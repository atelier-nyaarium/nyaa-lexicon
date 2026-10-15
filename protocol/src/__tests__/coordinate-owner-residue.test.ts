import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import ts from "typescript";
import { calleeOf, callsIn, lineOf, nodesIn, type ParsedSource, parseSource } from "../astResidue";
import { readSwept, sourceFiles } from "../residue";

/**
 * Holds coordinates.ts as the only module that maps an offset to a position.
 *
 * Bug class killed: twenty private converters that disagreed about what is out of bounds. One of
 * them minted a negative character, and the shared applier CLAMPED it rather than refusing, so a
 * caller's arithmetic bug became a correct-looking edit somewhere else in the file.
 *
 * The rule is DELEGATION, not naming. A helper called `rangeForText` that routes through the owner
 * is fine and there are a dozen of them; the same name doing its own line arithmetic is not. So the
 * test looks for the arithmetic, and requires any file doing it to be the owner.
 */
const PACKAGES = ["protocol", "core", "adapters", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

/** The one owner. */
const OWNER = "coordinates.ts";
const OWNER_PATH = join(import.meta.dirname, "..", "coordinates.ts");
const PROTOCOL_SOURCE = join(import.meta.dirname, "..");
const CORE_SOURCE = join(import.meta.dirname, "..", "..", "..", "core", "src");

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

const swept = (dir: string) => sourceFiles(dir, SKIP_DIRS);

////////////////////////////////
//  Functions & Helpers

/** A newline, however it is written: `"\n"`, `'\n'`, or a regex matching one. */
function isNewline(node: ts.Node | undefined): boolean {
	if (node === undefined) return false;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text === "\n";
	if (ts.isRegularExpressionLiteral(node)) return /^\/\\n\/[a-z]*$/.test(node.text);
	return false;
}

/**
 * Deriving a LINE or a CHARACTER from raw text, rather than merely splitting text into lines.
 *
 * Splitting for display is everywhere and legitimate; what is not is asking how MANY newlines came
 * before a point, or where the last one was. Those two questions are the coordinate, and the shape
 * of the answer is what is recognized here rather than the names a copy happened to use.
 */
function arithmetic(parsed: ParsedSource): Array<{ node: ts.Node; why: string }> {
	const found: Array<{ node: ts.Node; why: string }> = [];
	for (const call of callsIn(parsed.source)) {
		const callee = calleeOf(call);
		if (callee === undefined || !isNewline(call.arguments[0])) continue;
		// Where the line containing an offset begins: a character coordinate, never a display concern.
		if (callee.name === "lastIndexOf") found.push({ node: call, why: "lastIndexOf a newline" });
		// How many lines precede a point. The count is the line number; the split alone is not.
		if (
			(callee.name === "split" || callee.name === "match" || callee.name === "matchAll") &&
			ts.isPropertyAccessExpression(call.parent) &&
			call.parent.name.text === "length"
		) {
			found.push({ node: call, why: `counting newlines with ${callee.name}` });
		}
	}
	// NOT flagged, and this is the rule's known limit: `character === "\n"`. A hand-written lexer
	// advancing its own line counter is tokenizing, which docs/parsing.md rule 6 requires of it, and
	// every parser here does it. A one-off counter loop wears the same shape, so it walks past;
	// nothing here distinguishes the two, and a rule that cannot be stated is worse than a stated gap.
	return found;
}

interface CoordinateDifference {
	coordinate: "line" | "character";
	left: string;
	right: string;
}

function coordinateDifference(node: ts.Node): CoordinateDifference | undefined {
	if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.MinusToken) return undefined;
	if (!ts.isPropertyAccessExpression(node.left) || !ts.isPropertyAccessExpression(node.right)) return undefined;
	const left = node.left.name.text;
	const right = node.right.name.text;
	if (left !== right || (left !== "line" && left !== "character")) return undefined;
	return { coordinate: left, left: node.left.expression.getText(), right: node.right.expression.getText() };
}

const COMPARISON_OPERATORS = [
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.LessThanToken,
	ts.SyntaxKind.LessThanEqualsToken,
	ts.SyntaxKind.GreaterThanToken,
	ts.SyntaxKind.GreaterThanEqualsToken,
];

function comparedCoordinates(node: ts.Node, coordinate: "line" | "character"): [string, string] | undefined {
	if (!ts.isBinaryExpression(node) || !COMPARISON_OPERATORS.includes(node.operatorToken.kind)) return undefined;
	if (!ts.isPropertyAccessExpression(node.left) || !ts.isPropertyAccessExpression(node.right)) return undefined;
	if (node.left.name.text !== coordinate || node.right.name.text !== coordinate) return undefined;
	return [node.left.expression.getText(), node.right.expression.getText()];
}

function samePair(first: [string, string], second: [string, string]): boolean {
	return (first[0] === second[0] && first[1] === second[1]) || (first[0] === second[1] && first[1] === second[0]);
}

function sameSubjects(first: [string, string], difference: CoordinateDifference): boolean {
	return samePair(first, [difference.left, difference.right]);
}

function hasLineThenCharacter(
	differences: Array<CoordinateDifference | undefined>,
	subjects: [string, string],
): boolean {
	return (
		differences.some((difference) => difference?.coordinate === "line" && sameSubjects(subjects, difference)) &&
		differences.some((difference) => difference?.coordinate === "character" && sameSubjects(subjects, difference))
	);
}

function returnedDifference(statement: ts.Statement | undefined): CoordinateDifference | undefined {
	if (statement === undefined) return undefined;
	if (ts.isReturnStatement(statement) && statement.expression !== undefined) {
		return coordinateDifference(statement.expression);
	}
	if (ts.isBlock(statement) && statement.statements.length === 1) {
		return returnedDifference(statement.statements[0]);
	}
	return undefined;
}

function copiedConditionalOrder(expression: ts.ConditionalExpression): boolean {
	const subjects = comparedCoordinates(expression.condition, "line");
	if (subjects === undefined) return false;
	return hasLineThenCharacter(
		[coordinateDifference(expression.whenTrue), coordinateDifference(expression.whenFalse)],
		subjects,
	);
}

function copiedIfChainOrder(statement: ts.IfStatement): boolean {
	const subjects = comparedCoordinates(statement.expression, "line");
	if (subjects === undefined) return false;
	const differences = [returnedDifference(statement.thenStatement), returnedDifference(statement.elseStatement)];
	if (hasLineThenCharacter(differences, subjects)) return true;

	if (!ts.isBlock(statement.parent)) return false;
	const siblings = statement.parent.statements;
	const next = siblings[siblings.indexOf(statement) + 1];
	if (next === undefined) return false;
	if (ts.isIfStatement(next)) {
		const characterSubjects = comparedCoordinates(next.expression, "character");
		if (characterSubjects === undefined || !samePair(subjects, characterSubjects)) return false;
		differences.push(returnedDifference(next.thenStatement), returnedDifference(next.elseStatement));
	} else {
		differences.push(returnedDifference(next));
	}
	return hasLineThenCharacter(differences, subjects);
}

function copiedPositionOrder(parsed: ParsedSource): boolean {
	return nodesIn(parsed.source).some((node) => {
		if (ts.isConditionalExpression(node) && copiedConditionalOrder(node)) return true;
		if (ts.isIfStatement(node) && copiedIfChainOrder(node)) return true;
		if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return false;
		const left = coordinateDifference(node.left)?.coordinate;
		const right = coordinateDifference(node.right)?.coordinate;
		return (left === "line" && right === "character") || (left === "character" && right === "line");
	});
}

////////////////////////////////
//  Tests

describe("one module owns text coordinates", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(swept);
		expect(all.length).toBeGreaterThan(50);
		expect(all.map((file) => basename(file))).toContain(OWNER);
	});

	// Tests are included deliberately: a fixture helper doing its own arithmetic is how three of
	// these survived the first migration, inside this very package.
	it("has nobody but the owner deriving a line or character from raw text", () => {
		const offenders: string[] = [];

		for (const file of PACKAGES.flatMap(swept)) {
			if (basename(file) === OWNER) continue;
			const text = readSwept(file);
			if (text === null) continue;
			const parsed = parseSource(file, text);
			for (const { node, why } of arithmetic(parsed)) {
				offenders.push(`${basename(file)}:${lineOf(parsed, node)} ${why}`);
			}
		}

		expect(
			offenders,
			"line and character arithmetic belongs to coordinatesOf in protocol/src/coordinates.ts. A named helper may wrap it, but must not reimplement it.",
		).toEqual([]);
	});

	it("routes position ordering through comparePositions", () => {
		const planted = parseSource(
			"planted.ts",
			"(a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character",
		);
		expect(copiedPositionOrder(planted)).toBe(true);
		const ternary = parseSource(
			"planted-ternary.ts",
			"(a, b) => a.line !== b.line ? a.line - b.line : a.character - b.character",
		);
		expect(copiedPositionOrder(ternary)).toBe(true);
		const ifChain = parseSource(
			"planted-if-chain.ts",
			"function compare(a, b) { if (a.line !== b.line) return a.line - b.line; return a.character - b.character; }",
		);
		expect(copiedPositionOrder(ifChain)).toBe(true);

		const orderFiles = [...swept(PROTOCOL_SOURCE), ...swept(CORE_SOURCE)];
		expect(orderFiles.length).toBeGreaterThan(0);
		expect(orderFiles).toContain(OWNER_PATH);
		expect(orderFiles).toContain(join(CORE_SOURCE, "locals.ts"));

		const offenders: string[] = [];
		for (const file of orderFiles) {
			if (file === OWNER_PATH) continue;
			const text = readSwept(file);
			if (text === null) continue;
			const parsed = parseSource(file, text);
			if (copiedPositionOrder(parsed)) offenders.push(`${basename(file)}:${lineOf(parsed, parsed.source)}`);
		}

		expect(offenders).toEqual([]);
	});
});
