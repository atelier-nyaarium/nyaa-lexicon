import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { fakeSupervisor } from "./fakeProvider";
import { gitInit } from "./gitFixture";
import { TestLexiconService as LexiconService, testPolicy } from "./testPolicy";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let service: LexiconService;

function put(module: string, text: string): void {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-admitted-"));
	store = IndexStore.open(path.join(root, ".lexicon.sqlite")).store;
	await gitInit(root);
	put(".gitignore", "gen/\nstray.fake\n.lexicon.sqlite*\n");
	put("lexicon.json", JSON.stringify({ deny: ["vault.fake"], exclude: ["excluded/**"] }));
	put("root.fake", 'export class Root {}\nimport "./gen/types.fake";\nimport "./vault.fake";\n');
	put("gen/types.fake", "export class Types {}\n");
	put("stray.fake", "export class Stray {}\n");
	put("vault.fake", "export class Vault {}\n");
	service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root, undefined, testPolicy(root));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("why the index may read a module", () => {
	it.each(["write-first", "event-first"])("admits an explicit new file with %s ordering", async (order) => {
		await service.indexWorkspace();
		put("new.fake", "export class New {}\n");
		const event = { kind: "changed" as const, module: "new.fake", contentHash: "new" };
		if (order === "event-first") await service.applyBatch([event]);
		await service.indexFile("new.fake");
		expect(await service.admittedModules(["new.fake"])).toEqual([{ module: "new.fake", admitted: "discovered" }]);
		await service.applyBatch([event]);
		await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-again" }]);
		expect(await service.admittedModules(["new.fake", "stray.fake", "vault.fake"])).toEqual([
			{ module: "new.fake", admitted: "discovered" },
			{ module: "stray.fake", admitted: null, cause: "ignored" },
			{ module: "vault.fake", admitted: null, cause: "denied" },
		]);
	});

	it("removes a missing explicit file before its delete event", async () => {
		await service.indexWorkspace();
		put("new.fake", "export class New {}\n");
		await service.indexFile("new.fake");
		rmSync(path.join(root, "new.fake"));
		await service.indexFile("new.fake");
		expect(await service.admittedModules(["new.fake"])).toEqual([{ module: "new.fake", admitted: null }]);
	});

	it("does not discover an ignored explicit file or a default excluded directory", async () => {
		await service.indexWorkspace();
		put("node_modules/local.fake", "export class Local {}\n");
		for (const module of ["stray.fake", "node_modules/local.fake"]) {
			await service.indexFile(module);
			expect(await service.admittedModules([module])).toEqual([
				{ module, admitted: null, cause: module === "stray.fake" ? "ignored" : "excluded" },
			]);
		}
		await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-again" }]);
		expect(service.moduleStatus("stray.fake").indexed).toBe(false);
	});

	it("admits discovered and imported modules, and nothing denied, stray or never reached", async () => {
		await service.indexWorkspace();

		expect(
			await service.admittedModules(["root.fake", "gen/types.fake", "stray.fake", "vault.fake", "ghost.fake"]),
		).toEqual([
			{ module: "root.fake", admitted: "discovered" },
			{ module: "gen/types.fake", admitted: "imported" },
			{ module: "stray.fake", admitted: null, cause: "ignored" },
			{ module: "vault.fake", admitted: null, cause: "denied" },
			{ module: "ghost.fake", admitted: null },
		]);
		// A claim admits any path a caller names; admission does not.
		expect(service.moduleStatus("stray.fake").claimed).toBe(true);
	});

	it("never reads a denied file for its status or rows, so neither its presence nor a hash leaves", async () => {
		await service.indexWorkspace();

		const status = service.moduleStatus("vault.fake");
		const rows = service.moduleDeclarations("vault.fake");
		expect({ exists: status.exists, rowsExist: rows.exists, read: rows.read, diskHash: rows.diskHash }).toEqual({
			exists: false,
			rowsExist: false,
			read: { kind: "missing", detail: "denied by scope" },
			diskHash: null,
		});
	});

	it.each(["warm", "reopened"])("drops a %s import once nothing reaches it", async (state) => {
		await service.indexWorkspace();
		if (state === "reopened")
			service = new LexiconService(
				store,
				fakeSupervisor(),
				sourceReader(root),
				root,
				undefined,
				testPolicy(root),
			);
		await service.indexFile("gen/types.fake");
		if (state === "reopened") await service.indexWorkspace();
		expect(await service.admittedModules(["gen/types.fake"])).toEqual([
			{ module: "gen/types.fake", admitted: "imported" },
		]);
		put("root.fake", "export class Root {}\n");
		await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-2" }]);

		expect(await service.admittedModules(["gen/types.fake"])).toEqual([
			{ module: "gen/types.fake", admitted: null, cause: "ignored" },
		]);
	});

	it("answers for folders and identifies their omission rule", async () => {
		put("excluded/child.fake", "export class Excluded {}\n");
		put("inside/child.fake", "export class Inside {}\n");
		put("ignored/child.fake", "export class Ignored {}\n");
		put(".gitignore", "gen/\nignored/\nstray.fake\n.lexicon.sqlite*\n");
		await service.indexWorkspace();
		expect(await service.admittedModules(["excluded/", "inside", "ignored", "gen/", ".git/"])).toEqual([
			{ module: "excluded", admitted: null, cause: "excluded" },
			{ module: "inside", admitted: "discovered" },
			{ module: "ignored", admitted: null, cause: "ignored" },
			{ module: "gen", admitted: "imported" },
			{ module: ".git", admitted: null, cause: "denied" },
		]);
	});

	it("checks new ignored files and leaves missing or outside paths without a scope cause", async () => {
		put(".gitignore", "*.log\ngen/\nstray.fake\n.lexicon.sqlite*\n");
		await service.indexWorkspace();
		put("debug.log", "new ignored content\n");
		put("new.fake", "export class New {}\n");
		symlinkSync(tmpdir(), path.join(root, "outside"), "dir");
		expect(await service.admittedModules(["debug.log", "new.fake", "ghost.fake", "outside/"])).toEqual([
			{ module: "debug.log", admitted: null, cause: "ignored" },
			{ module: "new.fake", admitted: null, cause: "unlisted" },
			{ module: "ghost.fake", admitted: null },
			{ module: "outside", admitted: null },
		]);
		expect(await service.moduleView("outside/secret.txt", undefined, "SECRET_VALUE")).toEqual({ kind: "withheld" });
	});

	it("admits walk-mode folders containing providerless files", async () => {
		rmSync(path.join(root, ".git"), { recursive: true });
		put("docs/a.unknown", "documentation\n");
		await service.indexWorkspace();
		expect(await service.admittedModules(["docs", "docs/a.unknown"])).toEqual([
			{ module: "docs", admitted: "discovered" },
			{ module: "docs/a.unknown", admitted: "discovered" },
		]);
	});

	it("reports a shared omission cause for a folder of denied files", async () => {
		put("lexicon.json", JSON.stringify({ deny: ["secrets/*.key"] }));
		put("secrets/a.key", "value\n");
		await service.indexWorkspace();
		expect(await service.admittedModules(["secrets"])).toEqual([
			{ module: "secrets", admitted: null, cause: "denied" },
		]);
	});
});
