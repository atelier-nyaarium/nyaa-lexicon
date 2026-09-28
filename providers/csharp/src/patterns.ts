// C# patterns: their types, subpatterns and constants, and the designations they declare.

import { CsharpLocalReader } from "./locals.js";
import type { RawDeclaration, Scope, TypeShape, TypeSpan } from "./model.js";
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

export abstract class CsharpPatternReader extends CsharpLocalReader {
	////////////////////////////////
	//  Patterns

	/** A pattern and its `and`/`or` chain; declares its designations and answers the index past it. */
	protected readPattern(start: number, end: number, owner: RawDeclaration, scope: Scope): number {
		return this.nested(start, () => this.patternChain(start, end, owner, scope));
	}

	private patternChain(start: number, end: number, owner: RawDeclaration, scope: Scope): number {
		let current = start;
		for (;;) {
			const past = this.primaryPattern(current, end, owner, scope);
			const next = this.nextSignificant(past, end);
			const word = this.value(next);
			if (word !== "and" && word !== "or") return past;
			current = next + 1;
		}
	}

	private primaryPattern(start: number, end: number, owner: RawDeclaration, scope: Scope): number {
		let first = this.nextSignificant(start, end);
		while (this.value(first) === "not") first = this.nextSignificant(first + 1, end);
		if (first < 0) return end;
		const value = this.value(first) ?? "";
		if (value === "(" || value === "{" || value === "[")
			return this.patternTail(this.subpatterns(first, end, owner, scope), first, undefined, end, owner, scope);
		if (value === "var") {
			const designation = this.nextSignificant(first + 1, end);
			for (const name of this.designationNames(designation, end))
				this.declareLocal(
					name,
					first,
					name,
					owner,
					undefined,
					this.header(first, name + 1, this.skipTo(designation, name)),
					scope,
				);
			if (this.value(designation) !== "(") return designation < 0 ? end : designation + 1;
			const close = this.matching(designation, "(", ")", end);
			return close < 0 ? end : close + 1;
		}
		if (value === "..") {
			const next = this.nextSignificant(first + 1, end);
			return next < 0 || CONSTANT_ENDS.has(this.value(next) ?? "")
				? first + 1
				: this.readPattern(next, end, owner, scope);
		}
		if (RELATIONAL_OPERATORS.has(value)) return this.skipConstant(first + 1, end);
		const shape = this.patternType(first, end);
		if (shape === undefined) return this.skipConstant(first, end);
		const typeSpan = { start: first, end: shape.end };
		const after = this.nextSignificant(shape.end, end);
		const afterValue = this.value(after);
		if (afterValue === "(" || afterValue === "{") {
			this.addTypeReference(first, shape.end - 1, "typeUse");
			return this.patternTail(this.subpatterns(after, end, owner, scope), first, typeSpan, end, owner, scope);
		}
		if (this.isPatternDesignation(after)) {
			this.declareLocal(
				after,
				first,
				after,
				owner,
				{ start: first, end: after },
				this.header(first, after + 1),
				scope,
			);
			return after + 1;
		}
		return this.skipConstant(shape.end, end);
	}

	/** A type in a pattern; one ending in `?` is a conditional's operand instead. */
	private patternType(first: number, end: number): TypeShape | undefined {
		if (!this.startsType(first) || this.value(first) === "(") return undefined;
		const shape = this.typeShape(first, end);
		if (shape === undefined) return undefined;
		return this.value(this.previousSignificant(shape.end, first)) === "?" ? undefined : shape;
	}

	/** `(...)`, `{...}` or `[...]` subpatterns, each `[name:] pattern`; answers the index past the closer. */
	private subpatterns(open: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const opener = this.value(open) as string;
		const close = this.matching(open, opener, GROUP_CLOSERS.get(opener) as string, end);
		if (close < 0) return end;
		const angles = this.typeAngles(open + 1, close);
		for (const segment of this.commaSegments(open + 1, close, angles)) {
			const colon = this.topLevelValue(segment.start, segment.end, ":", angles);
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
		let current = this.nextSignificant(past, end);
		if (this.value(current) === "{" && this.value(this.previousSignificant(current)) === ")") {
			after = this.subpatterns(current, end, owner, scope);
			current = this.nextSignificant(after, end);
		}
		if (!this.isPatternDesignation(current)) return after;
		this.declareLocal(current, first, current, owner, typeSpan, this.header(first, current + 1), scope);
		return current + 1;
	}

	/** A constant pattern's expression; answers where the pattern ends. */
	private skipConstant(start: number, end: number): number {
		let current = this.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const value = this.value(current) ?? "";
			if (CONSTANT_ENDS.has(value)) return current;
			const closer = GROUP_CLOSERS.get(value);
			if (closer !== undefined) {
				const close = this.matching(current, value, closer, end);
				if (close < 0) return end;
				current = close;
			}
			current = this.nextSignificant(current + 1, end);
		}
		return end;
	}
}
