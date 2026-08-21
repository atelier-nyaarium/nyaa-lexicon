import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, type Declaration } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttachedComment } from "../commentAttach.js";
import { IndexReadModel } from "../indexReads";
import { IndexStore } from "../store";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let reads: IndexReadModel;

const POINT = { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };

function idOf(name: string, module = "src/a.ts"): string {
	return composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] });
}

function declaration(name: string, module = "src/a.ts"): Declaration {
	return {
		symbolId: idOf(name, module),
		kind: "function",
		name,
		range: POINT,
		selectionRange: POINT,
		visibility: "public",
		exported: true,
		signature: `function ${name}()`,
	};
}

function comment(normalized: string, anchorId: string | null, extra: Partial<AttachedComment> = {}): AttachedComment {
	return {
		range: POINT,
		raw: `// ${normalized}`,
		normalized,
		form: "leading",
		placement: "above",
		anchorId,
		...extra,
	};
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-find-comments-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	reads = new IndexReadModel(store);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("searching comments", () => {
	beforeEach(() => {
		store.replaceFile("src/a.ts", "h1", [declaration("work")], [], [], [], "full", [
			comment("refuses rather than clamping", idOf("work")),
			{ ...comment("TODO handle the empty case", idOf("work")), form: "trailing", placement: "after" },
		]);
		store.replaceFile("src/b.ts", "h1", [], [], [], [], "full", [
			{ ...comment("Copyright someone", null), form: "standalone", placement: "inside" },
		]);
	});

	it("finds by substring and names the symbol it was written about", () => {
		const found = reads.findComments({ text: "rather than" });

		expect(found.total).toBe(1);
		expect(found.comments[0]?.anchor?.name).toBe("work");
		expect(found.comments[0]?.anchor?.signature).toBe("function work()");
	});

	it("finds by regex over the normalized text", () => {
		expect(reads.findComments({ regex: "/TODO|FIXME/" }).total).toBe(1);
		expect(reads.findComments({ regex: "/nothing/" }).total).toBe(0);
	});

	it("reports a comment that documents no symbol as anchored to nothing", () => {
		const [found] = reads.findComments({ text: "Copyright" }).comments;

		expect(found?.anchor).toBeNull();
		expect(found?.module).toBe("src/b.ts");
	});

	it("filters by form", () => {
		expect(reads.findComments({ form: "trailing" }).total).toBe(1);
		expect(reads.findComments({ form: "standalone" }).comments[0]?.module).toBe("src/b.ts");
	});

	it("filters by module", () => {
		expect(reads.findComments({ module: "src/b.ts" }).total).toBe(1);
	});

	it("echoes the query back, so an answer says what it answered", () => {
		expect(reads.findComments({ text: "rather than" }).query).toEqual({ text: "rather than" });
	});

	// A refusal that names the shapes, because naming the parameters alone was measured to fail.
	it("refuses a query with nothing to search on", () => {
		expect(() => reads.findComments({})).toThrow(/text or a regex/);
	});

	it("reports a bad regex rather than an empty result", () => {
		expect(() => reads.findComments({ regex: "/(unclosed/" })).toThrow();
	});

	it("says when a page was cut rather than reporting the cap as a total", () => {
		store.replaceFile("src/c.ts", "h1", [], [], [], [], "full", [
			comment("shared word one", null),
			comment("shared word two", null),
			comment("shared word three", null),
		]);

		const found = reads.findComments({ text: "shared word" }, 2);
		expect(found.comments).toHaveLength(2);
		expect(found.truncated).toBe(true);
		expect(found.total).toBe(3);
	});

	// A long banner is hundreds of lines and no caller asked for them.
	it("caps a long comment and says how much it cut", () => {
		const lines = Array.from({ length: 20 }, (_, index) => `// line ${index}`).join("\n");
		store.replaceFile("src/d.ts", "h1", [], [], [], [], "full", [{ ...comment("a banner", null), raw: lines }]);

		const [found] = reads.findComments({ text: "a banner" }).comments;
		expect(found?.raw.split("\n")).toHaveLength(9);
		expect(found?.raw).toContain("... 12 more lines");
	});
});

describe("describe carries what else was written", () => {
	it("lists notes but not the documentation, which prints above", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("work")], [], [], [], "full", [
			comment("what work does", idOf("work")),
			{ ...comment("why this order", idOf("work")), form: "standalone", placement: "inside" },
		]);

		const described = reads.describe(idOf("work"));
		expect(described?.symbol.docComment).toBe("what work does");
		expect(described?.comments?.map((item) => item.text)).toEqual(["why this order"]);
	});

	it("omits the section when nothing but documentation was written", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("work")], [], [], [], "full", [
			comment("what work does", idOf("work")),
		]);

		expect(reads.describe(idOf("work"))?.comments).toBeUndefined();
	});
});
