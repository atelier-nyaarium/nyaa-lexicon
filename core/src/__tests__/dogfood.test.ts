// Points the whole stack at this repository's own source.
//
// A fixture proves the code runs. Real source proves it is right, because the expectations here
// are things a reader can check by opening the file.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDispatch } from "../dispatch";
import { LexiconService } from "../service";
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
	const outcome = await service.indexFile(module, "h1");
	if (outcome.action !== "indexed") throw new Error(`${module}: ${outcome.action} ${outcome.reason ?? ""}`);
}

beforeEach(async () => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-dogfood-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
	await supervisor.start({ command: ["bun", "run", PROVIDER], timeoutMs: 20_000 }, REPO);
	service = new LexiconService(store, supervisor, (module) => {
		try {
			return readFileSync(path.join(REPO, module), "utf8");
		} catch {
			return null;
		}
	});
});

afterEach(() => {
	supervisor?.stopAll();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("indexing this repository's own source", () => {
	it("finds the cursor class and its real methods", async () => {
		await index("protocol/src/cursor.ts");

		const found = service.findByName("Cursor");
		expect(found).toHaveLength(1);

		const described = service.describe(found[0]?.symbolId ?? "");
		const members = described?.members.map((m) => m.name) ?? [];
		expect(members).toEqual(expect.arrayContaining(["peek", "next", "good", "takeWhile", "mark", "fail"]));
	}, 40_000);

	it("separates an exported function from a file-local one, in a real file", async () => {
		await index("protocol/src/symbolId.ts");

		expect(service.findByName("composeSymbolId")[0]?.exported).toBe(true);
		// `readName` is a helper the module does not export.
		expect(service.findByName("readName")[0]?.exported).toBe(false);
	}, 40_000);

	it("carries a real signature, so a caller can read a function without the file", async () => {
		await index("protocol/src/symbolId.ts");

		expect(service.findByName("normalizeModulePath")[0]?.signature).toContain("normalizeModulePath(raw: string)");
	}, 40_000);

	it("resolves a relative import between two real files", async () => {
		const resolution = await service.resolveImport("protocol/src/symbolId.ts", "./cursor.js");
		expect(resolution).toMatchObject({ status: "resolved", module: "protocol/src/cursor.ts" });
	}, 40_000);

	it("calls an installed dependency external rather than unresolved", async () => {
		const resolution = await service.resolveImport("protocol/src/values.ts", "zod");
		expect(resolution.status).toBe("external");
	}, 40_000);

	it("gives every symbol in a real file a parseable, distinct id", async () => {
		await index("core/src/store.ts");

		const ids = store.declarationsIn("core/src/store.ts").map((d) => d.symbolId);
		expect(ids.length).toBeGreaterThan(10);
		expect(new Set(ids).size).toBe(ids.length);
	}, 40_000);

	it("answers through the daemon dispatch the MCP tools actually use", async () => {
		await index("protocol/src/cursor.ts");
		const dispatch = createDispatch(service);

		const found = (await dispatch("findByName", { name: "formatFailure" })) as Array<{ symbolId: string }>;
		expect(found).toHaveLength(1);

		const described = (await dispatch("describe", { symbolId: found[0]?.symbolId })) as {
			symbol: { kind: string };
		};
		expect(described.symbol.kind).toBe("function");
	}, 40_000);
});
