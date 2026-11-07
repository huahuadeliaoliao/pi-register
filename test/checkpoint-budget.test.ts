import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Checkpoint, newRevision, newSnapshot, renderCheckpoint } from "../src/model.ts";
import { assertCurrent, resolveAdoption } from "../src/projection.ts";
import { CAPACITY } from "../src/text.ts";
import { fixture, text } from "./helpers.ts";

for (const growth of [false, true]) {
	test(
		growth
			? "checkpoint-only growth triggers native compaction before the next main request"
			: "checkpoint-only relocation does not count the old and new Register body twice",
		async (t) => {
			const initial = newSnapshot(
				newRevision(growth ? "" : " x".repeat(CAPACITY - 100), undefined, "create", "portable-checkpoint"),
			);
			const f = await fixture(t, {
				contextWindow: 40_000,
				keepRecentTokens: 50,
				models: [{ id: "register-test", contextWindow: 40_000, maxTokens: 20_000, reasoning: true }],
				manager: (cwd) => {
					const manager = SessionManager.inMemory(cwd);
					const register: Checkpoint = {
						version: 1,
						kind: "checkpoint",
						snapshot: initial,
						ordinarySummary: "Earlier ordinary progress.",
						carrier: true,
					};
					manager.appendCompaction(renderCheckpoint(register), null, 100, { register }, true);
					return manager;
				},
			});
			let summaries = 0;
			let summariesAtMain = -1;
			const next = (context: Parameters<typeof text>[0]) => {
				if (getCurrentSystemPrompt(context.messages).startsWith("You are a context summarization assistant.")) {
					summaries++;
					assert.ok(!text(context).includes("<session-register revision="));
					return fauxAssistantMessage("Ordinary summary after the body change.");
				}
				summariesAtMain = summaries;
				const current = resolveAdoption(f.manager.getBranch());
				assert.ok(current);
				assert.ok(text(context).includes(current.revision.body));
				assert.equal(text(context).split("<session-register revision=").length - 1, 1);
				const done = fauxAssistantMessage("done");
				return { ...done, usage: { ...done.usage, input: 17_000, output: 2, totalTokens: 17_002 } };
			};
			const write = fauxAssistantMessage(
				fauxToolCall("register_write", {
					base_revision: initial.revision.id,
					action: "append",
					text: growth ? " x".repeat(CAPACITY) : "\nAdded.",
				}),
				{ stopReason: "toolUse" },
			);
			const input = growth ? 1500 : 17_000;
			const output = growth ? 15_200 : 100;
			f.respond([
				{ ...write, usage: { ...write.usage, input, output, totalTokens: input + output } },
				next,
				next,
				next,
				next,
				next,
			]);
			await f.session.prompt("Update the working state, then continue.");
			assert.equal(
				f.session.getLastAssistantText(),
				"done",
				JSON.stringify({ notices: f.notices, requests: f.requests.length }),
			);
			assert.ok(
				growth ? summariesAtMain > 0 : summariesAtMain === 0,
				"native accounting must reflect the final projection exactly once",
			);
			const current = resolveAdoption(f.manager.getBranch());
			assert.ok(current);
			assertCurrent(f.manager.getBranch(), current);
			assert.deepEqual(f.errors, []);
		},
	);
}
