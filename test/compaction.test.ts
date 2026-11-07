import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { newRevision, newSnapshot, PUBLICATION_TYPE, render, type Snapshot } from "../src/model.ts";
import { assertCurrent, resolveAdoption } from "../src/projection.ts";
import { CAPACITY } from "../src/text.ts";
import { fixture, text } from "./helpers.ts";

function diagnostic(f: Awaited<ReturnType<typeof fixture>>): string {
	const last = [...f.session.messages].reverse().find((m) => m.role === "assistant");
	return JSON.stringify({
		notices: f.notices,
		errors: f.errors,
		last: last?.role === "assistant" ? { stop: last.stopReason, error: last.errorMessage } : undefined,
		requests: f.requests.map((r) => ({
			system: getCurrentSystemPrompt(r.context.messages).slice(0, 80),
			managed: text(r.context).includes("<session-register revision="),
			aborted: r.aborted,
		})),
	});
}

function summarizing(context: Parameters<typeof text>[0]): boolean {
	return getCurrentSystemPrompt(context.messages).startsWith("You are a context summarization assistant.");
}

function summary(context: Parameters<typeof text>[0]) {
	assert.ok(summarizing(context), "must be the native ordinary summary request");
	assert.ok(
		!text(context).includes("<session-register revision="),
		"managed current/previous bodies must not enter either summary phase",
	);
	return fauxAssistantMessage("Ordinary conversation summary.");
}

function largeHistory(sourceSession: string): { snapshot: Snapshot; manager: (cwd: string) => SessionManager } {
	const old = newSnapshot(newRevision("", undefined, "create", sourceSession));
	const snapshot = newSnapshot(newRevision(" x".repeat(CAPACITY), old.revision, "replace", sourceSession), old);
	return {
		snapshot,
		manager: (cwd: string) => {
			const manager = SessionManager.inMemory(cwd);
			const oldPublication = manager.appendCustomMessageEntry(PUBLICATION_TYPE, render(old), false, {
				register: { version: 1, kind: "adopt", snapshot: old },
			});
			manager.appendMessage({ role: "user", content: "ordinary ".repeat(4000), timestamp: 1 });
			const previous = fauxAssistantMessage("Prior ordinary analysis.");
			manager.appendMessage({
				...previous,
				model: "register-test",
				usage: { ...previous.usage, input: 9000, output: 4, totalTokens: 9004 },
			});
			// A completed Register edit invalidates old usage. Native accounting must
			// re-estimate the WHOLE projection, including the new body once.
			manager.appendContextEdit(oldPublication, null);
			manager.appendCustomMessageEntry(PUBLICATION_TYPE, render(snapshot), false, {
				register: { version: 1, kind: "adopt", snapshot },
			});
			manager.appendMessage({ role: "user", content: "recent ".repeat(200), timestamp: 2 });
			return manager;
		},
	};
}

test("full fixed-capacity body participates once in native automatic compaction before the first request", async (t) => {
	const { snapshot, manager } = largeHistory("large-fixture");
	const f = await fixture(t, { contextWindow: 40_000, keepRecentTokens: 50, manager });
	let summaries = 0;
	const respond = (context: Parameters<typeof text>[0]) => {
		if (summarizing(context)) {
			summaries++;
			return summary(context);
		}
		assert.ok(text(context).includes(render(snapshot)));
		assert.equal(text(context).split("<session-register revision=").length - 1, 1);
		return fauxAssistantMessage("done");
	};
	f.respond([respond, respond, respond]);
	await f.session.prompt("Proceed.");
	assert.equal(f.session.getLastAssistantText(), "done", diagnostic(f));
	assert.ok(summaries > 0, "native compaction must include the body added after the usage anchor");
	assertCurrent(f.manager.getBranch(), snapshot);
	assert.deepEqual(f.errors, []);
});

test("queued steering during automatic compaction cannot delay restoration by one request", async (t) => {
	const { snapshot, manager } = largeHistory("queued-fixture");
	const f = await fixture(t, { contextWindow: 40_000, keepRecentTokens: 50, manager });
	let queued = false;
	let firstMain = -1;
	const respond = async (context: Parameters<typeof text>[0]) => {
		if (summarizing(context)) {
			if (!queued) {
				queued = true;
				await f.session.steer("Also preserve the current public interface.");
			}
			return summary(context);
		}
		if (firstMain < 0) firstMain = f.requests.length - 1;
		assert.ok(text(context).includes(render(snapshot)), "first main request, not just eventual visibility");
		assert.equal(text(context).split("<session-register revision=").length - 1, 1);
		return fauxAssistantMessage("continued");
	};
	f.respond([respond, respond, respond, respond]);
	await f.session.prompt("Continue implementation.");
	assert.equal(f.session.getLastAssistantText(), "continued", diagnostic(f));
	assert.ok(queued && firstMain > 0, diagnostic(f));
	assertCurrent(f.manager.getBranch(), snapshot);
	assert.deepEqual(f.errors, []);
});

test("repeated compaction strips previous protected bodies from both native summary phases", async (t) => {
	const f = await fixture(t, { keepRecentTokens: 30 });
	const snapshot = resolveAdoption(f.manager.getBranch());
	assert.ok(snapshot);
	for (let i = 0; i < 3; i++) {
		f.respond([fauxAssistantMessage("Ordinary work in this turn. ".repeat(40))]);
		await f.session.prompt(`Advance step ${i}`);
		// A split turn may require both history and turn-prefix summaries.
		f.respond([summary, summary]);
		await f.session.compact().catch((error) => {
			throw new Error(`${String(error)} ${diagnostic(f)}`);
		});
		assertCurrent(f.manager.getBranch(), snapshot);
		assert.equal(f.controller.exportArchive(f.context).revisions.length, 1);
	}
	assert.deepEqual(f.errors, []);
});

test("overflow recovery retries with exactly one immediately available current body", async (t) => {
	const f = await fixture(t, {
		keepRecentTokens: 30,
		manager: (cwd) => {
			const manager = SessionManager.inMemory(cwd);
			manager.appendMessage({ role: "user", content: "Earlier ordinary context. ".repeat(100), timestamp: 1 });
			return manager;
		},
	});
	const snapshot = resolveAdoption(f.manager.getBranch());
	assert.ok(snapshot);
	const recover = (context: Parameters<typeof text>[0]) => {
		if (summarizing(context)) return summary(context);
		assert.ok(text(context).includes(render(snapshot)));
		assert.equal(text(context).split("<session-register revision=").length - 1, 1);
		return fauxAssistantMessage("recovered");
	};
	f.respond([
		fauxAssistantMessage([], {
			stopReason: "error",
			errorMessage: "This model's maximum context length is 100000 tokens; the context is too long.",
		}),
		recover,
		recover,
		recover,
	]);
	await f.session.prompt("Continue.");
	assert.equal(f.session.getLastAssistantText(), "recovered", diagnostic(f));
	assertCurrent(f.manager.getBranch(), snapshot);
	assert.deepEqual(f.errors, []);
});
