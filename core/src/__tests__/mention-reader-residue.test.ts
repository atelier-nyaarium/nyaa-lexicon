import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { memberCalls, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/** Read uses via `uses*`. */
const REPOSITORY = join(import.meta.dirname, "..", "..", "..");

const ROOTS = [join(REPOSITORY, "core", "src"), join(REPOSITORY, "adapters")];

const RAW = ["referencesTo", "referencesIn", "referencesFrom"];

const MENTION_READERS: Record<string, { count: number; reason: string }> = {
	ArrangePlanner: { count: 2, reason: "re-points every importer and qualified use" },
	MovePlanner: { count: 4, reason: "reads moved references and checks post-index landings" },
	PaintReads: { count: 2, reason: "painting and the cursor see every reference span" },
	ReadContext: { count: 2, reason: "stamps each answered row's module" },
	RefactorPlanner: { count: 2, reason: "compares candidate references after replacement" },
	RenameCollisionPlanner: { count: 1, reason: "checks uses inside the renamed declaration's scope" },
	RenamePlanner: { count: 2, reason: "maps the renamed symbol's uses" },
	RouteResolver: { count: 4, reason: "rewrites every proven route" },
	IndexStore: { count: 2, reason: "facade delegates reference queries to StoreFactQueries" },
	proveRename: { count: 1, reason: "compares all uses in each candidate module" },
	usesMoved: { count: 1, reason: "checks uses that leave their declaration's scope" },
};

const rawReads = (root: ts.Node): number => memberCalls(root, RAW).length;

const probe = (code: string): number => rawReads(parseSource("probe.ts", code).source);

function readerName(node: ts.Node): string {
	let functionName: string | undefined;
	for (let at = node.parent; at !== undefined; at = at.parent) {
		if (ts.isClassDeclaration(at) && at.name) return at.name.text;
		if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name && functionName === undefined) {
			functionName = at.name.getText();
		}
	}
	return functionName ?? "module";
}

////////////////////////////////
//  Tests

describe("uses are read through the store's use surfaces", () => {
	it("fires on the spellings it forbids", () => {
		expect(probe("this.store.referencesTo(symbolId).filter(isUse)")).toBe(1);
		expect(probe("store.referencesIn (module)")).toBe(1);
		expect(probe("store\n\t.referencesFrom(id)")).toBe(1);
		expect(probe("this.store.usesTo(symbolId)")).toBe(0);
		expect(probe("class S { referencesTo(symbolId: string): StoredReference[] { return []; } }")).toBe(0);
	});

	it("reads raw rows only where mentions are the point", () => {
		const files = ROOTS.flatMap((root) => parsedFiles(root, ["__tests__", "node_modules", ".tsbuild"]));
		expect(files.length).toBeGreaterThan(50);

		const readers: Record<string, number> = {};
		for (const { source } of files) {
			for (const { node } of memberCalls(source, RAW)) {
				const owner = readerName(node);
				readers[owner] = (readers[owner] ?? 0) + 1;
			}
		}
		const expected = Object.fromEntries(
			Object.entries(MENTION_READERS).map(([name, reader]) => [name, reader.count]),
		);
		expect(readers).toEqual(expected);
	});
});
