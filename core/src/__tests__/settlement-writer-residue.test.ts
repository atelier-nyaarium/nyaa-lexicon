import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { lineOf, nodesIn, type ParsedSource, parseSource, stringsIn } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

////////////////////////////////
//  Helpers

/** Settlement ledger writes belong to drop and purgeImages. */
const CORE = join(import.meta.dirname, "..");

/** Ledger writer file and permitted method. */
const WRITERS = new Map([
	["transactions.ts", "drop"],
	["store.ts", "purgeImages"],
]);

const OWNER = "transactions.ts";

const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "fixtures"]);

const WRITE =
	/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+refactor_(?:settlements|settled_files)\b/i;

/** Ledger writes found in string literals. */
function writes(parsed: ParsedSource): ts.Node[] {
	const pieces = stringsIn(parsed.source);
	const explicit = pieces.filter(({ text }) => WRITE.test(text)).map(({ node }) => node);
	const registryDeletes = pieces
		.filter(
			({ node, text }) =>
				ts.isTemplateHead(node) &&
				/\bDELETE\s+FROM\s*$/i.test(text) &&
				ts.isTemplateExpression(node.parent) &&
				node.parent.templateSpans.length > 0 &&
				[...ancestors(node)].some(
					(method) =>
						ts.isMethodDeclaration(method) &&
						nodesIn(method).some((child) => ts.isIdentifier(child) && child.text === "JOURNAL_TABLE_NAMES"),
				),
		)
		.map(({ node }) => node);
	return [...explicit, ...registryDeletes];
}

function* ancestors(node: ts.Node): Generator<ts.Node> {
	for (let current = node.parent; current !== undefined; current = current.parent) yield current;
}

/** Checks whether a ledger write uses its permitted method. */
function inWriter(file: string, node: ts.Node): boolean {
	const writer = WRITERS.get(basename(file));
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text === writer;
	}
	return false;
}

function offenders(file: string, parsed: ParsedSource): string[] {
	return writes(parsed)
		.filter((node) => !inWriter(file, node))
		.map((node) => `${basename(file)}:${lineOf(parsed, node)}`);
}

////////////////////////////////
//  Tests

describe("only drop and purgeImages write the settlement ledger", () => {
	it("finds the writes in each writer, so a passing run is never vacuous", () => {
		for (const [name, writer] of WRITERS) {
			const file = join(CORE, name);
			const parsed = parseSource(file, readFileSync(file, "utf8"));
			expect(writes(parsed).filter((node) => inWriter(file, node)).length, writer).toBeGreaterThanOrEqual(
				name === OWNER ? 2 : 1,
			);
		}
	});

	it("writes it nowhere else in core", () => {
		const found = sourceFiles(CORE, SKIP_DIRS).flatMap((file) =>
			offenders(file, parseSource(file, readFileSync(file, "utf8"))),
		);

		expect(
			found,
			"a settlement is written by TransactionManager.drop, and a module's images purged by IndexStore.purgeImages",
		).toEqual([]);
	});

	it("recognises a planted write outside its writer, and not a read or a write elsewhere", () => {
		const planted = [
			'class T { close() { db.prepare("INSERT INTO refactor_settlements (seq) VALUES (1)"); } }',
			"class T { prune() { db.prepare(`DELETE FROM refactor_settled_files WHERE seq = ${seq}`); } }",
			"class T { prune() { for (const table of JOURNAL_TABLE_NAMES) db.prepare(`DELETE FROM ${table} WHERE seq = ${seq}`); } }",
			'class T { drop() { db.prepare("INSERT OR REPLACE INTO refactor_settled_files (seq) VALUES (1)"); } }',
			'class T { purgeImages() { db.prepare("DELETE FROM refactor_settled_files WHERE module = ?"); } }',
		];
		for (const source of planted)
			expect(offenders("planted.ts", parseSource("planted.ts", source)), source).toHaveLength(1);

		const clean: Array<[string, string]> = [
			[OWNER, 'class T { drop() { db.prepare("INSERT INTO refactor_settlements (seq) VALUES (1)"); } }'],
			[OWNER, 'class T { read() { db.prepare("SELECT seq FROM refactor_settlements"); } }'],
			[
				OWNER,
				'class T { prune() { db.prepare("DELETE FROM refactor_blobs WHERE hash NOT IN (SELECT opened FROM refactor_settled_files)"); } }',
			],
			[
				"store.ts",
				'class T { purgeImages() { db.prepare("DELETE FROM refactor_settled_files WHERE module = ?"); } }',
			],
			[
				"store.ts",
				"class T { purgeImages() { for (const table of JOURNAL_TABLE_NAMES) db.prepare(`DELETE FROM ${table} WHERE module = ?`); } }",
			],
			["store.ts", "class T { purgeImages() { db.prepare(`DELETE FROM ${table} WHERE module = ?`); } }"],
		];
		for (const [file, source] of clean) expect(offenders(file, parseSource(file, source)), source).toHaveLength(0);

		const wrongOwner = 'class T { drop() { db.prepare("DELETE FROM refactor_settled_files WHERE module = ?"); } }';
		expect(offenders("store.ts", parseSource("store.ts", wrongOwner))).toHaveLength(1);
	});
});
