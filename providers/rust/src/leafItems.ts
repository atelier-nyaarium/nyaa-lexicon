import type { OffsetRange } from "@nyaa-lexicon/protocol";
import type { ParseContext } from "./declarations.js";
import { isSymbolIn, OPENERS } from "./delimiters.js";
import { firstFrom } from "./header.js";
import type { CommentSpan, RawDeclaration } from "./model.js";
import type { Prefix } from "./prefixes.js";
import type { SpanRange } from "./references.js";
import { STATEMENT_END, Statements } from "./statements.js";
import { isNameToken, isValueToken, type RustToken, tokenAt } from "./tokens.js";

////////////////////////////////
//  Constants

const VARIANT_END = new Set([","]);

export const BODY = new Set(["{", ";"]);

const STRUCT_BODY = new Set(["{", "(", ";", "where"]);

////////////////////////////////
//  Classes

/** Items that hold no items, and the parts of a header or body any item reads. */
export abstract class LeafItems extends Statements {
	protected readonly ignoredRanges: SpanRange[] = [];

	////////////////////////////////
	//  Items

	protected parameterTypes(start: number, end: number): string[] {
		const values: string[] = [];
		for (const [from, to] of this.segments(start, end)) {
			const colon = this.topLevelToken(from, to, ":");
			if (colon >= 0) values.push(this.textOfTokens(colon + 1, to));
		}
		return values;
	}

	protected parameterCount(start: number, end: number): number {
		return this.segments(start, end).filter(([from, to]) => to > from && !isValueToken(this.tokens[from], "self"))
			.length;
	}

	/** Each binding a parameter's pattern names; `self` only when it stands alone. */
	protected parseParameters(start: number, end: number, functionRaw: RawDeclaration): void {
		const context = this.within(functionRaw, "function");
		for (const [from, to] of this.segments(start, end)) {
			const first = this.skipAttributes(from, to);
			const colon = this.topLevelToken(first, to, ":");
			const patternEnd = colon >= 0 ? colon : to;
			const names = isValueToken(this.tokens[first], "self")
				? first + 1 === patternEnd
					? [first]
					: []
				: this.patternNames(first, patternEnd, false);
			const typeDisplay = colon >= 0 ? this.textOfTokens(colon + 1, to) : undefined;
			const typeName = colon >= 0 ? this.simpleTypeName(colon + 1, to) : undefined;
			for (const nameIndex of names) {
				const name = this.tokens[nameIndex] as RustToken;
				this.addRawDeclaration({
					nameIndex,
					start: name,
					end: this.tokens[Math.max(nameIndex, to - 1)] as RustToken,
					context,
					descriptor: { kind: "parameter", name: name.value },
					kind: "variable",
					languageKind: "parameter",
					visibility: "local",
					exported: false,
					typeDisplay,
					typeName,
					valueType:
						colon >= 0 && this.plainBinding(first, nameIndex, patternEnd)
							? this.valueType(colon + 1, to)
							: undefined,
				});
			}
		}
	}

	/** From the prefix to `bodyOpen`, or to the item's `;` when there is none. */
	protected itemHeader(prefix: Prefix, bodyOpen: number, end: number): string | undefined {
		const stop = bodyOpen >= 0 ? bodyOpen : this.headers.stop(prefix.index, end, STATEMENT_END);
		return this.headers.render(prefix.headerStart, stop);
	}

	/** The closer's line when no token or comment precedes it there; a comma list must end in one. */
	protected memberInsertLine(open: number, close: number, commaList: boolean): number | undefined {
		const closer = tokenAt(this.tokens, close);
		const previous = tokenAt(this.tokens, close - 1);
		if (closer === undefined || previous === undefined || close <= open) return undefined;
		const line = closer.start.line;
		if (previous.end.line >= line) return undefined;
		const comment = this.lastCommentBefore(closer.startOffset);
		if (comment !== undefined && comment.range.end.line >= line) return undefined;
		if (commaList && close - 1 !== open && !isValueToken(previous, ",")) return undefined;
		return line;
	}

	private lastCommentBefore(offset: number): CommentSpan | undefined {
		const offsets = this.scan.commentOffsets;
		return this.scan.comments[
			firstFrom(offsets.length, (index) => (offsets[index] as OffsetRange).start, offset) - 1
		];
	}

	/** The `{`, `(` or `;` after a struct's name, generics and where clause. */
	private structBody(start: number, end: number): number {
		const stop = this.topLevelStop(start, end, STRUCT_BODY);
		return isValueToken(this.tokens[stop], "where") ? this.topLevelStop(stop + 1, end, BODY) : stop;
	}

	protected parseStruct(
		start: number,
		end: number,
		prefix: Prefix,
		context: ParseContext,
		languageKind: "struct" | "union" = "struct",
	): number {
		const name = this.tokens[start + 1] as RustToken;
		const bodyOpen = this.structBody(start + 2, end);
		const braced = isValueToken(this.tokens[bodyOpen], "{");
		const bodyEnd = braced ? this.matchingIndex(bodyOpen) : -1;
		const endIndex = braced && bodyEnd >= 0 ? bodyEnd : this.statementEnd(start, end);
		const raw = this.addRawDeclaration({
			nameIndex: start + 1,
			start: prefix.start,
			end: this.tokens[endIndex] ?? name,
			context,
			descriptor: { kind: "type", name: name.value },
			generics: this.genericsOf(start + 2, braced ? bodyOpen : endIndex),
			typeSpan: this.tupleFields(bodyOpen),
			kind: "struct",
			languageKind,
			visibility: prefix.visibility,
			exported: prefix.exported,
			// A tuple struct's fields are part of its header.
			signature: this.itemHeader(prefix, braced ? bodyOpen : -1, end),
			memberInsertLine: bodyEnd >= 0 ? this.memberInsertLine(bodyOpen, bodyEnd, true) : undefined,
		});
		if (bodyEnd >= 0) this.parseStructFields(bodyOpen + 1, bodyEnd, raw);
		return endIndex + 1;
	}

	/** A variant's fields take its enum's visibility. */
	private parseStructFields(start: number, end: number, structRaw: RawDeclaration, inherited?: Prefix): void {
		const context = this.within(structRaw, "type");
		for (const [from, to] of this.segments(start, end)) {
			const fieldPrefix = this.prefix(this.skipAttributes(from, to), to);
			if (inherited !== undefined) {
				fieldPrefix.visibility = inherited.visibility;
				fieldPrefix.exported = inherited.exported;
			}
			const nameIndex = fieldPrefix.index;
			const name = this.tokens[nameIndex];
			if (!isNameToken(name) || !isValueToken(this.tokens[nameIndex + 1], ":")) continue;
			const typeStart = nameIndex + 2;
			const defaultValue = this.topLevelToken(typeStart, to, "=");
			const typeEnd = defaultValue >= 0 ? defaultValue : to;
			const outline = this.depth === "outline";
			this.addRawDeclaration({
				nameIndex,
				start: fieldPrefix.start,
				end: this.tokens[to - 1] as RustToken,
				context,
				descriptor: { kind: "term", name: name.value },
				kind: "field",
				languageKind: "field",
				visibility: fieldPrefix.visibility,
				exported: fieldPrefix.exported,
				signature: this.headers.render(
					fieldPrefix.headerStart,
					to,
					defaultValue >= 0 ? defaultValue + 1 : undefined,
				),
				...(outline
					? {}
					: {
							typeDisplay: this.textOfTokens(typeStart, typeEnd),
							typeName: this.simpleTypeName(typeStart, typeEnd),
							typeSpan: { start: typeStart, end: typeEnd },
						}),
			});
		}
	}

	protected parseEnum(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const name = this.tokens[start + 1] as RustToken;
		const bodyOpen = this.structBody(start + 2, end);
		const braced = isValueToken(this.tokens[bodyOpen], "{");
		const bodyEnd = braced ? this.matchingIndex(bodyOpen) : -1;
		const endIndex = bodyEnd >= 0 ? bodyEnd : this.statementEnd(start, end);
		const raw = this.addRawDeclaration({
			nameIndex: start + 1,
			start: prefix.start,
			end: this.tokens[endIndex] ?? name,
			context,
			descriptor: { kind: "type", name: name.value },
			generics: this.genericsOf(start + 2, bodyOpen),
			kind: "enum",
			languageKind: "enum",
			visibility: prefix.visibility,
			exported: prefix.exported,
			signature: this.itemHeader(prefix, braced ? bodyOpen : -1, end),
			memberInsertLine: bodyEnd >= 0 ? this.memberInsertLine(bodyOpen, bodyEnd, true) : undefined,
		});
		if (bodyEnd >= 0) this.parseVariants(bodyOpen + 1, bodyEnd, raw, prefix);
		return endIndex + 1;
	}

	/** A tuple struct's or variant's field types, inside the parentheses opening at `open`. */
	private tupleFields(open: number): { start: number; end: number } | undefined {
		if (!isValueToken(this.tokens[open], "(")) return undefined;
		const close = this.matchingIndex(open);
		return close > open ? { start: open + 1, end: close } : undefined;
	}

	private parseVariants(start: number, end: number, enumRaw: RawDeclaration, prefix: Prefix): void {
		const context = this.within(enumRaw, "type");
		for (const [from, to] of this.segments(start, end)) {
			const first = this.skipAttributes(from, to);
			const variant = this.tokens[first];
			if (!isNameToken(variant) || first >= to) continue;
			// A struct variant's fields are its body.
			const headerStop = isValueToken(this.tokens[first + 1], "{")
				? first + 1
				: this.headers.stop(first, to, VARIANT_END);
			const discriminant = this.topLevelToken(first + 1, headerStop, "=");
			const raw = this.addRawDeclaration({
				nameIndex: first,
				start: this.tokens[this.rangeStart(first)] as RustToken,
				end: this.tokens[to - 1] as RustToken,
				context,
				descriptor: { kind: "term", name: variant.value },
				typeSpan: this.tupleFields(first + 1),
				kind: "constant",
				languageKind: "variant",
				visibility: prefix.visibility,
				exported: prefix.exported,
				signature: this.headers.render(
					this.headers.start(first),
					headerStop,
					discriminant >= 0 ? discriminant + 1 : undefined,
				),
			});
			const fieldsEnd = headerStop === first + 1 ? this.matchingIndex(first + 1) : -1;
			if (fieldsEnd > first) this.parseStructFields(first + 2, fieldsEnd, raw, prefix);
		}
	}

	/** The impl's own `for`, not a bound's `for<'a>`. */
	protected implFor(start: number, end: number): number {
		let index = start;
		while (index < end) {
			const found = this.topLevelToken(index, end, "for");
			if (found < 0 || !isValueToken(this.tokens[found + 1], "<")) return found;
			index = found + 1;
		}
		return -1;
	}

	/** The file an outer `#[path = "file"]` attribute between `start` and `end` names. */
	protected pathAttribute(start: number, end: number): string | undefined {
		for (let index = start; index < end; index++) {
			if (!isValueToken(this.tokens[index], "#") || !isValueToken(this.tokens[index + 1], "[")) continue;
			const close = this.matchingIndex(index + 1);
			const value = this.tokens[index + 4];
			if (
				close === index + 5 &&
				isValueToken(this.tokens[index + 2], "path") &&
				isValueToken(this.tokens[index + 3], "=") &&
				value?.kind === "string"
			)
				return value.value;
		}
		return undefined;
	}

	protected parseTypeAlias(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const name = this.tokens[start + 1] as RustToken;
		const endIndex = this.statementEnd(start, end);
		const equal = this.topLevelToken(start + 2, endIndex, "=");
		const typed = this.depth !== "outline" && equal >= 0;
		this.addRawDeclaration({
			nameIndex: start + 1,
			start: prefix.start,
			end: this.tokens[endIndex] ?? name,
			context,
			descriptor: { kind: "type", name: name.value },
			generics: this.genericsOf(start + 2, equal >= 0 ? equal : endIndex),
			valueType: equal >= 0 ? this.valueType(equal + 1, endIndex) : undefined,
			kind: "class",
			languageKind: "typeAlias",
			visibility: prefix.visibility,
			exported: prefix.exported,
			signature: this.itemHeader(prefix, -1, end),
			...(typed
				? {
						typeDisplay: this.textOfTokens(equal + 1, endIndex),
						typeName: this.simpleTypeName(equal + 1, endIndex),
					}
				: {}),
		});
		return endIndex + 1;
	}

	protected parseMacroRules(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const nameIndex = start + 2;
		const body = this.tokens[nameIndex + 1];
		const bodyEnd = isSymbolIn(body, OPENERS) ? this.matchingIndex(nameIndex + 1) : -1;
		const endIndex =
			bodyEnd < 0
				? this.statementEnd(start, end)
				: isValueToken(body, "{") || !isValueToken(this.tokens[bodyEnd + 1], ";")
					? bodyEnd
					: bodyEnd + 1;
		const endToken = this.tokens[endIndex] as RustToken;
		this.addRawDeclaration({
			nameIndex,
			start: prefix.start,
			end: endToken,
			context,
			descriptor: { kind: "term", name: (this.tokens[nameIndex] as RustToken).value },
			kind: "function",
			languageKind: "macroRules",
			visibility: prefix.visibility,
			exported: prefix.exported,
			signature: this.headers.render(prefix.headerStart, nameIndex + 1),
		});
		if (bodyEnd >= 0)
			this.ignoredRanges.push({
				startOffset: (this.tokens[start] as RustToken).startOffset,
				endOffset: endToken.endOffset,
			});
		return endIndex + 1;
	}

	protected bodyMetrics(start: number, end: number): { nesting: number; branches: number } {
		let depth = 0;
		let nesting = 0;
		let branches = 1;
		for (let index = start; index < end; index++) {
			const token = this.tokens[index] as RustToken;
			if (isValueToken(token, "{")) {
				depth++;
				nesting = Math.max(nesting, depth);
			}
			if (isValueToken(token, "}")) depth = Math.max(0, depth - 1);
			if (
				isValueToken(token, "if") ||
				isValueToken(token, "else") ||
				isValueToken(token, "for") ||
				isValueToken(token, "while") ||
				isValueToken(token, "match") ||
				isValueToken(token, "?") ||
				isValueToken(token, "&&") ||
				isValueToken(token, "||")
			)
				branches++;
		}
		return { nesting, branches };
	}
}
