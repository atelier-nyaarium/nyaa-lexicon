import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readSwept, sourceFiles } from "@nyaa-lexicon/protocol";
import {
	calling,
	exportsNamed,
	importing,
	naming,
	nodesIn,
	parseSource,
	reachesIn,
	readingStore,
	usesName,
} from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/**
 * Holds RefactorPlanner to planning.
 *
 * A plan must be safe to ask for, and one that also acted looks exactly like one that did not.
 */
const CORE_SRC = join(import.meta.dirname, "..");
const SKIP = new Set(["__tests__", "dist", "node_modules", ".tsbuild"]);
const PLANNER_HELPERS = new Set(["workspaceModule", "isDangling"]);

const FORBIDDEN = [
	importing("./supervisor.js", "providers are reached through ProviderProbe"),
	importing("./sourceWriter.js", "planning does not write source"),
	naming(
		["readSource", "sourceReader", "textOf", "fromText"],
		"a module a plan writes is read through SourceWorkspace.writable",
	),
	calling("writeAll", "planning does not write source"),
	calling("writeModule", "planning does not write source"),
	calling("indexFile", "planning does not reindex"),
	readingStore(["replaceFile", "forgetFile"], "the indexer owns what the index holds"),
	importing("./indexer.js", "planning must not be able to start a scan"),
	importing("./service.js", "the planner is upstream of the service"),
	// `renameSymbol` belongs to the caller; the planner neither declares nor calls it.
	naming(["renameSymbol"], "leaves carrying a rename out to the caller"),
];

function plannerModules(): Array<{ source: ts.SourceFile; classes: string[]; helpers: string[] }> {
	return sourceFiles(CORE_SRC, SKIP).flatMap((file) => {
		const text = readSwept(file);
		if (text === null) return [];
		const source = parseSource(file, text).source;
		const classes = nodesIn(source).flatMap((node) =>
			ts.isClassDeclaration(node) && node.name?.text.endsWith("Planner") === true ? [node.name.text] : [],
		);
		const helpers = nodesIn(source).flatMap((node) =>
			(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
			node.name &&
			ts.isIdentifier(node.name) &&
			PLANNER_HELPERS.has(node.name.text)
				? [node.name.text]
				: [],
		);
		return classes.length === 0 && helpers.length === 0 ? [] : [{ source, classes, helpers }];
	});
}

////////////////////////////////
//  Tests

describe("the refactor planner plans and does not act", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		const modules = plannerModules();
		const classes = modules.flatMap((module) => module.classes);
		const helpers = modules.flatMap((module) => module.helpers);
		const facade = modules.find((module) => module.classes.includes("RefactorPlanner"));
		expect(classes).toEqual(
			expect.arrayContaining([
				"ArrangePlanner",
				"InsertPlanner",
				"MovePlanner",
				"RefactorPlanner",
				"RenameCollisionPlanner",
				"RenamePlanner",
				"ReplacementPlanner",
			]),
		);
		expect(helpers).toEqual(expect.arrayContaining(["workspaceModule", "isDangling"]));
		expect(facade !== undefined && exportsNamed(facade.source, "RefactorPlanner")).toBe(true);
		expect(facade !== undefined && usesName(facade.source, "planReplacement")).toBe(true);
		expect(modules.reduce((total, module) => total + module.source.text.length, 0)).toBeGreaterThan(20_000);
	});

	it("writes nothing, reindexes nothing, holds no supervisor and carries out no rename", () => {
		const offenders = plannerModules().flatMap(({ source }) => reachesIn(source, FORBIDDEN));
		expect(offenders, "asking for a plan must never be the thing that changes the workspace").toEqual([]);
	});
});
