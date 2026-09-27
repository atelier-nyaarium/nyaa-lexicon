// What a parse of a machine-written string answers: its value, or where and why it failed.

////////////////////////////////
//  Interfaces & Types

export interface ParseFailure {
	message: string;
	offset: number;
	/** 1-based, as messages count lines. */
	line: number;
	/** 1-based UTF-16 column. */
	column: number;
	/** The span around the failure, with the offending token bracketed. */
	context: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; failure: ParseFailure };

////////////////////////////////
//  Functions & Helpers

export function ok<T>(value: T): ParseResult<T> {
	return { ok: true, value };
}

export function err<T>(failure: ParseFailure): ParseResult<T> {
	return { ok: false, failure };
}

/** One-line rendering for a log or an error message. */
export function formatFailure(failure: ParseFailure): string {
	return `${failure.message} at ${failure.line}:${failure.column} (offset ${failure.offset}): ${failure.context}`;
}

/**
 * A digit run as a number, or null when the text and the number would disagree.
 *
 * Past 2^53 two distinct digit runs collapse onto one value, and a leading zero gives one value two
 * spellings. Either way an id or a version stops being its own name. One owner, because the same
 * check written twice already drifted once.
 */
export function safeDigits(text: string): number | null {
	if (!/^\d+$/.test(text)) return null;
	const value = Number(text);
	return Number.isSafeInteger(value) && String(value) === text ? value : null;
}
