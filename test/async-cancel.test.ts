import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { PRODUCER_QUERY } from "../src/compaction.ts";
import { object } from "../src/model.ts";
import { assertCurrent, resolveAdoption } from "../src/projection.ts";
import { fixture } from "./helpers.ts";

test("a late ordinary summary cannot commit after public cancellation", { timeout: 10_000 }, async (t) => {
	let entered: () => void = () => undefined;
	let release: () => void = () => undefined;
	const began = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let produced = 0;
	const f = await fixture(t, {
		keepRecentTokens: 30,
		before: (pi) => {
			pi.events.on(PRODUCER_QUERY, (value) => {
				const request = object(value);
				(request.offer as (producer: unknown) => void)({
					id: "late-cancellation-fixture",
					version: 1,
					acquire: () => () => undefined,
					produce: async (event: SessionBeforeCompactEvent) => {
						produced++;
						entered();
						await gate;
						return {
							compaction: {
								summary: "Late result that must be discarded.",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					},
				});
			});
		},
	});
	f.respond([fauxAssistantMessage("Completed ordinary work. ".repeat(70))]);
	await f.session.prompt("Make ordinary progress.");
	const before = resolveAdoption(f.manager.getBranch());
	assert.ok(before);
	const leaf = f.manager.getLeafId();
	const compacting = f.session.compact();
	const rejected = assert.rejects(compacting, /cancel|abort/i);
	await began;
	const aborting = f.session.abort();
	release();
	await Promise.all([rejected, aborting]);
	assert.equal(produced, 1);
	assert.equal(f.manager.getLeafId(), leaf);
	assert.equal(
		f.manager.getBranch().some((entry) => entry.type === "compaction"),
		false,
	);
	assertCurrent(f.manager.getBranch(), before);
	assert.equal(f.requests.length, 1);
});
