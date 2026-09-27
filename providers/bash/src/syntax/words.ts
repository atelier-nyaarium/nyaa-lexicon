// Words and their parts: quotes, escapes and every expansion, each with its span.

import { type CursorMark, SourceCursor } from "@nyaa-lexicon/protocol";
import type {
	AnsiCQuotedPart,
	ArithmeticExpression,
	BraceExpansionPart,
	DoubleQuotedChild,
	ExtendedGlobPart,
	ExtGlobOperator,
	ParameterExpansionPart,
	Script,
	Span,
	Token,
	Word,
	WordPart,
} from "./ast.js";
import { isDigit, isMeta, isNameCharacter, isNameStart, type Scanner } from "./scanner.js";

////////////////////////////////
//  Interfaces & Types

/** What reads inside a word and is not a word: a nested script, arithmetic, decoded backquote text. */
export interface Nested {
	/** Statements up to the `)` closing a substitution, which is left unread. */
	subscript(): Script;
	/** Arithmetic up to `close`, which is left unread. */
	arithmetic(close: string): ArithmeticExpression | undefined;
	/** A script read apart, over text a backquote's escapes were removed from; `source` places its errors. */
	decoded(text: string, source: (offset: number) => number): { script: Script; tokens: Token[] };
}

/** Where a word ends besides a metacharacter. */
export interface WordStops {
	/** Characters that end the word, blanks included, instead of metacharacters. */
	only?: ReadonlySet<string>;
	/** `NAME=(` reads the parenthesized list as part of the word. */
	arrayValue?: boolean;
	/** Braces and extended globs stay literal: an operand, a subscript or a regular expression. */
	plainGlobs?: boolean;
}

/** A backquote's text with its escapes removed, and where each character came from. */
interface Decoded {
	text: string;
	/** Source offset of each decoded character, and of the closing backquote at the end. */
	starts: number[];
	/** Where each of `starts` sits, line and column included. */
	marks: CursorMark[];
	/** Source offset after each decoded character, indexed by the decoded end. */
	ends: number[];
}

////////////////////////////////
//  Constants

const SPECIAL_PARAMETERS: ReadonlySet<string> = new Set(["@", "*", "#", "?", "-", "$", "!", "0"]);
const EXTGLOB: ReadonlySet<string> = new Set(["?", "*", "+", "@", "!"]);
const ANSI_ESCAPES: Readonly<Record<string, string>> = {
	a: "\u0007",
	b: "\b",
	e: "\u001b",
	E: "\u001b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	"'": "'",
	'"': '"',
	"?": "?",
};
const OPERAND_STOP: WordStops = { only: new Set(["}"]), plainGlobs: true };
const SLICE_STOP: WordStops = { only: new Set(["}", ":"]), plainGlobs: true };
const PATTERN_STOP: WordStops = { only: new Set(["}", "/"]), plainGlobs: true };
const LIST_STOP: ReadonlySet<string> = new Set([")", "("]);
/** Operators after a parameter, longest first. */
const PARAMETER_OPERATORS = [
	":-",
	":=",
	":?",
	":+",
	"##",
	"%%",
	"//",
	"/#",
	"/%",
	"^^",
	",,",
	"-",
	"=",
	"?",
	"+",
	"#",
	"%",
	"/",
	"^",
	",",
	"@",
];

////////////////////////////////
//  Functions & Helpers

function isHexDigit(character: string): boolean {
	return isDigit(character) || (character >= "a" && character <= "f") || (character >= "A" && character <= "F");
}

function isOctalDigit(character: string): boolean {
	return character >= "0" && character <= "7";
}

/** Only literal characters: the word needs no parts. */
function plain(parts: WordPart[]): boolean {
	return parts.every((part) => part.type === "Literal");
}

////////////////////////////////
//  Classes

export class WordReader {
	constructor(
		private readonly scanner: Scanner,
		private readonly nested: Nested,
	) {}

	/** Whether a word starts here in command position. */
	startsWord(): boolean {
		const character = this.scanner.peek();
		if (character === "") return false;
		if ((character === "<" || character === ">") && this.scanner.peek(1) === "(") return true;
		return !isMeta(character);
	}

	/** An unquoted word, read to the next metacharacter or stop. */
	word(stops: WordStops = {}): Word {
		const pos = this.scanner.offset;
		const parts: WordPart[] = [];
		let value = "";
		let guard = -1;
		while (!this.scanner.done) {
			if (this.scanner.offset <= guard) throw new Error("bash word read failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (stops.arrayValue === true && character === "(" && this.assignmentHead(parts)) {
				value += this.listValue(parts);
				continue;
			}
			if (this.ends(character, stops)) break;
			const part = this.part(stops);
			if (part === null) break;
			joined(parts, part);
			value += partValue(part);
		}
		return this.made(pos, parts, value);
	}

	/**
	 * A word to the end of a here-document body: only `$`, backquotes and some escapes are special.
	 * With `strip`, each line's leading tabs are text but no value.
	 */
	heredocBody(end: number, strip: boolean): Word {
		const pos = this.scanner.offset;
		const parts: WordPart[] = [];
		let value = "";
		let literal: { pos: number; text: string; value: string } | null = null;
		const close = (at: number): void => {
			if (literal === null) return;
			parts.push({ type: "Literal", pos: literal.pos, end: at, text: literal.text, value: literal.value });
			value += literal.value;
			literal = null;
		};
		let lineStart = true;
		let guard = -1;
		while (this.scanner.offset < end) {
			if (this.scanner.offset <= guard) throw new Error("bash here-document read failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (strip && lineStart && character === "\t") {
				literal ??= { pos: this.scanner.offset, text: "", value: "" };
				literal.text += this.scanner.codeWhile((tab) => tab === "\t");
				continue;
			}
			lineStart = false;
			if (character === "$" || character === "`") {
				const at = this.scanner.offset;
				const expansion = character === "$" ? this.dollar(false) : this.backquote(false);
				if (expansion !== null) {
					close(at);
					parts.push(expansion);
					value += partValue(expansion);
					continue;
				}
			}
			literal ??= { pos: this.scanner.offset, text: "", value: "" };
			if (character === "\\" && ["$", "`", "\\", "\n"].includes(this.scanner.peek(1))) {
				literal.text += this.scanner.code();
				const escaped = this.scanner.code();
				literal.text += escaped;
				if (escaped !== "\n") literal.value += escaped;
				lineStart = escaped === "\n";
				continue;
			}
			const taken = this.scanner.code();
			literal.text += taken;
			literal.value += taken;
			lineStart = taken === "\n";
		}
		close(this.scanner.offset);
		return { pos, end: this.scanner.offset, text: this.scanner.textOf(pos), value, parts };
	}

	private made(pos: number, parts: WordPart[], value: string): Word {
		const end = this.scanner.offset;
		const text = this.scanner.textOf(pos, end);
		const word: Word = { pos, end, text, value, parts };
		if (plain(parts)) delete (word as { parts?: WordPart[] }).parts;
		return word;
	}

	private ends(character: string, stops: WordStops): boolean {
		if (stops.only !== undefined) return stops.only.has(character) || character === "";
		if ((character === "<" || character === ">") && this.scanner.peek(1) === "(") return false;
		return isMeta(character);
	}

	/** The word's parts so far spell `NAME=`, `NAME+=` or `NAME[...]=`; only the subscript may expand. */
	private assignmentHead(parts: readonly WordPart[]): boolean {
		if (parts.at(-1)?.end !== this.scanner.offset) return false;
		// Each part other than plain text stands as one character no name or operator uses.
		const shape = new SourceCursor(parts.map((part) => (part.type === "Literal" ? part.text : "\u0000")).join(""));
		if (!isNameStart(shape.peek())) return false;
		shape.readWhile(isNameCharacter);
		if (shape.peek() === "[") {
			shape.readWhile((character) => character !== "]");
			if (shape.next() !== "]") return false;
		}
		if (shape.peek() === "+") shape.next();
		return shape.next() === "=" && !shape.good();
	}

	/** `NAME=(...)` inside an argument: the list's text and expansions join the word's parts. */
	private listValue(parts: WordPart[]): string {
		const pos = this.scanner.offset;
		let value = "";
		const plainCharacter = (): void => {
			const at = this.scanner.offset;
			const taken = this.scanner.code();
			joined(parts, { type: "Literal", pos: at, end: this.scanner.offset, text: taken, value: taken });
			value += taken;
		};
		plainCharacter();
		let depth = 1;
		let guard = -1;
		while (!this.scanner.done && depth > 0) {
			if (this.scanner.offset <= guard) throw new Error("bash array value read failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (character === "(") depth++;
			if (character === ")") depth--;
			if (
				character === "'" ||
				character === '"' ||
				character === "$" ||
				character === "`" ||
				character === "\\"
			) {
				// Read whole so a quoted `)` stays inside.
				const part = this.part({ only: LIST_STOP, plainGlobs: true });
				if (part !== null) {
					joined(parts, part);
					value += partValue(part);
					continue;
				}
			}
			plainCharacter();
		}
		if (depth > 0) this.scanner.error("the array value has no closing )", pos);
		return value;
	}

	/** One part at the cursor, or null when nothing a word holds starts here. */
	private part(stops: WordStops): WordPart | null {
		const character = this.scanner.peek();
		const next = this.scanner.peek(1);
		switch (character) {
			case "'":
				return this.singleQuoted();
			case '"':
				return this.doubleQuoted();
			case "$":
				return this.dollar(true) ?? this.literal(stops);
			case "`":
				return this.backquote(false) ?? this.literal(stops);
			case "<":
			case ">":
				if (next === "(") return this.processSubstitution();
				break;
			case "{":
				return (stops.plainGlobs === true ? null : this.brace()) ?? this.literal(stops);
		}
		if (stops.plainGlobs !== true && EXTGLOB.has(character) && next === "(") return this.extglob();
		return this.literal(stops);
	}

	/** Plain characters and escapes, up to anything else a word holds. */
	private literal(stops: WordStops): WordPart | null {
		const pos = this.scanner.offset;
		let text = "";
		let value = "";
		let guard = -1;
		while (!this.scanner.done) {
			if (this.scanner.offset <= guard) throw new Error("bash literal read failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (this.scanner.offset > pos && this.special(character, stops)) break;
			if (this.ends(character, stops)) break;
			if (character === "\\") {
				if (this.scanner.atContinuation()) {
					this.scanner.continuation();
					text += "\\\n";
					continue;
				}
				text += this.scanner.code();
				if (this.scanner.done) break;
				const escaped = this.scanner.code();
				text += escaped;
				value += escaped;
				continue;
			}
			const taken = this.scanner.code();
			text += taken;
			value += taken;
		}
		if (this.scanner.offset === pos) return null;
		return { type: "Literal", pos, end: this.scanner.offset, text, value };
	}

	/** A character that may open a part of its own. */
	private special(character: string, stops: WordStops): boolean {
		const next = this.scanner.peek(1);
		if (character === "'" || character === '"' || character === "$" || character === "`") return true;
		if ((character === "<" || character === ">") && next === "(") return true;
		if (stops.plainGlobs === true) return false;
		return character === "{" || (EXTGLOB.has(character) && next === "(");
	}

	private singleQuoted(): WordPart {
		const pos = this.scanner.offset;
		this.scanner.code();
		const value = this.scanner.codeWhile((character) => character !== "'");
		if (!this.scanner.codeText("'")) this.scanner.error("the single quote has no closing quote", pos);
		const end = this.scanner.offset;
		return { type: "SingleQuoted", pos, end, text: this.scanner.textOf(pos, end), value };
	}

	private doubleQuoted(): WordPart {
		const pos = this.scanner.offset;
		this.scanner.code();
		const parts = this.quotedChildren();
		if (!this.scanner.codeText('"')) this.scanner.error("the double quote has no closing quote", pos);
		const end = this.scanner.offset;
		return { type: "DoubleQuoted", pos, end, text: this.scanner.textOf(pos, end), parts };
	}

	/** Inside `"..."`: literal runs and expansions up to the closing quote. */
	private quotedChildren(): DoubleQuotedChild[] {
		const children: DoubleQuotedChild[] = [];
		let literal: { pos: number; text: string; value: string } | null = null;
		const close = (at: number): void => {
			if (literal === null) return;
			children.push({ type: "Literal", pos: literal.pos, end: at, text: literal.text, value: literal.value });
			literal = null;
		};
		let guard = -1;
		while (!this.scanner.done && this.scanner.peek() !== '"') {
			if (this.scanner.offset <= guard) throw new Error("bash quoted read failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (character === "$" || character === "`") {
				const at = this.scanner.offset;
				const expansion = character === "$" ? this.dollar(false) : this.backquote(true);
				if (expansion !== null) {
					close(at);
					children.push(expansion as DoubleQuotedChild);
					continue;
				}
			}
			literal ??= { pos: this.scanner.offset, text: "", value: "" };
			if (character === "\\") {
				if (this.scanner.atContinuation()) {
					this.scanner.continuation();
					literal.text += "\\\n";
					continue;
				}
				const escaped = this.scanner.peek(1);
				literal.text += this.scanner.code();
				if (["$", "`", '"', "\\"].includes(escaped)) {
					literal.text += this.scanner.code();
					literal.value += escaped;
				} else literal.value += "\\";
				continue;
			}
			const taken = this.scanner.code();
			literal.text += taken;
			literal.value += taken;
		}
		close(this.scanner.offset);
		// `""` still holds one empty text run.
		if (children.length === 0) {
			const at = this.scanner.offset;
			children.push({ type: "Literal", pos: at, end: at, text: "", value: "" });
		}
		return children;
	}

	/** A `$` opening an expansion or a quote; null for a `$` that is literal. */
	private dollar(quotes: boolean): WordPart | null {
		const pos = this.scanner.offset;
		const next = this.scanner.peek(1);
		if (quotes && next === "'") return this.ansiC();
		if (quotes && next === '"') {
			this.scanner.code();
			this.scanner.code();
			const parts = this.quotedChildren();
			if (!this.scanner.codeText('"')) this.scanner.error("the locale string has no closing quote", pos);
			const end = this.scanner.offset;
			return { type: "LocaleString", pos, end, text: this.scanner.textOf(pos, end), parts };
		}
		if (next === "(" && this.scanner.peek(2) === "(") return this.arithmeticExpansion();
		if (next === "(") return this.commandExpansion();
		if (next === "{") return this.scanner.nested(() => this.parameterExpansion());
		if (isNameStart(next)) {
			this.scanner.code();
			const namePos = this.scanner.offset;
			this.scanner.codeWhile(isNameCharacter);
			return this.simple(pos, namePos);
		}
		if (isDigit(next) || SPECIAL_PARAMETERS.has(next)) {
			this.scanner.code();
			const namePos = this.scanner.offset;
			this.scanner.code();
			return this.simple(pos, namePos);
		}
		return null;
	}

	private simple(pos: number, namePos: number): WordPart {
		const end = this.scanner.offset;
		return {
			type: "SimpleExpansion",
			pos,
			end,
			text: this.scanner.textOf(pos, end),
			name: { pos: namePos, end },
		};
	}

	private ansiC(): AnsiCQuotedPart {
		const pos = this.scanner.offset;
		this.scanner.code();
		this.scanner.code();
		let value = "";
		let guard = -1;
		while (!this.scanner.done && this.scanner.peek() !== "'") {
			if (this.scanner.offset <= guard) throw new Error("bash ANSI-C read failed to advance");
			guard = this.scanner.offset;
			if (this.scanner.peek() !== "\\") {
				value += this.scanner.code();
				continue;
			}
			this.scanner.code();
			value += this.ansiEscape();
		}
		if (!this.scanner.codeText("'")) this.scanner.error("the $' quote has no closing quote", pos);
		const end = this.scanner.offset;
		return { type: "AnsiCQuoted", pos, end, text: this.scanner.textOf(pos, end), value };
	}

	/** The escape after a backslash inside `$'...'`. */
	private ansiEscape(): string {
		const character = this.scanner.peek();
		if (character === "") return "\\";
		const known = ANSI_ESCAPES[character];
		if (known !== undefined) {
			this.scanner.code();
			return known;
		}
		if (character === "c") {
			this.scanner.code();
			const control = this.scanner.code();
			return String.fromCharCode(control.toUpperCase().charCodeAt(0) & 0x1f);
		}
		if (isOctalDigit(character)) return this.numeric(8, 3, isOctalDigit);
		if (character === "x") {
			this.scanner.code();
			return this.numeric(16, 2, isHexDigit, "\\x");
		}
		if (character === "u" || character === "U") {
			this.scanner.code();
			return this.numeric(16, character === "u" ? 4 : 8, isHexDigit, `\\${character}`);
		}
		return `\\${this.scanner.code()}`;
	}

	private numeric(radix: number, most: number, accepts: (character: string) => boolean, bare = ""): string {
		let digits = "";
		for (let count = 0; count < most && accepts(this.scanner.peek()); count++) digits += this.scanner.code();
		if (digits === "") return bare;
		return String.fromCodePoint(Number.parseInt(digits, radix) % 0x110000);
	}

	private commandExpansion(): WordPart {
		const pos = this.scanner.offset;
		this.scanner.code();
		this.scanner.code();
		const script = this.nested.subscript();
		if (!this.scanner.codeText(")")) this.scanner.error("the $( has no closing )", pos);
		const end = this.scanner.offset;
		return {
			type: "CommandExpansion",
			pos,
			end,
			text: this.scanner.textOf(pos, end),
			script,
			backquoted: false,
		};
	}

	private processSubstitution(): WordPart {
		const pos = this.scanner.offset;
		const operator = this.scanner.code() as "<" | ">";
		this.scanner.code();
		const script = this.nested.subscript();
		if (!this.scanner.codeText(")")) this.scanner.error(`the ${operator}( has no closing )`, pos);
		const end = this.scanner.offset;
		return { type: "ProcessSubstitution", pos, end, text: this.scanner.textOf(pos, end), operator, script };
	}

	private arithmeticExpansion(): WordPart {
		const pos = this.scanner.offset;
		this.scanner.codeText("$((");
		const expression = this.nested.arithmetic("))");
		if (!this.scanner.codeText("))")) this.scanner.error("the $(( has no closing ))", pos);
		const end = this.scanner.offset;
		return { type: "ArithmeticExpansion", pos, end, text: this.scanner.textOf(pos, end), expression };
	}

	/** A backquoted command, read over its text with the escapes removed. */
	private backquote(inQuotes: boolean): WordPart | null {
		const pos = this.scanner.offset;
		this.scanner.code();
		const decoded = this.decode(inQuotes);
		const closed = this.scanner.peek() === "`";
		const { script, tokens } = this.nested.decoded(decoded.text, (offset) => decoded.starts[offset] ?? pos);
		for (const token of tokens) this.scanner.placeToken(relocated(token, decoded));
		relocate(script, decoded);
		if (closed) this.scanner.code();
		else this.scanner.error("the backquote has no closing backquote", pos);
		const end = this.scanner.offset;
		return {
			type: "CommandExpansion",
			pos,
			end,
			text: this.scanner.textOf(pos, end),
			script,
			backquoted: true,
		};
	}

	/** Reads to the closing backquote without placing tokens; the decoded parse places them. */
	private decode(inQuotes: boolean): Decoded {
		this.scanner.hush();
		const starts: number[] = [];
		const marks: CursorMark[] = [];
		const ends: number[] = [this.scanner.offset];
		let text = "";
		let guard = -1;
		while (!this.scanner.done && this.scanner.peek() !== "`") {
			if (this.scanner.offset <= guard) throw new Error("bash backquote read failed to advance");
			guard = this.scanner.offset;
			const from = this.scanner.cursor.mark();
			const escaped = this.scanner.peek(1);
			if (
				this.scanner.peek() === "\\" &&
				(escaped === "\\" || escaped === "`" || escaped === "$" || (inQuotes && escaped === '"'))
			) {
				// One decoded character from two source characters.
				this.scanner.code();
				text += this.scanner.code();
				starts.push(from.offset);
				marks.push(from);
				ends.push(this.scanner.offset);
				continue;
			}
			const character = this.scanner.code();
			for (let unit = 0; unit < character.length; unit++) {
				starts.push(from.offset + unit);
				marks.push({ offset: from.offset + unit, line: from.line, column: from.column + unit });
				ends.push(from.offset + unit + 1);
			}
			text += character;
		}
		starts.push(this.scanner.offset);
		marks.push(this.scanner.cursor.mark());
		this.scanner.loud();
		return { text, starts, marks, ends };
	}

	private parameterExpansion(): WordPart {
		const pos = this.scanner.offset;
		this.scanner.codeText("${");
		const part: ParameterExpansionPart = {
			type: "ParameterExpansion",
			pos,
			end: pos,
			text: "",
			parameter: "",
			name: { pos: this.scanner.offset, end: this.scanner.offset },
			index: undefined,
			indirect: undefined,
			length: undefined,
			operator: undefined,
			operand: undefined,
			slice: undefined,
			replace: undefined,
		};
		if (this.scanner.peek() === "#" && this.scanner.peek(1) !== "}") {
			this.scanner.code();
			part.length = true;
		} else if (this.scanner.peek() === "!" && this.scanner.peek(1) !== "}") {
			this.scanner.code();
			part.indirect = true;
		}
		part.name = this.parameterName();
		part.parameter = this.scanner.textOf(part.name.pos, part.name.end);
		if (part.parameter !== "" && this.scanner.peek() === "[") this.index(part);
		if (part.parameter !== "") this.parameterOperator(part);
		// Bash checks an expansion only when it runs, so one it cannot read still ends at its brace.
		if (!this.scanner.codeText("}") && !this.skipToBrace()) this.scanner.error("the ${ has no closing }", pos);
		part.end = this.scanner.offset;
		part.text = this.scanner.textOf(pos, part.end);
		return part;
	}

	/** Past the brace closing an expansion bash would reject at run time, quotes and nesting kept. */
	private skipToBrace(): boolean {
		let depth = 0;
		let guard = -1;
		while (!this.scanner.done) {
			if (this.scanner.offset <= guard) throw new Error("bash expansion skip failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (character === "'" || character === '"' || character === "`" || character === "$") {
				if (this.part(OPERAND_STOP) !== null) continue;
			}
			if (character === "{") depth++;
			if (character === "}" && depth-- === 0) {
				this.scanner.code();
				return true;
			}
			if (character === "\\") this.scanner.code();
			this.scanner.code();
		}
		return false;
	}

	private parameterName(): Span {
		const pos = this.scanner.offset;
		const character = this.scanner.peek();
		if (isNameStart(character)) this.scanner.codeWhile(isNameCharacter);
		else if (isDigit(character)) this.scanner.codeWhile(isDigit);
		else if (SPECIAL_PARAMETERS.has(character)) {
			this.scanner.code();
		}
		return { pos, end: this.scanner.offset };
	}

	/** `[...]` after a parameter: its text, and its parts when it expands. */
	private index(part: { index: string | undefined; indexParts?: WordPart[] }): void {
		this.scanner.code();
		const pos = this.scanner.offset;
		const parts: WordPart[] = [];
		let depth = 0;
		let guard = -1;
		while (!this.scanner.done) {
			if (this.scanner.offset <= guard) throw new Error("bash subscript read failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (character === "]" && depth === 0) break;
			if (character === "[") depth++;
			if (character === "]") depth--;
			if (character === "$" || character === "`" || character === "'" || character === '"') {
				const inner = this.part({ only: new Set(["]"]), plainGlobs: true });
				if (inner !== null) {
					parts.push(inner);
					continue;
				}
			}
			const literal = this.literal({ only: new Set(["]", "[", "$", "`", "'", '"']), plainGlobs: true });
			if (literal === null) this.scanner.code();
			else parts.push(literal);
		}
		part.index = this.scanner.textOf(pos);
		if (!plain(parts)) part.indexParts = parts;
		if (!this.scanner.codeText("]")) this.scanner.error("the subscript has no closing ]", pos);
	}

	private parameterOperator(part: ParameterExpansionPart): void {
		const character = this.scanner.peek();
		if (character === "}") return;
		if (part.indirect === true && (character === "*" || character === "@") && this.scanner.peek(1) === "}") {
			part.operator = this.scanner.code();
			return;
		}
		if (character === ":" && !["-", "=", "?", "+"].includes(this.scanner.peek(1))) {
			this.scanner.code();
			const offset = this.word(SLICE_STOP);
			const length = this.scanner.codeText(":") ? this.word(OPERAND_STOP) : undefined;
			part.slice = { offset, length };
			return;
		}
		const operator = PARAMETER_OPERATORS.find((candidate) => this.scanner.startsWith(candidate));
		if (operator === undefined) return;
		this.scanner.codeText(operator);
		part.operator = operator;
		if (operator.startsWith("/")) {
			const pattern = this.word(PATTERN_STOP);
			const replacement = this.scanner.codeText("/") ? this.word(OPERAND_STOP) : this.empty();
			part.replace = { pattern, replacement };
			return;
		}
		const operand = this.word(OPERAND_STOP);
		if (operand.text !== "" || !["^", "^^", ",", ",,"].includes(operator)) part.operand = operand;
	}

	private empty(): Word {
		const at = this.scanner.offset;
		return { pos: at, end: at, text: "", value: "" };
	}

	/** `{a,b}` or `{1..9}`: null when the brace holds neither, so it stays literal. */
	private brace(): BraceExpansionPart | null {
		if (!this.braceAhead()) return null;
		const pos = this.scanner.offset;
		const parts: WordPart[] = [];
		this.scanner.code();
		let depth = 1;
		let guard = -1;
		while (!this.scanner.done && depth > 0) {
			if (this.scanner.offset <= guard) throw new Error("bash brace read failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (character === "{") depth++;
			if (character === "}") {
				depth--;
				this.scanner.code();
				continue;
			}
			if (character === "$" || character === "`" || character === "'" || character === '"') {
				const inner = this.part({ only: new Set(["}", ","]) });
				if (inner !== null) {
					parts.push(inner);
					continue;
				}
			}
			if (character === "\\") this.scanner.code();
			this.scanner.code();
		}
		const end = this.scanner.offset;
		const part: BraceExpansionPart = { type: "BraceExpansion", pos, end, text: this.scanner.textOf(pos, end) };
		if (parts.length > 0) part.parts = parts;
		return part;
	}

	/** A closing brace on this word, with a comma or `..` at the outer depth. */
	private braceAhead(): boolean {
		let depth = 0;
		let separated = false;
		for (let ahead = 0; ; ahead++) {
			const character = this.scanner.peek(ahead);
			if (character === "" || character === " " || character === "\t" || character === "\n") return false;
			if (character === "\\") {
				ahead++;
				continue;
			}
			if (character === "'" || character === '"' || character === "`") {
				const closing = this.closingQuote(ahead);
				if (closing === undefined) return false;
				ahead = closing;
				continue;
			}
			if (character === "{") depth++;
			if (character === "}") {
				depth--;
				if (depth === 0) return separated;
			}
			if (depth === 1 && (character === "," || (character === "." && this.scanner.peek(ahead + 1) === ".")))
				separated = true;
			if (depth === 0 && isMeta(character)) return false;
		}
	}

	/** Units ahead to the quote closing the one `opening` ahead; a backslash escapes outside single quotes. */
	private closingQuote(opening: number): number | undefined {
		const quote = this.scanner.peek(opening);
		for (let ahead = opening + 1; ; ahead++) {
			const character = this.scanner.peek(ahead);
			if (character === "") return undefined;
			if (character === quote) return ahead;
			if (character === "\\" && quote !== "'") ahead++;
		}
	}

	private extglob(): ExtendedGlobPart {
		const pos = this.scanner.offset;
		const operator = this.scanner.code() as ExtGlobOperator;
		this.scanner.code();
		const patternPos = this.scanner.offset;
		const parts: WordPart[] = [];
		let depth = 1;
		let guard = -1;
		while (!this.scanner.done) {
			if (this.scanner.offset <= guard) throw new Error("bash extglob read failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (character === "(") depth++;
			if (character === ")" && --depth === 0) break;
			if (character === "$" || character === "`" || character === "'" || character === '"') {
				const inner = this.part({ only: new Set([")", "|"]) });
				if (inner !== null) {
					parts.push(inner);
					continue;
				}
			}
			if (character === "\\") this.scanner.code();
			this.scanner.code();
		}
		const pattern = this.scanner.textOf(patternPos);
		if (!this.scanner.codeText(")")) this.scanner.error(`the ${operator}( has no closing )`, pos);
		const end = this.scanner.offset;
		const part: ExtendedGlobPart = {
			type: "ExtendedGlob",
			pos,
			end,
			text: this.scanner.textOf(pos, end),
			operator,
			pattern,
		};
		if (parts.length > 0) part.parts = parts;
		return part;
	}
}

/** Adjacent literal runs are one part. */
function joined(parts: WordPart[], part: WordPart): void {
	const last = parts.at(-1);
	if (last?.type === "Literal" && part.type === "Literal" && last.end === part.pos) {
		last.end = part.end;
		last.text += part.text;
		last.value += part.value;
		return;
	}
	parts.push(part);
}

/** The value a part adds to its word: quotes removed, expansions as written. */
function partValue(part: WordPart): string {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
		case "AnsiCQuoted":
			return part.value;
		case "DoubleQuoted":
		case "LocaleString":
			return part.parts.map((child) => (child.type === "Literal" ? child.value : child.text)).join("");
		default:
			return part.text;
	}
}

function relocated(token: Token, decoded: Decoded): Token {
	const start = decoded.marks[token.pos] as CursorMark;
	return {
		...token,
		pos: start.offset,
		end: decoded.ends[token.end] as number,
		line: start.line,
		column: start.column,
	};
}

/** Moves every span in a decoded backquote's tree to where its characters sit in the source. */
function relocate(node: unknown, decoded: Decoded): void {
	const stack: unknown[] = [node];
	const seen = new Set<object>();
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === null || typeof current !== "object" || seen.has(current)) continue;
		seen.add(current);
		const record = current as Record<string, unknown>;
		if (typeof record["pos"] === "number" && typeof record["end"] === "number") {
			record["pos"] = decoded.starts[record["pos"] as number];
			record["end"] = decoded.ends[record["end"] as number];
		}
		for (const value of Object.values(record)) if (value !== null && typeof value === "object") stack.push(value);
	}
}
