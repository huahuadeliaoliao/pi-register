import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type SessionBoundaryDraft, SessionManager } from "@earendil-works/pi-coding-agent";
import { acquireLease } from "../src/lease.ts";
import { type Checkpoint, newRevision, newSnapshot, parseRevision, renderCheckpoint } from "../src/model.ts";
import { assertCurrent, carriers, publication, publicationDrafts, resolveAdoption } from "../src/projection.ts";
import { RevisionStore } from "../src/store.ts";
import { applyEdits, CAPACITY, count, hash, measure, PROFILE } from "../src/text.ts";

function apply(manager: SessionManager, drafts: SessionBoundaryDraft[]): void {
	for (const draft of drafts) {
		switch (draft.type) {
			case "custom_message":
				manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
				break;
			case "custom":
				manager.appendCustomEntry(draft.customType, draft.data);
				break;
			case "context_edit":
				manager.appendContextEdit(draft.targetId, draft.replacement);
				break;
			case "compaction":
				manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 100, draft.details, true, draft.usage);
				break;
		}
	}
}

const revision = (body: string, parent?: ReturnType<typeof newRevision>) =>
	newRevision(body, parent, parent ? "edit" : "create", "test-session");

test("fixed meter counts complete ordinary Unicode text, never interprets specials", () => {
	for (const [text, expected] of [
		["", 0],
		["hello world", 2],
		["你好，世界。", 4],
		["<|endoftext|>", 7],
		["a\r\nb", 3],
		["👩🏽‍💻", 7],
	] as const) {
		assert.equal(count(text), expected);
	}
	assert.equal(count(" x".repeat(CAPACITY)), CAPACITY);
	assert.deepEqual(measure(" x".repeat(CAPACITY)), { used: CAPACITY, remaining: 0 });
	assert.throws(() => measure(" x".repeat(CAPACITY + 1)), { code: "CAPACITY_EXCEEDED" });
	assert.throws(() => count("\ud800"), { code: "INVALID_UNICODE" });
	assert.throws(() => count("\udc00"), { code: "INVALID_UNICODE" });
});

test("edits match original text, are disjoint and all-or-nothing", () => {
	assert.equal(
		applyEdits("abc def", [
			{ oldText: "abc", newText: "def" },
			{ oldText: "def", newText: "last" },
		]),
		"def last",
	);
	assert.throws(
		() =>
			applyEdits("abc", [
				{ oldText: "ab", newText: "x" },
				{ oldText: "bc", newText: "y" },
			]),
		{ code: "OVERLAPPING_EDITS" },
	);
	assert.throws(() => applyEdits("abc abc", [{ oldText: "abc", newText: "x" }]), { code: "EDIT_MATCH" });
	assert.throws(() => applyEdits("abc", [{ oldText: "z", newText: "x" }]), { code: "EDIT_MATCH" });
	assert.throws(() => applyEdits("abc", [{ oldText: "", newText: "x" }]), { code: "INVALID_EDIT" });
	assert.equal(applyEdits("A\nB\r\nC", [{ oldText: "B", newText: "" }]), "A\n\r\nC");
});

test("snapshot validation rejects corrupt counts, profiles, Unicode and identity cycles", () => {
	const r = revision("original");
	assert.deepEqual(parseRevision(r), r);
	assert.throws(() => parseRevision({ ...r, body: "changed" }), { code: "HASH_MISMATCH" });
	assert.throws(() => parseRevision({ ...r, used: r.used + 1 }), { code: "COUNT_MISMATCH" });
	assert.throws(() => parseRevision({ ...r, profile: `${PROFILE}-unknown` }), { code: "UNSUPPORTED_PROFILE" });
	assert.throws(() => parseRevision({ ...r, parent: r.id }), { code: "REVISION_CYCLE" });
	// A valid replacement character and a lone surrogate have the same UTF-8 digest.
	const valid = revision("\ufffd");
	parseRevision(valid);
	assert.equal(hash("\ud800"), valid.hash);
	assert.throws(() => parseRevision({ ...valid, body: "\ud800" }), { code: "INVALID_UNICODE" });
});

test("SQLite keeps immutable revisions, clear/restore history and explicit missing ancestry", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "register-store-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "register.sqlite");
	const store = new RevisionStore(path);
	const first = revision("first");
	const cleared = newRevision("", first, "clear", "test-session");
	const restored = newRevision(first.body, cleared, "restore", "test-session", first.id);
	for (const r of [first, cleared, restored]) store.put(r);
	assert.equal(store.put(first), false);
	assert.throws(() => store.put({ ...first, operation: "append" }), { code: "ID_CONFLICT" });
	assert.throws(() => store.database.prepare("DELETE FROM revisions WHERE id=?").run(first.id), /immutable/);
	assert.throws(
		() => store.database.prepare("UPDATE revisions SET parent_id=NULL WHERE id=?").run(restored.id),
		/immutable/,
	);
	assert.equal(store.closure([restored.id]).revisions.length, 3);
	assert.deepEqual(store.closure([restored.id]).missing, []);
	store.close();
	const reopened = new RevisionStore(path);
	t.after(() => reopened.close());
	assert.deepEqual(reopened.get(restored.id), restored);
	const partial = { ...revision("imported current"), parent: "missing-ancestor" };
	reopened.put(partial);
	assert.deepEqual(reopened.closure([partial.id]).missing, ["missing-ancestor"]);
	assert.equal(reopened.get("missing-ancestor"), undefined);
});

test("archive roundtrip includes branches and staged roots, conflicts roll back imports", (t) => {
	const source = new RevisionStore();
	const target = new RevisionStore();
	t.after(() => {
		source.close();
		target.close();
	});
	const first = revision("root");
	const a = revision("branch-a", first);
	const b = revision("branch-b", first);
	const staged = revision("staged but not adopted", b);
	for (const r of [first, a, b, staged]) source.put(r);
	const snapshot = newSnapshot(a);
	const archive = source.export(snapshot, [a.id, b.id, staged.id]);
	assert.equal(archive.revisions.length, 4);
	target.import(JSON.parse(JSON.stringify(archive)));
	assert.equal(target.closure(archive.roots).revisions.length, 4);
	assert.equal(target.import(archive).current.adoptionId, snapshot.adoptionId);
	assert.throws(() => target.import({ ...archive, missing: ["tampered"] }), { code: "ARCHIVE_CHECKSUM" });
	const conflict = new RevisionStore();
	t.after(() => conflict.close());
	conflict.put({ ...b, operation: "append" });
	assert.throws(() => conflict.import(archive), { code: "ID_CONFLICT" });
	assert.equal(conflict.get(a.id), undefined);
	assert.equal(conflict.get(first.id), undefined);
});

test("cooperative ownership is atomic, live-owner conservative and independent per session file", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "register-lease-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const store = new RevisionStore(join(directory, "register.sqlite"));
	const other = new RevisionStore(store.path);
	t.after(() => {
		other.close();
		store.close();
	});
	const file = join(directory, "session.jsonl");
	const first = acquireLease(store, file);
	assert.throws(() => acquireLease(other, file), { code: "WRITER_CONFLICT" });
	const independent = acquireLease(other, join(directory, "other.jsonl"));
	first.assertOwned();
	independent.release();
	first.release();
	assert.throws(() => first.assertOwned(), { code: "WRITER_CONFLICT" });
	const next = acquireLease(other, file);
	next.assertOwned();
	next.release();
});

test("adoption is branch-relative, never inferred from a candidate or filtered carrier", () => {
	const manager = SessionManager.inMemory();
	const original = newSnapshot(revision("original"));
	apply(manager, [publication(original, "adopt")]);
	const originalLeaf = manager.getLeafId();
	assertCurrent(manager.getBranch(), original);
	const staged = revision("candidate", original.revision);
	assert.equal(resolveAdoption(manager.getBranch())?.revision.id, original.revision.id);
	const adopted = newSnapshot(staged, original);
	const drafts = publicationDrafts(manager.getBranch(), adopted, "adopt");
	apply(manager, drafts.slice(0, -1));
	assert.equal(carriers(manager.getBranch()).length, 0);
	assert.equal(resolveAdoption(manager.getBranch())?.adoptionId, original.adoptionId);
	// Cold recovery restores the old adopted content, not the staged candidate.
	apply(manager, [publication(original, "carry")]);
	assertCurrent(manager.getBranch(), original);
	apply(manager, publicationDrafts(manager.getBranch(), adopted, "adopt"));
	assertCurrent(manager.getBranch(), adopted);
	assert.ok(originalLeaf);
	manager.branch(originalLeaf);
	assertCurrent(manager.getBranch(), original);
});

test("a malformed committed publication fails rather than resurrecting older content", () => {
	const manager = SessionManager.inMemory();
	const original = newSnapshot(revision("original"));
	apply(manager, [publication(original, "adopt")]);
	manager.appendCustomMessageEntry("pi-register", "bad", false, { register: { version: 999 } });
	assert.throws(() => resolveAdoption(manager.getBranch()), { code: "UNSUPPORTED_FORMAT" });
});

test("checkpoint carrier replacement preserves ordinary tail and prior omissions", () => {
	const manager = SessionManager.inMemory();
	const oldMessage = manager.appendMessage({ role: "user", content: "omit this ordinary text", timestamp: 1 });
	const original = newSnapshot(revision("original"));
	apply(manager, [publication(original, "adopt")]);
	const tail = manager.appendMessage({ role: "user", content: "ordinary tail", timestamp: 2 });
	manager.appendContextEdit(oldMessage, null);
	const checkpoint: Checkpoint = {
		version: 1,
		kind: "checkpoint",
		snapshot: original,
		ordinarySummary: "ordinary summary",
		carrier: true,
	};
	manager.appendCompaction(
		renderCheckpoint(checkpoint),
		tail,
		100,
		{ register: checkpoint, companion: { preserved: true } },
		true,
	);
	assertCurrent(manager.getBranch(), original);
	const edited = newSnapshot(revision("new body", original.revision), original);
	const drafts = publicationDrafts(manager.getBranch(), edited, "adopt");
	assert.equal(drafts[0]?.type, "compaction");
	apply(manager, drafts);
	assertCurrent(manager.getBranch(), edited);
	const visible = manager.buildSessionProjection().messages;
	assert.ok(visible.some((m) => m.role === "user" && m.content === "ordinary tail"));
	assert.ok(!visible.some((m) => m.role === "user" && m.content === "omit this ordinary text"));
	assert.ok(visible.some((m) => m.role === "compactionSummary" && m.summary === "ordinary summary"));
	const lastCheckpoint = manager
		.getBranch()
		.filter((e) => e.type === "compaction")
		.at(-1);
	assert.deepEqual(lastCheckpoint?.details && (lastCheckpoint.details as { companion: unknown }).companion, {
		preserved: true,
	});
});

test("checkpoint that retains the standalone body must not duplicate it", () => {
	const manager = SessionManager.inMemory();
	const current = newSnapshot(revision("current"));
	apply(manager, [publication(current, "adopt")]);
	const publicationId = manager.getLeafId();
	assert.ok(publicationId);
	manager.appendMessage({ role: "user", content: "tail", timestamp: 1 });
	const checkpoint: Checkpoint = {
		version: 1,
		kind: "checkpoint",
		snapshot: current,
		ordinarySummary: "summary",
		carrier: false,
	};
	manager.appendCompaction(renderCheckpoint(checkpoint), publicationId, 100, { register: checkpoint }, true);
	assertCurrent(manager.getBranch(), current);
	assert.equal(carriers(manager.getBranch()).length, 1);
});
