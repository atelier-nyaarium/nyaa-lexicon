import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { lineOf, nodesIn, type ParsedSource, parseSource } from "../astResidue";
import { readSwept, sourceFiles } from "../residue";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PROVIDERS = join(ROOT, "providers");
const SOURCE_ROOTS = [PROVIDERS, join(ROOT, "core"), join(ROOT, "protocol")];
const OWNER = join(ROOT, "protocol", "src", "serve.ts");
const SKIP = ["__tests__", "__fixtures__", "fixtures", "dist", "node_modules", ".tsbuild"];

function productionFiles(roots = SOURCE_ROOTS): string[] {
	return roots.flatMap((root) => sourceFiles(root, SKIP)).sort();
}

function swept(roots = SOURCE_ROOTS): ParsedSource[] {
	return productionFiles(roots).flatMap((file) => {
		const text = readSwept(file);
		return text === null ? [] : [parseSource(file, text)];
	});
}

function propertyName(name: ts.PropertyName): string | undefined {
	return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function unwrapped(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function hasStringProperty(node: ts.ObjectLiteralExpression, name: string, value: string): boolean {
	return node.properties.some((property) => {
		if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== name) return false;
		const initializer = unwrapped(property.initializer);
		return ts.isStringLiteralLike(initializer) && initializer.text === value;
	});
}

function copies(parsed: ParsedSource): ts.ObjectLiteralExpression[] {
	return nodesIn(parsed.source).filter(
		(node): node is ts.ObjectLiteralExpression =>
			ts.isObjectLiteralExpression(node) &&
			hasStringProperty(node, "status", "refused") &&
			hasStringProperty(node, "reason", "NotImplemented") &&
			node.properties.some(
				(property) =>
					(ts.isPropertyAssignment(property) && propertyName(property.name) === "detail") ||
					(ts.isShorthandPropertyAssignment(property) && property.name.text === "detail"),
			),
	);
}

function refusalLocations(files: ParsedSource[]): string[] {
	return files.flatMap((parsed) =>
		parsed.file === OWNER
			? []
			: copies(parsed).map((node) => `${relative(ROOT, parsed.file)}:${lineOf(parsed, node)}`),
	);
}

describe("production source coverage for unimplemented edit refusals", () => {
	const paths = productionFiles();
	const files = swept();

	it("sweeps every production source and finds the owner's constructors", () => {
		const checked = new Set(files.map((parsed) => parsed.file));
		for (const root of SOURCE_ROOTS) expect(productionFiles([root]).length).toBeGreaterThan(0);
		expect([...checked].sort()).toEqual(paths);
		const owner = readSwept(OWNER);
		expect(owner).not.toBeNull();
		expect(copies(parseSource(OWNER, owner ?? ""))).toHaveLength(3);
	});

	it("catches a planted refusal in a non-entrypoint source", () => {
		const root = mkdtempSync(join(tmpdir(), "lexicon-source-residue-"));
		const planted = join(root, "probe", "src", "other.ts");
		try {
			mkdirSync(dirname(planted), { recursive: true });
			writeFileSync(
				planted,
				'const answer = { status: "refused", reason: "NotImplemented", detail: "unavailable" };',
			);
			const discovered = swept([root]);

			expect(discovered.map((parsed) => relative(root, parsed.file))).toEqual(["probe/src/other.ts"]);
			expect(refusalLocations(discovered)).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("catches a refusal copied with assertion wrappers", () => {
		const root = mkdtempSync(join(tmpdir(), "lexicon-source-residue-"));
		const planted = join(root, "probe", "src", "other.ts");
		try {
			mkdirSync(dirname(planted), { recursive: true });
			writeFileSync(
				planted,
				`const answer = {
					status: ("refused" as const),
					reason: (("NotImplemented") satisfies string),
					detail: <string>("unavailable"),
				} as const;`,
			);
			expect(refusalLocations(swept([root]))).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("negative control ignores a refusal with another reason", () => {
		const root = mkdtempSync(join(tmpdir(), "lexicon-source-residue-"));
		const planted = join(root, "probe", "src", "other.ts");
		try {
			mkdirSync(dirname(planted), { recursive: true });
			writeFileSync(planted, 'const answer = { status: "refused", reason: "InvalidName", detail: "invalid" };');
			expect(refusalLocations(swept([root]))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("finds no copied refusal", () => {
		expect(refusalLocations(files)).toEqual([]);
	});
});
