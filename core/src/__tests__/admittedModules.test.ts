import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { fakeSupervisor } from "./fakeProvider";
import { gitInit } from "./gitFixture";

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
	put("lexicon.json", JSON.stringify({ deny: ["vault.fake"] }));
	put("root.fake", 'export class Root {}\nimport "./gen/types.fake";\nimport "./vault.fake";\n');
	put("gen/types.fake", "export class Types {}\n");
	put("stray.fake", "export class Stray {}\n");
	put("vault.fake", "export class Vault {}\n");
	service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("why the index may read a module", () => {
	it("admits discovered and imported modules, and nothing denied, stray or never reached", async () => {
		await service.indexWorkspace();

		expect(
			await service.admittedModules(["root.fake", "gen/types.fake", "stray.fake", "vault.fake", "ghost.fake"]),
		).toEqual([
			{ module: "root.fake", admitted: "discovered" },
			{ module: "gen/types.fake", admitted: "imported" },
			{ module: "stray.fake", admitted: null },
			{ module: "vault.fake", admitted: null },
			{ module: "ghost.fake", admitted: null },
		]);
		// A claim admits any path a caller names; admission does not.
		expect(service.moduleStatus("stray.fake").claimed).toBe(true);
	});

	it("drops an import once nothing reaches it", async () => {
		await service.indexWorkspace();
		put("root.fake", "export class Root {}\n");
		await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-2" }]);

		expect(await service.admittedModules(["gen/types.fake"])).toEqual([
			{ module: "gen/types.fake", admitted: null },
		]);
	});
});
