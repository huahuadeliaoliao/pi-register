import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RevisionStore } from "../src/store.ts";

for (const mode of ["held-initial-writer-lock", "untouched-path-and-WAL"] as const) {
	test(`independent simultaneous SQLite initializers preserve both chains: ${mode}`, { timeout: 30_000 }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "register-concurrent-"));
		t.after(async () => rm(root, { recursive: true, force: true }));
		for (let round = 0; round < (mode === "untouched-path-and-WAL" ? 3 : 1); round++) {
			const path = join(root, `shared-${round}.sqlite`),
				barrier = join(root, `start-${round}`);
			const lock = mode === "held-initial-writer-lock" ? new DatabaseSync(path) : undefined;
			lock?.exec("PRAGMA journal_mode=WAL;BEGIN IMMEDIATE;");
			const workers = ["process-A", "process-B"].map((name) => {
				const child = spawn(
					process.execPath,
					[fileURLToPath(new URL("./sqlite-worker.ts", import.meta.url)), path, barrier, name],
					{
						cwd: root,
						env: {
							PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
							HOME: root,
							PI_CODING_AGENT_DIR: join(root, "agent"),
						},
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let output = "",
					error = "";
				child.stdout.on("data", (data) => {
					output += String(data);
				});
				child.stderr.on("data", (data) => {
					error += String(data);
				});
				const result = new Promise<{ code: number | null; output: string; error: string }>((resolve) =>
					child.on("close", (code) => resolve({ code, output, error })),
				);
				return { child, name, result };
			});
			t.after(() => {
				for (const worker of workers) worker.child.kill("SIGKILL");
			});
			try {
				const readyDeadline = Date.now() + 10_000;
				while (!workers.every((worker) => existsSync(`${barrier}.${worker.name}`))) {
					assert.ok(Date.now() < readyDeadline, "workers did not become ready");
					await delay(10);
				}
				await writeFile(barrier, "start");
				if (lock) await delay(600); // Both read version zero before the first writer is allowed to initialize.
			} finally {
				if (lock) {
					lock.exec("COMMIT");
					lock.close();
				}
			}
			const results = await Promise.all(workers.map((worker) => worker.result));
			for (const result of results) assert.equal(result.code, 0, result.error);
			const store = new RevisionStore(path);
			try {
				assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS n FROM revisions").get()?.n), 120);
				for (const result of results) {
					const info = JSON.parse(result.output);
					const chain = store.closure([info.last]);
					assert.equal(chain.missing.length, 0);
					assert.equal(chain.revisions.length, 60);
					assert.ok(chain.revisions.every((revision) => revision.sourceSession === info.name));
				}
			} finally {
				store.close();
			}
		}
	});
}

test("foreign identity/schema rejection leaves contents and persistent journal mode unchanged", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "register-foreign-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	for (const [index, sql] of [
		"CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES ('preserve me');",
		"PRAGMA user_version=7;",
		"PRAGMA application_id=1234;",
		"PRAGMA user_version=1;",
	].entries()) {
		const path = join(root, `${index}.sqlite`);
		const database = new DatabaseSync(path);
		database.exec(sql);
		const before = {
			version: database.prepare("PRAGMA user_version").get(),
			application: database.prepare("PRAGMA application_id").get(),
			journal: database.prepare("PRAGMA journal_mode").get(),
		};
		assert.throws(() => new RevisionStore(path), { code: "UNSUPPORTED_DATABASE" });
		assert.deepEqual(
			{
				version: database.prepare("PRAGMA user_version").get(),
				application: database.prepare("PRAGMA application_id").get(),
				journal: database.prepare("PRAGMA journal_mode").get(),
			},
			before,
		);
		if (index === 0) assert.equal(database.prepare("SELECT value FROM foreign_data").get()?.value, "preserve me");
		database.close();
	}
});

test("partial schema initialization rolls back and the same file can initialize cleanly", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "register-schema-fault-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const path = join(root, "register.sqlite");
	const exec = DatabaseSync.prototype.exec;
	const injected = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
		if (sql.startsWith("CREATE TABLE revisions")) {
			exec.call(this, "CREATE TABLE partial_state(value TEXT)");
			throw new Error("injected schema failure");
		}
		return exec.call(this, sql);
	});
	assert.throws(() => new RevisionStore(path), /injected schema failure/);
	injected.mock.restore();
	const raw = new DatabaseSync(path);
	assert.equal(raw.prepare("PRAGMA user_version").get()?.user_version, 0);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n, 0);
	raw.close();
	const store = new RevisionStore(path);
	store.close();
});
