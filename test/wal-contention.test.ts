import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { newRevision } from "../src/model.ts";
import { RevisionStore } from "../src/store.ts";

interface WorkerResult {
	ok: boolean;
	attempts: number;
	busy: number;
	count?: number;
	code?: string;
	errcode?: number;
	elapsedMs: number;
}

for (const release of [true, false]) {
	test(`real DELETE-mode reader lock: ${release ? "released after an observed BUSY" : "held through one deadline"}`, {
		timeout: 20_000,
	}, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "register-wal-contention-"));
		t.after(async () => rm(root, { recursive: true, force: true }));
		const path = join(root, "register.sqlite");
		const signal = join(root, "wal-attempt");
		const original = newRevision("preserve the original synthetic row", undefined, "create", "wal-fixture");
		const seed = new RevisionStore(path);
		seed.put(original);
		seed.close();
		const blocker = new DatabaseSync(path);
		blocker.exec("PRAGMA journal_mode=DELETE; BEGIN;");
		blocker.prepare("SELECT id FROM revisions").get();
		let held = true;
		const unlock = () => {
			if (!held) return;
			blocker.exec("COMMIT");
			blocker.close();
			held = false;
		};
		t.after(unlock);
		const child = spawn(process.execPath, [fileURLToPath(new URL("./wal-worker.ts", import.meta.url)), path, signal], {
			cwd: root,
			env: {
				PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
				HOME: root,
				PI_CODING_AGENT_DIR: join(root, "agent"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		t.after(() => child.kill("SIGKILL"));
		let output = "";
		let error = "";
		let exited = false;
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			error += String(chunk);
		});
		const result = new Promise<number | null>((resolve) =>
			child.on("close", (code) => {
				exited = true;
				resolve(code);
			}),
		);
		const deadline = performance.now() + 10_000;
		while (!existsSync(`${signal}.busy`) && !exited) {
			assert.ok(performance.now() < deadline, "worker never reached the WAL lock transition");
			await delay(5);
		}
		assert.ok(existsSync(`${signal}.busy`), `no native BUSY observed: ${output} ${error}`);
		if (release) unlock();
		assert.equal(await result, 0, error);
		const info = JSON.parse(output) as WorkerResult;
		assert.ok(info.attempts >= 2 && info.busy >= 1, JSON.stringify(info));
		if (release) {
			assert.equal(info.ok, true, JSON.stringify(info));
			assert.equal(info.count, 1);
		} else {
			assert.equal(info.ok, false);
			assert.equal(info.code, "ERR_SQLITE_ERROR");
			assert.equal((info.errcode ?? 0) & 0xff, 5);
			assert.ok(info.elapsedMs >= 1_800 && info.elapsedMs < 4_000, JSON.stringify(info));
			assert.equal(blocker.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
			unlock();
		}
		// Failure must have released the child connection, and neither path may lose history.
		const restored = new RevisionStore(path);
		try {
			assert.deepEqual(restored.get(original.id), original);
			assert.equal(restored.database.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
			assert.equal(restored.database.prepare("PRAGMA busy_timeout").get()?.timeout, 2_000);
		} finally {
			restored.close();
		}
		t.diagnostic(JSON.stringify(info));
	});
}

test("constructor rollback and close failures cannot replace the triggering revalidation error", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "register-wal-cleanup-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const path = join(root, "register.sqlite");
	const prepare = DatabaseSync.prototype.prepare;
	const exec = DatabaseSync.prototype.exec;
	const close = DatabaseSync.prototype.close;
	const busy = Object.assign(new Error("injected WAL BUSY"), { errcode: 5 });
	const trigger = new Error("injected identity revalidation error");
	let versionReads = 0;
	let walAttempts = 0;
	let rollbacks = 0;
	let closes = 0;
	t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
		if (sql === "PRAGMA user_version" && ++versionReads === 2) throw trigger;
		const statement = prepare.call(this, sql);
		if (sql !== "PRAGMA journal_mode=WAL") return statement;
		return new Proxy(statement, {
			get(target, property, receiver) {
				if (property === "get")
					return () => {
						walAttempts++;
						throw busy;
					};
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	});
	t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
		exec.call(this, sql);
		if (sql === "ROLLBACK") {
			rollbacks++;
			throw new Error("injected rollback cleanup error");
		}
	});
	t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
		closes++;
		close.call(this);
		throw new Error("injected close cleanup error");
	});
	assert.throws(
		() => new RevisionStore(path),
		(error) => error === trigger,
	);
	assert.equal(walAttempts, 1);
	assert.equal(rollbacks, 1);
	assert.equal(closes, 1);
	t.mock.restoreAll();
	const raw = new DatabaseSync(path);
	raw.exec("BEGIN EXCLUSIVE; ROLLBACK;");
	assert.equal(raw.prepare("PRAGMA user_version").get()?.user_version, 0);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n, 0);
	raw.close();
});
