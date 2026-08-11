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
				const diagnostics = request.text.includes("SYNTAX")
					? [{ severity: "error" as const, message: "syntax error" }]
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

	it("forgets a root that vanishes before the next scan", async () => {
		initGit();
		put("root.fake", "export class Root {}\n");
		execFileSync("git", ["add", "root.fake"], { cwd: root });
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

		await service.indexWorkspace();
		rmSync(path.join(root, "root.fake"));
		const outcomes = await service.indexWorkspace();

		expect(service.findByName("Root")).toEqual([]);
		expect(outcomes).toContainEqual({ module: "root.fake", action: "forgotten", reason: "file is gone" });
	});

	it("moves indexed facts with a live rename batch", async () => {
		initGit();
		put("before.fake", "export class Before {}\n");
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
	it("keeps an out-of-scope import tree while referenced and prunes it after a live refactor", async () => {
		initGit();
		put(".gitignore", "reachable.fake\nleaf.fake\n");
		put("root.fake", "export class Root {}\n");
		put("reachable.fake", 'export class Reachable {}\nimport "./leaf.fake";\n');
		put("leaf.fake", "export class Leaf {}\n");
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

	it("prunes an imported tree when its only root is deleted", async () => {
		initGit();
		put(".gitignore", "reachable.fake\nleaf.fake\n");
		put("root.fake", 'export class Root {}\nimport "./reachable.fake";\n');
		put("reachable.fake", 'export class Reachable {}\nimport "./leaf.fake";\n');
		put("leaf.fake", "export class Leaf {}\n");
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

		expect(service.findByName("Depth11")).toHaveLength(1);
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

	it("keeps prior facts while a live file has syntax errors", async () => {
		initGit();
		put(".gitignore", "reachable.fake\n");
		put("root.fake", 'export class Before {}\nimport "./reachable.fake";\n');
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
