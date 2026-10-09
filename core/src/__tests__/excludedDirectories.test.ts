import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { FAKE_CLAIMS, type FakeAnswers, fakeSupervisor } from "./fakeProvider";
import { gitInit } from "./gitFixture";

////////////////////////////////
//  Helpers

const roots: string[] = [];

/** `obj` at any depth; `vendor` and `build` at the root or beside a `marker.toml`. */
const CLAIMS = [
	{
		...FAKE_CLAIMS,
		excludedDirectories: { anywhere: ["obj"], beside: [{ names: ["vendor", "build"], markers: ["marker.toml"] }] },
	},
];

const EXCLUDED = "under a directory its provider excludes";
const FORCED = "vendor/forced.fake";

function write(root: string, files: Record<string, string>): void {
	for (const [module, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, module)), { recursive: true });
		writeFileSync(path.join(root, module), text);
	}
}

async function workspace(files: Record<string, string>, git: boolean): Promise<string> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-excluded-"));
	roots.push(root);
	write(root, { ".gitignore": ".lexicon.sqlite*\n", ...files });
	if (git) await gitInit(root);
	return root;
}

function open(root: string): IndexStore {
	return IndexStore.open(path.join(root, ".lexicon.sqlite")).store;
}

/** Where a discovery says it began, and what it waits on before answering. */
interface Held {
	reached?: () => void;
	gate?: Promise<void>;
}

/** A provider whose discovery names `files()`, once `held` lets it. */
function serviceOf(root: string, store: IndexStore, files: () => string[], held?: Held) {
	const answers: FakeAnswers = {
		discoverProject: async () => {
			held?.reached?.();
			await held?.gate;
			return { files: files(), externalRoots: [], configFiles: ["fake.json"], diagnostics: [] };
		},
	};
	return new LexiconService(store, fakeSupervisor({ claims: CLAIMS, answers }), sourceReader(root), root);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a provider's declared excluded directories", () => {
	it("root nothing under them and follow no import into them, unless discovery names it", async () => {
		for (const git of [true, false]) {
			const root = await workspace(
				{
					"root.fake":
						'export class Root {}\nimport "./vendor/dep.fake";\nimport "./src/pkg/build/meta.fake";\n',
					"vendor/dep.fake": "export class Dep {}\n",
					[FORCED]: "export class Forced {}\n",
					"deep/obj/generated.fake": "export class Generated {}\n",
					"src/pkg/build/meta.fake": "export class Meta {}\n",
					"lib/marker.toml": "",
					"lib/build/out.fake": "export class Out {}\n",
				},
				git,
			);
			const store = open(root);
			const service = serviceOf(root, store, () => ["root.fake", FORCED]);
			await service.indexWorkspace();

			// A nested output name with no marker beside it is a source package.
			expect(store.indexedFiles().sort(), `git ${git}`).toEqual(["root.fake", "src/pkg/build/meta.fake", FORCED]);
			for (const module of ["deep/obj/generated.fake", "lib/build/out.fake", "vendor/dep.fake"])
				expect(service.moduleStatus(module), `git ${git} ${module}`).toMatchObject({
					claimed: false,
					unclaimedReason: EXCLUDED,
				});
			store.close();
		}
	});

	it("keep a held file discovery named until a new process discovers, and through each later discovery", async () => {
		const root = await workspace(
			{ "root.fake": "export class Root {}\n", [FORCED]: "export class Forced {}\n" },
			true,
		);
		const earlier = open(root);
		await serviceOf(root, earlier, () => ["root.fake", FORCED]).indexWorkspace();
		earlier.close();

		const store = open(root);
		const held: Held = {};
		const service = serviceOf(root, store, () => ["root.fake", FORCED], held);
		const keeps = async () => {
			expect(service.moduleStatus(FORCED)).toMatchObject({ claimed: true });
			const outcome = await service.gate.exclusive(() => service.indexFile(FORCED));
			expect(outcome.action).not.toBe("forgotten");
			expect(store.indexedFiles()).toContain(FORCED);
		};

		// Recovery's road: no scan yet.
		await service.currentScope();
		await keeps();
		// Scans held in discovery: this process's first, then a later one.
		for (let pass = 0; pass < 2; pass++) {
			let release = () => {};
			held.gate = new Promise((resolve) => {
				release = resolve;
			});
			const asked = new Promise<void>((resolve) => {
				held.reached = resolve;
			});
			const warming = service.warmupWorkspace();
			await asked;
			await keeps();
			release();
			await warming;
			expect(store.indexedFiles()).toContain(FORCED);
		}
		store.close();
	});

	it("forget an imported file on the batch whose discovery stops naming it", async () => {
		const root = await workspace(
			{
				"root.fake": `export class Root {}\nimport "./${FORCED}";\n`,
				[FORCED]: "export class Forced {}\n",
				"fake.json": "1",
			},
			true,
		);
		const store = open(root);
		let named = [FORCED];
		const service = serviceOf(root, store, () => ["root.fake", ...named]);
		await service.indexWorkspace();
		expect(store.indexedFiles()).toContain(FORCED);

		named = [];
		write(root, { "fake.json": "2" });
		await service.gate.exclusive(() =>
			service.applyBatch([{ kind: "changed", module: "fake.json", contentHash: "json-2" }]),
		);
		expect(store.indexedFiles()).toEqual(["root.fake"]);
		store.close();
	});
});
