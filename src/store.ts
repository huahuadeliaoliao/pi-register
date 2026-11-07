import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enableWal } from "./journal.ts";
import {
	canonicalRevision,
	FORMAT,
	object,
	parseRevision,
	parseSnapshot,
	type Revision,
	type Snapshot,
} from "./model.ts";
import { hash, RegisterError } from "./text.ts";

export interface HistoryArchive {
	format: "pi-register-history";
	version: 1;
	exportedAt: string;
	current: Snapshot;
	roots: string[];
	revisions: Revision[];
	missing: string[];
	checksum: string;
}

/** Dependencies may be missing, but a known revision graph must never cycle. */
function assertAcyclic(revisions: Iterable<Revision>): void {
	const nodes = new Map([...revisions].map((revision) => [revision.id, revision]));
	const waiting = new Map<string, number>();
	const dependents = new Map<string, Set<string>>();
	const ready: string[] = [];
	for (const revision of nodes.values()) {
		const dependencies = new Set(
			[revision.parent, revision.restoredFrom].filter((id): id is string => !!id && nodes.has(id)),
		);
		waiting.set(revision.id, dependencies.size);
		if (!dependencies.size) ready.push(revision.id);
		for (const dependency of dependencies) {
			const children = dependents.get(dependency) ?? new Set<string>();
			children.add(revision.id);
			dependents.set(dependency, children);
		}
	}
	let processed = 0;
	while (ready.length) {
		const next = ready.pop() as string;
		processed++;
		for (const dependent of dependents.get(next) ?? []) {
			const remaining = (waiting.get(dependent) as number) - 1;
			waiting.set(dependent, remaining);
			if (remaining === 0) ready.push(dependent);
		}
	}
	if (processed !== nodes.size)
		throw new RegisterError("REVISION_CYCLE", "Register history contains a dependency cycle.");
}

function seal(data: Omit<HistoryArchive, "checksum">): HistoryArchive {
	return { ...data, checksum: hash(JSON.stringify(data)) };
}

const APPLICATION_ID = 0x52534752;

/** Call within a transaction so identity and schema belong to one SQLite snapshot. */
function databaseVersion(database: DatabaseSync): number {
	const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
	const application = Number(database.prepare("PRAGMA application_id").get()?.application_id);
	if (
		(version !== 0 && version !== FORMAT) ||
		(version === FORMAT && application !== APPLICATION_ID) ||
		(version === 0 && application !== 0)
	) {
		throw new RegisterError("UNSUPPORTED_DATABASE", "Register database schema is unsupported.");
	}
	if (version === 0) {
		const existing = database
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
			.all();
		if (existing.length)
			throw new RegisterError(
				"UNSUPPORTED_DATABASE",
				"Unrecognized database; refusing to initialize over existing data.",
			);
	}
	return version;
}

/** Immutable content store. There deliberately is no authoritative SQL head. */
export class RevisionStore {
	readonly database: DatabaseSync;
	private closed = false;
	readonly path: string;

	constructor(path: string = ":memory:") {
		this.path = path;
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			closeSync(openSync(path, "a", 0o600));
			chmodSync(path, 0o600);
		}
		this.database = new DatabaseSync(path);
		let transaction = false;
		try {
			this.database.exec("PRAGMA busy_timeout=2000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;");
			// Reject foreign data before changing persistent journal mode. Read all
			// recognition fields in one snapshot, then release it before taking a writer lock.
			this.database.exec("BEGIN");
			transaction = true;
			databaseVersion(this.database);
			this.database.exec("COMMIT");
			transaction = false;
			enableWal(this.database, {
				allowMemory: path === ":memory:",
				revalidate: () => {
					this.database.exec("BEGIN");
					transaction = true;
					databaseVersion(this.database);
					this.database.exec("COMMIT");
					transaction = false;
				},
			});
			this.database.exec("BEGIN IMMEDIATE");
			transaction = true;
			// Another process may have initialized the database since the preliminary read.
			if (databaseVersion(this.database) === 0) {
				this.database.exec(
					"CREATE TABLE revisions (id TEXT PRIMARY KEY, parent_id TEXT, payload TEXT NOT NULL) STRICT; CREATE INDEX revision_parent ON revisions(parent_id); CREATE TABLE writers(path TEXT PRIMARY KEY,pid INTEGER NOT NULL,start TEXT,token TEXT NOT NULL) STRICT; CREATE TRIGGER revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable revision'); END; CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable revision'); END; PRAGMA user_version=1; PRAGMA application_id=1381189458;",
				);
			}
			this.database.exec("COMMIT");
			transaction = false;
		} catch (error) {
			if (transaction) {
				try {
					this.database.exec("ROLLBACK");
				} catch {
					/* Preserve the original initialization error. */
				}
			}
			try {
				this.database.close();
			} catch {
				/* Preserve the original initialization error. */
			}
			throw error;
		}
	}

	get(id: string): Revision | undefined {
		const row = this.database.prepare("SELECT parent_id,payload FROM revisions WHERE id=?").get(id);
		if (!row) return undefined;
		const revision = parseRevision(JSON.parse(String(row.payload)));
		if (row.parent_id !== revision.parent)
			throw new RegisterError("DATABASE_INTEGRITY", "Stored revision ancestry does not match its payload.");
		if (revision.id !== id)
			throw new RegisterError("ID_CONFLICT", "Stored revision identifier does not match its key.");
		return revision;
	}

	put(revision: Revision): boolean {
		const payload = canonicalRevision(revision);
		const existing = this.get(revision.id);
		if (existing) {
			if (canonicalRevision(existing) !== payload) {
				throw new RegisterError(
					"ID_CONFLICT",
					"The same revision identifier already has different immutable contents.",
				);
			}
			return false;
		}
		const dependencies = [revision.parent, revision.restoredFrom].filter((id): id is string => id !== null);
		assertAcyclic([...this.closure(dependencies).revisions, revision]);
		this.database
			.prepare("INSERT INTO revisions(id,parent_id,payload) VALUES (?,?,?)")
			.run(revision.id, revision.parent, payload);
		return true;
	}

	transaction<T>(operation: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/** A missing parent is a real gap, never synthesized as an empty revision. */
	closure(roots: Iterable<string>): { revisions: Revision[]; missing: string[] } {
		const visited = new Set<string>();
		const missing = new Set<string>();
		const revisions: Revision[] = [];
		const queue = [...roots];
		while (queue.length) {
			const next = queue.pop();
			if (!next || visited.has(next)) continue;
			visited.add(next);
			const revision = this.get(next);
			if (!revision) {
				missing.add(next);
				continue;
			}
			revisions.push(revision);
			if (revision.parent) queue.push(revision.parent);
			if (revision.restoredFrom) queue.push(revision.restoredFrom);
		}
		assertAcyclic(revisions);
		return { revisions, missing: [...missing].sort() };
	}

	export(current: Snapshot, roots: Iterable<string>): HistoryArchive {
		const rootIds = [...new Set([...roots, current.revision.id])].sort();
		const closure = this.closure(rootIds);
		const data: Omit<HistoryArchive, "checksum"> = {
			format: "pi-register-history",
			version: FORMAT,
			exportedAt: new Date().toISOString(),
			current,
			roots: rootIds,
			revisions: closure.revisions.sort((a, b) => a.id.localeCompare(b.id)),
			missing: closure.missing,
		};
		return seal(data);
	}

	import(value: unknown, beforeCommit?: (archive: HistoryArchive) => undefined): HistoryArchive {
		const data = object(value);
		if (data.format !== "pi-register-history" || data.version !== FORMAT) {
			throw new RegisterError("UNSUPPORTED_ARCHIVE", "Unsupported Register history archive.");
		}
		const { checksum, ...contents } = data;
		if (typeof checksum !== "string" || hash(JSON.stringify(contents)) !== checksum) {
			throw new RegisterError("ARCHIVE_CHECKSUM", "History archive checksum mismatch.");
		}
		if (
			typeof data.exportedAt !== "string" ||
			!Number.isFinite(Date.parse(data.exportedAt)) ||
			!Array.isArray(data.roots) ||
			!data.roots.every((x) => typeof x === "string") ||
			!Array.isArray(data.revisions) ||
			!Array.isArray(data.missing) ||
			!data.missing.every((x) => typeof x === "string")
		) {
			throw new RegisterError("INVALID_ARCHIVE", "History archive structure is invalid.");
		}
		const current = parseSnapshot(data.current);
		const revisions = data.revisions.map(parseRevision);
		const supplied = new Map<string, Revision>();
		for (const revision of revisions) {
			const previous = supplied.get(revision.id);
			if (previous && canonicalRevision(previous) !== canonicalRevision(revision)) {
				throw new RegisterError("ID_CONFLICT", "History archive contains conflicting copies of a revision.");
			}
			supplied.set(revision.id, revision);
		}
		const published = supplied.get(current.revision.id);
		if (!published || canonicalRevision(published) !== canonicalRevision(current.revision)) {
			throw new RegisterError("INVALID_ARCHIVE", "The archive does not contain its declared current revision.");
		}
		if (!data.roots.includes(current.revision.id))
			throw new RegisterError("INVALID_ARCHIVE", "Current revision must be an archive root.");
		const reachable = new Set<string>();
		const missing = new Set<string>();
		const queue = [...data.roots];
		while (queue.length) {
			const id = queue.pop() as string;
			if (!/^[A-Za-z0-9._:-]{1,256}$/.test(id))
				throw new RegisterError("INVALID_ARCHIVE", "Archive reference identifier is invalid.");
			if (reachable.has(id) || missing.has(id)) continue;
			const revision = supplied.get(id);
			if (!revision) {
				missing.add(id);
				continue;
			}
			reachable.add(id);
			if (revision.parent) queue.push(revision.parent);
			if (revision.restoredFrom) queue.push(revision.restoredFrom);
		}
		const declaredMissing = new Set(data.missing);
		if (
			reachable.size !== supplied.size ||
			missing.size !== declaredMissing.size ||
			[...missing].some((id) => !declaredMissing.has(id))
		) {
			throw new RegisterError("INVALID_ARCHIVE", "Archive scope or missing-history declaration is inconsistent.");
		}
		assertAcyclic(supplied.values());
		const archive = seal({
			format: "pi-register-history",
			version: FORMAT,
			exportedAt: data.exportedAt,
			current,
			roots: [...new Set(data.roots)],
			revisions: [...supplied.values()],
			missing: [...missing].sort(),
		});
		// All identity/graph validation precedes the native scope-intent hook.
		// The hook is synchronous and inside the SQL transaction: failed bookkeeping
		// cannot leave committed rows invisible to this session\'s export scope.
		this.transaction(() => {
			for (const revision of revisions) this.put(revision);
			beforeCommit?.(archive);
		});
		return archive;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.database.close();
	}
}
