// A file's text, its tokens, and the positions facts report, from offsets into the parsed text.

import { coordinatesOf, type TextCoordinates } from "@nyaa-lexicon/protocol";
import type * as A from "../syntax/ast.js";
import { isKeyword, typeCommentText } from "../syntax/parser.js";
import type { Token, TokenType } from "../syntax/tokenizer.js";
import { docstringOf, isDefinition } from "./nodes.js";
import type { Position, Range } from "./types.js";

////////////////////////////////
//  Constants

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** Trivia before a statement. */
const LINE_TRIVIA: ReadonlySet<TokenType> = new Set(["INDENT", "DEDENT", "NL", "COMMENT"]);

export const OPEN_BRACKETS: ReadonlySet<string> = new Set(["(", "[", "{"]);
export const CLOSE_BRACKETS: ReadonlySet<string> = new Set([")", "]", "}"]);

////////////////////////////////
//  Classes

export class Source {
	/** The text the parser read: without a leading byte order mark. */
	readonly parsed: string;
	readonly coordinates: TextCoordinates;
	/** Where the parsed text starts in the file. */
	private readonly base: number;
	private indentMarks: Array<[number, string]> | undefined;

	constructor(
		readonly text: string,
		readonly tokens: readonly Token[] = [],
	) {
		this.base = text.startsWith(BYTE_ORDER_MARK) ? 1 : 0;
		this.parsed = text.slice(this.base);
		this.coordinates = coordinatesOf(text);
	}

	static parsedText(text: string): string {
		return text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
	}

	////////////////////////////////
	//  Positions

	position(offset: number): Position {
		return this.coordinates.positionAt(this.base + offset) as Position;
	}

	range(pos: number, end: number): Range {
		return { start: this.position(pos), end: this.position(end) };
	}

	rangeOf(node: A.Span): Range {
		return this.range(node.pos, node.end);
	}

	/** Zero-based line holding an offset. */
	line(offset: number): number {
		return this.position(offset).line;
	}

	segment(node: A.Span): string {
		return this.parsed.slice(node.pos, node.end);
	}

	/** An attribute's name, not its receiver. */
	referenceRange(node: A.Node): Range {
		return node.type === "Attribute" ? this.range(node.end - node.attr.length, node.end) : this.rangeOf(node);
	}

	////////////////////////////////
	//  Tokens

	/** The first token at or past an offset, past the zero-width dedents there. */
	tokenAt(offset: number): number {
		let low = 0;
		let high = this.tokens.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if ((this.tokens[middle] as Token).pos < offset) low = middle + 1;
			else high = middle;
		}
		while (low < this.tokens.length && (this.tokens[low] as Token).type === "DEDENT") low++;
		return low;
	}

	tokenAfter(index: number, type: TokenType): Token | undefined {
		for (let at = index; at < this.tokens.length; at++) {
			const token = this.tokens[at] as Token;
			if (token.type === type) return token;
		}
		return undefined;
	}

	/** The start of the line past the next token of a type; its own place when it ends the text. */
	lineAfter(index: number, type: TokenType): Position | undefined {
		const token = this.tokenAfter(index, type);
		if (token === undefined) return undefined;
		return token.string === "" ? this.position(token.pos) : { line: this.line(token.pos) + 1, character: 0 };
	}

	/** The operator before an expression, past parentheses around it. */
	operatorBefore(offset: number, symbol: string): Token | undefined {
		for (let index = this.tokenAt(offset) - 1; index >= 0; index--) {
			const token = this.tokens[index] as Token;
			if (token.type === "OP" && token.string === symbol) return token;
			if (token.type !== "NL" && token.type !== "COMMENT" && token.string !== "(") return undefined;
		}
		return undefined;
	}

	/** A definition starts at its first decorator's `@`. */
	declarationStart(node: A.Node): number {
		const first = isDefinition(node) ? node.decoratorList[0] : undefined;
		if (first === undefined) return node.pos;
		const at = this.operatorBefore(first.pos, "@");
		if (at === undefined) throw new Error("python decorator has no @ before it");
		return at.pos;
	}

	/** The name token a node binds. */
	selectionOf(node: A.Node): Range {
		let anchor = node.pos;
		if (node.type === "ExceptHandler" && node.exceptionType !== undefined) anchor = node.exceptionType.end;
		else if (node.type === "MatchAs" && node.pattern !== undefined) anchor = node.pattern.end;
		else if (node.type === "MatchMapping" && node.patterns.length > 0)
			anchor = (node.patterns.at(-1) as A.Pattern).end;
		for (let index = this.tokenAt(anchor); index < this.tokens.length; index++) {
			const token = this.tokens[index] as Token;
			if (token.pos >= node.end) break;
			if (token.type === "NAME" && !isKeyword(token.string)) return this.range(token.pos, token.end);
		}
		return this.rangeOf(node);
	}

	/** Module tokens after `from`. */
	moduleNameRange(node: A.ImportFrom): Range | null {
		const first = this.tokenAt(node.pos) + 1;
		let last = first;
		while (last < this.tokens.length) {
			const token = this.tokens[last] as Token;
			if (token.type === "NAME" && token.string === "import") break;
			last++;
		}
		if (last === first || last === this.tokens.length) return null;
		return this.range((this.tokens[first] as Token).pos, (this.tokens[last - 1] as Token).end);
	}

	/** Each prefix of an import alias's dotted name as written: `a`, `a.b`, `a.b.c` for `a.b.c`. */
	dottedPrefixes(alias: A.Alias): Range[] {
		const prefixes: Range[] = [];
		for (let index = this.tokenAt(alias.pos); index < this.tokens.length; index++) {
			const token = this.tokens[index] as Token;
			if (token.pos >= alias.end || token.string === "as") break;
			if (token.type === "NAME") prefixes.push(this.range(alias.pos, token.end));
			else if (token.string !== ".") break;
		}
		return prefixes;
	}

	/** The suite's indent when the statement starts its line. */
	statementIndent(node: A.Node): string | null {
		const index = this.tokenAt(node.pos);
		let before = index - 1;
		while (before >= 0 && LINE_TRIVIA.has((this.tokens[before] as Token).type)) before--;
		if (before >= 0 && (this.tokens[before] as Token).type !== "NEWLINE") return null;
		const marks = this.marks();
		let low = 0;
		let high = marks.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if ((marks[middle] as [number, string])[0] < index) low = middle + 1;
			else high = middle;
		}
		return (marks[low - 1] as [number, string])[1];
	}

	/** The indent in force after each indent or dedent token. */
	private marks(): Array<[number, string]> {
		if (this.indentMarks !== undefined) return this.indentMarks;
		const stack = [""];
		const marks: Array<[number, string]> = [[-1, ""]];
		this.tokens.forEach((token, index) => {
			if (token.type === "INDENT") stack.push(token.string);
			else if (token.type === "DEDENT") stack.pop();
			else return;
			marks.push([index, stack.at(-1) ?? ""]);
		});
		this.indentMarks = marks;
		return marks;
	}

	/** The colon ending a compound statement's header; a lambda's colon sits before the anchor. */
	headerColon(node: A.Node): Token | undefined {
		let anchor: A.Node | undefined;
		if (node.type === "FunctionDef" || node.type === "AsyncFunctionDef") anchor = node.returns;
		else if (node.type === "For" || node.type === "AsyncFor") anchor = node.iter;
		else if (node.type === "With" || node.type === "AsyncWith") {
			const last = node.items.at(-1) as A.WithItem;
			anchor = last.optionalVars ?? last.contextExpr;
		}
		let depth = 0;
		for (
			let index = this.tokenAt(anchor === undefined ? node.pos : anchor.end);
			index < this.tokens.length;
			index++
		) {
			const token = this.tokens[index] as Token;
			if (token.type !== "OP") continue;
			if (token.string === ":" && depth <= 0) return token;
			if (OPEN_BRACKETS.has(token.string)) depth++;
			else if (CLOSE_BRACKETS.has(token.string)) depth--;
		}
		return undefined;
	}

	/** Where a node's type comment text starts: after its value, its parameter and default, or its header's colon. */
	typeCommentStart(node: A.Node, text: string): number | undefined {
		let from: number | undefined;
		if (node.type === "Assign") from = node.value.end;
		else if (node.type === "arg") from = node.end;
		else from = this.headerColon(node)?.end;
		if (from === undefined) return undefined;
		let depth = 0;
		for (let index = this.tokenAt(from); index < this.tokens.length; index++) {
			const token = this.tokens[index] as Token;
			if (token.type === "COMMENT") {
				if (typeCommentText(token.string) === text) return token.end - text.length;
				continue;
			}
			// A header's comment may sit on the line after it; a statement's ends its line.
			if (token.type === "NEWLINE") {
				if (node.type === "Assign" || node.type === "arg") return undefined;
				continue;
			}
			if (token.type === "NL" || token.type === "INDENT") continue;
			// The parentheses closing a value.
			if (node.type === "Assign") continue;
			if (node.type !== "arg") return undefined;
			// A parameter's default and the comma after it.
			if (OPEN_BRACKETS.has(token.string)) depth++;
			else if (CLOSE_BRACKETS.has(token.string) && --depth < 0) return undefined;
		}
		return undefined;
	}

	/** Zero-based line after a class body's last statement, when the body is a block. */
	memberInsertLine(node: A.ClassDef): number | undefined {
		const colon = this.headerColon(node);
		if (colon === undefined) return undefined;
		let index = this.tokenAt(colon.end);
		while (index < this.tokens.length && (this.tokens[index] as Token).type === "COMMENT") index++;
		if (index === this.tokens.length || (this.tokens[index] as Token).type !== "NEWLINE") return undefined;
		const newline = this.tokenAfter(this.tokenAt((node.body.at(-1) as A.Statement).end), "NEWLINE");
		// No line break ends the file's last line.
		if (newline === undefined || newline.string === "") return undefined;
		return this.line(newline.pos) + 1;
	}

	/** After shebang, docstring and future imports. */
	prologueEnd(module: A.Module): Position {
		const ends: Array<Position | undefined> = [{ line: 0, character: 0 }];
		const first = this.tokens[0];
		if (first?.type === "COMMENT" && first.pos === 0 && first.string.startsWith("#!")) {
			ends.push(this.lineAfter(0, "NL"));
		}
		const statements: A.Statement[] = module.body.filter(
			(node) => node.type === "ImportFrom" && node.module === "__future__" && node.level === 0,
		);
		const opening = module.body[0];
		if (opening !== undefined && docstringOf(module.body) !== undefined) statements.push(opening);
		for (const node of statements) ends.push(this.lineAfter(this.tokenAt(node.end), "NEWLINE"));
		let latest = ends[0] as Position;
		for (const end of ends) {
			if (
				end !== undefined &&
				(end.line > latest.line || (end.line === latest.line && end.character > latest.character))
			) {
				latest = end;
			}
		}
		return latest;
	}
}
