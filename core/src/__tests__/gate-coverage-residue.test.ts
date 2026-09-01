import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callsIn, lineOf, type ParsedSource, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds every writing dispatch handler inside the workspace gate.
 *
 * Bug class killed: a write path nobody routed through the gate. Taking it is opt-in per handler,
 * so forgetting produces a race rather than an error, and it was forgotten twice: once for watcher
 * batches and once for rename. A new writing method now fails here instead.
 */
const DISPATCH = join(import.meta.dirname, "..", "dispatch.ts");

/** The three effects a handler may declare. Only `staged` has to gate its writes itself. */
const EFFECTS = new Set(["read", "write", "staged"]);

/** Service calls that touch disk or replace stored facts. Add a method here when you add one. */
const WRITING_CALLS = ["service.indexFile", "transactions().start", "transactions().track"];

/** Calls that put files back, each of which leaves the index describing the version it replaced. */
const RESTORING_CALLS = ["transactions().undo", "transactions().revert"];

interface Handler {
	readonly method: string;
	readonly effect: string;
	readonly node: ts.Node;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Each handler, as the AST node its effect wraps.
 *
 * Splitting the file's TEXT at a property was the defect: a call is judged by whether it sits inside
 * a gate's callback, which is containment, and text can only tell you what came earlier on the page.
 */
function handlers(parsed: ParsedSource): Handler[] {
	const found: Handler[] = [];
	const walk = (node: ts.Node): void => {
		if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && ts.isCallExpression(node.initializer)) {
			const callee = node.initializer.expression;
			if (ts.isIdentifier(callee) && EFFECTS.has(callee.text)) {
				found.push({ method: node.name.text, effect: callee.text, node: node.initializer });
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(parsed.source);
	return found;
}

/** The printed callee of a call, so `service.indexFile(x)` reads back as it is written. */
function calleeText(call: ts.CallExpression, parsed: ParsedSource): string {
	return call.expression.getText(parsed.source);
}

/** Calls under `node` whose callee is spelled as one of `names`. */
function callsNamed(parsed: ParsedSource, node: ts.Node, names: readonly string[]): ts.CallExpression[] {
	const found: ts.CallExpression[] = [];
	const walk = (current: ts.Node): void => {
		if (ts.isCallExpression(current) && names.includes(calleeText(current, parsed))) found.push(current);
		ts.forEachChild(current, walk);
	};
	walk(node);
	return found;
}

/** The name a staged handler binds its gate to, so an unrelated `.write` cannot stand in for it. */
function gateParameter(handler: ts.Node): string | undefined {
	const run = (handler as ts.CallExpression).arguments?.[0];
	if (run === undefined || (!ts.isArrowFunction(run) && !ts.isFunctionExpression(run))) return undefined;
	const second = run.parameters[1];
	return second !== undefined && ts.isIdentifier(second.name) ? second.name.text : undefined;
}

/**
 * Ranges of the work handed to the HANDLER'S OWN `gate.write(...)`.
 *
 * The receiver is checked against the gate the handler was given: any object with a `write` method
 * would otherwise read as the workspace gate, which is a hole rather than a looser rule.
 *
 * This is where a call SITS. Work ESCAPING the callback is caught separately below, since a write
 * stored inside the gate and run after it is a write outside the gate wearing the right shape.
 */
function exclusiveRegions(parsed: ParsedSource, handler: ts.Node): Array<{ start: number; end: number }> {
	const gate = gateParameter(handler);
	if (gate === undefined) return [];
	const regions: Array<{ start: number; end: number }> = [];
	for (const call of callsIn(handler)) {
		const callee = call.expression;
		if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "write") continue;
		if (!ts.isIdentifier(callee.expression) || callee.expression.text !== gate) continue;
		const work = call.arguments[0];
		if (work === undefined) continue;
		regions.push({ start: work.getStart(parsed.source), end: work.getEnd() });
	}
	return regions;
}

function inside(node: ts.Node, regions: ReadonlyArray<{ start: number; end: number }>, parsed: ParsedSource): boolean {
	const start = node.getStart(parsed.source);
	return regions.some((region) => start >= region.start && node.getEnd() <= region.end);
}

/**
 * Writes ASSIGNED OUT of an exclusive region, to be run once the gate is released.
 *
 * `await gate.write(() => { later = () => service.indexFile(m) }); await later()` puts the call
 * inside the region and the write outside it, which containment alone reads as gated.
 */
function escapingWrites(parsed: ParsedSource, handler: ts.Node): ts.Node[] {
	const regions = exclusiveRegions(parsed, handler);
	if (regions.length === 0) return [];
	const escaping: ts.Node[] = [];
	const walk = (node: ts.Node): void => {
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left) &&
			inside(node, regions, parsed) &&
			callsNamed(parsed, node.right, WRITING_CALLS).length > 0
		) {
			escaping.push(node);
		}
		ts.forEachChild(node, walk);
	};
	walk(handler);
	return escaping;
}

////////////////////////////////
//  Tests

describe("every writing dispatch handler takes the workspace gate", () => {
	const parsed = parseSource(DISPATCH, readFileSync(DISPATCH, "utf8"));

	it("finds the handlers to check, so a passing run is never vacuous", () => {
		expect(handlers(parsed).length).toBeGreaterThan(10);
	});

	it("sees the writing calls it names, so the list has not gone stale", () => {
		const written = handlers(parsed).flatMap((handler) =>
			callsNamed(parsed, handler.node, [...WRITING_CALLS, ...RESTORING_CALLS]).map((call) =>
				calleeText(call, parsed),
			),
		);
		for (const call of [...WRITING_CALLS, ...RESTORING_CALLS]) {
			expect(written, `${call} is no longer called in dispatch; update the list`).toContain(call);
		}
	});

	it("runs each of them under the exclusive gate", () => {
		const offenders: string[] = [];

		for (const handler of handlers(parsed)) {
			// A `write` handler is exclusive for its whole body; only `staged` has regions.
			if (handler.effect === "write") continue;
			const regions = handler.effect === "staged" ? exclusiveRegions(parsed, handler.node) : [];
			for (const call of callsNamed(parsed, handler.node, WRITING_CALLS)) {
				if (inside(call, regions, parsed)) continue;
				offenders.push(
					`${handler.method} (${handler.effect}) calls ${calleeText(call, parsed)} outside gate.write at line ${lineOf(parsed, call)}`,
				);
			}
			for (const assignment of escapingWrites(parsed, handler.node)) {
				offenders.push(
					`${handler.method} (${handler.effect}) assigns a write out of gate.write at line ${lineOf(parsed, assignment)}`,
				);
			}
		}

		expect(
			offenders,
			"a dispatch handler that writes must run inside the workspace gate, or it can interleave with a refactor step.",
		).toEqual([]);
	});

	// Restoring puts back text the index does not describe, so a restore that skips the reindex
	// leaves the store answering about a version that is no longer on disk. Forgotten twice.
	it("reindexes whatever it restores", () => {
		const offenders: string[] = [];

		for (const handler of handlers(parsed)) {
			if (callsNamed(parsed, handler.node, RESTORING_CALLS).length === 0) continue;
			if (callsNamed(parsed, handler.node, ["service.indexFile"]).length === 0) {
				offenders.push(`${handler.method} restores without reindexing`);
			}
		}

		expect(offenders, "a dispatch handler that restores files must reindex them.").toEqual([]);
	});
});
