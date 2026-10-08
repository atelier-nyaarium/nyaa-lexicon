// Token access, delimiter matching and diagnostics under every C# parse layer.

import { type Diagnostic, type HeaderSpan, NestingGauge, renderHeader, type WorkMeter } from "@nyaa-lexicon/protocol";
import { type LexedSource, lastLine, positionRange, type Token, tokenize } from "./tokens.js";
import { isTrivia, syntaxValue } from "./words.js";

////////////////////////////////
//  Constants

const OPENERS = ["(", "[", "{"];

/** Each closer's opener. */
const CLOSED_BY: ReadonlyMap<string, string> = new Map([
	[")", "("],
	["]", "["],
	["}", "{"],
]);

////////////////////////////////
//  Interfaces & Types

/** Each token's count of open parentheses, brackets and braces before it; each `;` by those counts. */
interface SemicolonIndex {
	depths: Int32Array[];
	found: Map<string, number[]>;
}

////////////////////////////////
//  Classes

export class CsharpTokenStream {
	protected readonly lexed: LexedSource;

	protected readonly tokens: Token[];

	protected readonly diagnostics: Diagnostic[];

	private readonly reportedDiagnostics = new Set<string>();

	/** Each bracket's partner of its own kind, by token index; -1 when it has none. */
	private readonly partners: Int32Array;

	/** Each opener's first comma outside inner groups, by token index; built on first use. */
	private commas: Int32Array | undefined;

	/** Built on first use, for `findSemicolon`. */
	private semicolons: SemicolonIndex | undefined;

	/** Counts every recursive reader's depth, so deep nesting is one problem, never a stack overflow. */
	protected readonly gauge = new NestingGauge();

	/** Where the gauge last opened, for the problem it may raise. */
	protected deepest = 0;

	constructor(
		protected readonly module: string,
		private readonly text: string,
		protected readonly outline = false,
		/** Defined before the file's own `#define` lines: its project's. */
		symbols: readonly string[] = [],
		protected readonly meter?: WorkMeter,
	) {
		this.lexed = tokenize(text, { collectLiterals: !outline, collectComments: !outline, symbols });
		this.tokens = this.lexed.tokens;
		this.diagnostics = [...this.lexed.diagnostics];
		this.partners = this.pairBrackets();
	}

	private pairBrackets(): Int32Array {
		const partners = new Int32Array(this.tokens.length).fill(-1);
		const open = new Map<string, number[]>(OPENERS.map((opener) => [opener, []]));
		for (let index = 0; index < this.tokens.length; index++) {
			const item = this.tokens[index] as Token;
			if (item.kind !== "punctuation") continue;
			const stack = open.get(item.value) ?? open.get(CLOSED_BY.get(item.value) ?? "");
			if (stack === undefined) continue;
			if (open.has(item.value)) {
				stack.push(index);
				continue;
			}
			const partner = stack.pop();
			if (partner === undefined) continue;
			partners[partner] = index;
			partners[index] = partner;
		}
		return partners;
	}

	private findCommas(): Int32Array {
		const commas = new Int32Array(this.tokens.length).fill(-1);
		const groups: number[] = [];
		for (let index = 0; index < this.tokens.length; index++) {
			const item = this.tokens[index] as Token;
			if (item.kind !== "punctuation") continue;
			const group = groups.at(-1);
			if (OPENERS.includes(item.value)) groups.push(index);
			else if (group !== undefined && this.partners[index] === group) groups.pop();
			else if (group !== undefined && item.value === "," && commas[group] === -1) commas[group] = index;
		}
		return commas;
	}

	private indexSemicolons(): SemicolonIndex {
		const [parentheses, brackets, braces] = [0, 1, 2].map(() => new Int32Array(this.tokens.length + 1)) as [
			Int32Array,
			Int32Array,
			Int32Array,
		];
		const found = new Map<string, number[]>();
		let [open, square, curly] = [0, 0, 0];
		for (let index = 0; index <= this.tokens.length; index++) {
			parentheses[index] = open;
			brackets[index] = square;
			braces[index] = curly;
			const item = this.tokens[index];
			if (item?.kind !== "punctuation") continue;
			const value = item.value;
			if (value === "(") open++;
			else if (value === ")") open--;
			else if (value === "[") square++;
			else if (value === "]") square--;
			else if (value === "{") curly++;
			else if (value === "}") curly--;
			else if (value === ";") {
				const key = `${open},${square},${curly}`;
				const list = found.get(key);
				if (list === undefined) found.set(key, [index]);
				else list.push(index);
			}
		}
		return { depths: [parentheses, brackets, braces], found };
	}

	/** The first comma in the group opening at `open`, outside its inner groups; -1 when none. */
	protected firstComma(open: number): number {
		this.commas ??= this.findCommas();
		const comma = this.commas[open] ?? -1;
		const close = this.partners[open] ?? -1;
		return comma >= 0 && comma < close ? comma : -1;
	}

	protected token(index: number): Token | undefined {
		return this.tokens[index];
	}

	/** A header over the source, which no layer above reads directly. */
	protected render(span: HeaderSpan): string | undefined {
		return renderHeader(this.text, span, this.meter);
	}

	/** Runs `read` one nesting level deeper, at `index`. */
	protected nested<T>(index: number, read: () => T): T {
		this.deepest = index;
		this.gauge.open();
		try {
			return read();
		} finally {
			this.gauge.close();
		}
	}

	protected value(index: number): string | undefined {
		return syntaxValue(this.token(index));
	}

	/** The first significant token at or after `index`; -1 for none, or for a negative `index`. */
	protected nextSignificant(index: number, end = this.tokens.length): number {
		if (index < 0) return -1;
		let current = index;
		while (current < end && isTrivia(this.token(current))) {
			if (this.meter !== undefined) this.meter.steps++;
			current++;
		}
		return current < end ? current : -1;
	}

	protected previousSignificant(index: number, start = 0): number {
		let current = index - 1;
		while (current >= start && isTrivia(this.token(current))) {
			if (this.meter !== undefined) this.meter.steps++;
			current--;
		}
		return current;
	}

	/** The closer of the `open` at `index`, before `end`; -1 when none. */
	protected matching(index: number, open: string, close: string, end = this.tokens.length): number {
		const item = this.token(index);
		if (item?.kind === "punctuation" && item.value === open && CLOSED_BY.get(close) === open) {
			const partner = this.partners[index] as number;
			return partner >= 0 && partner < end ? partner : -1;
		}
		let depth = 0;
		for (let current = index; current < end; current++) {
			if (this.meter !== undefined) this.meter.steps++;
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

	/** The opener the `closer` at `close` closes; -1 when none. */
	protected opener(close: number, open: string, closer: string): number {
		const item = this.token(close);
		if (item?.kind !== "punctuation" || item.value !== closer || CLOSED_BY.get(closer) !== open) return -1;
		return this.partners[close] as number;
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

	/** The first `;` in `[start, end)` where each bracket kind's opens and closes since `start` cancel; -1 when none. */
	protected findSemicolon(start: number, end: number): number {
		this.semicolons ??= this.indexSemicolons();
		const from = Math.min(Math.max(0, start), this.tokens.length);
		const key = this.semicolons.depths.map((depth) => depth[from]).join(",");
		const found = this.semicolons.found.get(key) ?? [];
		let low = 0;
		let high = found.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((found[middle] as number) < from) low = middle + 1;
			else high = middle;
		}
		const semicolon = found[low];
		return semicolon !== undefined && semicolon < end ? semicolon : -1;
	}

	protected lastIdentifier(start: number, end: number): number {
		let found = -1;
		for (let current = start; current < end; current++) {
			if (this.token(current)?.kind === "identifier") found = current;
		}
		return found;
	}

	protected sourceSpan(start: Token, end: Token): string {
		return this.lexed.cursor.textOf(start.startOffset, end.endOffset).trim();
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
