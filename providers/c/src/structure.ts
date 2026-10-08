// Delimiter pairs, directives and conditional groups: the structure every C parse layer reads.

import type { CommentSpan, Diagnostic, WorkMeter } from "@nyaa-lexicon/protocol";
import type { ConditionalFrame, DelimiterEntry, Directive } from "./model.js";
import type { CToken } from "./tokens.js";
import { nextCode, previousCode, tokenValue } from "./tokenWalk.js";
import { ATTRIBUTE_SPECIFIERS, CLOSERS, OPENERS } from "./words.js";

////////////////////////////////
//  Classes

export class CStructure {
	protected readonly pairs = new Map<number, number>();

	protected readonly directives = new Map<number, Directive>();

	protected readonly directiveEndByToken = new Map<number, number>();

	protected readonly conditionalByIndex = new Map<number, string>();

	protected readonly conditionalGroupByIndex = new Map<number, string>();

	protected readonly directiveTokens = new Set<number>();

	protected readonly includePathTokens = new Set<number>();

	/** Inside `__attribute__((...))`, `__declspec(...)` or `[[...]]`. */
	protected readonly attributeTokens = new Set<number>();

	protected readonly diagnostics: Diagnostic[];

	private conditionalSerial = 0;

	private structured = false;

	private unpaired = 0;

	constructor(
		protected readonly module: string,
		protected readonly text: string,
		protected readonly tokens: CToken[],
		protected readonly comments: CommentSpan[],
		protected readonly blankLines: number[],
		initialDiagnostics: Diagnostic[],
		protected readonly meter?: WorkMeter,
	) {
		this.diagnostics = [...initialDiagnostics];
	}

	/** Whether every delimiter pairs. */
	paired(): boolean {
		this.buildStructure();
		return this.unpaired === 0;
	}

	protected addDiagnostic(message: string, start: number, end = start): void {
		const first = this.tokens[start];
		const last = this.tokens[end] ?? first;
		if (first === undefined) return;
		this.diagnostics.push({
			severity: "error",
			message,
			path: this.module,
			range: { start: first.start, end: last?.end ?? first.end },
		});
	}

	protected buildStructure(): void {
		if (this.structured) return;
		this.structured = true;
		this.buildDirectives();
		this.buildPairs();
		this.buildAttributes();
	}

	private buildAttributes(): void {
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as CToken;
			const specifier = token.kind === "identifier" && ATTRIBUTE_SPECIFIERS.has(token.value);
			if ((!specifier && tokenValue(this.tokens, index) !== "[") || this.directiveTokens.has(index)) continue;
			const next = nextCode(this.tokens, index + 1);
			let open = -1;
			if (specifier && tokenValue(this.tokens, next) === "(") open = next;
			else if (!specifier && tokenValue(this.tokens, next) === "[") open = index;
			const close = open < 0 ? undefined : this.pairs.get(open);
			if (close === undefined || close < open) continue;
			for (let member = open; member <= close; member++) this.attributeTokens.add(member);
			index = close;
		}
	}

	private buildPairs(): void {
		const stack: DelimiterEntry[] = [];
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as CToken;
			const directive = this.directives.get(index);
			if (directive !== undefined) {
				index = Math.max(index, directive.end - 1);
				continue;
			}
			if (this.directiveTokens.has(index)) continue;
			if (token.kind !== "symbol") continue;
			if (OPENERS.has(token.value)) {
				stack.push({ value: token.value, index, aliases: [] });
				continue;
			}
			const opening = CLOSERS.get(token.value);
			if (opening === undefined) continue;
			const top = stack.at(-1);
			if (top?.value !== opening) {
				this.unpaired++;
				this.addDiagnostic(`Unexpected closing delimiter ${token.raw}.`, index);
				continue;
			}
			stack.pop();
			this.pairs.set(top.index, index);
			this.pairs.set(index, top.index);
			for (const alias of top.aliases) this.pairs.set(alias, index);
		}
		for (const open of stack) {
			if (open.value === "{" && this.isLinkageBlockOpen(open.index)) continue;
			this.unpaired++;
			this.addDiagnostic(`Opening ${open.value} is not closed before end of file.`, open.index);
		}
	}

	/** Only the two linkages the language defines; any other string is not a block opener. */
	protected isLinkageString(index: number): boolean {
		const token = this.tokens[index];
		return token?.kind === "string" && (token.value === "C" || token.value === "C++");
	}

	private isLinkageBlockOpen(openIndex: number): boolean {
		const stringIndex = previousCode(this.tokens, openIndex);
		const externIndex = previousCode(this.tokens, stringIndex);
		return this.isLinkageString(stringIndex) && tokenValue(this.tokens, externIndex) === "extern";
	}

	private directiveEnd(start: number): number {
		let index = start + 1;
		while (index < this.tokens.length) {
			const token = this.tokens[index] as CToken;
			if (token.kind === "newline") {
				let previous = index - 1;
				while (previous >= start && this.tokens[previous]?.kind === "comment") previous--;
				if (previous >= start && tokenValue(this.tokens, previous) === "\\") {
					index++;
					continue;
				}
				return index;
			}
			index++;
		}
		return this.tokens.length;
	}

	private buildDirectives(): void {
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as CToken;
			if (token.kind !== "symbol" || token.value !== "#" || !token.lineStart) continue;
			const end = this.directiveEnd(index);
			const keywordIndex = nextCode(this.tokens, index + 1, end);
			const keywordToken = this.tokens[keywordIndex];
			if (keywordToken?.kind !== "identifier") continue;
			this.directives.set(index, { start: index, end, keyword: keywordToken.value, keywordIndex });
			for (let member = index; member < end; member++) {
				this.directiveTokens.add(member);
				this.directiveEndByToken.set(member, end);
			}
			index = Math.max(index, end - 1);
		}
	}

	protected buildConditionals(): void {
		const stack: ConditionalFrame[] = [];
		let key = "";
		let group = "";
		for (let index = 0; index < this.tokens.length; index++) {
			this.conditionalByIndex.set(index, key);
			this.conditionalGroupByIndex.set(index, group);
			const directive = this.directives.get(index);
			if (directive === undefined) continue;
			switch (directive.keyword) {
				case "if":
				case "ifdef":
				case "ifndef":
					this.conditionalSerial++;
					stack.push({ id: this.conditionalSerial, branch: 0, outerKey: key, outerGroup: group });
					break;
				case "elif":
				case "else": {
					const frame = stack.at(-1);
					if (frame !== undefined) frame.branch++;
					break;
				}
				case "endif": {
					const frame = stack.pop();
					key = frame?.outerKey ?? key;
					group = frame?.outerGroup ?? group;
					continue;
				}
				default:
					continue;
			}
			const frame = stack.at(-1);
			if (frame === undefined) continue;
			key = `${frame.outerKey}${frame.outerKey === "" ? "" : "|"}${frame.id}:${frame.branch}`;
			group = `${frame.outerGroup}${frame.outerGroup === "" ? "" : "|"}${frame.id}`;
		}
	}
}
