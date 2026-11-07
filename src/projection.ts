import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionProjection,
	type CompactionEntry,
	type CustomMessageEntryDraft,
	type SessionBoundaryDraft,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	type Checkpoint,
	canonicalRevision,
	type Envelope,
	envelopeFromDetails,
	isInitialSnapshot,
	PUBLICATION_TYPE,
	renderCheckpoint,
	renderEnvelope,
	renderInitial,
	type Snapshot,
} from "./model.ts";
import { RegisterError } from "./text.ts";

const parsed = new WeakMap<SessionEntry, Envelope | undefined>();
export function entryEnvelope(entry: SessionEntry): Envelope | undefined {
	if (parsed.has(entry)) return parsed.get(entry);
	let envelope: Envelope | undefined;
	if (entry.type === "custom_message" && entry.customType === PUBLICATION_TYPE) {
		envelope = envelopeFromDetails(entry.details);
		if (!envelope || envelope.kind === "checkpoint" || entry.content !== renderEnvelope(envelope)) {
			throw new RegisterError("INVALID_PUBLICATION", "Register publication metadata and rendered text disagree.");
		}
	} else if (entry.type === "compaction") {
		envelope = envelopeFromDetails(entry.details);
		if (envelope && (envelope.kind !== "checkpoint" || entry.summary !== renderCheckpoint(envelope))) {
			throw new RegisterError("INVALID_CHECKPOINT", "Register checkpoint metadata and rendered summary disagree.");
		}
	}
	parsed.set(entry, envelope);
	return envelope;
}

/** Raw selected ancestry decides adoption, including during a partially retired carrier. */
export function resolveAdoption(entries: readonly SessionEntry[]): Snapshot | undefined {
	let current: Snapshot | undefined;
	for (const entry of entries) {
		const envelope = entryEnvelope(entry);
		if (!envelope) continue;
		const next = envelope.snapshot;
		if (current) {
			if (envelope.kind === "initial")
				throw new RegisterError("ADOPTION_CONFLICT", "Initialization cannot replace an existing adoption.");
			if (envelope.kind === "adopt") {
				if (next.previousAdoption !== current.adoptionId || next.adoptionId === current.adoptionId) {
					throw new RegisterError("ADOPTION_CONFLICT", "Register adoption does not extend the selected branch.");
				}
			} else if (
				next.adoptionId !== current.adoptionId ||
				next.previousAdoption !== current.previousAdoption ||
				canonicalRevision(next.revision) !== canonicalRevision(current.revision)
			) {
				throw new RegisterError("CARRIER_CONFLICT", "Carrier relocation attempted to change the adopted Register.");
			}
		}
		current = next;
	}
	return current;
}

export interface Carrier {
	entry: SessionEntry;
	envelope: Envelope;
}

export function carriers(entries: SessionEntry[]): Carrier[] {
	const projection = buildSessionProjection(entries);
	const adopted = resolveAdoption(entries);
	const relocated = projection.entries.some((entry) => {
		if (!entry.messages.length) return false;
		const envelope = entryEnvelope(entry.sourceEntry);
		return (
			envelope &&
			envelope.kind !== "initial" &&
			(envelope.kind !== "checkpoint" || envelope.carrier) &&
			envelope.snapshot.adoptionId === adopted?.adoptionId
		);
	});
	const result: Carrier[] = [];
	for (const projected of projection.entries) {
		if (!projected.messages.length) continue;
		const envelope = entryEnvelope(projected.sourceEntry);
		if (!envelope || (envelope.kind === "checkpoint" && !envelope.carrier)) continue;
		const expected = renderEnvelope(envelope);
		const actual = projected.messages.find((message) =>
			envelope.kind === "checkpoint" ? message.role === "compactionSummary" : message.role === "custom",
		);
		if (
			!actual ||
			(actual.role === "compactionSummary" ? actual.summary : actual.role === "custom" ? actual.content : undefined) !==
				expected
		) {
			throw new RegisterError("PROJECTED_CONTENT_CONFLICT", "A context edit altered a Register carrier.");
		}
		// Origin metadata stays immutable, but cannot stand in for a later adoption
		// or a relocated current body (including an empty checkpoint/carry).
		if (envelope.kind === "initial" && (relocated || envelope.snapshot.adoptionId !== adopted?.adoptionId)) continue;
		result.push({ entry: projected.sourceEntry, envelope });
	}
	return result;
}

export function publication(snapshot: Snapshot, kind: "adopt" | "carry"): CustomMessageEntryDraft {
	const register: Envelope =
		kind === "adopt" && isInitialSnapshot(snapshot)
			? { version: 2, kind: "initial", snapshot }
			: { version: 1, kind, snapshot };
	return {
		type: "custom_message",
		customType: PUBLICATION_TYPE,
		content: renderEnvelope(register),
		display: false,
		details: { register },
	};
}

/** Own carrier changes only; all ordinary tail entries and prior omit edits stay in place. */
export function publicationDrafts(
	entries: SessionEntry[],
	snapshot: Snapshot,
	kind: "adopt" | "carry",
): SessionBoundaryDraft[] {
	const drafts: SessionBoundaryDraft[] = [];
	for (const carrier of carriers(entries)) {
		if (carrier.envelope.kind === "initial") continue;
		if (carrier.entry.type === "custom_message") {
			drafts.push({ type: "context_edit", targetId: carrier.entry.id, replacement: null });
		} else if (carrier.entry.type === "compaction" && carrier.envelope.kind === "checkpoint") {
			const register: Checkpoint = { ...carrier.envelope, carrier: false };
			const details = carrier.entry.details && typeof carrier.entry.details === "object" ? carrier.entry.details : {};
			drafts.push({
				type: "compaction",
				summary: register.ordinarySummary,
				firstKeptEntryId: carrier.entry.firstKeptEntryId,
				details: { ...details, register },
			});
		}
	}
	drafts.push(publication(snapshot, kind));
	return drafts;
}

/** Filter only owned carriers. Ordinary quotations and mixed tool calls are not text-redacted. */
export function ordinaryMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message) => message.role !== "custom" || message.customType !== PUBLICATION_TYPE);
}

export function latestCheckpoint(entries: readonly SessionEntry[]): CompactionEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "compaction") return entry;
	}
	return undefined;
}

export function assertCurrent(entries: SessionEntry[], expected: Snapshot): Carrier {
	const adopted = resolveAdoption(entries);
	const active = carriers(entries);
	if (
		!adopted ||
		adopted.adoptionId !== expected.adoptionId ||
		active.length !== 1 ||
		active[0]?.envelope.snapshot.adoptionId !== expected.adoptionId
	) {
		throw new RegisterError(
			"INVALID_CURRENT_PROJECTION",
			"Request would not contain exactly one current Register carrier.",
		);
	}
	return active[0];
}

export function assertRequest(messages: AgentMessage[], carrier: Carrier, entries: SessionEntry[] = []): void {
	const initial = new Map<string, number>();
	if (carrier.envelope.kind !== "initial") {
		for (const projected of buildSessionProjection(entries).entries) {
			if (!projected.messages.length) continue;
			const envelope = entryEnvelope(projected.sourceEntry);
			if (envelope?.kind === "initial") {
				const text = renderInitial(envelope.snapshot);
				initial.set(text, (initial.get(text) ?? 0) + 1);
			}
		}
	}
	const active = messages.filter((message) => {
		if (message.role !== "custom" || message.customType !== PUBLICATION_TYPE) return false;
		if (typeof message.content === "string" && initial.has(message.content)) {
			const remaining = initial.get(message.content) ?? 0;
			if (remaining === 0)
				throw new RegisterError("REQUEST_PROJECTION_CONFLICT", "Initialization metadata was duplicated.");
			initial.set(message.content, remaining - 1);
			return false;
		}
		return true;
	});
	if (carrier.envelope.kind === "checkpoint") {
		const text = renderCheckpoint(carrier.envelope);
		const summaries = messages.filter((message) => message.role === "compactionSummary");
		if (
			summaries.length !== 1 ||
			summaries[0]?.role !== "compactionSummary" ||
			summaries[0].summary !== text ||
			active.length !== 0
		) {
			throw new RegisterError(
				"REQUEST_PROJECTION_CONFLICT",
				"Current Register checkpoint was changed or duplicated by a request transform.",
			);
		}
	} else {
		if (active.length !== 1 || active[0]?.role !== "custom" || active[0].content !== renderEnvelope(carrier.envelope)) {
			throw new RegisterError(
				"REQUEST_PROJECTION_CONFLICT",
				"Current Register publication was changed or duplicated by a request transform.",
			);
		}
	}
}
