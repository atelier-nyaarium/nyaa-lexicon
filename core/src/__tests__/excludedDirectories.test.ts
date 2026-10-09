import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { FAKE_CLAIMS, fakeSupervisor } from "./fakeProvider";
import { gitInit } from "./gitFixture";

////////////////////////////////
//  Helpers

const roots: string[] = [];

/** A workspace whose provider declares `vendor`, `obj` and `bin`, and whose discovery names one file in `vendor`. */
async function indexed(git: boolean): Promise<{ service: LexiconService; store: IndexStore }> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-excluded-"));
	roots.push(root);
	const files: Record<string, string> = {
		".gitignore": ".lexicon.sqlite*\n",
		"root.fake": 'export class Root {}\nimport "./vendor/dep.fake";\n',
		"vendor/dep.fake": "export class Dep {}\n",
		"vendor/forced.fake": "export class Forced {}\n",
		"obj/generated.fake": "export class Generated {}\n",
		"bin/built.fake": "export class Built {}\n",
	};
	for (const [module, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, module)), { recursive: true });
		writeFileSync(path.join(root, module), text);
	}
	if (git) await gitInit(root);
	const store = IndexStore.open(path.join(root, ".lexicon.sqlite")).store;
	const supervisor = fakeSupervisor({
		claims: [{ ...FAKE_CLAIMS, excludedDirectories: ["vendor", "obj", "bin"] }],
		// As a walk returns it, plus a file the provider names under an excluded directory itself.
		discover: () => ["root.fake", "vendor/forced.fake"],
	});
	const service = new LexiconService(store, supervisor, sourceReader(root), root);
	await service.indexWorkspace();
	return { service, store };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a provider's declared excluded directories", () => {
	it("root no tracked file under them and follow no import into them, unless discovery names the file", async () => {
		for (const git of [true, false]) {
			const { service, store } = await indexed(git);
			expect(store.indexedFiles().sort(), `git ${git}`).toEqual(["root.fake", "vendor/forced.fake"]);
			expect(service.moduleStatus("obj/generated.fake"), `git ${git}`).toMatchObject({
				claimed: false,
				unclaimedReason: "under a directory its provider excludes",
			});
			store.close();
		}
	});
});
