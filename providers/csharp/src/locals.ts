// C# locals: the declarations a body makes, and the heads and designations that name them.

import type { HeaderSkip, RawDeclaration, Scope, TypeSpan } from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
import type { Token } from "./tokens.js";
import { isIdentifier, PREDEFINED_TYPES, RESERVED_WORDS, syntaxValue } from "./words.js";

////////////////////////////////
//  Interfaces & Types

/** A local declaration's modifiers, type and first name. */
export interface LocalHead {
	first: number;
	type: number;
	typeEnd: number;
	name: number;
	modifiers: ReadonlySet<string>;
}

/** A declaration expression inside a deconstruction. */
export interface Declared {
	first: number;
	name: number;
	type: TypeSpan | undefined;
	skip?: HeaderSkip | undefined;
}

////////////////////////////////
//  Constants

/** May precede a local's or a local function's type. */
const LOCAL_MODIFIERS: ReadonlySet<string> = new Set([
	"async",
	"const",
	"extern",
	"readonly",
	"ref",
	"scoped",
	"static",
	"unsafe",
	"using",
]);

/** Follow a pattern's type without designating. */
const PATTERN_WORDS: ReadonlySet<string> = new Set([
	"and",
	"as",
	"ascending",
	"by",
	"descending",
	"equals",
	"from",
	"group",
	"into",
	"is",
	"join",
	"let",
	"not",
	"on",
	"or",
	"orderby",
	"select",
	"switch",
	"when",
	"where",
	"with",
]);

////////////////////////////////
//  Classes

export class CsharpLocalReader {
	constructor(private readonly context: CsharpParseContext) {}

	/** The last significant token before `past`, never before `from`. */
	public lastBefore(past: number, from: number): number {
		return Math.max(from, this.context.tokenStream.previousSignificant(past, from));
	}

	/** Each declared name; each spans its own declaration, or through `last` when given. */
	public declareAll(
		declared: readonly Declared[],
		last: number | undefined,
		owner: RawDeclaration,
		scope: Scope,
	): void {
		for (const item of declared)
			this.declareLocal(
				item.name,
				item.first,
				last ?? item.name,
				owner,
				item.type,
				this.context.typeReader.header(item.first, item.name + 1, item.skip),
				scope,
			);
	}

	/** Declaration expressions among a tuple's elements, nested tuples included. */
	public tupleDeclarations(open: number, close: number): Declared[] {
		const found: Declared[] = [];
		for (const segment of this.context.typeReader.commaSegments(open + 1, close)) {
			const first = this.context.tokenStream.nextSignificant(segment.start, segment.end);
			if (first < 0) continue;
			const value = this.context.tokenStream.value(first);
			const next = this.context.tokenStream.nextSignificant(first + 1, segment.end);
			if (value === "(") {
				const inner = this.context.tokenStream.matching(first, "(", ")", segment.end);
				if (inner >= 0 && this.context.tokenStream.nextSignificant(inner + 1, segment.end) < 0)
					found.push(...this.context.tokenStream.nested(first, () => this.tupleDeclarations(first, inner)));
				continue;
			}
			if (value === "var" && this.context.tokenStream.value(next) === "(") {
				for (const name of this.designationNames(next, segment.end))
					found.push({ first, name, type: undefined, skip: this.skipTo(next, name) });
				continue;
			}
			const shape = this.startsType(first) ? this.context.typeReader.typeShape(first, segment.end) : undefined;
			const name = shape === undefined ? -1 : this.context.tokenStream.nextSignificant(shape.end, segment.end);
			if (
				shape === undefined ||
				!this.isDesignation(name) ||
				this.context.tokenStream.nextSignificant(name + 1, segment.end) >= 0
			)
				continue;
			const isVar = value === "var" && shape.end === first + 1;
			found.push({ first, name, type: isVar ? undefined : { start: first, end: name } });
		}
		return found;
	}

	/** Names a designation declares: `x`, or `(x, (y, _))`; a discard declares none. */
	public designationNames(index: number, end: number): number[] {
		if (this.context.tokenStream.value(index) !== "(") return this.isDesignation(index) ? [index] : [];
		const close = this.context.tokenStream.matching(index, "(", ")", end);
		if (close < 0) return [];
		return this.context.typeReader.commaSegments(index + 1, close).flatMap((segment) => {
			const first = this.context.tokenStream.nextSignificant(segment.start, segment.end);
			if (first < 0) return [];
			const last = this.context.tokenStream.previousSignificant(segment.end, first);
			if (this.context.tokenStream.value(first) === "(")
				return this.context.tokenStream.matching(first, "(", ")", segment.end) === last
					? this.context.tokenStream.nested(first, () => this.designationNames(first, end))
					: [];
			return first === last && this.isDesignation(first) ? [first] : [];
		});
	}

	/** Renders `var x` for a name inside `var (...)`. */
	public skipTo(open: number, name: number): HeaderSkip | undefined {
		return open === name ? undefined : { from: open, to: name };
	}

	/** `[modifiers] type name` at `start`; undefined when no local declaration starts there. */
	public localHead(start: number, end: number): LocalHead | undefined {
		const first = this.context.tokenStream.nextSignificant(start, end);
		const modifiers = new Set<string>();
		let type = first;
		while (type >= 0) {
			const value = this.context.tokenStream.value(type) ?? "";
			const next = this.context.tokenStream.nextSignificant(type + 1, end);
			if (!LOCAL_MODIFIERS.has(value) && !(value === "await" && this.context.tokenStream.value(next) === "using"))
				break;
			modifiers.add(value);
			type = next;
		}
		if (type < 0 || !this.startsType(type)) return undefined;
		const shape = this.context.typeReader.typeShape(type, end);
		const name = shape === undefined ? -1 : this.context.tokenStream.nextSignificant(shape.end, end);
		if (shape === undefined || !this.isName(name)) return undefined;
		return { first, type, typeEnd: shape.end, name, modifiers };
	}

	/** Whether the head's name is followed as a declarator is, up to `limit`. */
	public namesLocals(head: LocalHead, limit: number): boolean {
		const follower = this.context.tokenStream.nextSignificant(head.name + 1, limit);
		return (
			follower < 0 ||
			this.context.tokenStream.value(follower) === "=" ||
			this.context.tokenStream.value(follower) === ","
		);
	}

	public isVar(head: LocalHead): boolean {
		return this.context.tokenStream.value(head.type) === "var" && head.typeEnd === head.type + 1;
	}

	public declareLocal(
		name: number,
		first: number,
		last: number,
		owner: RawDeclaration,
		typeSpan: TypeSpan | undefined,
		signature: string | undefined,
		scope: Scope,
		languageKind = "local",
	): void {
		const nameToken = this.context.tokenStream.token(name) as Token;
		const local = this.context.recorder.addDeclaration({
			kind: "variable",
			languageKind,
			name: nameToken.value,
			parent: owner,
			startToken: this.context.tokenStream.token(first) as Token,
			endToken: this.context.tokenStream.token(last) as Token,
			selectionStart: nameToken,
			selectionEnd: nameToken,
			codeStart: this.context.tokenStream.token(first) as Token,
			visibility: "local",
			exported: false,
			signature,
			scope,
			nameTokenOffsets: [nameToken.startOffset],
		});
		this.context.recorder.recordTypeSpan(typeSpan, local);
	}

	////////////////////////////////
	//  Words

	/** A type may start at `index`: a tuple, a name, or a predefined type. */
	public startsType(index: number): boolean {
		const value = this.context.tokenStream.value(index);
		if (value === "(") return true;
		if (value === undefined || !isIdentifier(this.context.tokenStream.token(index))) return false;
		if (value === "delegate")
			return this.context.tokenStream.value(this.context.tokenStream.nextSignificant(index + 1)) === "*";
		if (RESERVED_WORDS.has(value)) return PREDEFINED_TYPES.has(value);
		return value !== "await";
	}

	public isName(index: number): boolean {
		const token = this.context.tokenStream.token(index);
		return isIdentifier(token) && !RESERVED_WORDS.has(syntaxValue(token) as string);
	}

	/** A name, never a discard. */
	public isDesignation(index: number): boolean {
		return this.isName(index) && this.context.tokenStream.value(index) !== "_";
	}

	public isPatternDesignation(index: number): boolean {
		return this.isDesignation(index) && !PATTERN_WORDS.has(this.context.tokenStream.value(index) ?? "");
	}
}
