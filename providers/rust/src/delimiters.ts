import { comparePositions, type Diagnostic } from "@nyaa-lexicon/protocol";
import { type TypeBrackets, typeBrackets } from "./angles.js";
import { HeaderReader } from "./header.js";
import { isValueToken, type RustToken, type ScanResult, tokenAt, tokenize } from "./tokens.js";

////////////////////////////////
//  Constants

export const OPENERS = new Set(["(", "[", "{"]);

const CLOSERS = new Set([")", "]", "}"]);

////////////////////////////////
//  Functions & Helpers

export function isSymbolIn(token: RustToken | undefined, values: ReadonlySet<string>): boolean {
	return token?.kind === "symbol" && values.has(token.value);
}

////////////////////////////////
//  Classes

/** A file's tokens, their groups and type brackets, the scans over them, and its diagnostics. */
export abstract class Delimiters {
	protected readonly scan: ScanResult;
	protected readonly tokens: RustToken[];
	private readonly matching = new Map<number, number>();
	/** Each token's innermost open group, or -1. */
	protected readonly enclosing: Int32Array;
	protected readonly brackets: TypeBrackets;
	protected readonly headers: HeaderReader;
	private readonly pendingDiagnostics: Diagnostic[] = [];

	constructor(
		protected readonly module: string,
		protected readonly text: string,
		protected readonly depth: "full" | "outline" = "full",
	) {
		this.scan = tokenize(text);
		this.tokens = this.scan.tokens;
		this.enclosing = new Int32Array(this.tokens.length);
		this.buildMatching();
		this.brackets = typeBrackets(this.tokens);
		this.headers = new HeaderReader(text, this.tokens, this.matching, this.scan.commentOffsets, this.brackets);
	}

	////////////////////////////////
	//  Delimiters

	private buildMatching(): void {
		const stack: Array<{ value: string; index: number }> = [];
		const closes = new Map([
			[")", "("],
			["]", "["],
			["}", "{"],
		]);
		let guard = -1;
		for (let index = 0; index < this.tokens.length; index++) {
			if (index <= guard) throw new Error("delimiter scan failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			this.enclosing[index] = stack.at(-1)?.index ?? -1;
			if (isSymbolIn(token, OPENERS)) {
				stack.push({ value: token.value, index });
				continue;
			}
			if (token.kind !== "symbol") continue;
			const opening = closes.get(token.value);
			if (opening === undefined) continue;
			const previous = stack.pop();
			if (previous === undefined || previous.value !== opening) {
				this.addDiagnostic("unexpected closing delimiter", token);
				if (previous !== undefined) stack.push(previous);
				continue;
			}
			this.matching.set(previous.index, index);
			this.matching.set(index, previous.index);
		}
		for (const open of stack)
			this.addDiagnostic("opening delimiter is not closed before end of file", this.tokens[open.index]);
	}

	protected diagnostics(): Diagnostic[] {
		const diagnostics: Diagnostic[] = this.scan.diagnostics.map((diagnostic) => ({
			severity: "error",
			message: diagnostic.message,
			path: this.module,
			range: { start: diagnostic.span.start, end: diagnostic.span.end },
		}));
		for (const diagnostic of this.pendingDiagnostics) diagnostics.push(diagnostic);
		const last = { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
		return diagnostics.sort((left, right) =>
			comparePositions(left.range?.start ?? last, right.range?.start ?? last),
		);
	}

	protected addDiagnostic(message: string, token: RustToken | undefined): void {
		this.pendingDiagnostics.push({
			severity: "error",
			message,
			path: this.module,
			...(token === undefined ? {} : { range: { start: token.start, end: token.end } }),
		});
	}

	protected matchingIndex(index: number): number {
		return this.matching.get(index) ?? -1;
	}

	/** Past the group opening at `index`, else the next token. */
	protected past(index: number): number {
		const close = isSymbolIn(this.tokens[index], OPENERS) ? this.matchingIndex(index) : -1;
		return close > index ? close + 1 : index + 1;
	}

	/** The closer of the innermost brace group holding `index`, else `end`. */
	protected blockEnd(index: number, end: number): number {
		let open = this.enclosing[index] ?? -1;
		while (open >= 0 && !isValueToken(this.tokens[open], "{")) open = this.enclosing[open] ?? -1;
		const close = open >= 0 ? this.matchingIndex(open) : -1;
		return close >= 0 && close < end ? close : end;
	}

	/** The source of tokens `[start, end)`. */
	protected textOfTokens(start: number, end: number): string {
		const first = tokenAt(this.tokens, start);
		const last = tokenAt(this.tokens, end - 1);
		if (first === undefined || last === undefined || end <= start) return "";
		return this.scan.textOf(first.startOffset, last.endOffset);
	}

	/** Type brackets the token opens, less those it closes. */
	protected angleDeltaAt(index: number): number {
		return this.brackets.deltas.get(index) ?? 0;
	}

	/** Past a generic list opening at `start`, else `start`. */
	protected pastGenerics(start: number, end: number): number {
		if (this.angleDeltaAt(start) <= 0) return start;
		let depth = 0;
		for (let index = start; index < end; index++) {
			depth += this.angleDeltaAt(index);
			if (depth <= 0) return index + 1;
		}
		return end;
	}

	/** The `;` ending a statement at this depth, else the last token before `end`. */
	protected statementEnd(start: number, end: number): number {
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("statement parser failed to advance");
			guard = index;
			if (isValueToken(this.tokens[index], ";")) return index;
			index = this.past(index);
		}
		return Math.max(start, end - 1);
	}

	/** The last token of an expression: before a `,` or `;` at its depth, or its group's closer. */
	protected expressionEnd(start: number, end: number): number {
		let index = start;
		let last = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("expression parser failed to advance");
			guard = index;
			const token = this.tokens[index];
			if (isValueToken(token, ",") || isValueToken(token, ";") || isSymbolIn(token, CLOSERS)) break;
			const next = this.past(index);
			last = next - 1;
			index = next;
		}
		return Math.min(last, end - 1);
	}

	protected topLevelToken(start: number, end: number, value: string): number {
		const found = this.topLevelStop(start, end, new Set([value]));
		return found < end ? found : -1;
	}

	/** The first token in `values` outside every group and type bracket, else `end`. */
	protected topLevelStop(start: number, end: number, values: ReadonlySet<string>): number {
		let index = start;
		let angles = 0;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("stop scan failed to advance");
			guard = index;
			const current = this.tokens[index] as RustToken;
			if (angles === 0 && (current.kind === "symbol" || current.kind === "identifier") && values.has(current.raw))
				return index;
			if (isSymbolIn(current, OPENERS)) {
				const close = this.matchingIndex(index);
				if (close > index) {
					index = close + 1;
					continue;
				}
			}
			angles = Math.max(0, angles + this.angleDeltaAt(index));
			index++;
		}
		return end;
	}

	protected segments(start: number, end: number): Array<[number, number]> {
		const segments: Array<[number, number]> = [];
		let segmentStart = start;
		let index = start;
		let guard = -1;
		while (index < end) {
			const comma = this.topLevelToken(index, end, ",");
			if (index <= guard) throw new Error("segment scan failed to advance");
			guard = index;
			if (comma < 0) break;
			segments.push([segmentStart, comma]);
			segmentStart = comma + 1;
			index = comma + 1;
		}
		if (segmentStart < end) segments.push([segmentStart, end]);
		return segments;
	}
}
