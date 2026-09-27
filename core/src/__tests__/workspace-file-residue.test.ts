import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { calleeOf, callsIn, dottedName, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/**
 * A module reaches the disk through `workspaceFile` (protocol) and its core wrapper alone, which
 * refuse a path that leaves the root. A bare join of the root and a module is the hole a
 * `../secret` module walks through, so the join itself is forbidden here.
 */
const CORE = join(import.meta.dirname, "..");

/** The wrapper that turns a refusal into a read outcome or a named error. */
const OWNER = "sourceRead.ts";

const SKIP = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "tmp"]);

const JOINS = new Set(["join", "resolve"]);

const ROOTS = new Set(["root", "workspaceRoot", "this.root", "this.workspaceRoot"]);

/** The root joined with a module, whichever object holds either and however the join is reached. */
function bareJoins(root: ts.Node): ts.CallExpression[] {
	return callsIn(root).filter((call) => {
		const [first, second] = call.arguments;
		if (!JOINS.has(calleeOf(call)?.name ?? "") || first === undefined || second === undefined) return false;
		if (!ROOTS.has(dottedName(first) ?? "")) return false;
		if (ts.isIdentifier(second)) return second.text === "module";
		return (
			ts.isPropertyAccessExpression(second) && ts.isIdentifier(second.expression) && second.name.text === "module"
		);
	});
}

////////////////////////////////
//  Tests

describe("no module reaches the disk by a bare join", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(sourceFiles(CORE, SKIP).length).toBeGreaterThan(20);
	});

	it("fires on each spelling of the join", () => {
		for (const code of [
			"join(root, module)",
			"path.resolve(this.workspaceRoot, request.module)",
			'path["join"](workspaceRoot, module)',
		])
			expect(bareJoins(parseSource("probe.ts", code).source), code).toHaveLength(1);
		expect(bareJoins(parseSource("probe.ts", "join(root, moduleName)").source)).toEqual([]);
	});

	it("joins a module onto the root only inside the owner", () => {
		const offenders = parsedFiles(CORE, SKIP)
			.filter(({ file, source }) => basename(file) !== OWNER && bareJoins(source).length > 0)
			.map(({ file }) => basename(file));

		expect(
			offenders,
			"use insideWorkspace from sourceRead.ts, which refuses a module that leaves the root",
		).toEqual([]);
	});
});
