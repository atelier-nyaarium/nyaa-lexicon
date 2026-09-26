import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { calleeOf, callsIn, lineOf, type ParsedSource, parseSource } from "../astResidue";
import { readSwept, sourceFiles } from "../residue";

/**
 * Holds `readWorkspaceFile` and `readWorkspaceHead` as the only callers of the raw reads below.
 * Bug class killed: opening a module by name follows a link out of the workspace and indexes it.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const OWNER = "protocol/src/sourceFile.ts";

const RAW_READS = ["readSourceFile", "firstLineOfFile"];

function packageSourceDirs(parent: string): string[] {
	return readdirSync(join(ROOT, parent), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(ROOT, parent, entry.name, "src"))
		.filter((dir) => existsSync(dir));
}

const SWEPT = [
	...["core/src", "client/src", "protocol/src", "formats/src"].map((dir) => join(ROOT, dir)),
	...packageSourceDirs("adapters"),
	...packageSourceDirs("providers"),
];

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp"]);

////////////////////////////////
//  Helpers

function identifiersNamed(parsed: ParsedSource, name: string): ts.Identifier[] {
	const found: ts.Identifier[] = [];
	const walk = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === name) found.push(node);
		ts.forEachChild(node, walk);
	};
	walk(parsed.source);
	return found;
}

function parsedOwner(): ParsedSource {
	const file = join(ROOT, OWNER);
	return parseSource(file, readSwept(file) as string);
}

////////////////////////////////
//  Tests

describe("one module reads a workspace file's raw bytes", () => {
	it("finds source files in every swept tree, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP_DIRS).length, dir).toBeGreaterThan(0);
	});

	it("declares each raw read unexported in the owner, and calls it exactly once", () => {
		const owner = parsedOwner();
		const shape = RAW_READS.map((name) => {
			const declaration = owner.source.statements.find(
				(statement): statement is ts.FunctionDeclaration =>
					ts.isFunctionDeclaration(statement) && statement.name?.text === name,
			);
			const exported = (declaration === undefined ? [] : (ts.getModifiers(declaration) ?? [])).some(
				(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
			);
			const calls = callsIn(owner.source).filter((call) => {
				const callee = calleeOf(call);
				return callee?.receiver === undefined && callee?.name === name;
			});
			return {
				name,
				declared: declaration !== undefined,
				exported,
				calls: calls.length,
				named: identifiersNamed(owner, name).length,
			};
		});

		expect(shape).toEqual(RAW_READS.map((name) => ({ name, declared: true, exported: false, calls: 1, named: 2 })));
	});

	it("names a raw read nowhere but the owner", () => {
		const offenders: string[] = [];
		for (const dir of SWEPT) {
			for (const file of sourceFiles(dir, SKIP_DIRS)) {
				const here = relative(ROOT, file).split("\\").join("/");
				if (here === OWNER) continue;
				const text = readSwept(file);
				if (text === null) continue;
				const parsed = parseSource(file, text);
				for (const name of RAW_READS) {
					for (const node of identifiersNamed(parsed, name))
						offenders.push(`${here}:${lineOf(parsed, node)} ${name}`);
				}
			}
		}

		expect(
			offenders,
			"read a module through readWorkspaceFile or readWorkspaceHead in protocol/src/sourceFile.ts, which refuse a real path outside the workspace",
		).toEqual([]);
	});
});
