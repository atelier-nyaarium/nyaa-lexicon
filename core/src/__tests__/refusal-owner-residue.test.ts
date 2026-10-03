import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { readSwept, sourceFiles } from "@nyaa-lexicon/protocol";
import { calleeOf, callsIn, lineOf, memberCalls, nodesIn, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/**
 * Holds refusals.ts as the only composer of a refusal.
 *
 * Swept only where `reason:` always names one; elsewhere it also names an enum value and a tally
 * field, and the brand guards those slots instead.
 */
const SWEPT = ["notes.ts"].map((name) => join(import.meta.dirname, "..", name));

const OWNER = join(import.meta.dirname, "..", "refusals.ts");

/** Every file that composes a refusal, for the reachability check. */
const NARROWED = ["refactorPlanner.ts", "sourceWorkspace.ts", "service.ts", "transactions.ts", "applyEdits.ts"].map(
	(name) => join(import.meta.dirname, "..", name),
);

const SLOTS = join(import.meta.dirname, "..", "refusalSlots.ts");

/** Each narrowed slot is asserted against the compiler here, which a text sweep cannot do. */
const ASSERTIONS = join(import.meta.dirname, "refusalSlots.types.ts");

/** Refusal sentence slots. */
const SLOT_NAMES = new Set(["reason", "refused"]);

const CORE = join(import.meta.dirname, "..");

/** Tests are swept too: a double minting its own refusal is a sentence nobody reviewed. */
const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "fixtures"]);

/** Plants each spelling to test the check; excludes itself from the sweep. */
const SELF = import.meta.filename;

////////////////////////////////
//  Functions & Helpers

function parsed(file: string): ts.SourceFile {
	return parseSource(file, readSwept(file) ?? "").source;
}

/** `Refusal` or `refusal.Refusal`. */
function isBrand(type: ts.TypeNode): boolean {
	if (!ts.isTypeReferenceNode(type)) return false;
	const name = type.typeName;
	if (ts.isIdentifier(name)) return name.text === "Refusal";
	return ts.isIdentifier(name.left) && name.left.text === "refusal" && name.right.text === "Refusal";
}

/** `ReturnType<typeof refusal.x>`. */
function isConstructorReturn(type: ts.TypeNode): boolean {
	if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || type.typeName.text !== "ReturnType") {
		return false;
	}
	const argument = type.typeArguments?.[0];
	if (argument === undefined || !ts.isTypeQueryNode(argument) || !ts.isQualifiedName(argument.exprName)) return false;
	const left = argument.exprName.left;
	return ts.isIdentifier(left) && left.text === "refusal";
}

/** Casts, assertions, and `satisfies` clauses that mint the brand. */
function mints(root: ts.Node): string[] {
	return nodesIn(root).flatMap((node) => {
		const minting = ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node);
		if (!minting || !(isBrand(node.type) || isConstructorReturn(node.type))) return [];
		return [ts.SyntaxKind[node.kind]];
	});
}

/** Refusal-slot literals with line numbers. */
export function inlineRefusals(text: string): string[] {
	const source = parseSource("swept.ts", text);
	return nodesIn(source.source).flatMap((node) => {
		if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name) || !SLOT_NAMES.has(node.name.text)) return [];
		const literal = ts.isStringLiteralLike(node.initializer) || ts.isTemplateExpression(node.initializer);
		return literal ? [`line ${lineOf(source, node)}: ${node.name.text}`] : [];
	});
}

/** Calls to constructors through `refusal`. */
function namespacedCalls(root: ts.Node): string[] {
	return memberCalls(root)
		.filter(({ receiver }) => receiver === "refusal")
		.map(({ name }) => name);
}

/** The owner's exported function declarations. */
function exportedConstructors(): string[] {
	return parsed(OWNER).statements.flatMap((statement) => {
		if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) return [];
		const exported = ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
		return exported === true ? [statement.name.text] : [];
	});
}

////////////////////////////////
//  Tests

describe("one module composes every refusal", () => {
	it("finds every swept and narrowed file and the owner, so a passing run is never vacuous", () => {
		for (const file of [...SWEPT, ...NARROWED, OWNER, SLOTS, ASSERTIONS]) expect(readSwept(file)).not.toBeNull();
		const calls = SWEPT.flatMap((file) => namespacedCalls(parsed(file)));
		expect(calls.length).toBeGreaterThanOrEqual(15);
	});

	// A constructor nothing calls and a call naming no constructor are both drift.
	it("has each exported constructor called, and each call naming an export", () => {
		const exported = new Set(exportedConstructors());
		const called = new Set(
			parsedFiles(CORE, SKIP_DIRS).flatMap(({ source }) =>
				callsIn(source).flatMap((call) => calleeOf(call)?.name ?? []),
			),
		);
		const namespaced = new Set(SWEPT.flatMap((file) => namespacedCalls(parsed(file))));
		expect([...namespaced].filter((name) => !exported.has(name))).toEqual([]);
		expect([...exported].filter((name) => !called.has(name))).toEqual([]);
	});

	// One assertion per slot, so a widened one fails the build rather than this sweep.
	it("asserts every narrowed slot against the compiler", () => {
		const asserted = parsed(ASSERTIONS).statements.filter(
			(statement) =>
				ts.isTypeAliasDeclaration(statement) &&
				statement.name.text.startsWith("_") &&
				ts.isTypeReferenceNode(statement.type) &&
				ts.isIdentifier(statement.type.typeName) &&
				statement.type.typeName.text === "Assert",
		);
		expect(asserted.length, "each refusal slot needs its own type assertion").toBeGreaterThanOrEqual(15);
	});

	// The brand makes a raw sentence a type error; a cast is the way past it, in any spelling.
	it("has nobody in core but the owner minting the brand", () => {
		const files = sourceFiles(CORE, SKIP_DIRS);
		expect(files).toContain(OWNER);
		expect(files).toContain(SELF);
		const offenders = parsedFiles(CORE, SKIP_DIRS)
			.filter(({ file }) => file !== OWNER && file !== SELF)
			.flatMap(({ file, source }) => mints(source).map((spelling) => `${basename(file)}: ${spelling}`));
		expect(offenders, "minting a refusal belongs to core/src/refusals.ts; call a constructor").toEqual([]);
	});

	it("recognises each minting spelling when planted", () => {
		const planted = [
			"const r = text as Refusal;",
			"const r = <refusal.Refusal>text;",
			"const r = text satisfies Refusal;",
			"const r = text as ReturnType<typeof refusal.doubtNeedsReason>;",
		];
		for (const line of planted) expect(mints(parseSource("probe.ts", line).source), line).toHaveLength(1);
		expect(mints(parseSource("probe.ts", 'const note = "text as Refusal";').source)).toEqual([]);
	});

	it("catches a planted literal under each of the three shapes", () => {
		expect(inlineRefusals(`return { outcome: "refused", reason: "a doubt needs a reason" };`)).toHaveLength(1);
		expect(inlineRefusals("return { symbolId, refused: `nothing to doubt` };")).toHaveLength(1);
		expect(inlineRefusals(`return { ok: false, reason: 'cites none' };`)).toHaveLength(1);
		expect(inlineRefusals(`return { ok: false, reason: refusal.doubtNeedsReason() };`)).toHaveLength(0);
		expect(inlineRefusals(`return { outcome: "refused", reason: check.reason };`)).toHaveLength(0);
	});

	it("has the note ledger composing no refusal of its own", () => {
		const offenders = SWEPT.flatMap((file) => {
			const source = readSwept(file);
			if (source === null) return [];
			return inlineRefusals(source).map((hit) => `${file.split("/").pop()} ${hit}`);
		});
		expect(
			offenders,
			"a note refusal is a named constructor in core/src/refusals.ts; put its result in the reason slot rather than a sentence",
		).toEqual([]);
	});
});
