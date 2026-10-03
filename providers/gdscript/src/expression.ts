// Owns GDScript statement and expression structure, read from tokens.

import type { TextCoordinates } from "@nyaa-lexicon/protocol";
import type { ReferenceToken, SourceLine } from "./parse-model.js";
import { isContinuation, isLineBreak, sourceBetween } from "./tokens.js";

//////// Types

/** Token indices, end exclusive. */
export interface TokenSpan {
	start: number;
	end: number;
}

/** A statement and its continuation lines. */
export interface LogicalLine extends TokenSpan {
	line: number;
	lastLine: number;
	indent: number;
}

/** A block lambda's body inside a bracket, ended by a dedent or by that bracket closing. */
export interface BracketBody {
	statements: LogicalLine[];
	/** The line of the token ending it. */
	endLine: number;
}

export type Expression =
	| { kind: "name"; name: string }
	| { kind: "number"; text: string }
	| { kind: "string"; token: ReferenceToken }
	| { kind: "keyword"; value: "true" | "false" | "null" }
	| { kind: "collection"; base: "Array" | "Dictionary" }
	| { kind: "unary"; operator: string; operand: Expression }
	| { kind: "binary"; operator: string; left: Expression; right: Expression }
	| { kind: "ternary"; value: Expression; otherwise: Expression }
	| { kind: "cast"; display: string; typeName?: string }
	| { kind: "typeTest" }
	| { kind: "await" }
	| { kind: "call"; callee: Expression; arguments: TokenSpan[] }
	| { kind: "member"; target: Expression; name: string }
	| { kind: "subscript" }
	| { kind: "nodePath" };

//////// Constants

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/** Godot's precedence, loosest first. */
const POWER = {
	cast: 1,
	ternary: 2,
	or: 3,
	and: 4,
	not: 5,
	content: 6,
	comparison: 7,
	bitOr: 8,
	bitXor: 9,
	bitAnd: 10,
	shift: 11,
	sum: 12,
	factor: 13,
	sign: 14,
	bitNot: 15,
	power: 16,
	typeTest: 17,
	await: 18,
	postfix: 19,
} as const;

const BINARY = new Map<string, number>([
	["or", POWER.or],
	["||", POWER.or],
	["and", POWER.and],
	["&&", POWER.and],
	["in", POWER.content],
	["==", POWER.comparison],
	["!=", POWER.comparison],
	["<", POWER.comparison],
	[">", POWER.comparison],
	["<=", POWER.comparison],
	[">=", POWER.comparison],
	["|", POWER.bitOr],
	["^", POWER.bitXor],
	["&", POWER.bitAnd],
	["<<", POWER.shift],
	[">>", POWER.shift],
	["+", POWER.sum],
	["-", POWER.sum],
	["*", POWER.factor],
	["/", POWER.factor],
	["%", POWER.factor],
	["**", POWER.power],
]);

const PREFIX = new Map<string, number>([
	["-", POWER.sign],
	["+", POWER.sign],
	["~", POWER.bitNot],
	["!", POWER.not],
]);

//////// Statements

/** Tokens `start` through `last`, ending before `end`. */
function logicalLine(
	tokens: ReferenceToken[],
	lines: readonly SourceLine[],
	start: number,
	last: number,
	end: number,
): LogicalLine | undefined {
	const first = tokens[start];
	const final = tokens[last];
	if (first === undefined || final === undefined) return undefined;
	const indent = lines[first.line]?.indent ?? 0;
	return { start, end, line: first.line, lastLine: final.string?.end.line ?? final.line, indent };
}

export function logicalLines(tokens: ReferenceToken[], lines: readonly SourceLine[]): LogicalLine[] {
	const logical: LogicalLine[] = [];
	let depth = 0;
	let start = -1;
	let last = -1;
	const close = (end: number): void => {
		const line = logicalLine(tokens, lines, start, last, end);
		if (line !== undefined) logical.push(line);
		start = -1;
		depth = 0;
	};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind === "newline") {
			if (start >= 0 && depth === 0 && !isContinuation(tokens[index - 1])) close(index);
			continue;
		}
		if (start < 0) start = index;
		last = index;
		if (OPENERS.has(token.value)) depth++;
		else if (CLOSERS.has(token.value)) depth = Math.max(0, depth - 1);
	}
	if (start >= 0) close(tokens.length);
	return logical;
}

/** The block colon of the lambda whose `func` is at `at`, when a line break follows it; else -1. */
export function lambdaBlockColon(tokens: ReferenceToken[], at: number, end: number): number {
	let depth = 0;
	for (let index = at + 1; index < end; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (OPENERS.has(value)) depth++;
		else if (CLOSERS.has(value)) {
			if (depth === 0) return -1;
			depth--;
		} else if (depth === 0 && value === ":") return tokens[index + 1]?.kind === "newline" ? index : -1;
	}
	return -1;
}

/** Statements from `from` until one starts left of the first, or the bracket around them closes. */
function bracketBody(
	tokens: ReferenceToken[],
	lines: readonly SourceLine[],
	from: number,
	end: number,
): { body: BracketBody; stop: number } {
	const statements: LogicalLine[] = [];
	let depth = 0;
	let start = -1;
	let last = -1;
	let indent = -1;
	const close = (stop: number): void => {
		const line = logicalLine(tokens, lines, start, last, stop);
		if (line !== undefined) statements.push(line);
		start = -1;
	};
	let stop = from;
	for (; stop < end; stop++) {
		const token = tokens[stop] as ReferenceToken;
		if (token.kind === "newline") {
			if (start >= 0 && depth === 0 && !isContinuation(tokens[stop - 1])) close(stop);
			continue;
		}
		if (depth === 0 && CLOSERS.has(token.value)) break;
		if (start < 0) {
			const lineIndent = lines[token.line]?.indent ?? 0;
			if (indent < 0) indent = lineIndent;
			else if (lineIndent < indent) break;
			start = stop;
		}
		last = stop;
		if (OPENERS.has(token.value)) depth++;
		else if (CLOSERS.has(token.value)) depth--;
	}
	if (start >= 0) close(stop);
	const ender = tokens[stop] ?? tokens[last];
	return { body: { statements, endLine: ender?.line ?? 0 }, stop };
}

/** Block lambdas' bodies inside the brackets of `span`, each before the bodies inside it. */
export function bracketBodies(
	tokens: ReferenceToken[],
	lines: readonly SourceLine[],
	span: TokenSpan,
	found: BracketBody[] = [],
): BracketBody[] {
	let depth = 0;
	for (let index = span.start; index < span.end; index++) {
		const token = tokens[index] as ReferenceToken;
		if (OPENERS.has(token.value)) depth++;
		else if (CLOSERS.has(token.value)) depth--;
		else if (depth > 0 && token.kind === "identifier" && token.value === "func") {
			const colon = lambdaBlockColon(tokens, index, span.end);
			if (colon < 0) continue;
			const { body, stop } = bracketBody(tokens, lines, colon + 1, span.end);
			if (body.statements.length > 0) found.push(body);
			for (const statement of body.statements) bracketBodies(tokens, lines, statement, found);
			index = stop - 1;
		}
	}
	return found;
}

/** First unbracketed `:` from `start`, or -1. */
export function blockColon(tokens: ReferenceToken[], span: TokenSpan, start = span.start): number {
	let depth = 0;
	for (let index = start; index < span.end; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (OPENERS.has(value)) depth++;
		else if (CLOSERS.has(value)) depth--;
		else if (depth === 0 && value === ":") return index;
	}
	return -1;
}

/** Split at unbracketed `;`. */
export function statements(tokens: ReferenceToken[], span: TokenSpan): TokenSpan[] {
	const found: TokenSpan[] = [];
	let depth = 0;
	let start = span.start;
	for (let index = span.start; index < span.end; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (OPENERS.has(value)) depth++;
		else if (CLOSERS.has(value)) depth--;
		else if (depth === 0 && value === ";") {
			found.push({ start, end: index });
			start = index + 1;
		}
	}
	found.push({ start, end: span.end });
	return found.filter((statement) => statement.end > statement.start);
}

/** An initializer's unbracketed end; `:` opens accessors. */
export function expressionEnd(tokens: ReferenceToken[], start: number): number {
	let depth = 0;
	for (let index = start; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (depth === 0 && token.kind === "newline" && !isContinuation(tokens[index - 1])) return index;
		if (depth === 0 && (token.value === ";" || token.value === "," || token.value === ":")) return index;
		if (OPENERS.has(token.value)) depth++;
		else if (CLOSERS.has(token.value)) {
			if (depth === 0) return index;
			depth--;
		}
	}
	return tokens.length;
}

//////// Expressions

class ExpressionParser {
	private at: number;

	constructor(
		private readonly tokens: ReferenceToken[],
		private readonly span: TokenSpan,
		private readonly coordinates: TextCoordinates,
	) {
		this.at = span.start;
		this.skip();
	}

	parse(): Expression | null {
		const expression = this.expression(0);
		return expression !== null && this.peek() === undefined ? expression : null;
	}

	private skip(): void {
		while (this.at < this.span.end && isLineBreak(this.tokens[this.at])) this.at++;
	}

	private peek(offset = 0): ReferenceToken | undefined {
		let at = this.at;
		for (let step = 0; step < offset; step++) {
			at++;
			while (at < this.span.end && isLineBreak(this.tokens[at])) at++;
		}
		return at < this.span.end ? this.tokens[at] : undefined;
	}

	private advance(): ReferenceToken | undefined {
		const token = this.peek();
		if (token !== undefined) {
			this.at++;
			this.skip();
		}
		return token;
	}

	private expect(value: string): boolean {
		if (this.peek()?.value !== value) return false;
		this.advance();
		return true;
	}

	/** The matching closer's index, or -1. */
	private skipBalanced(): number {
		let depth = 0;
		while (this.peek() !== undefined) {
			const index = this.at;
			const value = (this.advance() as ReferenceToken).value;
			if (OPENERS.has(value)) depth++;
			else if (CLOSERS.has(value) && --depth === 0) return index;
		}
		return -1;
	}

	/** A call's argument spans. */
	private arguments(): TokenSpan[] | null {
		const open = this.at;
		const close = this.skipBalanced();
		if (close < 0) return null;
		const found: TokenSpan[] = [];
		let depth = 0;
		let start = open + 1;
		for (let index = open + 1; index < close; index++) {
			const value = (this.tokens[index] as ReferenceToken).value;
			if (OPENERS.has(value)) depth++;
			else if (CLOSERS.has(value)) depth--;
			else if (depth === 0 && value === ",") {
				found.push({ start, end: index });
				start = index + 1;
			}
		}
		if (close > start) found.push({ start, end: close });
		return found;
	}

	/** `Name`, `A.B` or `Array[T]`, rendered from source; a lone name kept apart. */
	private type(): { display: string; typeName?: string } | null {
		const first = this.advance();
		if (first?.kind !== "identifier") return null;
		let last = first;
		while (this.peek()?.value === "." && this.peek(1)?.kind === "identifier") {
			this.advance();
			last = this.advance() as ReferenceToken;
		}
		if (this.peek()?.value === "[") {
			const close = this.skipBalanced();
			if (close < 0) return null;
			last = this.tokens[close] as ReferenceToken;
		}
		const display = sourceBetween(this.coordinates, first, last)?.trim();
		if (display === undefined) return null;
		return last === first ? { display, typeName: first.value } : { display };
	}

	private expression(minimum: number): Expression | null {
		let left = this.prefix();
		while (left !== null) {
			const value = this.peek()?.value;
			if (value === undefined) return left;
			if (value === "." || value === "(" || value === "[") {
				left = this.postfix(left);
				continue;
			}
			if (value === "is" && POWER.typeTest >= minimum) {
				this.advance();
				if (this.peek()?.value === "not") this.advance();
				left = this.type() === null ? null : { kind: "typeTest" };
				continue;
			}
			if (value === "as" && POWER.cast >= minimum) {
				this.advance();
				const type = this.type();
				left = type === null ? null : { kind: "cast", ...type };
				continue;
			}
			if (value === "if" && POWER.ternary >= minimum) {
				this.advance();
				if (this.expression(POWER.ternary + 1) === null || !this.expect("else")) return null;
				const otherwise = this.expression(POWER.ternary);
				left = otherwise === null ? null : { kind: "ternary", value: left, otherwise };
				continue;
			}
			const negated = value === "not" && this.peek(1)?.value === "in";
			const operator = negated ? "in" : value;
			const power = BINARY.get(operator);
			if (power === undefined || power < minimum) return left;
			this.advance();
			if (negated) this.advance();
			const right = this.expression(power + 1);
			left = right === null ? null : { kind: "binary", operator, left, right };
		}
		return null;
	}

	private postfix(target: Expression): Expression | null {
		const value = this.peek()?.value;
		if (value === ".") {
			this.advance();
			const name = this.advance();
			return name?.kind === "identifier" ? { kind: "member", target, name: name.value } : null;
		}
		if (value === "(") {
			const found = this.arguments();
			return found === null ? null : { kind: "call", callee: target, arguments: found };
		}
		return this.skipBalanced() < 0 ? null : { kind: "subscript" };
	}

	private prefix(): Expression | null {
		const token = this.peek();
		if (token === undefined) return null;
		if (token.kind === "number") {
			this.advance();
			return { kind: "number", text: token.value };
		}
		if (token.kind === "string") {
			this.advance();
			return { kind: "string", token };
		}
		if (token.kind === "identifier") return this.word(token);
		const value = token.value;
		if (value === "(") {
			this.advance();
			const inner = this.expression(0);
			return inner !== null && this.expect(")") ? inner : null;
		}
		if (value === "[" || value === "{") {
			if (this.skipBalanced() < 0) return null;
			return { kind: "collection", base: value === "[" ? "Array" : "Dictionary" };
		}
		if (value === "$" || value === "%") return this.nodePath();
		const power = PREFIX.get(value);
		if (power === undefined) return null;
		this.advance();
		const operand = this.expression(power);
		if (operand === null) return null;
		if (operand.kind === "number" && power === POWER.sign)
			return { kind: "number", text: `${value}${operand.text}` };
		return { kind: "unary", operator: value === "!" ? "not" : value, operand };
	}

	/** `$Path/To`, `$"path"`, `%Unique`. */
	private nodePath(): Expression | null {
		this.advance();
		if (this.peek()?.value === "%") this.advance();
		if (this.peek()?.kind === "string") {
			this.advance();
			return { kind: "nodePath" };
		}
		if (this.advance()?.kind !== "identifier") return null;
		while (this.peek()?.value === "/") {
			this.advance();
			if (this.peek()?.value === "%") this.advance();
			if (this.advance()?.kind !== "identifier") return null;
		}
		return { kind: "nodePath" };
	}

	private word(token: ReferenceToken): Expression | null {
		const value = token.value;
		if (value === "func") return null;
		this.advance();
		if (value === "true" || value === "false" || value === "null") return { kind: "keyword", value };
		if (value === "not") {
			const operand = this.expression(POWER.not);
			return operand === null ? null : { kind: "unary", operator: "not", operand };
		}
		if (value === "await") return this.expression(POWER.await) === null ? null : { kind: "await" };
		return { kind: "name", name: value };
	}
}

/** Null outside the parsed subset. */
export function parseExpression(
	tokens: ReferenceToken[],
	span: TokenSpan,
	coordinates: TextCoordinates,
): Expression | null {
	return new ExpressionParser(tokens, span, coordinates).parse();
}
