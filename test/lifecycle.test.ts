import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { newRevision, newSnapshot, PUBLICATION_TYPE, render, SELECTION_TYPE } from "../src/model.ts";
import { assertCurrent, resolveAdoption } from "../src/projection.ts";
import { CAPACITY } from "../src/text.ts";
import { fixture, text } from "./helpers.ts";

test("a failed sibling write leaves an earlier successful candidate intact", async (t) => {
	const f = await fixture(t);
	const original = resolveAdoption(f.manager.getBranch());
	assert.ok(original);
	f.respond([
		fauxAssistantMessage(
			[
				fauxToolCall("register_write", {
					base_revision: original.revision.id,
					action: "append",
					text: "accepted first",
				}),
				fauxToolCall("register_write", { base_revision: original.revision.id, action: "append", text: "stale second" }),
			],
			{ stopReason: "toolUse" },
		),
		(context) => {
			const current = resolveAdoption(f.manager.getBranch());
			assert.ok(current);
			assert.equal(current.revision.body, "accepted first");
			assert.ok(text(context).includes("REVISION_CONFLICT"));
			assertCurrent(f.manager.getBranch(), current);
			return fauxAssistantMessage("kept working");
		},
	]);
	await f.session.prompt("Make the change.");
	assert.equal(f.session.getLastAssistantText(), "kept working");
	assert.equal(f.controller.exportArchive(f.context).revisions.length, 2);
	assert.deepEqual(f.errors, []);
});

test("actual codemode nested writes read their staged results and coalesce at one boundary", async (t) => {
	const f = await fixture(t, { codemode: true });
	const original = resolveAdoption(f.manager.getBranch());
	assert.ok(original);
	assert.ok(f.session.getActiveToolNames().includes("codemode"));
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code:
					"const a=await tools.register_write({base_revision:" +
					JSON.stringify(original.revision.id) +
					',action:"append",text:"A"});' +
					'const b=await tools.register_write({base_revision:a.revision,action:"append",text:"B"});text(b);',
			}),
			{ stopReason: "toolUse" },
		),
		(context) => {
			const current = resolveAdoption(f.manager.getBranch());
			assert.ok(current);
			assert.equal(current.revision.body, "AB");
			assert.equal(text(context).split("<session-register revision=").length - 1, 1);
			assertCurrent(f.manager.getBranch(), current);
			return fauxAssistantMessage("done");
		},
	]);
	await f.session.prompt("Continue.");
	assert.equal(f.session.getLastAssistantText(), "done");
	assert.equal(f.controller.exportArchive(f.context).revisions.length, 3);
	assert.equal(
		f.manager.getBranch().filter((e) => e.type === "custom_message" && e.customType === PUBLICATION_TYPE).length,
		2,
	);
	assert.deepEqual(f.errors, []);
});

test("oversize edit returns capacity details and does not change the adopted body", async (t) => {
	const f = await fixture(t);
	const original = resolveAdoption(f.manager.getBranch());
	assert.ok(original);
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("register_write", {
				base_revision: original.revision.id,
				action: "replace",
				text: " x".repeat(CAPACITY + 1),
			}),
			{ stopReason: "toolUse" },
		),
		(context) => {
			assert.equal(resolveAdoption(f.manager.getBranch())?.revision.id, original.revision.id);
			assert.ok(text(context).includes("CAPACITY_EXCEEDED"));
			assert.ok(text(context).includes("current_used"));
			return fauxAssistantMessage("task continued");
		},
	]);
	await f.session.prompt("Work on the task.");
	assert.equal(f.session.getLastAssistantText(), "task continued");
	assert.equal(f.controller.exportArchive(f.context).revisions.length, 1);
});

test("clear and restore preserve intervening history and restore creates a new revision", async (t) => {
	const f = await fixture(t);
	const root = resolveAdoption(f.manager.getBranch());
	assert.ok(root);
	let saved = "";
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("register_write", { base_revision: root.revision.id, action: "replace", text: "keep this" }),
			{ stopReason: "toolUse" },
		),
		() => {
			const head = resolveAdoption(f.manager.getBranch());
			assert.ok(head);
			saved = head.revision.id;
			return fauxAssistantMessage(
				fauxToolCall("register_write", { base_revision: head.revision.id, action: "clear" }),
				{ stopReason: "toolUse" },
			);
		},
		() => {
			const head = resolveAdoption(f.manager.getBranch());
			assert.ok(head);
			assert.equal(head.revision.body, "");
			return fauxAssistantMessage(
				fauxToolCall("register_restore", { base_revision: head.revision.id, revision: saved }),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("restored"),
	]);
	await f.session.prompt("Manage these notes.");
	const current = resolveAdoption(f.manager.getBranch());
	assert.ok(current);
	assert.equal(current.revision.body, "keep this");
	assert.equal(current.revision.restoredFrom, saved);
	assert.notEqual(current.revision.id, saved);
	assert.equal(f.controller.exportArchive(f.context).revisions.length, 4);
	assert.deepEqual(f.errors, []);
});

test("two live persisted sessions share SQLite without exposing each other's revisions", async (t) => {
	const first = await fixture(t, {
		manager: (cwd, agentDir) => SessionManager.create(cwd, join(agentDir, "sessions")),
	});
	const second = await fixture(t, {
		agentDir: first.agentDir,
		manager: (cwd, agentDir) => SessionManager.create(cwd, join(agentDir, "sessions")),
	});
	const a = resolveAdoption(first.manager.getBranch());
	const b = resolveAdoption(second.manager.getBranch());
	assert.ok(a && b);
	for (const [f, initial, canary] of [
		[first, a, "SESSION_A_CANARY"],
		[second, b, "SESSION_B_CANARY"],
	] as const) {
		f.respond([
			fauxAssistantMessage(
				fauxToolCall("register_write", { base_revision: initial.revision.id, action: "append", text: canary }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
	}
	await Promise.all([
		first.session.prompt("First independent task."),
		second.session.prompt("Second independent task."),
	]);
	const headA = resolveAdoption(first.manager.getBranch());
	const headB = resolveAdoption(second.manager.getBranch());
	assert.ok(headA && headB);
	assert.equal(headA.revision.body, "SESSION_A_CANARY");
	assert.equal(headB.revision.body, "SESSION_B_CANARY");
	assert.ok(!first.requests.some((r) => text(r.context).includes("SESSION_B_CANARY")));
	assert.ok(!second.requests.some((r) => text(r.context).includes("SESSION_A_CANARY")));
	assert.throws(() => first.controller.restore(first.context, headA.revision.id, headB.revision.id), {
		code: "REVISION_NOT_ACCESSIBLE",
	});
	assert.ok(!first.controller.exportArchive(first.context).revisions.some((r) => r.id === headB.revision.id));
	assert.deepEqual(first.errors, []);
	assert.deepEqual(second.errors, []);
});

test("no-session reload reconstructs complete in-process revision history without a persistent database", async (t) => {
	const f = await fixture(t);
	const original = resolveAdoption(f.manager.getBranch());
	assert.ok(original);
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("register_write", { base_revision: original.revision.id, action: "append", text: "reload me" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await f.session.prompt("Work.");
	const before = f.controller.exportArchive(f.context);
	await f.session.reload();
	const after = f.controller.exportArchive(f.context);
	assert.equal(after.current.adoptionId, before.current.adoptionId);
	assert.deepEqual(after.revisions, before.revisions);
	f.respond([
		(context) => {
			assert.ok(text(context).includes(render(before.current)));
			return fauxAssistantMessage("resumed");
		},
	]);
	await f.session.prompt("Continue.");
	assert.equal(f.session.getLastAssistantText(), "resumed");
	assert.deepEqual(f.errors, []);
});

test("tree selection is persisted with a non-model entry and earlier contents are restored", async (t) => {
	const f = await fixture(t, { manager: (cwd, agentDir) => SessionManager.create(cwd, join(agentDir, "sessions")) });
	const original = resolveAdoption(f.manager.getBranch());
	assert.ok(original);
	assert.equal(assertCurrent(f.manager.getBranch(), original).envelope.kind, "initial");
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("register_write", { base_revision: original.revision.id, action: "append", text: "later branch" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await f.session.prompt("Implement.");
	const firstUser = f.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
	assert.ok(firstUser);
	await f.session.navigateTree(firstUser.id, { summarize: false });
	assert.equal(resolveAdoption(f.manager.getBranch())?.revision.id, original.revision.id);
	const leaf = f.manager.getLeafEntry();
	assert.ok(leaf?.type === "custom" && leaf.customType === SELECTION_TYPE);
	const file = f.manager.getSessionFile();
	assert.ok(file);
	const reopened = SessionManager.open(file);
	assert.equal(resolveAdoption(reopened.getBranch())?.revision.id, original.revision.id);
	assert.equal(assertCurrent(f.manager.getBranch(), original).envelope.kind, "initial");
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("register_write", {
				base_revision: original.revision.id,
				action: "append",
				text: "new work on the earlier empty branch",
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("earlier branch adopted"),
	]);
	await f.session.prompt("Write on the selected earlier empty branch.");
	const selected = resolveAdoption(f.manager.getBranch());
	assert.ok(selected);
	assert.equal(selected.revision.body, "new work on the earlier empty branch");
	assert.equal(selected.revision.parent, original.revision.id);
	assert.equal(selected.previousAdoption, original.adoptionId);
	assert.equal(resolveAdoption(SessionManager.open(file).getBranch())?.adoptionId, selected.adoptionId);
	assert.deepEqual(f.errors, []);
});

test("storage failure preserves a self-contained current body and makes writes explicitly fail", async (t) => {
	const snapshot = newSnapshot(newRevision("trusted portable body", undefined, "create", "prior-session"));
	const f = await fixture(t, {
		storeFactory: () => {
			throw new Error("injected storage failure");
		},
		manager: (cwd) => {
			const manager = SessionManager.inMemory(cwd);
			manager.appendCustomMessageEntry(PUBLICATION_TYPE, render(snapshot), false, {
				register: { version: 1, kind: "adopt", snapshot },
			});
			return manager;
		},
	});
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("register_write", {
				base_revision: snapshot.revision.id,
				action: "append",
				text: "must not appear",
			}),
			{ stopReason: "toolUse" },
		),
		(context) => {
			assert.ok(text(context).includes(render(snapshot)));
			assert.ok(text(context).includes("injected storage failure"));
			return fauxAssistantMessage("continued with trusted notes");
		},
	]);
	await f.session.prompt("Continue other work.");
	assert.equal(resolveAdoption(f.manager.getBranch())?.revision.id, snapshot.revision.id);
	assert.equal(f.session.getLastAssistantText(), "continued with trusted notes");
	assert.deepEqual(f.errors, []);
});
