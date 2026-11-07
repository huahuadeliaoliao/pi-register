import { RegisterError } from "./text.ts";

interface JournalConnection {
	exec(sql: string): void;
	prepare(sql: string): { get(): Record<string, unknown> | undefined };
}

interface WalOptions {
	allowMemory: boolean;
	/** Recheck identity in a short, fully released read transaction. */
	revalidate(): void;
	timeoutMs?: number;
	now?: () => number;
	pause?: (milliseconds: number) => void;
	random?: () => number;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** WAL selection is outside a transaction; competing upgrades can bypass SQLite's busy handler. */
export function enableWal(database: JournalConnection, options: WalOptions): void {
	const timeout = options.timeoutMs ?? 2_000;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError("Invalid WAL transition timeout.");
	const now = options.now ?? (() => performance.now());
	const pause = options.pause ?? ((milliseconds: number) => Atomics.wait(sleeper, 0, 0, milliseconds));
	const random = options.random ?? Math.random;
	const deadline = now() + timeout;
	let lastBusy: unknown;
	let attempt = 0;
	while (true) {
		const remaining = deadline - now();
		if (remaining <= 0) throw lastBusy ?? new RegisterError("WAL_TIMEOUT", "WAL transition timed out.");
		// One deadline, not a fresh two-second SQLite wait on every attempt.
		database.exec(`PRAGMA busy_timeout=${Math.max(1, Math.min(100, Math.floor(remaining)))};`);
		if (attempt > 0) {
			// Validation errors are not WAL-transition retries. Constructor cleanup
			// rolls back any failed read transaction before closing the connection.
			options.revalidate();
			const afterValidation = deadline - now();
			if (afterValidation <= 0) throw lastBusy;
			database.exec(`PRAGMA busy_timeout=${Math.max(1, Math.min(100, Math.floor(afterValidation)))};`);
		}
		let mode: unknown;
		try {
			mode = database.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode;
		} catch (error) {
			// SQLITE_LOCKED can indicate a local statement conflict, not transient cross-process contention.
			const code = error && typeof error === "object" && "errcode" in error ? error.errcode : undefined;
			if (typeof code !== "number" || (code & 0xff) !== 5) throw error;
			lastBusy = error;
			const left = deadline - now();
			if (left <= 0) throw lastBusy;
			pause(Math.min(left, Math.min(8 + attempt * 3, 25) + Math.floor(random() * 5)));
			attempt++;
			continue;
		}
		if (mode !== "wal" && !(options.allowMemory && mode === "memory"))
			throw new RegisterError("WAL_UNAVAILABLE", "Register requires WAL for disk-backed revision storage.");
		database.exec("PRAGMA busy_timeout=2000;");
		return;
	}
}
