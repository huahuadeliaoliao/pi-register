import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { renderInitial, SELECTION_TYPE } from "../src/model.ts";
import { assertCurrent, resolveAdoption } from "../src/projection.ts";
import { fixture, text } from "./helpers.ts";

test("navigating before the first publication creates and immediately presents a fresh empty adopted state", async (t) => {
	const f = await fixture(t, { manager: (cwd, agentDir) => SessionManager.create(cwd, join(agentDir, "sessions")) });
	const first = resolveAdoption(f.manager.getBranch());
	const publication = f.manager.getLeafId();
	assert.ok(first && publication);
	f.respond([fauxAssistantMessage("completed ordinary work")]);
	await f.session.prompt("Start work.");
	await f.session.navigateTree(publication, { summarize: false });
	const next = resolveAdoption(f.manager.getBranch());
	assert.ok(next, JSON.stringify(f.notices));
	assert.notEqual(next.revision.id, first.revision.id);
	assert.equal(next.revision.body, "");
	assertCurrent(f.manager.getBranch(), next);
	const leaf = f.manager.getLeafEntry();
	assert.ok(leaf?.type === "custom" && leaf.customType === SELECTION_TYPE);
	const file = f.manager.getSessionFile();
	assert.ok(file);
	assert.equal(resolveAdoption(SessionManager.open(file).getBranch())?.adoptionId, next.adoptionId);
	f.respond([
		(context) => {
			assert.ok(text(context).includes(renderInitial(next)));
			return fauxAssistantMessage("continued");
		},
	]);
	await f.session.prompt("Continue the selected branch.");
	assert.equal(f.session.getLastAssistantText(), "continued");
	assert.deepEqual(f.errors, []);
});

test("unchanged turns preserve the entire prior request prefix and the Register anchor", async (t) => {
	const f = await fixture(t);
	const snapshot = resolveAdoption(f.manager.getBranch());
	assert.ok(snapshot);
	f.respond([fauxAssistantMessage("first answer")]);
	await f.session.prompt("First small task.");
	f.respond([fauxAssistantMessage("second answer")]);
	await f.session.prompt("Second small task.");
	assert.equal(f.requests.length, 2);
	const previous = f.requests[0]?.context.messages;
	const next = f.requests[1]?.context.messages;
	assert.ok(previous && next);
	assert.deepEqual(next.slice(0, previous.length), previous);
	assert.equal(resolveAdoption(f.manager.getBranch())?.adoptionId, snapshot.adoptionId);
	assert.equal(
		text(f.requests[0]?.context as NonNullable<(typeof f.requests)[0]>["context"]).split(renderInitial(snapshot))
			.length - 1,
		1,
	);
	assert.equal(
		text(f.requests[1]?.context as NonNullable<(typeof f.requests)[0]>["context"]).split(renderInitial(snapshot))
			.length - 1,
		1,
	);
	assert.deepEqual(f.errors, []);
});
