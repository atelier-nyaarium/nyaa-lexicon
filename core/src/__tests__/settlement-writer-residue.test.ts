import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { lineOf, type ParsedSource, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

////////////////////////////////
//  Helpers

/** Constrains ledger writes to transactions.ts drop. */
const CORE = join(import.meta.dirname, "..");

const OWNER = "transactions.ts";

const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "fixtures"]);

const WRITE =
	/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+refactor_(?:settlements|settled_files)\b/i;

function writes(parsed: ParsedSource): ts.Node[] {
	const found: ts.Node[] = [];
	const walk = (node: ts.Node): void => {
		const literal =
			ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
		if (literal && WRITE.test(node.getText(parsed.source))) found.push(node);
		else ts.forEachChild(node, walk);
	};
	walk(parsed.source);
	return found;
}

function inDrop(node: ts.Node): boolean {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text === "drop";
	}
	return false;
}

function offenders(file: string, parsed: ParsedSource): string[] {
	return writes(parsed)
		.filter((node) => basename(file) !== OWNER || !inDrop(node))
		.map((node) => `${basename(file)}:${lineOf(parsed, node)}`);
}

////////////////////////////////
//  Tests

describe("only drop writes the settlement ledger", () => {
	it("finds the writes in drop, so a passing run is never vacuous", () => {
		const owner = join(CORE, OWNER);
		const parsed = parseSource(owner, readFileSync(owner, "utf8"));
		expect(writes(parsed).filter(inDrop).length).toBeGreaterThanOrEqual(2);
	});

	it("writes it nowhere else in core", () => {
		const found = sourceFiles(CORE, SKIP_DIRS).flatMap((file) =>
			offenders(file, parseSource(file, readFileSync(file, "utf8"))),
		);

		expect(found, "a settlement is written by TransactionManager.drop alone").toEqual([]);
	});

	it("recognises a planted write outside drop, and not a read or a write elsewhere", () => {
		const planted = [
			'class T { close() { db.prepare("INSERT INTO refactor_settlements (seq) VALUES (1)"); } }',
			"class T { prune() { db.prepare(`DELETE FROM refactor_settled_files WHERE seq = ${seq}`); } }",
			'class T { drop() { db.prepare("INSERT OR REPLACE INTO refactor_settled_files (seq) VALUES (1)"); } }',
		];
		for (const source of planted)
			expect(offenders("store.ts", parseSource("store.ts", source)), source).toHaveLength(1);

		const clean = [
			'class T { drop() { db.prepare("INSERT INTO refactor_settlements (seq) VALUES (1)"); } }',
			'class T { read() { db.prepare("SELECT seq FROM refactor_settlements"); } }',
			'class T { prune() { db.prepare("DELETE FROM refactor_blobs WHERE hash NOT IN (SELECT opened FROM refactor_settled_files)"); } }',
		];
		for (const source of clean) expect(offenders(OWNER, parseSource(OWNER, source)), source).toHaveLength(0);
	});
});
