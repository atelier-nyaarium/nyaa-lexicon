import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Declaration, Import } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderClaims, Route } from "../routing";
import { LexiconService } from "../service";
import { IndexStore } from "../store";
import type { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let service: LexiconService;

const claims: ProviderClaims = { providerId: "fake", language: "fake", extensions: [".fake"] };
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

function fakeSupervisor(discovered: string[] = []): ProviderSupervisor {
	const supervisor = {
		running: () => [claims],
		route: (module: string): Route =>
			module.endsWith(".fake")
				? { owned: true, providerId: claims.providerId }
				: { owned: false, reason: "unclaimed" },
		askProvider: async () => ({ files: discovered, externalRoots: [], configFiles: [], diagnostics: [] }),
		ask: async (_module: string, method: string, params: unknown) => {
			if (method === "parseFile") {
				const request = params as { module: string; contentHash: string; text: string };
				if (request.text.includes("POISON")) throw new Error("poisoned file");
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
					diagnostics: [],
				};
			}
			if (method === "resolveImport") {
				const request = params as { fromModule: string; specifier: string };
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
		service = new LexiconService(
			store,
			fakeSupervisor(["root.fake"]),
			(module) => {
				try {
					return readFileSync(path.join(root, module), "utf8");
				} catch {
					return null;
				}
			},
			root,
		);

		const outcomes = await service.indexWorkspace();

		expect(outcomes.filter((outcome) => outcome.action === "indexed").map((outcome) => outcome.module)).toEqual([
			"extra.fake",
			"root.fake",
		]);
		expect(service.findByName("Extra")).toHaveLength(1);
	});
});

describe("root exclusions and includes", () => {
	it("excludes generated roots until an explicit include names them", async () => {
		initGit();
		put(".gitattributes", "generated.fake linguist-generated\n");
		put("generated.fake", "export class Generated {}\n");
		put("ordinary.fake", "export class Ordinary {}\n");
		put("lexicon.json", JSON.stringify({ exclude: ["generated.fake"] }));
		service = new LexiconService(
			store,
			fakeSupervisor(),
			(module) => {
				try {
					return readFileSync(path.join(root, module), "utf8");
				} catch {
					return null;
				}
			},
			root,
		);

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
});

describe("reachability and failures", () => {
	it("keeps an out-of-scope import while referenced and prunes it after refactoring", async () => {
		initGit();
		put(".gitignore", "reachable.fake\n");
		put("root.fake", 'export class Root {}\nimport "./reachable.fake";\n');
		put("reachable.fake", "export class Reachable {}\n");
		service = new LexiconService(
			store,
			fakeSupervisor(),
			(module) => {
				try {
					return readFileSync(path.join(root, module), "utf8");
				} catch {
					return null;
				}
			},
			root,
		);

		await service.indexWorkspace();
		expect(service.findByName("Reachable")).toHaveLength(1);

		put("root.fake", "export class Root {}\n");
		const outcomes = await service.indexWorkspace();

		expect(service.findByName("Reachable")).toEqual([]);
		expect(outcomes).toContainEqual({
			module: "reachable.fake",
			action: "forgotten",
			reason: "no longer a root or reachable",
		});
	});

	it("keeps prior facts and continues after a poisoned workspace file", async () => {
		initGit();
		put("bad.fake", "export class Bad {}\n");
		put("good.fake", "export class Good {}\n");
		service = new LexiconService(
			store,
			fakeSupervisor(),
			(module) => {
				try {
					return readFileSync(path.join(root, module), "utf8");
				} catch {
					return null;
				}
			},
			root,
		);

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

	it("isolates a poisoned closure target", async () => {
		initGit();
		put(".gitignore", "reachable.fake\n");
		put("root.fake", 'export class Root {}\nimport "./reachable.fake";\n');
		put("reachable.fake", "export class Reachable {}\n");
		service = new LexiconService(
			store,
			fakeSupervisor(),
			(module) => {
				try {
					return readFileSync(path.join(root, module), "utf8");
				} catch {
					return null;
				}
			},
			root,
		);

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
		service = new LexiconService(
			store,
			fakeSupervisor(),
			(module) => {
				try {
					return readFileSync(path.join(root, module), "utf8");
				} catch {
					return null;
				}
			},
			root,
		);

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
