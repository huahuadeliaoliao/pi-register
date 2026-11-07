import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { PRODUCER_QUERY } from "../src/compaction.ts";
import {
	IMPORT_TYPE,
	JOURNAL_TYPE,
	newRevision,
	newSnapshot,
	object,
	PUBLICATION_TYPE,
	render,
	renderEnvelope,
} from "../src/model.ts";
import { assertCurrent, resolveAdoption } from "../src/projection.ts";
import { RevisionStore } from "../src/store.ts";
import { CAPACITY } from "../src/text.ts";
import { fixture, text } from "./helpers.ts";

function offer(pi: ExtensionAPI, produce: (event: SessionBeforeCompactEvent) => unknown) {
	pi.events.on(PRODUCER_QUERY, (value) => {
		const query = object(value);
		(query.offer as (producer: unknown) => void)({
			id: "fault-fixture",
			version: 1,
			acquire: () => () => undefined,
			produce,
		});
	});
}

/** Test-only public SessionManager adapter, never a patch to pi source/private state. */
function publicationFault(timing: "before" | "after") {
	const state = { injected: 0 };
	return {
		state,
		manager: (cwd: string) => {
			const target = SessionManager.inMemory(cwd);
			return new Proxy(target, {
				get(manager, property, receiver) {
					if (property === "appendCustomMessageEntry") {
						return (...args: Parameters<SessionManager["appendCustomMessageEntry"]>) => {
							const envelope = (
								args[3] as { register?: { kind?: string; snapshot?: { revision?: { body?: string } } } } | undefined
							)?.register;
							if (
								!state.injected &&
								args[0] === PUBLICATION_TYPE &&
								envelope?.kind === "adopt" &&
								envelope.snapshot?.revision?.body === "candidate"
							) {
								state.injected++;
								if (timing === "after") manager.appendCustomMessageEntry(...args);
								throw new Error(`injected native publication ${timing} append`);
							}
							return manager.appendCustomMessageEntry(...args);
						};
					}
					const value = Reflect.get(manager, property, receiver);
					return typeof value === "function" ? value.bind(manager) : value;
				},
			});
		},
	};
}

for (const timing of ["before", "after"] as const) {
	test(`partial native publication failure ${timing} append preserves the actual adoption and can continue without reload`, async (t) => {
		const fault = publicationFault(timing);
		const f = await fixture(t, { manager: fault.manager });
		const old = resolveAdoption(f.manager.getBranch());
		assert.ok(old);
		f.respond([
			fauxAssistantMessage(
				fauxToolCall("register_write", { base_revision: old.revision.id, action: "append", text: "candidate" }),
				{ stopReason: "toolUse" },
			),
		]);
		try {
			await f.session.prompt("Record this note.");
		} catch (error) {
			assert.match(String(error), /injected native publication/);
		}
		assert.equal(fault.state.injected, 1);
		const current = resolveAdoption(f.manager.getBranch());
		assert.ok(current);
		assert.equal(current.revision.body, timing === "before" ? "" : "candidate");
		assertCurrent(f.manager.getBranch(), current);
		assert.equal(f.controller.exportArchive(f.context).revisions.length, 2);
		f.respond([
			(context) => {
				assert.ok(text(context).includes(renderEnvelope(assertCurrent(f.manager.getBranch(), current).envelope)));
				return fauxAssistantMessage("continued safely");
			},
		]);
		await f.session.prompt("Continue the task.");
		assert.equal(f.session.getLastAssistantText(), "continued safely");
	});
}

test("producer pre-processing cannot mutate ordinary native session records", async (t) => {
	let mutated = false;
	const f = await fixture(t, {
		keepRecentTokens: 30,
		before: (pi) =>
			offer(pi, (event) => {
				const kept = event.branchEntries.find((entry) => entry.id === event.preparation.firstKeptEntryId);
				assert.ok(kept?.type === "message");
				assert.ok(kept.message.role === "assistant");
				kept.message.content = [{ type: "text", text: "producer-local replacement" }];
				for (const message of [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]) {
					if (message.role === "user") message.content = "producer-local redaction";
				}
				mutated = true;
				return {
					compaction: {
						summary: "Ordinary summary.",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			}),
	});
	f.respond([fauxAssistantMessage("This native tail must stay unchanged. ".repeat(40))]);
	await f.session.prompt("Original user request.");
	const before = f.manager
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => JSON.stringify(entry));
	await f.session.compact();
	assert.ok(mutated);
	for (const record of before) {
		const entry = JSON.parse(record) as { id: string };
		assert.equal(JSON.stringify(f.manager.getEntry(entry.id)), record);
	}
	assert.deepEqual(f.errors, []);
});

test("append-only non-context producer telemetry does not discard an otherwise valid paid summary", async (t) => {
	let calls = 0;
	const f = await fixture(t, {
		keepRecentTokens: 30,
		after: (pi) =>
			offer(pi, (event) => {
				calls++;
				pi.appendEntry("peer-summary-telemetry", { call: calls });
				return {
					compaction: {
						summary: "Ordinary summary.",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			}),
	});
	f.respond([fauxAssistantMessage("Ordinary work completed. ".repeat(40))]);
	await f.session.prompt("Work.");
	await f.session.compact();
	assert.equal(calls, 1);
	const current = resolveAdoption(f.manager.getBranch());
	assert.ok(current);
	assertCurrent(f.manager.getBranch(), current);
	assert.deepEqual(f.errors, []);
});

test("an irreducible protected floor fails before any summarizer is invoked, including retries", async (t) => {
	const snapshot = newSnapshot(newRevision(" x".repeat(CAPACITY), undefined, "create", "floor-fixture"));
	const f = await fixture(t, {
		contextWindow: 18_000,
		keepRecentTokens: 30,
		manager: (cwd) => {
			const manager = SessionManager.inMemory(cwd);
			manager.appendMessage({ role: "user", content: "Earlier ordinary work. ".repeat(40), timestamp: 1 });
			manager.appendCustomMessageEntry(PUBLICATION_TYPE, render(snapshot), false, {
				register: { version: 1, kind: "adopt", snapshot },
			});
			manager.appendMessage({ role: "user", content: "Later ordinary work. ".repeat(40), timestamp: 2 });
			return manager;
		},
	});
	f.respond([fauxAssistantMessage("must not spend a summary call")]);
	await assert.rejects(f.session.compact(), /cancel/i);
	await assert.rejects(f.session.compact(), /cancel/i);
	assert.equal(f.requests.length, 0);
	assert.ok(f.notices.some((message) => message.includes("No summary request was made")));
	assertCurrent(f.manager.getBranch(), snapshot);
});

function journalFault(type: string) {
	const state = { injected: 0 };
	return {
		state,
		manager: (cwd: string) => {
			const target = SessionManager.inMemory(cwd);
			return new Proxy(target, {
				get(manager, property, receiver) {
					if (property === "appendCustomEntry")
						return (...args: Parameters<SessionManager["appendCustomEntry"]>) => {
							const data = object(args[1]);
							const revision = data.revision ? object(data.revision) : undefined;
							if (
								!state.injected &&
								args[0] === type &&
								(type === IMPORT_TYPE || revision?.body === "journal candidate")
							) {
								state.injected++;
								throw new Error("injected native journal failure");
							}
							return manager.appendCustomEntry(...args);
						};
					const value = Reflect.get(manager, property, receiver);
					return typeof value === "function" ? value.bind(manager) : value;
				},
			});
		},
	};
}

test("a failed native candidate journal cannot strand a committed SQL revision outside this file's history scope", async (t) => {
	const fault = journalFault(JOURNAL_TYPE);
	let storage: RevisionStore | undefined;
	const f = await fixture(t, {
		manager: fault.manager,
		storeFactory: (path) => {
			storage = new RevisionStore(path);
			return storage;
		},
	});
	const old = resolveAdoption(f.manager.getBranch());
	assert.ok(old);
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("register_write", { base_revision: old.revision.id, action: "append", text: "journal candidate" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The note write failed; continue other work."),
	]);
	await f.session.prompt("Record and continue.");
	assert.equal(fault.state.injected, 1);
	assert.ok(storage);
	const archived = new Set(f.controller.exportArchive(f.context).revisions.map((revision) => revision.id));
	const stored = storage.database
		.prepare("SELECT id FROM revisions")
		.all()
		.map((row) => String(row.id));
	assert.deepEqual(
		stored.filter((id) => !archived.has(id)),
		[],
		"no acknowledged or orphan committed revision may be silently omitted",
	);
	assert.equal(resolveAdoption(f.manager.getBranch())?.revision.id, old.revision.id);
	assertCurrent(f.manager.getBranch(), old);
});

test("an import bookkeeping failure rolls back new SQL rows without changing current adoption", async (t) => {
	const fault = journalFault(IMPORT_TYPE);
	const f = await fixture(t, { manager: fault.manager });
	const source = new RevisionStore();
	t.after(() => source.close());
	const imported = newRevision("explicitly imported history", undefined, "create", "import-fault");
	source.put(imported);
	const archive = source.export(newSnapshot(imported), [imported.id]);
	const old = resolveAdoption(f.manager.getBranch());
	assert.ok(old);
	assert.throws(() => f.controller.importArchive(f.context, archive), /injected native journal failure/);
	assert.equal(fault.state.injected, 1);
	assert.ok(!f.controller.exportArchive(f.context).revisions.some((revision) => revision.id === imported.id));
	assertCurrent(f.manager.getBranch(), old);
});
