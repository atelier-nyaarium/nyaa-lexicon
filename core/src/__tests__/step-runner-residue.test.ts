import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { nodesIn, parsedFiles } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/**
 * Holds the daemon's method table as the only importer of the refactor step runners.
 *
 * A step runner takes the gate its caller hands it. The table hands each the service's gate through
 * a staged handler; any other caller could hand one that gates nothing.
 */
const PACKAGES = ["client", "core", "adapters", "protocol", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

/** The one importer. */
const OWNER = "dispatch.ts";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

/** The runners that write. */
const RUNNERS = new Set(["refactorMove", "refactorRename", "refactorReplace", "refactorInsert"]);

////////////////////////////////
//  Functions & Helpers

/** Runner names a file imports from the step runners module. */
function runnersImported(source: ts.SourceFile): string[] {
	return nodesIn(source)
		.filter(
			(node): node is ts.ImportDeclaration =>
				ts.isImportDeclaration(node) &&
				ts.isStringLiteral(node.moduleSpecifier) &&
				/^\.{1,2}\/(?:.*\/)?stepRunners(?:\.js)?$/.test(node.moduleSpecifier.text),
		)
		.flatMap((node) => {
			const bindings = node.importClause?.namedBindings;
			if (bindings === undefined || !ts.isNamedImports(bindings)) return [];
			return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
		})
		.filter((name) => RUNNERS.has(name));
}

////////////////////////////////
//  Tests

describe("only the method table imports a refactor step runner", () => {
	const files = PACKAGES.flatMap((dir) => parsedFiles(dir, SKIP_DIRS));

	it("finds the owner importing every runner, so a passing run is never vacuous", () => {
		const owner = files.find(({ file }) => file.endsWith(join("core", "src", OWNER)));
		expect(owner).toBeDefined();
		expect(new Set(runnersImported(owner?.source as ts.SourceFile))).toEqual(RUNNERS);
	});

	it("has nobody in production but the method table importing a runner", () => {
		const offenders = files
			.filter(({ file }) => !file.endsWith(join("core", "src", OWNER)) && !file.includes("__tests__"))
			.flatMap(({ file, source }) => runnersImported(source).map((name) => `${basename(file)}: ${name}`));

		expect(
			offenders,
			"a step runner belongs to core/src/dispatch.ts, whose staged handler hands it the service's gate.",
		).toEqual([]);
	});

	it("catches a planted importer", () => {
		const planted = ts.createSourceFile(
			"planted.ts",
			`import { refactorMove as move } from "./stepRunners.js";`,
			ts.ScriptTarget.Latest,
			true,
		);
		expect(runnersImported(planted)).toEqual(["refactorMove"]);
	});
});
