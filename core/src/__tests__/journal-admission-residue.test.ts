import { describe, expect, it } from "bun:test";
import { basename, join, relative } from "node:path";
import { calleeOf, parsedFiles, stringsIn } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";
import { JOURNAL_TABLES, type JournalTable } from "../journalSchema.js";

////////////////////////////////
//  Constants

const CORE = join(import.meta.dirname, "..");
const SKIP = ["__tests__", "dist", "node_modules", ".tsbuild"];
const JOURNAL = "transactions.ts";
const STORE = "store.ts";
const POLICY_METHODS = new Set(["admitBytes", "confirm", "confirmHeld", "revision"]);
const JUDGMENT_CALLS = new Set(["hashBytes", "readSource", "answer", "assess"]);
const READ_LEAF = "readLeaf";
const JOURNAL_WRITES =
	/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+refactor_(?:blobs|admissions)\b/i;

////////////////////////////////
//  Functions

function isPolicyRoot(node: ts.Node): boolean {
	return (
		ts.isPropertyAccessExpression(node) &&
		node.expression.kind === ts.SyntaxKind.ThisKeyword &&
		node.name.text === "policy"
	);
}

function policyPath(node: ts.Node): string[] | null {
	if (isPolicyRoot(node)) return [];
	if (!ts.isPropertyAccessExpression(node)) return null;
	const base = policyPath(node.expression);
	return base === null ? null : [...base, node.name.text];
}

function policyAccessOffenders(source: ts.SourceFile): string[] {
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isPropertyAccessExpression(node)) {
			const path = policyPath(node);
			const parent = node.parent;
			if (
				path !== null &&
				path.length > 0 &&
				!(ts.isPropertyAccessExpression(parent) && parent.expression === node) &&
				!(path.length === 1 && POLICY_METHODS.has(path[0] ?? ""))
			)
				found.push(path.join("."));
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function callName(call: ts.CallExpression): string | undefined {
	return calleeOf(call)?.name;
}

function enclosingMethod(node: ts.Node): string | undefined {
	for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
		if (ts.isMethodDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
	}
	return undefined;
}

function readLeafOffenders(source: ts.SourceFile): string[] {
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && callName(node) === READ_LEAF && enclosingMethod(node) !== "look") {
			found.push(READ_LEAF);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function journalWrites(source: ts.SourceFile): string[] {
	return stringsIn(source)
		.filter(({ text }) => JOURNAL_WRITES.test(text))
		.map(({ text }) => text);
}

function hashColumnNames(ddl: string): string[] {
	return [...ddl.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s+(?:TEXT|INTEGER|BLOB)\b/g)].map((match) => match[1] ?? "");
}

function unregisteredHashColumns(tables: Record<string, JournalTable>): string[] {
	const ownedHashes = new Set(["refactor_admissions.hash", "refactor_blobs.hash"]);
	return Object.entries(tables).flatMap(([table, entry]) => {
		const registered = new Set(entry.hashes?.columns ?? []);
		return hashColumnNames(entry.ddl)
			.filter((column) => /hash/i.test(column))
			.filter((column) => !ownedHashes.has(`${table}.${column}`))
			.filter((column) => !registered.has(column))
			.map((column) => `${table}.${column}`);
	});
}

////////////////////////////////
//  Tests

describe("journal admits only policy-judged bytes", () => {
	const swept = parsedFiles(CORE, SKIP);
	const journal = swept.find(({ file }) => basename(file) === JOURNAL);

	it("sweeps the core sources and finds the journal", () => {
		expect(swept.length).toBeGreaterThan(50);
		expect(journal).toBeDefined();
	});

	it("limits journal policy access to admission methods", () => {
		if (journal === undefined) throw new Error("journal source missing");
		expect(policyAccessOffenders(journal.source)).toEqual([]);
		const directJudge = ts.createSourceFile(
			"planted.ts",
			"class T { check() { this.policy.current.answer('src/a.ts'); } }",
			ts.ScriptTarget.Latest,
			true,
		);
		expect(policyAccessOffenders(directJudge)).toEqual(["current.answer"]);
		const rawHash = ts.createSourceFile(
			"planted.ts",
			"class T { check(bytes: Uint8Array) { hashBytes(bytes); } }",
			ts.ScriptTarget.Latest,
			true,
		);
		expect(
			journal.source.statements.flatMap((statement) => {
				const found: string[] = [];
				const visit = (node: ts.Node): void => {
					if (ts.isCallExpression(node) && JUDGMENT_CALLS.has(callName(node) ?? ""))
						found.push(callName(node) ?? "");
					ts.forEachChild(node, visit);
				};
				visit(statement);
				return found;
			}),
		).toEqual([]);
		const plantedCalls: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && JUDGMENT_CALLS.has(callName(node) ?? ""))
				plantedCalls.push(callName(node) ?? "");
			ts.forEachChild(node, visit);
		};
		visit(rawHash);
		expect(plantedCalls).toEqual(["hashBytes"]);
	});

	it("reads disk bytes only through look", () => {
		if (journal === undefined) throw new Error("journal source missing");
		expect(readLeafOffenders(journal.source)).toEqual([]);
		const planted = ts.createSourceFile(
			"planted.ts",
			"class T { look() { readLeaf('a'); } check() { readLeaf('b'); } }",
			ts.ScriptTarget.Latest,
			true,
		);
		expect(readLeafOffenders(planted)).toEqual([READ_LEAF]);
	});

	it("keeps journal admission SQL in the store", () => {
		const writes = swept.flatMap(({ file, source }) =>
			journalWrites(source).map((text) => ({ file: relative(CORE, file), text })),
		);
		expect(writes.some(({ file, text }) => file === STORE && /refactor_admissions/i.test(text))).toBe(true);
		expect(writes.some(({ file, text }) => file === STORE && /refactor_blobs/i.test(text))).toBe(true);
		expect(writes.filter(({ file }) => file !== STORE)).toEqual([]);
		const planted = ts.createSourceFile(
			"planted.ts",
			"class T { write() { db.prepare('INSERT INTO refactor_admissions (module) VALUES (?)'); } }",
			ts.ScriptTarget.Latest,
			true,
		);
		expect(journalWrites(planted)).toHaveLength(1);
	});

	it("registers every hash column and JSON image reference", () => {
		const schema = swept.find(({ file }) => basename(file) === "journalSchema.ts");
		expect(schema).toBeDefined();
		expect(unregisteredHashColumns(JOURNAL_TABLES)).toEqual([]);
		expect(JOURNAL_TABLES.refactor_client_steps.jsonHashes?.some(({ column }) => column === "answer")).toBe(true);
		expect(JOURNAL_TABLES.refactor_recovery_intents.jsonHashes?.some(({ column }) => column === "diskStates")).toBe(
			true,
		);

		const planted = {
			unregistered: {
				ddl: "CREATE TABLE unregistered (imageHash TEXT)",
				salvage: false,
				revision: false,
			},
		} satisfies Record<string, JournalTable>;
		expect(unregisteredHashColumns(planted)).toEqual(["unregistered.imageHash"]);
	});
});
