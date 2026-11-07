import { randomUUID } from "node:crypto";
import { CAPACITY, hash, measure, PROFILE, RegisterError, validateText } from "./text.ts";

export const PUBLICATION_TYPE = "pi-register";
export const JOURNAL_TYPE = "pi-register-revision";
export const IMPORT_TYPE = "pi-register-import";
export const SELECTION_TYPE = "pi-register-selection";
export const FORMAT = 1;
export const OPERATIONS = ["create", "replace", "edit", "append", "clear", "restore"] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface Revision {
	id: string;
	parent: string | null;
	body: string;
	hash: string;
	profile: string;
	used: number;
	createdAt: string;
	operation: Operation;
	restoredFrom: string | null;
	sourceSession: string;
}

export interface Snapshot {
	version: 1;
	adoptionId: string;
	previousAdoption: string | null;
	revision: Revision;
}

export interface Publication {
	version: 1;
	kind: "adopt" | "carry";
	snapshot: Snapshot;
}

export interface Checkpoint {
	version: 1;
	kind: "checkpoint";
	snapshot: Snapshot;
	ordinarySummary: string;
	carrier: boolean;
}

/** Immutable empty-origin metadata; a carrier until superseded or relocated. */
export interface Initialization {
	version: 2;
	kind: "initial";
	snapshot: Snapshot;
}

export type Envelope = Publication | Checkpoint | Initialization;

export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RegisterError("INVALID_FORMAT", "Expected a Register metadata object.");
	}
	return value as Record<string, unknown>;
}

function id(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
		throw new RegisterError("INVALID_FORMAT", "Invalid Register identifier.");
	}
	return value;
}

function optionalId(value: unknown): string | null {
	return value === null ? null : id(value);
}

// Cache counting, not integrity checks: body hashes are still recomputed on each read.
const measured = new Map<string, number>();
export function parseRevision(value: unknown): Revision {
	const data = object(value);
	if (data.profile !== PROFILE) {
		throw new RegisterError(
			"UNSUPPORTED_PROFILE",
			"Register metering profile is unsupported; data has not been replaced.",
		);
	}
	if (
		typeof data.body !== "string" ||
		typeof data.createdAt !== "string" ||
		!Number.isFinite(Date.parse(data.createdAt))
	) {
		throw new RegisterError("INVALID_FORMAT", "Revision text or timestamp is invalid.");
	}
	if (!OPERATIONS.includes(data.operation as Operation))
		throw new RegisterError("INVALID_FORMAT", "Unknown revision operation.");
	validateText(data.body);
	if (data.parent === data.id || data.restoredFrom === data.id)
		throw new RegisterError("REVISION_CYCLE", "A revision cannot depend on itself.");
	const digest = hash(data.body);
	if (digest !== data.hash)
		throw new RegisterError("HASH_MISMATCH", "Register revision checksum does not match its body.");
	let used = measured.get(digest);
	if (used === undefined) {
		used = measure(data.body).used;
		if (measured.size >= 256) measured.delete(measured.keys().next().value as string);
		measured.set(digest, used);
	}
	if (data.used !== used)
		throw new RegisterError("COUNT_MISMATCH", "Stored Register usage does not match its fixed meter.");
	return Object.freeze({
		id: id(data.id),
		parent: optionalId(data.parent),
		body: data.body,
		hash: digest,
		profile: PROFILE,
		used,
		createdAt: data.createdAt,
		operation: data.operation as Operation,
		restoredFrom: optionalId(data.restoredFrom),
		sourceSession: id(data.sourceSession),
	});
}

export function newRevision(
	body: string,
	parent: Revision | undefined,
	operation: Operation,
	sourceSession: string,
	restoredFrom: string | null = null,
): Revision {
	const { used } = measure(body);
	return Object.freeze({
		id: randomUUID(),
		parent: parent?.id ?? null,
		body,
		hash: hash(body),
		profile: PROFILE,
		used,
		createdAt: new Date().toISOString(),
		operation,
		restoredFrom,
		sourceSession,
	});
}

export function newSnapshot(revision: Revision, previous?: Snapshot): Snapshot {
	return Object.freeze({
		version: FORMAT,
		adoptionId: randomUUID(),
		previousAdoption: previous?.adoptionId ?? null,
		revision: Object.freeze({ ...revision }),
	});
}

export function parseSnapshot(value: unknown): Snapshot {
	const data = object(value);
	if (data.version !== FORMAT)
		throw new RegisterError("UNSUPPORTED_FORMAT", "Register snapshot format is unsupported.");
	return Object.freeze({
		version: FORMAT,
		adoptionId: id(data.adoptionId),
		previousAdoption: optionalId(data.previousAdoption),
		revision: parseRevision(data.revision),
	});
}

export function parseEnvelope(value: unknown): Envelope {
	const data = object(value);
	if (data.version === 2 && data.kind === "initial") {
		const snapshot = parseSnapshot(data.snapshot);
		if (!isInitialSnapshot(snapshot))
			throw new RegisterError("INVALID_INITIALIZATION", "Initialization must describe the original empty adoption.");
		return Object.freeze({ version: 2, kind: "initial", snapshot });
	}
	if (data.version !== FORMAT)
		throw new RegisterError("UNSUPPORTED_FORMAT", "Register envelope format is unsupported.");
	const snapshot = parseSnapshot(data.snapshot);
	if (data.kind === "adopt" || data.kind === "carry")
		return Object.freeze({ version: FORMAT, kind: data.kind, snapshot });
	if (data.kind === "checkpoint" && typeof data.ordinarySummary === "string" && typeof data.carrier === "boolean") {
		return Object.freeze({
			version: FORMAT,
			kind: data.kind,
			snapshot,
			ordinarySummary: data.ordinarySummary,
			carrier: data.carrier,
		});
	}
	throw new RegisterError("INVALID_FORMAT", "Register envelope kind is invalid.");
}

export function envelopeFromDetails(details: unknown): Envelope | undefined {
	if (!details || typeof details !== "object" || !("register" in details)) return undefined;
	return parseEnvelope((details as Record<string, unknown>).register);
}

export function render(snapshot: Snapshot): string {
	const r = snapshot.revision;
	return (
		'<session-register revision="' +
		r.id +
		'" adoption="' +
		snapshot.adoptionId +
		'" profile="' +
		r.profile +
		'" capacity="' +
		CAPACITY +
		'" used="' +
		r.used +
		'" remaining="' +
		(CAPACITY - r.used) +
		'">\n' +
		r.body +
		"\n</session-register>"
	);
}

export function renderCheckpoint(envelope: Checkpoint): string {
	return envelope.carrier ? `${envelope.ordinarySummary}\n\n${render(envelope.snapshot)}` : envelope.ordinarySummary;
}

export function isInitialSnapshot(snapshot: Snapshot): boolean {
	const r = snapshot.revision;
	return (
		snapshot.previousAdoption === null &&
		r.operation === "create" &&
		r.parent === null &&
		r.restoredFrom === null &&
		r.body === "" &&
		r.used === 0
	);
}

/** Initial fields remain true after later writes and do not claim to be current. */
export function renderInitial(snapshot: Snapshot): string {
	if (!isInitialSnapshot(snapshot))
		throw new RegisterError("INVALID_INITIALIZATION", "Only an original empty adoption can initialize Register.");
	return (
		'<session-register-initial-state initial-revision="' +
		snapshot.revision.id +
		'" profile="' +
		snapshot.revision.profile +
		'" capacity="' +
		CAPACITY +
		'" initial-used="0" initial-remaining="' +
		CAPACITY +
		'" initial-body="" />'
	);
}

export function renderEnvelope(envelope: Envelope): string {
	if (envelope.kind === "initial") return renderInitial(envelope.snapshot);
	return envelope.kind === "checkpoint" ? renderCheckpoint(envelope) : render(envelope.snapshot);
}

export function canonicalRevision(revision: Revision): string {
	return JSON.stringify(parseRevision(revision));
}
