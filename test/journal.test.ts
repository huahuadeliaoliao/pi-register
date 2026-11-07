import assert from "node:assert/strict";
import test from "node:test";
import { enableWal } from "../src/journal.ts";
import { RegisterError } from "../src/text.ts";

function nativeError(errcode: number) {
	return Object.assign(new Error(`native SQLite ${errcode}`), { code: "ERR_SQLITE_ERROR", errcode });
}

function fixture(outcome: (attempt: number) => unknown) {
	let time = 0;
	let attempts = 0;
	const statements: string[] = [];
	const waits: number[] = [];
	let validations = 0;
	const database = {
		exec(sql: string) {
			statements.push(sql);
		},
		prepare(sql: string) {
			assert.equal(sql, "PRAGMA journal_mode=WAL");
			return {
				get() {
					const result = outcome(++attempts);
					if (result instanceof Error) throw result;
					return { journal_mode: result };
				},
			};
		},
	};
	const options = {
		allowMemory: false,
		timeoutMs: 25,
		now: () => time,
		random: () => 0,
		pause(milliseconds: number) {
			assert.ok(milliseconds > 0);
			waits.push(milliseconds);
			time += milliseconds;
		},
		revalidate() {
			validations++;
		},
	};
	return {
		database,
		options,
		statements,
		waits,
		get attempts() {
			return attempts;
		},
		get time() {
			return time;
		},
		get validations() {
			return validations;
		},
		advance(milliseconds: number) {
			time += milliseconds;
		},
	};
}

test("WAL retries BUSY outside validation and restores the ordinary connection timeout", () => {
	const busy = nativeError(5);
	const f = fixture((attempt) => (attempt === 1 ? busy : "wal"));
	enableWal(f.database, f.options);
	assert.equal(f.attempts, 2);
	assert.equal(f.validations, 1);
	assert.deepEqual(f.waits, [8]);
	assert.equal(f.statements.at(-1), "PRAGMA busy_timeout=2000;");
});

test("extended native BUSY codes use their primary code", () => {
	const f = fixture((attempt) => (attempt === 1 ? nativeError(517) : "wal"));
	enableWal(f.database, f.options);
	assert.equal(f.attempts, 2);
});

test("permanent WAL contention has one deadline and preserves the native exception", () => {
	const busy = nativeError(5);
	const f = fixture(() => busy);
	assert.throws(
		() => enableWal(f.database, f.options),
		(error) => error === busy,
	);
	assert.equal(f.time, 25);
	assert.equal(f.attempts, 3);
	assert.deepEqual(f.waits, [8, 11, 6]);
	assert.ok(!f.statements.includes("PRAGMA busy_timeout=2000;"));
	for (const sql of f.statements) {
		const timeout = Number(sql.match(/=(\d+)/)?.[1]);
		assert.ok(timeout >= 1 && timeout <= 25);
	}
});

for (const code of [6, 8, 10, 11, 14]) {
	test(`WAL does not retry native non-BUSY error ${code}`, () => {
		const failure = nativeError(code);
		const f = fixture(() => failure);
		assert.throws(
			() => enableWal(f.database, f.options),
			(error) => error === failure,
		);
		assert.equal(f.attempts, 1);
		assert.equal(f.validations, 0);
		assert.equal(f.waits.length, 0);
	});
}

test("WAL verifies the returned mode and accepts memory only for an explicit memory target", () => {
	for (const mode of ["delete", "memory", undefined]) {
		const f = fixture(() => mode);
		assert.throws(() => enableWal(f.database, f.options), { code: "WAL_UNAVAILABLE" });
		assert.equal(f.attempts, 1);
		assert.equal(f.waits.length, 0);
	}
	const memory = fixture(() => "memory");
	enableWal(memory.database, { ...memory.options, allowMemory: true });
	assert.equal(memory.statements.at(-1), "PRAGMA busy_timeout=2000;");
});

test("a newly foreign identity stops before the next persistent pragma", () => {
	const busy = nativeError(5);
	const foreign = new RegisterError("UNSUPPORTED_DATABASE", "Foreign identity appeared.");
	const f = fixture(() => busy);
	assert.throws(
		() =>
			enableWal(f.database, {
				...f.options,
				revalidate: () => {
					throw foreign;
				},
			}),
		(error) => error === foreign,
	);
	assert.equal(f.attempts, 1);
	assert.equal(f.waits.length, 1);
});

test("validation errors are not retried as WAL transitions", () => {
	const busy = nativeError(5);
	const validationBusy = nativeError(5);
	const f = fixture(() => busy);
	assert.throws(
		() =>
			enableWal(f.database, {
				...f.options,
				revalidate: () => {
					throw validationBusy;
				},
			}),
		(error) => error === validationBusy,
	);
	assert.equal(f.attempts, 1);
});

test("time spent revalidating consumes the same WAL deadline", () => {
	const busy = nativeError(5);
	const f = fixture(() => busy);
	assert.throws(
		() => enableWal(f.database, { ...f.options, revalidate: () => f.advance(30) }),
		(error) => error === busy,
	);
	assert.equal(f.attempts, 1);
});

test("an ordinary timeout-restore error cannot trigger another WAL attempt", () => {
	const f = fixture(() => "wal");
	const failure = nativeError(5);
	const exec = f.database.exec;
	f.database.exec = (sql) => {
		if (sql === "PRAGMA busy_timeout=2000;") throw failure;
		exec(sql);
	};
	assert.throws(
		() => enableWal(f.database, f.options),
		(error) => error === failure,
	);
	assert.equal(f.attempts, 1);
});
