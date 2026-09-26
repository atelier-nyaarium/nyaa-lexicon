// Owns GDScript header spans, handed to the protocol's one renderer.

import { type HeaderFold, type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";
import { isIdentifierPart, isIdentifierStart } from "./cursor.js";
import { annotationLine, indentationEnd, indentOf, isIgnorable } from "./line-syntax.js";
import type { SourceLine } from "./parse-model.js";
import type { ScannedSource } from "./source-scan.js";

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
	/** Column just past the declared name. */
	nameEnd: number;
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

//////// Constants

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/** Words after which `[` opens a literal. */
const OPERATOR_WORDS = new Set(["and", "or", "not", "in", "if", "else", "return", "await"]);

/** After a colon, an accessor rather than a type. */
const ACCESSORS = new Set(["get", "set"]);

//////// Helpers

function isBlank(character: string): boolean {
	return character === " " || character === "\t" || character === "\r";
}

function isWhitespace(character: string): boolean {
	return isBlank(character) || character === "\n";
}

//////// Headers

/** Scans masked code, so strings never count. */
export class HeaderReader {
	private readonly lines: readonly SourceLine[];
	private readonly masked: string;
	private readonly starts: number[] = [];
	private readonly comments = new Map<number, OffsetRange>();
	/** In source order, prefixes included. */
	private readonly strings: OffsetRange[];

	constructor(
		private readonly text: string,
		scanned: ScannedSource,
	) {
		this.lines = scanned.lines;
		let offset = 0;
		for (const line of this.lines) {
			this.starts.push(offset);
			offset += line.text.length + 1;
		}
		this.masked = this.lines.map((line) => line.code).join("\n");
		for (const comment of scanned.comments) {
			const start = this.starts[comment.range.start.line];
			if (start === undefined) continue;
			this.comments.set(comment.range.start.line, {
				start: start + comment.range.start.character,
				end: start + comment.range.end.character,
			});
		}
		this.strings = scanned.strings.map((string) => {
			const start = (this.starts[string.start.line] ?? 0) + string.start.character;
			return {
				start: this.prefixed(start),
				end: (this.starts[string.end.line] ?? 0) + string.end.character,
			};
		});
	}

	/** One line, owned annotations included. */
	header(request: HeaderRequest): string | undefined {
		const lineStart = this.starts[request.line.line] ?? 0;
		const first = this.firstLine(request.line, request.head);
		const start = first === request.line.line ? lineStart + request.head : this.codeStart(first);
		const scan = this.scan(lineStart + request.head, lineStart + request.nameEnd, request);
		const omit = [...scan.joins];
		const last = this.lineAt(scan.end);
		for (let line = first; line <= last; line++) {
			const comment = this.comments.get(line);
			if (comment !== undefined) omit.push(comment);
		}
		const verbatim = this.stringsWithin(start, scan.end);
		return renderHeader(this.text, { start, end: scan.end, folds: scan.folds, omit, verbatim });
	}

	/** StringName, NodePath and raw prefixes. */
	private prefixed(quote: number): number {
		const prefix = this.text.charAt(quote - 1);
		if (prefix === "&" || prefix === "^") return quote - 1;
		return prefix === "r" && !isIdentifierPart(this.text.charAt(quote - 2)) ? quote - 1 : quote;
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

	/** Line of the first owned annotation. */
	private firstLine(line: SourceLine, head: number): number {
		let first = line.line;
		let before = head - 1;
		while (before >= 0 && isBlank(line.code.charAt(before))) before--;
		if (before >= 0) return first;
		for (let index = line.line - 1; index >= 0; index--) {
			const above = this.lines[index] as SourceLine;
			if (isIgnorable(above)) {
				if (above.text.trim() === "") break;
				continue;
			}
			const run = annotationLine(above);
			if (run === null) break;
			if (run.head !== null) first = index;
			if (run.detached) break;
		}
		return first;
	}

	/** Start of its owned annotations. */
	private codeStart(index: number): number {
		const line = this.lines[index] as SourceLine;
		const run = annotationLine(line);
		return (this.starts[index] ?? 0) + (run?.head ?? indentationEnd(line.text));
	}

	private scan(from: number, nameEnd: number, request: HeaderRequest): Scan {
		const masked = this.masked;
		const folds: HeaderFold[] = [];
		const joins: OffsetRange[] = [];
		const done = (end: number): Scan => ({ end, folds, joins });
		// Depths of lambdas awaiting their colon.
		const lambdas: number[] = [];
		let typed = request.typed === true;
		let depth = 0;
		let at = from;
		while (at < masked.length) {
			const character = masked.charAt(at);
			if (at >= nameEnd && isIdentifierStart(character) && !isIdentifierPart(masked.charAt(at - 1))) {
				const word = this.wordAt(at);
				if (word === "func") lambdas.push(depth);
				at += word.length;
				continue;
			}
			if (character === "\n") {
				if (depth === 0 && request.stop !== "member" && !this.inString(at)) {
					const join = this.joinBefore(at);
					if (join < 0) return done(at);
					joins.push({ start: join, end: join + 1 });
				}
				at++;
				continue;
			}
			if (depth === 0 && (character === ";" || (character === "," && request.stop === "member"))) return done(at);
			if (depth === 0 && character === "{" && request.stop === "brace") return done(at);
			if ((character === "[" || character === "{") && this.startsLiteral(at)) {
				const close = this.closing(at);
				if (close < 0) break;
				folds.push({ start: at, end: close + 1 });
				at = close + 1;
				continue;
			}
			if (OPENERS.has(character)) depth++;
			if (CLOSERS.has(character)) {
				if (depth === 0) return done(at);
				depth--;
				while ((lambdas.at(-1) ?? -1) > depth) lambdas.pop();
			}
			if (character === ":") {
				if (masked.charAt(at + 1) === "=") {
					at += 2;
					continue;
				}
				if (lambdas.at(-1) === depth) {
					lambdas.pop();
					const body = this.lambdaBody(at + 1, depth);
					if (body !== undefined) {
						folds.push({ ...body, bare: true });
						at = body.end;
						continue;
					}
				} else if (depth === 0) {
					const opensType = typed && this.opensType(nameEnd, at);
					typed = false;
					if (!opensType && request.stop === "colon") return done(at + 1);
				}
			}
			at++;
		}
		const open = this.inString(masked.length - 1);
		if (at >= masked.length && depth === 0 && request.stop !== "member" && !open) return done(masked.length);
		// Unterminated: the first line alone.
		const line = this.lines[this.lineAt(from)] as SourceLine;
		return done((this.starts[line.line] ?? 0) + line.text.trimEnd().length);
	}

	private wordAt(at: number): string {
		let end = at;
		while (end < this.masked.length && isIdentifierPart(this.masked.charAt(end))) end++;
		return this.masked.slice(at, end);
	}

	/** Continuation backslash, or -1. */
	private joinBefore(newline: number): number {
		let index = newline - 1;
		while (index >= 0 && isBlank(this.masked.charAt(index))) index--;
		return this.masked.charAt(index) === "\\" ? index : -1;
	}

	/** Its matching closer, or -1. */
	private closing(open: number): number {
		let depth = 0;
		for (let index = open; index < this.masked.length; index++) {
			const character = this.masked.charAt(index);
			if (OPENERS.has(character)) depth++;
			else if (CLOSERS.has(character) && --depth === 0) return index;
		}
		return -1;
	}

	/** After a value, `[` subscripts or types. */
	private startsLiteral(at: number): boolean {
		if (this.masked.charAt(at) === "{") return true;
		let index = at - 1;
		while (index >= 0 && isWhitespace(this.masked.charAt(index))) {
			if (!isWhitespace(this.text.charAt(index)) && !this.inComment(index)) return false;
			index--;
		}
		const previous = this.masked.charAt(index);
		if (CLOSERS.has(previous)) return false;
		if (!isIdentifierPart(previous)) return true;
		let begin = index;
		while (begin > 0 && isIdentifierPart(this.masked.charAt(begin - 1))) begin--;
		return OPERATOR_WORDS.has(this.masked.slice(begin, index + 1));
	}

	/** Unless `get` or `set` follows. */
	private opensType(nameEnd: number, colon: number): boolean {
		if (this.masked.slice(nameEnd, colon).trim() !== "") return false;
		let at = colon + 1;
		while (isBlank(this.masked.charAt(at))) at++;
		const word = this.wordAt(at);
		return word !== "" && !ACCESSORS.has(word);
	}

	/** Inline tail or indented block. */
	private lambdaBody(after: number, depth: number): OffsetRange | undefined {
		const line = this.lineAt(after);
		const comment = this.comments.get(line)?.start ?? Number.POSITIVE_INFINITY;
		let start = after;
		while (isBlank(this.text.charAt(start))) start++;
		const rest = this.text.charAt(start);
		if (rest !== "" && rest !== "\n" && start < comment) return this.inlineBody(start, depth);
		return this.blockBody(line);
	}

	private inlineBody(start: number, depth: number): OffsetRange | undefined {
		let local = 0;
		let at = start;
		for (; at < this.masked.length; at++) {
			const character = this.masked.charAt(at);
			if (local === 0 && (character === "\n" || character === ";" || (character === "," && depth > 0))) break;
			if (OPENERS.has(character)) local++;
			if (CLOSERS.has(character)) {
				if (local === 0) break;
				local--;
			}
		}
		while (at > start && isWhitespace(this.text.charAt(at - 1))) at--;
		return at > start ? { start, end: at } : undefined;
	}

	private blockBody(colonLine: number): OffsetRange | undefined {
		const indent = indentOf((this.lines[colonLine] as SourceLine).text);
		let first = -1;
		let last = -1;
		for (let index = colonLine + 1; index < this.lines.length; index++) {
			const line = this.lines[index] as SourceLine;
			if (isIgnorable(line)) continue;
			if (indentOf(line.text) <= indent) break;
			if (first < 0) first = index;
			last = index;
		}
		if (first < 0) return undefined;
		const firstLine = this.lines[first] as SourceLine;
		const lastLine = this.lines[last] as SourceLine;
		return {
			start: (this.starts[first] ?? 0) + indentationEnd(firstLine.text),
			end: (this.starts[last] ?? 0) + lastLine.text.trimEnd().length,
		};
	}

	/** Whether its line ends inside a string. */
	private inString(offset: number): boolean {
		return this.lines[this.lineAt(offset)]?.endsInString === true;
	}

	private inComment(offset: number): boolean {
		const comment = this.comments.get(this.lineAt(offset));
		return comment !== undefined && offset >= comment.start && offset < comment.end;
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
