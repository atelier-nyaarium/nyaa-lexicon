import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import ts from "typescript";
import { lineOf, type ParsedSource, parseSource } from "../astResidue";
import { readSwept, sourceFiles } from "../residue";

/**
 * Holds edits.ts as the only module deciding what a SET of edits means.
 *
 * Five copies had drifted. The rule is DELEGATION, not naming, so the sweep finds the overlap scan.
 */
const PACKAGES = ["protocol", "core", "adapters", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

/** The one owner. */
const OWNER = "edits.ts";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

const COMPARISONS = new Set([
	ts.SyntaxKind.LessThanToken,
	ts.SyntaxKind.LessThanEqualsToken,
	ts.SyntaxKind.GreaterThanToken,
	ts.SyntaxKind.GreaterThanEqualsToken,
]);

const swept = (dir: string) => sourceFiles(dir, SKIP_DIRS);

////////////////////////////////
//  Functions & Helpers

function memberName(node: ts.Node): string | undefined {
	return ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
}

/**
 * Whether an `.end` reaches this expression: directly, or through the one combinator a cursor uses.
 *
 * Only `Math.max`/`Math.min`. Any call taking an `.end` would make its result an end, and a parser
 * asking `previousCode(tokens, segment.end)` for a token index is not carrying a running edit
 * cursor; following that properly is data flow, and guessing at it is how a rule earns its noise.
 */
function carriesEnd(node: ts.Node | undefined, known: ReadonlySet<string>): boolean {
	if (node === undefined) return false;
	if (memberName(node) === "end") return true;
	// A name already known to hold one, so a chain through `Math.max` still reads as the cursor.
	if (ts.isIdentifier(node) && known.has(node.text)) return true;
	if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
	const combinator = node.expression;
	if (!ts.isIdentifier(combinator.expression) || combinator.expression.text !== "Math") return false;
	if (combinator.name.text !== "max" && combinator.name.text !== "min") return false;
	return node.arguments.some((argument) => carriesEnd(argument, known));
}

/** Names a destructure binds to a range's `start`, so a bare `start` still reads as one. */
function startNames(source: ts.Node): Set<string> {
	const names = new Set<string>();
	const walk = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
			for (const element of node.name.elements) {
				const named = element.propertyName ?? element.name;
				if (ts.isIdentifier(named) && named.text === "start" && ts.isIdentifier(element.name)) {
					names.add(element.name.text);
				}
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return names;
}

/**
 * Names and properties this file ever puts an `.end` into, since the scan holds one in a cursor.
 *
 * Every way a running end is carried, because naming three variables was the old rule's whole
 * weakness: a declaration, a later assignment, a destructure, an accumulator property, and a value
 * arriving through `Math.max`.
 */
function endHolders(source: ts.Node): Set<string> {
	const holders = new Set<string>();
	// To a fixed point: a cursor is often fed from a name that was itself fed from an end.
	for (let pass = 0, growing = true; growing && pass < 8; pass += 1) {
		const before = holders.size;
		collectEndHolders(source, holders);
		growing = holders.size > before;
	}
	return holders;
}

function collectEndHolders(source: ts.Node, holders: Set<string>): void {
	const walk = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && carriesEnd(node.initializer, holders)) {
			if (ts.isIdentifier(node.name)) holders.add(node.name.text);
		}
		// `const { end } = edit.range`, where the destructured name is the end itself.
		if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
			for (const element of node.name.elements) {
				const named = element.propertyName ?? element.name;
				if (ts.isIdentifier(named) && named.text === "end" && ts.isIdentifier(element.name)) {
					holders.add(element.name.text);
				}
			}
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			carriesEnd(node.right, holders)
		) {
			if (ts.isIdentifier(node.left)) holders.add(node.left.text);
			// `cursor.end = Math.max(cursor.end, edit.range.end)`: the running end lives on an object.
			else if (ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)) {
				holders.add(`${node.left.expression.text}.${node.left.name.text}`);
			}
		}
		// `ends.push(edit.range.end)`, read back later as the running end.
		if (
			ts.isCallExpression(node) &&
			memberName(node.expression) === "push" &&
			node.arguments.some((argument) => carriesEnd(argument, holders))
		) {
			const target = (node.expression as ts.PropertyAccessExpression).expression;
			if (ts.isIdentifier(target)) holders.add(target.text);
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
}

/** The name a comparison side reaches, whether a bare local or an accumulator's property. */
function sideName(node: ts.Node): string | undefined {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
		return `${node.expression.text}.${node.name.text}`;
	}
	if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
		// `ends.at(-1)` reads the running end back out.
		return ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : undefined;
	}
	return undefined;
}

/**
 * Comparing one edit's start against a RUNNING end, however that end is named.
 *
 * The running part is what makes it the overlap scan. A `.start` against a fixed `.end` is an
 * ordinary bounds check, and flagging those buries the rule in noise: a span walked inside a range,
 * or an offset checked against a file's end, are neither of them a second edit planner.
 *
 * Known limit: the end has to reach a name or an accumulator property. One rebuilt from an index
 * into an unrelated structure, or returned by a function this file does not define, walks past;
 * following those is data flow, and a rule that guesses at it earns only noise.
 */
function overlapScans(parsed: ParsedSource): ts.Node[] {
	// Per FUNCTION, never per file: one file-wide set lets a `last` in one function make every other
	// `last` read as a running end, which is the same scope blindness this rule replaced.
	const found: ts.Node[] = [];
	const scopes: ts.Node[] = [parsed.source];
	const collect = (node: ts.Node): void => {
		if (ts.isFunctionLike(node)) scopes.push(node);
		ts.forEachChild(node, collect);
	};
	collect(parsed.source);
	for (const scope of scopes) found.push(...scanScope(parsed, scope));
	return [...new Set(found)];
}

function scanScope(parsed: ParsedSource, scope: ts.Node): ts.Node[] {
	const holders = endHolders(scope);
	if (holders.size === 0) return [];
	const starts = startNames(scope);
	const found: ts.Node[] = [];
	const walk = (node: ts.Node): void => {
		if (node !== scope && ts.isFunctionLike(node)) return;
		if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
			const sides = [node.left, node.right];
			const startSide = sides.find(
				(side) =>
					memberName(side) === "start" ||
					sideName(side)?.endsWith(".start") === true ||
					(ts.isIdentifier(side) && starts.has(side.text)),
			);
			const endSide = sides.find((side) => holders.has(sideName(side) ?? ""));
			if (startSide !== undefined && endSide !== undefined && startSide !== endSide) found.push(node);
		}
		ts.forEachChild(node, walk);
	};
	walk(scope);
	return found;
}

////////////////////////////////
//  Tests

describe("one module owns what a set of edits means", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(swept);
		expect(all.length).toBeGreaterThan(50);
		expect(all.map((file) => basename(file))).toContain(OWNER);
	});

	it("has nobody but the owner sweeping an edit list for overlap", () => {
		const offenders: string[] = [];

		for (const file of PACKAGES.flatMap(swept)) {
			if (basename(file) === OWNER) continue;
			const text = readSwept(file);
			if (text === null) continue;
			const parsed = parseSource(file, text);
			for (const node of overlapScans(parsed)) {
				offenders.push(`${basename(file)}:${lineOf(parsed, node)} ${node.getText(parsed.source)}`);
			}
		}

		expect(
			offenders,
			"deciding which edits can travel together belongs to planEdits in protocol/src/edits.ts. A provider maps its findings into its own vocabulary; it does not redo the analysis.",
		).toEqual([]);
	});
});
