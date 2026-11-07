import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { PRODUCER_QUERY } from "../src/compaction.ts";
import { object, PUBLICATION_TYPE } from "../src/model.ts";
import { assertCurrent, resolveAdoption } from "../src/projection.ts";
import { fixture, text } from "./helpers.ts";

function companion(pi: ExtensionAPI, options: { version?: number; fail?: boolean } = {}) {
	const state = { leases: 0, ordinaryCalls: 0, legacyCalls: 0 };
	const produce = async (
		event: SessionBeforeCompactEvent,
		_ctx: ExtensionContext,
	): Promise<SessionBeforeCompactResult> => {
		state.ordinaryCalls++;
		assert.ok(
			!event.preparation.messagesToSummarize.some((m) => m.role === "custom" && m.customType === PUBLICATION_TYPE),
		);
		assert.ok(
			!event.preparation.turnPrefixMessages.some((m) => m.role === "custom" && m.customType === PUBLICATION_TYPE),
		);
		assert.ok(!event.preparation.previousSummary?.includes("<session-register revision="));
		assert.ok(
			!event.branchEntries.some((entry) => entry.type === "custom_message" && entry.customType === PUBLICATION_TYPE),
		);
		if (options.fail) throw new Error("injected ordinary producer failure");
		return {
			compaction: {
				summary: "Ordinary producer summary.",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { selectedProducer: "fixture", readFiles: ["retained.ts"], modifiedFiles: [] },
			},
		};
	};
	pi.events.on(PRODUCER_QUERY, (value) => {
		const request = object(value);
		assert.equal(typeof request.offer, "function");
		(request.offer as (producer: unknown) => void)({
			id: "fixture",
			version: options.version ?? 1,
			produce,
			acquire: () => {
				state.leases++;
				let released = false;
				return () => {
					if (!released) {
						released = true;
						state.leases--;
					}
				};
			},
		});
	});
	pi.on("session_before_compact", async (event, ctx) => {
		if (state.leases) return;
		state.legacyCalls++;
		return produce(event, ctx);
	});
	return state;
}

for (const order of ["before", "after"] as const) {
	test(`explicit ordinary producer cooperation is independent of ${order} load order`, async (t) => {
		let state: ReturnType<typeof companion> | undefined;
		const setup = (pi: ExtensionAPI) => {
			state = companion(pi);
		};
		const f = await fixture(t, { [order]: setup, keepRecentTokens: 30 });
		assert.ok(state);
		const active = state;
		assert.equal(active.leases, 1);
		const snapshot = resolveAdoption(f.manager.getBranch());
		assert.ok(snapshot);
		for (let i = 0; i < 2; i++) {
			f.respond([fauxAssistantMessage("Ordinary progress. ".repeat(60))]);
			await f.session.prompt("Advance.");
			await f.session.compact();
			assertCurrent(f.manager.getBranch(), snapshot);
		}
		assert.equal(active.ordinaryCalls, 2);
		assert.equal(active.legacyCalls, 0);
		const last = f.manager
			.getBranch()
			.filter((e) => e.type === "compaction")
			.at(-1);
		assert.ok(last?.type === "compaction");
		assert.equal((last.details as { selectedProducer: string }).selectedProducer, "fixture");
		f.controller.stop();
		assert.equal(active.leases, 0);
		assert.deepEqual(f.errors, []);
	});
}

test("an ordinary producer failure cancels without calling the default summarizer", async (t) => {
	const f = await fixture(t, {
		before: (pi) => {
			companion(pi, { fail: true });
		},
		keepRecentTokens: 30,
	});
	f.respond([fauxAssistantMessage("Ordinary task progress. ".repeat(50))]);
	await f.session.prompt("Work.");
	const before = resolveAdoption(f.manager.getBranch());
	assert.ok(before);
	await assert.rejects(f.session.compact(), /cancel/i);
	assert.equal(f.requests.length, 1);
	assertCurrent(f.manager.getBranch(), before);
	assert.ok(f.notices.some((n) => n.includes("injected ordinary producer failure")));
});

test("an offered unsupported protocol is not mistaken for an absent producer", async (t) => {
	const f = await fixture(t, {
		before: (pi) => {
			companion(pi, { version: 999 });
		},
		keepRecentTokens: 30,
	});
	assert.ok(f.notices.some((n) => n.includes("protocol version 1")));
	f.respond([fauxAssistantMessage("Ordinary progress. ".repeat(50))]);
	await f.session.prompt("Work.");
	await assert.rejects(f.session.compact(), /cancel/i);
	assert.equal(f.requests.length, 1, "no unprotected fallback request");
});

test("multiple ordinary producers are diagnosed rather than selected by registration order", async (t) => {
	const f = await fixture(t, {
		before: (pi) => {
			companion(pi);
			companion(pi);
		},
		keepRecentTokens: 30,
	});
	assert.ok(f.notices.some((n) => n.includes("Multiple ordinary compaction")));
	f.respond([fauxAssistantMessage("Ordinary progress. ".repeat(50))]);
	await f.session.prompt("Work.");
	const before = resolveAdoption(f.manager.getBranch());
	assert.ok(before);
	await assert.rejects(f.session.compact(), /cancel/i);
	assertCurrent(f.manager.getBranch(), before);
});

test("producer lease renegotiates on reload without leaking a stale coordinator", async (t) => {
	const states: ReturnType<typeof companion>[] = [];
	const f = await fixture(t, {
		after: (pi) => {
			states.push(companion(pi));
		},
		keepRecentTokens: 30,
	});
	assert.equal(states[0]?.leases, 1);
	await f.session.reload();
	assert.equal(states[0]?.leases, 0);
	assert.equal(states[1]?.leases, 1);
	f.respond([fauxAssistantMessage("Some ordinary work. ".repeat(50))]);
	await f.session.prompt("Work.");
	await f.session.compact();
	assert.equal(states[0]?.ordinaryCalls, 0);
	assert.equal(states[1]?.ordinaryCalls, 1);
	assert.ok(!f.requests.some((r) => text(r.context).includes("No more faux")));
	assert.deepEqual(f.errors, []);
});
