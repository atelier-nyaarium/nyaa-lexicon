import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { readSwept } from "@nyaa-lexicon/protocol";
import { memberReads, nodesIn, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/** A syntax node carries syntax; a derived fact lives in `environment.ts`, keyed by the node. */
const SRC = join(import.meta.dirname, "..");

/** What the grammar reports. Anything else is derived. */
const STRUCTURAL = ["children", "end", "field", "missing", "named", "parent", "start", "type"];

const SKIP = ["__tests__", ".tsbuild", "dist", "node_modules"];

/** A cast to a type this wide lets anything onto a node. */
const WIDE_CASTS = new Set([ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.UnknownKeyword]);

/** Writes that reach past a node's static type. */
const REFLECTIVE = [
	["Object", "assign"],
	["Object", "defineProperty"],
	["Reflect", "set"],
];

/**
 * Widening a node's static type, or reopening its interface, is the way past `tsc`.
 *
 * No provider source spells any of these today, so none carries an allowlist entry.
 */
function bypasses(source: ts.SourceFile): string[] {
	const found = nodesIn(source).flatMap((node) => {
		if (ts.isModuleDeclaration(node)) return ["declare module"];
		if (!ts.isAsExpression(node)) return [];
		if (WIDE_CASTS.has(node.type.kind)) return [`as ${ts.tokenToString(node.type.kind)}`];
		const record =
			ts.isTypeReferenceNode(node.type) &&
			ts.isIdentifier(node.type.typeName) &&
			node.type.typeName.text === "Record";
		return record ? ["as Record<>"] : [];
	});
	for (const { receiver, name } of memberReads(source)) {
		if (REFLECTIVE.some(([owner, member]) => owner === receiver && member === name))
			found.push(`${receiver}.${name}`);
	}
	return found;
}

/** The members an interface declares, by name. */
function interfaceMembers(source: ts.SourceFile, name: string): string[] | null {
	const declared = source.statements.find(
		(statement): statement is ts.InterfaceDeclaration =>
			ts.isInterfaceDeclaration(statement) && statement.name.text === name,
	);
	return declared === undefined ? null : declared.members.map((member) => member.name?.getText(source) ?? "");
}

////////////////////////////////
//  Tests

describe("a syntax node carries syntax, never a derived fact", () => {
	it("declares only what the grammar reports on SyntaxNode", () => {
		const text = readSwept(join(SRC, "tree.ts"));
		expect(text, "tree.ts is the home of SyntaxNode and the sweep must read it").not.toBeNull();
		const members = interfaceMembers(parseSource("tree.ts", text as string).source, "SyntaxNode");
		expect(members, "SyntaxNode was not found in tree.ts, so this test checked nothing").not.toBeNull();
		expect(
			[...(members as string[])].sort(),
			"a fact about a node belongs in environment.ts, keyed by the node, never on the node",
		).toEqual(STRUCTURAL);
	});

	it("fires on each bypass", () => {
		for (const code of [
			'declare module "./tree" { interface SyntaxNode { x: 1 } }',
			"const a = node as any;",
			"const a = node as unknown;",
			"const a = node as Record<string, 1>;",
			"Object.assign(node, {});",
			"Reflect.set(node, 'x', 1);",
		])
			expect(bypasses(parseSource("probe.ts", code).source), code).toHaveLength(1);
		expect(bypasses(parseSource("probe.ts", '// as any\nconst a = "Object.assign";').source)).toEqual([]);
	});

	it("never widens a node's type or reopens its interface", () => {
		const read = parsedFiles(SRC, SKIP);
		expect(read.length, "the sweep found no provider source, so it checked nothing").toBeGreaterThanOrEqual(8);
		const offenders = read.flatMap(({ file, source }) =>
			bypasses(source).map((bypass) => `${basename(file)}: ${bypass}`),
		);
		expect(offenders, "a widened or reopened node lets a derived fact back onto the tree").toEqual([]);
	});
});
