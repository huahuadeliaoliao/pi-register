import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RevisionStore } from "../src/store.ts";

const [path, signal] = process.argv.slice(2);
if (!path || !signal) throw new Error("Missing isolated WAL worker arguments.");
const prepare = DatabaseSync.prototype.prepare;
let attempts = 0;
let busy = 0;
DatabaseSync.prototype.prepare = function (sql: string) {
	const statement = prepare.call(this, sql);
	if (sql !== "PRAGMA journal_mode=WAL") return statement;
	return new Proxy(statement, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			if (property !== "get") return value.bind(target);
			return (...args: unknown[]) => {
				attempts++;
				writeFileSync(signal, String(attempts));
				try {
					return Reflect.apply(value, target, args);
				} catch (error) {
					const code = error && typeof error === "object" && "errcode" in error ? error.errcode : undefined;
					if (typeof code === "number" && (code & 0xff) === 5) {
						busy++;
						writeFileSync(`${signal}.busy`, String(busy));
					}
					throw error;
				}
			};
		},
	});
};
const started = performance.now();
try {
	const store = new RevisionStore(path);
	const count = Number(store.database.prepare("SELECT count(*) AS n FROM revisions").get()?.n);
	store.close();
	console.log(JSON.stringify({ ok: true, attempts, busy, count, elapsedMs: performance.now() - started }));
} catch (error) {
	const detail = error as { code?: unknown; errcode?: unknown };
	console.log(
		JSON.stringify({
			ok: false,
			attempts,
			busy,
			code: detail.code,
			errcode: detail.errcode,
			elapsedMs: performance.now() - started,
		}),
	);
} finally {
	DatabaseSync.prototype.prepare = prepare;
}
