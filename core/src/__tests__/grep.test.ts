import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, coordinatesOf, type Declaration, hashContent } from "@nyaa-lexicon/protocol";
import { rethrown } from "@nyaa-lexicon/protocol/rejection";
import { searchFiles } from "../fileScope";
import { GrepReader } from "../grep";
import { NoteLedger } from "../notes";
import { maskedView, maskSecretText } from "../secrets";
import { type AllowedView, sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { forgetPlain, writePlain } from "./admissions";
import { TestLexiconService, TestProviderSupervisor } from "./testPolicy";

////////////////////////////////
//  Fixtures

let root: string;
let store: IndexStore;
let views: Map<string, AllowedView>;
let notes: NoteLedger;
let reader: GrepReader;

function declaration(module: string, name: string, text: string): Declaration {
	return {
		symbolId: composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] }),
		name,
		kind: "function",
		visibility: "public",
		range: coordinatesOf(text).rangeAt(0, text.length) as Declaration["range"],
	};
}

function plant(module: string, text: string, names: string[] = []): string[] {
	const declarations = names.map((name) => declaration(module, name, text));
	views.set(module, { kind: "plain", text, hash: hashContent(text), lossless: true });
	writePlain(store, { module, contentHash: hashContent(text), declarations, references: [] });
	return declarations.map((item) => item.symbolId);
}

function save(symbolId: string, text: string): void {
	const result = notes.write({ symbolId, text, expectedRevision: 0 });
	if (result.outcome === "refused") throw new Error(result.reason);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-grep-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	views = new Map();
	notes = new NoteLedger(store, "test");
	reader = new GrepReader(store, {
		modules: async () => ({ modules: [...views.keys()].sort(), incomplete: false }),
		view: (module) => views.get(module) ?? { kind: "missing" },
		notes,
	});
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

it("finds source phrases, paths and note-only words in one bounded page", async () => {
	const [symbolId] = plant("src/dispatcher.ts", "new ToolDispatcher();\nnew ToolDispatcher();", ["wire"]);
	if (symbolId === undefined) throw new Error("invalid fixture");
	save(symbolId, "Explains the ToolDispatcher lifetime.");
	const found = await reader.search({ text: "ToolDispatcher", limit: 2 });
	expect(found.matches.map((match) => match.kind)).toEqual(["source", "note"]);
	expect(found.count).toEqual({ kind: "exact", count: 3 });
	expect(found.truncated).toBe(true);
	expect((await reader.search({ text: "new ToolDispatcher" })).matches[0]).toMatchObject({
		kind: "source",
		symbolId,
	});
	expect((await reader.search({ text: "dispatcher.ts", sources: ["path"] })).matches).toEqual([
		{ kind: "path", module: "src/dispatcher.ts" },
	]);
	expect((await reader.search({ text: "lifetime", sources: ["source", "path"] })).matches).toEqual([]);
});

it("scopes files and folders on boundaries before limiting current notes", async () => {
	const [a] = plant("src/a.ts", "needle", ["alpha"]);
	const [b] = plant("src-old/b.ts", "needle", ["beta"]);
	if (a === undefined || b === undefined) throw new Error("invalid fixture");
	save(a, "Finds a needle here.");
	save(b, "Finds another needle there.");
	expect(store.notes.addresses(1, ["src-old/b.ts"])).toEqual([b]);
	const found = await reader.search({ text: "needle", module: "src" });
	expect(found.matches.map((match) => match.module)).toEqual(["src/a.ts", "src/a.ts"]);
	expect(found.coverage.scannedNotes).toBe(1);
	expect((await reader.search({ text: "needle", module: "." })).matches).toHaveLength(4);
	forgetPlain(store, "src/a.ts");
	expect((await reader.search({ text: "needle", sources: ["notes"] })).matches.map((match) => match.module)).toEqual([
		"src-old/b.ts",
	]);
});

it("keeps UTF-16 ranges across multiline regex matches and one hit per line", async () => {
	plant("a.ts", "\u{1f431} needle needle\r\nNEXT needle\r\nend");
	const exact = await reader.search({ text: "needle", sources: ["source"] });
	expect(exact.matches.map((match) => ("range" in match ? match.range : null))).toEqual([
		{ start: { line: 0, character: 3 }, end: { line: 0, character: 9 } },
		{ start: { line: 1, character: 5 }, end: { line: 1, character: 11 } },
	]);
	const multiline = await reader.search({ regex: "/needle\\r\\nnext/i", sources: ["source"] });
	expect(multiline.matches[0]).toMatchObject({
		range: { start: { line: 0, character: 10 }, end: { line: 1, character: 4 } },
	});
	expect((await reader.search({ text: "next", sources: ["source"] })).matches).toEqual([]);
	expect(
		(await reader.search({ regex: "/^/m", sources: ["source"] })).matches.map((match) =>
			"range" in match ? match.range.start : null,
		),
	).toEqual([
		{ line: 0, character: 0 },
		{ line: 1, character: 0 },
		{ line: 2, character: 0 },
	]);
	expect(await rethrown(reader.search({ regex: "/(?<=needle)x/" }))).toThrow(/RE2/);
	expect(await rethrown(reader.search({ text: "needle", regex: "/needle/" }))).toThrow();
});

it("omits guessed owners for stale text and equal declaration ranges", async () => {
	plant("a.ts", "const a = Foo(), b = Bar();", ["a", "b"]);
	const tied = await reader.search({ text: "Foo", sources: ["source"] });
	expect(tied.matches[0]).not.toHaveProperty("symbolId");
	plant("a.ts", "function wire() { Foo(); }", ["wire"]);
	const changed = "\nfunction wire() { Foo(); }";
	views.set("a.ts", { kind: "plain", text: changed, hash: hashContent(changed), lossless: true });
	const stale = await reader.search({ text: "Foo", sources: ["source"] });
	expect(stale.matches[0]).not.toHaveProperty("symbolId");
	expect(stale.matches[0]).toMatchObject({ range: { start: { line: 1, character: 18 } } });
});

it("keeps visible matches and snippets after hidden text without inventing anchors", async () => {
	const text = `token=${"secret".repeat(30)}; visibleNeedle`;
	const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 186 } };
	const masked = maskSecretText(text, [range]);
	if (masked === null) throw new Error("invalid fixture");
	views.set("secret.yaml", maskedView(masked, "hash", { wholeFile: false, spans: [range], omitted: [], shown: [] }));
	const found = await reader.search({ text: "visibleNeedle", sources: ["source"] });
	expect(found.matches[0]).toMatchObject({ kind: "source", text: "********; visibleNeedle" });
	expect(JSON.stringify(found)).not.toContain("secretsecret");
	expect((await reader.search({ text: "secret", sources: ["source"] })).matches).toEqual([]);
	expect((await reader.search({ text: " ", sources: ["source"] })).matches[0]).toMatchObject({
		range: { start: { line: 0, character: 187 } },
	});
	const shortRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } };
	views.set(
		"secret.yaml",
		maskedView("      visibleNeedle", "hash", { wholeFile: false, spans: [shortRange], omitted: [], shown: [] }),
	);
	expect((await reader.search({ regex: "/[ a-z]+/i", sources: ["source"] })).matches[0]).toMatchObject({
		range: { start: { line: 0, character: 6 } },
	});
	expect((await reader.search({ regex: "/^visibleNeedle$/", sources: ["source"] })).matches).toEqual([]);
	views.set(
		"secret.yaml",
		maskedView("key=      ", "hash", {
			wholeFile: true,
			spans: [{ start: { line: 0, character: 4 }, end: { line: 0, character: 10 } }],
			omitted: [],
			shown: [],
		}),
	);
	expect((await reader.search({ text: "key", sources: ["source"] })).matches).toEqual([]);
	for (const regex of ["/.*/", "/.*?/", "/$/"])
		expect((await reader.search({ regex, sources: ["source"] })).matches).toEqual([]);
	views.set(
		"secret.yaml",
		maskedView("      mid      visibleNeedle", "hash", {
			wholeFile: false,
			spans: [shortRange, { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } }],
			omitted: [],
			shown: [],
		}),
	);
	expect((await reader.search({ regex: "/[ a-z]+/i", sources: ["source"] })).matches[0]).toMatchObject({
		range: { start: { line: 0, character: 15 } },
	});
});

it("reports zero matches as incomplete when the file or inventory scan stops", async () => {
	const view = { kind: "plain" as const, text: "nothing", hash: "hash", lossless: true };
	for (let at = 0; at < 5001; at++) views.set(`a${at}.txt`, view);
	const found = await reader.search({ text: "absent", sources: ["source"] });
	expect(found).toMatchObject({
		matches: [],
		count: { kind: "atLeast", count: 0, reason: "scanCapped" },
		scanIncomplete: true,
		coverage: { scannedFiles: 5000 },
	});
	const incomplete = new GrepReader(store, {
		modules: async () => ({ modules: [], incomplete: true }),
		view: () => ({ kind: "missing" }),
		notes,
	});
	expect(await incomplete.search({ text: "absent" })).toMatchObject({
		count: { kind: "atLeast", count: 0, reason: "scanCapped" },
		scanIncomplete: true,
	});
});

it("discovers providerless source while skipping excluded trees, links and nested repositories", async () => {
	writeFileSync(path.join(root, "barrel.ts"), "export { ToolDispatcher } from './dispatcher';\n");
	writeFileSync(path.join(root, "README.md"), "Find ToolDispatcher in the extension.\n");
	mkdirSync(path.join(root, "node_modules"));
	writeFileSync(path.join(root, "node_modules", "hidden.ts"), "ToolDispatcher");
	mkdirSync(path.join(root, "nested", ".git"), { recursive: true });
	writeFileSync(path.join(root, "nested", "hidden.ts"), "ToolDispatcher");
	symlinkSync(path.join(root, "README.md"), path.join(root, "alias.md"));
	const supervisor = new TestProviderSupervisor();
	const service = new TestLexiconService(store, supervisor, sourceReader(root), root);
	const found = await service.grep({ text: "ToolDispatcher", module: ".", sources: ["source"] });
	expect(found.matches.map((match) => match.module)).toEqual(["README.md", "barrel.ts"]);
	expect(supervisor.providerStatuses()).toEqual([]);
	expect(searchFiles(root, await service.currentScope(), "barrel.ts")).toEqual({
		modules: ["barrel.ts"],
		incomplete: false,
	});
});
