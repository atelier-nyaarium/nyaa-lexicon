import type { Diagnostic, Position, Range } from "@nyaa-lexicon/protocol";
import { Cursor, isDigit, isHexDigit, isIdentifierPart, isIdentifierStart, isWhitespace } from "./cursor.js";

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
}

/** Whether a code token shares a comment's first line before it and its last line after it. */
export interface CommentTrivia {
	codeBefore: boolean;
	codeAfter: boolean;
}

export interface LexedSource {
	tokens: Token[];
	literals: Token[];
	/** Every line and block comment token, in source order. A directive is not a comment. */
	comments: Token[];
	/** By comment token, interpolation holes included. */
	trivia: Map<Token, CommentTrivia>;
	/** Lines no token touches, dropped conditional branches included. */
	blankLines: number[];
	/** Kept tokens right after a dropped conditional branch holding more than line breaks. */
	droppedBefore: Set<Token>;
	diagnostics: Diagnostic[];
}

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

/** Take a pp expression. */
const CONDITION_DIRECTIVES = new Set(["if", "elif"]);

/** Longest first. */
const CONDITION_OPERATORS = ["&&", "||", "==", "!=", "!", "(", ")"] as const;

/** Deeper is unknown. */
const MAX_CONDITION_DEPTH = 64;

/** Escaped, since a raw zero-width character is forbidden in this repo's sources. */
const BYTE_ORDER_MARK = "\uFEFF";

const SIMPLE_ESCAPES: Record<string, string> = {
	"0": "\0",
	a: "\x07",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	'"': '"',
	"'": "'",
};

function rangeOf(start: Position, end: Position): Range {
	return { start, end };
}

function diagnostic(message: string, start: Position, end: Position): Diagnostic {
	return { severity: "error", message, range: rangeOf(start, end) };
}

function positionOf(mark: ReturnType<Cursor["mark"]>): Position {
	return { line: mark.line, character: mark.column };
}

function sameAscii(cursor: Cursor, value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		if (cursor.peek(index) !== value[index]) return false;
	}
	return true;
}

function consumeAscii(cursor: Cursor, value: string): void {
	for (let index = 0; index < value.length; index++) cursor.next();
}

/** Up to `limit` of `character`. */
function consumeRun(cursor: Cursor, character: string, limit: number): void {
	for (let count = 0; count < limit && cursor.peek() === character; count++) cursor.next();
}

/** Length of the run of `character` at the cursor. */
function runLength(cursor: Cursor, character: string): number {
	let length = 0;
	while (cursor.peek(length) === character) length++;
	return length;
}

function decodeEscape(cursor: Cursor): string {
	const slash = cursor.next();
	if (slash !== "\\") return slash;
	const escaped = cursor.next();
	if (escaped === "") return "\\";
	const simple = SIMPLE_ESCAPES[escaped];
	if (simple !== undefined) return simple;
	const digits = escaped === "u" ? 4 : escaped === "U" ? 8 : escaped === "x" ? 2 : 0;
	if (digits === 0) return escaped;
	let hex = "";
	let guard = -1;
	while (hex.length < digits && isHexDigit(cursor.peek())) {
		if (cursor.offset <= guard) throw new Error("escape reader failed to advance");
		guard = cursor.offset;
		hex += cursor.next();
	}
	if (hex.length !== digits) return `${escaped}${hex}`;
	const codePoint = Number.parseInt(hex, 16);
	return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : `${escaped}${hex}`;
}

/** The line holding its last character. */
export function lastLine(item: Token): number {
	return item.end.character === 0 && item.end.line > item.start.line ? item.end.line - 1 : item.end.line;
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

function readNumber(cursor: Cursor): string {
	let value = "";
	if (cursor.peek() === "0" && (cursor.peek(1) === "x" || cursor.peek(1) === "X")) {
		value += cursor.next();
		value += cursor.next();
		value += cursor.readWhile((character) => isHexDigit(character) || character === "_");
		return value + cursor.readWhile((character) => /[uUlL]$/u.test(character));
	}
	if (cursor.peek() === "0" && (cursor.peek(1) === "b" || cursor.peek(1) === "B")) {
		value += cursor.next();
		value += cursor.next();
		value += cursor.readWhile((character) => character === "0" || character === "1" || character === "_");
		return value + cursor.readWhile((character) => /[uUlL]$/u.test(character));
	}
	value += cursor.readWhile((character) => isDigit(character) || character === "_");
	if (cursor.peek() === "." && isDigit(cursor.peek(1))) {
		value += cursor.next();
		value += cursor.readWhile((character) => isDigit(character) || character === "_");
	}
	if (cursor.peek() === "e" || cursor.peek() === "E") {
		const mark = cursor.mark();
		let exponent = cursor.next();
		if (cursor.peek() === "+" || cursor.peek() === "-") exponent += cursor.next();
		const digits = cursor.readWhile((character) => isDigit(character) || character === "_");
		if (digits === "") cursor.rewind(mark);
		else exponent += digits;
		if (digits !== "") value += exponent;
	}
	return value + cursor.readWhile((character) => /[fFdDmMuUlL]$/u.test(character));
}

/**
 * A hole is code: it nests braces, holds strings of its own, and recognizes comments. A colon
 * outside its groups starts format text through the closing brace.
 *
 * Returns raw source with both braces because its rendered value is not
 * known here; the literal's decoded value carries the hole verbatim rather than dropping it.
 */
function skipInterpolationHole(
	cursor: Cursor,
	found: Token[],
	trivia: Map<Token, CommentTrivia>,
	braces: number,
): string {
	const holeStart = cursor.offset;
	const tracker = new TriviaTracker(trivia);
	let nested = 0;
	let grouped = 0;
	let format = false;
	tracker.code(cursor.line, cursor.line);
	consumeRun(cursor, "{", braces);
	while (cursor.good()) {
		const before = cursor.offset;
		const character = cursor.peek();
		if (character === "}" && nested === 0) {
			const line = cursor.line;
			consumeRun(cursor, "}", braces);
			tracker.code(line, line);
			break;
		}
		if (!format) {
			if (character === ":" && nested === 0 && grouped === 0) format = true;
			else if (character === "{") nested++;
			else if (character === "}") nested--;
			else if (character === "(" || character === "[") grouped++;
			else if ((character === ")" || character === "]") && grouped > 0) grouped--;
			if (sameAscii(cursor, "//")) {
				const start = cursor.mark();
				cursor.readWhile((item) => !isNewline(item));
				const comment = token(cursor, "comment", "", start);
				found.push(comment);
				tracker.comment(comment);
				continue;
			}
			if (sameAscii(cursor, "/*")) {
				const start = cursor.mark();
				consumeAscii(cursor, "/*");
				while (cursor.good() && !sameAscii(cursor, "*/")) cursor.next();
				if (sameAscii(cursor, "*/")) consumeAscii(cursor, "*/");
				const comment = token(cursor, "comment", "", start);
				found.push(comment);
				tracker.comment(comment);
				continue;
			}
			if (character === '"' || character === "'" || character === "$" || character === "@") {
				const line = cursor.line;
				const inner = readPrefixString(cursor, trivia);
				if (inner !== null) {
					found.push(...inner.holeComments);
					tracker.code(line, cursor.line);
					continue;
				}
			}
		}
		const line = cursor.line;
		const consumed = cursor.next();
		if (!isWhitespace(consumed) && !isNewline(consumed)) tracker.code(line, line);
		if (cursor.offset <= before) throw new Error("interpolation scan failed to advance");
	}
	return cursor.textBetween(holeStart, cursor.offset);
}

/** `dollars` is the `$` count; zero is not interpolated. */
function readString(
	cursor: Cursor,
	quote: '"' | "'",
	verbatim: boolean,
	rawString: boolean,
	dollars: number,
	trivia: Map<Token, CommentTrivia>,
): { value: string; closed: boolean; invalidNewline: boolean; holeComments: Token[] } {
	let value = "";
	let invalidNewline = false;
	const holeComments: Token[] = [];
	const interpolated = dollars > 0;
	if (rawString) {
		// Closes only on a run as long as the opener; a shorter run is content.
		let opener = 0;
		while (cursor.peek() === quote) {
			cursor.next();
			opener++;
		}
		while (cursor.good()) {
			if (interpolated && cursor.peek() === "{") {
				// A hole opens with the dollar count's last braces; fewer are text.
				const run = runLength(cursor, "{");
				const content = run < dollars ? run : run - dollars;
				value += "{".repeat(content);
				consumeRun(cursor, "{", content);
				if (run >= dollars) value += skipInterpolationHole(cursor, holeComments, trivia, dollars);
				continue;
			}
			if (cursor.peek() !== quote) {
				value += cursor.next();
				continue;
			}
			let run = 0;
			while (cursor.peek() === quote) {
				cursor.next();
				run++;
			}
			if (run < opener) {
				value += quote.repeat(run);
				continue;
			}
			value += quote.repeat(run - opener);
			return { value, closed: true, invalidNewline, holeComments };
		}
		return { value, closed: false, invalidNewline, holeComments };
	}
	if (cursor.peek() === quote) cursor.next();
	while (cursor.good()) {
		if (cursor.peek() === quote) {
			if (verbatim && cursor.peek(1) === quote) {
				cursor.next();
				cursor.next();
				value += quote;
				continue;
			}
			cursor.next();
			return { value, closed: true, invalidNewline, holeComments };
		}
		if (interpolated && cursor.peek() === "{") {
			if (cursor.peek(1) === "{") {
				cursor.next();
				cursor.next();
				value += "{";
				continue;
			}
			value += skipInterpolationHole(cursor, holeComments, trivia, 1);
			continue;
		}
		if (interpolated && cursor.peek() === "}" && cursor.peek(1) === "}") {
			cursor.next();
			cursor.next();
			value += "}";
			continue;
		}
		if (!verbatim && isNewline(cursor.peek())) invalidNewline = true;
		if (!verbatim && cursor.peek() === "\\") {
			value += decodeEscape(cursor);
			continue;
		}
		value += cursor.next();
	}
	return { value, closed: false, invalidNewline, holeComments };
}

function readPrefixString(
	cursor: Cursor,
	trivia: Map<Token, CommentTrivia>,
): {
	value: string;
	quote: '"' | "'";
	rawString: boolean;
	closed: boolean;
	invalidNewline: boolean;
	holeComments: Token[];
} | null {
	const start = cursor.mark();
	let verbatim = false;
	let dollars = 0;
	while (cursor.peek() === "$" || cursor.peek() === "@") {
		if (cursor.next() === "@") verbatim = true;
		else dollars++;
	}
	const quote = cursor.peek();
	if (quote !== '"' && quote !== "'") {
		cursor.rewind(start);
		return null;
	}
	const rawString = !verbatim && quote === '"' && cursor.peek(1) === '"' && cursor.peek(2) === '"';
	const string = readString(cursor, quote, verbatim, rawString, dollars, trivia);
	return { ...string, quote, rawString };
}

function token(cursor: Cursor, kind: TokenKind, value: string, start: ReturnType<Cursor["mark"]>): Token {
	const end = cursor.mark();
	return {
		kind,
		value,
		raw: cursor.textBetween(start.offset, end.offset),
		start: { line: start.line, character: start.column },
		end: { line: end.line, character: end.column },
		startOffset: start.offset,
		endOffset: end.offset,
	};
}

function isNewline(character: string): boolean {
	return character === "\r" || character === "\n";
}

function addLiteral(literals: Token[], item: Token): void {
	if (item.kind === "string" || item.kind === "number" || item.kind === "boolean") literals.push(item);
}

interface ConditionalBranch {
	start: number;
	end: number;
}

interface ConditionalGroup {
	ifIndex: number;
	branches: ConditionalBranch[];
	parent: ConditionalGroup | undefined;
	closed: boolean;
}

interface ConditionToken {
	kind: "name" | "operator";
	value: string;
}

/** To the quote or line end. */
function skipDirectiveString(cursor: Cursor): void {
	cursor.next();
	while (cursor.good() && !isNewline(cursor.peek()) && cursor.peek() !== '"') cursor.next();
	if (cursor.peek() === '"') cursor.next();
}

/** Tokenized stops at `//`. */
function skipDirectiveText(cursor: Cursor, tokenized: boolean): void {
	while (cursor.good() && !isNewline(cursor.peek())) {
		if (tokenized && sameAscii(cursor, "//")) break;
		if (tokenized && cursor.peek() === '"') skipDirectiveString(cursor);
		else cursor.next();
	}
}

/** Undefined on a non-pp token. */
function readCondition(cursor: Cursor): ConditionToken[] | undefined {
	const found: ConditionToken[] = [];
	let valid = true;
	while (cursor.good() && !isNewline(cursor.peek()) && !sameAscii(cursor, "//")) {
		const before = cursor.offset;
		const character = cursor.peek();
		if (isWhitespace(character)) {
			cursor.next();
		} else if (sameAscii(cursor, "/*")) {
			consumeAscii(cursor, "/*");
			while (cursor.good() && !isNewline(cursor.peek()) && !sameAscii(cursor, "//") && !sameAscii(cursor, "*/"))
				cursor.next();
			if (sameAscii(cursor, "*/")) consumeAscii(cursor, "*/");
			else valid = false;
		} else if (isIdentifierStart(character)) {
			found.push({ kind: "name", value: cursor.readWhile(isIdentifierPart) });
		} else if (character === '"') {
			skipDirectiveString(cursor);
			valid = false;
		} else {
			const operator = CONDITION_OPERATORS.find((candidate) => sameAscii(cursor, candidate));
			if (operator === undefined) {
				cursor.next();
				valid = false;
			} else {
				consumeAscii(cursor, operator);
				found.push({ kind: "operator", value: operator });
			}
		}
		if (cursor.offset <= before) throw new Error("condition reader failed to advance");
	}
	return valid ? found : undefined;
}

/** Symbols evaluate unknown. */
class ConditionEvaluator {
	private index = 0;
	private valid = true;

	constructor(private readonly items: ConditionToken[]) {}

	/** Undefined: unknown or invalid. */
	value(): boolean | undefined {
		const value = this.or(0);
		return this.valid && this.index === this.items.length ? value : undefined;
	}

	private or(depth: number): boolean | undefined {
		let value = this.and(depth);
		while (this.accept("||")) {
			const right = this.and(depth);
			value = value === true || right === true ? true : value === false && right === false ? false : undefined;
		}
		return value;
	}

	private and(depth: number): boolean | undefined {
		let value = this.equality(depth);
		while (this.accept("&&")) {
			const right = this.equality(depth);
			value = value === false || right === false ? false : value === true && right === true ? true : undefined;
		}
		return value;
	}

	private equality(depth: number): boolean | undefined {
		let value = this.unary(depth);
		for (;;) {
			const equal = this.accept("==") ? true : this.accept("!=") ? false : undefined;
			if (equal === undefined) return value;
			const right = this.unary(depth);
			value = value === undefined || right === undefined ? undefined : (value === right) === equal;
		}
	}

	private unary(depth: number): boolean | undefined {
		if (depth > MAX_CONDITION_DEPTH) {
			this.valid = false;
			return undefined;
		}
		if (this.accept("!")) {
			const operand = this.unary(depth + 1);
			return operand === undefined ? undefined : !operand;
		}
		if (this.accept("(")) {
			const inner = this.or(depth + 1);
			if (!this.accept(")")) this.valid = false;
			return inner;
		}
		const item = this.items[this.index];
		if (item?.kind !== "name") {
			this.valid = false;
			return undefined;
		}
		this.index++;
		return item.value === "true" ? true : item.value === "false" ? false : undefined;
	}

	private accept(operator: string): boolean {
		const item = this.items[this.index];
		if (item?.kind !== "operator" || item.value !== operator) return false;
		this.index++;
		return true;
	}
}

function branchIsWhole(
	tokens: Token[],
	branch: ConditionalBranch,
	directiveTokens: Set<number>,
	removed: Set<number>,
): boolean {
	const expected: string[] = [];
	const closing = new Map([
		[")", "("],
		["]", "["],
		["}", "{"],
	]);
	for (let index = branch.start; index < branch.end; index++) {
		if (directiveTokens.has(index) || removed.has(index)) continue;
		const token = tokens[index];
		if (token?.kind !== "punctuation") continue;
		if (token.value === "(" || token.value === "[" || token.value === "{") {
			expected.push(token.value);
			continue;
		}
		const opener = closing.get(token.value);
		if (opener === undefined) continue;
		if (expected.pop() !== opener) return false;
	}
	return expected.length === 0;
}

function closedThroughout(group: ConditionalGroup): boolean {
	for (let current: ConditionalGroup | undefined = group; current !== undefined; current = current.parent) {
		if (!current.closed) return false;
	}
	return true;
}

/** Every main-stream comment's trivia; a directive is code. */
function trackTrivia(tokens: Token[], trivia: Map<Token, CommentTrivia>): void {
	const tracker = new TriviaTracker(trivia);
	for (const item of tokens) {
		if (item.kind === "newline" || item.kind === "eof") continue;
		if (item.kind === "comment" || item.kind === "doc") tracker.comment(item);
		else tracker.code(item.start.line, lastLine(item));
	}
}

/** The empty remainder after a final line break is not a line. */
function blankLinesOf(tokens: Token[], end: Token): number[] {
	const touched = new Set<number>();
	for (const item of tokens) {
		if (item.kind === "newline" || item.kind === "eof") continue;
		for (let line = item.start.line; line <= lastLine(item); line++) touched.add(line);
	}
	const count = end.start.line + (end.start.character > 0 ? 1 : 0);
	const blank: number[] = [];
	for (let line = 0; line < count; line++) if (!touched.has(line)) blank.push(line);
	return blank;
}

function resolveConditionals(
	tokens: Token[],
	literals: Token[],
	comments: Token[],
	diagnostics: Diagnostic[],
	falseConditions: Set<Token>,
): Omit<LexedSource, "trivia" | "blankLines"> {
	const directiveIndexes = tokens.flatMap((token, index) => (token.kind === "directive" ? [index] : []));
	const directiveTokens = new Set(directiveIndexes);
	const protectedTokens = new Set<number>();
	const groups: ConditionalGroup[] = [];
	const stack: ConditionalGroup[] = [];
	for (const index of directiveIndexes) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token.value === "if") {
			const group: ConditionalGroup = {
				ifIndex: index,
				branches: [{ start: index + 1, end: tokens.length }],
				parent: stack.at(-1),
				closed: false,
			};
			groups.push(group);
			stack.push(group);
			continue;
		}
		if (token.value === "elif" || token.value === "else") {
			const group = stack.at(-1);
			if (group === undefined) {
				diagnostics.push({
					severity: "error",
					message: `Unexpected #${token.value} outside a conditional.`,
					range: positionRange(token),
				});
				continue;
			}
			group.branches.at(-1)!.end = index;
			group.branches.push({ start: index + 1, end: tokens.length });
			continue;
		}
		if (token.value === "endif") {
			const group = stack.pop();
			if (group === undefined) {
				diagnostics.push({
					severity: "error",
					message: "Unexpected #endif outside a conditional.",
					range: positionRange(token),
				});
				continue;
			}
			group.branches.at(-1)!.end = index;
			group.closed = true;
		}
	}
	for (const group of stack) {
		const token = tokens[group.ifIndex];
		if (token === undefined) continue;
		diagnostics.push({
			severity: "error",
			message: "Conditional directive is not closed.",
			range: positionRange(token),
		});
	}
	for (const index of directiveIndexes) {
		const token = tokens[index];
		if (token !== undefined && ["if", "elif", "else", "endif"].includes(token.value)) protectedTokens.add(index);
	}
	const removed = new Set<number>();
	for (const group of groups.toReversed()) {
		if (!closedThroughout(group)) continue;
		const first = tokens[group.ifIndex];
		if (first === undefined) continue;
		const activeBranch = falseConditions.has(first) ? 1 : 0;
		const allWhole = group.branches.every((branch) => branchIsWhole(tokens, branch, directiveTokens, removed));
		for (let branchIndex = 0; branchIndex < group.branches.length; branchIndex++) {
			if ((allWhole && !(activeBranch === 1 && branchIndex === 0)) || (!allWhole && branchIndex === activeBranch))
				continue;
			const branch = group.branches[branchIndex];
			if (branch === undefined) continue;
			for (let index = branch.start; index < branch.end; index++) {
				if (!protectedTokens.has(index)) removed.add(index);
			}
		}
	}
	const removedOffsets = new Set<number>();
	const droppedBefore = new Set<Token>();
	let droppedCode = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as Token;
		if (removed.has(index)) {
			removedOffsets.add(token.startOffset);
			droppedCode ||= token.kind !== "newline";
			continue;
		}
		if (droppedCode) droppedBefore.add(token);
		droppedCode = false;
	}
	return {
		tokens: tokens.filter((_token, index) => !removed.has(index)),
		literals: literals.filter((item) => !removedOffsets.has(item.startOffset)),
		comments: keptComments(comments, tokens, removed),
		droppedBefore,
		diagnostics,
	};
}

/** Drops a comment inside a dropped token too, as a hole's comment is inside its string. */
function keptComments(comments: Token[], tokens: Token[], removed: Set<number>): Token[] {
	const spans = [...removed].sort((left, right) => left - right).map((index) => tokens[index] as Token);
	const kept: Token[] = [];
	let span = 0;
	for (const item of comments) {
		while (span < spans.length && (spans[span] as Token).endOffset <= item.startOffset) span++;
		const covering = spans[span];
		if (covering === undefined || covering.startOffset > item.startOffset) kept.push(item);
	}
	return kept;
}

export function tokenize(
	text: string,
	options: { collectLiterals?: boolean; collectComments?: boolean } = {},
): LexedSource {
	const cursor = new Cursor(text);
	const tokens: Token[] = [];
	const literals: Token[] = [];
	const comments: Token[] = [];
	const diagnostics: Diagnostic[] = [];
	const falseConditions = new Set<Token>();
	const trivia = new Map<Token, CommentTrivia>();
	const collectLiterals = options.collectLiterals ?? true;
	const collectComments = options.collectComments ?? true;
	const addComment = (item: Token): void => {
		tokens.push(item);
		if (collectComments) comments.push(item);
	};
	while (cursor.good()) {
		const before = cursor.offset;
		const character = cursor.peek();
		if (before === 0 && character === BYTE_ORDER_MARK) {
			// A leading byte order mark is not source text; drop it like whitespace.
			cursor.next();
		} else if (isWhitespace(character)) {
			cursor.next();
		} else if (isNewline(character)) {
			const start = cursor.mark();
			cursor.next();
			if (character === "\r" && cursor.peek() === "\n") cursor.next();
			tokens.push(token(cursor, "newline", "\n", start));
		} else if (sameAscii(cursor, "//")) {
			const start = cursor.mark();
			cursor.next();
			cursor.next();
			if (cursor.peek() === "/") {
				cursor.next();
				if (cursor.peek() === " ") cursor.next();
				const value = cursor.readWhile((item) => !isNewline(item));
				addComment(token(cursor, "doc", value, start));
			} else {
				cursor.readWhile((item) => !isNewline(item));
				addComment(token(cursor, "comment", "", start));
			}
		} else if (sameAscii(cursor, "/*")) {
			const start = cursor.mark();
			cursor.next();
			cursor.next();
			let closed = false;
			while (cursor.good()) {
				if (sameAscii(cursor, "*/")) {
					cursor.next();
					cursor.next();
					closed = true;
					break;
				}
				cursor.next();
			}
			if (!closed)
				diagnostics.push(
					diagnostic("Block comment has no closing delimiter.", positionOf(start), positionOf(cursor.mark())),
				);
			addComment(token(cursor, "comment", "", start));
		} else if (character === "#") {
			const start = cursor.mark();
			cursor.next();
			cursor.readWhile(isWhitespace);
			const keyword = cursor.readWhile(isIdentifierPart);
			let value: boolean | undefined;
			if (CONDITION_DIRECTIVES.has(keyword)) {
				const condition = readCondition(cursor);
				value = condition === undefined ? undefined : new ConditionEvaluator(condition).value();
			} else {
				skipDirectiveText(cursor, TOKENIZED_DIRECTIVES.has(keyword));
			}
			const directive = token(cursor, "directive", keyword, start);
			tokens.push(directive);
			if (keyword === "if" && value === false) falseConditions.add(directive);
			if (sameAscii(cursor, "//")) {
				const commentStart = cursor.mark();
				cursor.readWhile((item) => !isNewline(item));
				addComment(token(cursor, "comment", "", commentStart));
			}
		} else if (character === "@" && isIdentifierStart(cursor.peek(1))) {
			const start = cursor.mark();
			cursor.next();
			const value = cursor.readWhile(isIdentifierPart);
			tokens.push(token(cursor, "identifier", value, start));
		} else if (character === '"' || character === "'" || character === "$" || character === "@") {
			const start = cursor.mark();
			const parsed = readPrefixString(cursor, trivia);
			if (parsed === null) {
				cursor.next();
				tokens.push(token(cursor, "punctuation", character, start));
			} else {
				const item = token(cursor, parsed.quote === '"' ? "string" : "character", parsed.value, start);
				tokens.push(item);
				if (!parsed.closed) {
					diagnostics.push(diagnostic("String literal has no closing quote.", item.start, item.end));
				}
				if (parsed.invalidNewline)
					diagnostics.push(diagnostic("String literal cannot contain a newline.", item.start, item.end));
				if (collectLiterals) addLiteral(literals, item);
				// Comments only: the string is one token, so these must not split its span.
				if (collectComments) comments.push(...parsed.holeComments);
			}
		} else if (isDigit(character)) {
			const start = cursor.mark();
			const value = readNumber(cursor);
			const item = token(cursor, "number", value, start);
			tokens.push(item);
			if (collectLiterals) addLiteral(literals, item);
		} else if (isIdentifierStart(character)) {
			const start = cursor.mark();
			const value = cursor.readWhile(isIdentifierPart);
			const kind: TokenKind = value === "true" || value === "false" ? "boolean" : "identifier";
			const item = token(cursor, kind, value, start);
			tokens.push(item);
			if (collectLiterals) addLiteral(literals, item);
		} else {
			const start = cursor.mark();
			const operator = OPERATORS.find((candidate) => sameAscii(cursor, candidate));
			if (operator === undefined) {
				cursor.next();
				tokens.push(token(cursor, "punctuation", character, start));
			} else {
				consumeAscii(cursor, operator);
				tokens.push(token(cursor, "punctuation", operator, start));
			}
		}
		if (cursor.offset <= before) throw new Error("tokenizer failed to advance");
	}
	const end = token(cursor, "eof", "", cursor.mark());
	tokens.push(end);
	trackTrivia(tokens, trivia);
	const blankLines = blankLinesOf(tokens, end);
	return { ...resolveConditionals(tokens, literals, comments, diagnostics, falseConditions), trivia, blankLines };
}

export function positionRange(token: Token): Range {
	return { start: token.start, end: token.end };
}

export function pointRange(position: Position): Range {
	return { start: position, end: { line: position.line, character: position.character + 1 } };
}
