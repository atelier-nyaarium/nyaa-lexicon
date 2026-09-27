// Arithmetic: `(( ))`, `$(( ))` and `for (( ; ; ))`, by C precedence.

import type { ArithmeticExpression, ArithmeticWord, WordPart } from "./ast.js";
import { isBlank, isNameCharacter, isNameStart, type Scanner } from "./scanner.js";
import type { WordReader } from "./words.js";

////////////////////////////////
//  Constants

/** Longest first, so `<<=` is never read as `<<` then `=`. */
const OPERATORS = [
	"<<=",
	">>=",
	"**",
	"++",
	"--",
	"<<",
	">>",
	"<=",
	">=",
	"==",
	"!=",
	"&&",
	"||",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"^=",
	"|=",
	"+",
	"-",
	"*",
	"/",
	"%",
	"<",
	">",
	"=",
	"!",
	"~",
	"&",
	"^",
	"|",
	"?",
	":",
	",",
	"(",
	")",
];

const ASSIGNMENTS: ReadonlySet<string> = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="]);

/** Binary levels, loosest first. */
const LEVELS: ReadonlyArray<ReadonlySet<string>> = [
	new Set(["||"]),
	new Set(["&&"]),
	new Set(["|"]),
	new Set(["^"]),
	new Set(["&"]),
	new Set(["==", "!="]),
	new Set(["<=", ">=", "<", ">"]),
	new Set(["<<", ">>"]),
	new Set(["+", "-"]),
	new Set(["*", "/", "%"]),
];

const PREFIX: ReadonlySet<string> = new Set(["!", "~", "+", "-", "++", "--"]);

/** Characters that end an arithmetic word. */
const WORD_ENDS: ReadonlySet<string> = new Set([..."+-*/%<>=!~&^|?:,()[]; \t\n", ""]);

////////////////////////////////
//  Classes

export class ArithmeticReader {
	constructor(
		private readonly scanner: Scanner,
		private readonly words: WordReader,
	) {}

	/** An expression up to `close`, which is left unread; undefined when empty or unreadable. */
	read(close: string): ArithmeticExpression | undefined {
		this.space();
		if (this.scanner.done || this.at(close)) return undefined;
		const pos = this.scanner.offset;
		const expression = this.comma(close);
		this.space();
		if (expression !== undefined && this.at(close)) return expression;
		this.scanner.error(`the arithmetic expression does not end at ${close}`, pos);
		this.skipTo(close);
		return undefined;
	}

	private at(close: string): boolean {
		return this.scanner.startsWith(close);
	}

	/** Past a broken expression to its `close`, parentheses balanced. */
	private skipTo(close: string): void {
		let depth = 0;
		let guard = -1;
		while (!this.scanner.done) {
			if (this.scanner.offset <= guard) throw new Error("bash arithmetic recovery failed to advance");
			guard = this.scanner.offset;
			if (depth === 0 && this.at(close)) return;
			const character = this.scanner.peek();
			if (character === "(") depth++;
			if (character === ")") {
				if (depth === 0) return;
				depth--;
			}
			this.scanner.code();
		}
	}

	private space(): void {
		let guard = -1;
		for (;;) {
			if (this.scanner.offset <= guard) throw new Error("bash arithmetic space failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (isBlank(character) || character === "\n") this.scanner.skip();
			else if (this.scanner.atContinuation()) this.scanner.continuation();
			else return;
		}
	}

	/** The operator next, without reading it; never one that begins `close`. */
	private operator(close: string): string | null {
		this.space();
		if (this.at(close)) return null;
		return OPERATORS.find((candidate) => this.scanner.startsWith(candidate)) ?? null;
	}

	/** Whether `operator` was next and is now read. */
	private take(operator: string): boolean {
		return this.scanner.codeText(operator);
	}

	private comma(close: string): ArithmeticExpression | undefined {
		let left = this.assignment(close);
		this.scanner.chain(() => {
			if (left === undefined || this.operator(close) !== "," || !this.take(",")) return false;
			const right = this.assignment(close);
			left =
				right === undefined
					? undefined
					: { type: "ArithmeticBinary", pos: left.pos, end: right.end, operator: ",", left, right };
			return left !== undefined;
		});
		return left;
	}

	private assignment(close: string): ArithmeticExpression | undefined {
		const left = this.ternary(close);
		const operator = this.operator(close);
		if (left === undefined || operator === null || !ASSIGNMENTS.has(operator)) return left;
		this.take(operator);
		const right = this.scanner.nested(() => this.assignment(close));
		if (right === undefined) return undefined;
		return { type: "ArithmeticBinary", pos: left.pos, end: right.end, operator, left, right };
	}

	private ternary(close: string): ArithmeticExpression | undefined {
		const test = this.binary(close, 0);
		if (test === undefined || this.operator(close) !== "?") return test;
		this.take("?");
		const consequent = this.scanner.nested(() => this.comma(close));
		if (consequent === undefined || this.operator(close) !== ":") return undefined;
		this.take(":");
		const alternate = this.scanner.nested(() => this.ternary(close));
		if (alternate === undefined) return undefined;
		return { type: "ArithmeticTernary", pos: test.pos, end: alternate.end, test, consequent, alternate };
	}

	private binary(close: string, level: number): ArithmeticExpression | undefined {
		const operators = LEVELS[level];
		if (operators === undefined) return this.power(close);
		let left = this.binary(close, level + 1);
		this.scanner.chain(() => {
			const operator = this.operator(close);
			if (left === undefined || operator === null || !operators.has(operator) || !this.take(operator))
				return false;
			const right = this.binary(close, level + 1);
			left =
				right === undefined
					? undefined
					: { type: "ArithmeticBinary", pos: left.pos, end: right.end, operator, left, right };
			return left !== undefined;
		});
		return left;
	}

	/** `**` binds right to left. */
	private power(close: string): ArithmeticExpression | undefined {
		const left = this.unary(close);
		if (left === undefined || this.operator(close) !== "**") return left;
		this.take("**");
		const right = this.scanner.nested(() => this.power(close));
		if (right === undefined) return undefined;
		return { type: "ArithmeticBinary", pos: left.pos, end: right.end, operator: "**", left, right };
	}

	/** Prefixes are read in a loop, so a long run costs no stack, but each counts a level. */
	private unary(close: string): ArithmeticExpression | undefined {
		const prefixes: Array<{ operator: string; pos: number }> = [];
		this.scanner.chain(() => {
			const operator = this.operator(close);
			const pos = this.scanner.offset;
			if (operator === null || !PREFIX.has(operator) || !this.take(operator)) return false;
			prefixes.push({ operator, pos });
			return true;
		});
		let operand = this.postfix(close);
		for (let index = prefixes.length - 1; index >= 0 && operand !== undefined; index--) {
			const { operator, pos } = prefixes[index] as { operator: string; pos: number };
			operand = { type: "ArithmeticUnary", pos, end: operand.end, operator, operand, prefix: true };
		}
		return operand;
	}

	private postfix(close: string): ArithmeticExpression | undefined {
		let operand = this.primary(close);
		for (;;) {
			const operator = this.operator(close);
			if (operand === undefined || (operator !== "++" && operator !== "--") || !this.take(operator))
				return operand;
			operand = {
				type: "ArithmeticUnary",
				pos: operand.pos,
				end: this.scanner.offset,
				operator,
				operand,
				prefix: false,
			};
		}
	}

	private primary(close: string): ArithmeticExpression | undefined {
		if (this.operator(close) === "(") {
			const pos = this.scanner.offset;
			this.take("(");
			const expression = this.scanner.nested(() => this.comma(")"));
			this.space();
			if (expression === undefined || !this.scanner.codeText(")")) return undefined;
			return { type: "ArithmeticGroup", pos, end: this.scanner.offset, expression };
		}
		return this.word();
	}

	/** A number, a name with its subscript, or a word holding expansions. */
	private word(): ArithmeticWord | undefined {
		this.space();
		const pos = this.scanner.offset;
		const named = isNameStart(this.scanner.peek());
		const parts: WordPart[] = [];
		let literalFrom = pos;
		const literal = (): void => {
			if (this.scanner.offset === literalFrom) return;
			const text = this.scanner.textOf(literalFrom);
			parts.push({ type: "Literal", pos: literalFrom, end: this.scanner.offset, text, value: text });
		};
		let guard = -1;
		while (!this.scanner.done) {
			if (this.scanner.offset <= guard) throw new Error("bash arithmetic word failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (character === "$" || character === "`" || character === "'" || character === '"') {
				literal();
				const inner = this.words.word({ only: WORD_ENDS, plainGlobs: true });
				parts.push(
					...(inner.parts ?? [
						{ type: "Literal", pos: inner.pos, end: inner.end, text: inner.text, value: inner.value },
					]),
				);
				literalFrom = this.scanner.offset;
				continue;
			}
			if (character === "[" && this.scanner.offset > pos && named) {
				this.subscript(parts, literal, (at) => {
					literalFrom = at;
				});
				continue;
			}
			if (WORD_ENDS.has(character) && character !== "[") break;
			if (character === "#" || isNameCharacter(character) || character === "@" || character === ".")
				this.scanner.code();
			else break;
		}
		literal();
		if (this.scanner.offset === pos) return undefined;
		const end = this.scanner.offset;
		const word: ArithmeticWord = { type: "ArithmeticWord", pos, end, value: this.scanner.textOf(pos, end) };
		if (parts.some((part) => part.type !== "Literal")) word.parts = parts;
		return word;
	}

	/** `[...]` after a name: part of the word, expansions inside kept as parts. */
	private subscript(parts: WordPart[], literal: () => void, restart: (at: number) => void): void {
		let depth = 0;
		let guard = -1;
		while (!this.scanner.done) {
			if (this.scanner.offset <= guard) throw new Error("bash arithmetic subscript failed to advance");
			guard = this.scanner.offset;
			const character = this.scanner.peek();
			if (character === "[") depth++;
			if (character === "]") {
				depth--;
				this.scanner.code();
				if (depth === 0) return;
				continue;
			}
			if (character === "$" || character === "`" || character === "'" || character === '"') {
				literal();
				const inner = this.words.word({ only: new Set(["]", "[", " ", "\t", "\n", ""]), plainGlobs: true });
				parts.push(...(inner.parts ?? []));
				restart(this.scanner.offset);
				continue;
			}
			this.scanner.code();
		}
	}
}
