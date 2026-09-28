// C# lexical grammar through one SourceCursor, conditional compilation applied as it reads.

import {
	type CursorMark,
	type Diagnostic,
	isTooDeep,
	NestingGauge,
	type Position,
	type Range,
	SourceCursor,
	TOO_DEEP,
} from "@nyaa-lexicon/protocol";
import { isDigit, isIdentifierPart, isNewline, isWhitespace } from "./characters.js";
import { CONDITION_OPERATORS, ConditionEvaluator, type ConditionToken } from "./conditions.js";
import { decodeEscape, readIdentifier, startsIdentifier } from "./escapes.js";
import { readNumber } from "./numbers.js";
import { dedented, joined, type RawPart } from "./rawStrings.js";

////////////////////////////////
//  Interfaces & Types

export type TokenKind =
	| "identifier"
	| "number"
	| "string"
	| "character"
	| "boolean"
	| "punctuation"
	| "doc"
	| "comment"
	| "directive"
	| "newline"
	| "eof";

export interface Token {
	kind: TokenKind;
	value: string;
	raw: string;
	start: Position;
	end: Position;
	startOffset: number;
	endOffset: number;
	/** An `@` identifier: a name, never a keyword. */
	verbatim?: true;
	/** An interpolation hole's brace. */
	hole?: true;
	/** A literal's C# type. */
	literalType?: string;
	/** A number literal's value; none for an integer past 2^53. */
	number?: number;
}

/** Whether a code token shares a comment's first line before it and its last line after it. */
export interface CommentTrivia {
	codeBefore: boolean;
	codeAfter: boolean;
}

export interface LexedSource {
	/** Past the whole source, so `textOf` reads any span. */
	cursor: SourceCursor;
	tokens: Token[];
	literals: Token[];
	/** Every line and block comment token, in source order. A directive is not a comment. */
	comments: Token[];
	/** By comment token, interpolation holes included. */
	trivia: Map<Token, CommentTrivia>;
	/** Lines no token touches; a skipped section's text touches its lines. */
	blankLines: number[];
	/** Tokens right after a skipped section holding text. */
	droppedBefore: Set<Token>;
	/** Whole interpolated strings by start offset; the stream holds each as text around its holes' code. */
	interpolated: ReadonlyMap<number, Token>;
	diagnostics: Diagnostic[];
}

/** One `#if` group: whether its current section is live, and whether any section was. */
interface Conditional {
	directive: Token;
	live: boolean;
	taken: boolean;
	sawElse: boolean;
}

////////////////////////////////
//  Constants

const OPERATORS = [
	">>>=",
	"<<=",
	">>=",
	"??=",
	"=>",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"?.",
	"++",
	"--",
	"->",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"<<",
	">>",
	"::",
	"..",
] as const;

// Only these take a trailing comment; elsewhere slashes are the directive's own text.
const TOKENIZED_DIRECTIVES = new Set(["define", "elif", "else", "endif", "if", "line", "nullable", "pragma", "undef"]);

const CONDITIONAL_DIRECTIVES = new Set(["if", "elif", "else", "endif"]);

const GROUP_OPENERS = new Set(["(", "[", "{"]);

const GROUP_ENDS = new Set([")", "]", "}"]);

/** Built from its code point, since a raw zero-width character is forbidden in this repo's sources. */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

////////////////////////////////
//  Functions & Helpers

function rangeOf(start: Position, end: Position): Range {
	return { start, end };
}

function diagnostic(message: string, start: Position, end: Position): Diagnostic {
	return { severity: "error", message, range: rangeOf(start, end) };
}

function positionOf(mark: CursorMark): Position {
	return { line: mark.line, character: mark.column };
}

/** Up to `limit` of `character`. */
function consumeRun(cursor: SourceCursor, character: string, limit: number): void {
	for (let count = 0; count < limit && cursor.peek() === character; count++) cursor.next();
}

/** Length of the run of `character` at the cursor. */
function runLength(cursor: SourceCursor, character: string): number {
	let length = 0;
	while (cursor.peek(length) === character) length++;
	return length;
}

/** The line holding its last character. */
export function lastLine(item: Token): number {
	return item.end.character === 0 && item.end.line > item.start.line ? item.end.line - 1 : item.end.line;
}

function token(cursor: SourceCursor, kind: TokenKind, value: string, start: CursorMark): Token {
	return {
		kind,
		value,
		raw: cursor.textOf(start.offset),
		start: positionOf(start),
		end: cursor.position,
		startOffset: start.offset,
		endOffset: cursor.offset,
	};
}

/** Whether only white space stands before the next line break. */
function endsLine(cursor: SourceCursor): boolean {
	let ahead = 0;
	while (isWhitespace(cursor.peek(ahead))) ahead++;
	return isNewline(cursor.peek(ahead));
}

/** Tracks code and comments in source order to mark each comment's boundary-line trivia. */
class TriviaTracker {
	private codeLine = -1;
	private readonly pending: Token[] = [];

	constructor(private readonly trivia: Map<Token, CommentTrivia>) {}

	comment(item: Token): void {
		this.trivia.set(item, { codeBefore: item.start.line === this.codeLine, codeAfter: false });
		this.pending.push(item);
	}

	code(startLine: number, endLine: number): void {
		for (const item of this.pending) {
			const found = this.trivia.get(item);
			if (found !== undefined) found.codeAfter = startLine === lastLine(item);
		}
		this.pending.length = 0;
		this.codeLine = endLine;
	}
}

/** Every kept comment's trivia; a directive is code. */
function trackTrivia(tokens: Token[], trivia: Map<Token, CommentTrivia>): void {
	const tracker = new TriviaTracker(trivia);
	for (const item of tokens) {
		if (item.kind === "newline" || item.kind === "eof") continue;
		if (item.kind === "comment" || item.kind === "doc") tracker.comment(item);
		else tracker.code(item.start.line, lastLine(item));
	}
}

/** The empty remainder after a final line break is not a line. */
function blankLinesOf(tokens: Token[], skipped: ReadonlySet<number>, end: Token): number[] {
	const touched = new Set(skipped);
	for (const item of tokens) {
		if (item.kind === "newline" || item.kind === "eof") continue;
		for (let line = item.start.line; line <= lastLine(item); line++) touched.add(line);
	}
	const count = end.start.line + (end.start.character > 0 ? 1 : 0);
	const blank: number[] = [];
	for (let line = 0; line < count; line++) if (!touched.has(line)) blank.push(line);
	return blank;
}

////////////////////////////////
//  Classes

class CsharpLexer {
	readonly cursor: SourceCursor;
	private readonly tokens: Token[] = [];
	private readonly literals: Token[] = [];
	private readonly comments: Token[] = [];
	private readonly diagnostics: Diagnostic[] = [];
	private readonly trivia = new Map<Token, CommentTrivia>();
	private readonly droppedBefore = new Set<Token>();
	/** Lines a skipped section's text touches. */
	private readonly skippedLines = new Set<number>();
	/** Whole interpolated strings, which the stream holds as text runs around code. */
	private readonly interpolated: Token[] = [];
	private readonly groups: Conditional[] = [];
	private readonly defined: Set<string>;
	/** Only white space since the last line break. */
	private lineStart = true;
	/** A code token has been read; `#define` must come first. */
	private seenCode = false;
	/** Skipped text since the last kept token. */
	private dropped = false;
	/** Interpolation holes open around the cursor. */
	private holes = 0;
	private readonly gauge = new NestingGauge();

	constructor(
		text: string,
		private readonly collectLiterals: boolean,
		private readonly collectComments: boolean,
		symbols: readonly string[],
	) {
		this.cursor = new SourceCursor(text);
		this.defined = new Set(symbols);
	}

	run(): LexedSource {
		const cursor = this.cursor;
		try {
			while (cursor.good()) {
				const before = cursor.offset;
				if (this.live()) this.readCode();
				else this.readSkipped();
				if (cursor.offset <= before) throw new Error("tokenizer failed to advance");
			}
		} catch (error) {
			if (!isTooDeep(error)) throw error;
			this.diagnostics.push(diagnostic(TOO_DEEP, cursor.position, cursor.position));
			cursor.readWhile(() => true);
		}
		for (const group of this.groups)
			this.diagnostics.push(
				diagnostic("Conditional directive is not closed.", group.directive.start, group.directive.end),
			);
		const end = token(cursor, "eof", "", cursor.mark());
		this.tokens.push(end);
		trackTrivia(this.tokens, this.trivia);
		return {
			cursor,
			tokens: this.tokens,
			literals: this.literals,
			comments: this.comments,
			trivia: this.trivia,
			blankLines: blankLinesOf([...this.tokens, ...this.interpolated], this.skippedLines, end),
			droppedBefore: this.droppedBefore,
			interpolated: new Map(this.interpolated.map((item) => [item.startOffset, item])),
			diagnostics: this.diagnostics,
		};
	}

	private live(): boolean {
		return this.groups.at(-1)?.live ?? true;
	}

	private emit(item: Token): void {
		if (this.dropped) this.droppedBefore.add(item);
		this.dropped = false;
		this.tokens.push(item);
		if (item.kind === "newline") return;
		this.lineStart = false;
		if (item.kind !== "comment" && item.kind !== "doc" && item.kind !== "directive") this.seenCode = true;
	}

	private addComment(item: Token): void {
		this.emit(item);
		if (this.collectComments) this.comments.push(item);
	}

	private addLiteral(item: Token): void {
		if (!this.collectLiterals) return;
		if (item.kind === "string" || item.kind === "number" || item.kind === "boolean") this.literals.push(item);
	}

	/** A line break; only `\n` is one in positions, so any other break mints no token. */
	private lineBreak(live: boolean): void {
		const cursor = this.cursor;
		const start = cursor.mark();
		const character = cursor.next();
		if (character === "\r" && cursor.peek() === "\n") cursor.next();
		this.lineStart = true;
		if (live && cursor.line > start.line) this.emit(token(cursor, "newline", "\n", start));
	}

	/** One token or run of white space in a live section. */
	private readCode(): void {
		const cursor = this.cursor;
		const before = cursor.offset;
		const character = cursor.peek();
		if (before === 0 && character === BYTE_ORDER_MARK) {
			// A leading byte order mark is not source text; drop it like whitespace.
			cursor.next();
		} else if (isWhitespace(character)) {
			cursor.next();
		} else if (isNewline(character)) {
			this.lineBreak(true);
		} else if (character === "#" && this.lineStart && this.holes === 0) {
			this.directive();
		} else if (cursor.startsWith("//")) {
			const start = cursor.mark();
			cursor.take("//");
			if (cursor.peek() === "/") {
				cursor.next();
				if (cursor.peek() === " ") cursor.next();
				const value = cursor.readWhile((item) => !isNewline(item));
				this.addComment(token(cursor, "doc", value, start));
			} else {
				cursor.readWhile((item) => !isNewline(item));
				this.addComment(token(cursor, "comment", "", start));
			}
		} else if (cursor.startsWith("/*")) {
			const start = cursor.mark();
			cursor.take("/*");
			cursor.readWhile(() => !cursor.startsWith("*/"));
			if (!cursor.take("*/"))
				this.diagnostics.push(
					diagnostic("Block comment has no closing delimiter.", positionOf(start), cursor.position),
				);
			this.addComment(token(cursor, "comment", "", start));
		} else if (character === "@" && startsIdentifier(cursor, 1)) {
			const start = cursor.mark();
			cursor.next();
			const { value } = readIdentifier(cursor);
			this.emit({ ...token(cursor, "identifier", value, start), verbatim: true });
		} else if (character === '"' || character === "'" || character === "$" || character === "@") {
			this.readStringToken(character);
		} else if (isDigit(character) || (character === "." && isDigit(cursor.peek(1)))) {
			const start = cursor.mark();
			const read = readNumber(cursor);
			const item: Token = {
				...token(cursor, "number", read.value, start),
				literalType: read.type,
				...(read.number === undefined ? {} : { number: read.number }),
			};
			this.emit(item);
			this.addLiteral(item);
		} else if (startsIdentifier(cursor)) {
			const start = cursor.mark();
			const { value, escaped } = readIdentifier(cursor);
			const item: Token = escaped
				? { ...token(cursor, "identifier", value, start), verbatim: true }
				: value === "true" || value === "false"
					? { ...token(cursor, "boolean", value, start), literalType: "bool" }
					: token(cursor, "identifier", value, start);
			this.emit(item);
			this.addLiteral(item);
		} else {
			const start = cursor.mark();
			const operator = OPERATORS.find((candidate) => cursor.startsWith(candidate)) ?? character;
			cursor.take(operator);
			const item = token(cursor, "punctuation", operator, start);
			if (operator === "#")
				this.diagnostics.push(
					diagnostic("A preprocessor directive must start its line.", item.start, item.end),
				);
			this.emit(item);
		}
	}

	/**
	 * A string or character literal from its prefix: one token, or, interpolated, a string token
	 * for each run of text around its holes' code. The literal is the whole, holes kept as written.
	 */
	private readStringToken(character: string): void {
		const cursor = this.cursor;
		const start = cursor.mark();
		const prefix = cursor.readWhile((item) => item === "$" || item === "@");
		const verbatim = prefix.includes("@");
		const dollars = prefix.length - prefix.replaceAll("$", "").length;
		const quote = cursor.peek();
		if (quote !== '"' && quote !== "'") {
			cursor.rewind(start);
			cursor.next();
			this.emit(token(cursor, "punctuation", character, start));
			return;
		}
		const raw = !verbatim && quote === '"' && cursor.peek(1) === '"' && cursor.peek(2) === '"';
		// Before its holes' literals, in source order.
		const slot = this.literals.length;
		const read = raw ? this.readRawString(start, dollars) : this.readQuoted(start, quote, verbatim, dollars);
		const string = quote === '"';
		// A UTF-8 literal: the suffix is the string's own.
		const utf8 =
			string &&
			read.closed &&
			dollars === 0 &&
			(cursor.startsWith("u8") || cursor.startsWith("U8")) &&
			!isIdentifierPart(cursor.peek(2));
		if (utf8) cursor.take(`${cursor.peek()}8`);
		const literalType = utf8 ? "ReadOnlySpan<byte>" : string ? "string" : "char";
		const item: Token = { ...token(cursor, string ? "string" : "character", read.value, start), literalType };
		if (dollars === 0) this.emit(item);
		else this.interpolated.push(item);
		if (!read.closed)
			this.diagnostics.push(diagnostic("String literal has no closing quote.", item.start, item.end));
		if (read.invalidNewline)
			this.diagnostics.push(diagnostic("String literal cannot contain a newline.", item.start, item.end));
		if (this.collectLiterals && string) this.literals.splice(slot, 0, item);
	}

	/** A regular or verbatim string or character, from its quote. */
	private readQuoted(
		start: CursorMark,
		quote: string,
		verbatim: boolean,
		dollars: number,
	): { value: string; closed: boolean; invalidNewline: boolean } {
		const cursor = this.cursor;
		const text = { start };
		let value = "";
		let invalidNewline = false;
		let closed = false;
		cursor.next();
		let guard = -1;
		while (cursor.good()) {
			if (cursor.offset <= guard) throw new Error("quoted string reader failed to advance");
			guard = cursor.offset;
			const character = cursor.peek();
			if (character === quote) {
				cursor.next();
				if (!verbatim || cursor.peek() !== quote) {
					closed = true;
					break;
				}
				cursor.next();
				value += quote;
			} else if (dollars > 0 && character === "{" && cursor.peek(1) !== "{") {
				value += this.hole(text, 1);
			} else if (dollars > 0 && (character === "{" || character === "}") && cursor.peek(1) === character) {
				cursor.next();
				cursor.next();
				value += character;
			} else if (!verbatim && character === "\\") {
				value += decodeEscape(cursor);
			} else {
				if (!verbatim && isNewline(character)) invalidNewline = true;
				value += cursor.next();
			}
		}
		if (dollars > 0) this.emitText(text.start);
		return { value, closed, invalidNewline };
	}

	/** A raw string, from its opening quotes; a hole opens with as many braces as it has dollars. */
	private readRawString(
		start: CursorMark,
		dollars: number,
	): { value: string; closed: boolean; invalidNewline: false } {
		const cursor = this.cursor;
		const text = { start };
		// Closes only on a run as long as the opener; a shorter run is content.
		const opener = runLength(cursor, '"');
		consumeRun(cursor, '"', opener);
		const multiline = endsLine(cursor);
		const parts: RawPart[] = [];
		let content = "";
		const flush = (): void => {
			if (content !== "") parts.push({ text: content, hole: false });
			content = "";
		};
		let closed = false;
		let guard = -1;
		while (cursor.good() && !closed) {
			if (cursor.offset <= guard) throw new Error("raw string reader failed to advance");
			guard = cursor.offset;
			const character = cursor.peek();
			if (character === "{" && dollars > 0) {
				const run = runLength(cursor, "{");
				const literal = run < dollars ? run : run - dollars;
				content += "{".repeat(literal);
				consumeRun(cursor, "{", literal);
				if (run >= dollars) {
					flush();
					parts.push({ text: this.hole(text, dollars), hole: true });
				}
			} else if (character === '"') {
				const run = runLength(cursor, '"');
				consumeRun(cursor, '"', run);
				content += '"'.repeat(run < opener ? run : run - opener);
				closed = run >= opener;
			} else {
				content += cursor.next();
			}
		}
		flush();
		if (dollars > 0) this.emitText(text.start);
		return { value: closed && multiline ? dedented(parts) : joined(parts), closed, invalidNewline: false };
	}

	/** An interpolated string's run of text from `start`, as a string token. */
	private emitText(start: CursorMark): void {
		if (this.cursor.offset > start.offset)
			this.emit({ ...token(this.cursor, "string", "", start), literalType: "string" });
	}

	/**
	 * One hole at its braces: its code as tokens, then its format text through the closing braces.
	 * Answers the hole as written, braces included, for the literal's value.
	 */
	private hole(text: { start: CursorMark }, braces: number): string {
		const cursor = this.cursor;
		const start = cursor.mark();
		this.emitText(text.start);
		// The braces are a group, so a comma or colon inside never reads as the string's neighbor's.
		consumeRun(cursor, "{", braces);
		this.emit({ ...token(cursor, "punctuation", "{", start), hole: true });
		this.gauge.open();
		this.holes++;
		let depth = 0;
		while (cursor.good()) {
			const before = cursor.offset;
			const character = cursor.peek();
			// A colon outside the hole's groups, and not half of `::`, starts its format.
			if (depth === 0 && (character === "}" || (character === ":" && !cursor.startsWith("::")))) break;
			const count = this.tokens.length;
			this.readCode();
			const last = this.tokens.length > count ? this.tokens.at(-1) : undefined;
			if (last?.kind === "punctuation" && GROUP_OPENERS.has(last.value)) depth++;
			else if (last?.kind === "punctuation" && GROUP_ENDS.has(last.value)) depth = Math.max(0, depth - 1);
			if (cursor.offset <= before) throw new Error("hole reader failed to advance");
		}
		this.holes--;
		this.gauge.close();
		const format = cursor.mark();
		cursor.readWhile((character) => character !== "}");
		this.emitText(format);
		const close = cursor.mark();
		consumeRun(cursor, "}", braces);
		if (cursor.offset > close.offset) this.emit({ ...token(cursor, "punctuation", "}", close), hole: true });
		text.start = cursor.mark();
		return cursor.textOf(start.offset);
	}

	/** One line of a skipped section: white space, a line break, a conditional directive, or text. */
	private readSkipped(): void {
		const cursor = this.cursor;
		const character = cursor.peek();
		if (isWhitespace(character)) {
			cursor.next();
		} else if (isNewline(character)) {
			this.lineBreak(false);
		} else if (character === "#" && this.lineStart && CONDITIONAL_DIRECTIVES.has(this.directiveKeyword())) {
			this.directive();
		} else {
			this.skipText();
		}
	}

	/** The rest of a line in a skipped section. */
	private skipText(): void {
		const cursor = this.cursor;
		this.skippedLines.add(cursor.line);
		cursor.readWhile((item) => !isNewline(item));
		this.dropped = true;
		this.lineStart = false;
	}

	/** The keyword of the directive at the cursor, read without moving. */
	private directiveKeyword(): string {
		const cursor = this.cursor;
		const mark = cursor.mark();
		cursor.next();
		cursor.readWhile(isWhitespace);
		const keyword = cursor.readWhile(isIdentifierPart);
		cursor.rewind(mark);
		return keyword;
	}

	private directive(): void {
		const cursor = this.cursor;
		const start = cursor.mark();
		cursor.next();
		cursor.readWhile(isWhitespace);
		const keyword = cursor.readWhile(isIdentifierPart);
		let condition: ConditionToken[] | undefined;
		let symbol = "";
		if (keyword === "if" || keyword === "elif") {
			condition = this.readCondition();
		} else {
			if (keyword === "define" || keyword === "undef") {
				cursor.readWhile(isWhitespace);
				if (startsIdentifier(cursor)) symbol = readIdentifier(cursor).value;
			}
			this.skipDirectiveText(TOKENIZED_DIRECTIVES.has(keyword));
		}
		const directive = token(cursor, "directive", keyword, start);
		this.emit(directive);
		if (keyword === "define" || keyword === "undef") this.defineSymbol(directive, symbol);
		else if (CONDITIONAL_DIRECTIVES.has(keyword)) this.conditional(directive, condition ?? []);
		if (!cursor.startsWith("//")) return;
		if (!this.live()) {
			this.skipText();
			return;
		}
		const commentStart = cursor.mark();
		cursor.readWhile((item) => !isNewline(item));
		this.addComment(token(cursor, "comment", "", commentStart));
	}

	private defineSymbol(directive: Token, symbol: string): void {
		if (this.seenCode)
			this.diagnostics.push(
				diagnostic("#define and #undef must come before the first token.", directive.start, directive.end),
			);
		if (symbol === "" || symbol === "true" || symbol === "false") return;
		if (directive.value === "define") this.defined.add(symbol);
		else this.defined.delete(symbol);
	}

	/** Exactly one section of a group is live, and none under a skipped section. */
	private conditional(directive: Token, condition: ConditionToken[]): void {
		const keyword = directive.value;
		if (keyword === "if") {
			const parentLive = this.live();
			const value = parentLive && this.evaluate(directive, condition);
			this.groups.push({ directive, live: value, taken: value || !parentLive, sawElse: false });
			return;
		}
		const group = this.groups.at(-1);
		if (group === undefined) {
			this.diagnostics.push(
				diagnostic(`Unexpected #${keyword} outside a conditional.`, directive.start, directive.end),
			);
			return;
		}
		if (keyword === "endif") {
			this.groups.pop();
			return;
		}
		if (group.sawElse) {
			this.diagnostics.push(diagnostic(`Unexpected #${keyword} after #else.`, directive.start, directive.end));
			return;
		}
		if (keyword === "else") {
			group.sawElse = true;
			group.live = !group.taken;
		} else {
			group.live = !group.taken && this.evaluate(directive, condition);
		}
		group.taken ||= group.live;
	}

	private evaluate(directive: Token, condition: ConditionToken[]): boolean {
		const evaluator = new ConditionEvaluator(condition, this.defined);
		const value = evaluator.value();
		if (!evaluator.valid) {
			const at = evaluator.problem?.range ?? { start: directive.end, end: directive.end };
			this.diagnostics.push(diagnostic("Invalid preprocessor expression.", at.start, at.end));
		}
		return value;
	}

	/** To the quote or line end. */
	private skipDirectiveString(): void {
		const cursor = this.cursor;
		cursor.next();
		cursor.readWhile((character) => !isNewline(character) && character !== '"');
		if (cursor.peek() === '"') cursor.next();
	}

	/** Tokenized stops at `//`. */
	private skipDirectiveText(tokenized: boolean): void {
		const cursor = this.cursor;
		let guard = -1;
		while (cursor.good() && !isNewline(cursor.peek())) {
			if (cursor.offset <= guard) throw new Error("directive text reader failed to advance");
			guard = cursor.offset;
			if (tokenized && cursor.startsWith("//")) break;
			if (tokenized && cursor.peek() === '"') this.skipDirectiveString();
			else cursor.next();
		}
	}

	/** A condition's names and operators; anything else is an invalid name. */
	private readCondition(): ConditionToken[] {
		const cursor = this.cursor;
		const found: ConditionToken[] = [];
		while (cursor.good() && !isNewline(cursor.peek()) && !cursor.startsWith("//")) {
			const before = cursor.offset;
			const start = cursor.position;
			const push = (kind: ConditionToken["kind"], value: string) =>
				found.push({ kind, value, range: { start, end: cursor.position } });
			const character = cursor.peek();
			if (isWhitespace(character)) {
				cursor.next();
			} else if (cursor.take("/*")) {
				cursor.readWhile((item) => !isNewline(item) && !cursor.startsWith("//") && !cursor.startsWith("*/"));
				if (!cursor.take("*/")) push("operator", "/*");
			} else if (startsIdentifier(cursor)) {
				push("name", readIdentifier(cursor).value);
			} else if (character === '"') {
				this.skipDirectiveString();
				push("operator", '"');
			} else {
				const operator = CONDITION_OPERATORS.find((candidate) => cursor.startsWith(candidate)) ?? character;
				cursor.take(operator);
				push("operator", operator);
			}
			if (cursor.offset <= before) throw new Error("condition reader failed to advance");
		}
		return found;
	}
}

export function tokenize(
	text: string,
	options: { collectLiterals?: boolean; collectComments?: boolean; symbols?: readonly string[] } = {},
): LexedSource {
	return new CsharpLexer(
		text,
		options.collectLiterals ?? true,
		options.collectComments ?? true,
		options.symbols ?? [],
	).run();
}

export function positionRange(token: Token): Range {
	return { start: token.start, end: token.end };
}

export function pointRange(position: Position): Range {
	return { start: position, end: { line: position.line, character: position.character + 1 } };
}
