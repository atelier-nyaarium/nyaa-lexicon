import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { lineOf, type ParsedSource, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/**
 * Holds the `own` step policy to the two committed handlers.
 *
 * A step holding `{ own }` refuses an open refactor and commits one of its own, so a third caller
 * minting it would turn a write that joins into one that commits. The handler entries are the
 * reviewed place.
 */
const CORE = join(import.meta.dirname, "..");

const DISPATCH = join(CORE, "dispatch.ts");

const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "fixtures"]);

/** The handler entries that may mint one. */
const MINTERS = ["refactorRenameCommitted", "refactorMoveCommitted"];

////////////////////////////////
//  Functions & Helpers

function ownKey(property: ts.ObjectLiteralElementLike): boolean {
	const name = property.name;
	if (name === undefined) return false;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === "own";
	return ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) && name.expression.text === "own";
}

/** Object literals with an `own` key, in any spelling of the key. */
function mints(parsed: ParsedSource): ts.ObjectLiteralExpression[] {
	const found: ts.ObjectLiteralExpression[] = [];
	const walk = (node: ts.Node): void => {
		if (ts.isObjectLiteralExpression(node) && node.properties.some(ownKey)) found.push(node);
		ts.forEachChild(node, walk);
	};
	walk(parsed.source);
	return found;
}

/** The minting handler entry a node sits in. */
function entryOf(node: ts.Node): string | undefined {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name) && MINTERS.includes(current.name.text)) {
			return current.name.text;
		}
	}
	return undefined;
}

function parse(file: string): ParsedSource {
	return parseSource(file, readFileSync(file, "utf8"));
}

////////////////////////////////
//  Tests

describe("only the committed handlers mint an own step policy", () => {
	it("finds core sources and one mint per committed handler, so a passing run is never vacuous", () => {
		expect(sourceFiles(CORE, SKIP_DIRS)).toContain(DISPATCH);
		expect(mints(parse(DISPATCH)).map(entryOf).sort()).toEqual([...MINTERS].sort());
	});

	it("mints it nowhere else in core", () => {
		const offenders = sourceFiles(CORE, SKIP_DIRS).flatMap((file) => {
			const parsed = parse(file);
			return mints(parsed)
				.filter((node) => file !== DISPATCH || entryOf(node) === undefined)
				.map((node) => `${basename(file)}:${lineOf(parsed, node)}`);
		});

		expect(offenders, "an own step commits its own refactor; mint it only in a committed handler").toEqual([]);
	});

	it("recognises each spelling of the key when planted, and not the type or the hold", () => {
		const planted = [
			"const policy = { own: bases };",
			'const policy = { "own": bases };',
			'const policy = { ["own"]: bases };',
			"const own = bases; const policy = { own };",
		];
		for (const line of planted) expect(mints(parseSource("planted.ts", line)), line).toHaveLength(1);

		const clean = ["type Policy = { own: StepBase[] };", 'if (hold === "own") commit();'];
		for (const line of clean) expect(mints(parseSource("clean.ts", line)), line).toHaveLength(0);
	});
});
