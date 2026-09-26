import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	composeSymbolId,
	type Declaration,
	type DocRegion,
	type Import,
	type Literal,
	type ModuleExclusion,
	type Range,
} from "@nyaa-lexicon/protocol";
import type { AttachedComment } from "../commentAttach";
import { ImportResolver } from "../imports";
import { IndexReadModel, REGEX_SCAN_LIMIT } from "../indexReads";
import { IndexStore } from "../store";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let reads: IndexReadModel;
let imports: ImportResolver;

const HIDE_SECRETS: ModuleExclusion = { hide: ["**/.env*", "secret/**"] };

function at(line: number): Range {
	return { start: { line, character: 0 }, end: { line, character: 1 } };
}

interface Facts {
	declarations?: readonly string[];
	literals?: readonly string[];
	comments?: readonly string[];
	docs?: readonly string[];
	imports?: readonly string[];
}

/** One module, one row per entry, each on its own line. */
function put(module: string, facts: Facts): void {
	const declarations: Declaration[] = (facts.declarations ?? []).map((name, line) => ({
		symbolId: composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] }),
		kind: "function",
		name,
		range: at(line),
		selectionRange: at(line),
		visibility: "public",
		exported: true,
	}));
	const literals: Literal[] = (facts.literals ?? []).map((value, line) => ({
		kind: "string",
		value,
		range: at(line),
	}));
	const comments: AttachedComment[] = (facts.comments ?? []).map((text, line) => ({
		range: at(line),
		raw: `// ${text}`,
		normalized: text,
		form: "standalone",
		placement: "inside",
		anchorId: null,
	}));
	const docs: DocRegion[] = (facts.docs ?? []).map((text, line) => ({ range: at(line), text, fenced: false }));
	const written: Import[] = (facts.imports ?? []).map((specifier) => ({ specifier, imported: [], reExport: false }));
	store.replaceFile({
		module,
		contentHash: module,
		declarations,
		references: [],
		imports: written,
		literals,
		comments,
		docs,
		depth: "full",
	});
}

function many(count: number, text: (index: number) => string): string[] {
	return Array.from({ length: count }, (_, index) => text(index));
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-exclusion-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	reads = new IndexReadModel(store);
	imports = new ImportResolver(store, async () => ({ status: "unresolved", reason: "NotImplemented" }));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

// `.env` sorts first, so an unfiltered scan spends its whole budget there.
describe("a hidden file past the scan limit", () => {
	const flooded = REGEX_SCAN_LIMIT + 5;

	it.each([
		["literals", { literals: many(flooded, (i) => `sk-a${i}`) }, { literals: ["sk-a-placeholder"] }],
		["docs", { docs: many(flooded, (i) => `KEY=sk-a${i}`) }, { docs: ["keys look like sk-a-placeholder"] }],
		["comments", { comments: many(flooded, (i) => `sk-a${i}`) }, { comments: ["keys look like sk-a"] }],
	] as const)("spends none of the %s scan and leaves scanIncomplete unset", (tier, hidden, shown) => {
		put(".env", hidden);
		put("src/config.ts", shown);
		const search = (exclude?: ModuleExclusion) =>
			tier === "literals"
				? reads.findLiterals({ regex: "/sk-a/" }, 50, exclude)
				: tier === "docs"
					? reads.findDocs({ regex: "/sk-a/" }, 50, exclude)
					: reads.findComments({ regex: "/sk-a/" }, 50, exclude);

		expect(search().scanIncomplete).toBe(true);
		const filtered = search(HIDE_SECRETS);
		expect(filtered.scanIncomplete).toBeUndefined();
		expect(filtered).toMatchObject({ query: { excluded: true }, total: 1, truncated: false });
	});
});

describe("a page and its total", () => {
	beforeEach(() => {
		put(".env", {
			declarations: many(5, (i) => `token${i}`),
			literals: many(5, () => "shared"),
			comments: many(5, () => "token rotation"),
			docs: many(5, () => "token rotation"),
			imports: ["./token-store"],
		});
		put("secret/keys.ts", { imports: ["./token-store"] });
		put("src/a.ts", {
			declarations: many(3, (i) => `token${i}`),
			literals: many(3, () => "shared"),
			comments: many(3, () => "token rotation"),
			docs: many(3, () => "token rotation"),
			imports: ["./token-store"],
		});
	});

	it("count only visible rows, whether or not the page holds them all", () => {
		const counts = (limit: number) => ({
			literals: reads.findLiterals({ value: "shared" }, limit, HIDE_SECRETS),
			comments: reads.findComments({ text: "rotation" }, limit, HIDE_SECRETS),
			docs: reads.findDocs({ text: "rotation" }, limit, HIDE_SECRETS),
		});
		const paged = counts(2);
		const whole = counts(50);

		for (const tier of ["literals", "comments", "docs"] as const) {
			expect({ total: paged[tier].total, truncated: paged[tier].truncated }, tier).toEqual({
				total: 3,
				truncated: true,
			});
			expect({ total: whole[tier].total, truncated: whole[tier].truncated }, tier).toEqual({
				total: 3,
				truncated: false,
			});
		}
		expect(whole.literals.literals.map((row) => row.module)).toEqual(["src/a.ts", "src/a.ts", "src/a.ts"]);
		expect(whole.comments.comments).toHaveLength(3);
		expect(whole.docs.docs).toHaveLength(3);
	});

	it("counts a shared value's files and uses only where it is visible", () => {
		expect(reads.sharedLiterals(1, 50)).toEqual([{ value: "shared", kind: "string", files: 2, uses: 8 }]);
		expect(reads.sharedLiterals(1, 50, HIDE_SECRETS)).toEqual([
			{ value: "shared", kind: "string", files: 1, uses: 3, excluded: true },
		]);
		expect(reads.sharedLiterals(2, 50, HIDE_SECRETS)).toEqual([]);
	});

	it("reaches symbols and importers only in visible modules", async () => {
		const symbols = reads.searchSymbols("token", { limit: 50, exclude: HIDE_SECRETS });
		expect(symbols).toMatchObject({ excluded: true, total: 3, truncated: false });
		expect(new Set(symbols.symbols.map((symbol) => symbol.module))).toEqual(new Set(["src/a.ts"]));

		const bySpecifier = await imports.findImports({ specifier: "token", exclude: HIDE_SECRETS });
		const byRegex = await imports.findImports({ specifierRegex: "/token/", exclude: HIDE_SECRETS });
		for (const found of [bySpecifier, byRegex]) {
			expect(found).toMatchObject({ excluded: true, total: 1 });
			expect(found.imports.map((row) => row.module)).toEqual(["src/a.ts"]);
			expect(found.query).not.toHaveProperty("exclude");
		}
	});

	it("answers as before, with no echo, when no exclusion is asked", async () => {
		expect(reads.findDocs({ text: "rotation" }).total).toBe(8);
		expect(reads.findDocs({ text: "rotation" }).query).not.toHaveProperty("excluded");
		expect(reads.searchSymbols("token", { limit: 50 })).not.toHaveProperty("excluded");
		expect((await imports.findImports({ specifier: "token" })).total).toBe(3);
	});
});

describe("what the exclusion names", () => {
	it("hides by glob in any case, and shows what keep or allow names", () => {
		for (const module of [".ENV", ".env.example", "config/.env.shared", "config/.env.local", "src/a.ts"])
			put(module, { docs: ["token rotation"] });

		const found = reads.findDocs({ text: "rotation" }, 50, {
			hide: ["**/.env*"],
			keep: ["**/.env.example"],
			allow: ["config/.env.shared"],
		});

		expect(found.docs.map((doc) => doc.module)).toEqual([".env.example", "config/.env.shared", "src/a.ts"]);
		expect(found.total).toBe(3);
	});
});
