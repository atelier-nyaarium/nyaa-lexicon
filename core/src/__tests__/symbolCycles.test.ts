import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, type Declaration } from "@nyaa-lexicon/protocol";
import { IndexReadModel } from "../indexReads.js";
import { IndexStore, type ReplaceFileInput } from "../store.js";

const POINT = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

let store: IndexStore;
let reads: IndexReadModel;
let directory: string;

function id(name: string, module: string): string {
	return composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] });
}

function declaration(symbolId: string, name: string): Declaration {
	return {
		symbolId,
		kind: "function",
		name,
		range: POINT,
		selectionRange: POINT,
		visibility: "public",
		exported: true,
	};
}

/** One module declaring `name`, calling `calls` from inside it. */
function file(module: string, name: string, calls: string | null): ReplaceFileInput {
	const self = id(name, module);
	return {
		module,
		contentHash: `${module}:${calls}`,
		declarations: [declaration(self, name)],
		references:
			calls === null
				? []
				: [
						{
							name: "callee",
							range: POINT,
							fromId: self,
							role: "call",
							binding: { status: "bound", symbolId: calls, provenance: "bound" },
						},
					],
		imports: [],
		depth: "full",
	};
}

beforeEach(() => {
	directory = mkdtempSync(path.join(tmpdir(), "lexicon-symbol-cycles-"));
	store = IndexStore.open(path.join(directory, "index.sqlite")).store;
	reads = new IndexReadModel(store);
});

afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("symbol cycles", () => {
	it("follows each facts change, and a limit never trims what a later read sees", () => {
		const ping = id("ping", "a.ts");
		const pong = id("pong", "b.ts");
		store.replaceFile(file("a.ts", "ping", pong));
		store.replaceFile(file("b.ts", "pong", ping));
		const joined = reads.cycles(1).map((cycle) => [...cycle.members].sort());
		const again = reads.cycles(5).length;

		store.replaceFile(file("b.ts", "pong", null));
		expect({ joined, again, broken: reads.cycles(5) }).toEqual({
			joined: [[ping, pong].sort()],
			again: 1,
			broken: [],
		});
	});
});
