// C# patterns: their types, subpatterns and constants, and the designations they declare.

import type { RawDeclaration, Scope, TypeShape, TypeSpan } from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
import { GROUP_CLOSERS } from "./words.js";

////////////////////////////////
//  Constants

/** End a constant pattern's expression. */
const CONSTANT_ENDS: ReadonlySet<string> = new Set([
	",",
	")",
	"]",
	"}",
	";",
	"=>",
	":",
	"?",
	"&&",
	"||",
	"and",
	"or",
	"when",
]);

const RELATIONAL_OPERATORS: ReadonlySet<string> = new Set(["<", "<=", ">", ">="]);

////////////////////////////////
//  Classes

export class CsharpPatternReader {
	constructor(private readonly context: CsharpParseContext) {}

	////////////////////////////////
	//  Patterns

	/** A pattern and its `and`/`or` chain; declares its designations and answers the index past it. */
	public readPattern(start: number, end: number, owner: RawDeclaration, scope: Scope): number {
		return this.context.tokenStream.nested(start, () => this.patternChain(start, end, owner, scope));
	}

	private patternChain(start: number, end: number, owner: RawDeclaration, scope: Scope): number {
		let current = start;
		for (;;) {
			const past = this.primaryPattern(current, end, owner, scope);
			const next = this.context.tokenStream.nextSignificant(past, end);
			const word = this.context.tokenStream.value(next);
			if (word !== "and" && word !== "or") return past;
			current = next + 1;
		}
	}

	private primaryPattern(start: number, end: number, owner: RawDeclaration, scope: Scope): number {
		let first = this.context.tokenStream.nextSignificant(start, end);
		while (this.context.tokenStream.value(first) === "not")
			first = this.context.tokenStream.nextSignificant(first + 1, end);
		if (first < 0) return end;
		const value = this.context.tokenStream.value(first) ?? "";
		if (value === "(" || value === "{" || value === "[")
			return this.patternTail(this.subpatterns(first, end, owner, scope), first, undefined, end, owner, scope);
		if (value === "var") {
			const designation = this.context.tokenStream.nextSignificant(first + 1, end);
			for (const name of this.context.locals.designationNames(designation, end))
				this.context.locals.declareLocal(
					name,
					first,
					name,
					owner,
					undefined,
					this.context.typeReader.header(first, name + 1, this.context.locals.skipTo(designation, name)),
					scope,
				);
			if (this.context.tokenStream.value(designation) !== "(") return designation < 0 ? end : designation + 1;
			const close = this.context.tokenStream.matching(designation, "(", ")", end);
			return close < 0 ? end : close + 1;
		}
		if (value === "..") {
			const next = this.context.tokenStream.nextSignificant(first + 1, end);
			return next < 0 || CONSTANT_ENDS.has(this.context.tokenStream.value(next) ?? "")
				? first + 1
				: this.readPattern(next, end, owner, scope);
		}
		if (RELATIONAL_OPERATORS.has(value)) return this.skipConstant(first + 1, end);
		const shape = this.patternType(first, end);
		if (shape === undefined) return this.skipConstant(first, end);
		const typeSpan = { start: first, end: shape.end };
		const after = this.context.tokenStream.nextSignificant(shape.end, end);
		const afterValue = this.context.tokenStream.value(after);
		if (afterValue === "(" || afterValue === "{") {
			this.context.recorder.addTypeReference(first, shape.end - 1, "typeUse");
			return this.patternTail(this.subpatterns(after, end, owner, scope), first, typeSpan, end, owner, scope);
		}
		if (this.context.locals.isPatternDesignation(after)) {
			this.context.locals.declareLocal(
				after,
				first,
				after,
				owner,
				{ start: first, end: after },
				this.context.typeReader.header(first, after + 1),
				scope,
			);
			return after + 1;
		}
		return this.skipConstant(shape.end, end);
	}

	/** A type in a pattern; one ending in `?` is a conditional's operand instead. */
	private patternType(first: number, end: number): TypeShape | undefined {
		if (!this.context.locals.startsType(first) || this.context.tokenStream.value(first) === "(") return undefined;
		const shape = this.context.typeReader.typeShape(first, end);
		if (shape === undefined) return undefined;
		return this.context.tokenStream.value(this.context.tokenStream.previousSignificant(shape.end, first)) === "?"
			? undefined
			: shape;
	}

	/** `(...)`, `{...}` or `[...]` subpatterns, each `[name:] pattern`; answers the index past the closer. */
	private subpatterns(open: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const opener = this.context.tokenStream.value(open) as string;
		const close = this.context.tokenStream.matching(open, opener, GROUP_CLOSERS.get(opener) as string, end);
		if (close < 0) return end;
		const angles = this.context.typeReader.typeAngles(open + 1, close);
		for (const segment of this.context.typeReader.commaSegments(open + 1, close, angles)) {
			const colon = this.context.typeReader.topLevelValue(segment.start, segment.end, ":", angles);
			this.readPattern(colon < 0 ? segment.start : colon + 1, segment.end, owner, scope);
		}
		return close + 1;
	}

	/** After a positional, property or list pattern: a property part, then a designation, each optional. */
	private patternTail(
		past: number,
		first: number,
		typeSpan: TypeSpan | undefined,
		end: number,
		owner: RawDeclaration,
		scope: Scope,
	): number {
		let after = past;
		let current = this.context.tokenStream.nextSignificant(past, end);
		if (
			this.context.tokenStream.value(current) === "{" &&
			this.context.tokenStream.value(this.context.tokenStream.previousSignificant(current)) === ")"
		) {
			after = this.subpatterns(current, end, owner, scope);
			current = this.context.tokenStream.nextSignificant(after, end);
		}
		if (!this.context.locals.isPatternDesignation(current)) return after;
		this.context.locals.declareLocal(
			current,
			first,
			current,
			owner,
			typeSpan,
			this.context.typeReader.header(first, current + 1),
			scope,
		);
		return current + 1;
	}

	/** A constant pattern's expression; answers where the pattern ends. */
	private skipConstant(start: number, end: number): number {
		let current = this.context.tokenStream.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const value = this.context.tokenStream.value(current) ?? "";
			if (CONSTANT_ENDS.has(value)) return current;
			const closer = GROUP_CLOSERS.get(value);
			if (closer !== undefined) {
				const close = this.context.tokenStream.matching(current, value, closer, end);
				if (close < 0) return end;
				current = close;
			}
			current = this.context.tokenStream.nextSignificant(current + 1, end);
		}
		return end;
	}
}
