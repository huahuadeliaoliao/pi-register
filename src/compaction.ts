import {
	compact,
	type ExtensionContext,
	estimateTokens,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
	type SessionEntry,
	SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Checkpoint, envelopeFromDetails, PUBLICATION_TYPE, renderCheckpoint, type Snapshot } from "./model.ts";
import { carriers, entryEnvelope, ordinaryMessages, resolveAdoption } from "./projection.ts";
import { RegisterError } from "./text.ts";

export const PRODUCER_QUERY = "pi-register:compaction-producer:v1";
export interface CompactionProducer {
	id: string;
	version: 1;
	produce(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<SessionBeforeCompactResult>;
	/** Suppresses the producer's standalone final-result hook until released. */
	acquire(): () => void;
}

function sanitizedEntries(entries: SessionEntry[]): SessionEntry[] {
	return entries.map((entry) => {
		if (entry.type === "custom_message" && entry.customType === PUBLICATION_TYPE) {
			const snapshot = entryEnvelope(entry)?.snapshot;
			return {
				type: "custom",
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				customType: "pi-register-reference",
				data: { revision: snapshot?.revision.id },
			};
		}
		if (entry.type === "custom" && entry.customType.startsWith("pi-register-")) {
			return { ...entry, data: undefined };
		}
		if (entry.type === "compaction") {
			const envelope = entryEnvelope(entry);
			if (envelope?.kind === "checkpoint") {
				const { register: _register, ...details } = entry.details as Record<string, unknown>;
				return { ...entry, summary: envelope.ordinarySummary, details };
			}
		}
		return entry;
	});
}

export function sanitizeCompaction(event: SessionBeforeCompactEvent): SessionBeforeCompactEvent {
	const latest = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
	const previous = latest ? entryEnvelope(latest) : undefined;
	return {
		...event,
		branchEntries: structuredClone(sanitizedEntries(event.branchEntries)),
		preparation: {
			...event.preparation,
			messagesToSummarize: structuredClone(ordinaryMessages(event.preparation.messagesToSummarize)),
			turnPrefixMessages: structuredClone(ordinaryMessages(event.preparation.turnPrefixMessages)),
			previousSummary: previous?.kind === "checkpoint" ? previous.ordinarySummary : event.preparation.previousSummary,
			fileOps: structuredClone(event.preparation.fileOps),
			settings: { ...event.preparation.settings },
		},
	};
}

/** Reject an irreducible protected floor before paying for any ordinary summary. */
export function checkProtectedFloor(event: SessionBeforeCompactEvent, ctx: ExtensionContext, snapshot: Snapshot): void {
	const header = ctx.sessionManager.getHeader();
	if (!header || !ctx.model || ctx.model.contextWindow <= 0)
		throw new RegisterError("UNKNOWN_MODEL", "Compaction needs a known main-model window.");
	const manager = SessionManager.inMemory(ctx.cwd, undefined, [header, ...event.branchEntries]);
	const register: Checkpoint = { version: 1, kind: "checkpoint", snapshot, ordinarySummary: "", carrier: true };
	// A self-retaining checkpoint models the best possible case: no ordinary tail.
	// appendCompaction preserves the effective prompt and tool declarations.
	manager.appendCompaction(renderCheckpoint(register), null, 0, { register }, true);
	const floor = manager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	if (floor + event.preparation.settings.reserveTokens > ctx.model.contextWindow) {
		throw new RegisterError(
			"CONTEXT_CANNOT_FIT",
			"Register, required prompt/tools and reserve cannot fit this model even without ordinary history. No summary request was made.",
		);
	}
}

export async function defaultProducer(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	settings: ReturnType<SettingsManager["getRetrySettings"]>,
): Promise<SessionBeforeCompactResult> {
	if (!ctx.model || ctx.model.contextWindow <= 0)
		throw new RegisterError("UNKNOWN_MODEL", "Compaction needs a concrete model with a known context window.");
	const result = await compact(
		event.preparation,
		ctx.model,
		undefined,
		undefined,
		event.customInstructions,
		event.signal,
		ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
		(model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
		undefined,
		settings,
	);
	return { compaction: result };
}

/** Producer owns only ordinary summarization; Register alone builds the final checkpoint. */
export function protectCompaction(
	event: SessionBeforeCompactEvent,
	snapshot: Snapshot,
	result: SessionBeforeCompactResult,
): SessionBeforeCompactResult {
	if (result.cancel || !result.compaction) return { cancel: true };
	const active = carriers(event.branchEntries);
	if (active.length !== 1 || active[0]?.envelope.snapshot.adoptionId !== snapshot.adoptionId) {
		throw new RegisterError("INVALID_CURRENT_PROJECTION", "Cannot compact a missing or inconsistent Register carrier.");
	}
	const firstKept = event.branchEntries.findIndex((entry) => entry.id === result.compaction?.firstKeptEntryId);
	if (firstKept < 0)
		throw new RegisterError(
			"INVALID_COMPACTION",
			"Summary producer returned a kept boundary outside the current branch.",
		);
	if (result.compaction.firstKeptEntryId !== event.preparation.firstKeptEntryId) {
		throw new RegisterError(
			"INVALID_COMPACTION",
			"Summary producer changed the prepared boundary without preparing its corresponding ordinary history.",
		);
	}
	if (!result.compaction.summary.trim())
		throw new RegisterError("EMPTY_SUMMARY", "Ordinary compaction returned an empty summary.");
	const source = active[0];
	const retained =
		source.entry.type === "custom_message" &&
		event.branchEntries.findIndex((entry) => entry.id === source.entry.id) >= firstKept;
	const register: Checkpoint = {
		version: 1,
		kind: "checkpoint",
		snapshot,
		ordinarySummary: result.compaction.summary,
		carrier: !retained,
	};
	const details =
		result.compaction.details && typeof result.compaction.details === "object" ? result.compaction.details : {};
	if (envelopeFromDetails(details))
		throw new RegisterError("INVALID_PRODUCER", "Ordinary summary producer attempted to own Register metadata.");
	return {
		compaction: { ...result.compaction, summary: renderCheckpoint(register), details: { ...details, register } },
	};
}

export function checkCompactionBudget(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	result: SessionBeforeCompactResult,
): void {
	if (!result.compaction) return;
	const header = ctx.sessionManager.getHeader();
	if (!header || !ctx.model || ctx.model.contextWindow <= 0)
		throw new RegisterError("UNKNOWN_MODEL", "Cannot verify the final compaction budget.");
	const manager = SessionManager.inMemory(ctx.cwd, undefined, [header, ...event.branchEntries]);
	manager.appendCompaction(
		result.compaction.summary,
		result.compaction.firstKeptEntryId,
		result.compaction.tokensBefore,
		result.compaction.details,
		true,
		result.compaction.usage,
	);
	const snapshot = resolveAdoption(manager.getBranch());
	const active = carriers(manager.getBranch());
	if (!snapshot || active.length !== 1 || active[0]?.envelope.snapshot.adoptionId !== snapshot.adoptionId) {
		throw new RegisterError("INVALID_COMPACTION", "Compaction would lose or duplicate the current Register.");
	}
	const estimated = manager
		.buildSessionProjection()
		.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	if (estimated + event.preparation.settings.reserveTokens > ctx.model.contextWindow) {
		throw new RegisterError(
			"CONTEXT_CANNOT_FIT",
			"Protected Register, summary, retained context and reserve do not fit. Use a larger model or reduce ordinary retained history.",
		);
	}
}
