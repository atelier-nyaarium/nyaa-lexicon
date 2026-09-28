import {
	type CursorMark,
	type Diagnostic,
	defined,
	type OffsetRange,
	type Position,
	type Range,
	SourceCursor,
} from "@nyaa-lexicon/protocol";
import {
	isDigit,
	isExponent,
	isHorizontalSpace,
	isIdentifierPart,
	isIdentifierStart,
	isNumberPart,
	isSign,
} from "./characters.js";

export type TokenKind = "identifier" | "number" | "string" | "character" | "comment" | "newline" | "punctuation";

export interface Token {
	kind: TokenKind;
	text: string;
	value: string;
	start: Position;
	end: Position;
	startOffset: number;
	endOffset: number;
	/** Whether code precedes the comment on its first line. */
	codeBefore?: boolean;
	/** Whether code follows the comment on its last line. */
	codeAfter?: boolean;
	/** Whether a splice or a removed branch sits between the previous kept token and this one. */
	hiddenBefore?: boolean;
	/** Backslash-newlines inside the token, which its `text` leaves out. */
	splices?: OffsetRange[];
	/** On a preprocessing directive's line, so no bracket or statement of the code around it. */
	directive?: boolean;
	/** The innermost kept alternative around it; each links the one around it. */
	alternative?: Alternative;
}

/** One branch of an `#if` group whose branches are all kept; its declarations exclude the others'. */
export interface Alternative {
	group: number;
	branch: number;
	outer?: Alternative;
}

/** The branch `left` takes of a group where `right` takes another; undefined when the chains agree. */
export function divergence(left: Alternative | undefined, right: Alternative | undefined): Alternative | undefined {
	const taken = new Map<number, number>();
	for (let current = right; current !== undefined; current = current.outer) taken.set(current.group, current.branch);
	for (let current = left; current !== undefined; current = current.outer) {
		const branch = taken.get(current.group);
		if (branch !== undefined && branch !== current.branch) return current;
	}
	return undefined;
}

/** Whether two chains of alternatives take different branches of one group, so never both hold. */
export function exclusive(left: Alternative | undefined, right: Alternative | undefined): boolean {
	return divergence(left, right) !== undefined;
}

/** Whether a chain of alternatives lies inside some branch of `group`. */
export function withinGroup(chain: Alternative | undefined, group: number): boolean {
	for (let current = chain; current !== undefined; current = current.outer) if (current.group === group) return true;
	return false;
}

/** A token's characters read so far, splices left out, and where each splice was. */
interface Spelling {
	text: string;
	splices: OffsetRange[];
}

export interface TokenizedSource {
	tokens: Token[];
	/** Lines no token or splice touches, an inactive branch's tokens included. */
	blankLines: number[];
	diagnostics: Diagnostic[];
}

interface ConditionalDirective {
	start: number;
	end: number;
	keyword: string;
	keywordIndex: number;
}

interface ConditionalBranch {
	start: number;
	end: number;
}

interface AlternativeSpan extends ConditionalBranch {
	group: number;
	branch: number;
}

interface ConditionalGroup {
	ifIndex: number;
	branches: ConditionalBranch[];
	parent: ConditionalGroup | undefined;
	closed: boolean;
	/** Past its `#endif` line. */
	end: number;
	/** The brackets its kept branches leave unmatched, once resolved. */
	kept?: string[];
}

const OPERATORS = [
	">>>=",
	"<=>",
	"...",
	"->*",
	"<<=",
	">>=",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"++",
	"--",
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
	"->",
	"::",
	".*",
	"##",
];

const OPERATOR_STARTS: ReadonlySet<string> = new Set(OPERATORS.map((operator) => operator[0] as string));

const STRING_PREFIXES = ["u8R", "u8", "uR", "UR", "LR", "R", "u", "U", "L"];

const PREFIX_STARTS: ReadonlySet<string> = new Set(STRING_PREFIXES.map((prefix) => prefix[0] as string));

/** Each closing bracket's opener. */
const CLOSING: ReadonlyMap<string, string> = new Map([
	[")", "("],
	["]", "["],
	["}", "{"],
]);

const BRACKETS: ReadonlySet<string> = new Set(["(", "[", "{", ")", "]", "}"]);

/** Not code, so a comment after it has none before it. */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

function pointRange(start: Position, end: Position): Range {
	return { start, end };
}

function diagnostic(message: string, start: Position, end: Position): Diagnostic {
	return { severity: "error", message, range: pointRange(start, end) };
}

/** A literal's encoding prefix and the quote after it, read through splices. */
function prefixAt(cursor: SourceCursor): { prefix: string; quote: string } | null {
	const first = cursor.peek();
	if (!PREFIX_STARTS.has(first) && first !== '"' && first !== "'") return null;
	const ahead = spelledAhead(cursor, 4);
	for (const prefix of ["", ...STRING_PREFIXES]) {
		const quote = ahead[prefix.length] ?? "";
		if (ahead.startsWith(prefix) && (quote === '"' || quote === "'")) return { prefix, quote };
	}
	return null;
}

function decodeString(value: string): string {
	let decoded = "";
	let escaped = false;
	for (const character of value) {
		if (!escaped) {
			if (character === "\\") {
				escaped = true;
			} else {
				decoded += character;
			}
			continue;
		}
		const replacements: Record<string, string> = {
			"0": "\0",
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
		decoded += replacements[character] ?? character;
		escaped = false;
	}
	if (escaped) decoded += "\\";
	return decoded;
}

/** A CRLF carriage return ends the line, so it is not comment text. */
function endsLine(cursor: SourceCursor): boolean {
	return cursor.peek() === "\n" || (cursor.peek() === "\r" && cursor.peek(1) === "\n");
}

/** Backslash-newline, deleted before tokenizing. */
function continuesLine(cursor: SourceCursor): boolean {
	if (cursor.peek() !== "\\") return false;
	return cursor.peek(1) === "\n" || (cursor.peek(1) === "\r" && cursor.peek(2) === "\n");
}

/** Past the backslash-newline `continuesLine` saw. */
function takeSplice(cursor: SourceCursor): void {
	cursor.next();
	if (cursor.peek() === "\r") cursor.next();
	cursor.next();
}

/** Past a splice the token goes on after, into `spelling`; false and unmoved otherwise. */
function spliceInto(cursor: SourceCursor, spelling: Spelling, continues: (character: string) => boolean): boolean {
	if (!continuesLine(cursor)) return false;
	const splice = cursor.mark();
	takeSplice(cursor);
	if (continues(cursor.peek())) {
		spelling.splices.push({ start: splice.offset, end: cursor.offset });
		return true;
	}
	cursor.rewind(splice);
	return false;
}

/** Characters while `part` holds, through splices. */
function readSpelled(cursor: SourceCursor, spelling: Spelling, part: (character: string) => boolean): void {
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("token scan failed to advance");
		guard = cursor.offset;
		if (spliceInto(cursor, spelling, part)) continue;
		if (!part(cursor.peek())) return;
		spelling.text += cursor.next();
	}
}

/** Past any splices at the cursor, each recorded. */
function takeSplices(cursor: SourceCursor, splices: OffsetRange[]): void {
	while (continuesLine(cursor)) {
		const at = cursor.offset;
		takeSplice(cursor);
		splices.push({ start: at, end: cursor.offset });
	}
}

/** Past `text`, which `spelledAhead` saw, and the splices inside it. */
function takeSpelled(cursor: SourceCursor, text: string, splices: OffsetRange[]): void {
	for (const expected of text) {
		takeSplices(cursor, splices);
		if (cursor.peek() !== expected) return;
		cursor.next();
	}
}

/** Up to the next `count` characters, splices left out. */
function spelledAhead(cursor: SourceCursor, count: number): string {
	let text = "";
	let at = 0;
	let guard = -1;
	while (text.length < count) {
		if (at <= guard) throw new Error("spelling scan failed to advance");
		guard = at;
		const character = cursor.peek(at);
		if (character === "") break;
		const newline =
			cursor.peek(at + 1) === "\n" ? 2 : cursor.peek(at + 1) === "\r" && cursor.peek(at + 2) === "\n" ? 3 : 0;
		if (character === "\\" && newline > 0) {
			at += newline;
			continue;
		}
		text += character;
		at += character.length;
	}
	return text;
}

function readLineComment(cursor: SourceCursor): void {
	cursor.take("//");
	let guard = -1;
	while (cursor.good() && !endsLine(cursor)) {
		if (cursor.offset <= guard) throw new Error("line comment scan failed to advance");
		guard = cursor.offset;
		if (continuesLine(cursor)) takeSplice(cursor);
		else cursor.next();
	}
}

/** Whether the comment closes. */
function readBlockComment(cursor: SourceCursor): boolean {
	cursor.take("/*");
	let guard = -1;
	while (cursor.good() && !cursor.startsWith("*/")) {
		if (cursor.offset <= guard) throw new Error("block comment scan failed to advance");
		guard = cursor.offset;
		cursor.next();
	}
	return cursor.take("*/");
}

function readRawString(
	cursor: SourceCursor,
	prefix: string,
	splices: OffsetRange[],
): { value: string; closed: boolean } {
	takeSpelled(cursor, `${prefix}"`, splices);
	const delimiterFrom = cursor.mark();
	let delimiterGuard = -1;
	while (cursor.good() && cursor.peek() !== "(") {
		if (cursor.offset <= delimiterGuard) throw new Error("raw string delimiter scan failed to advance");
		delimiterGuard = cursor.offset;
		cursor.next();
		if (cursor.offset - delimiterFrom.offset > 16) return { value: cursor.textSince(delimiterFrom), closed: false };
	}
	const delimiter = cursor.textSince(delimiterFrom);
	if (cursor.peek() !== "(") return { value: delimiter, closed: false };
	cursor.next();
	const contentFrom = cursor.mark();
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("raw string scan failed to advance");
		guard = cursor.offset;
		if (cursor.peek() === ")") {
			const close = cursor.mark();
			cursor.next();
			if (cursor.take(delimiter) && cursor.peek() === '"') {
				const value = cursor.textOf(contentFrom.offset, close.offset);
				cursor.next();
				return { value, closed: true };
			}
			cursor.rewind(close);
		}
		cursor.next();
	}
	return { value: cursor.textSince(contentFrom), closed: false };
}

function readQuoted(
	cursor: SourceCursor,
	prefix: string,
	quote: string,
	splices: OffsetRange[],
): { value: string; closed: boolean } {
	takeSpelled(cursor, `${prefix}${quote}`, splices);
	let value = "";
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("quoted literal scan failed to advance");
		guard = cursor.offset;
		if (cursor.peek() === quote) {
			cursor.next();
			return { value: decodeString(value), closed: true };
		}
		if (cursor.peek() === "\n") return { value: decodeString(value), closed: false };
		if (continuesLine(cursor)) {
			takeSplices(cursor, splices);
			continue;
		}
		const character = cursor.next();
		if (character !== "\\") {
			value += character;
			continue;
		}
		// Splices go before escapes: `\\` then a line break escapes what follows the break.
		takeSplices(cursor, splices);
		if (cursor.good()) value += character + cursor.next();
	}
	return { value: decodeString(value), closed: false };
}

/** A pp-number: digits, name characters, separators, periods, and a sign after an exponent letter. */
function readNumber(cursor: SourceCursor, spelling: Spelling): void {
	if (cursor.peek() === ".") spelling.text += cursor.next();
	readSpelled(
		cursor,
		spelling,
		(character) => isNumberPart(character) || (isSign(character) && isExponent(spelling.text.at(-1) ?? "")),
	);
}

function longestOperator(cursor: SourceCursor): string | null {
	if (!OPERATOR_STARTS.has(cursor.peek())) return null;
	const next = spelledAhead(cursor, 4);
	for (const operator of OPERATORS) if (next.startsWith(operator)) return operator;
	return null;
}

/** The characters of `operator`, which `longestOperator` saw ahead, through splices. */
function readOperator(cursor: SourceCursor, spelling: Spelling, operator: string): void {
	for (const expected of operator) {
		spliceInto(cursor, spelling, (character) => character === expected);
		spelling.text += cursor.next();
	}
}

/** A token's last line; one ending at a line's start ends on the line before. */
function lastLine(token: Token): number {
	return token.end.character === 0 && token.end.line > token.start.line ? token.end.line - 1 : token.end.line;
}

/** Whether code shares a comment's first line before it or last line after it. */
function markTrivia(tokens: readonly Token[]): void {
	let previous: Token | undefined;
	const waiting: Token[] = [];
	for (const token of tokens) {
		if (token.kind === "newline") continue;
		if (token.kind === "comment") {
			token.codeBefore = previous !== undefined && lastLine(previous) === token.start.line;
			token.codeAfter = false;
			waiting.push(token);
			continue;
		}
		for (const comment of waiting) comment.codeAfter = lastLine(comment) === token.start.line;
		waiting.length = 0;
		previous = token;
	}
}

/** Lines of `lineCount` that no token touches and no splice ends. */
function blankLinesOf(tokens: readonly Token[], spliced: readonly number[], lineCount: number): number[] {
	const touched = new Array<boolean>(lineCount).fill(false);
	for (const line of spliced) touched[line] = true;
	for (const token of tokens) {
		if (token.kind === "newline") continue;
		for (let line = token.start.line; line <= lastLine(token); line++) touched[line] = true;
	}
	const blank: number[] = [];
	for (let line = 0; line < lineCount; line++) if (touched[line] !== true) blank.push(line);
	return blank;
}

export function tokenize(text: string, module?: string): TokenizedSource {
	const cursor = new SourceCursor(text);
	const tokens: Token[] = [];
	const spliced: number[] = [];
	const diagnostics: Diagnostic[] = [];
	let splicedBefore = false;
	const emit = (kind: TokenKind, from: CursorMark, value?: string, spelling?: Spelling) => {
		const span = cursor.span(from);
		const text = spelling?.text ?? cursor.textSince(from);
		const token: Token = {
			kind,
			text,
			value: value ?? text,
			start: span.start,
			end: span.end,
			startOffset: span.startOffset,
			endOffset: span.endOffset,
		};
		if (splicedBefore) token.hiddenBefore = true;
		if (spelling !== undefined && spelling.splices.length > 0) token.splices = spelling.splices;
		splicedBefore = false;
		tokens.push(token);
	};
	const spell = (): Spelling => ({ text: "", splices: [] });
	const unterminated = (message: string, from: CursorMark) =>
		diagnostics.push(diagnostic(message, cursor.span(from).start, cursor.position));
	if (cursor.peek() === BYTE_ORDER_MARK) cursor.next();
	while (cursor.good()) {
		const from = cursor.mark();
		const character = cursor.peek();
		if (continuesLine(cursor)) {
			spliced.push(from.line);
			takeSplice(cursor);
			splicedBefore = true;
		} else if (character === "\n") {
			cursor.next();
			emit("newline", from);
		} else if (isHorizontalSpace(character)) {
			cursor.readWhile(isHorizontalSpace);
		} else if (cursor.startsWith("//")) {
			readLineComment(cursor);
			emit("comment", from);
		} else if (cursor.startsWith("/*")) {
			const closed = readBlockComment(cursor);
			emit("comment", from);
			if (!closed) unterminated("Unterminated block comment.", from);
		} else {
			const literal = prefixAt(cursor);
			if (literal !== null) {
				const { prefix, quote } = literal;
				const splices: OffsetRange[] = [];
				const raw = prefix.endsWith("R") && quote === '"';
				const result = raw
					? readRawString(cursor, prefix, splices)
					: readQuoted(cursor, prefix, quote, splices);
				const text = cursor.textSince(from);
				emit(quote === "'" ? "character" : "string", from, result.value, { text, splices });
				if (!result.closed)
					unterminated(raw ? "Unterminated raw string literal." : "Unterminated string literal.", from);
			} else if (isIdentifierStart(character)) {
				const spelling = spell();
				readSpelled(cursor, spelling, isIdentifierPart);
				emit("identifier", from, undefined, spelling);
			} else if (isDigit(character) || (character === "." && isDigit(spelledAhead(cursor, 2)[1] ?? ""))) {
				const spelling = spell();
				readNumber(cursor, spelling);
				emit("number", from, undefined, spelling);
			} else {
				const spelling = spell();
				const operator = longestOperator(cursor);
				if (operator === null) spelling.text += cursor.next();
				else readOperator(cursor, spelling, operator);
				emit("punctuation", from, undefined, spelling);
			}
		}
		if (cursor.offset <= from.offset) throw new Error("tokenizer failed to advance");
	}
	markTrivia(tokens);
	const blankLines = blankLinesOf(tokens, spliced, cursor.line + (cursor.column > 0 ? 1 : 0));
	const resolved = resolveConditionals(tokens, diagnostics);
	if (module !== undefined) {
		for (const item of diagnostics) item.path = module;
	}
	return { tokens: resolved, blankLines, diagnostics };
}

function directiveEnd(tokens: Token[], start: number): number {
	let index = start + 1;
	while (index < tokens.length) {
		if (tokens[index]?.kind !== "newline") {
			index++;
			continue;
		}
		return index;
	}
	return tokens.length;
}

function directivesIn(tokens: Token[]): ConditionalDirective[] {
	const directives: ConditionalDirective[] = [];
	let lineStart = true;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as Token;
		if (token.kind === "newline") {
			lineStart = true;
			continue;
		}
		if (token.kind === "comment") continue;
		if (lineStart && token.text === "#") {
			const end = directiveEnd(tokens, index);
			let keywordIndex = index + 1;
			while (
				keywordIndex < end &&
				(tokens[keywordIndex]?.kind === "comment" || tokens[keywordIndex]?.kind === "newline")
			)
				keywordIndex++;
			const keyword = tokens[keywordIndex]?.value;
			if (keyword !== undefined) directives.push({ start: index, end, keyword, keywordIndex });
			index = Math.max(index, end - 1);
			lineStart = true;
			continue;
		}
		lineStart = false;
	}
	return directives;
}

/** Every token on a preprocessing directive line. */
export function directiveTokenIndexes(tokens: Token[]): Set<number> {
	const indexes = new Set<number>();
	for (const directive of directivesIn(tokens)) {
		for (let index = directive.start; index < directive.end; index++) indexes.add(index);
	}
	return indexes;
}

function firstConditionIsZero(tokens: Token[], directive: ConditionalDirective): boolean {
	let next = directive.keywordIndex + 1;
	while (next < directive.end && (tokens[next]?.kind === "comment" || tokens[next]?.kind === "newline")) next++;
	if (next >= directive.end || tokens[next]?.kind !== "number" || tokens[next]?.value !== "0") return false;
	next++;
	while (next < directive.end && (tokens[next]?.kind === "comment" || tokens[next]?.kind === "newline")) next++;
	return next >= directive.end;
}

/** Adds a bracket to a run, cancelling it against the opener it closes; a balanced run is empty. */
function extendRun(run: string[], bracket: string): void {
	const opener = CLOSING.get(bracket);
	if (opener !== undefined && run.at(-1) === opener) run.pop();
	else run.push(bracket);
}

/**
 * The brackets a branch leaves unmatched. A nested group, already resolved, adds what its kept
 * branches leave, so no token is read twice.
 */
function bracketRun(
	tokens: Token[],
	branch: ConditionalBranch,
	directiveTokens: Set<number>,
	groupAt: ReadonlyMap<number, ConditionalGroup>,
): string[] {
	const run: string[] = [];
	for (let index = branch.start; index < branch.end; index++) {
		const inner = groupAt.get(index);
		if (inner?.kept !== undefined) {
			for (const bracket of inner.kept) extendRun(run, bracket);
			index = inner.end - 1;
			continue;
		}
		if (directiveTokens.has(index)) continue;
		// A string or comment spelling a bracket is content, not a delimiter.
		const token = tokens[index];
		const value = token?.kind === "punctuation" ? token.value : "";
		if (BRACKETS.has(value)) extendRun(run, value);
	}
	return run;
}

function resolveConditionals(tokens: Token[], diagnostics: Diagnostic[]): Token[] {
	const directives = directivesIn(tokens);
	const directiveByIndex = new Map(directives.map((directive) => [directive.start, directive]));
	const directiveTokens = new Set<number>();
	const protectedTokens = new Set<number>();
	for (const directive of directives) {
		for (let index = directive.start; index < directive.end; index++) directiveTokens.add(index);
		if (!["if", "ifdef", "ifndef", "elif", "else", "endif"].includes(directive.keyword)) continue;
		for (let index = directive.start; index < directive.end; index++) protectedTokens.add(index);
	}
	const groups: ConditionalGroup[] = [];
	const stack: ConditionalGroup[] = [];
	for (const directive of directives) {
		if (["if", "ifdef", "ifndef"].includes(directive.keyword)) {
			const group: ConditionalGroup = {
				ifIndex: directive.start,
				branches: [{ start: directive.end, end: tokens.length }],
				parent: stack.at(-1),
				closed: false,
				end: tokens.length,
			};
			groups.push(group);
			stack.push(group);
			continue;
		}
		if (["elif", "else"].includes(directive.keyword)) {
			const group = stack.at(-1);
			if (group === undefined) {
				diagnostics.push({
					severity: "error",
					message: `Unexpected #${directive.keyword} outside a conditional.`,
					range: rangeOfToken(tokens[directive.start] as Token),
				});
				continue;
			}
			(group.branches.at(-1) as ConditionalBranch).end = directive.start;
			group.branches.push({ start: directive.end, end: tokens.length });
			continue;
		}
		if (directive.keyword === "endif") {
			const group = stack.pop();
			if (group === undefined) {
				diagnostics.push({
					severity: "error",
					message: "Unexpected #endif outside a conditional.",
					range: rangeOfToken(tokens[directive.start] as Token),
				});
				continue;
			}
			(group.branches.at(-1) as ConditionalBranch).end = directive.start;
			group.closed = true;
			group.end = directive.end;
		}
	}
	for (const group of stack) {
		diagnostics.push({
			severity: "error",
			message: "Conditional directive is not closed.",
			range: rangeOfToken(tokens[group.ifIndex] as Token),
		});
	}
	// Innermost groups first, so each branch reads a nested group through its summary.
	const groupAt = new Map<number, ConditionalGroup>();
	const removedSpans: ConditionalBranch[] = [];
	const alternativeSpans: AlternativeSpan[] = [];
	// An unclosed group anywhere above leaves a group's branches as they are.
	const closedThroughout = new Set<ConditionalGroup>();
	for (const group of groups)
		if (group.closed && (group.parent === undefined || closedThroughout.has(group.parent)))
			closedThroughout.add(group);
	for (const group of groups.toReversed()) {
		groupAt.set(group.ifIndex, group);
		if (!closedThroughout.has(group)) continue;
		const directive = directiveByIndex.get(group.ifIndex) as ConditionalDirective;
		const activeBranch = firstConditionIsZero(tokens, directive) ? 1 : 0;
		const runs = group.branches.map((branch) => bracketRun(tokens, branch, directiveTokens, groupAt));
		const allWhole = runs.every((run) => run.length === 0);
		const kept: string[] = [];
		const keptBranches: number[] = [];
		for (const [branch, segment] of group.branches.entries()) {
			const keep = allWhole ? !(activeBranch === 1 && branch === 0) : branch === activeBranch;
			if (!keep) {
				removedSpans.push(segment);
				continue;
			}
			keptBranches.push(branch);
			for (const bracket of runs[branch] ?? []) extendRun(kept, bracket);
		}
		group.kept = kept;
		if (keptBranches.length < 2) continue;
		for (const branch of keptBranches)
			alternativeSpans.push({ ...(group.branches[branch] as ConditionalBranch), group: group.ifIndex, branch });
	}
	for (const index of directiveTokens) (tokens[index] as Token).directive = true;
	const removed = spanned(tokens.length, removedSpans);
	markAlternatives(tokens, alternativeSpans);
	const kept: Token[] = [];
	let hidden = false;
	for (const [index, token] of tokens.entries()) {
		if (removed[index] === 1 && !protectedTokens.has(index)) {
			hidden ||= token.kind !== "newline" || token.hiddenBefore === true;
			continue;
		}
		if (hidden) token.hiddenBefore = true;
		hidden = false;
		kept.push(token);
	}
	return kept;
}

/** Which of `count` indexes some span covers, 1 or 0, in one sweep. */
function spanned(count: number, spans: readonly ConditionalBranch[]): Uint8Array {
	const starts = new Int32Array(count + 1);
	for (const span of spans) {
		starts[span.start] = (starts[span.start] as number) + 1;
		starts[span.end] = (starts[span.end] as number) - 1;
	}
	const covered = new Uint8Array(count);
	let depth = 0;
	for (let index = 0; index < count; index++) {
		depth += starts[index] as number;
		covered[index] = depth > 0 ? 1 : 0;
	}
	return covered;
}

/** Gives each token the innermost kept alternative around it, in one sweep over nested spans. */
function markAlternatives(tokens: Token[], spans: AlternativeSpan[]): void {
	if (spans.length === 0) return;
	spans.sort((left, right) => left.start - right.start || right.end - left.end);
	const open: Array<{ end: number; alternative: Alternative }> = [];
	let next = 0;
	for (let index = 0; index < tokens.length; index++) {
		while (open.length > 0 && (open.at(-1) as { end: number }).end <= index) open.pop();
		while (next < spans.length && (spans[next] as AlternativeSpan).start <= index) {
			const { end, group, branch } = spans[next] as AlternativeSpan;
			open.push({ end, alternative: { group, branch, ...defined({ outer: open.at(-1)?.alternative }) } });
			next++;
		}
		const alternative = open.at(-1)?.alternative;
		if (alternative !== undefined) (tokens[index] as Token).alternative = alternative;
	}
}

export function isSignificant(token: Token): boolean {
	return token.kind !== "comment" && token.kind !== "newline";
}

export function rangeOfToken(token: Token): Range {
	return { start: token.start, end: token.end };
}
