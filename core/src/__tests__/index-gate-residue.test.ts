import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callsIn, lineOf, type ParsedSource, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds every indexing road to one gate, and keeps the two classes of road apart.
 *
 * Bug class killed: a road that parses a module beside another road parsing the same one. The
 * loser commits last and the store keeps the older facts, which no refusal and no admission
 * verdict can detect afterwards. The upgrade walk and the warm scan were both outside the gate.
 */
const CORE = join(import.meta.dirname, "..");
const INDEXER = join(CORE, "indexer.ts");

/** What opens an exclusive hold, whatever the receiver is called. */
const HOLD_OPENERS = ["exclusive", "write"];

/** What opens one of the indexer's own per-file holds. */
const STEP_OPENERS = ["alone", "step"];

/**
 * Roads that take the gate per file themselves.
 *
 * The gate is not re-entrant, so one of these reached from inside a hold deadlocks on its first
 * file. Matched by method name alone: the receiver is not the question, and no other declaration
 * here carries one of these names.
 */
const SELF_GATING = [
	"warmupWorkspace",
	"indexWorkspace",
	"upgradeRemaining",
	"requestFull",
	"ensureTreeFor",
	"ensureTreeForModule",
];

/**
 * Roads whose caller holds the gate around a unit larger than one file.
 *
 * A method of one of these names takes no hold itself, so a call inside one is already held and a
 * call outside one is not. `renameSymbol` is here because the refactor executor holds the gate
 * around it from another file, where containment cannot see it.
 */
const CALLER_HELD = new Set(["indexFile", "applyBatch", "renameSymbol"]);

/**
 * What `journaledStep` runs inside its write. The shape's plan runs before the hold; these members
 * of what it planned run under it, opened in another file where containment cannot see it.
 */
const STEP_HELD_MEMBERS = ["stale", "begin", "rebind", "apply"];

/** The service that owns the one gate; nothing else in core may build a second. */
const GATE_OWNER = "service.ts";

////////////////////////////////
//  Functions & Helpers

function coreSources(): ParsedSource[] {
	return readdirSync(CORE)
		.filter((entry) => entry.endsWith(".ts"))
		.map((entry) => join(CORE, entry))
		.map((file) => parseSource(file, readFileSync(file, "utf8")));
}

/** The member a call reaches, so `gate.exclusive` and a bare `write` read alike. */
function calleeName(call: ts.CallExpression): string | undefined {
	const callee = call.expression;
	if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
	if (ts.isIdentifier(callee)) return callee.text;
	return undefined;
}

/**
 * Ranges of the work handed to a hold.
 *
 * Only a function argument counts, or `stdin.write(chunk)` would read as a gate and swallow
 * everything under it.
 */
function regions(parsed: ParsedSource, openers: readonly string[]): Array<{ start: number; end: number }> {
	const found: Array<{ start: number; end: number }> = [];
	for (const call of callsIn(parsed.source)) {
		const name = calleeName(call);
		if (name === undefined || !openers.includes(name)) continue;
		const work = call.arguments[0];
		if (work === undefined || (!ts.isArrowFunction(work) && !ts.isFunctionExpression(work))) continue;
		found.push({ start: work.getStart(parsed.source), end: work.getEnd() });
	}
	return found;
}

/** The held members of every step shape handed to `journaledStep`. */
function stepRegions(parsed: ParsedSource): Array<{ start: number; end: number }> {
	const found: Array<{ start: number; end: number }> = [];
	const heldMember = (name: ts.PropertyName): boolean =>
		ts.isIdentifier(name) && STEP_HELD_MEMBERS.includes(name.text);
	const collect = (node: ts.Node): void => {
		if (ts.isMethodDeclaration(node) && heldMember(node.name)) {
			found.push({ start: node.getStart(parsed.source), end: node.getEnd() });
		} else if (
			ts.isPropertyAssignment(node) &&
			heldMember(node.name) &&
			(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
		) {
			found.push({ start: node.initializer.getStart(parsed.source), end: node.initializer.getEnd() });
		}
		ts.forEachChild(node, collect);
	};
	for (const call of callsNamed(parsed, ["journaledStep"])) collect(call);
	return found;
}

/** Every range that runs under the gate: a hold opened here, or a step member held elsewhere. */
function heldRegions(parsed: ParsedSource): Array<{ start: number; end: number }> {
	return [...regions(parsed, HOLD_OPENERS), ...stepRegions(parsed)];
}

function inside(node: ts.Node, ranges: ReadonlyArray<{ start: number; end: number }>, parsed: ParsedSource): boolean {
	const start = node.getStart(parsed.source);
	return ranges.some((range) => start >= range.start && node.getEnd() <= range.end);
}

function callsNamed(parsed: ParsedSource, names: readonly string[]): ts.CallExpression[] {
	return callsIn(parsed.source).filter((call) => {
		const name = calleeName(call);
		return name !== undefined && names.includes(name);
	});
}

/** The method a node sits in, so a road can be excused by where it is declared. */
function enclosingMethod(node: ts.Node): string | undefined {
	for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
		if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
	}
	return undefined;
}

function shortName(parsed: ParsedSource): string {
	return parsed.file.slice(CORE.length + 1);
}

/** Whether this file builds a gate of its own. */
function constructsGate(parsed: ParsedSource): boolean {
	let found = false;
	const walk = (node: ts.Node): void => {
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "WorkspaceGate") {
			found = true;
		}
		ts.forEachChild(node, walk);
	};
	walk(parsed.source);
	return found;
}

////////////////////////////////
//  Tests

describe("one gate, every indexing road", () => {
	const sources = coreSources();

	it("finds the holds and the roads it names, so a passing run is never vacuous", () => {
		const opened = sources.flatMap((parsed) => regions(parsed, HOLD_OPENERS));
		expect(opened.length).toBeGreaterThan(5);

		const reached = new Set(sources.flatMap((parsed) => callsNamed(parsed, SELF_GATING)).map(calleeName));
		for (const road of SELF_GATING) {
			expect([...reached], `${road} is no longer called in core; update the list`).toContain(road);
		}
	});

	it("never calls a self-gating road from inside a hold", () => {
		const offenders: string[] = [];
		for (const parsed of sources) {
			const held = heldRegions(parsed);
			if (held.length === 0) continue;
			for (const call of callsNamed(parsed, SELF_GATING)) {
				if (!inside(call, held, parsed)) continue;
				offenders.push(`${shortName(parsed)}:${lineOf(parsed, call)} calls ${calleeName(call)} inside a hold`);
			}
		}

		expect(
			offenders,
			"the workspace gate is not re-entrant, so a road that takes it per file deadlocks when a caller already holds it.",
		).toEqual([]);
	});

	it("parses a module only under a hold, or in a road whose caller holds one", () => {
		const parsed = parseSource(INDEXER, readFileSync(INDEXER, "utf8"));
		const stepped = regions(parsed, STEP_OPENERS);
		expect(stepped.length).toBeGreaterThan(2);

		const offenders: string[] = [];
		for (const call of callsNamed(parsed, ["indexOne"])) {
			if (inside(call, stepped, parsed)) continue;
			const method = enclosingMethod(call);
			if (method !== undefined && CALLER_HELD.has(method)) continue;
			offenders.push(`indexer.ts:${lineOf(parsed, call)} parses in ${method ?? "a free function"}`);
		}

		expect(
			offenders,
			"a parse outside the gate can commit after a newer parse of the same module, and the store keeps the older facts.",
		).toEqual([]);
	});

	// A caller-held road takes no hold itself; whoever calls it must.
	it("calls a caller-held road only from inside a hold", () => {
		const offenders: string[] = [];
		for (const parsed of sources) {
			if (shortName(parsed) === "indexer.ts") continue;
			const held = heldRegions(parsed);
			for (const call of callsNamed(parsed, [...CALLER_HELD])) {
				if (inside(call, held, parsed)) continue;
				const method = enclosingMethod(call);
				if (method !== undefined && CALLER_HELD.has(method)) continue;
				offenders.push(`${shortName(parsed)}:${lineOf(parsed, call)} calls ${calleeName(call)} unheld`);
			}
		}

		expect(
			offenders,
			"a caller-held road takes no gate itself, so a caller that holds none leaves its parse racing every other road.",
		).toEqual([]);
	});

	// A second gate orders nothing against the first.
	it("builds the workspace gate only where the service owns it", () => {
		const built = sources.flatMap((parsed) => (constructsGate(parsed) ? [shortName(parsed)] : []));
		expect(built, "no WorkspaceGate is constructed in core; the owner has moved").not.toEqual([]);
		expect(built, "one workspace has one gate, and the service is what holds it.").toEqual([GATE_OWNER]);
	});
});
