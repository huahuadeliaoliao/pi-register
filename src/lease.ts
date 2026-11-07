import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { RevisionStore } from "./store.ts";
import { RegisterError } from "./text.ts";

function processStart(pid: number): string | null {
	if (process.platform !== "linux") return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
	} catch {
		return null;
	}
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		try {
			return join(realpathSync(dirname(path)), basename(path));
		} catch {
			return resolve(path);
		}
	}
}

function live(pid: number, start: string | null): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
	const current = processStart(pid);
	return !start || !current || start === current;
}

export interface WriterLease {
	assertOwned(): void;
	release(): void;
}

/**
 * Cooperative ownership within a Register store, serialized by SQLite.
 * Never takes over a live owner on a timer. Does not fence arbitrary pi writers.
 */
export function acquireLease(store: RevisionStore, sessionFile: string): WriterLease {
	const key = canonical(sessionFile);
	const token = randomUUID();
	store.transaction(() => {
		const previous = store.database.prepare("SELECT pid,start FROM writers WHERE path=?").get(key);
		if (previous && live(Number(previous.pid), previous.start === null ? null : String(previous.start))) {
			throw new RegisterError("WRITER_CONFLICT", "Another active Register writer owns this session file.");
		}
		store.database
			.prepare(
				"INSERT INTO writers(path,pid,start,token) VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET pid=excluded.pid,start=excluded.start,token=excluded.token",
			)
			.run(key, process.pid, processStart(process.pid), token);
	});
	let released = false;
	return {
		assertOwned() {
			const row = store.database.prepare("SELECT token FROM writers WHERE path=?").get(key);
			if (released || row?.token !== token)
				throw new RegisterError("WRITER_CONFLICT", "Register writer ownership changed.");
		},
		release() {
			if (released) return;
			store.database.prepare("DELETE FROM writers WHERE path=? AND token=?").run(key, token);
			released = true;
		},
	};
}
