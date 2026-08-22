import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Declaration, Import } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderClaims, Route } from "../routing";
import { LexiconService } from "../service";
import { MAX_SOURCE_BYTES, sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import type { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let service: LexiconService;

const claims: ProviderClaims = { providerId: "fake", language: "fake", extensions: [".fake"] };
const dataClaims: ProviderClaims = {
	providerId: "fakedata",
	language: "fakedata",
	extensions: [".fdata"],
	content: "data",
};
const point = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function put(module: string, text: string): void {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

function initGit(): void {
	execFileSync("git", ["init", "-q"], { cwd: root });
}

function declaration(module: string, name: string): Declaration {
	return {
		symbolId: `lexicon fake ${module} ${name}.`,
		kind: "class",
		name,
		range: point,
		selectionRange: point,
		visibility: "public",
		exported: true,
	};
}

function importsFrom(text: string): Import[] {
	return [...text.matchAll(/import\s+["']([^"']+)["']/g)].map((match) => ({
		specifier: match[1] as string,
		imported: [],
		reExport: false,
	}));
}

function fakeSupervisor(
	discovered: string[] = [],
	parseRequests: Array<{ module: string; depth?: "full" | "surface" }> = [],
): ProviderSupervisor {
	const supervisor = {
		running: () => [claims, dataClaims],
		route: (module: string): Route =>
			module.endsWith(".fake")
				? { owned: true, providerId: claims.providerId, content: "code" }
				: module.endsWith(".fdata")
					? { owned: true, providerId: dataClaims.providerId, content: "data" }
					: { owned: false, reason: "unclaimed" },
		askProvider: async () => ({ files: discovered, externalRoots: [], configFiles: [], diagnostics: [] }),
		ask: async (_module: string, method: string, params: unknown) => {
			if (method === "parseFile") {
				const request = params as {
					module: string;
					contentHash: string;
					text: string;
					depth?: "full" | "surface";
				};
				parseRequests.push({
					module: request.module,
					...(request.depth === undefined ? {} : { depth: request.depth }),
				});
				if (request.text.includes("POISON")) throw new Error("poisoned file");
				const diagnostics = request.text.includes("SYNTAX")
					? [{ severity: "error" as const, message: "syntax error" }]
					: request.text.includes("WARN")
						? [{ severity: "warning" as const, message: "duplicate key" }]
						: [];
				const declarations = [...request.text.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)].map((match) =>
					declaration(request.module, match[1] as string),
				);
				return {
					module: request.module,
					contentHash: request.contentHash,
					declarations,
					references: [],
					imports: importsFrom(request.text),
					literals: [],
					diagnostics,
				};
			}
			if (method === "resolveImport") {
				const request = params as { fromModule: string; specifier: string };
				if (request.specifier.startsWith("external:")) {
					return {
						status: "external",
						packageName: "fixture",
						surface: { module: request.specifier.slice("external:".length) },
					};
				}
				if (!request.specifier.startsWith(".")) return { status: "unresolved", reason: "NotImplemented" };
				return {
					status: "resolved",
					module: path.posix.normalize(
						path.posix.join(path.posix.dirname(request.fromModule), request.specifier),
					),
				};
			}
			throw new Error(`unexpected method ${method}`);
		},
		stopAll: () => {},
	} as unknown as ProviderSupervisor;
	return supervisor;
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-workspace-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("workspace roots", () => {
	it("adds git-visible claimed files to provider discovery", async () => {
		initGit();
		put("root.fake", "export class Root {}\n");
		put("extra.fake", "export class Extra {}\n");
		service = new LexiconService(store, fakeSupervisor(["root.fake"]), sourceReader(root), root);

		const outcomes = await service.indexWorkspace();

		expect(outcomes.filter((outcome) => outcome.action === "indexed").map((outcome) => outcome.module)).toEqual([
			"extra.fake",
			"root.fake",
		]);
		expect(service.findByName("Extra")).toHaveLength(1);
	});

	it("forgets a root that vanishes before the next scan", async () => {
		initGit();
		put("root.fake", "export class Root {}\n");
		execFileSync("git", ["add", "root.fake"], { cwd: root });
		service = new LexiconService(store, fakeSupervisor(["root.fake"]), sourceReader(root), root);

		await service.indexWorkspace();
		rmSync(path.join(root, "root.fake"));
		const outcomes = await service.indexWorkspace();

		expect(service.findByName("Root")).toEqual([]);
		expect(outcomes).toContainEqual({ module: "root.fake", action: "forgotten", reason: "file is gone" });
	});

	it("moves indexed facts with a live rename batch", async () => {
		initGit();
		put("before.fake", "export class Before {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		rmSync(path.join(root, "before.fake"));
		put("after.fake", "export class After {}\n");
		await service.applyBatch([
			{ kind: "deleted", module: "before.fake" },
			{ kind: "changed", module: "after.fake", contentHash: "after-1" },
		]);

		expect(service.findByName("Before")).toEqual([]);
		expect(service.findByName("After")).toHaveLength(1);
	});
});

describe("root exclusions and includes", () => {
	it("does not parse a denied direct index request", async () => {
		initGit();
		put("lexicon.json", JSON.stringify({ deny: ["reference.fake"] }));
		put("reference.fake", "export class Reference {}\n");
		const requests: Array<{ module: string; depth?: "full" | "surface" }> = [];
		service = new LexiconService(store, fakeSupervisor([], requests), sourceReader(root), root);

		await expect(service.indexFile("reference.fake")).resolves.toEqual({
			module: "reference.fake",
			action: "skipped",
			reason: "denied by scope",
		});
		expect(requests).toEqual([]);
	});

	it("excludes generated roots until an explicit include names them", async () => {
		initGit();
		put(".gitattributes", "generated.fake linguist-generated\n");
		put("generated.fake", "export class Generated {}\n");
		put("ordinary.fake", "export class Ordinary {}\n");
		put("lexicon.json", JSON.stringify({ exclude: ["generated.fake"] }));
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		expect(service.findByName("Generated")).toEqual([]);
		expect(service.findByName("Ordinary")).toHaveLength(1);

		put("lexicon.json", JSON.stringify({ include: ["generated.fake"], exclude: ["generated.fake"] }));
		await service.indexWorkspace();
		expect(service.findByName("Generated")).toHaveLength(1);

		put("lexicon.json", JSON.stringify({ exclude: ["generated.fake"] }));
		const outcomes = await service.indexWorkspace();
		expect(service.findByName("Generated")).toEqual([]);
		expect(outcomes).toContainEqual({
			module: "generated.fake",
			action: "forgotten",
			reason: "no longer a root or reachable",
		});
	});

	it("passes configured bundle roots and reachable files to providers at surface depth", async () => {
		initGit();
		put(".gitignore", "opaque/\n");
		put("root.fake", 'export class Root {}\nimport "./opaque/runtime.fake";\n');
		put("opaque/runtime.fake", "export class Runtime {}\n");
		put("lexicon.json", JSON.stringify({ bundles: ["opaque/**"] }));
		const requests: Array<{ module: string; depth?: "full" | "surface" }> = [];
		service = new LexiconService(store, fakeSupervisor([], requests), sourceReader(root), root);

		await service.indexWorkspace();

		expect(requests.find((request) => request.module === "root.fake")).toEqual({ module: "root.fake" });
		expect(requests.find((request) => request.module === "opaque/runtime.fake")).toEqual({
			module: "opaque/runtime.fake",
			depth: "surface",
		});
	});
});

describe("reachability and failures", () => {
	it("indexes an external surface without treating the package as a workspace module", async () => {
		initGit();
		put(".gitignore", "external.fake\n");
		put("root.fake", 'export class Root {}\nimport "external:external.fake";\n');
		put("external.fake", "export class External {}\n");
		const requests: Array<{ module: string; depth?: "full" | "surface" }> = [];
		service = new LexiconService(store, fakeSupervisor([], requests), sourceReader(root), root);

		await service.indexWorkspace();

		expect(service.findByName("External")).toHaveLength(1);
		expect(requests.find((request) => request.module === "external.fake")).toEqual({
			module: "external.fake",
			depth: "surface",
		});
	});

	it("omits dependency modules from the overview", async () => {
		initGit();
		put(".gitignore", "node_modules/\n");
		put("root.fake", 'export class Root {}\nimport "external:node_modules/fixture/index.fake";\n');
		put("node_modules/fixture/index.fake", "export class External {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();

		expect(service.overview()).toMatchObject({
			files: 1,
			symbols: 1,
			references: 0,
			imports: 1,
			literals: 0,
			modules: 1,
			largest: [{ module: "root.fake", symbols: 1 }],
		});
	});

	it("counts and ranks data files apart from code", async () => {
		initGit();
		put("root.fake", "export class Root {}\n");
		put("fixtures/specs.fdata", "export class A {}\nexport class B {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();

		expect(service.overview()).toMatchObject({
			content: {
				files: { code: 1, data: 1, document: 0, unknown: 0 },
				symbols: { code: 1, data: 2, document: 0, unknown: 0 },
			},
			largest: [{ module: "root.fake", symbols: 1 }],
			largestData: [{ module: "fixtures/specs.fdata", symbols: 2, content: "data" }],
		});
	});

	it("classes a file kept by an earlier release on the next scan, without re-reading it", async () => {
		initGit();
		put("root.fake", "export class Root {}\n");
		put("specs.fdata", "export class A {}\n");
		const parsed: Array<{ module: string }> = [];
		service = new LexiconService(store, fakeSupervisor([], parsed), sourceReader(root), root);
		await service.indexWorkspace();
		store.close();

		const file = path.join(root, "index.sqlite");
		const raw = new DatabaseSync(file);
		raw.exec("ALTER TABLE files DROP COLUMN content");
		raw.close();
		store = IndexStore.open(file).store;
		service = new LexiconService(store, fakeSupervisor([], parsed), sourceReader(root), root);
		expect(service.overview().content.files).toEqual({ code: 0, data: 0, document: 0, unknown: 2 });

		// The daemon's start-up scan.
		parsed.length = 0;
		await service.warmupWorkspace();

		expect(parsed).toEqual([]);
		expect(service.overview().content.files).toEqual({ code: 1, data: 1, document: 0, unknown: 0 });
	});

	it("keeps an out-of-scope import tree while referenced and prunes it after a live refactor", async () => {
		initGit();
		put(".gitignore", "reachable.fake\nleaf.fake\n");
		put("root.fake", "export class Root {}\n");
		put("reachable.fake", 'export class Reachable {}\nimport "./leaf.fake";\n');
		put("leaf.fake", "export class Leaf {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		expect(service.findByName("Reachable")).toEqual([]);
		expect(service.findByName("Leaf")).toEqual([]);

		put("root.fake", 'export class Root {}\nimport "./reachable.fake";\n');
		await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-2" }]);
		expect(service.findByName("Reachable")).toHaveLength(1);
		expect(service.findByName("Leaf")).toHaveLength(1);

		put("root.fake", "export class Root {}\n");
		const outcomes = await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-3" }]);

		expect(service.findByName("Reachable")).toEqual([]);
		expect(service.findByName("Leaf")).toEqual([]);
		expect(outcomes).toContainEqual({
			module: "reachable.fake",
			action: "forgotten",
			reason: "no longer a root or reachable",
		});
		expect(outcomes).toContainEqual({
			module: "leaf.fake",
			action: "forgotten",
			reason: "no longer a root or reachable",
		});
	});

	it("denies imported files and prunes their prior facts after a config change", async () => {
		initGit();
		put("root.fake", 'export class Root {}\nimport "./reference/entry.fake";\n');
		put("reference/entry.fake", "export class Reference {}\n");
		const requests: Array<{ module: string; depth?: "full" | "surface" }> = [];
		service = new LexiconService(store, fakeSupervisor([], requests), sourceReader(root), root);

		await service.indexWorkspace();
		expect(service.findByName("Reference")).toHaveLength(1);
		expect(requests.filter((request) => request.module === "reference/entry.fake")).toHaveLength(1);

		put("lexicon.json", JSON.stringify({ deny: ["reference/**"] }));
		const outcomes = await service.applyBatch([
			{ kind: "changed", module: "lexicon.json", contentHash: "scope-deny" },
		]);

		expect(service.findByName("Reference")).toEqual([]);
		expect(requests.filter((request) => request.module === "reference/entry.fake")).toHaveLength(1);
		expect(outcomes).toContainEqual({
			module: "reference/entry.fake",
			action: "forgotten",
			reason: "no longer a root or reachable",
		});
	});

	it("prunes an imported tree when its only root is deleted", async () => {
		initGit();
		put(".gitignore", "reachable.fake\nleaf.fake\n");
		put("root.fake", 'export class Root {}\nimport "./reachable.fake";\n');
		put("reachable.fake", 'export class Reachable {}\nimport "./leaf.fake";\n');
		put("leaf.fake", "export class Leaf {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		rmSync(path.join(root, "root.fake"));
		await service.applyBatch([{ kind: "deleted", module: "root.fake" }]);

		expect(service.findByName("Root")).toEqual([]);
		expect(service.findByName("Reachable")).toEqual([]);
		expect(service.findByName("Leaf")).toEqual([]);
	});

	it("indexes an import tree to its fixpoint", async () => {
		initGit();
		put(".gitignore", "hidden/\n");
		put("root.fake", 'export class Root {}\nimport "./hidden/0.fake";\n');
		for (let depth = 0; depth < 12; depth++) {
			const next = depth === 11 ? "" : `\nimport "./${depth + 1}.fake";`;
			put(`hidden/${depth}.fake`, `export class Depth${depth} {}${next}\n`);
		}
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();

		expect(service.findByName("Depth11")).toHaveLength(1);
	});

	it("keeps prior facts and continues after a poisoned workspace file", async () => {
		initGit();
		put("bad.fake", "export class Bad {}\n");
		put("good.fake", "export class Good {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		put("bad.fake", "POISON\n");
		put("good.fake", "export class GoodUpdated {}\n");
		const outcomes = await service.indexWorkspace();

		expect(outcomes).toContainEqual({
			module: "bad.fake",
			action: "skipped",
			reason: "parse failed",
			failure: "poisoned file",
		});
		expect(service.findByName("Bad")).toHaveLength(1);
		expect(service.findByName("GoodUpdated")).toHaveLength(1);
		expect(service.indexStatus()).toMatchObject({ state: "ready", failures: 1 });
		expect(service.overview().index).toMatchObject({ failures: 1 });
	});

	it("keeps a warning beside the file's facts rather than failing the file", async () => {
		initGit();
		put("noted.fake", "export class Noted {} // WARN\n");
		put("clean.fake", "export class Clean {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();

		expect(service.findByName("Noted")).toHaveLength(1);
		expect(service.indexStatus().failures).toBe(0);
		expect(service.fileNotes("noted.fake")).toEqual({
			module: "noted.fake",
			known: true,
			notes: [{ severity: "warning", message: "duplicate key" }],
		});
		expect(service.fileNotes("clean.fake")).toEqual({ module: "clean.fake", known: true, notes: [] });
		expect(service.overview().notes).toEqual({ noted: 1, unknown: 0 });
	});

	it("records a binary and an oversized file as failures with the reason, holding no facts", async () => {
		initGit();
		put("ok.fake", "export class Ok {}\n");
		writeFileSync(path.join(root, "blob.fake"), Buffer.from([0x65, 0x00, 0x66]));
		writeFileSync(path.join(root, "big.fake"), Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61));
		const parseRequests: Array<{ module: string }> = [];
		service = new LexiconService(store, fakeSupervisor([], parseRequests), sourceReader(root), root);

		const outcomes = await service.indexWorkspace();

		expect(service.findByName("Ok")).toHaveLength(1);
		expect(outcomes).toContainEqual({
			module: "blob.fake",
			action: "skipped",
			reason: "parse failed",
			failure: expect.stringContaining("NUL"),
		});
		expect(store.parseFailures()).toEqual([
			{
				module: "big.fake",
				reason: `${MAX_SOURCE_BYTES + 1} bytes, past the ${MAX_SOURCE_BYTES} byte limit for indexing`,
			},
			{ module: "blob.fake", reason: "not text: a NUL byte within the first 8 KiB" },
		]);
		expect(store.declarationsIn("blob.fake")).toEqual([]);
		expect(store.declarationsIn("big.fake")).toEqual([]);
		// Neither reached the provider.
		expect(parseRequests.map((request) => request.module)).toEqual(["ok.fake"]);
	});

	it("keeps prior facts while a live file has syntax errors", async () => {
		initGit();
		put(".gitignore", "reachable.fake\n");
		put("root.fake", 'export class Before {}\nimport "./reachable.fake";\n');
		put("reachable.fake", "export class Reachable {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		put("root.fake", "SYNTAX\nexport class After {}\n");
		const broken = await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-broken" }]);

		expect(broken).toContainEqual({
			module: "root.fake",
			action: "skipped",
			reason: "parse failed",
			failure: "syntax error",
		});
		expect(service.findByName("Before")).toHaveLength(1);
		expect(service.findByName("After")).toEqual([]);
		expect(service.findByName("Reachable")).toHaveLength(1);

		put("root.fake", "export class After {}\n");
		await service.applyBatch([{ kind: "changed", module: "root.fake", contentHash: "root-green" }]);
		expect(service.findByName("Before")).toEqual([]);
		expect(service.findByName("After")).toHaveLength(1);
		expect(service.findByName("Reachable")).toEqual([]);
	});

	it("isolates a poisoned closure target", async () => {
		initGit();
		put(".gitignore", "reachable.fake\n");
		put("root.fake", 'export class Root {}\nimport "./reachable.fake";\n');
		put("reachable.fake", "export class Reachable {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		put("reachable.fake", "POISON\n");
		const outcomes = await service.indexWorkspace();

		expect(outcomes).toContainEqual({
			module: "reachable.fake",
			action: "skipped",
			reason: "parse failed",
			failure: "poisoned file",
		});
		expect(service.findByName("Reachable")).toHaveLength(1);
	});

	it("isolates a poisoned watcher event from later events", async () => {
		initGit();
		put("bad.fake", "export class Bad {}\n");
		put("good.fake", "export class Good {}\n");
		service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root);

		await service.indexWorkspace();
		put("bad.fake", "POISON\n");
		put("good.fake", "export class GoodUpdated {}\n");
		const outcomes = await service.applyBatch([
			{ kind: "changed", module: "bad.fake", contentHash: "bad-2" },
			{ kind: "changed", module: "good.fake", contentHash: "good-2" },
		]);

		expect(outcomes[0]).toMatchObject({ action: "skipped", reason: "parse failed" });
		expect(outcomes[1]).toMatchObject({ action: "indexed", module: "good.fake" });
		expect(service.findByName("Bad")).toHaveLength(1);
		expect(service.findByName("GoodUpdated")).toHaveLength(1);
	});
});
