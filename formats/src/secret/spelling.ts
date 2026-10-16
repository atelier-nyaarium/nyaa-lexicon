// Shared key-spelling walks for format prefilters.
// Context comes from the full text; matches stay within the span.

import type { OffsetRange } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** Key read and end offset. */
export interface KeyRead {
	found: boolean;
	/** Next scan offset. */
	end: number;
}

////////////////////////////////
//  Constants

export const TAB = 0x09;
export const LF = 0x0a;
export const CR = 0x0d;
export const SPACE = 0x20;
export const QUOTE = 0x22;
export const DOLLAR = 0x24;
export const APOSTROPHE = 0x27;
export const SLASH = 0x2f;
export const COLON = 0x3a;
export const BACKSLASH = 0x5c;
const NEXT_LINE = 0x85;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

////////////////////////////////
//  Functions & Helpers

/** ASCII identifier character. */
export function isWord(code: number): boolean {
	return (
		(code >= 0x30 && code <= 0x39) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		code === 0x5f
	);
}

function isBlank(code: number): boolean {
	return code === SPACE || code === TAB;
}

/** Reader-specific line break. */
export function isBreak(code: number): boolean {
	return code === LF || code === CR || code === NEXT_LINE || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR;
}

/** Code unit, or -1 outside text. */
export function unitAt(text: string, at: number): number {
	return at >= 0 && at < text.length ? text.charCodeAt(at) : -1;
}

/** Skips spaces and tabs. */
export function skipBlanks(text: string, from: number): number {
	let at = from;
	while (at < text.length && isBlank(text.charCodeAt(at))) at += 1;
	return at;
}

/** Skips ASCII whitespace. */
export function skipSpaces(text: string, from: number): number {
	let at = from;
	while (at < text.length) {
		const code = text.charCodeAt(at);
		if (code !== SPACE && (code < TAB || code > CR)) break;
		at += 1;
	}
	return at;
}

/** Hex digits before `limit`. */
export function hexRun(text: string, at: number, limit: number): number {
	let count = 0;
	while (count < limit) {
		const code = text.charCodeAt(at + count);
		if (!((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66)))
			break;
		count += 1;
	}
	return count;
}

export function hexValue(text: string, at: number, count: number): number {
	return Number.parseInt(text.slice(at, at + count), 16);
}

/** Finds accepted occurrences within a span. */
export function someOccurrence(
	text: string,
	needle: string,
	span: OffsetRange,
	accept: (start: number, end: number) => boolean,
): boolean {
	if (needle === "") return true;
	for (
		let at = text.indexOf(needle, span.start);
		at !== -1 && at + needle.length <= span.end;
		at = text.indexOf(needle, at + 1)
	)
		if (accept(at, at + needle.length)) return true;
	return false;
}

export function includesWithin(text: string, needle: string, span: OffsetRange): boolean {
	return someOccurrence(text, needle, span, () => true);
}

/**
 * Finds escaped names by checking possible key starts.
 * Unknown escapes can spell any name.
 * Skips escapes inside already-read keys.
 */
export function someEscaped(
	text: string,
	span: OffsetRange,
	name: string,
	read: (start: number, before: number) => KeyRead | null,
	unknown?: (slash: number) => boolean,
): boolean {
	const first = name.charCodeAt(0);
	// A span may start inside an escape.
	let run = 0;
	while (span.start > run && text.charCodeAt(span.start - run - 1) === BACKSLASH) run += 1;
	let from = span.start + (run % 2);
	for (let slash = text.indexOf("\\", from); slash !== -1 && slash < span.end; slash = text.indexOf("\\", from)) {
		if (unknown?.(slash)) return true;
		let resume = slash + 2;
		for (let length = Math.min(name.length, slash - span.start); length >= 0; length--) {
			const start = slash - length;
			if (
				length > 0 &&
				(text.charCodeAt(start) !== first || text.charCodeAt(slash - 1) !== name.charCodeAt(length - 1))
			)
				continue;
			const reading = read(start, unitAt(text, start - 1));
			if (reading === null) continue;
			if (reading.found) return true;
			resume = Math.max(resume, reading.end);
		}
		from = resume;
	}
	return false;
}
