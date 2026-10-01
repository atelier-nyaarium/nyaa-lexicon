// Owns GDScript header spans, handed to the protocol's one renderer.

import { type HeaderFold, type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";
import { declarationStart } from "./line-syntax.js";
import type { ReferenceToken, SourceLine } from "./parse-model.js";
import {
	firstLineToken,
	isIgnorable,
	type LexedSource,
	nextReferenceToken,
	previousReferenceToken,
	tokenAt,
} from "./tokens.js";

//////// Types

/**
 * Where a header stops, besides `;` or an outside-bracket line end.
 * `colon` includes it; `brace` stops before it; `member` also breaks at commas, across lines.
 */
export type HeaderStop = "colon" | "line" | "brace" | "member";

export interface HeaderRequest {
	line: SourceLine;
	/** Column of the header's first token on `line`. */
	head: number;
	/** Column of the declared name on `line`. */
	name: number;
	stop: HeaderStop;
	/** A colon right after the name opens a type. */
	typed?: boolean;
}

interface Scan {
	end: number;
	folds: HeaderFold[];
	/** Line-joining backslashes. */
	joins: OffsetRange[];
}

/** A folded body and the token the scan resumes at. */
interface Body extends OffsetRange {
	next: number;
}

//////// Constants

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/** Words after which `[` opens a literal. */
const OPERATOR_WORDS = new Set(["and", "or", "not", "in", "if", "else", "return", "await"]);

/** After a colon, an accessor rather than a type. */
const ACCESSORS = new Set(["get", "set"]);

//////// Helpers

/** A line-joining backslash. */
function isContinuation(token: ReferenceToken | undefined): boolean {
	return token?.kind === "symbol" && token.value === "\\";
}

//////// Headers

/** Walks tokens, so strings and comments never count. */
export class HeaderReader {
	private readonly lines: readonly SourceLine[];
	private readonly tokens: ReferenceToken[];
	private readonly starts: number[];
	private readonly comments = new Map<number, OffsetRange>();
	/** In source order, prefixes included. */
	private readonly strings: OffsetRange[];

	constructor(
		private readonly text: string,
		private readonly lexed: LexedSource,
	) {
		this.lines = lexed.lines;
		this.tokens = lexed.tokens;
		this.starts = this.lines.map((line) => line.start);
		for (const comment of lexed.comments) {
			const start = this.starts[comment.range.start.line];
			if (start === undefined) continue;
			this.comments.set(comment.range.start.line, {
				start: start + comment.range.start.character,
				end: start + comment.range.end.character,
			});
		}
		this.strings = lexed.strings.map((string) => ({
			start: (this.starts[string.start.line] ?? 0) + string.start.character,
			end: (this.starts[string.end.line] ?? 0) + string.end.character,
		}));
	}

	/** One line, owned annotations included. */
	header(request: HeaderRequest): string | undefined {
		const line = request.line.line;
		const head = tokenAt(this.lexed, line, request.head);
		const name = tokenAt(this.lexed, line, request.name);
		if (head < 0 || name < 0) return undefined;
		const first = declarationStart(this.lexed, line, request.head);
		const start = (this.starts[first.line] ?? 0) + first.character;
		const scan = this.scan(head, name, request);
		const omit = [...scan.joins];
		const last = this.lineAt(scan.end);
		for (let index = first.line; index <= last; index++) {
			const comment = this.comments.get(index);
			if (comment !== undefined) omit.push(comment);
		}
		const verbatim = this.stringsWithin(start, scan.end);
		return renderHeader(this.text, { start, end: scan.end, folds: scan.folds, omit, verbatim });
	}

	private stringsWithin(start: number, end: number): OffsetRange[] {
		let low = 0;
		let high = this.strings.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((this.strings[middle] as OffsetRange).start < start) low = middle + 1;
			else high = middle;
		}
		const found: OffsetRange[] = [];
		for (let index = low; index < this.strings.length; index++) {
			const string = this.strings[index] as OffsetRange;
			if (string.start >= end) break;
			if (string.end <= end) found.push(string);
		}
		return found;
	}

	private scan(from: number, name: number, request: HeaderRequest): Scan {
		const tokens = this.tokens;
		const folds: HeaderFold[] = [];
		const joins: OffsetRange[] = [];
		const done = (end: number): Scan => ({ end, folds, joins });
		// Depths of lambdas awaiting their colon.
		const lambdas: number[] = [];
		let typed = request.typed === true;
		let depth = 0;
		let at = from;
		while (at < tokens.length) {
			const token = tokens[at] as ReferenceToken;
			const value = token.value;
			if (token.kind === "newline") {
				if (depth === 0 && request.stop !== "member" && !this.endsInString(token.line)) {
					const join = tokens[at - 1];
					if (join === undefined || !isContinuation(join)) return done(this.offset(token));
					const offset = this.offset(join);
					joins.push({ start: offset, end: offset + 1 });
				}
				at++;
				continue;
			}
			if (token.kind !== "symbol") {
				if (at > name && token.kind === "identifier" && value === "func") lambdas.push(depth);
				at++;
				continue;
			}
			if (depth === 0 && (value === ";" || (value === "," && request.stop === "member")))
				return done(this.offset(token));
			if (depth === 0 && value === "{" && request.stop === "brace") return done(this.offset(token));
			if ((value === "[" || value === "{") && this.startsLiteral(at)) {
				const close = this.closing(at);
				if (close < 0) break;
				folds.push({ start: this.offset(token), end: this.end(close) });
				at = close + 1;
				continue;
			}
			if (OPENERS.has(value)) depth++;
			if (CLOSERS.has(value)) {
				if (depth === 0) return done(this.offset(token));
				depth--;
				while ((lambdas.at(-1) ?? -1) > depth) lambdas.pop();
			}
			if (value === ":") {
				if (lambdas.at(-1) === depth) {
					lambdas.pop();
					const body = this.lambdaBody(at, depth);
					if (body !== undefined) {
						folds.push({ start: body.start, end: body.end, bare: true });
						at = body.next;
						continue;
					}
				} else if (depth === 0) {
					const opensType = typed && this.opensType(name, at);
					typed = false;
					if (!opensType && request.stop === "colon") return done(this.end(at));
				}
			}
			at++;
		}
		const lastCode = this.lastCodeToken();
		const open = this.endsInString(this.lines.length - 1);
		if (at >= tokens.length && depth === 0 && request.stop !== "member" && !open && lastCode >= 0)
			return done(this.end(lastCode));
		// Unterminated: the first line alone.
		const line = (tokens[from] as ReferenceToken).line;
		const last = this.lexed.lineTokens[line]?.at(-1) ?? from;
		return done(this.end(last));
	}

	private lastCodeToken(): number {
		let index = this.tokens.length - 1;
		while (index >= 0 && (this.tokens[index] as ReferenceToken).kind === "newline") index--;
		return index;
	}

	/** Its matching closer, or -1. */
	private closing(open: number): number {
		let depth = 0;
		for (let index = open; index < this.tokens.length; index++) {
			const value = (this.tokens[index] as ReferenceToken).value;
			if (OPENERS.has(value)) depth++;
			else if (CLOSERS.has(value) && --depth === 0) return index;
		}
		return -1;
	}

	/** After a value, `[` subscripts or types. */
	private startsLiteral(at: number): boolean {
		if ((this.tokens[at] as ReferenceToken).value === "{") return true;
		const previous = this.tokens[previousReferenceToken(this.tokens, at)];
		if (previous === undefined) return true;
		if (previous.kind === "string" || previous.kind === "number") return false;
		if (previous.kind === "identifier") return OPERATOR_WORDS.has(previous.value);
		return !CLOSERS.has(previous.value);
	}

	/** Unless `get` or `set` follows. */
	private opensType(name: number, colon: number): boolean {
		if (nextReferenceToken(this.tokens, name) !== colon) return false;
		const next = this.tokens[colon + 1];
		return next?.kind === "identifier" && !ACCESSORS.has(next.value);
	}

	/** Inline tail or indented block. */
	private lambdaBody(colon: number, depth: number): Body | undefined {
		const next = this.tokens[colon + 1];
		if (next !== undefined && next.kind !== "newline") return this.inlineBody(colon + 1, depth);
		return this.blockBody((this.tokens[colon] as ReferenceToken).line);
	}

	private inlineBody(start: number, depth: number): Body | undefined {
		let local = 0;
		let at = start;
		for (; at < this.tokens.length; at++) {
			const token = this.tokens[at] as ReferenceToken;
			const value = token.value;
			if (local === 0 && (token.kind === "newline" || value === ";" || (value === "," && depth > 0))) break;
			if (OPENERS.has(value)) local++;
			if (CLOSERS.has(value)) {
				if (local === 0) break;
				local--;
			}
		}
		if (at === start) return undefined;
		return { start: this.offset(this.tokens[start] as ReferenceToken), end: this.end(at - 1), next: at };
	}

	private blockBody(colonLine: number): Body | undefined {
		const indent = (this.lines[colonLine] as SourceLine).indent;
		let first = -1;
		let last = -1;
		for (let index = colonLine + 1; index < this.lines.length; index++) {
			if (isIgnorable(this.lexed, index)) continue;
			if ((this.lines[index] as SourceLine).indent <= indent) break;
			if (first < 0) first = index;
			last = index;
		}
		const opening = firstLineToken(this.lexed, first);
		const closing = this.lexed.lineTokens[last]?.at(-1);
		if (opening === undefined || closing === undefined) return undefined;
		return { start: this.offset(opening), end: this.end(closing), next: closing + 1 };
	}

	/** Whether its line ends inside a string. */
	private endsInString(line: number): boolean {
		return this.lines[line]?.endsInString === true;
	}

	private offset(token: ReferenceToken): number {
		return token.offset;
	}

	/** Offset past the token at `index`. */
	private end(index: number): number {
		const token = this.tokens[index] as ReferenceToken;
		return token.offset + token.value.length;
	}

	private lineAt(offset: number): number {
		let low = 0;
		let high = this.starts.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if ((this.starts[middle] ?? 0) <= offset) low = middle;
			else high = middle - 1;
		}
		return low;
	}
}
