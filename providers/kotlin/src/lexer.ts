// Kotlin tokens per the language specification's lexical grammar, read through one SourceCursor.
//
// Strings arrive whole, their parts and templates inside, so the parser never meets a quote.

import { type CursorMark, isTooDeep, NestingGauge, SourceCursor, TOO_DEEP } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export type TokenKind =
	/** Plain or backticked; soft keywords and modifiers included. */
	| "identifier"
	| "keyword"
	| "number"
	| "float"
	| "char"
	| "string"
	/** A label definition, `name@`. */
	| "label"
	/** `return@`, `break@`, `continue@`, `this@` or `super@`, its label following. */
	| "jump"
	| "punct"
	| "eof";

export type StringPart =
	| { kind: "content"; start: number; end: number }
	| { kind: "escape"; start: number; end: number }
	/** `$name`: the dollars, then the name. */
	| { kind: "name"; start: number; end: number; name: Token }
	/** `${ ... }`: its tokens, and the closer when there is one. */
	| { kind: "expression"; start: number; end: number; openEnd: number; tokens: Token[]; closed: boolean };

export interface Token {
	kind: TokenKind;
	text: string;
	start: number;
	end: number;
	/** Where `start` sits: 0-based line, UTF-16 column. */
	line: number;
	column: number;
	/** A line break separates it from the previous token, outside comments. */
	newlineBefore: boolean;
	/** Whitespace or a comment separates it from the previous token. */
	spaceBefore: boolean;
	/** A string's or character's parts, between its quotes. */
	parts?: StringPart[];
	/** A string's opener (`"`, `"""`, `$$"`) and closer; the closer is empty when unterminated. */
	opener?: string;
	closer?: string;
}

export interface Comment {
	type: "line_comment" | "block_comment" | "shebang";
	start: number;
	end: number;
	/** False for a block comment the text never closes. */
	closed: boolean;
	/** A line break separates it from the token before it. */
	newlineBefore: boolean;
}

export interface LexProblem {
	message: string;
	start: number;
	end: number;
}

export interface Lexed {
	tokens: Token[];
	comments: Comment[];
	problems: LexProblem[];
}

////////////////////////////////
//  Constants

export const HARD_KEYWORDS: ReadonlySet<string> = new Set([
	"as",
	"break",
	"class",
	"continue",
	"do",
	"else",
	"false",
	"for",
	"fun",
	"if",
	"in",
	"interface",
	"is",
	"null",
	"object",
	"package",
	"return",
	"super",
	"this",
	"throw",
	"true",
	"try",
	"typealias",
	"typeof",
	"val",
	"var",
	"when",
	"while",
]);

const JUMP_WORDS: ReadonlySet<string> = new Set(["return", "break", "continue", "this", "super"]);

/** Longest first. */
const PUNCTUATION = [
	"===",
	"!==",
	"...",
	"..<",
	"&&",
	"||",
	"++",
	"--",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"->",
	"=>",
	"==",
	"!=",
	"<=",
	">=",
	"::",
	"..",
	".",
	",",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
	"*",
	"%",
	"/",
	"+",
	"-",
	"!",
	":",
	";",
	"=",
	"<",
	">",
	"?",
	"@",
	"#",
	"&",
];

const ESCAPED = new Set(["t", "b", "r", "n", "'", '"', "\\", "$"]);

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

////////////////////////////////
//  Functions & Helpers

export function isIdentifierStart(character: string): boolean {
	return character === "_" || /^[\p{L}\p{Nl}]$/u.test(character);
}

export function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || /^[\p{Nd}\p{Mn}\p{Mc}]$/u.test(character);
}

function isDigit(character: string): boolean {
	return character >= "0" && character <= "9";
}

function isHexDigit(character: string): boolean {
	return /^[0-9A-Fa-f]$/u.test(character);
}

function isInlineSpace(character: string): boolean {
	return character === " " || character === "\t" || character === "\f";
}

////////////////////////////////
//  Classes

class KotlinLexer {
	private readonly cursor: SourceCursor;
	private readonly comments: Comment[] = [];
	private readonly problems: LexProblem[] = [];
	/** Templates nest inside strings inside templates. */
	private readonly gauge = new NestingGauge();

	constructor(text: string) {
		this.cursor = new SourceCursor(text);
	}

	lex(): Lexed {
		if (this.cursor.peek() === BYTE_ORDER_MARK) this.cursor.next();
		if (this.cursor.startsWith("#!")) {
			const start = this.cursor.offset;
			this.cursor.readWhile((character) => character !== "\n" && character !== "\r");
			this.comments.push({ type: "shebang", start, end: this.cursor.offset, closed: true, newlineBefore: false });
		}
		try {
			const tokens = this.tokens(false);
			return { tokens, comments: this.comments, problems: this.problems };
		} catch (error) {
			if (!isTooDeep(error)) throw error;
			const at = this.cursor.offset;
			this.problems.push({ message: TOO_DEEP, start: at, end: at });
			this.cursor.readWhile(() => true);
			return {
				tokens: [this.token("eof", this.cursor.mark(), false, false)],
				comments: [],
				problems: this.problems,
			};
		}
	}

	/** Tokens to the end, or to a template's closing brace when `template`. */
	private tokens(template: boolean): Token[] {
		const tokens: Token[] = [];
		let depth = 0;
		// Line breaks inside `(` or `[` are insignificant; `{` makes them count again.
		const inside: boolean[] = [];
		let guard = -1;
		for (;;) {
			const { newline, space } = this.trivia();
			const from = this.cursor.mark();
			// A template's tokens end in an eof at its closing brace.
			if (!this.cursor.good() || (template && this.cursor.peek() === "}" && depth === 0)) {
				tokens.push(this.token("eof", from, newline, space));
				return tokens;
			}
			if (from.offset <= guard) throw new Error("Kotlin lexer failed to advance");
			guard = from.offset;
			const token = this.next(newline && inside.at(-1) !== true, space);
			if (token.kind === "punct") {
				if (token.text === "(" || token.text === "[") inside.push(true);
				else if (token.text === "{") inside.push(false);
				else if (token.text === ")" || token.text === "]" || token.text === "}") inside.pop();
			}
			if (template && token.kind === "punct") {
				if (token.text === "{") depth++;
				else if (token.text === "}") depth--;
			}
			tokens.push(token);
		}
	}

	/** Skips whitespace and comments; reports whether a line break or any space passed. */
	private trivia(): { newline: boolean; space: boolean } {
		let newline = false;
		let space = false;
		let guard = -1;
		while (this.cursor.good()) {
			if (this.cursor.offset <= guard) throw new Error("Kotlin trivia scan failed to advance");
			guard = this.cursor.offset;
			const character = this.cursor.peek();
			if (character === "\n" || character === "\r") {
				this.cursor.next();
				newline = true;
				space = true;
			} else if (isInlineSpace(character)) {
				this.cursor.next();
				space = true;
			} else if (this.cursor.startsWith("//")) {
				const start = this.cursor.offset;
				this.cursor.readWhile((next) => next !== "\n" && next !== "\r");
				this.comments.push({
					type: "line_comment",
					start,
					end: this.cursor.offset,
					closed: true,
					newlineBefore: newline,
				});
				space = true;
			} else if (this.cursor.startsWith("/*")) {
				// A line break inside the comment still separates what it sits between.
				if (this.blockComment(newline)) newline = true;
				space = true;
			} else {
				break;
			}
		}
		return { newline, space };
	}

	/** Block comments nest. Answers whether the comment holds a line break. */
	private blockComment(newlineBefore: boolean): boolean {
		const start = this.cursor.offset;
		const line = this.cursor.line;
		this.cursor.take("/*");
		let depth = 1;
		let broken = false;
		let guard = -1;
		while (this.cursor.good() && depth > 0) {
			if (this.cursor.offset <= guard) throw new Error("Kotlin comment scan failed to advance");
			guard = this.cursor.offset;
			if (this.cursor.take("/*")) depth++;
			else if (this.cursor.take("*/")) depth--;
			else if (this.cursor.next() === "\r") broken = true;
		}
		const closed = depth === 0;
		if (!closed) this.problems.push({ message: "block comment is not closed", start, end: this.cursor.offset });
		this.comments.push({ type: "block_comment", start, end: this.cursor.offset, closed, newlineBefore });
		return broken || this.cursor.line > line;
	}

	private token(
		kind: TokenKind,
		from: CursorMark,
		newlineBefore: boolean,
		spaceBefore: boolean,
		extra: Partial<Token> = {},
	): Token {
		return {
			kind,
			text: this.cursor.textSince(from),
			start: from.offset,
			end: this.cursor.offset,
			line: from.line,
			column: from.column,
			newlineBefore,
			spaceBefore,
			...extra,
		};
	}

	private next(newline: boolean, space: boolean): Token {
		const from = this.cursor.mark();
		const character = this.cursor.peek();
		if (character === '"' || (character === "$" && this.dollarsThenQuote())) return this.string(newline, space);
		if (character === "'") return this.character(newline, space);
		if (character === "`") return this.backticked(newline, space);
		if (isDigit(character) || (character === "." && isDigit(this.cursor.peek(1)))) {
			return this.number(newline, space);
		}
		if (isIdentifierStart(character)) return this.word(newline, space);
		if (character === "!" && (this.notWord("!in") || this.notWord("!is"))) {
			this.cursor.take(this.cursor.startsWith("!in") ? "!in" : "!is");
			return this.token("keyword", from, newline, space);
		}
		for (const punctuation of PUNCTUATION) {
			if (this.cursor.take(punctuation)) return this.token("punct", from, newline, space);
		}
		this.cursor.next();
		this.problems.push({
			message: `unexpected character ${JSON.stringify(character)}`,
			start: from.offset,
			end: this.cursor.offset,
		});
		return this.token("punct", from, newline, space);
	}

	/** `!in` or `!is` not continuing into a longer word. */
	private notWord(word: string): boolean {
		return this.cursor.startsWith(word) && !isIdentifierPart(this.cursor.peek(word.length));
	}

	/** A run of dollars opening a string: a multi-dollar prefix. */
	private dollarsThenQuote(): boolean {
		let ahead = 0;
		while (this.cursor.peek(ahead) === "$") ahead++;
		return ahead > 0 && this.cursor.peek(ahead) === '"';
	}

	private word(newline: boolean, space: boolean): Token {
		const from = this.cursor.mark();
		this.cursor.next();
		this.cursor.readWhile(isIdentifierPart);
		const word = this.cursor.textSince(from);
		if (this.cursor.peek() === "@" && JUMP_WORDS.has(word)) {
			this.cursor.next();
			return this.token("jump", from, newline, space);
		}
		if (this.cursor.peek() === "@" && !HARD_KEYWORDS.has(word)) {
			this.cursor.next();
			return this.token("label", from, newline, space);
		}
		if (word === "as" && this.cursor.peek() === "?") {
			this.cursor.next();
			return this.token("keyword", from, newline, space);
		}
		return this.token(HARD_KEYWORDS.has(word) ? "keyword" : "identifier", from, newline, space);
	}

	private backticked(newline: boolean, space: boolean): Token {
		const from = this.cursor.mark();
		this.cursor.next();
		this.cursor.readWhile((character) => character !== "`" && character !== "\n" && character !== "\r");
		if (!this.cursor.take("`")) {
			this.problems.push({
				message: "backticked name is not closed",
				start: from.offset,
				end: this.cursor.offset,
			});
		}
		if (this.cursor.peek() === "@") {
			this.cursor.next();
			return this.token("label", from, newline, space);
		}
		return this.token("identifier", from, newline, space);
	}

	private number(newline: boolean, space: boolean): Token {
		const from = this.cursor.mark();
		if (this.cursor.peek() === "0" && /^[xXbB]$/u.test(this.cursor.peek(1))) {
			const hex = /^[xX]$/u.test(this.cursor.peek(1));
			this.cursor.next();
			this.cursor.next();
			this.digits(hex ? isHexDigit : (character) => character === "0" || character === "1");
			this.integerSuffix();
			return this.token("number", from, newline, space);
		}
		let float = false;
		this.digits(isDigit);
		if (this.cursor.peek() === "." && isDigit(this.cursor.peek(1))) {
			float = true;
			this.cursor.next();
			this.digits(isDigit);
		}
		if (/^[eE]$/u.test(this.cursor.peek())) {
			const sign = this.cursor.peek(1) === "+" || this.cursor.peek(1) === "-" ? 1 : 0;
			if (isDigit(this.cursor.peek(1 + sign)) || this.cursor.peek(1 + sign) === "_") {
				float = true;
				this.cursor.next();
				if (sign === 1) this.cursor.next();
				this.digits(isDigit);
			}
		}
		if (/^[fF]$/u.test(this.cursor.peek())) {
			this.cursor.next();
			return this.token("float", from, newline, space);
		}
		if (float) return this.token("float", from, newline, space);
		this.integerSuffix();
		return this.token("number", from, newline, space);
	}

	/** A digit run: underscores only between digits, at least one digit. */
	private digits(accept: (character: string) => boolean): void {
		const start = this.cursor.offset;
		const run = this.cursor.readWhile((character) => character === "_" || accept(character));
		if (run === "" || run.startsWith("_") || run.endsWith("_"))
			this.problems.push({
				message: "a number needs digits on both sides of each _",
				start,
				end: this.cursor.offset,
			});
	}

	private integerSuffix(): void {
		if (/^[uU]$/u.test(this.cursor.peek())) this.cursor.next();
		if (/^[lL]$/u.test(this.cursor.peek())) this.cursor.next();
	}

	private character(newline: boolean, space: boolean): Token {
		const from = this.cursor.mark();
		this.cursor.next();
		const parts: StringPart[] = [];
		const bodyStart = this.cursor.offset;
		if (this.cursor.peek() === "\\") {
			parts.push(this.escape());
		} else if (this.cursor.peek() !== "'" && this.cursor.peek() !== "\n" && this.cursor.peek() !== "") {
			this.cursor.next();
			parts.push({ kind: "content", start: bodyStart, end: this.cursor.offset });
		}
		const closed = this.cursor.take("'");
		if (!closed) {
			this.problems.push({
				message: "character literal is not closed",
				start: from.offset,
				end: this.cursor.offset,
			});
		} else if (parts.length === 0) {
			this.problems.push({
				message: "character literal holds no character",
				start: from.offset,
				end: this.cursor.offset,
			});
		}
		return this.token("char", from, newline, space, { parts, opener: "'", closer: closed ? "'" : "" });
	}

	/** One escape: a known character, or `\u` and four hex digits. */
	private escape(): StringPart {
		const start = this.cursor.offset;
		this.cursor.next();
		const next = this.cursor.peek();
		if (next === "u" && [1, 2, 3, 4].every((ahead) => isHexDigit(this.cursor.peek(ahead)))) {
			for (let count = 0; count < 5; count++) this.cursor.next();
		} else if (ESCAPED.has(next)) {
			this.cursor.next();
		} else {
			this.problems.push({ message: `illegal escape \\${next}`, start, end: this.cursor.offset + next.length });
			if (next !== "" && next !== "\n") this.cursor.next();
		}
		return { kind: "escape", start, end: this.cursor.offset };
	}

	private string(newline: boolean, space: boolean): Token {
		const from = this.cursor.mark();
		const start = from.offset;
		const dollars = this.cursor.readWhile((character) => character === "$").length;
		const interpolation = Math.max(1, dollars);
		const raw = this.cursor.startsWith('"""');
		this.cursor.take(raw ? '"""' : '"');
		const opener = this.cursor.textSince(from);
		const parts: StringPart[] = [];
		let contentStart = this.cursor.offset;
		const flush = () => {
			if (this.cursor.offset > contentStart) {
				parts.push({ kind: "content", start: contentStart, end: this.cursor.offset });
			}
		};
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("Kotlin string scan failed to advance");
			guard = this.cursor.offset;
			const character = this.cursor.peek();
			if (character === "" || (!raw && (character === "\n" || character === "\r"))) {
				flush();
				this.problems.push({ message: "string literal is not closed", start, end: this.cursor.offset });
				return this.token("string", from, newline, space, { parts, opener, closer: "" });
			}
			if (raw && this.closesRaw()) {
				// Quotes before the final three are content.
				while (!this.cursor.startsWith('"""') || this.cursor.startsWith('""""')) this.cursor.next();
				flush();
				const closerFrom = this.cursor.mark();
				this.cursor.take('"""');
				return this.token("string", from, newline, space, {
					parts,
					opener,
					closer: this.cursor.textSince(closerFrom),
				});
			}
			if (!raw && character === '"') {
				flush();
				this.cursor.next();
				return this.token("string", from, newline, space, { parts, opener, closer: '"' });
			}
			if (!raw && character === "\\") {
				flush();
				parts.push(this.escape());
				contentStart = this.cursor.offset;
				continue;
			}
			if (character === "$" && this.templateAhead(interpolation)) {
				flush();
				parts.push(this.template(interpolation));
				contentStart = this.cursor.offset;
				continue;
			}
			if (character === "$" && !raw) {
				// A line string's bare `$` is its own content piece.
				flush();
				const dollar = this.cursor.offset;
				this.cursor.next();
				parts.push({ kind: "content", start: dollar, end: this.cursor.offset });
				contentStart = this.cursor.offset;
				continue;
			}
			this.cursor.next();
		}
	}

	/** A raw string's closing quotes: three or more at the cursor. */
	private closesRaw(): boolean {
		return this.cursor.startsWith('"""');
	}

	/** Exactly `dollars` dollars, then a name start or a brace. */
	private templateAhead(dollars: number): boolean {
		for (let ahead = 0; ahead < dollars; ahead++) if (this.cursor.peek(ahead) !== "$") return false;
		const next = this.cursor.peek(dollars);
		return next === "{" || next === "`" || isIdentifierStart(next);
	}

	private template(dollars: number): StringPart {
		const start = this.cursor.offset;
		for (let count = 0; count < dollars; count++) this.cursor.next();
		if (this.cursor.peek() === "{") {
			this.cursor.next();
			const openEnd = this.cursor.offset;
			this.gauge.open();
			const tokens = this.tokens(true);
			this.gauge.close();
			const closed = this.cursor.take("}");
			if (!closed) this.problems.push({ message: "template is not closed", start, end: this.cursor.offset });
			return { kind: "expression", start, end: this.cursor.offset, openEnd, tokens, closed };
		}
		const nameFrom = this.cursor.mark();
		if (this.cursor.peek() === "`") {
			this.cursor.next();
			this.cursor.readWhile((character) => character !== "`" && character !== "\n" && character !== "\r");
			if (!this.cursor.take("`"))
				this.problems.push({
					message: "backticked name is not closed",
					start: nameFrom.offset,
					end: this.cursor.offset,
				});
		} else {
			this.cursor.next();
			this.cursor.readWhile((character) => isIdentifierPart(character));
		}
		const word = this.cursor.textSince(nameFrom);
		const name = this.token(HARD_KEYWORDS.has(word) ? "keyword" : "identifier", nameFrom, false, false);
		return { kind: "name", start, end: this.cursor.offset, name };
	}
}

////////////////////////////////
//  Functions

export function lexKotlin(text: string): Lexed {
	return new KotlinLexer(text).lex();
}

/** Every token's extent in source order, a string's quotes, parts and template tokens apart. */
export function codeSpans(tokens: readonly Token[]): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = [];
	for (const token of tokens) {
		if (token.end === token.start) continue;
		if (token.kind !== "string") {
			spans.push({ start: token.start, end: token.end });
			continue;
		}
		const opener = token.opener ?? "";
		const closer = token.closer ?? "";
		spans.push({ start: token.start, end: token.start + opener.length });
		for (const part of token.parts ?? []) {
			if (part.kind !== "expression") {
				spans.push({ start: part.start, end: part.end });
				continue;
			}
			spans.push({ start: part.start, end: part.openEnd });
			spans.push(...codeSpans(part.tokens));
			if (part.closed) spans.push({ start: part.end - 1, end: part.end });
		}
		if (closer !== "") spans.push({ start: token.end - closer.length, end: token.end });
	}
	return spans;
}
