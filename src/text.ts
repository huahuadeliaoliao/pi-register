import { createHash } from "node:crypto";
import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";

export const CAPACITY = 30_000;
export const VOCABULARY_HASH = "de7eb511338b0e23589a3cae2dceb8dd66c2a9fd70dbf7ea778fd9df9f175d45";
export const PROFILE = `o200k_base/js-tiktoken@1.0.21/ordinary-v1/sha256:${VOCABULARY_HASH}`;

export class RegisterError extends Error {
	readonly code: string;
	readonly data: Record<string, unknown>;
	constructor(code: string, message: string, data: Record<string, unknown> = {}) {
		super(message);
		this.name = "RegisterError";
		this.code = code;
		this.data = data;
	}
}

export function hash(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function validateText(text: string): void {
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(++i);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new RegisterError("INVALID_UNICODE", "Text contains an unpaired UTF-16 surrogate; no text was changed.");
			}
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			throw new RegisterError("INVALID_UNICODE", "Text contains an unpaired UTF-16 surrogate; no text was changed.");
		}
	}
}

let encoder: Tiktoken | undefined;
export function count(text: string): number {
	validateText(text);
	if (!encoder) {
		if (hash(JSON.stringify(ranks)) !== VOCABULARY_HASH) {
			throw new RegisterError("METER_MISMATCH", "The installed Register vocabulary differs from its fixed profile.");
		}
		encoder = new Tiktoken(ranks);
	}
	// Special-token spellings are ordinary text, not privileged control tokens.
	return encoder.encode(text, [], []).length;
}

export function measure(text: string): { used: number; remaining: number } {
	const used = count(text);
	if (used > CAPACITY) {
		throw new RegisterError("CAPACITY_EXCEEDED", "Candidate exceeds Register capacity; the edit was not applied.", {
			capacity: CAPACITY,
			candidate_used: used,
			over_by: used - CAPACITY,
		});
	}
	return { used, remaining: CAPACITY - used };
}

export interface TextEdit {
	oldText: string;
	newText: string;
}

/** All matches are against the original body, never a preceding replacement. */
export function applyEdits(body: string, edits: readonly TextEdit[]): string {
	if (edits.length === 0) throw new RegisterError("INVALID_EDIT", "Supply at least one edit.");
	const spans = edits
		.map(({ oldText, newText }) => {
			if (!oldText) throw new RegisterError("INVALID_EDIT", "oldText must be nonempty; use append or replace.");
			const start = body.indexOf(oldText);
			if (start < 0 || body.indexOf(oldText, start + 1) >= 0) {
				throw new RegisterError("EDIT_MATCH", "Each oldText must match exactly once in the original body.");
			}
			return { start, end: start + oldText.length, newText };
		})
		.sort((a, b) => a.start - b.start);
	let end = 0;
	let result = "";
	for (const span of spans) {
		if (span.start < end) throw new RegisterError("OVERLAPPING_EDITS", "Edits overlap; merge them into one edit.");
		result += body.slice(end, span.start) + span.newText;
		end = span.end;
	}
	return result + body.slice(end);
}
