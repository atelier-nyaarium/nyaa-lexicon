import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { readSwept, sourceFiles } from "@nyaa-lexicon/protocol";
import { lineOf, type ParsedSource, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

////////////////////////////////
//  Constants

const CORE_SRC = join(import.meta.dirname, "..");
const SKIP = ["__tests__", "dist", "node_modules", ".tsbuild"];

////////////////////////////////
//  Functions

function evidenceViewAssertions(parsed: ParsedSource): ts.AsExpression[] {
	const found: ts.AsExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isAsExpression(node) &&
			ts.isTypeReferenceNode(node.type) &&
			ts.isIdentifier(node.type.typeName) &&
			node.type.typeName.text === "EvidenceView"
		)
			found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(parsed.source);
	return found;
}

function brandMints(parsed: ParsedSource): ts.PropertyAssignment[] {
	const found: ts.PropertyAssignment[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isPropertyAssignment(node) &&
			ts.isComputedPropertyName(node.name) &&
			ts.isIdentifier(node.name.expression) &&
			node.name.expression.text === "evidenceViewBrand"
		)
			found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(parsed.source);
	return found;
}

function mintOwner(node: ts.Node): string | undefined {
	for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
		if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name && ts.isIdentifier(at.name))
			return at.name.text;
	}
	return undefined;
}

function sourceAssertions(): Array<{ file: string; owner: string | undefined }> {
	return sourceFiles(CORE_SRC, SKIP).flatMap((file) => {
		const text = readSwept(file);
		if (text === null) return [];
		const parsed = parseSource(file, text);
		return evidenceViewAssertions(parsed).map((node) => ({
			file: basename(file),
			owner: mintOwner(node),
		}));
	});
}

////////////////////////////////
//  Tests

describe("EvidenceView minting", () => {
	it("mints the brand only in its owner function", () => {
		expect(sourceAssertions()).toEqual([]);
		const policyEvidence = sourceFiles(CORE_SRC, SKIP).find((file) => basename(file) === "policyEvidence.ts");
		if (policyEvidence === undefined) throw new Error("policyEvidence.ts was not found");
		const text = readSwept(policyEvidence);
		if (text === null) throw new Error("policyEvidence.ts was unreadable");
		const parsed = parseSource(policyEvidence, text);
		expect(brandMints(parsed).map(mintOwner)).toEqual(["makeEvidenceView"]);
	});

	it("finds a planted assertion outside the owner", () => {
		const planted = parseSource(join(CORE_SRC, "planted.ts"), "const view = {} as EvidenceView;");
		const assertions = evidenceViewAssertions(planted);
		expect(assertions).toHaveLength(1);
		expect(lineOf(planted, assertions[0]!)).toBe(1);
		expect(sourceAssertions().length).toBe(0);
	});
});
