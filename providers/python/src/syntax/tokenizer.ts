// Python's lexical grammar, per the reference manual's "Lexical analysis" chapter, with the token
// stream CPython's tokenize module reports: INDENT, DEDENT, NL and NEWLINE where it places them,
// f-strings as FSTRING_START, FSTRING_MIDDLE and FSTRING_END around their replacement fields.

import { type CursorMark, SourceCursor } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export type TokenType =
	| "NAME"
	| "NUMBER"
	| "STRING"
	| "OP"
	| "COMMENT"
	| "NL"
	| "NEWLINE"
	| "INDENT"
	| "DEDENT"
	| "ENDMARKER"
	| "FSTRING_START"
	| "FSTRING_MIDDLE"
	| "FSTRING_END"
	| "TSTRING_START"
	| "TSTRING_MIDDLE"
	| "TSTRING_END"
	/** A character no token starts with; tokenize reads it, the parser refuses it. */
	| "ERRORTOKEN";

export interface Token {
	type: TokenType;
	/** As written; an implicit line end at the end of the text is empty. */
	string: string;
	pos: number;
	end: number;
	/** Where `pos` sits: zero-based line, UTF-16 column. */
	line: number;
	column: number;
}

export interface LexError {
	kind: "TokenError" | "IndentationError" | "TabError" | "SyntaxError";
	message: string;
	pos: number;
}

export interface Lexed {
	/** Every token read before an error. */
	tokens: Token[];
	error?: LexError;
}

/** Where the reader stands: plain code, an interpolated string's text, or a format spec's text. */
type Mode =
	| { kind: "code"; brackets: string[]; field: boolean }
	| { kind: "string"; quote: string; raw: boolean; template: boolean }
	| { kind: "spec"; string: { quote: string; raw: boolean; template: boolean } };

////////////////////////////////
//  Constants

const TAB_SIZE = 8;

/** Fields nest in format specs this deep, as CPython's tokenizer allows. */
const MAX_SPEC_NESTING = 3;

/** Longest first. */
const OPERATORS = [
	"**=",
	"//=",
	">>=",
	"<<=",
	"...",
	"->",
	":=",
	"**",
	"//",
	">>",
	"<<",
	"<=",
	">=",
	"==",
	"!=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"@=",
];

const OPENERS: ReadonlyMap<string, string> = new Map([
	["(", ")"],
	["[", "]"],
	["{", "}"],
]);

const ID_START_RE = /^[\p{XID_Start}_]$/u;
const ID_CONTINUE_RE = /^\p{XID_Continue}$/u;

////////////////////////////////
//  Functions & Helpers

export function isIdentifierStart(character: string): boolean {
	return ID_START_RE.test(character);
}

export function isIdentifierCharacter(character: string): boolean {
	return ID_CONTINUE_RE.test(character);
}

function isDigit(character: string): boolean {
	return character.length === 1 && character >= "0" && character <= "9";
}

function isLineBreak(character: string): boolean {
	return character === "\n" || character === "\r";
}

/** The prefix letters a string may carry, lowercased, when `letters` is one. */
function stringPrefix(
	letters: string,
): { raw: boolean; interpolated: boolean; template: boolean; bytes: boolean } | undefined {
	const lower = letters.toLowerCase();
	const valid = ["r", "u", "b", "br", "rb", "f", "fr", "rf", "t", "tr", "rt", ""];
	if (!valid.includes(lower)) return undefined;
	return {
		raw: lower.includes("r"),
		interpolated: lower.includes("f"),
		template: lower.includes("t"),
		bytes: lower.includes("b"),
	};
}

////////////////////////////////
//  Classes

class Refusal extends Error {
	constructor(readonly error: LexError) {
		super(error.message);
	}
}

class Tokenizer {
	private readonly cursor: SourceCursor;
	private readonly tokens: Token[] = [];
	private readonly modes: Mode[] = [{ kind: "code", brackets: [], field: false }];
	/** Indentation widths with tabs to multiples of eight, and with tabs as one column. */
	private readonly indents: Array<{ width: number; alternate: number }> = [{ width: 0, alternate: 0 }];
	private atLineStart = true;
	/** The logical line holds a token other than a comment. */
	private lineHasCode = false;
	/** A backslash joined this physical line to the previous one. */
	private continued = false;
	private ended = false;

	constructor(text: string) {
		this.cursor = new SourceCursor(text);
	}

	lex(): Lexed {
		try {
			while (!this.ended) {
				const offset = this.cursor.offset;
				const placed = this.tokens.length;
				const depth = this.modes.length;
				this.step();
				// A step reads, places a zero-width token or changes mode; anything else would repeat forever.
				if (
					this.cursor.offset === offset &&
					this.tokens.length === placed &&
					this.modes.length === depth &&
					!this.ended
				)
					throw new Error("python tokenizer failed to advance");
			}
			return { tokens: this.tokens };
		} catch (error) {
			if (error instanceof Refusal) return { tokens: this.tokens, error: error.error };
			throw error;
		}
	}

	private fail(kind: LexError["kind"], message: string, pos = this.cursor.offset): never {
		throw new Refusal({ kind, message, pos });
	}

	private mode(): Mode {
		return this.modes[this.modes.length - 1] as Mode;
	}

	private place(type: TokenType, start: CursorMark, string = this.cursor.textSince(start)): Token {
		const token: Token = {
			type,
			string,
			pos: start.offset,
			end: this.cursor.offset,
			line: start.line,
			column: start.column,
		};
		this.tokens.push(token);
		return token;
	}

	private step(): void {
		const mode = this.mode();
		if (mode.kind === "string") this.stringText(mode);
		else if (mode.kind === "spec") this.specText(mode);
		else this.code(mode);
	}

	////////////////////////////////
	//  Lines

	private code(mode: Extract<Mode, { kind: "code" }>): void {
		const topLevel = this.modes.length === 1;
		if (topLevel && this.atLineStart && mode.brackets.length === 0 && !this.continued) {
			this.indentation();
			if (this.ended) return;
		}
		this.cursor.readWhile((character) => character === " " || character === "\t" || character === "\f");
		const start = this.cursor.mark();
		const character = this.cursor.peek();
		if (character === "") {
			if (!topLevel) this.fail("SyntaxError", "unterminated f-string literal", start.offset);
			this.finish();
			return;
		}
		if (character === "#") {
			this.cursor.readWhile((next) => !isLineBreak(next));
			this.place("COMMENT", start);
			return;
		}
		if (isLineBreak(character)) {
			this.lineBreak(mode, start);
			return;
		}
		if (character === "\\") {
			this.cursor.next();
			if (!isLineBreak(this.cursor.peek()))
				this.fail("SyntaxError", "unexpected character after line continuation character", start.offset);
			this.consumeLineBreak();
			if (!this.cursor.good()) this.fail("TokenError", "unexpected EOF in multi-line statement", start.offset);
			this.continued = true;
			return;
		}
		this.continued = false;
		this.lineHasCode = true;
		if (mode.field && mode.brackets.length === 0 && this.fieldBoundary(character, start)) return;
		if (isIdentifierStart(character)) this.nameOrString(start);
		else if (isDigit(character) || (character === "." && isDigit(this.cursor.peek(1)))) this.number(start);
		else if (character === '"' || character === "'") this.string(start, "");
		else this.operator(mode, start);
	}

	/** Measures a line's indentation and places INDENT or DEDENT; a blank line places neither. */
	private indentation(): void {
		this.atLineStart = false;
		const start = this.cursor.mark();
		let width = 0;
		let alternate = 0;
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("python indentation scan failed to advance");
			guard = this.cursor.offset;
			const character = this.cursor.peek();
			if (character === " ") {
				width++;
				alternate++;
			} else if (character === "\t") {
				width = (Math.floor(width / TAB_SIZE) + 1) * TAB_SIZE;
				alternate++;
			} else if (character === "\f") {
				width = 0;
				alternate = 0;
			} else break;
			this.cursor.next();
		}
		const next = this.cursor.peek();
		if (next === "#" || isLineBreak(next)) return;
		if (next === "") {
			// The text ends here: every open block closes.
			width = 0;
			alternate = 0;
		}
		const top = this.indents[this.indents.length - 1] as { width: number; alternate: number };
		if (width === top.width) {
			if (alternate !== top.alternate)
				this.fail("TabError", "inconsistent use of tabs and spaces in indentation");
			return;
		}
		if (width > top.width) {
			if (alternate <= top.alternate) this.fail("TabError", "inconsistent use of tabs and spaces in indentation");
			this.indents.push({ width, alternate });
			this.place("INDENT", start);
			return;
		}
		while (this.indents.length > 1 && width < (this.indents[this.indents.length - 1] as { width: number }).width) {
			this.indents.pop();
			this.placeDedent();
		}
		const outer = this.indents[this.indents.length - 1] as { width: number; alternate: number };
		if (width !== outer.width) this.fail("IndentationError", "unindent does not match any outer indentation level");
		if (alternate !== outer.alternate) this.fail("TabError", "inconsistent use of tabs and spaces in indentation");
	}

	private placeDedent(): void {
		const here = this.cursor.mark();
		this.tokens.push({
			type: "DEDENT",
			string: "",
			pos: here.offset,
			end: here.offset,
			line: here.line,
			column: here.column,
		});
	}

	private consumeLineBreak(): void {
		if (this.cursor.peek() === "\r") this.cursor.next();
		if (this.cursor.peek() === "\n") this.cursor.next();
	}

	private lineBreak(mode: Extract<Mode, { kind: "code" }>, start: CursorMark): void {
		this.consumeLineBreak();
		const logical = this.modes.length === 1 && mode.brackets.length === 0 && this.lineHasCode;
		this.place(logical ? "NEWLINE" : "NL", start);
		if (this.modes.length === 1 && mode.brackets.length === 0) {
			this.atLineStart = true;
			this.lineHasCode = false;
		}
		this.continued = false;
	}

	/** The text ends: the last line's implicit line break, the open blocks' DEDENTs, the end marker. */
	private finish(): void {
		const here = this.cursor.mark();
		const mode = this.mode() as Extract<Mode, { kind: "code" }>;
		if (mode.brackets.length > 0) this.fail("TokenError", "unexpected EOF in multi-line statement", here.offset);
		const lastLineHasText = here.column > 0;
		if (lastLineHasText) {
			this.tokens.push({
				type: this.lineHasCode ? "NEWLINE" : "NL",
				string: "",
				pos: here.offset,
				end: here.offset,
				line: here.line,
				column: here.column,
			});
		}
		while (this.indents.length > 1) {
			this.indents.pop();
			this.tokens.push({
				type: "DEDENT",
				string: "",
				pos: here.offset,
				end: here.offset,
				line: here.line + (lastLineHasText ? 1 : 0),
				column: 0,
			});
		}
		this.tokens.push({
			type: "ENDMARKER",
			string: "",
			pos: here.offset,
			end: here.offset,
			line: here.line + (lastLineHasText ? 1 : 0),
			column: 0,
		});
		this.ended = true;
	}

	////////////////////////////////
	//  Tokens

	private nameOrString(start: CursorMark): void {
		const name = this.cursor.next() + this.cursor.readWhile(isIdentifierCharacter);
		const quote = this.cursor.peek();
		if ((quote === '"' || quote === "'") && name.length <= 2 && stringPrefix(name) !== undefined) {
			this.string(start, name);
			return;
		}
		this.place("NAME", start);
	}

	/** Digits, underscores, a point, an exponent and a `j`, as far as a number reads; the parser checks it. */
	private number(start: CursorMark): void {
		const first = this.cursor.next();
		const radix = first === "0" ? this.cursor.peek().toLowerCase() : "";
		if (radix === "x" || radix === "o" || radix === "b") {
			this.cursor.next();
			this.cursor.readWhile((character) => character === "_" || /^[0-9a-fA-F]$/.test(character));
			this.place("NUMBER", start);
			return;
		}
		const digits = (character: string): boolean => isDigit(character) || character === "_";
		if (first !== ".") this.cursor.readWhile(digits);
		if (
			first === "." ||
			(this.cursor.peek() === "." && !(this.cursor.peek(1) === "." && this.cursor.peek(2) === "."))
		) {
			if (first !== ".") this.cursor.next();
			this.cursor.readWhile(digits);
		}
		const exponent = this.cursor.peek();
		if (exponent === "e" || exponent === "E") {
			const sign = this.cursor.peek(1);
			const digitAt = sign === "+" || sign === "-" ? 2 : 1;
			if (isDigit(this.cursor.peek(digitAt))) {
				for (let index = 0; index < digitAt; index++) this.cursor.next();
				this.cursor.readWhile(digits);
			}
		}
		if (this.cursor.peek() === "j" || this.cursor.peek() === "J") this.cursor.next();
		this.place("NUMBER", start);
	}

	private operator(mode: Extract<Mode, { kind: "code" }>, start: CursorMark): void {
		const character = this.cursor.peek();
		const closer = OPENERS.get(character);
		if (closer !== undefined) {
			this.cursor.next();
			mode.brackets.push(closer);
			this.place("OP", start);
			return;
		}
		if (character === ")" || character === "]" || character === "}") {
			const expected = mode.brackets.pop();
			if (expected === undefined) this.fail("SyntaxError", `unmatched '${character}'`, start.offset);
			if (expected !== character)
				this.fail(
					"SyntaxError",
					`closing parenthesis '${character}' does not match opening parenthesis`,
					start.offset,
				);
			this.cursor.next();
			this.place("OP", start);
			return;
		}
		const operator = OPERATORS.find((candidate) => this.cursor.startsWith(candidate));
		if (operator !== undefined) this.cursor.take(operator);
		else this.cursor.next();
		const written = this.cursor.textSince(start);
		// An ASCII punctuation character is an operator to tokenize; anything else starts no token.
		const known = operator !== undefined || (written.length === 1 && written >= "!" && written <= "~");
		this.place(known ? "OP" : "ERRORTOKEN", start);
	}

	////////////////////////////////
	//  Strings

	private string(start: CursorMark, prefix: string): void {
		const shape = stringPrefix(prefix);
		if (shape === undefined) this.fail("SyntaxError", "invalid string prefix", start.offset);
		const quoteCharacter = this.cursor.peek();
		const quote = this.cursor.startsWith(quoteCharacter.repeat(3)) ? quoteCharacter.repeat(3) : quoteCharacter;
		this.cursor.take(quote);
		if (shape.interpolated || shape.template) {
			this.place(shape.template ? "TSTRING_START" : "FSTRING_START", start);
			this.modes.push({ kind: "string", quote, raw: shape.raw, template: shape.template });
			return;
		}
		let guard = -1;
		while (!this.cursor.take(quote)) {
			if (this.cursor.offset <= guard) throw new Error("python string scan failed to advance");
			guard = this.cursor.offset;
			const character = this.cursor.peek();
			if (character === "" || (quote.length === 1 && isLineBreak(character))) this.unterminated(quote, start);
			this.cursor.next();
			// A backslash keeps the next character in the string, raw or not.
			if (character === "\\" && this.cursor.good()) {
				if (this.cursor.peek() === "\r") this.consumeLineBreak();
				else this.cursor.next();
			}
		}
		this.place("STRING", start);
	}

	private unterminated(quote: string, start: CursorMark): never {
		const line = this.cursor.line + 1;
		const what = quote.length === 3 ? "unterminated triple-quoted string literal" : "unterminated string literal";
		this.fail("TokenError", `${what} (detected at line ${line})`, start.offset);
	}

	/** An interpolated string's text up to a replacement field or its closing quote. */
	private stringText(mode: Extract<Mode, { kind: "string" }>): void {
		const start = this.cursor.mark();
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("python f-string scan failed to advance");
			guard = this.cursor.offset;
			const character = this.cursor.peek();
			if (character === "" || (mode.quote.length === 1 && isLineBreak(character))) {
				const kind = mode.template ? "t-string" : "f-string";
				this.fail(
					"TokenError",
					`unterminated ${kind} literal (detected at line ${this.cursor.line + 1})`,
					start.offset,
				);
			}
			if (this.cursor.startsWith(mode.quote)) {
				this.middle(mode.template, start);
				const end = this.cursor.mark();
				this.cursor.take(mode.quote);
				this.place(mode.template ? "TSTRING_END" : "FSTRING_END", end);
				this.modes.pop();
				return;
			}
			if (character === "{" && this.cursor.peek(1) !== "{") {
				this.middle(mode.template, start);
				this.openField();
				return;
			}
			if ((character === "{" || character === "}") && this.cursor.peek(1) === character) {
				this.cursor.next();
				this.cursor.next();
				continue;
			}
			if (character === "}") this.fail("SyntaxError", "f-string: single '}' is not allowed");
			this.cursor.next();
			if (character !== "\\" || !this.cursor.good()) continue;
			// A backslash keeps the next character in the text, raw or not, unless it is a brace.
			const escaped = this.cursor.peek();
			if (escaped === "{" || escaped === "}") continue;
			// `\N{...}` names a character; its brace opens no field.
			if (!mode.raw && escaped === "N" && this.cursor.peek(1) === "{") {
				this.cursor.readWhile((named) => named !== "}" && !isLineBreak(named));
				this.cursor.take("}");
			} else if (escaped === "\r" && this.cursor.peek(1) === "\n") this.cursor.take("\r\n");
			else this.cursor.next();
		}
	}

	/** A format spec's text, up to a nested field or the `}` closing its own. */
	private specText(mode: Extract<Mode, { kind: "spec" }>): void {
		const start = this.cursor.mark();
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("python format spec scan failed to advance");
			guard = this.cursor.offset;
			const character = this.cursor.peek();
			if (character === "" || (mode.string.quote.length === 1 && isLineBreak(character)))
				this.fail("SyntaxError", "f-string: expecting '}'", start.offset);
			if (character === "{") {
				this.middle(mode.string.template, start);
				if (this.specDepth() >= MAX_SPEC_NESTING) {
					this.fail("SyntaxError", "f-string: expressions nested too deeply", this.cursor.offset);
				}
				this.openField();
				return;
			}
			if (character === "}") {
				this.middle(mode.string.template, start);
				// The spec ends, and the field it belongs to with it.
				this.modes.pop();
				const close = this.cursor.mark();
				this.cursor.next();
				this.place("OP", close);
				this.modes.pop();
				return;
			}
			this.cursor.next();
		}
	}

	/** Format specs open inside the innermost interpolated string. */
	private specDepth(): number {
		let depth = 0;
		for (let index = this.modes.length - 1; index >= 0; index--) {
			const mode = this.modes[index] as Mode;
			if (mode.kind === "string") break;
			if (mode.kind === "spec") depth++;
		}
		return depth;
	}

	private middle(template: boolean, start: CursorMark): void {
		if (this.cursor.offset > start.offset) this.place(template ? "TSTRING_MIDDLE" : "FSTRING_MIDDLE", start);
	}

	private openField(): void {
		const start = this.cursor.mark();
		this.cursor.next();
		this.place("OP", start);
		this.modes.push({ kind: "code", brackets: [], field: true });
	}

	/** At a field's own depth, `}` closes it, `:` opens its format spec, and `!` its conversion. */
	private fieldBoundary(character: string, start: CursorMark): boolean {
		if (character === "}") {
			this.cursor.next();
			this.place("OP", start);
			this.modes.pop();
			return true;
		}
		// `{x:=5}` is `x` with the format spec `=5`; a walrus needs parentheses here.
		if (character === ":") {
			this.cursor.next();
			this.place("OP", start);
			const owner = this.modes[this.modes.length - 2];
			const string = owner?.kind === "spec" ? owner.string : owner?.kind === "string" ? owner : undefined;
			if (string === undefined) throw new Error("python format spec outside an f-string");
			this.modes.push({
				kind: "spec",
				string: { quote: string.quote, raw: string.raw, template: string.template },
			});
			return true;
		}
		if (character === "!" && this.cursor.peek(1) !== "=") {
			this.cursor.next();
			this.place("OP", start);
			return true;
		}
		return false;
	}
}

////////////////////////////////
//  Main

/** Every token of `text`, or those read before the first error. */
export function tokenize(text: string): Lexed {
	return new Tokenizer(text).lex();
}
