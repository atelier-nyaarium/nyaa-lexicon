import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readSwept } from "@nyaa-lexicon/protocol";

/**
 * Only the three constructors mint a daemon handler, and the methods that take the gate in parts are
 * named here: the type cannot see a staged handler ignore its gate, so adding one is a reviewed edit.
 */
const DISPATCH = join(import.meta.dirname, "..", "dispatch.ts");

const CAST = /as Handler</g;

const MINT = /\bmint\(/g;

const STAGED_ENTRY = /^\t\t(\w+): staged\(/gm;

const TREE_ENTRY = /^\t\t(\w+): treeFirst\(/gm;

const UPGRADED_ENTRY = /^\t\t(\w+): upgradedRead\(/gm;

/** Reads under the gate, writes under it, or steps the work itself. */
const STAGED = ["recallAnswer", "refactorReplace", "refactorInsert", "refactorRename", "refactorMove"];

/** A tree upgrade alone, then the answer shared. */
const TREE_FIRST = ["describe", "typeHierarchy", "callHierarchy", "findReferences", "factsFor", "typeOf"];

/** The background upgrade ungated, then the answer shared. */
const UPGRADED = ["prepareRename", "renameEdits", "planMove"];

function names(source: string, pattern: RegExp): string[] {
	return [...source.matchAll(pattern)].map((match) => match[1] as string).sort();
}

////////////////////////////////
//  Tests

describe("one place mints a daemon handler", () => {
	it("fires on the spellings it counts", () => {
		expect("return { effect, run } as Handler<M>;".match(CAST)).toHaveLength(1);
		expect('=> mint("read", run);'.match(MINT)).toHaveLength(1);
		expect(names("\t\trecallAnswer: staged(async (params, gate) => {", STAGED_ENTRY)).toEqual(["recallAnswer"]);
		expect(names("\t\tdescribe: treeFirst(", TREE_ENTRY)).toEqual(["describe"]);
		expect(names("\t\tplanMove: upgradedRead((params) =>", UPGRADED_ENTRY)).toEqual(["planMove"]);
	});

	it("casts to the handler brand once and calls mint three times, one per effect", () => {
		const source = readSwept(DISPATCH) as string;
		expect(source).not.toBeNull();
		expect(source.match(CAST) ?? []).toHaveLength(1);
		expect(source.match(MINT) ?? []).toHaveLength(3);
	});

	it("names every method that takes the gate in parts", () => {
		const source = readSwept(DISPATCH) as string;
		expect(names(source, STAGED_ENTRY)).toEqual([...STAGED].sort());
		expect(names(source, TREE_ENTRY)).toEqual([...TREE_FIRST].sort());
		expect(names(source, UPGRADED_ENTRY)).toEqual([...UPGRADED].sort());
	});
});
