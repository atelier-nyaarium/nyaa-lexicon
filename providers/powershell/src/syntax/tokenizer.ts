// PowerShell's lexical grammar, as its own tokenizer reads it: the parser asks for the next token
// in the mode it stands in (a command, an expression, a type name or a class signature), and
// strings, variables and bare words are read differently in each.

import { type CursorMark, SourceCursor } from "@nyaa-lexicon/protocol";
import {
	type ExpandableToken,
	forcesNewAssemblyToken,
	forcesNewToken,
	forcesNewTokenAfterNumber,
	isDash,
	isDecimalDigit,
	isDoubleQuote,
	isHexDigit,
	isIdentifierFollow,
	isIdentifierStart,
	isLetter,
	isLetterOrDigit,
	isSingleQuote,
	isVariableStart,
	isWhitespace,
	KEYWORDS,
	type LabelToken,
	type NestedExpression,
	type NestedPart,
	NUL,
	type NumberToken,
	OPERATORS,
	type ParameterToken,
	type PlainToken,
	type RedirectionToken,
	type StringToken,
	type Token,
	type TokenKind,
	type VariableToken,
} from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

export type Mode = "command" | "expression" | "typeName" | "signature";

export interface SyntaxProblem {
	message: string;
	pos: number;
}

////////////////////////////////
//  Constants

export const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** `$(` or `"` ends a bare word only where these can follow. */
const VARIABLE_ENDERS = new Set([
	"",
	NUL,
	"\t",
	"\r",
	"\n",
	" ",
	"&",
	"(",
	")",
	",",
	";",
	"{",
	"}",
	"|",
	".",
	"[",
	"=",
]);

const TYPE_SUFFIXES: ReadonlyMap<string, string> = new Map([
	["u", "u"],
	["s", "s"],
	["l", "l"],
	["d", "d"],
	["y", "y"],
	["n", "n"],
]);

const MULTIPLIERS: ReadonlyMap<string, bigint> = new Map([
	["k", 1024n],
	["m", 1024n ** 2n],
	["g", 1024n ** 3n],
	["t", 1024n ** 4n],
	["p", 1024n ** 5n],
]);

/** The integer type a suffix names, with its range. */
const SUFFIX_TYPES: ReadonlyMap<string, readonly [string, bigint, bigint]> = new Map([
	["y", ["sbyte", -128n, 127n]],
	["uy", ["byte", 0n, 255n]],
	["s", ["short", -32768n, 32767n]],
	["us", ["ushort", 0n, 65535n]],
	["l", ["long", -(2n ** 63n), 2n ** 63n - 1n]],
	["ul", ["ulong", 0n, 2n ** 64n - 1n]],
]);

const INT_RANGE = [-(2n ** 31n), 2n ** 31n - 1n] as const;
const LONG_RANGE = [-(2n ** 63n), 2n ** 63n - 1n] as const;
const UINT_MAX = 2n ** 32n - 1n;
const ULONG_MAX = 2n ** 64n - 1n;
const DECIMAL_MAX = 2n ** 96n - 1n;
const DOUBLE_MAX = BigInt(Number.MAX_VALUE);

/** Binary digit counts whose first digit is a sign bit. */
const SIGNED_BINARY_LENGTHS: ReadonlySet<number> = new Set([8, 16, 32, 64, 96]);

////////////////////////////////
//  Classes

export class PowerShellSyntaxError extends Error {
	constructor(readonly problem: SyntaxProblem) {
		super(problem.message);
	}
}

export class Tokenizer {
	mode: Mode = "command";
	allowSignedNumbers = false;
	forceEndNumberOnTernary = false;
	wantSimpleName = false;
	inWorkflow = false;
	/** Every token read, trivia included, in order; a resync drops what it rereads. */
	readonly saved: Array<{ token: Token; at: CursorMark }> = [];
	private readonly cursor: SourceCursor;
	private start: CursorMark;

	/** Where the script starts: past a byte order mark. */
	readonly firstOffset: number;

	/**
	 * @param text What this tokenizer reads: the file, or a `$(...)` of a string with its doubled quotes
	 *   undone.
	 * @param origins Where each code point of the text sits in the file, when the text is not the file.
	 */
	constructor(
		text: string,
		private readonly origins?: ReadonlyMap<number, CursorMark>,
	) {
		this.cursor = new SourceCursor(text);
		// PowerShell reads a file past its byte order mark.
		if (origins === undefined && this.cursor.peek() === BYTE_ORDER_MARK) this.cursor.next();
		this.firstOffset = this.cursor.offset;
		this.start = this.cursor.mark();
	}

	////////////////////////////////
	//  Characters

	private peek(): string {
		return this.cursor.peek();
	}

	/** The character after the next one. */
	private peekSecond(): string {
		const first = this.cursor.peek();
		return first === "" ? "" : this.cursor.peek(first.length);
	}

	private get(): string {
		return this.cursor.next();
	}

	private atEnd(): boolean {
		return !this.cursor.good();
	}

	private skipWhitespace(): void {
		this.cursor.readWhile(isWhitespace);
	}

	/** Where a place in this text sits in the file. */
	private fileMark(mark: CursorMark): CursorMark {
		if (this.origins === undefined) return mark;
		const found = this.origins.get(mark.offset);
		if (found === undefined) throw new Error("powershell nested text offset has no file origin");
		return found;
	}

	/** The file offset of a text offset at a code point's start. */
	private origin(offset: number): number {
		if (this.origins === undefined) return offset;
		const found = this.origins.get(offset);
		if (found === undefined) throw new Error("powershell nested text offset has no file origin");
		return found.offset;
	}

	fail(message: string, offset = this.cursor.offset): never {
		throw new PowerShellSyntaxError({ message, pos: this.origin(offset) });
	}

	////////////////////////////////
	//  Tokens

	private begin(): void {
		this.start = this.cursor.mark();
	}

	private save<T extends Token>(token: T): T {
		this.saved.push({ token, at: this.start });
		return token;
	}

	/** What every token holds: its place in the file and its text. */
	private base(): Omit<PlainToken, "kind"> {
		const start = this.fileMark(this.start);
		const end = this.fileMark(this.cursor.mark());
		return {
			pos: start.offset,
			end: end.offset,
			line: start.line,
			column: start.column,
			endLine: end.line,
			endColumn: end.column,
			text: this.cursor.textSince(this.start),
		};
	}

	private token(kind: TokenKind): PlainToken {
		return this.save({ kind, ...this.base() });
	}

	/** Where the next token will start. */
	restorePoint(): CursorMark {
		this.begin();
		return this.cursor.mark();
	}

	/** Rereads from a token or a restore point, dropping every token saved since. */
	resync(point: Token | CursorMark): void {
		const mark = "offset" in point ? point : this.markOf(point);
		this.cursor.rewind(mark);
		this.start = mark;
		while (this.saved.length > 0 && (this.saved.at(-1)?.at.offset ?? 0) >= mark.offset) this.saved.pop();
	}

	private markOf(token: Token): CursorMark {
		for (let index = this.saved.length - 1; index >= 0; index--) {
			const entry = this.saved[index];
			if (entry?.token === token) return entry.at;
		}
		throw new Error("powershell resync to a token that was never saved");
	}

	/** Offset at the next character, as the file counts it. */
	get offset(): number {
		return this.origin(this.cursor.offset);
	}

	////////////////////////////////
	//  Layout

	/** Past blanks, comments, continuations and line breaks, and `;` when asked. */
	skipNewlines(skipSemis: boolean): void {
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) return;
			guard = this.cursor.offset;
			this.begin();
			const c = this.peek();
			if (isWhitespace(c)) this.skipWhitespace();
			else if (c === "\r" || c === "\n") {
				this.get();
				if (c === "\r" && this.peek() === "\n") this.get();
				this.token("NewLine");
			} else if (c === ";" && skipSemis) {
				this.get();
				this.token("Semi");
			} else if (c === "#") {
				this.get();
				this.lineComment();
			} else if (c === "<" && this.peekSecond() === "#") {
				this.get();
				this.get();
				this.blockComment();
			} else if (c === "`" && (this.peekSecond() === "\n" || this.peekSecond() === "\r")) {
				this.get();
				const breaker = this.get();
				if (breaker === "\r" && this.peek() === "\n") this.get();
				this.token("LineContinuation");
			} else if (c === "`" && isWhitespace(this.peekSecond())) {
				this.get();
				this.skipWhitespace();
			} else return;
		}
	}

	private lineComment(): void {
		this.cursor.readWhile((character) => character !== "\r" && character !== "\n");
		this.token("Comment");
	}

	private blockComment(): void {
		const opened = this.start.offset;
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("powershell block comment scan failed to advance");
			guard = this.cursor.offset;
			if (this.atEnd()) {
				// Still a comment, to the end.
				this.token("Comment");
				this.fail("Missing the terminator '#>' in a multi-line comment.", opened);
			}
			if (this.cursor.take("#>")) break;
			this.get();
		}
		this.token("Comment");
	}

	/**
	 * Past a line break: whether a `|` comes first, blanks, comments and single line breaks aside. A
	 * blank line ends the pipeline.
	 */
	pipeFollows(): boolean {
		const mark = this.cursor.mark();
		try {
			let afterBreak = true;
			let guard = -1;
			for (;;) {
				if (this.cursor.offset <= guard) throw new Error("powershell leading pipe scan failed to advance");
				guard = this.cursor.offset;
				const c = this.peek();
				if (c === "") return false;
				if (isWhitespace(c)) {
					this.skipWhitespace();
					continue;
				}
				if (c === "\n" || c === "\r") {
					if (afterBreak) return false;
					afterBreak = true;
					this.get();
					if (c === "\r" && this.peek() === "\n") this.get();
					continue;
				}
				afterBreak = false;
				if (c === "#") {
					this.cursor.readWhile((character) => character !== "\r" && character !== "\n");
					continue;
				}
				if (c === "<" && this.peekSecond() === "#") {
					this.get();
					this.get();
					let inner = -1;
					while (this.cursor.good() && !this.cursor.take("#>")) {
						if (this.cursor.offset <= inner)
							throw new Error("powershell leading pipe scan failed to advance");
						inner = this.cursor.offset;
						this.get();
					}
					continue;
				}
				return c === "|";
			}
		} finally {
			this.cursor.rewind(mark);
		}
	}

	////////////////////////////////
	//  Escapes

	/** The character a backtick escapes; `u{...}` names a code point. */
	private backtick(c: string): string {
		switch (c) {
			case "0":
				return "\0";
			case "a":
				return "\u0007";
			case "b":
				return "\b";
			case "e":
				return "\u001b";
			case "f":
				return "\f";
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "v":
				return "\u000b";
			case "u":
				return this.unicodeEscape();
			default:
				return c;
		}
	}

	private unicodeEscape(): string {
		const escapeStart = this.cursor.offset - 2;
		if (this.peek() !== "{") this.fail("The Unicode escape sequence is not valid.", escapeStart);
		this.get();
		let digits = "";
		while (isHexDigit(this.peek()) && digits.length < 6) digits += this.get();
		if (this.peek() !== "}" || digits.length === 0)
			this.fail("The Unicode escape sequence is not valid.", escapeStart);
		this.get();
		const point = Number.parseInt(digits, 16);
		if (point > 0x10ffff) this.fail("The Unicode escape sequence is not valid.", escapeStart);
		return String.fromCodePoint(point);
	}

	////////////////////////////////
	//  Strings

	/** A `'...'` string's value, past its opening quote. */
	private verbatimBody(): string {
		const opened = this.cursor.offset - 1;
		let value = "";
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("powershell string scan failed to advance");
			guard = this.cursor.offset;
			if (this.atEnd()) this.fail("The string is missing the terminator: '.", opened);
			const c = this.get();
			if (isSingleQuote(c)) {
				if (!isSingleQuote(this.peek())) break;
				value += this.get();
				continue;
			}
			value += c;
		}
		return value;
	}

	/** A `"..."` string's value, past its opening quote, with its expansions. */
	private expandableBody(nested: NestedPart[]): string {
		const opened = this.cursor.offset - 1;
		let value = "";
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("powershell string scan failed to advance");
			guard = this.cursor.offset;
			if (this.atEnd()) this.fail('The string is missing the terminator: ".', opened);
			const at = this.cursor.mark();
			const c = this.get();
			if (isDoubleQuote(c)) {
				if (!isDoubleQuote(this.peek())) break;
				value += this.get();
				continue;
			}
			if (c === "$" && this.dollarInString(false, nested, at)) {
				value += this.cursor.textSince(at);
				continue;
			}
			if (c === "`" && !this.atEnd()) {
				value += this.backtick(this.get());
				continue;
			}
			value += c;
		}
		return value;
	}

	/**
	 * Past a `$` in a string, `dollar` marking it: a variable or `$(...)` the string expands, or false
	 * for a plain `$`.
	 */
	private dollarInString(hereString: boolean, nested: NestedPart[], dollar: CursorMark): boolean {
		const next = this.peek();
		const savedStart = this.start;
		const savedMode = this.mode;
		const savedLength = this.saved.length;
		try {
			this.mode = "expression";
			if (next === "(") {
				const open = this.cursor.mark();
				this.get();
				nested.push(this.subExpression(hereString, dollar, open));
				return true;
			}
			if (isVariableStart(next) || next === "{") {
				this.start = dollar;
				nested.push(this.variable(false, true) as VariableToken);
				return true;
			}
			return false;
		} finally {
			// Nested tokens are read again when the parser reaches them.
			this.saved.length = savedLength;
			this.start = savedStart;
			this.mode = savedMode;
		}
	}

	/** A string's `$(...)`, counted by parentheses, its doubled quotes undone for the nested scan. */
	private subExpression(hereString: boolean, dollar: CursorMark, open: CursorMark): NestedExpression {
		let text = "";
		const origins = new Map<number, CursorMark>();
		const keep = (character: string, at: CursorMark): void => {
			origins.set(text.length, this.fileMark(at));
			text += character;
		};
		keep("$", dollar);
		keep("(", open);
		let depth = 1;
		let guard = -1;
		while (depth > 0) {
			if (this.cursor.offset <= guard) throw new Error("powershell subexpression scan failed to advance");
			guard = this.cursor.offset;
			if (this.atEnd()) this.fail("Missing closing ')' in subexpression.", dollar.offset);
			const at = this.cursor.mark();
			const c = this.get();
			if (c === "(") depth++;
			else if (c === ")") depth--;
			// A doubled quote, or an escaped one, reads as the quote alone.
			if ((c === "`" || isDoubleQuote(c)) && !hereString && isDoubleQuote(this.peek())) {
				const kept = this.cursor.mark();
				keep(this.get(), kept);
				continue;
			}
			keep(c, at);
		}
		const end = this.fileMark(this.cursor.mark());
		origins.set(text.length, end);
		return { kind: "SubExpression", pos: this.fileMark(dollar).offset, end: end.offset, text, origins };
	}

	private stringLiteral(): StringToken {
		const value = this.verbatimBody();
		return this.save({ kind: "StringLiteral", ...this.base(), value });
	}

	private stringExpandable(): Token {
		const nested: NestedPart[] = [];
		const value = this.expandableBody(nested);
		return this.save({
			kind: "StringExpandable",
			...this.base(),
			value,
			nested,
			expandable: true,
		} as ExpandableToken);
	}

	/** Past `@'` or `@"`: blanks, then a line break, before the body. */
	private hereStringHeader(quote: string): void {
		const header = this.cursor.offset - 2;
		this.skipWhitespace();
		const c = this.peek();
		if (c === "\r") {
			this.get();
			if (this.peek() === "\n") this.get();
			return;
		}
		if (c === "\n") {
			this.get();
			return;
		}
		if (c === "") this.fail(`The string is missing the terminator: ${quote}@.`, header);
		this.fail("No characters are allowed after a here-string header but before the end of the line.");
	}

	/** At a line's start in a here-string: its `'@` or `"@` footer, which ends it. */
	private hereStringFooter(single: boolean, misplaced: { at?: number }): boolean {
		const closes = (): boolean =>
			(single ? isSingleQuote(this.peek()) : isDoubleQuote(this.peek())) && this.peekSecond() === "@";
		if (closes()) {
			this.get();
			this.get();
			return true;
		}
		// A footer behind blanks is text, named if the string never ends.
		if (misplaced.at === undefined && isWhitespace(this.peek())) {
			const mark = this.cursor.mark();
			this.skipWhitespace();
			if (closes()) misplaced.at = this.cursor.offset;
			this.cursor.rewind(mark);
		}
		return false;
	}

	private hereString(single: boolean): Token {
		const header = this.cursor.offset - 2;
		this.hereStringHeader(single ? "'" : '"');
		const nested: NestedPart[] = [];
		const misplaced: { at?: number } = {};
		let value = "";
		if (!this.hereStringFooter(single, misplaced)) {
			let guard = -1;
			for (;;) {
				if (this.cursor.offset <= guard) throw new Error("powershell here-string scan failed to advance");
				guard = this.cursor.offset;
				if (this.atEnd()) {
					if (misplaced.at !== undefined)
						this.fail("White space is not allowed before the string terminator.", misplaced.at);
					this.fail(`The string is missing the terminator: ${single ? "'" : '"'}@.`, header);
				}
				const at = this.cursor.mark();
				const c = this.get();
				if (c === "\r" || c === "\n") {
					let lineBreak = c;
					if (c === "\r" && this.peek() === "\n") lineBreak += this.get();
					if (this.hereStringFooter(single, misplaced)) break;
					value += lineBreak;
					continue;
				}
				if (!single && c === "$" && this.dollarInString(true, nested, at)) {
					value += this.cursor.textSince(at);
					continue;
				}
				if (!single && c === "`" && !this.atEnd()) {
					value += this.backtick(this.get());
					continue;
				}
				value += c;
			}
		}
		if (single) return this.save({ kind: "HereStringLiteral", ...this.base(), value });
		return this.save({
			kind: "HereStringExpandable",
			...this.base(),
			value,
			nested,
			expandable: true,
		} as ExpandableToken);
	}

	/** A `--%` argument: the rest of the line, up to a `|` or `&&` outside quotes. */
	verbatimArgument(): StringToken {
		this.skipWhitespace();
		this.begin();
		let quoted = false;
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("powershell verbatim argument scan failed to advance");
			guard = this.cursor.offset;
			const c = this.peek();
			if (c === "" || c === "\r" || c === "\n") break;
			if (isDoubleQuote(c)) quoted = !quoted;
			else if (!quoted && (c === "|" || (c === "&" && this.peekSecond() === "&"))) break;
			this.get();
		}
		const token = this.base();
		return this.save({ kind: "Generic", ...token, value: token.text });
	}

	////////////////////////////////
	//  Variables

	/** Past `$` or `@`: a variable, or a bare word when what follows makes it one. */
	private variable(splatted: boolean, inString: boolean): Token {
		const opened = this.cursor.offset;
		if (this.peek() === "{") {
			this.get();
			let name = "";
			let closed = false;
			for (;;) {
				const c = this.get();
				if (c === "") break;
				if (c === "}") {
					closed = true;
					break;
				}
				if (c === "`") {
					if (this.atEnd()) break;
					name += this.backtick(this.get());
					continue;
				}
				if (isDoubleQuote(c) && inString) {
					if (isDoubleQuote(this.peek())) name += this.get();
					else name += c;
					continue;
				}
				if (c === "{")
					this.fail(
						"Variable reference is not valid. '{' must be escaped with a backtick.",
						this.cursor.offset - 1,
					);
				name += c;
			}
			if (!closed) this.fail("Incomplete variable reference token.", opened);
			if (name === "") this.fail("An empty braced variable reference was found.", this.cursor.offset - 1);
			if (this.mode === "command") {
				const next = this.peek();
				if (!forcesNewToken(next) && next !== "." && next !== "[") {
					this.cursor.rewind(this.start);
					return this.genericToken("");
				}
			}
			if (unqualified(name) === "") this.fail("Invalid variable reference.", this.start.offset);
			return this.save({
				kind: splatted ? "SplattedVariable" : "Variable",
				...this.base(),
				path: name,
				braced: true,
			});
		}
		const first = this.peek();
		if (!isVariableStart(first)) return this.genericToken("$");
		let name = this.get();
		if (first === "$" || first === "?" || first === "^") {
			if (this.mode === "command" && !forcesNewToken(this.peek())) {
				this.cursor.rewind(this.start);
				return this.genericToken("");
			}
		} else {
			let guard = -1;
			for (;;) {
				if (this.cursor.offset <= guard) throw new Error("powershell variable scan failed to advance");
				guard = this.cursor.offset;
				const c = this.peek();
				if (c === ":") {
					if (this.peekSecond() === ":") break;
					name += this.get();
					continue;
				}
				if (/^[A-Za-z0-9_?]$/.test(c)) {
					name += this.get();
					continue;
				}
				if (VARIABLE_ENDERS.has(c)) break;
				if (isLetterOrDigit(c)) {
					name += this.get();
					continue;
				}
				if (this.mode === "command" && !forcesNewToken(c)) {
					this.cursor.rewind(this.start);
					return this.genericToken("");
				}
				break;
			}
		}
		if (unqualified(name) === "") this.fail("Invalid variable reference.", this.start.offset);
		return this.save({
			kind: splatted ? "SplattedVariable" : "Variable",
			...this.base(),
			path: name,
			braced: false,
		});
	}

	////////////////////////////////
	//  Parameters and operators

	/** Past `-`: a parameter, an operator in expression mode, or a lone minus. */
	private parameter(): Token {
		let name = "";
		let sawColon = false;
		for (;;) {
			const c = this.peek();
			if (isWhitespace(c)) break;
			if (c === "" || "{}();,|&.[\r\n".includes(c)) break;
			if (c === ":") {
				sawColon = true;
				if (this.mode === "command") this.get();
				break;
			}
			if (/^[A-Za-z]$/.test(c)) {
				name += this.get();
				continue;
			}
			if (isSingleQuote(c) || isDoubleQuote(c)) {
				if (this.mode === "command") {
					this.cursor.rewind(this.start);
					return this.genericToken("");
				}
				break;
			}
			if (this.mode === "command") name += this.get();
			else break;
		}
		if (this.mode === "expression") {
			const operator = OPERATORS.get(name.toLowerCase());
			if (operator !== undefined) return this.token(operator);
		}
		if (name === "") return this.token("Minus");
		return this.save({ kind: "Parameter", ...this.base(), name, usedColon: sawColon } as ParameterToken);
	}

	/** An operator, unless command mode reads the characters as the start of a bare word. */
	private operatorInCommandMode(consumed: string, kind: TokenKind): Token {
		if (this.mode === "command" && !forcesNewToken(this.peek())) return this.genericToken(consumed);
		return this.token(kind);
	}

	////////////////////////////////
	//  Bare words

	/**
	 * The rest of a bare word, `prefix` already read: quoted parts and escapes decoded, variables and
	 * `$(...)` kept for expansion.
	 */
	private genericToken(prefix: string): Token {
		let value = prefix;
		const nested: NestedPart[] = [];
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("powershell bare word scan failed to advance");
			guard = this.cursor.offset;
			const c = this.peek();
			if (forcesNewToken(c)) break;
			const at = this.cursor.mark();
			this.get();
			if (c === "`") {
				if (!this.atEnd()) value += this.backtick(this.get());
				else value += c;
				continue;
			}
			if (isSingleQuote(c)) {
				value += this.verbatimBody();
				continue;
			}
			if (isDoubleQuote(c)) {
				value += this.expandableBody(nested);
				continue;
			}
			if (c === "$" && this.dollarInString(false, nested, at)) {
				value += this.cursor.textSince(at);
				continue;
			}
			value += c;
		}
		if (nested.length > 0)
			return this.save({ kind: "Generic", ...this.base(), value, nested, expandable: true } as ExpandableToken);
		return this.save({ kind: "Generic", ...this.base(), value } as StringToken);
	}

	////////////////////////////////
	//  Numbers

	/** A number, or a bare word when what follows the digits makes it one. */
	private number(first: string): Token {
		const scanned = this.numberText(first);
		if (scanned === undefined) {
			this.cursor.rewind(this.start);
			return this.genericToken("");
		}
		const constant = numberConstant(scanned);
		if (constant === null) {
			if (this.mode !== "expression") {
				this.cursor.rewind(this.start);
				return this.genericToken("");
			}
			this.fail(`Bad numeric constant: ${this.cursor.textSince(this.start)}.`, this.start.offset);
		}
		return this.save({ kind: "Number", ...this.base(), ...constant } as NumberToken);
	}

	private digits(predicate: (character: string) => boolean): string {
		return this.cursor.readWhile((character) => character.length === 1 && predicate(character));
	}

	/** The number's parts, or undefined when the characters are no number. */
	private numberText(first: string): ScannedNumber | undefined {
		const scanned: ScannedNumber = {
			sign: "",
			digits: "",
			format: "decimal",
			real: false,
			suffix: "",
			multiplier: 1n,
		};
		let notNumber = false;
		let c = first;
		if (isDash(c) || c === "+") {
			scanned.sign = isDash(c) ? "-" : "+";
			c = this.get();
		}
		const exponent = (): void => {
			const sign = this.peek();
			if (sign === "+" || isDash(sign)) {
				this.get();
				scanned.digits += isDash(sign) ? "-" : "+";
			}
			const exponentDigits = this.digits(isDecimalDigit);
			if (exponentDigits === "") notNumber = true;
			scanned.digits += exponentDigits;
		};
		const afterDot = (): void => {
			scanned.digits += this.digits(isDecimalDigit);
			const e = this.peek();
			if (e === "e" || e === "E") {
				scanned.digits += this.get();
				exponent();
			}
		};
		if (c === ".") {
			scanned.digits = ".";
			scanned.real = true;
			afterDot();
		} else {
			const prefix = this.peek();
			if (c === "0" && (prefix === "x" || prefix === "X" || prefix === "b" || prefix === "B")) {
				this.get();
				const hex = prefix === "x" || prefix === "X";
				scanned.format = hex ? "hex" : "binary";
				scanned.digits = this.digits(hex ? isHexDigit : (character) => character === "0" || character === "1");
				// A bare `0x` reads as zero.
				if (hex) scanned.digits = `0${scanned.digits}`;
				else if (scanned.digits === "" && scanned.sign === "") notNumber = true;
			} else {
				scanned.digits = c + this.digits(isDecimalDigit);
				const next = this.peek();
				if (next === "." && this.peekSecond() !== ".") {
					this.get();
					scanned.digits += ".";
					scanned.real = true;
					afterDot();
				} else if (next === "e" || next === "E") {
					scanned.digits += this.get();
					scanned.real = true;
					exponent();
				}
			}
		}
		let next = this.peek().toLowerCase();
		const suffix = TYPE_SUFFIXES.get(next);
		if (suffix !== undefined) {
			this.get();
			scanned.suffix = suffix;
			next = this.peek().toLowerCase();
			if (TYPE_SUFFIXES.has(next)) {
				this.get();
				if (scanned.suffix === "u" && (next === "l" || next === "s" || next === "y"))
					scanned.suffix = `u${next}`;
				else notNumber = true;
				next = this.peek().toLowerCase();
			}
		}
		const multiplier = MULTIPLIERS.get(next);
		if (multiplier !== undefined) {
			this.get();
			scanned.multiplier = multiplier;
			if (this.peek() === "b" || this.peek() === "B") this.get();
			else notNumber = true;
		}
		const end = this.peek();
		if (
			!forcesNewToken(end) &&
			(this.mode !== "expression" || !forcesNewTokenAfterNumber(end, this.forceEndNumberOnTernary))
		) {
			notNumber = true;
		}
		return notNumber ? undefined : scanned;
	}

	////////////////////////////////
	//  Names

	private identifier(first: string): Token {
		let name = first;
		name += this.cursor.readWhile(isIdentifierFollow);
		if (this.mode === "typeName") return this.typeName();
		if (!this.wantSimpleName && this.mode === "command" && !forcesNewToken(this.peek()))
			return this.genericToken(name);
		if (!this.wantSimpleName && (this.mode === "command" || this.mode === "signature")) {
			const keyword = KEYWORDS.get(name.toLowerCase());
			if (keyword !== undefined && (keyword !== "InlineScript" || this.inWorkflow)) return this.token(keyword);
		}
		return this.token("Identifier");
	}

	private typeName(): Token {
		this.cursor.readWhile(
			(c) => c === "." || c === "`" || c === "_" || c === "+" || c === "#" || c === "\\" || isLetterOrDigit(c),
		);
		return this.token("Identifier");
	}

	/** After `,` in an assembly-qualified type: the assembly name and its properties. */
	assemblyNameSpec(): string {
		const piece = (): string => {
			this.skipWhitespace();
			this.begin();
			const text = this.cursor.readWhile((c) => !forcesNewAssemblyToken(c));
			this.token("Identifier");
			this.skipWhitespace();
			return text;
		};
		let spec = piece();
		while (this.peek() === ",") {
			this.begin();
			this.get();
			this.token("Comma");
			spec += `, ${piece()}`;
			if (this.peek() === "=") {
				this.begin();
				this.get();
				this.token("Equals");
				spec += `=${piece()}`;
			}
		}
		return spec;
	}

	private label(): Token {
		const c = this.peek();
		if (!isIdentifierStart(c)) return this.genericToken(":");
		const name = this.cursor.readWhile(isIdentifierFollow);
		// PowerShell keeps the character that ends the name as written, an escape or quote included.
		if (this.mode === "command" && !forcesNewToken(this.peek())) return this.genericToken(`:${name}${this.get()}`);
		return this.save({ kind: "Label", ...this.base(), label: name } as LabelToken);
	}

	private dot(): Token {
		const c = this.peek();
		if (c === ".") {
			this.get();
			if (this.mode === "command" && !forcesNewToken(this.peek())) {
				this.cursor.rewind({ ...this.start });
				this.get();
				return this.genericToken(".");
			}
			return this.token("DotDot");
		}
		if (isDecimalDigit(c)) return this.number(".");
		if (this.mode === "command" && !forcesNewToken(c) && c !== "$" && c !== '"' && c !== "'")
			return this.genericToken(".");
		return this.token("Dot");
	}

	////////////////////////////////
	//  Redirections

	private fileRedirection(from: string, append: boolean): Token {
		return this.save({ kind: "Redirection", ...this.base(), from, append } as RedirectionToken);
	}

	private mergingRedirection(from: string, to: string): Token {
		return this.save({ kind: "Redirection", ...this.base(), from, to, append: false } as RedirectionToken);
	}

	////////////////////////////////
	//  Member access

	/** A `.`, `::`, `?.`, `[` or `?[` right after an expression; blanks end the expression. */
	memberAccessOperator(allowLBracket: boolean): Token | undefined {
		for (;;) {
			if (this.peek() !== "<" || this.peekSecond() !== "#") break;
			this.begin();
			this.get();
			this.get();
			this.blockComment();
		}
		const c = this.peek();
		const mark = this.cursor.mark();
		this.begin();
		if (c === ".") {
			this.get();
			const next = this.peek();
			if (next === ".") {
				this.cursor.rewind(mark);
				return undefined;
			}
			if (this.mode === "command" && (isWhitespace(next) || next === "" || next === "\r" || next === "\n")) {
				this.cursor.rewind(mark);
				return undefined;
			}
			return this.token("Dot");
		}
		if (c === ":" && this.peekSecond() === ":") {
			this.get();
			this.get();
			const next = this.peek();
			if (this.mode === "command" && (isWhitespace(next) || next === "" || next === "\r" || next === "\n")) {
				this.cursor.rewind(mark);
				return undefined;
			}
			return this.token("ColonColon");
		}
		if (c === "[" && allowLBracket) {
			this.get();
			return this.token("LBracket");
		}
		if (c === "?") {
			const next = this.peekSecond();
			if (next === ".") {
				this.get();
				this.get();
				return this.token("QuestionDot");
			}
			if (next === "[" && allowLBracket) {
				this.get();
				this.get();
				return this.token("QuestionLBracket");
			}
		}
		return undefined;
	}

	/** A `(` or `{` right after a member name. */
	invokeMemberOpenParen(): Token | undefined {
		const c = this.peek();
		if (c !== "(" && c !== "{") return undefined;
		this.begin();
		this.get();
		return this.token(c === "(" ? "LParen" : "LCurly");
	}

	/** A `[` where an attribute or type may start, past blanks and comments, or nothing. */
	lBracket(): Token | undefined {
		const resyncPoint = this.cursor.mark();
		let resyncIfMemberAccess = false;
		for (;;) {
			this.begin();
			const c = this.peek();
			if (isWhitespace(c)) {
				resyncIfMemberAccess = true;
				this.skipWhitespace();
				continue;
			}
			if (c === "#") {
				resyncIfMemberAccess = true;
				this.get();
				this.lineComment();
				continue;
			}
			if (c === "<" && this.peekSecond() === "#") {
				resyncIfMemberAccess = false;
				this.get();
				this.get();
				this.blockComment();
				continue;
			}
			if (c === "[") {
				this.get();
				return this.token("LBracket");
			}
			if ((c === "." || c === ":") && resyncIfMemberAccess) this.resync(resyncPoint);
			return undefined;
		}
	}

	////////////////////////////////
	//  Main

	/** After a refusal: the rest read as commands, so comments and blank lines past it hold. */
	drain(): void {
		this.mode = "command";
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("powershell drain failed to advance");
			guard = this.cursor.offset;
			try {
				if (this.next().kind === "EndOfInput") return;
			} catch (error) {
				if (error instanceof PowerShellSyntaxError) return;
				throw error;
			}
		}
	}

	next(): Token {
		for (;;) {
			this.begin();
			if (this.atEnd()) return this.token("EndOfInput");
			if (isWhitespace(this.peek())) {
				this.skipWhitespace();
				continue;
			}
			const c = this.get();
			if (isSingleQuote(c)) return this.stringLiteral();
			if (isDoubleQuote(c)) return this.stringExpandable();
			switch (c) {
				case "@": {
					const next = this.peek();
					if (next === "{") {
						this.get();
						return this.token("AtCurly");
					}
					if (next === "(") {
						this.get();
						return this.token("AtParen");
					}
					if (isSingleQuote(next)) {
						this.get();
						return this.hereString(true);
					}
					if (isDoubleQuote(next)) {
						this.get();
						return this.hereString(false);
					}
					if (isVariableStart(next)) return this.variable(true, false);
					this.fail("Unrecognized token in source text.", this.start.offset);
					break;
				}
				case "#":
					this.lineComment();
					continue;
				case "\n":
					return this.token("NewLine");
				case "\r":
					if (this.peek() === "\n") this.get();
					return this.token("NewLine");
				case "`": {
					const next = this.peek();
					if (next === "\r" || next === "\n") {
						this.get();
						if (next === "\r" && this.peek() === "\n") this.get();
						this.token("LineContinuation");
						continue;
					}
					if (isWhitespace(next)) {
						this.skipWhitespace();
						continue;
					}
					if (next === "") this.fail("Incomplete string token.", this.cursor.offset);
					return this.genericToken(this.backtick(this.get()));
				}
				case "=":
					return this.operatorInCommandMode("=", "Equals");
				case "+": {
					const next = this.peek();
					if (next === "+") {
						this.get();
						return this.operatorInCommandMode("++", "PlusPlus");
					}
					if (next === "=") {
						this.get();
						return this.operatorInCommandMode("+=", "PlusEquals");
					}
					if (this.allowSignedNumbers && (isDecimalDigit(next) || next === ".")) return this.number("+");
					return this.operatorInCommandMode("+", "Plus");
				}
				case "*": {
					const next = this.peek();
					if (next === "=") {
						this.get();
						return this.operatorInCommandMode("*=", "MultiplyEquals");
					}
					if (next === ">") {
						this.get();
						if (this.peek() === ">") {
							this.get();
							return this.fileRedirection("*", true);
						}
						if (this.peek() === "&" && this.peekSecond() === "1") {
							this.get();
							this.get();
							return this.mergingRedirection("*", "1");
						}
						return this.fileRedirection("*", false);
					}
					return this.operatorInCommandMode("*", "Multiply");
				}
				case "/":
					if (this.peek() === "=") {
						this.get();
						return this.operatorInCommandMode("/=", "DivideEquals");
					}
					return this.operatorInCommandMode("/", "Divide");
				case "%":
					if (this.peek() === "=") {
						this.get();
						return this.operatorInCommandMode("%=", "RemainderEquals");
					}
					return this.operatorInCommandMode("%", "Rem");
				case "$":
					if (this.peek() === "(") {
						this.get();
						return this.token("DollarParen");
					}
					return this.variable(false, false);
				case "<":
					if (this.peek() === "#") {
						this.get();
						this.blockComment();
						continue;
					}
					return this.save({
						kind: "RedirectInStd",
						...this.base(),
						from: "0",
						append: false,
					} as RedirectionToken);
				case ">":
					if (this.peek() === ">") {
						this.get();
						return this.fileRedirection("1", true);
					}
					return this.fileRedirection("1", false);
				case "(":
					return this.token("LParen");
				case ")":
					return this.token("RParen");
				case "[":
					if (this.mode === "command" && !forcesNewToken(this.peek())) return this.genericToken("[");
					return this.token("LBracket");
				case "]":
					return this.token("RBracket");
				case "{":
					return this.token("LCurly");
				case "}":
					return this.token("RCurly");
				case ".":
					return this.dot();
				case ";":
					return this.token("Semi");
				case ",":
					return this.token("Comma");
				case "&":
					if (this.peek() === "&") {
						this.get();
						return this.token("AndAnd");
					}
					return this.token("Ampersand");
				case "|":
					if (this.peek() === "|") {
						this.get();
						return this.token("OrOr");
					}
					return this.token("Pipe");
				case "!":
					return this.exclaim();
				case ":":
					return this.colon();
				case "?":
					if (this.mode === "expression") return this.question();
					return this.genericToken("?");
				default:
					return this.other(c);
			}
		}
	}

	private exclaim(): Token {
		const next = this.peek();
		if (
			(this.mode === "command" && !forcesNewToken(next)) ||
			(this.mode === "expression" && isIdentifierStart(next))
		) {
			return this.genericToken("!");
		}
		if (this.mode === "expression" && (isDecimalDigit(next) || next === ".")) {
			const mark = this.cursor.mark();
			const scanned = this.numberText("!");
			this.cursor.rewind(mark);
			if (scanned === undefined) return this.genericToken("!");
		}
		return this.token("Exclaim");
	}

	private colon(): Token {
		if (this.peek() === ":") {
			this.get();
			if (this.mode === "command" && !this.wantSimpleName && !forcesNewToken(this.peek()))
				return this.genericToken("::");
			return this.token("ColonColon");
		}
		if (this.mode === "command") return this.label();
		return this.token("Colon");
	}

	private question(): Token {
		if (this.peek() === "?") {
			this.get();
			if (this.peek() === "=") {
				this.get();
				return this.token("QuestionQuestionEquals");
			}
			return this.token("QuestionQuestion");
		}
		return this.token("QuestionMark");
	}

	private other(c: string): Token {
		if (isDash(c)) return this.dash(c);
		if (/^[A-Za-z_]$/.test(c)) return this.identifier(c);
		if (c >= "0" && c <= "9") return this.digit(c);
		if (isLetter(c)) return this.identifier(c);
		return this.genericToken(c);
	}

	private dash(c: string): Token {
		const next = this.peek();
		if (isDash(next)) {
			this.get();
			return this.operatorInCommandMode(c + next, "MinusMinus");
		}
		if (next === "=") {
			this.get();
			return this.operatorInCommandMode(`${c}=`, "MinusEquals");
		}
		if (isLetter(next) || next === "_" || next === "?") return this.parameter();
		if (this.allowSignedNumbers && (isDecimalDigit(next) || next === ".")) return this.number(c);
		return this.operatorInCommandMode(c, "Minus");
	}

	private digit(c: string): Token {
		if (c >= "1" && c <= "6" && this.peek() === ">") {
			const third = this.cursor.peek(2);
			const merging = this.peekSecond() === "&" && (third === "1" || third === "2");
			// An expression reads a file redirection's stream as a number.
			if (this.mode === "expression" && !merging) {
				return this.save({ kind: "Number", ...this.base(), value: Number(c) } as NumberToken);
			}
			this.get();
			if (this.peek() === ">") {
				this.get();
				return this.fileRedirection(c, true);
			}
			if (this.peek() === "&" && (this.peekSecond() === "1" || this.peekSecond() === "2")) {
				this.get();
				return this.mergingRedirection(c, this.get());
			}
			return this.fileRedirection(c, false);
		}
		return this.number(c);
	}
}

////////////////////////////////
//  Functions & Helpers

interface ScannedNumber {
	sign: "" | "+" | "-";
	digits: string;
	format: "decimal" | "hex" | "binary";
	real: boolean;
	suffix: string;
	multiplier: bigint;
}

/** A variable path's name past any scope or drive. */
export function unqualified(path: string): string {
	const colon = path.indexOf(":");
	return colon < 0 ? path : path.slice(colon + 1);
}

interface NumberConstant {
	value: number;
	staticType: string;
}

/** The constant a number spells, as PowerShell's `TryGetNumberValue` reads it; null where it refuses one. */
function numberConstant(scanned: ScannedNumber): NumberConstant | null {
	const sign = scanned.sign === "-" ? -1n : 1n;
	if (scanned.real) {
		const value = Number(scanned.digits) * Number(scanned.multiplier) * Number(sign);
		// A decimal keeps 28 places.
		if (scanned.suffix === "d")
			return decimalHolds(scanned) ? { value: Number(value.toFixed(28)), staticType: "decimal" } : null;
		// A double overflows to infinity rather than refuse.
		if (scanned.suffix === "") return { value, staticType: "double" };
		if (!Number.isFinite(value)) return null;
		return integerConstant(BigInt(roundHalfEven(value)), scanned.suffix, scanned.format);
	}
	const whole = wholeOf(scanned);
	if (whole === undefined) return null;
	return integerConstant(whole.value * scanned.multiplier * sign, whole.suffix, scanned.format);
}

/** A whole number's digits; hex and binary read a sign bit at full width, and 64 bits make a long. */
function wholeOf(scanned: ScannedNumber): { value: bigint; suffix: string } | undefined {
	const { digits, suffix } = scanned;
	const unsigned = suffix.startsWith("u");
	// A signed `-0b` has no digit to read a sign bit from; an unsigned one is zero.
	if (digits === "") return unsigned && scanned.format === "binary" ? { value: 0n, suffix } : undefined;
	if (scanned.format === "decimal") return { value: BigInt(digits), suffix };
	const promoted = (width: number) => (width === 64 && (suffix === "" || suffix === "u") ? `${suffix}l` : suffix);
	if (scanned.format === "binary") {
		const raw = BigInt(`0b${digits}`);
		const signed =
			!unsigned &&
			!digits.startsWith("0") &&
			(SIGNED_BINARY_LENGTHS.has(digits.length) || (digits.length >= 128 && digits.length % 8 === 0));
		return { value: signed ? raw - 2n ** BigInt(digits.length) : raw, suffix: promoted(digits.length) };
	}
	// Hex digits arrive behind a `0`; dropping it at a type's width makes the next digit a sign bit.
	const width = suffix === "y" ? 2 : suffix === "s" ? 4 : suffix === "l" ? 16 : digits.length < 16 ? 8 : 16;
	const signed = !unsigned && digits.length === width + 1;
	const counted = signed ? digits.length - 1 : digits.length;
	const raw = BigInt(`0x${digits}`);
	const negative = signed && raw >= 8n * 16n ** BigInt(counted - 1);
	return { value: negative ? raw - 16n ** BigInt(counted) : raw, suffix: promoted(counted * 4) };
}

/** A whole number in its suffix's type, or the narrowest of int, long, decimal and double. */
function integerConstant(whole: bigint, suffix: string, format: ScannedNumber["format"]): NumberConstant | null {
	const within = (low: bigint, high: bigint): boolean => whole >= low && whole <= high;
	const typed = (staticType: string): NumberConstant => ({ value: Number(whole), staticType });
	const named = SUFFIX_TYPES.get(suffix);
	if (named !== undefined) return within(named[1], named[2]) ? typed(named[0]) : null;
	if (suffix === "n") return typed("bigint");
	if (suffix === "u") return within(0n, UINT_MAX) ? typed("uint") : within(0n, ULONG_MAX) ? typed("ulong") : null;
	if (suffix === "d") return within(-DECIMAL_MAX, DECIMAL_MAX) ? typed("decimal") : null;
	if (within(...INT_RANGE)) return typed("int");
	if (within(...LONG_RANGE)) return typed("long");
	if (format !== "decimal") return null;
	if (within(-DECIMAL_MAX, DECIMAL_MAX)) return typed("decimal");
	return within(-DOUBLE_MAX, DOUBLE_MAX) ? typed("double") : null;
}

/** Whether a real fits a decimal once rounded to its 29 digits, half to even. */
function decimalHolds(scanned: ScannedNumber): boolean {
	let mantissa = "";
	let exponent = "";
	let scale = 0;
	let part: "whole" | "fraction" | "exponent" = "whole";
	for (const character of scanned.digits) {
		if (character === ".") part = "fraction";
		else if (character === "e" || character === "E") part = "exponent";
		else if (part === "exponent") exponent += character;
		else {
			mantissa += character;
			if (part === "fraction") scale++;
		}
	}
	const value = BigInt(mantissa === "" ? "0" : mantissa) * scanned.multiplier;
	if (value === 0n) return true;
	const power = Number(exponent === "" ? "0" : exponent) - scale;
	const size = value.toString().length + power;
	if (size !== 29) return size < 29;
	// The maximum is odd, so its half rounds up past it.
	const limit = 2n * DECIMAL_MAX + 1n;
	return power >= 0 ? 2n * value * 10n ** BigInt(power) < limit : 2n * value < limit * 10n ** BigInt(-power);
}

/** .NET's `Math.Round`: a half goes to the even neighbour. */
function roundHalfEven(value: number): number {
	const floor = Math.floor(value);
	if (value - floor !== 0.5) return Math.round(value);
	return floor % 2 === 0 ? floor : floor + 1;
}
