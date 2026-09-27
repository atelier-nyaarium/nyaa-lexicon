// Token access, delimiter matching and diagnostics under every C# parse layer.

import type { Diagnostic } from "@nyaa-lexicon/protocol";
import { Cursor } from "./cursor.js";

import { type LexedSource, lastLine, positionRange, type Token, tokenize } from "./tokens.js";
import { isTrivia, syntaxValue } from "./words.js";

////////////////////////////////
//  Classes

export class CsharpTokenStream {
	private readonly cursor: Cursor;

	protected readonly lexed: LexedSource;

	protected readonly tokens: Token[];

	protected readonly diagnostics: Diagnostic[];

	private readonly reportedDiagnostics = new Set<string>();

	constructor(
		protected readonly module: string,
		protected readonly text: string,
		protected readonly outline = false,
	) {
		this.cursor = new Cursor(text);
		this.lexed = tokenize(text, { collectLiterals: !outline, collectComments: !outline });
		this.tokens = this.lexed.tokens;
		this.diagnostics = [...this.lexed.diagnostics];
	}

	protected token(index: number): Token | undefined {
		return this.tokens[index];
	}

	protected value(index: number): string | undefined {
		return syntaxValue(this.token(index));
	}

	protected nextSignificant(index: number, end = this.tokens.length): number {
		let current = index;
		while (current < end && isTrivia(this.token(current))) current++;
		return current < end ? current : -1;
	}

	protected previousSignificant(index: number, start = 0): number {
		let current = index - 1;
		while (current >= start && isTrivia(this.token(current))) current--;
		return current;
	}

	protected matching(index: number, open: string, close: string, end = this.tokens.length): number {
		let depth = 0;
		for (let current = index; current < end; current++) {
			const item = this.token(current);
			const value = item?.kind === "punctuation" ? item.value : undefined;
			if (value === open) depth++;
			else if (value === close) {
				depth--;
				if (depth === 0) return current;
			}
		}
		return -1;
	}

	protected report(message: string, token: Token | undefined): void {
		if (token === undefined) return;
		const key = `${message}:${token.startOffset}`;
		if (this.reportedDiagnostics.has(key)) return;
		this.reportedDiagnostics.add(key);
		this.diagnostics.push({ severity: "error", message, range: positionRange(token) });
	}

	protected checkDelimiters(): void {
		const opens = new Map<string, string>([
			["(", ")"],
			["[", "]"],
			["{", "}"],
		]);
		const closes = new Map<string, string>([
			[")", "("],
			["]", "["],
			["}", "{"],
		]);
		const stack: Token[] = [];
		for (const item of this.tokens) {
			if (item.kind !== "punctuation") continue;
			if (opens.has(item.value)) {
				stack.push(item);
				continue;
			}
			const opening = closes.get(item.value);
			if (opening === undefined) continue;
			if (stack[stack.length - 1]?.value === opening) {
				stack.pop();
			} else {
				this.report(`Unexpected closing delimiter ${item.value}.`, item);
			}
		}
		for (const item of stack) this.report(`Opening delimiter ${item.value} is not closed.`, item);
	}

	protected findTopLevelValue(start: number, end: number, value: string): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let current = start; current < end; current++) {
			const item = this.token(current);
			if (isTrivia(item)) continue;
			const itemValue = syntaxValue(item);
			if (itemValue === value && parentheses === 0 && brackets === 0 && braces === 0) return current;
			if (itemValue === "(") parentheses++;
			else if (itemValue === ")") parentheses--;
			else if (itemValue === "[") brackets++;
			else if (itemValue === "]") brackets--;
			else if (itemValue === "{") braces++;
			else if (itemValue === "}") braces--;
		}
		return -1;
	}

	protected findSemicolon(start: number, end: number): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let current = start; current < end; current++) {
			const value = this.value(current);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (value === "{") braces++;
			else if (value === "}") braces--;
			else if (value === ";" && parentheses === 0 && brackets === 0 && braces === 0) return current;
		}
		return -1;
	}

	protected lastIdentifier(start: number, end: number): number {
		let found = -1;
		for (let current = start; current < end; current++) {
			if (this.token(current)?.kind === "identifier") found = current;
		}
		return found;
	}

	protected sourceSpan(start: Token, end: Token): string {
		return this.cursor.textBetween(start.startOffset, end.endOffset).trim();
	}

	/** Its line when nothing precedes it there. */
	protected closerLine(close: number): number | undefined {
		const closer = close < 0 ? undefined : this.token(close);
		if (closer === undefined) return undefined;
		let previous = close - 1;
		while (this.token(previous)?.kind === "newline") previous--;
		const before = this.token(previous);
		return before === undefined || lastLine(before) < closer.start.line ? closer.start.line : undefined;
	}

	/** Past the line break after the last code in the span. */
	protected lineAfterLast(from: number, end: number): number | undefined {
		let last = from;
		for (let index = from + 1; index < end; index++) {
			const kind = this.token(index)?.kind;
			if (kind !== "newline" && kind !== "comment" && kind !== "doc" && kind !== "eof") last = index;
		}
		for (let index = last + 1; index < this.tokens.length; index++) {
			const item = this.token(index) as Token;
			if (item.kind === "newline") return item.start.line + 1;
		}
		return undefined;
	}
}
