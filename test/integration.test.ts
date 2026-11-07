import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { newRevision, newSnapshot, PUBLICATION_TYPE, render, renderInitial } from "../src/model.ts";
import { assertCurrent, resolveAdoption } from "../src/projection.ts";
import { REGISTER_GUIDANCE } from "../src/prompts.ts";
import { fixture, text } from "./helpers.ts";

test("native first request includes empty Register and shared guidance once", async (t) => {
	const architecture = await readFile(new URL("../arch.md", import.meta.url), "utf8");
	const approved = architecture.split("```text\n")[1]?.split("\n```")[0];
	assert.equal(REGISTER_GUIDANCE.length, 6);
	assert.equal(approved, `Session Register\n\n${REGISTER_GUIDANCE.join("\n\n")}`);
	assert.ok(
		REGISTER_GUIDANCE[1]?.includes("You decide what is useful to keep, how to organize it, and when to update it."),
	);
	assert.ok(
		REGISTER_GUIDANCE[1]?.includes(
			"Keep these working materials here rather than scattering them across Markdown files or other scratch documents in the project.",
		),
	);
	assert.ok(
		REGISTER_GUIDANCE[2]?.startsWith(
			"Create new project documents when the user requests a document or an established project requirement explicitly calls for one.",
		),
	);
	assert.ok(REGISTER_GUIDANCE[3]?.includes("instead of merely appending updates"));
	assert.ok(REGISTER_GUIDANCE[4]?.includes("preserve exact values when needed"));
	const f = await fixture(t);
	const initial = resolveAdoption(f.manager.getBranch());
	assert.ok(initial);
	assert.equal(initial.revision.body, "");
	assertCurrent(f.manager.getBranch(), initial);
	f.respond([
		(context) => {
			const actual = text(context);
			assert.ok(actual.includes(renderInitial(initial)));
			assert.equal(actual.split("<session-register-initial-state ").length - 1, 1);
			assert.equal(actual.split("<session-register revision=").length - 1, 0);
			const system = getCurrentSystemPrompt(context.messages);
			for (const paragraph of REGISTER_GUIDANCE) assert.equal(system.split(paragraph).length - 1, 1);
			assert.ok(system.includes("Concise summaries, fragments, shorthand"));
			return fauxAssistantMessage("done");
		},
	]);
	await f.session.prompt("Do this small task.");
	assert.equal(f.session.getLastAssistantText(), "done");
	assert.deepEqual(f.errors, []);
});

test("completed write is adopted before the next provider request", async (t) => {
	const f = await fixture(t);
	const initial = resolveAdoption(f.manager.getBranch());
	assert.ok(initial);
	f.respond([
		() =>
			fauxAssistantMessage(
				fauxToolCall("register_write", {
					base_revision: initial.revision.id,
					action: "append",
					text: "Temporary prototype skips compatibility; revisit at integration.",
				}),
				{ stopReason: "toolUse" },
			),
		(context) => {
			const next = resolveAdoption(f.manager.getBranch());
			assert.ok(next);
			assert.notEqual(next.adoptionId, initial.adoptionId);
			assert.ok(next.revision.body.includes("revisit at integration"));
			assertCurrent(f.manager.getBranch(), next);
			assert.ok(text(context).includes(render(next)));
			assert.ok(text(context).includes(renderInitial(initial)), "initial metadata remains byte-stable, not current");
			assert.equal(text(context).split("<session-register revision=").length - 1, 1);
			assert.equal(text(context).split("<session-register-initial-state ").length - 1, 1);
			return fauxAssistantMessage("finished");
		},
	]);
	await f.session.prompt("Continue the implementation.");
	assert.equal(f.session.getLastAssistantText(), "finished");
	assert.equal(f.requests.length, 2);
	assert.deepEqual(f.errors, []);
});

test("native manual compaction protects the Register in its very first following request", async (t) => {
	const f = await fixture(t, { keepRecentTokens: 50 });
	const initial = resolveAdoption(f.manager.getBranch());
	assert.ok(initial);
	f.respond([
		() =>
			fauxAssistantMessage(
				fauxToolCall("register_write", {
					base_revision: initial.revision.id,
					action: "replace",
					text: "User constraint: preserve the public interface; prototype exception only.",
				}),
				{ stopReason: "toolUse" },
			),
		fauxAssistantMessage("Ordinary project discussion. ".repeat(60)),
	]);
	await f.session.prompt("Investigate the module.");
	const before = resolveAdoption(f.manager.getBranch());
	assert.ok(before);
	f.respond([
		(context) => {
			assert.ok(
				!text(context).includes("<session-register revision="),
				"managed body must not enter the ordinary summary request",
			);
			return fauxAssistantMessage("Ordinary task summary: investigation completed; continue implementation.");
		},
	]);
	await f.session.compact();
	assertCurrent(f.manager.getBranch(), before);
	f.respond([
		(context) => {
			assert.ok(text(context).includes(render(before)));
			assert.equal(text(context).split("<session-register revision=").length - 1, 1);
			return fauxAssistantMessage("continued");
		},
	]);
	await f.session.prompt("Continue from here.");
	assert.equal(f.session.getLastAssistantText(), "continued");
	assert.deepEqual(f.errors, []);
});

test("editing a checkpoint-carried body preserves ordinary context without a new summary call", async (t) => {
	const f = await fixture(t, { keepRecentTokens: 30 });
	f.respond([fauxAssistantMessage("Earlier ordinary context. ".repeat(60))]);
	await f.session.prompt("Discuss the project.");
	f.respond([fauxAssistantMessage("Keep this ordinary summary.")]);
	await f.session.compact();
	const before = resolveAdoption(f.manager.getBranch());
	assert.ok(before);
	f.respond([
		() =>
			fauxAssistantMessage(
				fauxToolCall("register_write", {
					base_revision: before.revision.id,
					action: "append",
					text: "New current note",
				}),
				{ stopReason: "toolUse" },
			),
		(context) => {
			assert.ok(text(context).includes("Keep this ordinary summary."));
			assert.ok(text(context).includes("New current note"));
			assert.equal(text(context).split("<session-register revision=").length - 1, 1);
			return fauxAssistantMessage("done");
		},
	]);
	await f.session.prompt("Update the working note.");
	assert.equal(f.session.getLastAssistantText(), "done");
	assert.deepEqual(f.errors, []);
});

test("cold startup repairs an interrupted retirement without adopting the stored candidate", async (t) => {
	const original = newSnapshot(newRevision("adopted before interruption", undefined, "create", "original-session"));
	const candidate = newRevision("not adopted", original.revision, "edit", "original-session");
	const f = await fixture(t, {
		manager: (cwd) => {
			const manager = SessionManager.inMemory(cwd);
			const publication = manager.appendCustomMessageEntry(PUBLICATION_TYPE, render(original), false, {
				register: { version: 1, kind: "adopt", snapshot: original },
			});
			manager.appendCustomEntry("pi-register-revision", { version: 1, revisionId: candidate.id, revision: candidate });
			manager.appendContextEdit(publication, null);
			return manager;
		},
	});
	f.respond([
		(context) => {
			assert.ok(text(context).includes(render(original)));
			assert.equal(resolveAdoption(f.manager.getBranch())?.revision.id, original.revision.id);
			return fauxAssistantMessage("recovered");
		},
	]);
	await f.session.prompt("Resume the interrupted work.");
	assert.equal(f.session.getLastAssistantText(), "recovered");
	assert.deepEqual(f.errors, []);
});

test("request-local removal of the body aborts rather than sending a missing managed state", async (t) => {
	const f = await fixture(t, {
		before: (pi) => {
			pi.on("context", (event) => ({
				messages: event.messages.filter((m) => m.role !== "custom" || m.customType !== PUBLICATION_TYPE),
			}));
		},
	});
	f.respond([fauxAssistantMessage("must not be delivered")]);
	await f.session.prompt("Proceed.");
	assert.equal(f.requests.filter((request) => !request.aborted).length, 0);
	assert.ok(f.notices.some((message) => message.includes("changed or duplicated")));
	assert.notEqual(f.session.getLastAssistantText(), "must not be delivered");
});
