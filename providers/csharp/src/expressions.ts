// C# expressions: where one ends, and what its patterns, `out` variables, lambdas, anonymous methods
import type { CsharpParseContext } from "./parseContext.js";
// and queries declare.

import type { AnglePairs, RawDeclaration, Scope } from "./model.js";
import type { Token } from "./tokens.js";
import { GROUP_CLOSERS } from "./words.js";

////////////////////////////////
//  Constants

/** End an expression at its own depth. */
const EXPRESSION_ENDS: ReadonlySet<string> = new Set([",", ";", ")", "]", "}"]);

const QUERY_CLAUSES: ReadonlySet<string> = new Set([
	"from",
	"group",
	"into",
	"join",
	"let",
	"orderby",
	"select",
	"where",
]);

/** Keywords inside a query, never names there. */
const QUERY_WORDS: ReadonlySet<string> = new Set([...QUERY_CLAUSES, "ascending", "by", "descending", "equals", "on"]);

////////////////////////////////
//  Classes

export class CsharpExpressionReader {
	constructor(private readonly context: CsharpParseContext) {}

	/**
	 * Each token an `expressionEnd` walk stepped on at its own depth, and where that walk ended:
	 * at an ending token, or at its bound with none found. A lambda nested in an expression starts
	 * its own walk on one of them, so nesting never walks the rest of the expression again.
	 */
	private readonly expressionEnds = new Map<number, { end: number; found: boolean }>();

	/** A block body's statements, in `scope`. */

	////////////////////////////////
	//  Expressions

	/**
	 * What an expression declares: patterns, `out` variables, lambdas, anonymous methods and
	 * queries. `clauses` are a query's own `from` words, never a query of their own.
	 */
	public scanExpression(
		start: number,
		end: number,
		owner: RawDeclaration,
		scope: Scope,
		clauses?: ReadonlySet<number>,
	): void {
		this.context.tokenStream.nested(start, () => this.scanTokens(start, end, owner, scope, clauses));
	}

	private scanTokens(
		start: number,
		end: number,
		owner: RawDeclaration,
		scope: Scope,
		clauses: ReadonlySet<number> | undefined,
	): void {
		let current = this.context.tokenStream.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const value = this.context.tokenStream.value(current);
			const next = this.context.tokenStream.nextSignificant(current + 1, end);
			let past = current + 1;
			if (value === "is") past = this.context.patterns.readPattern(current + 1, end, owner, scope);
			else if (value === "out") past = this.outVariable(current, end, owner, scope);
			else if (value === "switch" && this.context.tokenStream.value(next) === "{")
				past = this.switchArms(next, end, owner);
			else if (value === "=>") past = this.lambda(current, end, owner);
			else if (value === "delegate") past = this.anonymousMethod(current, end, owner);
			else if (value === "from" && clauses?.has(current) !== true && this.startsQuery(current, end))
				past = this.query(current, end, owner);
			current = this.context.tokenStream.nextSignificant(Math.max(past, current + 1), end);
		}
	}

	/** Where an expression from `start` ends: its first `,`, `;` or closer at its own depth. */
	public expressionEnd(start: number, end: number): number {
		const stepped: number[] = [];
		let reached = { end, found: false };
		let previous = -1;
		let current = this.context.tokenStream.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const known = this.expressionEnds.get(current);
			// A walk that found its end answers any bound; one that ran out, only a bound no further.
			if (known !== undefined && (known.found || end <= known.end)) {
				reached = known.found && known.end < end ? known : { end, found: false };
				break;
			}
			stepped.push(current);
			const value = this.context.tokenStream.value(current) ?? "";
			if (EXPRESSION_ENDS.has(value)) {
				reached = { end: current, found: true };
				break;
			}
			if (value === "from" && this.startsQuery(current, end)) {
				current = this.queryEnd(current, end);
				continue;
			}
			current = this.skipGroup(current, previous, end);
			previous = current;
			current = this.context.tokenStream.nextSignificant(current + 1, end);
		}
		for (const token of stepped) this.expressionEnds.set(token, reached);
		return reached.end;
	}

	/** Past a group or type argument list opening at `index`, to its closer; `index` otherwise. */
	private skipGroup(index: number, previous: number, end: number): number {
		const value = this.context.tokenStream.value(index) ?? "";
		const closer = GROUP_CLOSERS.get(value);
		if (closer !== undefined) {
			const close = this.context.tokenStream.matching(index, value, closer, end);
			return close < 0 ? end : close;
		}
		if (value === "<" && this.context.typeReader.opensTypeList(previous, index, end, false, 0)) {
			const close = this.context.typeReader.listClose(index, end);
			return close < 0 ? index : close;
		}
		return index;
	}

	/** A lambda at its arrow: parameters scoped to the body, then the body. */
	private lambda(arrow: number, end: number, owner: RawDeclaration): number {
		const body = this.context.tokenStream.nextSignificant(arrow + 1, end);
		const block = this.context.tokenStream.value(body) === "{";
		const close = block ? this.context.tokenStream.matching(body, "{", "}", end) : -1;
		const stop = block ? (close < 0 ? end : close) : this.expressionEnd(arrow + 1, end);
		const scope: Scope = { from: arrow, to: this.context.locals.lastBefore(stop + (block ? 1 : 0), arrow) };
		const previous = this.context.tokenStream.previousSignificant(arrow);
		if (this.context.tokenStream.value(previous) === ")") {
			const open = this.context.tokenStream.opener(previous, "(", ")");
			if (open >= 0) this.lambdaParameters(open, previous, owner, scope);
		} else if (this.context.locals.isDesignation(previous)) {
			this.context.locals.declareLocal(
				previous,
				previous,
				previous,
				owner,
				undefined,
				undefined,
				scope,
				"lambdaParameter",
			);
		}
		if (block) this.context.statements.statements(body + 1, stop, owner, { from: body, to: stop });
		else this.scanExpression(arrow + 1, stop, owner, scope);
		return block ? stop + 1 : stop;
	}

	/** `([attributes] [modifiers] [T] name [= default], ...)` */
	private lambdaParameters(open: number, close: number, owner: RawDeclaration, scope: Scope): void {
		const angles: AnglePairs = this.context.typeReader.typeAngles(open + 1, close);
		for (const segment of this.context.typeReader.commaSegments(open + 1, close, angles)) {
			const name = this.context.signatures.findParameterName(segment.start, segment.end, angles);
			if (!this.context.locals.isDesignation(name)) continue;
			const first = this.context.tokenStream.nextSignificant(segment.start, segment.end);
			const last = this.context.tokenStream.previousSignificant(segment.end, first);
			const typeSpan = this.context.typeReader.spanBeforeName(
				this.context.attributes.bracketedSectionsEnd(segment.start, name),
				name,
			);
			this.context.locals.declareLocal(name, first, last, owner, typeSpan, undefined, scope, "lambdaParameter");
		}
	}

	/** `delegate [(...)] { ... }` */
	private anonymousMethod(keyword: number, end: number, owner: RawDeclaration): number {
		let body = this.context.tokenStream.nextSignificant(keyword + 1, end);
		let parameters = -1;
		if (this.context.tokenStream.value(body) === "(") {
			parameters = body;
			const close = this.context.tokenStream.matching(body, "(", ")", end);
			if (close < 0) return keyword + 1;
			body = this.context.tokenStream.nextSignificant(close + 1, end);
		}
		if (this.context.tokenStream.value(body) !== "{") return keyword + 1;
		const close = this.context.tokenStream.matching(body, "{", "}", end);
		const stop = close < 0 ? end : close;
		if (parameters >= 0)
			this.lambdaParameters(parameters, this.context.tokenStream.matching(parameters, "(", ")", end), owner, {
				from: keyword,
				to: stop,
			});
		this.context.statements.statements(body + 1, stop, owner, { from: body, to: stop });
		return close < 0 ? end : close + 1;
	}

	/** `out T x` or `out var x`, as an argument. */
	private outVariable(keyword: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const first = this.context.tokenStream.nextSignificant(keyword + 1, end);
		const shape =
			first >= 0 && this.context.locals.startsType(first)
				? this.context.typeReader.typeShape(first, end)
				: undefined;
		const name = shape === undefined ? -1 : this.context.tokenStream.nextSignificant(shape.end, end);
		if (shape === undefined || !this.context.locals.isDesignation(name)) return keyword + 1;
		const follower = this.context.tokenStream.nextSignificant(name + 1, end);
		if (
			follower >= 0 &&
			this.context.tokenStream.value(follower) !== "," &&
			this.context.tokenStream.value(follower) !== ")"
		)
			return keyword + 1;
		const typeSpan =
			this.context.tokenStream.value(first) === "var" && shape.end === first + 1
				? undefined
				: { start: first, end: name };
		this.context.locals.declareLocal(
			name,
			first,
			name,
			owner,
			typeSpan,
			this.context.typeReader.header(first, name + 1),
			scope,
		);
		return name + 1;
	}

	/** A switch expression's `pattern [when condition] => result` arms, each its own scope. */
	private switchArms(open: number, end: number, owner: RawDeclaration): number {
		const close = this.context.tokenStream.matching(open, "{", "}", end);
		if (close < 0) return end;
		for (const arm of this.context.typeReader.commaSegments(open + 1, close)) {
			const scope: Scope = { from: arm.start, to: this.context.locals.lastBefore(arm.end, arm.start) };
			const arrow = this.context.tokenStream.findTopLevelValue(arm.start, arm.end, "=>");
			if (arrow < 0) {
				this.scanExpression(arm.start, arm.end, owner, scope);
				continue;
			}
			const past = this.context.patterns.readPattern(arm.start, arrow, owner, scope);
			const when = this.context.tokenStream.nextSignificant(past, arrow);
			if (this.context.tokenStream.value(when) === "when") this.scanExpression(when + 1, arrow, owner, scope);
			this.scanExpression(arrow + 1, arm.end, owner, scope);
		}
		return close + 1;
	}

	////////////////////////////////
	//  Queries

	/** `from [T] x in` opens a query expression. */
	private startsQuery(keyword: number, end: number): boolean {
		return this.rangeVariableName(keyword, end, "in") >= 0;
	}

	/** A query, its range variables scoped to it; answers where it ends. */
	private query(keyword: number, end: number, owner: RawDeclaration): number {
		const stop = this.queryEnd(keyword, end);
		const last = this.context.locals.lastBefore(stop, keyword);
		const scope: Scope = { from: keyword, to: last };
		const clauses = new Set<number>();
		// Each variable's scope: from the next clause after its source or initializer, or a join's from
		// its `equals`, to the continuation `into` that ends its region; a join's own `into` ends it early.
		let region: Scope[] = [];
		let join: Scope | undefined;
		let waiting: Scope[] = [];
		let joining: Scope | undefined;
		let clause = "";
		let previous = -1;
		for (
			let current = keyword;
			current >= 0 && current < stop;
			current = this.context.tokenStream.nextSignificant(current + 1, stop)
		) {
			const value = this.context.tokenStream.value(current) ?? "";
			if (QUERY_WORDS.has(value))
				this.context.recorder.ignore((this.context.tokenStream.token(current) as Token).startOffset);
			if (current > keyword && QUERY_CLAUSES.has(value)) {
				for (const item of [...waiting, ...(joining === undefined ? [] : [joining])]) item.from = current;
				waiting = [];
				joining = undefined;
			}
			if (value === "equals" && joining !== undefined) {
				joining.from = current;
				joining = undefined;
			}
			if (value === "into" && clause === "join" && join !== undefined) {
				join.to = this.context.locals.lastBefore(current, join.from);
				join = undefined;
			} else if (value === "into") {
				for (const item of region) item.to = this.context.locals.lastBefore(current, item.from);
				if (join !== undefined) join.to = Math.min(join.to, this.context.locals.lastBefore(current, join.from));
				region = [];
				join = undefined;
			}
			const follower =
				value === "from" || value === "join" ? "in" : value === "let" ? "=" : value === "into" ? "" : null;
			const name = follower === null ? -1 : this.rangeVariableName(current, stop, follower);
			if (name >= 0) {
				if (value === "from") clauses.add(current);
				const own: Scope = { from: value === "into" ? name : current, to: last };
				if (value === "join") {
					join = own;
					joining = own;
				} else {
					region.push(own);
					if (value !== "into") waiting.push(own);
				}
				const first = this.context.tokenStream.nextSignificant(current + 1, stop);
				const typeSpan = first === name ? undefined : { start: first, end: name };
				this.context.locals.declareLocal(
					name,
					first,
					name,
					owner,
					typeSpan,
					this.context.typeReader.header(first, name + 1),
					own,
					"rangeVariable",
				);
			}
			if (QUERY_CLAUSES.has(value)) clause = value;
			current = this.skipGroup(current, previous, stop);
			previous = current;
		}
		// No clause followed: nothing sees them.
		for (const item of [...waiting, ...(joining === undefined ? [] : [joining])]) item.from = stop;
		this.scanExpression(keyword, stop, owner, scope, clauses);
		return stop;
	}

	/** The name a range clause declares, `in`, `=` or nothing following it; -1 when none. */
	private rangeVariableName(keyword: number, end: number, follower: string): number {
		const first = this.context.tokenStream.nextSignificant(keyword + 1, end);
		const followed = (name: number): boolean => {
			if (!this.context.locals.isDesignation(name)) return false;
			return (
				follower === "" ||
				this.context.tokenStream.value(this.context.tokenStream.nextSignificant(name + 1, end)) === follower
			);
		};
		if (followed(first)) return first;
		if (follower !== "in" || first < 0 || !this.context.locals.startsType(first)) return -1;
		const shape = this.context.typeReader.typeShape(first, end);
		const name = shape === undefined ? -1 : this.context.tokenStream.nextSignificant(shape.end, end);
		return followed(name) ? name : -1;
	}

	/** A query runs to its expression's end; an `orderby` clause's commas are its own. */
	private queryEnd(keyword: number, end: number): number {
		let ordering = false;
		let previous = -1;
		let current = this.context.tokenStream.nextSignificant(keyword + 1, end);
		while (current >= 0 && current < end) {
			const value = this.context.tokenStream.value(current) ?? "";
			if (EXPRESSION_ENDS.has(value) && !(value === "," && ordering)) return current;
			if (QUERY_CLAUSES.has(value)) ordering = value === "orderby";
			current = this.skipGroup(current, previous, end);
			previous = current;
			current = this.context.tokenStream.nextSignificant(current + 1, end);
		}
		return end;
	}
}
