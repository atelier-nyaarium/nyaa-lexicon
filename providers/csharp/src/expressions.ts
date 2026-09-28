// C# expressions: where one ends, and what its patterns, `out` variables, lambdas, anonymous methods
// and queries declare.

import type { AnglePairs, RawDeclaration, Scope } from "./model.js";
import { CsharpPatternReader } from "./patterns.js";
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

export abstract class CsharpExpressionReader extends CsharpPatternReader {
	/**
	 * Each token an `expressionEnd` walk stepped on at its own depth, and where that walk ended:
	 * at an ending token, or at its bound with none found. A lambda nested in an expression starts
	 * its own walk on one of them, so nesting never walks the rest of the expression again.
	 */
	private readonly expressionEnds = new Map<number, { end: number; found: boolean }>();

	/** A block body's statements, in `scope`. */
	protected abstract statements(start: number, end: number, owner: RawDeclaration, scope: Scope): void;

	////////////////////////////////
	//  Expressions

	/**
	 * What an expression declares: patterns, `out` variables, lambdas, anonymous methods and
	 * queries. `clauses` are a query's own `from` words, never a query of their own.
	 */
	protected scanExpression(
		start: number,
		end: number,
		owner: RawDeclaration,
		scope: Scope,
		clauses?: ReadonlySet<number>,
	): void {
		this.nested(start, () => this.scanTokens(start, end, owner, scope, clauses));
	}

	private scanTokens(
		start: number,
		end: number,
		owner: RawDeclaration,
		scope: Scope,
		clauses: ReadonlySet<number> | undefined,
	): void {
		let current = this.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const value = this.value(current);
			const next = this.nextSignificant(current + 1, end);
			let past = current + 1;
			if (value === "is") past = this.readPattern(current + 1, end, owner, scope);
			else if (value === "out") past = this.outVariable(current, end, owner, scope);
			else if (value === "switch" && this.value(next) === "{") past = this.switchArms(next, end, owner);
			else if (value === "=>") past = this.lambda(current, end, owner);
			else if (value === "delegate") past = this.anonymousMethod(current, end, owner);
			else if (value === "from" && clauses?.has(current) !== true && this.startsQuery(current, end))
				past = this.query(current, end, owner);
			current = this.nextSignificant(Math.max(past, current + 1), end);
		}
	}

	/** Where an expression from `start` ends: its first `,`, `;` or closer at its own depth. */
	protected expressionEnd(start: number, end: number): number {
		const stepped: number[] = [];
		let reached = { end, found: false };
		let previous = -1;
		let current = this.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const known = this.expressionEnds.get(current);
			// A walk that found its end answers any bound; one that ran out, only a bound no further.
			if (known !== undefined && (known.found || end <= known.end)) {
				reached = known.found && known.end < end ? known : { end, found: false };
				break;
			}
			stepped.push(current);
			const value = this.value(current) ?? "";
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
			current = this.nextSignificant(current + 1, end);
		}
		for (const token of stepped) this.expressionEnds.set(token, reached);
		return reached.end;
	}

	/** Past a group or type argument list opening at `index`, to its closer; `index` otherwise. */
	private skipGroup(index: number, previous: number, end: number): number {
		const value = this.value(index) ?? "";
		const closer = GROUP_CLOSERS.get(value);
		if (closer !== undefined) {
			const close = this.matching(index, value, closer, end);
			return close < 0 ? end : close;
		}
		if (value === "<" && this.opensTypeList(previous, index, end, false, 0)) {
			const close = this.listClose(index, end);
			return close < 0 ? index : close;
		}
		return index;
	}

	/** A lambda at its arrow: parameters scoped to the body, then the body. */
	private lambda(arrow: number, end: number, owner: RawDeclaration): number {
		const body = this.nextSignificant(arrow + 1, end);
		const block = this.value(body) === "{";
		const close = block ? this.matching(body, "{", "}", end) : -1;
		const stop = block ? (close < 0 ? end : close) : this.expressionEnd(arrow + 1, end);
		const scope: Scope = { from: arrow, to: this.lastBefore(stop + (block ? 1 : 0), arrow) };
		const previous = this.previousSignificant(arrow);
		if (this.value(previous) === ")") {
			const open = this.opener(previous, "(", ")");
			if (open >= 0) this.lambdaParameters(open, previous, owner, scope);
		} else if (this.isDesignation(previous)) {
			this.declareLocal(previous, previous, previous, owner, undefined, undefined, scope, "lambdaParameter");
		}
		if (block) this.statements(body + 1, stop, owner, { from: body, to: stop });
		else this.scanExpression(arrow + 1, stop, owner, scope);
		return block ? stop + 1 : stop;
	}

	/** `([attributes] [modifiers] [T] name [= default], ...)` */
	private lambdaParameters(open: number, close: number, owner: RawDeclaration, scope: Scope): void {
		const angles: AnglePairs = this.typeAngles(open + 1, close);
		for (const segment of this.commaSegments(open + 1, close, angles)) {
			const name = this.findParameterName(segment.start, segment.end, angles);
			if (!this.isDesignation(name)) continue;
			const first = this.nextSignificant(segment.start, segment.end);
			const last = this.previousSignificant(segment.end, first);
			const typeSpan = this.spanBeforeName(this.bracketedSectionsEnd(segment.start, name), name);
			this.declareLocal(name, first, last, owner, typeSpan, undefined, scope, "lambdaParameter");
		}
	}

	/** `delegate [(...)] { ... }` */
	private anonymousMethod(keyword: number, end: number, owner: RawDeclaration): number {
		let body = this.nextSignificant(keyword + 1, end);
		let parameters = -1;
		if (this.value(body) === "(") {
			parameters = body;
			const close = this.matching(body, "(", ")", end);
			if (close < 0) return keyword + 1;
			body = this.nextSignificant(close + 1, end);
		}
		if (this.value(body) !== "{") return keyword + 1;
		const close = this.matching(body, "{", "}", end);
		const stop = close < 0 ? end : close;
		if (parameters >= 0)
			this.lambdaParameters(parameters, this.matching(parameters, "(", ")", end), owner, {
				from: keyword,
				to: stop,
			});
		this.statements(body + 1, stop, owner, { from: body, to: stop });
		return close < 0 ? end : close + 1;
	}

	/** `out T x` or `out var x`, as an argument. */
	private outVariable(keyword: number, end: number, owner: RawDeclaration, scope: Scope): number {
		const first = this.nextSignificant(keyword + 1, end);
		const shape = first >= 0 && this.startsType(first) ? this.typeShape(first, end) : undefined;
		const name = shape === undefined ? -1 : this.nextSignificant(shape.end, end);
		if (shape === undefined || !this.isDesignation(name)) return keyword + 1;
		const follower = this.nextSignificant(name + 1, end);
		if (follower >= 0 && this.value(follower) !== "," && this.value(follower) !== ")") return keyword + 1;
		const typeSpan =
			this.value(first) === "var" && shape.end === first + 1 ? undefined : { start: first, end: name };
		this.declareLocal(name, first, name, owner, typeSpan, this.header(first, name + 1), scope);
		return name + 1;
	}

	/** A switch expression's `pattern [when condition] => result` arms, each its own scope. */
	private switchArms(open: number, end: number, owner: RawDeclaration): number {
		const close = this.matching(open, "{", "}", end);
		if (close < 0) return end;
		for (const arm of this.commaSegments(open + 1, close)) {
			const scope: Scope = { from: arm.start, to: this.lastBefore(arm.end, arm.start) };
			const arrow = this.findTopLevelValue(arm.start, arm.end, "=>");
			if (arrow < 0) {
				this.scanExpression(arm.start, arm.end, owner, scope);
				continue;
			}
			const past = this.readPattern(arm.start, arrow, owner, scope);
			const when = this.nextSignificant(past, arrow);
			if (this.value(when) === "when") this.scanExpression(when + 1, arrow, owner, scope);
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
		const last = this.lastBefore(stop, keyword);
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
		for (let current = keyword; current >= 0 && current < stop; current = this.nextSignificant(current + 1, stop)) {
			const value = this.value(current) ?? "";
			if (QUERY_WORDS.has(value)) this.ignoredOffsets.add((this.token(current) as Token).startOffset);
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
				join.to = this.lastBefore(current, join.from);
				join = undefined;
			} else if (value === "into") {
				for (const item of region) item.to = this.lastBefore(current, item.from);
				if (join !== undefined) join.to = Math.min(join.to, this.lastBefore(current, join.from));
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
				const first = this.nextSignificant(current + 1, stop);
				const typeSpan = first === name ? undefined : { start: first, end: name };
				this.declareLocal(
					name,
					first,
					name,
					owner,
					typeSpan,
					this.header(first, name + 1),
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
		const first = this.nextSignificant(keyword + 1, end);
		const followed = (name: number): boolean => {
			if (!this.isDesignation(name)) return false;
			return follower === "" || this.value(this.nextSignificant(name + 1, end)) === follower;
		};
		if (followed(first)) return first;
		if (follower !== "in" || first < 0 || !this.startsType(first)) return -1;
		const shape = this.typeShape(first, end);
		const name = shape === undefined ? -1 : this.nextSignificant(shape.end, end);
		return followed(name) ? name : -1;
	}

	/** A query runs to its expression's end; an `orderby` clause's commas are its own. */
	private queryEnd(keyword: number, end: number): number {
		let ordering = false;
		let previous = -1;
		let current = this.nextSignificant(keyword + 1, end);
		while (current >= 0 && current < end) {
			const value = this.value(current) ?? "";
			if (EXPRESSION_ENDS.has(value) && !(value === "," && ordering)) return current;
			if (QUERY_CLAUSES.has(value)) ordering = value === "orderby";
			current = this.skipGroup(current, previous, end);
			previous = current;
			current = this.nextSignificant(current + 1, end);
		}
		return end;
	}
}
