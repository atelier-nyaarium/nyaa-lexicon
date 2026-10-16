// Unions dotenv-js, compose-go, and POSIX shell readings.
// dotenv-js shapes keys; shell words shape values.
// Disagreements become uncertain values or hazards.
// Loose-key spans are read again by dotenv-js.
// The protocol owns masking.

import type { OffsetRange } from "@nyaa-lexicon/protocol";
import type {
	ScalarReading,
	SecretFormat,
	SecretHazard,
	SecretNode,
	SecretSyntax,
	SecretSyntaxDocument,
} from "@nyaa-lexicon/protocol/secretSyntax";
import { includesWithin, someOccurrence } from "./spelling.js";

////////////////////////////////
//  Constants

/** Shared unquoted value characters. */
const SAFE_VALUE = /[A-Za-z0-9_./,:@%+=-]/;
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Shell command and word boundaries. */
const COMMAND = /[ \t;&|<>()`]/;
const KEY_CHAR = /[\w.-]|[^\p{ASCII}\s]/u;
/** dotenv-js pair-key syntax. */
const DOTENV_KEY = /^[\w.-]+$/;
/** In-line whitespace. */
const BLANK = /[^\S\n\r]/;
/** Shared word delimiters. */
const SPACES = /^[ \t]*$/;
const BREAK = /[\n\r]/;
/** Line breaks split patterns, not values. */
const SEPARATOR = /[\u{2028}\u{2029}]/u;
const QUOTES = "'\"`";
const BYTE_ORDER_MARK = 0xfeff;

const readings = new WeakMap<SecretSyntaxDocument, Map<number, ScalarReading>>();

interface Value {
	span: OffsetRange;
	reading: ScalarReading;
	hazards: SecretHazard[];
	next: number;
	/** Any later quote may close it. */
	wide?: boolean;
}

interface Line {
	content: number;
	next: number;
}

////////////////////////////////
//  Functions & Helpers

function isBlank(char: string | undefined): boolean {
	return char !== undefined && BLANK.test(char);
}

/** Shell comment spacing. */
function isShellBlank(char: string | undefined): boolean {
	return char === " " || char === "\t";
}

function skipBlank(text: string, at: number, end: number): number {
	let cursor = at;
	while (cursor < end && isBlank(text[cursor])) cursor += 1;
	return cursor;
}

/** Skips all whitespace. */
function skipSpace(text: string, at: number): number {
	let cursor = at;
	while (cursor < text.length && /\s/.test(text[cursor] as string)) cursor += 1;
	return cursor;
}

/** Lone CR splits lines for dotenv-js only. */
function lineBounds(text: string, at: number): Line {
	let end = at;
	while (end < text.length && !BREAK.test(text[end] as string)) end += 1;
	if (end === text.length) return { content: end, next: end };
	if (text[end] === "\r" && text[end + 1] === "\n") return { content: end, next: end + 2 };
	return { content: end, next: end + 1 };
}

/** Shell line ends at LF or CRLF. */
function shellLineEnd(text: string, from: number): number {
	const newline = text.indexOf("\n", from);
	if (newline === -1) return text.length;
	return newline > from && text[newline - 1] === "\r" ? newline - 1 : newline;
}

/** Closing quote, honoring backslash escapes. */
function closeOf(text: string, open: number, quote: string, escapes: boolean): number {
	if (!escapes) return text.indexOf(quote, open + 1);
	for (let at = open + 1; at < text.length; at++) {
		const char = text[at];
		if (char === "\\") at += 1;
		else if (char === quote) return at;
	}
	return -1;
}

/**
 * Shell words span quotes and escaped breaks.
 * Lone CR is not a shell line break.
 * Hash comments need a space, tab, or line start.
 */
function shellReach(text: string, from: number, lineStart: boolean): number {
	let end = shellLineEnd(text, from);
	let blank = false;
	for (let at = from; at < end; at++) {
		const char = text[at] as string;
		if (char === "\\") {
			if (at + 1 >= end && end < text.length) end = shellLineEnd(text, end + (text[end] === "\r" ? 2 : 1));
			at += 1;
			blank = false;
		} else if (char === "#" && (at === from ? lineStart : blank)) {
			break;
		} else if (QUOTES.includes(char)) {
			const close = closeOf(text, at, char, char !== "'");
			if (close === -1) return text.length;
			if (close >= end) end = shellLineEnd(text, close + 1);
			at = close;
			blank = false;
		} else {
			blank = isShellBlank(char);
		}
	}
	return end;
}

/** Hash comments start outside quotes after blanks. */
function beforeComment(code: string): string {
	let blank = false;
	for (let at = 0; at < code.length; at++) {
		const char = code[at] as string;
		if (char === "\\") {
			at += 1;
			blank = false;
		} else if (char === "#" && blank) {
			return code.slice(0, at);
		} else if (QUOTES.includes(char)) {
			const close = closeOf(code, at, char, char !== "'");
			if (close === -1) return code;
			at = close;
			blank = false;
		} else {
			blank = isShellBlank(char);
		}
	}
	return code;
}

/**
 * Shell lines read inside a dotenv-js span.
 * Continued word lines are not separate shell lines.
 */
function innerReach(text: string, span: OffsetRange, reach: number, shellEnd: number): number {
	let found = reach;
	for (let at = text.indexOf("\n", span.start); at !== -1 && at + 1 < span.end; at = text.indexOf("\n", at + 1)) {
		if (at + 1 >= Math.max(found, shellEnd)) found = Math.max(found, shellReach(text, at + 1, true));
	}
	return found;
}

function junk(span: OffsetRange): SecretHazard {
	return { span, within: 0, reach: "any", reshapes: false };
}

function uncertain(empty: boolean): ScalarReading {
	return { kind: "uncertain", empty };
}

/**
 * When closing quotes disagree, dotenv-js reads unquoted.
 * Unclosed quotes, trailing words, and single-quote slashes widen spans.
 * Backslashes let later quotes close wide values.
 */
function quotedValue(text: string, open: number, line: Line, valid: boolean): Value {
	const quote = text[open] as string;
	const close = closeOf(text, open, quote, quote !== "'");
	if (close === -1) return bareValue(text, open, line, false);
	const inner = text.slice(open + 1, close);
	const after = lineBounds(text, close + 1);
	const rest = text.slice(close + 1, after.content);
	const trailing = !/^(?:[ \t]+#.*)?[ \t]*$/.test(rest);
	const multiline = BREAK.test(inner);
	if (quote === "'" && inner.includes("\\")) return { ...bareValue(text, open, line, false), wide: true };
	// A post-quote hash is dotenv-js-only; the quote stays closed.
	if (multiline && trailing && !/^\s*(?:#.*)?$/.test(rest)) return bareValue(text, open, line, false);
	let end = close + 1;
	const hazards: SecretHazard[] = [];
	if (trailing) {
		end = after.content;
		while (end > close + 1 && isBlank(text[end - 1])) end -= 1;
		hazards.push(junk({ start: open, end }));
	}
	const span = { start: open, end };
	if (multiline) hazards.push({ span, within: 0, reach: "spelled", reshapes: false });
	if (quote === "`" || (quote === '"' && /`|\$\(/.test(inner))) hazards.push(junk(span));
	const expands = quote === '"' ? /[\\$`]/.test(inner) : quote === "`";
	const reading: ScalarReading =
		valid && !trailing && !expands && !multiline
			? { kind: "decided", value: inner, empty: inner === "" }
			: uncertain(inner === "");
	return { span, reading, hazards, next: after.next };
}

/** Safe unquoted values allow trailing comments. */
function bareValue(text: string, from: number, line: Line, valid: boolean): Value {
	const { content } = line;
	let end = from;
	while (end < content && SAFE_VALUE.test(text[end] as string)) end += 1;
	const rest = skipBlank(text, end, content);
	const spaces = SPACES.test(text.slice(end, rest));
	if (end > from && spaces && (rest === content || (rest > end && text[rest] === "#"))) {
		const value = text.slice(from, end);
		return {
			span: { start: from, end },
			reading: valid ? { kind: "decided", value, empty: false } : uncertain(false),
			hazards: [],
			next: line.next,
		};
	}
	let stop = content;
	while (stop > from && isBlank(text[stop - 1])) stop -= 1;
	const span = { start: from, end: stop };
	const code = beforeComment(text.slice(from, stop));
	return { span, reading: uncertain(false), hazards: COMMAND.test(code) ? [junk(span)] : [], next: line.next };
}

function valueAt(text: string, at: number, line: Line, valid: boolean): Value {
	return QUOTES.includes(text[at] as string) ? quotedValue(text, at, line, valid) : bareValue(text, at, line, valid);
}

function emptyReading(shellForm: boolean): ScalarReading {
	return shellForm ? { kind: "decided", value: "", empty: true } : uncertain(true);
}

function readDotenv(text: string): SecretSyntax {
	const children: number[] = [];
	const nodes: SecretNode[] = [
		{
			parent: -1,
			names: [],
			key: { start: 0, end: 0 },
			value: { start: 0, end: text.length },
			children,
			via: [],
			virtual: false,
		},
	];
	const hazards: SecretHazard[] = [];
	if (SEPARATOR.test(text)) {
		// Patterns split lines that values cross.
		const whole = { start: 0, end: text.length };
		return { documents: [{ nodes, hazards: [{ span: whole, within: 0, reach: "any", reshapes: true }] }] };
	}
	const scalars = new Map<number, ScalarReading>();
	/** Shell-word end excludes its continued lines. */
	let shellEnd = 0;
	let at = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
	while (at < text.length) {
		const line = lineBounds(text, at);
		let cursor = skipBlank(text, at, line.content);
		// Shell starts lines at LF; hashes need space or tab.
		const origin = at === 1 && text.charCodeAt(0) === BYTE_ORDER_MARK ? 0 : at;
		const commentable = (origin === 0 || text[origin - 1] === "\n") && SPACES.test(text.slice(origin, cursor));
		if (cursor === line.content || (text[cursor] === "#" && commentable)) {
			at = line.next;
			continue;
		}
		const lineStart = cursor;
		const plain = SPACES.test(text.slice(at, cursor));
		let { content, next } = line;
		if (text.startsWith("export", cursor) && isBlank(text[cursor + "export".length]))
			cursor = skipBlank(text, cursor + "export".length, content);
		const keyStart = cursor;
		while (cursor < content && KEY_CHAR.test(text[cursor] as string)) cursor += 1;
		const keyEnd = cursor;
		const separator = keyEnd === keyStart ? keyEnd : skipSpace(text, keyEnd);
		const sign = text[separator];
		if (keyEnd === keyStart || (sign !== "=" && sign !== ":")) {
			const reach = lineStart < shellEnd ? content : shellReach(text, lineStart, commentable);
			shellEnd = Math.max(shellEnd, reach);
			hazards.push(junk({ start: lineStart, end: Math.max(content, reach) }));
			at = line.next;
			continue;
		}

		const crossed = separator > content;
		let current = line;
		if (crossed) {
			current = lineBounds(text, separator);
			content = current.content;
			next = current.next;
		}
		const key = text.slice(keyStart, keyEnd);
		const afterSign = separator + 1;
		const valueStart = skipBlank(text, afterSign, content);
		const spaced = valueStart > afterSign;
		const shellForm = plain && !crossed && sign === "=" && separator === keyEnd && SHELL_NAME.test(key);
		const loose = !DOTENV_KEY.test(key);
		const empty = { start: afterSign, end: afterSign };
		let value: Value;
		let reached = false;
		let from = valueStart;
		if (valueStart === content) {
			// A quoted value may begin on the next line.
			const probe = skipSpace(text, next);
			const wrapped =
				sign === ":" &&
				separator === keyEnd &&
				afterSign === content &&
				next < text.length &&
				!"#\r\n".includes(text[next] as string);
			if (probe < text.length && QUOTES.includes(text[probe] as string)) {
				value = valueAt(text, probe, lineBounds(text, probe), false);
				from = probe;
				reached = true;
			} else if (wrapped) {
				const following = lineBounds(text, next);
				value = {
					span: { start: afterSign, end: following.content },
					reading: uncertain(false),
					hazards: [],
					next: following.next,
				};
				from = next;
				reached = true;
			} else {
				value = { span: empty, reading: emptyReading(shellForm), hazards: [], next };
			}
		} else if (text[valueStart] === "#" && spaced && SPACES.test(text.slice(afterSign, valueStart))) {
			value = { span: empty, reading: emptyReading(shellForm), hazards: [], next };
		} else {
			value = valueAt(text, valueStart, current, shellForm && !spaced);
		}
		// Reparse loose-key value lines as dotenv-js pairs.
		const via = loose && value.next !== next ? [{ start: content, end: value.span.end }] : [];
		if (via.length > 0)
			value = { ...value, span: { start: Math.min(value.span.start, content), end: content }, next };
		if (!shellForm || reached || (spaced && value.span.end > value.span.start)) {
			hazards.push(junk({ start: crossed ? keyStart : separator, end: Math.max(value.span.end, afterSign) }));
			if (value.reading.kind === "decided") value.reading = uncertain(value.reading.empty);
		}
		const first = from < shellEnd ? content : shellReach(text, from, false);
		const reach = innerReach(text, value.span, first, shellEnd);
		shellEnd = Math.max(shellEnd, reach);
		const extent = value.wide === true ? text.length : reach;
		if (extent > Math.max(content, value.span.end))
			hazards.push({ span: { start: keyStart, end: extent }, within: 0, reach: "spelled", reshapes: false });
		hazards.push(...value.hazards);

		scalars.set(nodes.length, value.reading);
		children.push(nodes.length);
		nodes.push({
			parent: 0,
			names: [key],
			key: { start: keyStart, end: keyEnd },
			value: value.span,
			children: [],
			via,
			virtual: false,
		});
		at = value.next;
	}
	const document: SecretSyntaxDocument = { nodes, hazards };
	readings.set(document, scalars);
	return { documents: [document] };
}

////////////////////////////////
//  Prefilter

/** Whether a unit belongs to a key. */
function inKey(text: string, at: number): boolean {
	return at >= 0 && at < text.length && KEY_CHAR.test(text[at] as string);
}

/** Whether a name spans the whole key run. */
function isWholeKey(text: string, start: number, end: number): boolean {
	return !(inKey(text, start - 1) && inKey(text, start)) && !(inKey(text, end) && inKey(text, end - 1));
}

////////////////////////////////
//  Format

export const dotenvFormat: SecretFormat & { id: "dotenv" } = {
	id: "dotenv",
	consumers: ["dotenv-js", "compose-go dotenv", "POSIX sh source"],
	matches: (module) => {
		const lower = module.toLowerCase();
		return lower.slice(lower.lastIndexOf("/") + 1).startsWith(".env");
	},
	inert: /(?:\s+|#[^\n]*|export(?=\s)|[=:])/y,
	read: readDotenv,
	scalar: (document, node) => readings.get(document)?.get(node) ?? uncertain(false),
	mayName: (text, span, names) =>
		names.some(
			(name) =>
				someOccurrence(text, name, span, (start, end) => isWholeKey(text, start, end)) ||
				// Shell backslash escapes join lines.
				includesWithin(text, "\\\n", span),
		),
};
