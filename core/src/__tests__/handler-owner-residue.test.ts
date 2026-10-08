import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readSwept } from "@nyaa-lexicon/protocol";
import { callsTo, nodesIn, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";
import { TREE_FIRST } from "./dispatchTiers";

/**
 * Only the four constructors mint a daemon handler, and the methods that take the gate in parts or not
 * at all are named here: the type cannot see a staged handler ignore its gate, or a status handler
 * reach a write, so adding one is a reviewed edit.
 */
const DISPATCH = join(import.meta.dirname, "..", "dispatch.ts");

/** Reads under the gate, writes under it, or steps the work itself. */
const STAGED = [
	"refactorReplace",
	"refactorReplaceSpan",
	"refactorInsert",
	"refactorRename",
	"refactorMove",
	"refactorArrange",
	"refactorRenameCommitted",
	"refactorMoveCommitted",
	"refactorStepOutcome",
	"refactorStepCancel",
];

/** The background upgrade ungated, then the answer shared. */
const UPGRADED = [
	"prepareRename",
	"renameEdits",
	"planMove",
	"previewMove",
	"previewArrange",
	"previewInsert",
	"previewReplace",
];

/** History read ungated, then the answer shared. */
const HISTORY_FIRST = ["relationsOf", "relationsBetween", "relationCandidates", "relationGaps"];

/** Answered with no gate, so no batch or step holding it delays them. */
const STATUS = ["indexStatus", "indexWorkspace", "cacheStats", "refactorStatus", "refactorSettlements"];

function parsed(code: string): ts.SourceFile {
	return parseSource("probe.ts", code).source;
}

/** `as Handler<...>` casts. */
function casts(root: ts.Node): ts.Node[] {
	return nodesIn(root).filter(
		(node) =>
			ts.isAsExpression(node) &&
			ts.isTypeReferenceNode(node.type) &&
			ts.isIdentifier(node.type.typeName) &&
			node.type.typeName.text === "Handler",
	);
}

/** Handler-table entries built by one builder: `name: builder(...)`. */
function entries(root: ts.Node, builder: string): string[] {
	return nodesIn(root)
		.filter(
			(node): node is ts.PropertyAssignment =>
				ts.isPropertyAssignment(node) &&
				ts.isCallExpression(node.initializer) &&
				ts.isIdentifier(node.initializer.expression) &&
				node.initializer.expression.text === builder,
		)
		.map((node) => (ts.isIdentifier(node.name) ? node.name.text : ""))
		.sort();
}

////////////////////////////////
//  Tests

describe("one place mints a daemon handler", () => {
	it("fires on the spellings it counts", () => {
		expect(casts(parsed("function f() { return { effect, run } as Handler<M>; }"))).toHaveLength(1);
		expect(callsTo(parsed('const h = () => mint("read", run);'), "mint")).toHaveLength(1);
		expect(entries(parsed("const t = { refactorMove: staged(async (params, gate) => {}) };"), "staged")).toEqual([
			"refactorMove",
		]);
		expect(entries(parsed("const t = { describe: treeFirst(run) };"), "treeFirst")).toEqual(["describe"]);
		expect(entries(parsed("const t = { planMove: upgradedRead((params) => 1) };"), "upgradedRead")).toEqual([
			"planMove",
		]);
	});

	it("casts to the handler brand once and calls mint four times, one per effect", () => {
		const text = readSwept(DISPATCH);
		expect(text).not.toBeNull();
		const source = parsed(text as string);
		expect(casts(source)).toHaveLength(1);
		expect(callsTo(source, "mint")).toHaveLength(4);
	});

	it("names every method that takes the gate in parts or not at all", () => {
		const source = parsed(readSwept(DISPATCH) as string);
		expect(entries(source, "staged")).toEqual([...STAGED].sort());
		expect(entries(source, "treeFirst")).toEqual([...TREE_FIRST].sort());
		expect(entries(source, "upgradedRead")).toEqual([...UPGRADED].sort());
		expect(entries(source, "historyFirst")).toEqual([...HISTORY_FIRST].sort());
		expect(entries(source, "status")).toEqual([...STATUS].sort());
	});
});
