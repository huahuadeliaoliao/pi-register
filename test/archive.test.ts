import assert from "node:assert/strict";
import test from "node:test";
import { newRevision, newSnapshot, type Revision } from "../src/model.ts";
import { RevisionStore } from "../src/store.ts";
import { hash } from "../src/text.ts";

const revision = (body: string, parent?: Revision) =>
	newRevision(body, parent, parent ? "edit" : "create", "archive-test");
function signed(contents: Record<string, unknown>) {
	return { ...contents, checksum: hash(JSON.stringify(contents)) };
}

test("missing ancestry is allowed, but closing a previously missing cycle is atomic and rejected", (t) => {
	const store = new RevisionStore();
	t.after(() => store.close());
	const b = revision("b");
	const a = { ...revision("a"), parent: b.id };
	store.put(a);
	assert.deepEqual(store.closure([a.id]).missing, [b.id]);
	assert.throws(() => store.put({ ...b, parent: a.id }), { code: "REVISION_CYCLE" });
	assert.equal(store.get(b.id), undefined);
	assert.deepEqual(store.get(a.id), a);
});

test("import rejects dependency cycles before committing any revision", (t) => {
	const target = new RevisionStore();
	t.after(() => target.close());
	const root = revision("ordinary root");
	const a = revision("a");
	const b = revision("b");
	const malformedA = { ...a, parent: b.id };
	const malformedB = { ...b, parent: a.id };
	const current = newSnapshot(root);
	const archive = signed({
		format: "pi-register-history",
		version: 1,
		exportedAt: new Date().toISOString(),
		current,
		roots: [root.id, a.id],
		revisions: [root, malformedA, malformedB],
		missing: [],
	});
	assert.throws(() => target.import(archive), { code: "REVISION_CYCLE" });
	assert.equal(target.get(root.id), undefined);
	assert.equal(target.get(a.id), undefined);
	assert.equal(target.get(b.id), undefined);
});

test("archive cannot disguise a missing ancestor as complete or hide out-of-scope revisions", (t) => {
	const source = new RevisionStore();
	const target = new RevisionStore();
	t.after(() => {
		source.close();
		target.close();
	});
	const current = newSnapshot({ ...revision("portable"), parent: "unknown-parent" });
	source.put(current.revision);
	const archive = source.export(current, [current.revision.id]);
	const { checksum: _checksum, ...contents } = archive;
	assert.deepEqual(archive.missing, ["unknown-parent"]);
	assert.throws(() => target.import(signed({ ...contents, missing: [] })), { code: "INVALID_ARCHIVE" });
	assert.throws(() => target.import(signed({ ...contents, missing: ["unknown-parent", "invented-gap"] })), {
		code: "INVALID_ARCHIVE",
	});
	assert.throws(
		() => target.import(signed({ ...contents, revisions: [...contents.revisions, revision("unscoped")] })),
		{ code: "INVALID_ARCHIVE" },
	);
	assert.equal(target.get(current.revision.id), undefined);
	target.import(archive);
	assert.deepEqual(target.closure([current.revision.id]).missing, ["unknown-parent"]);
});

test("identical imported copies deduplicate and the returned normalized archive stays self-consistent", (t) => {
	const source = new RevisionStore();
	const target = new RevisionStore();
	const again = new RevisionStore();
	t.after(() => {
		source.close();
		target.close();
		again.close();
	});
	const r = revision("same");
	source.put(r);
	const archive = source.export(newSnapshot(r), [r.id]);
	const { checksum: _checksum, ...contents } = archive;
	const duplicated = signed({ ...contents, revisions: [r, r] });
	const normalized = target.import(duplicated);
	assert.equal(normalized.revisions.length, 1);
	assert.equal(again.import(normalized).revisions.length, 1);
});

test("published revision and adoption snapshots cannot be mutated through an exported object alias", () => {
	const r = revision("keep immutable");
	const snapshot = newSnapshot(r);
	assert.ok(Object.isFrozen(r));
	assert.ok(Object.isFrozen(snapshot));
	assert.ok(Object.isFrozen(snapshot.revision));
	assert.throws(() => {
		snapshot.revision.body = "mutated outside the edit protocol";
	}, TypeError);
	assert.equal(snapshot.revision.body, "keep immutable");
});

test("raw database ancestry corruption is diagnosed, not converted to a valid empty history", (t) => {
	const store = new RevisionStore();
	t.after(() => store.close());
	const r = revision("valid body");
	store.database
		.prepare("INSERT INTO revisions(id,parent_id,payload) VALUES (?,?,?)")
		.run(r.id, "different-parent", JSON.stringify(r));
	assert.throws(() => store.get(r.id), { code: "DATABASE_INTEGRITY" });
});
