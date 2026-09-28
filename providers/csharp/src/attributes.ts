// C# attribute sections, `[...]`: their names are type uses, and a declaration's header starts at them.

import { type AttributeSection, positionKey } from "./model.js";
import { CsharpRecorder } from "./recorder.js";
import type { Token } from "./tokens.js";
import { isIdentifier, syntaxValue } from "./words.js";

////////////////////////////////
//  Classes

export abstract class CsharpAttributeReader extends CsharpRecorder {
	/** One `[...]` section at `index`; `close` is -1 when it never closes. */
	protected attributeSectionAt(index: number, end: number): AttributeSection | undefined {
		const open = this.nextSignificant(index, end);
		if (open < 0 || this.value(open) !== "[") return undefined;
		const close = this.matching(open, "[", "]", end);
		if (close < 0) {
			this.report("Attribute list is not closed.", this.token(open));
			return { open, close, attached: false };
		}
		let cursor = this.nextSignificant(open + 1, close);
		let attached = true;
		const target = this.token(cursor);
		if (isIdentifier(target)) {
			const colon = this.nextSignificant(cursor + 1, close);
			if (this.value(colon) === ":") {
				this.ignoredOffsets.add(target.startOffset);
				attached = syntaxValue(target) !== "assembly" && syntaxValue(target) !== "module";
				cursor = this.nextSignificant(colon + 1, close);
			}
		}
		while (cursor >= 0 && cursor < close) {
			const name = this.attributeName(cursor, close);
			this.addTypeReference(cursor, name.end - 1, "typeUse");
			if (name.token !== undefined) this.attributeNames.add(positionKey(name.token.start));
			let next = name.end;
			if (this.value(next) === "(") {
				const argumentsClose = this.matching(next, "(", ")", close);
				next = argumentsClose < 0 ? close : argumentsClose + 1;
			}
			if (this.value(next) === ",") next++;
			cursor = this.nextSignificant(Math.max(next, cursor + 1), close);
		}
		return { open, close, attached };
	}

	/** Where the name span ends, and its type identifier. */
	private attributeName(start: number, close: number): { end: number; token: Token | undefined } {
		let cursor = start;
		let token: Token | undefined;
		while (cursor >= 0 && cursor < close) {
			const item = this.token(cursor);
			const value = syntaxValue(item);
			if (value === "<") {
				const angleClose = this.listClose(cursor, close);
				cursor = angleClose < 0 ? close : angleClose + 1;
				break;
			}
			if (isIdentifier(item)) token = item;
			else if (value !== "." && value !== "::") break;
			cursor = this.nextSignificant(cursor + 1, close);
		}
		return { end: cursor < 0 ? close : cursor, token };
	}

	/** Marks every section at `index`; answers where the last ends. */
	protected afterAttributeSections(index: number, end: number): number {
		let current = index;
		for (;;) {
			const section = this.attributeSectionAt(current, end);
			if (section === undefined || section.close < 0) return current;
			current = section.close + 1;
		}
	}

	/** Marks every `[...]` section without declaring anything. */
	protected walkAttributeSections(start: number, end: number): void {
		let current = this.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const section = this.attributeSectionAt(current, end);
			if (section !== undefined) {
				current = section.close < 0 ? end : this.nextSignificant(section.close + 1, end);
				continue;
			}
			current = this.nextSignificant(current + 1, end);
		}
	}

	/** Where a run of `[...]` sections ends, without marking them. */
	protected bracketedSectionsEnd(index: number, end: number): number {
		let current = index;
		for (;;) {
			const open = this.nextSignificant(current, end);
			if (open < 0 || this.value(open) !== "[") return current;
			const close = this.matching(open, "[", "]", end);
			if (close < 0) return current;
			current = close + 1;
		}
	}
}
