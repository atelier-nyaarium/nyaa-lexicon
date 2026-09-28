// Token marks, line walks and diagnostics under every C++ parse layer.

import { comparePositions, type Diagnostic } from "@nyaa-lexicon/protocol";
import { type DeclaredName, templateAngles } from "./angles.js";
import type { ImportFact } from "./model.js";
import type { Token } from "./tokens.js";
import { directiveTokenIndexes, isSignificant } from "./tokens.js";
import { codeText, MetricsIndex, rangeFrom, significantAfter, tokenAt } from "./tokenWalk.js";
import { isNameToken } from "./words.js";

////////////////////////////////
//  Classes

export class CppTokenStream {
	protected readonly excludedTokenIndexes = new Set<number>();

	protected readonly declarationSpecifierTokenIndexes = new Set<number>();

	protected readonly templateTokenIndexes = new Set<number>();

	private readonly diagnostics: Diagnostic[];

	protected readonly imports: ImportFact[] = [];

	/** Offsets of template brackets. */
	protected readonly angles: Set<number>;

	protected readonly metrics: MetricsIndex;

	/** Tokens on preprocessing directive lines, which no declaration is made of. */
	protected readonly directiveTokens: Set<number>;

	constructor(
		protected readonly module: string,
		protected readonly text: string,
		protected readonly tokens: Token[],
		protected readonly blankLines: number[],
		diagnostics: Diagnostic[],
		names?: ReadonlyMap<string, DeclaredName>,
	) {
		this.diagnostics = diagnostics.map((item) => ({ ...item, path: module }));
		this.directiveTokens = directiveTokenIndexes(tokens);
		this.angles = templateAngles(tokens, this.directiveTokens, names);
		this.metrics = new MetricsIndex(tokens);
	}

	/** Whether `names` would mark other template brackets than this read did. */
	anglesDifferWith(names: ReadonlyMap<string, DeclaredName>): boolean {
		const angles = templateAngles(this.tokens, this.directiveTokens, names);
		return angles.size !== this.angles.size || [...angles].some((offset) => !this.angles.has(offset));
	}

	/** The next token after `index` that is code: not blank, not on a directive line; -1 when none. */
	protected codeAfter(index: number, limit = this.tokens.length): number {
		let current = significantAfter(this.tokens, index, limit);
		while (current >= 0 && this.directiveTokens.has(current))
			current = significantAfter(this.tokens, current, limit);
		return current;
	}

	protected addDiagnostic(message: string, startIndex: number, endIndex = startIndex + 1): void {
		const range = rangeFrom(this.tokens, startIndex, endIndex);
		if (range === null) return;
		if (
			this.diagnostics.some(
				(item) =>
					item.message === message &&
					item.range !== undefined &&
					comparePositions(item.range.start, range.start) === 0,
			)
		)
			return;
		this.diagnostics.push({ severity: "error", message, range, path: this.module });
	}

	protected sortedDiagnostics(): Diagnostic[] {
		return [...this.diagnostics].sort((left, right) => {
			const leftStart = left.range?.start ?? {
				line: Number.MAX_SAFE_INTEGER,
				character: Number.MAX_SAFE_INTEGER,
			};
			const rightStart = right.range?.start ?? {
				line: Number.MAX_SAFE_INTEGER,
				character: Number.MAX_SAFE_INTEGER,
			};
			return comparePositions(leftStart, rightStart) || left.message.localeCompare(right.message);
		});
	}

	protected collectIncludes(): void {
		for (let index = 0; index < this.tokens.length; index++) {
			const token = tokenAt(this.tokens, index);
			if (token?.text !== "#") continue;
			const directive = this.nextOnLine(index);
			if (directive < 0 || tokenAt(this.tokens, directive)?.value !== "include") continue;
			const target = this.nextOnLine(directive);
			if (target < 0) {
				this.addDiagnostic("#include needs a header name.", index);
				continue;
			}
			const targetToken = tokenAt(this.tokens, target);
			if (targetToken?.kind === "string") {
				this.imports.push({
					imported: { specifier: targetToken.value, imported: [], reExport: false },
					quoted: true,
					tokenStart: index,
					tokenEnd: target + 1,
				});
				this.markLine(index);
				continue;
			}
			if (targetToken?.text !== "<") {
				this.addDiagnostic("#include needs a quoted or bracketed header name.", target);
				this.markLine(index);
				continue;
			}
			const close = this.findLineText(target, ">", this.nextLine(index));
			let end = close;
			if (close < 0 || tokenAt(this.tokens, close)?.text !== ">") {
				this.addDiagnostic("#include header is not closed.", target);
				end = this.nextLine(index);
			} else {
				const parts: string[] = [];
				for (let part = target + 1; part < close; part++) {
					const item = tokenAt(this.tokens, part);
					if (item !== undefined && item.kind !== "newline" && item.kind !== "comment") parts.push(item.text);
				}
				this.imports.push({
					imported: { specifier: parts.join(""), imported: [], reExport: false },
					quoted: false,
					tokenStart: index,
					tokenEnd: close + 1,
				});
				end = close;
			}
			this.markRange(index, Math.max(index, end) + 1);
		}
	}

	protected nextLine(index: number): number {
		for (let current = index; current < this.tokens.length; current++) {
			if (tokenAt(this.tokens, current)?.kind === "newline") return current;
		}
		return this.tokens.length;
	}

	private findLineText(startIndex: number, value: string, limit: number): number {
		for (let index = startIndex; index < limit; index++) {
			const token = tokenAt(this.tokens, index);
			if (token?.kind === "newline") return -1;
			if (token?.text === value) return index;
		}
		return -1;
	}

	private nextOnLine(index: number): number {
		let current = index + 1;
		while (current < this.tokens.length) {
			const token = tokenAt(this.tokens, current);
			if (token?.kind === "newline") return -1;
			if (token !== undefined && isSignificant(token)) return current;
			current++;
		}
		return -1;
	}

	private markLine(index: number): void {
		this.markRange(index, this.nextLine(index));
	}

	protected markRange(startIndex: number, endIndex: number): void {
		for (let index = startIndex; index < endIndex; index++) this.templateTokenIndexes.add(index);
	}

	protected checkDelimiters(): void {
		const stack: Array<{ value: string; index: number }> = [];
		const closes = new Map([
			[")", "("],
			["]", "["],
			["}", "{"],
		]);
		for (let index = 0; index < this.tokens.length; index++) {
			const value = codeText(this.tokens, index);
			if (value === "(" || value === "[" || value === "{") {
				stack.push({ value, index });
				continue;
			}
			const expected = closes.get(value ?? "");
			if (expected === undefined) continue;
			const opening = stack.at(-1);
			if (opening?.value === expected) {
				stack.pop();
			} else {
				this.addDiagnostic(`Unexpected closing delimiter ${value}.`, index);
			}
		}
		for (const opening of stack)
			this.addDiagnostic(`Opening delimiter ${opening.value} is not closed.`, opening.index);
	}

	protected findNextText(startIndex: number, value: string, limit: number): number {
		for (let index = Math.max(0, startIndex); index < limit; index++)
			if (tokenAt(this.tokens, index)?.text === value) return index;
		return -1;
	}

	protected findPreviousText(startIndex: number, value: string, limit: number): number {
		for (let index = startIndex - 1; index >= limit; index--)
			if (tokenAt(this.tokens, index)?.text === value) return index;
		return -1;
	}

	protected findTopLevelAny(startIndex: number, values: string[], limit: number): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = startIndex; index < limit; index++) {
			const value = codeText(this.tokens, index);
			if (value === "(" && parentheses === 0 && brackets === 0 && braces === 0 && values.includes(value))
				return index;
			if (value === "[" && parentheses === 0 && brackets === 0 && braces === 0 && values.includes(value))
				return index;
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
		}
		return -1;
	}

	protected optionalSemicolon(closeIndex: number, limit: number): number {
		if (closeIndex < 0) return limit;
		const next = significantAfter(this.tokens, closeIndex, limit);
		return tokenAt(this.tokens, next)?.text === ";" ? next + 1 : closeIndex + 1;
	}

	protected significantIndexes(startIndex: number, endIndex: number): number[] {
		const indexes: number[] = [];
		for (let index = Math.max(0, startIndex); index < endIndex; index++) {
			const token = tokenAt(this.tokens, index);
			if (
				token !== undefined &&
				isSignificant(token) &&
				!this.declarationSpecifierTokenIndexes.has(index) &&
				!this.directiveTokens.has(index)
			)
				indexes.push(index);
		}
		return indexes;
	}

	protected firstName(startIndex: number, endIndex: number): number {
		for (const index of this.significantIndexes(startIndex, endIndex))
			if (isNameToken(tokenAt(this.tokens, index))) return index;
		return -1;
	}

	protected lastName(startIndex: number, endIndex: number): number {
		const indexes = this.significantIndexes(startIndex, endIndex);
		for (let index = indexes.length - 1; index >= 0; index--) {
			const tokenIndex = indexes[index] as number;
			if (isNameToken(tokenAt(this.tokens, tokenIndex))) return tokenIndex;
		}
		return -1;
	}
}
