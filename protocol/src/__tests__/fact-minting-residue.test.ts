import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import ts from "typescript";
import { calleeOf, callsIn, parseSource, reachedCalls } from "../astResidue";
import { codeOnly, readSwept, sourceFiles } from "../residue";

/** The store owns fact-id minting. */
const REPO = join(import.meta.dirname, "..", "..", "..");

const ROOTS = ["protocol", "client", "core", "adapters", "providers"].map((dir) => join(REPO, dir));

/** Id grammar owns builders. */
const BUILDER_OWNER = join(REPO, "protocol/src/factId.ts");

const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "tmp"]);

const BUILDERS = new Set(
	["declaration", "reference", "import", "literal", "comment", "doc"].map((kind) => `${kind}FactId`),
);

/** Builder modules by import path. */
const BUILDER_MODULES = new Set(["@nyaa-lexicon/protocol", "./factId.js", "./factId", "../factId.js", "../factId"]);

const MINT = /\b(declaration|reference|import|literal|comment|doc)FactId\(/;

const swept = () => ROOTS.flatMap((root) => sourceFiles(root, SKIP_DIRS)).filter((file) => file !== BUILDER_OWNER);

/** Finds direct, aliased, and namespace calls. */
function mints(file: string, text: string): boolean {
	return (
		MINT.test(codeOnly(text)) || reachedCalls(parseSource(file, text).source, BUILDER_MODULES, BUILDERS).length > 0
	);
}

/** Builder calls, and builders passed on as values. */
function factIdUses(file: string, text: string): ts.Node[] {
	const source = parseSource(file, text).source;
	const direct = callsIn(source).filter((call) => BUILDERS.has(calleeOf(call)?.name ?? ""));
	const reached = reachedCalls(source, BUILDER_MODULES, BUILDERS).map((hit) => hit.call);
	return [...new Set<ts.Node>([...direct, ...reached])];
}

function isInReplaceFile(use: ts.Node): boolean {
	for (let node: ts.Node | undefined = use; node !== undefined; node = node.parent) {
		if (!ts.isMethodDeclaration(node)) continue;
		return (
			ts.isIdentifier(node.name) &&
			node.name.text === "replaceFile" &&
			ts.isClassDeclaration(node.parent) &&
			node.parent.name?.text === "IndexStore"
		);
	}
	return false;
}

function factIdsOutsideReplaceFile(file: string, text: string): ts.Node[] {
	return factIdUses(file, text).filter((use) => !isInReplaceFile(use));
}

////////////////////////////////
//  Tests

describe("one minting site for index facts", () => {
	it("finds source files to check, and exempts only the id grammar", () => {
		const all = ROOTS.flatMap((root) => sourceFiles(root, SKIP_DIRS));
		expect({ checked: swept().length > 100, exempt: all.length - swept().length }).toEqual({
			checked: true,
			exempt: 1,
		});
	});

	it("keeps store builder calls inside replaceFile", () => {
		const store = join(REPO, "core/src/store.ts");
		const uses = factIdUses(store, readSwept(store) ?? "");
		expect(uses.length).toBeGreaterThan(0);
		expect(uses.filter((use) => !isInReplaceFile(use))).toEqual([]);
	});

	it("catches a builder called or passed on in another store method", () => {
		const planted = `
			import { referenceFactId } from "@nyaa-lexicon/protocol";
			class IndexStore {
				replaceFile() { referenceFactId(module, reference, owners); }
				readFacts() { referenceFactId(module, reference, owners); }
				relay() { invoke(referenceFactId, module, reference, owners); }
			}
		`;

		expect(factIdsOutsideReplaceFile("store.ts", planted)).toHaveLength(2);
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
		const store = join(REPO, "core/src/store.ts");
		const offenders = swept().filter((file) => {
			const text = readSwept(file) ?? "";
			return file === store ? factIdsOutsideReplaceFile(file, text).length > 0 : mints(file, text);
		});

		expect(
			offenders,
			"index fact ids are minted in IndexStore.replaceFile, which knows every owner's start",
		).toEqual([]);
	});
});
