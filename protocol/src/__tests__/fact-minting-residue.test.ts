import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseSource, reachedCalls } from "../astResidue";
import { codeOnly, readSwept, sourceFiles } from "../residue";

/** The store owns fact-id minting. */
const REPO = join(import.meta.dirname, "..", "..", "..");

const ROOTS = ["protocol", "client", "core", "adapters", "providers"].map((dir) => join(REPO, dir));

/** Match exact owner paths. */
const OWNERS = new Set(["protocol/src/factId.ts", "core/src/store.ts"].map((file) => join(REPO, file)));

const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "tmp"]);

const BUILDERS = new Set(
	["declaration", "reference", "import", "literal", "comment", "doc"].map((kind) => `${kind}FactId`),
);

/** Builder modules by import path. */
const BUILDER_MODULES = new Set(["@nyaa-lexicon/protocol", "./factId.js", "./factId", "../factId.js", "../factId"]);

const MINT = /\b(declaration|reference|import|literal|comment|doc)FactId\(/;

const swept = () => ROOTS.flatMap((root) => sourceFiles(root, SKIP_DIRS)).filter((file) => !OWNERS.has(file));

/** Finds direct, aliased, and namespace calls. */
function mints(file: string, text: string): boolean {
	return (
		MINT.test(codeOnly(text)) || reachedCalls(parseSource(file, text).source, BUILDER_MODULES, BUILDERS).length > 0
	);
}

////////////////////////////////
//  Tests

describe("one minting site for index facts", () => {
	it("finds source files to check, and exempts exactly the two owners", () => {
		const all = ROOTS.flatMap((root) => sourceFiles(root, SKIP_DIRS));
		expect({ checked: swept().length > 100, exempt: all.length - swept().length }).toEqual({
			checked: true,
			exempt: 2,
		});
	});

	it("keeps the store on the builders", () => {
		const store = join(REPO, "core/src/store.ts");
		expect(mints(store, readSwept(store) ?? "")).toBe(true);
	});

	it("fires on a direct call, an alias and a namespace", () => {
		const planted = [
			"const id = referenceFactId(module, reference, owners);",
			'import { referenceFactId as makeId } from "@nyaa-lexicon/protocol";\nmakeId(module, reference, owners);\n',
			'import * as ids from "@nyaa-lexicon/protocol";\nids.literalFactId(module, literal, owners);\n',
		];

		expect(planted.map((text) => mints("planted.ts", text))).toEqual([true, true, true]);
	});

	it("has no module but the store minting an index fact id", () => {
		const offenders = swept().filter((file) => mints(file, readSwept(file) ?? ""));

		expect(
			offenders,
			"index fact ids are minted in IndexStore.replaceFile, which knows every owner's start",
		).toEqual([]);
	});
});
