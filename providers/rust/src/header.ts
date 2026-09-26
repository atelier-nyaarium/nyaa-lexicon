// A declaration's header spans, handed to the protocol's one renderer.

import { type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";
import { angleDelta, isValueToken, KEYWORDS, type RustToken } from "./tokens.js";

////////////////////////////////
//  Constants

const OPENERS = new Set(["(", "[", "{"]);

const COMMA = new Set([","]);

const PIPE = new Set(["|"]);

const BRACE = new Set(["{"]);

/** Keywords that still end an operand. */
const OPERAND_WORDS = new Set(["self", "Self", "true", "false", "crate", "super", "await"]);

////////////////////////////////
//  Functions & Helpers

/** Whether a `(` or `[` after this token applies to it: a call or an index. */
function endsOperand(token: RustToken): boolean {
	if (token.kind === "number" || token.kind === "string" || token.kind === "char") return true;
	if (token.kind === "identifier") return !KEYWORDS.has(token.value) || OPERAND_WORDS.has(token.value);
	return token.value === "?";
}

function isMacroName(token: RustToken | undefined): boolean {
	return token?.kind === "identifier" && !KEYWORDS.has(token.value);
}

////////////////////////////////
//  Classes

/** Header spans over one file's tokens. Indices are token indices, stops exclusive. */
export class HeaderReader {
	constructor(
		private readonly text: string,
		private readonly tokens: readonly RustToken[],
		private readonly matching: ReadonlyMap<number, number>,
		private readonly comments: readonly OffsetRange[],
	) {}

	/** The first outer attribute directly above `index`, else `index`. */
	start(index: number): number {
		let first = index;
		while (isValueToken(this.tokens[first - 1], "]")) {
			const open = this.matching.get(first - 1) ?? -1;
			if (open < 1 || !isValueToken(this.tokens[open - 1], "#")) break;
			first = open - 1;
		}
		return first;
	}

	/** The first token at bracket depth zero whose value is in `values`, else `end`. */
	stop(start: number, end: number, values: ReadonlySet<string>): number {
		let index = start;
		while (index < end) {
			const token = this.tokens[index];
			if (token?.kind === "symbol" && values.has(token.value)) return index;
			index = this.past(index);
		}
		return end;
	}

	/** Tokens `[first, stop)` on one line; from `valueStart`, its literal containers fold. */
	render(first: number, stop: number, valueStart?: number): string | undefined {
		return this.rendered(first, stop, valueStart, undefined);
	}

	/** A declarator's tokens `[first, stop)` after the one `lead` token its siblings share. */
	renderAfter(lead: number, first: number, stop: number): string | undefined {
		return this.rendered(first, stop, undefined, this.tokens[lead]);
	}

	private rendered(
		first: number,
		stop: number,
		valueStart: number | undefined,
		lead: RustToken | undefined,
	): string | undefined {
		const head = this.tokens[first];
		const last = this.tokens[stop - 1];
		if (head === undefined || last === undefined || stop <= first) return undefined;
		const span = { start: head.startOffset, end: last.endOffset };
		const folds: OffsetRange[] = [];
		if (valueStart !== undefined) this.collectFolds(valueStart, stop, folds);
		return renderHeader(this.text, {
			...(lead === undefined ? {} : { lead: { start: lead.startOffset, end: lead.endOffset } }),
			...span,
			folds,
			omit: this.commentsWithin(span),
			verbatim: this.literalsWithin(first, stop),
		});
	}

	/** String and character literals, which keep their whitespace. */
	private literalsWithin(first: number, stop: number): OffsetRange[] {
		const found: OffsetRange[] = [];
		for (let index = first; index < stop; index++) {
			const token = this.tokens[index] as RustToken;
			if (token.kind === "string" || token.kind === "char") {
				found.push({ start: token.startOffset, end: token.endOffset });
			}
		}
		return found;
	}

	/** Past the group opening at `index`, else the next token. */
	private past(index: number): number {
		const close = this.closeOf(index);
		return close > index ? close + 1 : index + 1;
	}

	private closeOf(index: number): number {
		const token = this.tokens[index];
		if (token?.kind !== "symbol" || !OPENERS.has(token.value)) return -1;
		return this.matching.get(index) ?? -1;
	}

	private commentsWithin(span: OffsetRange): OffsetRange[] {
		let low = 0;
		let high = this.comments.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((this.comments[middle]?.start ?? span.start) < span.start) low = middle + 1;
			else high = middle;
		}
		const found: OffsetRange[] = [];
		for (let index = low; index < this.comments.length; index++) {
			const comment = this.comments[index] as OffsetRange;
			if (comment.start >= span.end) break;
			found.push(comment);
		}
		return found;
	}

	/** Literal containers in a value, outermost only. */
	private collectFolds(start: number, stop: number, folds: OffsetRange[]): void {
		let operand = false;
		let index = start;
		while (index < stop) {
			const token = this.tokens[index] as RustToken;
			if (isValueToken(token, "::") && isValueToken(this.tokens[index + 1], "<")) {
				index = this.turbofishEnd(index + 1, stop);
				operand = true;
				continue;
			}
			if (!operand && (isValueToken(token, "|") || isValueToken(token, "||"))) {
				index = this.closureBody(index, stop);
				continue;
			}
			const close = this.closeOf(index);
			if (close <= index || close >= stop) {
				operand = endsOperand(token);
				index++;
				continue;
			}
			if (this.isContainer(index, close, operand)) {
				folds.push({ start: token.startOffset, end: (this.tokens[close] as RustToken).endOffset });
			} else {
				this.collectFolds(index + 1, close, folds);
			}
			operand = true;
			index = close + 1;
		}
	}

	/** Past the generic arguments opening at `open`. */
	private turbofishEnd(open: number, stop: number): number {
		let depth = 0;
		for (let index = open; index < stop; index++) {
			depth += angleDelta(this.tokens[index] as RustToken);
			if (depth <= 0) return index + 1;
		}
		return stop;
	}

	/** Past a closure's typed parameters and return type, which never fold. */
	private closureBody(open: number, stop: number): number {
		const body = isValueToken(this.tokens[open], "||") ? open + 1 : this.stop(open + 1, stop, PIPE) + 1;
		return isValueToken(this.tokens[body], "->") ? this.stop(body + 1, stop, BRACE) : body;
	}

	/** Blocks and bodies always; brackets and tuples unless called or indexed. */
	private isContainer(open: number, close: number, afterOperand: boolean): boolean {
		const value = this.tokens[open]?.value;
		if (value === "{") return true;
		// Parenthesized macro arguments read as a call.
		if (isValueToken(this.tokens[open - 1], "!") && isMacroName(this.tokens[open - 2])) return value === "[";
		if (afterOperand) return false;
		return value === "[" || this.stop(open + 1, close, COMMA) < close;
	}
}
