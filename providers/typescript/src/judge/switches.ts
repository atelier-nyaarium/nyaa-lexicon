// Switch statements: which clause the discriminant enters, and how the clauses' completions leave it.

import ts from "typescript";
import { can, canOther, canOtherThan, EITHER, exclude, isFiniteDomain, type Primitive } from "./domains.js";
import {
	type Exit,
	type Flow,
	type Frame,
	type Guard,
	literal,
	mergeGuards,
	provOf,
	strictEquals,
	UNKNOWN,
	unionProv,
	type Value,
} from "./model.js";
import { statements } from "./statements.js";
import { literalOf } from "./symbols.js";
import type { Step, Walker } from "./walker.js";

////////////////////////////////
//  Switches

export function* switchStatement(
	w: Walker,
	node: ts.SwitchStatement,
	frame: Frame,
	flow: Flow,
	label?: string,
): Step<void> {
	const discriminant = yield* w.expr(node.expression, frame, flow);
	if (!flow.alive) return;
	const base = [...flow.guards];
	const clauses = node.caseBlock.clauses;
	const fallback = clauses.findIndex(ts.isDefaultClause);
	let start = fallback;
	let unfolded: number | undefined;
	let tested = -1;
	/** Each case's label, once evaluated. */
	const labels = new Map<number, Value>();
	for (const [at, clause] of clauses.entries()) {
		if (!ts.isCaseClause(clause)) continue;
		if (discriminant.kind !== "literal") {
			unfolded = at;
			break;
		}
		const test = yield* w.expr(clause.expression, frame, flow);
		if (!flow.alive) return;
		tested = at;
		labels.set(at, test);
		if (test.kind !== "literal") {
			unfolded = at;
			break;
		}
		if (test.value === discriminant.value) {
			start = at;
			break;
		}
	}
	const own = (exit: Exit) => exit.kind === "break" && (exit.label === undefined || exit.label === label);
	if (unfolded === undefined) {
		if (start < 0) return;
		const inner = w.branch(flow);
		for (const clause of clauses.slice(start)) yield* statements(w, clause.statements, frame, inner);
		const rest = inner.exits.filter((exit) => !own(exit));
		flow.exits.push(...rest);
		flow.alive = inner.alive || inner.exits.some(own);
		flow.guards = w.dependent(base, rest);
		return;
	}
	// Labels run in order, each past the ones before it: one that throws ends the tests, and the default.
	const tests = w.branch(flow);
	const matched = new Map<number, Guard[]>();
	let remaining = discriminant.kind === "unknown" ? discriminant.domain : undefined;
	let finiteNarrowing = remaining !== undefined && isFiniteDomain(remaining);
	let exhausted = false;
	for (const [at, clause] of clauses.entries()) {
		if (!ts.isCaseClause(clause) || at < unfolded) continue;
		const guardCount = tests.guards.length;
		const value = at > tested ? yield* w.expr(clause.expression, frame, tests) : (labels.get(at) ?? UNKNOWN);
		if (!tests.alive) break;
		const evaluated = tests.guards.slice(guardCount);
		const evaluationOpaque = evaluated.some((guard) => guard.opaque);
		const literal = value.kind === "literal" ? value.value : undefined;
		if (literal === undefined || evaluationOpaque) finiteNarrowing = false;
		if (finiteNarrowing && remaining !== undefined && literal !== undefined && !can(remaining, literal)) continue;
		const exactMatch = finiteNarrowing && literal !== undefined;
		const narrowed = exactMatch && remaining !== undefined ? { ...discriminant, domain: remaining } : discriminant;
		matched.set(at, [...tests.guards, w.guard(matching(narrowed, value), node.expression, flow)]);
		if (finiteNarrowing && remaining !== undefined && literal !== undefined)
			remaining = exclude(remaining, literal);
		const failedGuard = w.guard(nonmatching(discriminant, value), node.expression, flow);
		tests.guards.push(failedGuard);
		if (remaining !== undefined && remaining.length === 0) {
			exhausted = true;
			break;
		}
	}
	if (exhausted) tests.alive = false;
	const spelled = clauses.flatMap((clause) => (ts.isCaseClause(clause) ? [literalOf(clause.expression)] : []));
	const unmatchedGuards = tests.alive
		? [
				...tests.guards,
				w.guard(
					finiteNarrowing && remaining !== undefined && remaining.length > 0
						? literal(true)
						: unmatched(discriminant, spelled),
					node.expression,
					flow,
				),
			]
		: undefined;
	let fallthrough: Flow[] = [];
	const exits = [...tests.exits];
	const switchBreaks: Exit[] = [];
	for (const [at, clause] of clauses.entries()) {
		// Before the first unfolded test, a clause after the default is reached only through its fallthrough.
		const throughDefault = ts.isDefaultClause(clause) || (at < unfolded && fallback >= 0 && at > fallback);
		const direct = throughDefault ? unmatchedGuards : matched.get(at);
		const entries: Flow[] = [
			...(direct === undefined ? [] : [{ alive: true, guards: [...direct], exits: [] }]),
			...fallthrough,
		];
		const next: Flow[] = [];
		for (const entry of entries) {
			yield* statements(w, clause.statements, frame, entry);
			for (const exit of entry.exits) {
				if (own(exit)) switchBreaks.push(exit);
				else exits.push(exit);
			}
			if (entry.alive) next.push({ alive: true, guards: [...entry.guards], exits: [] });
		}
		fallthrough = next;
	}
	flow.exits.push(...exits);
	const noMatch = fallback < 0 && tests.alive && !exhausted;
	flow.alive = noMatch || fallthrough.length > 0 || switchBreaks.length > 0;
	const continuing = [
		...fallthrough.map((path) => path.guards),
		...switchBreaks.map((exit) => exit.guards),
		...(noMatch && unmatchedGuards !== undefined ? [unmatchedGuards] : []),
	];
	const extra = continuing.flatMap((guards) => guards.slice(base.length));
	flow.guards = extra.length === 0 ? base : [...base, mergeGuards(extra)];
}

function nonmatching(discriminant: Value, label: Value): Value {
	const same = strictEquals(discriminant, label);
	if (same === false) return literal(true);
	if (same === true) return literal(false);
	const prov = unionProv(provOf(discriminant), provOf(label));
	const operand = discriminant.kind === "literal" ? label : discriminant;
	const other = discriminant.kind === "literal" ? discriminant : label;
	if (operand.kind === "unknown" && operand.domain !== undefined && other.kind === "literal") {
		if (!can(operand.domain, other.value)) return literal(true);
		if (!canOther(operand.domain, other.value)) return literal(false);
		return { kind: "unknown", prov, domain: EITHER };
	}
	return { kind: "unknown", prov };
}

/**
 * Whether a case matches: decided between known values, else a test that can match where an input may
 * equal a literal label. One that cannot match is entered only by a fallthrough the walk does not follow.
 */
function matching(discriminant: Value, label: Value): Value {
	const same = strictEquals(discriminant, label);
	if (same === true) return literal(true);
	if (same === false) return UNKNOWN;
	const prov = unionProv(provOf(discriminant), provOf(label));
	const operand = discriminant.kind === "literal" ? label : discriminant;
	const other = discriminant.kind === "literal" ? discriminant : label;
	if (operand.kind === "unknown" && operand.domain !== undefined && other.kind === "literal") {
		// A domain of that label alone always matches.
		if (!canOther(operand.domain, other.value)) return literal(true);
		if (can(operand.domain, other.value)) return { kind: "unknown", prov, domain: EITHER };
	}
	return { kind: "unknown", prov };
}

/** Whether no case matches, so the default runs: where every label is a literal the discriminant may differ from. */
function unmatched(discriminant: Value, labels: ReadonlyArray<{ value: Primitive } | undefined>): Value {
	const values = labels.flatMap((label) => (label === undefined ? [] : [label.value]));
	if (values.length < labels.length) return UNKNOWN;
	if (discriminant.kind === "literal") return values.includes(discriminant.value) ? UNKNOWN : literal(true);
	if (discriminant.kind !== "unknown" || discriminant.domain === undefined)
		return { kind: "unknown", prov: provOf(discriminant) };
	const either = canOtherThan(discriminant.domain, values);
	return { kind: "unknown", prov: provOf(discriminant), ...(either ? { domain: EITHER } : {}) };
}
