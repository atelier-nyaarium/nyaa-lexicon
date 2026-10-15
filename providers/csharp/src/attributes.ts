// C# attribute sections, `[...]`: their names are type uses, and a declaration's header starts at them.

import { type AttributeSection, positionKey } from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
import type { Token } from "./tokens.js";
import { isIdentifier, syntaxValue } from "./words.js";

////////////////////////////////
//  Classes

export class CsharpAttributeReader {
	constructor(private readonly context: CsharpParseContext) {}

	/** One `[...]` section at `index`; `close` is -1 when it never closes. */
	public attributeSectionAt(index: number, end: number): AttributeSection | undefined {
		const open = this.context.tokenStream.nextSignificant(index, end);
		if (open < 0 || this.context.tokenStream.value(open) !== "[") return undefined;
		const close = this.context.tokenStream.matching(open, "[", "]", end);
		if (close < 0) {
			this.context.tokenStream.report("Attribute list is not closed.", this.context.tokenStream.token(open));
			return { open, close, attached: false };
		}
		let cursor = this.context.tokenStream.nextSignificant(open + 1, close);
		let attached = true;
		const target = this.context.tokenStream.token(cursor);
		if (isIdentifier(target)) {
			const colon = this.context.tokenStream.nextSignificant(cursor + 1, close);
			if (this.context.tokenStream.value(colon) === ":") {
				this.context.recorder.ignore(target.startOffset);
				attached = syntaxValue(target) !== "assembly" && syntaxValue(target) !== "module";
				cursor = this.context.tokenStream.nextSignificant(colon + 1, close);
			}
		}
		while (cursor >= 0 && cursor < close) {
			const name = this.attributeName(cursor, close);
			this.context.recorder.addTypeReference(cursor, name.end - 1, "typeUse");
			if (name.token !== undefined) this.context.recorder.markAttributeName(positionKey(name.token.start));
			let next = name.end;
			if (this.context.tokenStream.value(next) === "(") {
				const argumentsClose = this.context.tokenStream.matching(next, "(", ")", close);
				next = argumentsClose < 0 ? close : argumentsClose + 1;
			}
			if (this.context.tokenStream.value(next) === ",") next++;
			cursor = this.context.tokenStream.nextSignificant(Math.max(next, cursor + 1), close);
		}
		return { open, close, attached };
	}

	/** Where the name span ends, and its type identifier. */
	private attributeName(start: number, close: number): { end: number; token: Token | undefined } {
		let cursor = start;
		let token: Token | undefined;
		while (cursor >= 0 && cursor < close) {
			const item = this.context.tokenStream.token(cursor);
			const value = syntaxValue(item);
			if (value === "<") {
				const angleClose = this.context.typeReader.listClose(cursor, close);
				cursor = angleClose < 0 ? close : angleClose + 1;
				break;
			}
			if (isIdentifier(item)) token = item;
			else if (value !== "." && value !== "::") break;
			cursor = this.context.tokenStream.nextSignificant(cursor + 1, close);
		}
		return { end: cursor < 0 ? close : cursor, token };
	}

	/** Marks every section at `index`; answers where the last ends. */
	public afterAttributeSections(index: number, end: number): number {
		let current = index;
		for (;;) {
			const section = this.attributeSectionAt(current, end);
			if (section === undefined || section.close < 0) return current;
			current = section.close + 1;
		}
	}

	/** Marks every `[...]` section without declaring anything. */
	public walkAttributeSections(start: number, end: number): void {
		let current = this.context.tokenStream.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const section = this.attributeSectionAt(current, end);
			if (section !== undefined) {
				current = section.close < 0 ? end : this.context.tokenStream.nextSignificant(section.close + 1, end);
				continue;
			}
			current = this.context.tokenStream.nextSignificant(current + 1, end);
		}
	}

	/** Where a run of `[...]` sections ends, without marking them. */
	public bracketedSectionsEnd(index: number, end: number): number {
		let current = index;
		for (;;) {
			const open = this.context.tokenStream.nextSignificant(current, end);
			if (open < 0 || this.context.tokenStream.value(open) !== "[") return current;
			const close = this.context.tokenStream.matching(open, "[", "]", end);
			if (close < 0) return current;
			current = close + 1;
		}
	}
}
