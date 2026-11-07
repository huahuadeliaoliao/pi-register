import { join } from "node:path";
import {
	type AgentBeforeSettleEvent,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens,
	getAgentDir,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
	type SessionBoundaryDraft,
	SessionManager,
	SettingsManager,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type CompactionProducer,
	checkCompactionBudget,
	checkProtectedFloor,
	defaultProducer,
	PRODUCER_QUERY,
	protectCompaction,
	sanitizeCompaction,
} from "./compaction.ts";
import { acquireLease, type WriterLease } from "./lease.ts";
import {
	IMPORT_TYPE,
	JOURNAL_TYPE,
	newRevision,
	newSnapshot,
	type Operation,
	object,
	parseRevision,
	type Revision,
	SELECTION_TYPE,
	type Snapshot,
} from "./model.ts";
import {
	assertCurrent,
	assertRequest,
	carriers,
	entryEnvelope,
	publication,
	publicationDrafts,
	resolveAdoption,
} from "./projection.ts";
import { type HistoryArchive, RevisionStore } from "./store.ts";
import { applyEdits, CAPACITY, PROFILE, RegisterError, type TextEdit } from "./text.ts";
import { showRegister } from "./viewer.ts";

export interface RegisterOptions {
	agentDir?: string;
	storeFactory?: (path: string) => RevisionStore;
}
export interface WriteInput {
	base_revision: string;
	action: "replace" | "edit" | "append" | "clear";
	text?: string;
	edits?: TextEdit[];
}

export class RegisterController {
	private readonly pi: ExtensionAPI;
	private readonly options: RegisterOptions;
	private store: RevisionStore | undefined;
	private lease: WriterLease | undefined;
	private current: Snapshot | undefined;
	private pending: Snapshot | undefined;
	private repairAdoption: string | undefined;
	private generation = 0;
	private key = "";
	private ephemeral = false;
	private storageIssue: unknown;
	private fatalIssue: unknown;
	private producer: CompactionProducer | undefined;
	private producerRelease: (() => void) | undefined;
	private producerIssue: unknown;
	private notified = "";
	private ctx: ExtensionContext | undefined;

	constructor(pi: ExtensionAPI, options: RegisterOptions = {}) {
		this.pi = pi;
		this.options = options;
	}

	private sessionKey(ctx: ExtensionContext): string {
		return `${ctx.sessionManager.getSessionFile() ?? "in-memory"}:${ctx.sessionManager.getSessionId()}`;
	}

	private report(ctx: ExtensionContext, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		if (this.notified === message) return;
		this.notified = message;
		try {
			ctx.ui.notify(`Register: ${message}`, "error");
			if (!ctx.hasUI) process.stderr.write(`[register] ${message}\n`);
		} catch {
			/* replacement has already invalidated this context */
		}
	}

	private status(ctx: ExtensionContext): void {
		try {
			const r = (this.pending ?? this.current)?.revision;
			ctx.ui.setStatus(
				"register",
				r
					? `register ${r.used}/${CAPACITY}${this.pending ? " pending" : this.storageIssue ? " read-only" : ""}`
					: "register unavailable",
			);
		} catch {
			/* no UI or a stale context */
		}
	}

	start(ctx: ExtensionContext): void {
		this.stop();
		this.ctx = ctx;
		this.key = this.sessionKey(ctx);
		this.ephemeral = !ctx.sessionManager.getSessionFile();
		this.fatalIssue = undefined;
		this.storageIssue = undefined;
		this.producerIssue = undefined;
		this.notified = "";
		try {
			this.current = resolveAdoption(ctx.sessionManager.getBranch());
		} catch (error) {
			this.fatalIssue = error;
		}
		try {
			const path = this.ephemeral
				? ":memory:"
				: join(this.options.agentDir ?? getAgentDir(), "register", "revisions.sqlite");
			this.store = (this.options.storeFactory ?? ((p) => new RevisionStore(p)))(path);
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) this.lease = acquireLease(this.store, sessionFile);
			if (this.ephemeral) {
				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type !== "custom" || entry.customType !== JOURNAL_TYPE) continue;
					try {
						const data = object(entry.data);
						if (data.revision) this.store.put(parseRevision(data.revision));
					} catch {
						/* An unadopted invalid candidate cannot replace a valid adopted state. */
					}
				}
			}
			if (this.current) this.store.put(this.current.revision);
		} catch (error) {
			this.storageIssue = error;
		}
		try {
			if (this.fatalIssue) throw this.fatalIssue;
			if (!this.current) {
				this.writable(ctx);
				const revision = newRevision("", undefined, "create", ctx.sessionManager.getSessionId());
				this.saveCandidate(ctx, revision);
				this.current = newSnapshot(revision);
				this.publishIdle(ctx, this.current, "adopt");
			} else if (carriers(ctx.sessionManager.getBranch()).length === 0) {
				if (this.storageIssue instanceof RegisterError && this.storageIssue.code === "WRITER_CONFLICT")
					throw this.storageIssue;
				this.publishIdle(ctx, this.current, "carry");
			}
			assertCurrent(ctx.sessionManager.getBranch(), this.requiredCurrent());
		} catch (error) {
			this.fatalIssue = error;
		}
		this.discoverProducer(ctx);
		if (this.fatalIssue ?? this.storageIssue) this.report(ctx, this.fatalIssue ?? this.storageIssue);
		this.status(ctx);
	}

	stop(): void {
		this.generation++;
		this.pending = undefined;
		this.repairAdoption = undefined;
		try {
			this.producerRelease?.();
		} catch (error) {
			if (this.ctx) this.report(this.ctx, error);
		}
		this.producerRelease = undefined;
		this.producer = undefined;
		try {
			this.lease?.release();
		} catch {
			/* disk failures must not prevent shutdown */
		}
		this.lease = undefined;
		try {
			this.store?.close();
		} catch (error) {
			if (this.ctx) this.report(this.ctx, error);
		}
		this.store = undefined;
		this.current = undefined;
		this.ctx = undefined;
	}

	private discoverProducer(ctx: ExtensionContext): void {
		this.producerRelease?.();
		this.producerRelease = undefined;
		this.producer = undefined;
		this.producerIssue = undefined;
		const offers: CompactionProducer[] = [];
		const protocolFailures: unknown[] = [];
		try {
			this.pi.events.emit(PRODUCER_QUERY, {
				version: 1,
				offer: (value: unknown) => {
					// EventBus isolates listener exceptions. Capture negotiation errors here,
					// rather than accidentally interpreting a failed offer as no producer.
					try {
						const data = object(value);
						if (
							data.version !== 1 ||
							typeof data.id !== "string" ||
							typeof data.produce !== "function" ||
							typeof data.acquire !== "function"
						) {
							throw new RegisterError(
								"PRODUCER_PROTOCOL",
								"Compaction producer does not implement protocol version 1.",
							);
						}
						offers.push(value as CompactionProducer);
					} catch (error) {
						protocolFailures.push(error);
					}
				},
			});
			if (protocolFailures.length) throw protocolFailures[0];
			if (offers.length > 1)
				throw new RegisterError(
					"MULTIPLE_PRODUCERS",
					"Multiple ordinary compaction producers were offered; choose one.",
				);
			const selected = offers[0];
			if (selected) {
				const release = selected.acquire();
				if (typeof release !== "function")
					throw new RegisterError("PRODUCER_PROTOCOL", "Compaction producer did not return a release function.");
				this.producerRelease = release;
				this.producer = selected;
			} else if (this.pi.getCommands().some((command) => command.name === "compact-model")) {
				throw new RegisterError(
					"UNCOOPERATIVE_COMPACTOR",
					"Installed compact-model lacks Register coordination. Update its cooperative adapter or disable it for this run.",
				);
			}
		} catch (error) {
			this.producerIssue = error;
			this.report(ctx, error);
		}
	}

	private publishIdle(
		ctx: ExtensionContext,
		snapshot: Snapshot,
		kind: "adopt" | "carry",
		atTreeBoundary = false,
	): void {
		// session_tree runs with the branch-summary busy flag still set, but no main turn is streaming.
		if (!ctx.isIdle() && !atTreeBoundary)
			throw new RegisterError(
				"RECOVERY_REQUIRES_IDLE",
				"Register recovery needs an idle session; no incomplete state will be sent.",
			);
		const message = publication(snapshot, kind);
		this.pi.sendMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			},
			{ triggerTurn: false },
		);
		// sendMessage is void; verify the native append actually committed rather than being queued.
		assertCurrent(ctx.sessionManager.getBranch(), snapshot);
	}

	private storeRequired(): RevisionStore {
		if (!this.store)
			throw this.storageIssue ?? new RegisterError("STORAGE_UNAVAILABLE", "Register revision storage is unavailable.");
		return this.store;
	}

	private requiredCurrent(): Snapshot {
		if (!this.current)
			throw this.fatalIssue ?? new RegisterError("REGISTER_UNAVAILABLE", "No trusted current Register is available.");
		return this.current;
	}

	private bind(ctx: ExtensionContext): void {
		if (this.sessionKey(ctx) !== this.key)
			throw new RegisterError("STALE_SESSION", "Register operation belongs to a replaced session.");
		this.ctx = ctx;
	}

	private sync(ctx: ExtensionContext): Snapshot {
		this.bind(ctx);
		if (this.fatalIssue) throw this.fatalIssue;
		const adopted = resolveAdoption(ctx.sessionManager.getBranch());
		if (!adopted) throw new RegisterError("REGISTER_UNAVAILABLE", "Current branch has no adopted Register.");
		this.current = adopted;
		if (this.pending?.adoptionId === adopted.adoptionId) this.pending = undefined;
		else if (this.pending && this.pending.previousAdoption !== adopted.adoptionId) {
			throw new RegisterError(
				"ADOPTION_CONFLICT",
				"A stored candidate was not adopted because the branch state changed.",
			);
		}
		return adopted;
	}

	private writable(ctx: ExtensionContext): void {
		this.bind(ctx);
		if (this.fatalIssue) throw this.fatalIssue;
		if (this.storageIssue) throw this.storageIssue;
		if (ctx.signal?.aborted) throw new RegisterError("ABORTED", "Register operation was cancelled.");
		this.lease?.assertOwned();
		this.storeRequired();
	}

	private saveCandidate(ctx: ExtensionContext, revision: Revision): void {
		const store = this.storeRequired();
		store.transaction(() => {
			store.put(revision);
			// Durable native scope intent precedes SQL commit, not adoption.
			// A failed append rolls the insertion back instead of stranding a row.
			this.journal(ctx, revision);
		});
	}

	private journal(ctx: ExtensionContext, revision: Revision): void {
		this.pi.appendEntry(JOURNAL_TYPE, {
			version: 1,
			intent: true,
			revisionId: revision.id,
			hash: revision.hash,
			...(this.ephemeral ? { revision } : {}),
			sourceSession: ctx.sessionManager.getSessionId(),
		});
	}

	private effective(ctx: ExtensionContext): Revision {
		this.sync(ctx);
		return (this.pending ?? this.requiredCurrent()).revision;
	}

	private base(ctx: ExtensionContext, expected: string): Revision {
		this.writable(ctx);
		const effective = this.effective(ctx);
		if (effective.id !== expected)
			throw new RegisterError("REVISION_CONFLICT", "base_revision is stale; use the current or last staged revision.", {
				effective_revision: effective.id,
				used: effective.used,
				remaining: CAPACITY - effective.used,
			});
		return effective;
	}

	private stage(
		ctx: ExtensionContext,
		body: string,
		parent: Revision,
		operation: Operation,
		restoredFrom: string | null = null,
	): Record<string, unknown> {
		if (operation !== "restore" && body === parent.body) return this.receipt(parent, "unchanged");
		let revision: Revision;
		try {
			revision = newRevision(body, parent, operation, ctx.sessionManager.getSessionId(), restoredFrom);
		} catch (error) {
			if (error instanceof RegisterError)
				throw new RegisterError(error.code, error.message, {
					...error.data,
					current_used: parent.used,
					current_remaining: CAPACITY - parent.used,
				});
			throw error;
		}
		this.saveCandidate(ctx, revision);
		// Advances only after validation, storage and the scope journal succeeded.
		this.pending = newSnapshot(revision, this.requiredCurrent());
		this.status(ctx);
		return this.receipt(revision, "staged");
	}

	private receipt(revision: Revision, state: "staged" | "unchanged"): Record<string, unknown> {
		return {
			state,
			revision: revision.id,
			hash: revision.hash,
			used: revision.used,
			remaining: CAPACITY - revision.used,
			capacity: CAPACITY,
			profile: PROFILE,
			adopted_revision: this.current?.revision.id,
		};
	}

	write(ctx: ExtensionContext, input: WriteInput): Record<string, unknown> {
		const parent = this.base(ctx, input.base_revision);
		if (input.action === "clear") {
			if (input.text !== undefined || input.edits !== undefined)
				throw new RegisterError("INVALID_ARGUMENT", "clear accepts no text or edits.");
			return this.stage(ctx, "", parent, "clear");
		}
		if (input.action === "edit") {
			if (!input.edits || input.text !== undefined)
				throw new RegisterError("INVALID_ARGUMENT", "edit requires edits and no text.");
			return this.stage(ctx, applyEdits(parent.body, input.edits), parent, "edit");
		}
		if (typeof input.text !== "string" || input.edits !== undefined)
			throw new RegisterError("INVALID_ARGUMENT", "replace/append require text and no edits.");
		return this.stage(ctx, input.action === "append" ? parent.body + input.text : input.text, parent, input.action);
	}

	private roots(ctx: ExtensionContext, scope: "branch" | "session"): Set<string> {
		const roots = new Set<string>([(this.pending ?? this.requiredCurrent()).revision.id]);
		const entries = scope === "session" ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();
		for (const entry of entries) {
			if (scope === "session") {
				const envelope = entryEnvelope(entry);
				if (envelope) roots.add(envelope.snapshot.revision.id);
				if (entry.type === "custom" && entry.customType === JOURNAL_TYPE) {
					const data = object(entry.data);
					if (typeof data.revisionId === "string") roots.add(data.revisionId);
				}
			}
			if (entry.type === "custom" && entry.customType === IMPORT_TYPE) {
				const data = object(entry.data);
				if (Array.isArray(data.roots)) for (const id of data.roots) if (typeof id === "string") roots.add(id);
			}
		}
		return roots;
	}

	history(
		ctx: ExtensionContext,
		options: { scope?: "branch" | "session"; revision?: string; before?: string; limit?: number },
	): Record<string, unknown> {
		this.sync(ctx);
		const closure = this.storeRequired().closure(this.roots(ctx, options.scope ?? "branch"));
		const revisions = closure.revisions.sort(
			(a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
		);
		if (options.revision) {
			const revision = revisions.find((r) => r.id === options.revision);
			if (!revision)
				throw new RegisterError(
					"REVISION_NOT_ACCESSIBLE",
					"Revision is not accessible in the requested history scope.",
				);
			return { historical: true, revision, missing: closure.missing, current_revision: this.current?.revision.id };
		}
		let start = 0;
		if (options.before) {
			start = revisions.findIndex((r) => r.id === options.before) + 1;
			if (!start) throw new RegisterError("INVALID_CURSOR", "History cursor is not in the selected history scope.");
		}
		const limit = Math.max(1, Math.min(50, options.limit ?? 10));
		const page = revisions.slice(start, start + limit);
		return {
			revisions: page.map(({ body, ...r }) => ({ ...r, preview: body.slice(0, 120) })),
			next: start + limit < revisions.length ? page.at(-1)?.id : null,
			missing: closure.missing,
		};
	}

	restore(ctx: ExtensionContext, expected: string, target: string): Record<string, unknown> {
		const parent = this.base(ctx, expected);
		const revisions = this.storeRequired().closure(this.roots(ctx, "session")).revisions;
		const historical = revisions.find((r) => r.id === target);
		if (!historical)
			throw new RegisterError(
				"REVISION_NOT_ACCESSIBLE",
				"Restore target does not belong to this session's available history.",
			);
		return this.stage(ctx, historical.body, parent, "restore", historical.id);
	}

	boundary(
		event: TurnEndEvent | AgentBeforeSettleEvent,
		ctx: ExtensionContext,
	): { entries: SessionBoundaryDraft[] } | undefined {
		try {
			if (event.outcome !== "completed") return;
			this.sync(ctx);
			this.lease?.assertOwned();
			if (!this.pending) return;
			const target = this.pending;
			const header = ctx.sessionManager.getHeader();
			if (!header) throw new RegisterError("NO_SESSION_HEADER", "Cannot publish Register without a session header.");
			const preview = SessionManager.inMemory(ctx.cwd, undefined, [header, ...ctx.sessionManager.getBranch()]);
			for (const draft of event.entries) applyDraft(preview, draft);
			try {
				assertCurrent(preview.getBranch(), target);
				return { entries: event.entries };
			} catch {
				/* not proposed yet */
			}
			const drafts = publicationDrafts(ctx.sessionManager.getBranch(), target, "adopt");
			for (const draft of drafts) applyDraft(preview, draft);
			assertCurrent(preview.getBranch(), target);
			return { entries: [...event.entries, ...drafts] };
		} catch (error) {
			this.report(ctx, error);
			ctx.abort();
		}
	}

	guard(messages: Parameters<typeof assertRequest>[0], ctx: ExtensionContext): void {
		try {
			const adopted = this.sync(ctx);
			if (this.storageIssue instanceof RegisterError && this.storageIssue.code === "WRITER_CONFLICT")
				throw this.storageIssue;
			if (this.pending)
				throw new RegisterError(
					"PUBLICATION_NOT_COMMITTED",
					"A staged Register revision did not reach its publication boundary.",
				);
			const branch = ctx.sessionManager.getBranch();
			assertRequest(messages, assertCurrent(branch, adopted), branch);
			if (!ctx.model || ctx.model.contextWindow <= 0)
				throw new RegisterError("UNKNOWN_MODEL", "Register needs a known effective context window.");
			const reserve = this.pi.getSettings().compaction?.reserveTokens ?? 16_384;
			const estimate = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
			if (estimate + reserve > ctx.model.contextWindow)
				throw new RegisterError(
					"CONTEXT_CANNOT_FIT",
					"Current context and Register do not fit this model with its reserve. Use a larger model or reduce the working context.",
				);
		} catch (error) {
			this.report(ctx, error);
			ctx.abort();
		}
	}

	async compact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<SessionBeforeCompactResult> {
		try {
			this.sync(ctx);
			if (this.pending)
				throw new RegisterError(
					"PUBLICATION_NOT_COMMITTED",
					"Cannot compact while a Register candidate is awaiting publication.",
				);
			if (this.producerIssue) throw this.producerIssue;
			this.lease?.assertOwned();
			const snapshot = this.requiredCurrent();
			checkProtectedFloor(event, ctx, snapshot);
			const stamp = this.generation;
			const producerEvent = sanitizeCompaction(event);
			const result = this.producer
				? await this.producer.produce(producerEvent, ctx)
				: await defaultProducer(producerEvent, ctx, SettingsManager.inMemory(this.pi.getSettings()).getRetrySettings());
			if (
				event.signal.aborted ||
				stamp !== this.generation ||
				this.key !== this.sessionKey(ctx) ||
				!sameCompactionInput(event.branchEntries, ctx.sessionManager.getBranch()) ||
				this.pending
			)
				return { cancel: true };
			const current = this.sync(ctx);
			if (current.adoptionId !== snapshot.adoptionId) return { cancel: true };
			const protectedResult = protectCompaction(event, snapshot, result);
			checkCompactionBudget(event, ctx, protectedResult);
			return protectedResult;
		} catch (error) {
			this.report(ctx, error);
			return { cancel: true };
		}
	}

	afterCompact(ctx: ExtensionContext): void {
		try {
			assertCurrent(ctx.sessionManager.getBranch(), this.sync(ctx));
		} catch (error) {
			this.fatalIssue = error;
			this.report(ctx, error);
			ctx.abort();
		}
		this.status(ctx);
	}

	tree(ctx: ExtensionContext): void {
		this.generation++;
		this.pending = undefined;
		this.repairAdoption = undefined;
		this.fatalIssue = undefined;
		try {
			this.bind(ctx);
			this.current = resolveAdoption(ctx.sessionManager.getBranch());
			if (!this.current) {
				this.writable(ctx);
				const root = newRevision("", undefined, "create", ctx.sessionManager.getSessionId());
				this.saveCandidate(ctx, root);
				this.current = newSnapshot(root);
				this.publishIdle(ctx, this.current, "adopt", true);
			} else {
				if (!this.storageIssue) this.storeRequired().put(this.current.revision);
				if (carriers(ctx.sessionManager.getBranch()).length === 0) this.publishIdle(ctx, this.current, "carry", true);
			}
			assertCurrent(ctx.sessionManager.getBranch(), this.requiredCurrent());
			if (!(this.storageIssue instanceof RegisterError && this.storageIssue.code === "WRITER_CONFLICT")) {
				this.pi.appendEntry(SELECTION_TYPE, { version: 1, adoptionId: this.requiredCurrent().adoptionId });
			}
		} catch (error) {
			this.fatalIssue = error;
			this.report(ctx, error);
		}
		this.status(ctx);
	}

	settled(ctx: ExtensionContext): void {
		try {
			const adopted = this.sync(ctx);
			if (this.pending) {
				if (carriers(ctx.sessionManager.getBranch()).length === 0) this.repairAdoption = adopted.adoptionId;
				this.report(
					ctx,
					new RegisterError(
						"CANDIDATE_NOT_ADOPTED",
						"Stored candidate was not adopted. It remains in session history; current contents are unchanged.",
					),
				);
				this.pending = undefined;
			}
			if (this.repairAdoption) {
				if (this.repairAdoption === adopted.adoptionId && carriers(ctx.sessionManager.getBranch()).length === 0) {
					this.lease?.assertOwned();
					this.publishIdle(ctx, adopted, "carry");
				}
				this.repairAdoption = undefined;
			}
		} catch (error) {
			this.report(ctx, error);
			this.pending = undefined;
		}
		this.status(ctx);
	}

	exportArchive(ctx: ExtensionContext): HistoryArchive {
		this.sync(ctx);
		return this.storeRequired().export(this.requiredCurrent(), this.roots(ctx, "session"));
	}

	importArchive(ctx: ExtensionContext, value: unknown): HistoryArchive {
		this.writable(ctx);
		if (!ctx.isIdle()) throw new RegisterError("BUSY", "Import history while the session is idle.");
		return this.storeRequired().import(value, (archive) => {
			if (this.ephemeral) for (const revision of archive.revisions) this.journal(ctx, revision);
			this.pi.appendEntry(IMPORT_TYPE, {
				version: 1,
				intent: true,
				roots: [...archive.roots],
				checksum: archive.checksum,
				sourceChecksum: object(value).checksum,
			});
		});
	}

	async command(args: string, ctx: ExtensionContext): Promise<void> {
		try {
			if (args.trim()) throw new RegisterError("USAGE", "Usage: /register");
			const current = this.sync(ctx);
			await showRegister(ctx, current.revision);
		} catch (error) {
			this.report(ctx, error);
		}
	}
}

/** Preserve the captured branch; only append-only non-context peer telemetry is harmless. */
function sameCompactionInput(
	before: readonly import("@earendil-works/pi-coding-agent").SessionEntry[],
	after: readonly import("@earendil-works/pi-coding-agent").SessionEntry[],
): boolean {
	return (
		after.length >= before.length &&
		before.every((entry, index) => after[index]?.id === entry.id) &&
		after.slice(before.length).every((entry) => entry.type === "custom" && !entry.customType.startsWith("pi-register"))
	);
}

function applyDraft(manager: SessionManager, draft: SessionBoundaryDraft): void {
	switch (draft.type) {
		case "custom":
			manager.appendCustomEntry(draft.customType, draft.data);
			break;
		case "custom_message":
			manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
			break;
		case "context_edit":
			manager.appendContextEdit(draft.targetId, draft.replacement);
			break;
		case "compaction":
			manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 0, draft.details, true, draft.usage);
			break;
	}
}
