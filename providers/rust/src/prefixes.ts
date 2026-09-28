import type { Declaration } from "@nyaa-lexicon/protocol";
import { Delimiters } from "./delimiters.js";
import { isValueToken, type RustToken } from "./tokens.js";

////////////////////////////////
//  Constants

/** Modifiers that are keywords wherever they appear. */
const MODIFIERS = new Set(["async", "extern", "unsafe"]);

/** Contextual modifiers, each with the words it may precede. */
const CONTEXTUAL_MODIFIERS = new Map([
	["default", new Set(["fn", "impl", "type", "const", "unsafe", "async", "extern", "pub"])],
	["auto", new Set(["trait"])],
	["safe", new Set(["fn", "static"])],
	["gen", new Set(["fn"])],
]);

/** Words after which `const` qualifies a function. */
const CONST_FUNCTION_NEXT = new Set(["fn", "unsafe", "async", "extern"]);

////////////////////////////////
//  Interfaces & Types

export interface Prefix {
	index: number;
	/** The first outer attribute above the item, else its first token. */
	start: RustToken;
	/** Where the header starts, outer attributes included. */
	headerStart: number;
	visibility: Declaration["visibility"];
	exported: boolean;
	modifiers: Set<string>;
	/** Contextual modifier tokens, keywords only once an item follows. */
	words: number[];
}

////////////////////////////////
//  Classes

/** Outer attributes, and the visibility and modifiers an item starts with. */
export abstract class Prefixes extends Delimiters {
	protected readonly attributeTokens = new Set<number>();

	////////////////////////////////
	//  Attributes and prefixes

	protected skipAttributes(start: number, end: number): number {
		let index = start;
		while (index < end && isValueToken(this.tokens[index], "#")) {
			const open = isValueToken(this.tokens[index + 1], "!") ? index + 2 : index + 1;
			if (!isValueToken(this.tokens[open], "[")) break;
			const close = this.matchingIndex(open);
			if (close < 0 || close >= end) {
				this.addDiagnostic("attribute has no closing bracket", this.tokens[open]);
				return end;
			}
			for (let tokenIndex = index; tokenIndex <= close; tokenIndex++) this.attributeTokens.add(tokenIndex);
			index = close + 1;
		}
		return index;
	}

	/** The first outer attribute directly above `index`. */
	protected rangeStart(index: number): number {
		let first = index;
		while (isValueToken(this.tokens[first - 1], "]")) {
			const open = this.matchingIndex(first - 1);
			if (open < 1 || !isValueToken(this.tokens[open - 1], "#")) break;
			first = open - 1;
		}
		return first;
	}

	protected prefix(start: number, end: number): Prefix {
		let index = start;
		let visibility: Declaration["visibility"] = "private";
		let exported = false;
		const modifiers = new Set<string>();
		const words: number[] = [];
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("prefix parser failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			const next = this.tokens[index + 1];
			if (isValueToken(token, "pub")) {
				exported = true;
				visibility = "public";
				index++;
				const close = isValueToken(this.tokens[index], "(") ? this.matchingIndex(index) : -1;
				if (close < 0) continue;
				const inner = this.tokens.slice(index + 1, close).map((value) => value.raw);
				if (inner.length === 1 && inner[0] === "self") {
					visibility = "private";
					exported = false;
				} else if (inner.includes("crate") || inner.includes("super") || inner.includes("in")) {
					visibility = "internal";
				}
				index = close + 1;
				continue;
			}
			if (isValueToken(token, "const") && CONST_FUNCTION_NEXT.has(next?.raw ?? "")) {
				modifiers.add("const");
				index++;
				continue;
			}
			if (token.kind === "identifier" && MODIFIERS.has(token.raw)) {
				modifiers.add(token.raw);
				index++;
				if (token.raw === "extern" && this.tokens[index]?.kind === "string") index++;
				continue;
			}
			const precedes = token.kind === "identifier" ? CONTEXTUAL_MODIFIERS.get(token.raw) : undefined;
			if (precedes?.has(next?.raw ?? "") === true) {
				modifiers.add(token.raw);
				words.push(index);
				index++;
				continue;
			}
			break;
		}
		return {
			index,
			start: this.tokens[this.rangeStart(start)] as RustToken,
			headerStart: this.headers.start(start),
			visibility,
			exported,
			modifiers,
			words,
		};
	}
}
