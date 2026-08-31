import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, type Declaration } from "@nyaa-lexicon/protocol";
import { IndexReadModel } from "../indexReads";
import { IndexStore } from "../store";

let dir: string;
let store: IndexStore;
let reads: IndexReadModel;

const POINT = { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };

function declaration(name: string): Declaration {
	return {
		symbolId: composeSymbolId({ language: "ts", module: "src/a.ts", descriptors: [{ kind: "term", name }] }),
		kind: "function",
		name,
		range: POINT,
		selectionRange: POINT,
		visibility: "public",
		exported: true,
	};
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-paging-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	reads = new IndexReadModel(store);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

// The live bug: a probe of limit + 1 rows was printed as the total.
describe("a symbol search past its page", () => {
	it("answers a floor of limit + 1, and an exact count once the page holds everything", () => {
		const names = Array.from({ length: 60 }, (_, index) => `thing${index}`);
		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: names.map(declaration),
			references: [],
		});

		const capped = reads.searchSymbols("thing", { limit: 50 });
		expect(capped.symbols).toHaveLength(50);
		expect(capped.count).toEqual({ kind: "atLeast", count: 51, reason: "pageCapped" });
		expect(capped).toMatchObject({ total: 51, truncated: true });

		const whole = reads.searchSymbols("thing", { limit: 100 });
		expect(whole.symbols).toHaveLength(60);
		expect(whole.count).toEqual({ kind: "exact", count: 60 });
		expect(whole).toMatchObject({ total: 60, truncated: false });
	});
});
