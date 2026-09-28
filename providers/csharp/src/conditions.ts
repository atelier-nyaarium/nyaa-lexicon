// C# conditional compilation expressions, `#if` and `#elif`, over the symbols `#define` set.

import type { Range } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export interface ConditionToken {
	kind: "name" | "operator";
	value: string;
	range: Range;
}

////////////////////////////////
//  Constants

/** Longest first. */
export const CONDITION_OPERATORS = ["&&", "||", "==", "!=", "!", "(", ")"] as const;

/** Deeper is invalid. */
const MAX_CONDITION_DEPTH = 64;

////////////////////////////////
//  Classes

/** A conditional directive's expression over the symbols `#define` set; invalid reads as far as it parsed. */
export class ConditionEvaluator {
	private index = 0;
	valid = true;
	/** Where the expression first went wrong; undefined past its last token. */
	problem: ConditionToken | undefined;

	constructor(
		private readonly items: ConditionToken[],
		private readonly defined: ReadonlySet<string>,
	) {}

	value(): boolean {
		const value = this.or(0);
		if (this.index !== this.items.length) this.fail();
		return value;
	}

	private fail(): void {
		if (!this.valid) return;
		this.valid = false;
		this.problem = this.items[this.index];
	}

	private or(depth: number): boolean {
		let value = this.and(depth);
		while (this.accept("||")) value = this.and(depth) || value;
		return value;
	}

	private and(depth: number): boolean {
		let value = this.equality(depth);
		while (this.accept("&&")) value = this.equality(depth) && value;
		return value;
	}

	private equality(depth: number): boolean {
		let value = this.unary(depth);
		for (;;) {
			const equal = this.accept("==") ? true : this.accept("!=") ? false : undefined;
			if (equal === undefined) return value;
			value = (value === this.unary(depth)) === equal;
		}
	}

	private unary(depth: number): boolean {
		if (depth > MAX_CONDITION_DEPTH) {
			this.fail();
			this.index = this.items.length;
			return false;
		}
		if (this.accept("!")) return !this.unary(depth + 1);
		if (this.accept("(")) {
			const inner = this.or(depth + 1);
			if (!this.accept(")")) this.fail();
			return inner;
		}
		const item = this.items[this.index];
		if (item?.kind !== "name") {
			this.fail();
			return false;
		}
		this.index++;
		return item.value === "true" ? true : item.value === "false" ? false : this.defined.has(item.value);
	}

	private accept(operator: string): boolean {
		const item = this.items[this.index];
		if (item?.kind !== "operator" || item.value !== operator) return false;
		this.index++;
		return true;
	}
}
