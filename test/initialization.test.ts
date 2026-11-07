import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { buildSessionProjection, estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	type Checkpoint,
	isInitialSnapshot,
	newRevision,
	newSnapshot,
	PUBLICATION_TYPE,
	parseEnvelope,
	render,
	renderCheckpoint,
	renderEnvelope,
	renderInitial,
	type Snapshot,
} from "../src/model.ts";
import {
	assertCurrent,
	assertRequest,
	carriers,
	entryEnvelope,
	ordinaryMessages,
	publication,
	publicationDrafts,
	resolveAdoption,
} from "../src/projection.ts";
import { CAPACITY, PROFILE } from "../src/text.ts";
import { fixture, text } from "./helpers.ts";

function append(manager: SessionManager, snapshot: Snapshot, kind: "adopt" | "carry" = "adopt") {
	const draft = publication(snapshot, kind);
	return manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
}

function initial() {
	return newSnapshot(newRevision("", undefined, "create", "initialization-fixture"));
}

function selected(f: Awaited<ReturnType<typeof fixture>>) {
	const snapshot = resolveAdoption(f.manager.getBranch());
	assert.ok(snapshot);
	assertCurrent(f.manager.getBranch(), snapshot);
	return snapshot;
}

async function replace(f: Awaited<ReturnType<typeof fixture>>, body: string) {
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("register_write", { base_revision: selected(f).revision.id, action: "replace", text: body }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("saved"),
	]);
	await f.session.prompt("Save the synthetic working notes.");
	assert.equal(f.session.getLastAssistantText(), "saved");
	assert.equal(selected(f).revision.body, body);
	return selected(f);
}

test("v2 initialization is self-contained and restricted to the original empty create", () => {
	const root = initial();
	const parsed = parseEnvelope({ version: 2, kind: "initial", snapshot: root });
	assert.deepEqual(parsed.snapshot, root);
	assert.equal(parsed.snapshot.version, 1);
	assert.equal(parsed.snapshot.revision.profile, PROFILE);
	assert.equal(parsed.snapshot.revision.used, 0);
	const representation = renderInitial(root);
	assert.ok(representation.includes(`initial-revision="${root.revision.id}"`));
	assert.ok(representation.includes(`profile="${PROFILE}"`));
	assert.ok(representation.includes(`capacity="${CAPACITY}" initial-used="0" initial-remaining="${CAPACITY}"`));
	assert.ok(representation.endsWith('initial-body="" />'));
	for (const candidate of [
		newSnapshot(newRevision("nonempty", undefined, "create", "fixture")),
		newSnapshot(newRevision("", root.revision, "clear", "fixture"), root),
		newSnapshot(newRevision("", root.revision, "restore", "fixture", root.revision.id), root),
		newSnapshot(root.revision, root),
		newSnapshot(newRevision("", root.revision, "create", "fixture")),
	]) {
		assert.equal(isInitialSnapshot(candidate), false);
		assert.throws(() => parseEnvelope({ version: 2, kind: "initial", snapshot: candidate }), {
			code: "INVALID_INITIALIZATION",
		});
		assert.throws(() => renderInitial(candidate), { code: "INVALID_INITIALIZATION" });
	}
	assert.throws(() => parseEnvelope({ version: 2, kind: "carry", snapshot: root }), { code: "UNSUPPORTED_FORMAT" });
});

test("an initialization cannot reset or duplicate an existing adoption", () => {
	const manager = SessionManager.inMemory();
	const root = initial();
	append(manager, root);
	append(manager, root);
	assert.throws(() => resolveAdoption(manager.getBranch()), { code: "ADOPTION_CONFLICT" });
});

for (const codemode of [false, true]) {
	test(`first native write is append-only; subsequent nonempty replacement retires its full predecessor: codemode=${codemode}`, async (t) => {
		const f = await fixture(t, { codemode });
		const root = selected(f);
		const source = assertCurrent(f.manager.getBranch(), root);
		assert.equal(source.envelope.kind, "initial");
		const immutable = structuredClone(source.entry);
		const before = ordinaryMessages(buildSessionProjection(f.manager.getBranch()).messages);
		const call = codemode
			? fauxToolCall("codemode", {
					code: `text(await tools.register_write({base_revision:${JSON.stringify(root.revision.id)},action:"replace",text:"first synthetic note"}));`,
				})
			: fauxToolCall("register_write", {
					base_revision: root.revision.id,
					action: "replace",
					text: "first synthetic note",
				});
		f.respond([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("saved")]);
		await f.session.prompt("Store the first synthetic note.");
		assert.equal(f.session.getLastAssistantText(), "saved");
		const first = selected(f);
		assert.equal(first.revision.body, "first synthetic note");
		assert.equal(carriers(f.manager.getBranch()).length, 1);
		assert.deepEqual(
			f.manager.getBranch().find((entry) => entry.id === immutable.id),
			immutable,
		);
		assert.equal(f.manager.getBranch().filter((entry) => entry.type === "context_edit").length, 0);
		const earlier = f.requests[0]?.context.messages;
		const later = f.requests[1]?.context.messages;
		assert.ok(earlier && later);
		assert.deepEqual(later.slice(0, earlier.length), earlier, "first write must preserve the complete prepared prefix");
		assert.deepEqual(
			ordinaryMessages(buildSessionProjection(f.manager.getBranch()).messages).slice(0, before.length),
			before,
		);
		const nextRevision = newRevision("second synthetic note", first.revision, "replace", "fixture");
		const drafts = publicationDrafts(f.manager.getBranch(), newSnapshot(nextRevision, first), "adopt");
		assert.ok(drafts.some((draft) => draft.type === "context_edit"));
		await replace(f, nextRevision.body);
		const last = f.requests.at(-1);
		assert.ok(last);
		assert.ok(!text(last.context).includes(render(first)), "no stale nonempty managed body survives");
		assert.ok(text(last.context).includes(renderInitial(root)));
		assert.equal(text(last.context).split("<session-register revision=").length - 1, 1);
		assert.deepEqual(f.errors, []);
	});
}

test("legacy v1 empty publication remains unchanged and writable without retrofitting initialization", async (t) => {
	const legacy = initial();
	const f = await fixture(t, {
		manager: (cwd) => {
			const manager = SessionManager.inMemory(cwd);
			manager.appendCustomMessageEntry(PUBLICATION_TYPE, render(legacy), false, {
				register: { version: 1, kind: "adopt", snapshot: legacy },
			});
			return manager;
		},
	});
	assert.equal(selected(f).adoptionId, legacy.adoptionId);
	assert.equal(assertCurrent(f.manager.getBranch(), legacy).envelope.kind, "adopt");
	assert.equal(
		f.manager.getBranch().some((entry) => entryEnvelope(entry)?.kind === "initial"),
		false,
	);
	await replace(f, "legacy note retained");
	assert.ok(text(f.requests[0]?.context as NonNullable<(typeof f.requests)[0]>["context"]).includes(render(legacy)));
	assert.equal(
		f.manager.getBranch().some((entry) => entry.type === "context_edit"),
		true,
	);
	assert.deepEqual(f.errors, []);
});

test("clear and restore of empty content remain ordinary new adoptions, not new initialization metadata", async (t) => {
	const f = await fixture(t);
	const root = selected(f);
	await replace(f, "temporary content");
	f.respond([
		fauxAssistantMessage(fauxToolCall("register_write", { base_revision: selected(f).revision.id, action: "clear" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("cleared"),
	]);
	await f.session.prompt("Clear the working notes.");
	const cleared = selected(f);
	assert.equal(cleared.revision.body, "");
	assert.equal(cleared.revision.operation, "clear");
	assert.equal(assertCurrent(f.manager.getBranch(), cleared).envelope.kind, "adopt");
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("register_restore", { base_revision: cleared.revision.id, revision: root.revision.id }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("restored"),
	]);
	await f.session.prompt("Restore the initial empty revision as a new revision.");
	const restored = selected(f);
	assert.equal(restored.revision.body, "");
	assert.equal(restored.revision.operation, "restore");
	assert.equal(restored.revision.restoredFrom, root.revision.id);
	assert.notEqual(restored.revision.id, root.revision.id);
	assert.equal(assertCurrent(f.manager.getBranch(), restored).envelope.kind, "adopt");
	assert.equal(f.manager.getBranch().filter((entry) => entryEnvelope(entry)?.kind === "initial").length, 1);
	assert.deepEqual(f.errors, []);
});

for (const checkpoint of [false, true]) {
	test(`relocating the original empty adoption has one current body despite visible origin metadata: checkpoint=${checkpoint}`, () => {
		const manager = SessionManager.inMemory();
		const root = initial();
		const origin = append(manager, root);
		manager.appendMessage({ role: "user", content: "ordinary tail", timestamp: 1 });
		if (checkpoint) {
			const envelope: Checkpoint = {
				version: 1,
				kind: "checkpoint",
				snapshot: root,
				ordinarySummary: "Ordinary summary remains unchanged.",
				carrier: true,
			};
			manager.appendCompaction(renderCheckpoint(envelope), origin, 100, { register: envelope }, true);
		} else append(manager, root, "carry");
		const branch = manager.getBranch();
		const active = assertCurrent(branch, root);
		assert.equal(active.envelope.kind, checkpoint ? "checkpoint" : "carry");
		assert.equal(carriers(branch).length, 1);
		const messages = buildSessionProjection(branch).messages;
		assertRequest(messages, active, branch);
		assert.ok(messages.some((message) => message.role === "custom" && message.content === renderInitial(root)));
	});
}

for (const checkpoint of [false, true]) {
	for (const changed of ["revision", "previousAdoption"] as const) {
		test(`same adoption ID cannot authorize a conflicting ${changed} in ${checkpoint ? "checkpoint" : "carry"}`, () => {
			const manager = SessionManager.inMemory();
			const root = initial();
			const origin = append(manager, root);
			const conflicting: Snapshot =
				changed === "revision"
					? { ...root, revision: newRevision("conflicting current text", root.revision, "replace", "fixture") }
					: { ...root, previousAdoption: "conflicting-ancestor" };
			if (checkpoint) {
				const register: Checkpoint = {
					version: 1,
					kind: "checkpoint",
					snapshot: conflicting,
					ordinarySummary: "ordinary",
					carrier: true,
				};
				manager.appendCompaction(renderCheckpoint(register), origin, 100, { register }, true);
			} else append(manager, conflicting, "carry");
			assert.throws(() => resolveAdoption(manager.getBranch()), { code: "CARRIER_CONFLICT" });
			assert.throws(() => carriers(manager.getBranch()), { code: "CARRIER_CONFLICT" });
		});
	}
}

test("historical empty origin cannot mask a missing, altered, or duplicated current body", () => {
	const manager = SessionManager.inMemory();
	const root = initial();
	const origin = append(manager, root);
	const current = newSnapshot(newRevision("must never become empty", root.revision, "replace", "fixture"), root);
	const body = append(manager, current);
	const branch = manager.getBranch();
	const active = assertCurrent(branch, current);
	const messages = buildSessionProjection(branch).messages;
	const onlyInitial = messages.filter((message) => message.role !== "custom" || message.content !== render(current));
	assert.throws(() => assertRequest(onlyInitial, active, branch), { code: "REQUEST_PROJECTION_CONFLICT" });
	const initialMessage = messages.find(
		(message) => message.role === "custom" && message.content === renderInitial(root),
	);
	assert.ok(initialMessage);
	assert.throws(() => assertRequest([...messages, initialMessage], active, branch), {
		code: "REQUEST_PROJECTION_CONFLICT",
	});
	manager.appendContextEdit(body, null);
	assert.equal(resolveAdoption(manager.getBranch())?.revision.body, current.revision.body);
	assert.throws(() => assertCurrent(manager.getBranch(), current), { code: "INVALID_CURRENT_PROJECTION" });
	manager.appendContextEdit(origin, { content: "tampered origin" });
	assert.throws(() => carriers(manager.getBranch()), { code: "PROJECTED_CONTENT_CONFLICT" });
});

test("an initial-only copied session recovers the exact empty revision without its SQLite database", async (t) => {
	const f = await fixture(t, { manager: (cwd, agentDir) => SessionManager.create(cwd, join(agentDir, "sessions")) });
	const root = selected(f);
	f.respond([fauxAssistantMessage("persisted ordinary work")]);
	await f.session.prompt("Persist this empty workspace.");
	const originalFile = f.manager.getSessionFile();
	assert.ok(originalFile);
	const copied = join(f.root, "initial-copy.jsonl");
	await copyFile(originalFile, copied);
	const recovered = await fixture(t, { manager: () => SessionManager.open(copied) });
	assert.equal(selected(recovered).adoptionId, root.adoptionId);
	assert.equal(selected(recovered).revision.id, root.revision.id);
	assert.equal(selected(recovered).revision.body, "");
	assert.equal(assertCurrent(recovered.manager.getBranch(), root).envelope.kind, "initial");
	await replace(recovered, "independent copied workspace note");
	assert.equal(selected(f).revision.body, "");
	const hybrid = selected(recovered);
	const hybridFile = recovered.manager.getSessionFile();
	assert.ok(hybridFile);
	const hybridCopy = join(f.root, "hybrid-copy.jsonl");
	await copyFile(hybridFile, hybridCopy);
	const copiedAgain = await fixture(t, { manager: () => SessionManager.open(hybridCopy) });
	assert.equal(selected(copiedAgain).adoptionId, hybrid.adoptionId);
	assert.equal(selected(copiedAgain).revision.body, hybrid.revision.body);
	assert.equal(
		copiedAgain.manager.getBranch().some((entry) => entryEnvelope(entry)?.kind === "initial"),
		true,
	);
	copiedAgain.respond([
		(context) => {
			assert.ok(text(context).includes(render(hybrid)));
			assert.ok(text(context).includes(renderInitial(root)));
			return fauxAssistantMessage("hybrid recovered without a database");
		},
	]);
	await copiedAgain.session.prompt("Continue using the exact copied current notes.");
	assert.equal(copiedAgain.session.getLastAssistantText(), "hybrid recovered without a database");
	assert.deepEqual(copiedAgain.errors, []);
	assert.deepEqual(recovered.errors, []);
});

for (const retained of [false, true]) {
	test(`native compaction preserves empty current state before the next request: origin retained=${retained}`, async (t) => {
		const f = await fixture(t, {
			keepRecentTokens: retained ? 1_000 : 20,
			manager: retained
				? (cwd) => {
						const manager = SessionManager.inMemory(cwd);
						manager.appendMessage({ role: "user", content: "old ordinary work ".repeat(1_000), timestamp: 1 });
						manager.appendMessage(fauxAssistantMessage("Old ordinary response. ".repeat(200)));
						return manager;
					}
				: undefined,
		});
		const root = selected(f);
		f.respond([fauxAssistantMessage(retained ? "brief recent progress" : "Long ordinary progress. ".repeat(200))]);
		await f.session.prompt("Make ordinary progress without editing Register.");
		if (retained) {
			// The native prompt/tool-state message is also part of the tail. Choose
			// the boundary from its real size, not an arbitrary threshold that drops the origin.
			const projected = buildSessionProjection(f.manager.getBranch()).entries;
			const origin = projected.findIndex((entry) => entryEnvelope(entry.sourceEntry)?.kind === "initial");
			assert.ok(origin > 0);
			const suffix = projected.slice(origin).flatMap((entry) => entry.messages);
			const keepRecentTokens = suffix.reduce((sum, message) => sum + estimateTokens(message), 0) + 1;
			f.settings.applyOverrides({ compaction: { ...f.settings.getCompactionSettings(), keepRecentTokens } });
		}
		const summary = (context: Parameters<typeof text>[0]) => {
			assert.ok(getCurrentSystemPrompt(context.messages).startsWith("You are a context summarization assistant."));
			assert.ok(!text(context).includes(renderInitial(root)), "origin metadata is not ordinary summary input");
			return fauxAssistantMessage("Ordinary summary only.");
		};
		f.respond([summary, summary]);
		const compacted = await f.session.compact();
		assert.ok(compacted);
		assert.equal(selected(f).adoptionId, root.adoptionId);
		assert.equal(selected(f).revision.body, "");
		const active = assertCurrent(f.manager.getBranch(), root);
		assert.equal(active.envelope.kind, retained ? "initial" : "checkpoint");
		f.respond([
			(context) => {
				assert.ok(text(context).includes(renderEnvelope(active.envelope)));
				return fauxAssistantMessage("continued with the exact empty revision");
			},
		]);
		await f.session.prompt("Continue the selected empty workspace.");
		assert.equal(f.session.getLastAssistantText(), "continued with the exact empty revision");
		// A replacement checkpoint regenerates the system snapshot timestamp,
		// which is not rendered into provider instructions. Preserve every semantic field.
		const ordinaryBefore = ordinaryMessages(buildSessionProjection(f.manager.getBranch()).messages)
			.filter((message) => message.role !== "compactionSummary")
			.map((message) => (message.role === "system" ? { ...message, timestamp: 0 } : message));
		const previousCheckpoint = [...f.manager.getBranch()].reverse().find((entry) => entry.type === "compaction");
		assert.ok(previousCheckpoint);
		const previousEnvelope = entryEnvelope(previousCheckpoint);
		assert.ok(previousEnvelope?.kind === "checkpoint");
		const hybrid = await replace(f, "Hybrid nonempty current notes.");
		const ordinaryAfter = ordinaryMessages(buildSessionProjection(f.manager.getBranch()).messages)
			.filter((message) => message.role !== "compactionSummary")
			.map((message) => (message.role === "system" ? { ...message, timestamp: 0 } : message));
		assert.deepEqual(ordinaryAfter.slice(0, ordinaryBefore.length), ordinaryBefore);
		const latestCheckpoint = [...f.manager.getBranch()].reverse().find((entry) => entry.type === "compaction");
		assert.ok(latestCheckpoint);
		const latestEnvelope = entryEnvelope(latestCheckpoint);
		assert.ok(latestEnvelope?.kind === "checkpoint");
		assert.equal(latestEnvelope.ordinarySummary, previousEnvelope.ordinarySummary);
		assert.ok(
			!text(f.requests.at(-1)?.context as NonNullable<(typeof f.requests)[0]>["context"]).includes(render(root)),
		);
		if (retained) {
			const projected = buildSessionProjection(f.manager.getBranch()).entries;
			const origin = projected.findIndex((entry) => entryEnvelope(entry.sourceEntry)?.kind === "initial");
			assert.ok(origin > 0);
			const suffix = projected.slice(origin).flatMap((entry) => entry.messages);
			const keepRecentTokens = suffix.reduce((sum, message) => sum + estimateTokens(message), 0);
			f.settings.applyOverrides({ compaction: { ...f.settings.getCompactionSettings(), keepRecentTokens } });
			f.respond([
				(context) => {
					assert.ok(!text(context).includes(render(hybrid)));
					return summary(context);
				},
			]);
			assert.ok(await f.session.compact());
			assert.equal(selected(f).adoptionId, hybrid.adoptionId);
			assert.equal(carriers(f.manager.getBranch()).length, 1);
			f.respond([
				(context) => {
					assert.ok(text(context).includes(renderInitial(root)));
					assert.ok(text(context).includes(render(hybrid)));
					return fauxAssistantMessage("hybrid retained correctly");
				},
			]);
			await f.session.prompt("Continue the hybrid retained state.");
			assert.equal(f.session.getLastAssistantText(), "hybrid retained correctly");
		}
		f.respond([
			fauxAssistantMessage(fauxToolCall("register_write", { base_revision: hybrid.revision.id, action: "clear" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("cleared after compaction"),
		]);
		await f.session.prompt("Clear the current notes after compaction.");
		const cleared = selected(f);
		assert.equal(cleared.revision.body, "");
		assert.equal(cleared.revision.operation, "clear");
		assert.notEqual(cleared.revision.id, root.revision.id);
		assert.equal(assertCurrent(f.manager.getBranch(), cleared).envelope.kind, "adopt");
		assert.deepEqual(f.errors, []);
	});
}
