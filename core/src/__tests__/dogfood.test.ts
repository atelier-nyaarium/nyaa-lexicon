// Points the whole stack at this repository's own source.
//
// A fixture proves the code runs. Real source proves it is right, because the expectations here
// are things a reader can check by opening the file.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDispatch } from "../dispatch";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

// Lives in core, not in the provider: a provider package must never depend on the core, and this
// test needs both. Core spawns providers by command, so it reaches this one by path alone.
const REPO = path.join(import.meta.dirname, "..", "..", "..");
const PROVIDER = path.join(REPO, "providers", "typescript", "src", "main.ts");

let dir: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let service: LexiconService;

async function index(module: string): Promise<void> {
	const outcome = await service.indexFile(module);
	if (outcome.action !== "indexed") throw new Error(`${module}: ${outcome.action} ${outcome.reason ?? ""}`);
}

// One provider for the suite: its first parse builds the repository's program, which a loaded gate
// can stretch past half a minute.
beforeAll(async () => {
	supervisor = new ProviderSupervisor();
	await supervisor.start({ command: [process.execPath, "run", PROVIDER], timeoutMs: 90_000 }, REPO);
});

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-dogfood-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	service = new LexiconService(store, supervisor, sourceReader(REPO));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

afterAll(() => supervisor?.stopAll());

////////////////////////////////
//  Tests

describe("indexing this repository's own source", () => {
	it("finds the cursor class and its real methods", async () => {
		await index("protocol/src/sourceCursor.ts");

		const found = service.findByName("SourceCursor");
		expect(found).toHaveLength(1);

		const described = service.describe(found[0]?.symbolId ?? "");
		const members = described?.members.map((m) => m.name) ?? [];
		expect(members).toEqual(expect.arrayContaining(["peek", "next", "good", "readWhile", "mark", "failure"]));
	}, 120_000);

	it("separates an exported function from a file-local one, in a real file", async () => {
		await index("protocol/src/symbolId.ts");

		expect(service.findByName("composeSymbolId")[0]?.exported).toBe(true);
		// `readName` is a helper the module does not export.
		expect(service.findByName("readName")[0]?.exported).toBe(false);
	}, 120_000);

	it("carries a real signature, so a caller can read a function without the file", async () => {
		await index("protocol/src/symbolId.ts");

		expect(service.findByName("normalizeModulePath")[0]?.signature).toContain("normalizeModulePath(raw: string)");
	}, 120_000);

	it("resolves a relative import between two real files", async () => {
		const resolution = await service.resolveImport("protocol/src/symbolId.ts", "./sourceCursor.js");
		expect(resolution).toMatchObject({
			status: "resolved",
			landing: { kind: "module", module: "protocol/src/sourceCursor.ts" },
		});
	}, 120_000);

	it("calls an installed dependency external rather than unresolved", async () => {
		const resolution = await service.resolveImport("protocol/src/values.ts", "zod");
		expect(resolution.status).toBe("external");
	}, 120_000);

	it("gives every symbol in a real file a parseable, distinct id", async () => {
		await index("core/src/store.ts");

		const ids = store.declarationsIn("core/src/store.ts").map((d) => d.symbolId);
		expect(ids.length).toBeGreaterThan(10);
		expect(new Set(ids).size).toBe(ids.length);
	}, 120_000);

	it("answers through the daemon dispatch the MCP tools actually use", async () => {
		await index("protocol/src/parseResult.ts");
		const dispatch = createDispatch(service);

		const found = (await dispatch("findByName", { name: "formatFailure" })) as Array<{ symbolId: string }>;
		expect(found).toHaveLength(1);

		const described = (await dispatch("describe", { symbolId: found[0]?.symbolId })) as {
			symbol: { kind: string };
		};
		expect(described.symbol.kind).toBe("function");
	}, 120_000);
});
