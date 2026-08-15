import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Declaration, Import, IndexDepth } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderClaims, Route } from "../routing";
import { LexiconService } from "../service";
import { IndexStore } from "../store";
import { type ProviderSupervisor, ProviderUnavailableError } from "../supervisor";

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

interface ParseSeen {
	module: string;
	depth?: IndexDepth;
}

/** Controls whether outline requests are echoed or served as full facts. */
function depthSupervisor(discovered: string[], honorOutline: boolean, seen: ParseSeen[]): ProviderSupervisor {
	return {
		running: () => [claims],
		route: (module: string): Route =>
			module.endsWith(".fake")
				? { owned: true, providerId: claims.providerId }
				: { owned: false, reason: "unclaimed" },
		askProvider: async () => ({ files: discovered, externalRoots: [], configFiles: [], diagnostics: [] }),
		ask: async (_module: string, method: string, params: unknown) => {
			if (method === "parseFile") {
				const request = params as { module: string; contentHash: string; text: string; depth?: IndexDepth };
				seen.push({ module: request.module, ...(request.depth === undefined ? {} : { depth: request.depth }) });
				if (request.text.includes("DEAD")) throw new ProviderUnavailableError("provider exited with code null");
				if (request.text.includes("POISON")) throw new Error("poisoned file");
				const declarations = [...request.text.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)].map((match) =>
					declaration(request.module, match[1] as string),
				);
				const outlined = honorOutline && request.depth === "outline";
				return {
					module: request.module,
					contentHash: request.contentHash,
					declarations,
					references: [],
					imports: importsFrom(request.text),
					// Full parsing must retain this literal.
					literals: outlined ? [] : [{ kind: "string" as const, value: "full-only", range: point }],
					diagnostics: [],
					...(outlined ? { depth: "outline" as const } : {}),
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
}

function serviceOver(supervisor: ProviderSupervisor): LexiconService {
	return new LexiconService(
		store,
		supervisor,
		(module) => {
			try {
				return readFileSync(path.join(root, module), "utf8");
			} catch {
				return null;
			}
		},
		root,
	);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-warmup-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("warmup pass", () => {
	it("stores honored outline facts as outline, then upgrades them to full", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		const seen: ParseSeen[] = [];
		service = serviceOver(depthSupervisor(["a.fake", "b.fake"], true, seen));

		await service.warmupWorkspace();
		// The warmup genuinely asked for outline, not full facts it then discarded.
		expect(seen.map((p) => p.depth)).toEqual(["outline", "outline"]);
		expect(store.depthTotals()).toMatchObject({ outline: 2, full: 0 });
		expect(service.findByName("A")).toHaveLength(1);

		await service.upgradeRemaining();
		expect(store.depthTotals()).toMatchObject({ outline: 0, full: 2 });
		const status = service.indexStatus();
		expect(status.outlineFiles).toBe(0);
		expect(status.fullFiles).toBe(2);
	});

	it("records full when a provider ignores the outline request, owing no upgrade", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		const seen: ParseSeen[] = [];
		service = serviceOver(depthSupervisor(["a.fake"], false, seen));

		await service.warmupWorkspace();
		expect(store.depthTotals()).toMatchObject({ outline: 0, full: 1 });

		await service.upgradeRemaining();
		// One parse total: the silent full answer left nothing owed.
		expect(seen.filter((p) => p.module === "a.fake")).toHaveLength(1);
	});

	it("does not demote a full store on a warm restart, and skips unchanged files entirely", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		const seen: ParseSeen[] = [];
		service = serviceOver(depthSupervisor(["a.fake"], true, seen));

		await service.warmupWorkspace();
		await service.upgradeRemaining();
		const parses = seen.length;

		await service.warmupWorkspace();
		expect(store.depthTotals()).toMatchObject({ outline: 0, full: 1 });
		expect(seen.length).toBe(parses);
	});

	it("serves a requestFull order before the background backlog", async () => {
		initGit();
		const modules = ["a.fake", "b.fake", "c.fake", "d.fake", "z.fake"];
		for (const module of modules) put(module, `export class C${module[0]?.toUpperCase()} {}\n`);
		service = serviceOver(depthSupervisor(modules, true, []));

		await service.warmupWorkspace();
		// The upgrade is mid-flight when the order arrives, so this exercises real preemption:
		// z sorts last in the backlog, and the order must beat the alphabetical walk to it.
		const upgrading = service.upgradeRemaining();
		await service.ensureTreeForModule("z.fake");
		const outlineAtOrderTime = store.depthTotals().outline;

		expect(store.depthOf("z.fake")).toBe("full");
		expect(outlineAtOrderTime).toBeGreaterThan(0);
		await upgrading;
		expect(store.depthTotals().outline).toBe(0);
	});

	it("pulls a symbol's direct imports into the ordered tree", async () => {
		initGit();
		put("a.fake", 'import "./b.fake"\nexport class A {}\n');
		put("b.fake", "export class B {}\n");
		put("c.fake", "export class C {}\n");
		service = serviceOver(depthSupervisor(["a.fake", "b.fake", "c.fake"], true, []));

		await service.warmupWorkspace();
		const [found] = service.findByName("A");
		await service.ensureTreeFor((found as { symbolId: string }).symbolId);

		expect(store.depthOf("a.fake")).toBe("full");
		expect(store.depthOf("b.fake")).toBe("full");
		expect(store.depthOf("c.fake")).toBe("outline");
	});

	it("persists a parse failure, skips it in the upgrade, and clears it on recovery", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		put("bad.fake", "POISON\n");
		service = serviceOver(depthSupervisor(["a.fake", "bad.fake"], true, []));

		await service.warmupWorkspace();
		expect(store.parseFailures().map((f) => f.module)).toEqual(["bad.fake"]);

		await service.upgradeRemaining();
		expect(store.depthOf("a.fake")).toBe("full");
		// The drain resolves, and the failed module honestly remains incomplete.
		expect(service.indexStatus().failures).toBe(1);

		put("bad.fake", "export class Fixed {}\n");
		await service.indexFile("bad.fake");
		expect(store.parseFailures()).toEqual([]);
	});

	it("classifies a dead provider as unavailable, blaming no file", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		put("gone.fake", "DEAD\n");
		service = serviceOver(depthSupervisor(["a.fake", "gone.fake"], true, []));

		const outcomes = await service.warmupWorkspace();
		const skipped = outcomes.find((outcome) => outcome.module === "gone.fake");

		expect(skipped).toMatchObject({ action: "skipped", reason: "provider unavailable" });
		// Provider outages do not create per-file failure records.
		expect(store.parseFailures()).toEqual([]);
		expect(service.indexStatus().failures).toBe(0);
	});
});

describe("accounting for every file the scan saw", () => {
	// The parts must sum, or a reader cannot tell a defect from a readme.
	it("splits tracked files into disjoint parts that add up", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		put("README.md", "# readme\n");
		put("data.json", "{}\n");
		service = serviceOver(depthSupervisor(["a.fake", "b.fake"], true, []));

		await service.warmupWorkspace();
		const scan = store.readScanSummary();

		expect(scan).not.toBeNull();
		const { tracked, claimed, unclaimed, generated, denied } = scan as NonNullable<typeof scan>;
		expect(claimed).toBe(2);
		// At least the readme and the json. The harness also writes its sqlite files here, and they
		// are unclaimed too, which is exactly the kind of file this accounting exists to explain.
		expect(unclaimed).toBeGreaterThanOrEqual(2);
		expect(claimed + unclaimed + generated + denied).toBe(tracked);
	});

	// A watcher batch recomputed the counts and then never stored them.
	it("refreshes the stored summary after a watcher batch", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		service = serviceOver(depthSupervisor(["a.fake"], true, []));
		await service.warmupWorkspace();
		expect(store.readScanSummary()?.claimed).toBe(1);

		put("b.fake", "export class B {}\n");
		await service.applyBatch([{ kind: "changed", module: "b.fake", contentHash: "b1" }]);

		expect(store.readScanSummary()?.claimed).toBe(2);
	});

	// Defaulting a missing part would print arithmetic that does not sum.
	it("refuses a summary missing any part", () => {
		store.writeScanSummary({ tracked: 5, claimed: 5, unclaimed: 0, generated: 0, denied: 0 });
		expect(store.readScanSummary()?.tracked).toBe(5);

		// biome-ignore lint/suspicious/noExplicitAny: writing a legacy shape is the point.
		store.writeScanSummary({ discovered: 5, claimed: 5 } as any);
		expect(store.readScanSummary()).toBeNull();
	});
});
