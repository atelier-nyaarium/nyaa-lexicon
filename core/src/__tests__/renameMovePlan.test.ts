import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	composeSymbolId,
	hashContent,
	type ImportResolution,
	type Range,
	type ResponseOf,
} from "@nyaa-lexicon/protocol";
import { ImportResolver, type ResolveSpecifier } from "../imports";
import type { CandidateParse, ProviderProbe } from "../providerProbe";
import { RefactorPlanner } from "../refactorPlanner";
import type { SourceWorkspace } from "../sourceWorkspace";
import type { FactsStamp, IndexStore, StoredDeclaration, StoredImport, StoredReference } from "../store";
import { askWith, stepWith } from "./steppedPlan";

////////////////////////////////
//  Helpers

const MODULE = "src/mod.ts";
const TARGET = "src/moved.ts";

const INDEXED: FactsStamp = { depth: "full", indexedAt: 1 };

function id(name: string, module: string = MODULE): string {
	return composeSymbolId({ language: "test", module, descriptors: [{ kind: "term", name }] });
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number): Range {
	return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

function sliced(text: string, span: Range): string {
	const lines = text.split("\n");
	const first = (lines[span.start.line] ?? "").slice(span.start.character);
	if (span.start.line === span.end.line) return first.slice(0, span.end.character - span.start.character);
	const last = (lines[span.end.line] ?? "").slice(0, span.end.character);
	return [first, ...lines.slice(span.start.line + 1, span.end.line), last].join("\n");
}

interface World {
	text: string;
	declarations: StoredDeclaration[];
	references?: StoredReference[];
	/** What the module's rows stand committed as; defaults to full facts. */
	stamp?: FactsStamp | null;
}

function storeFor(world: World): IndexStore {
	return {
		declaration: (symbolId: string) => world.declarations.find((d) => d.symbolId === symbolId) ?? null,
		declarationsIn: (module: string) => world.declarations.filter((d) => d.module === module),
		declarationsNamed: () => [],
		referencesTo: (symbolId: string) => (world.references ?? []).filter((row) => row.targetId === symbolId),
		referencesIn: (module: string) => (world.references ?? []).filter((row) => row.module === module),
		referencesSpelled: () => [],
		importsBinding: () => [],
		symbolIdsIn: (module: string) => world.declarations.filter((d) => d.module === module).map((d) => d.symbolId),
		contentHashOf: (module: string) => (module === MODULE ? hashContent(world.text) : null),
		stampOf: () => (world.stamp === undefined ? INDEXED : world.stamp),
	} as unknown as IndexStore;
}

function plannerFor(world: World): RefactorPlanner {
	const source = {
		symbolSourceRead: (address: { symbolId?: string }) => {
			const found = world.declarations.find((d) => d.symbolId === address.symbolId);
			if (found === undefined) throw new Error(`the world declares no ${address.symbolId}`);
			const text = sliced(world.text, found.range);
			return {
				found: true,
				module: MODULE,
				name: found.name,
				kind: found.kind,
				range: found.range,
				text,
				contentHash: hashContent(world.text),
				spanHash: hashContent(text),
				fileText: world.text,
			};
		},
		symbolSource: (address: { symbolId?: string }) => {
			const found = world.declarations.find((d) => d.symbolId === address.symbolId);
			if (found === undefined) return { found: false, reason: "not found" };
			const text = sliced(world.text, found.range);
			return {
				found: true,
				module: MODULE,
				name: found.name,
				kind: found.kind,
				range: found.range,
				text,
				contentHash: hashContent(world.text),
				spanHash: hashContent(text),
			};
		},
		writable: (module: string) => {
			if (module === MODULE) return { text: world.text };
			if (module === TARGET) return { text: null };
			return { refused: "unknown module" };
		},
		staleModules: (): string[] => [],
	};

	const probe: ProviderProbe = {
		owner: () => ({ owned: true, providerId: "test" }),
		declares: () => true,
		words: () => ({ keywords: [], builtins: [], literals: [] }),
		parseCandidate: (): Promise<CandidateParse> => Promise.reject(new Error("not asked")),
		renameEdits: async (_module, request) => ({
			status: "ready",
			edits: request.sites.map((site) => ({ range: site.range, newText: request.newName })),
			blocked: [],
		}),
		moveEdits: async (_module, request) => {
			const removal = request.role.removal;
			if (removal !== undefined) {
				return { status: "ready", edits: [{ range: removal, newText: "" }], blocked: [] };
			}
			const insertion = request.role.insertion;
			if (insertion !== undefined) {
				const at = { line: 0, character: 0 };
				return {
					status: "ready",
					edits: [{ range: { start: at, end: at }, newText: `${insertion.text}\n` }],
					blocked: [],
				};
			}
			return { status: "ready", edits: [], blocked: [] };
		},
	};

	const imports = { importSitesFor: async () => [], importSitesForMove: () => [] } as unknown as ImportResolver;

	return new RefactorPlanner(storeFor(world), imports, source as unknown as SourceWorkspace, probe);
}

////////////////////////////////
//  Tests

// The write must prove the plan's reads did not move.
describe("writing a rename only over the rows the plan read", () => {
	const text = ["function greet() {}", "", "greet();", ""].join("\n");

	function worldFor(): World {
		const greet = id("greet");
		return {
			text,
			declarations: [
				{
					factId: `decl:${greet}`,
					module: MODULE,
					symbolId: greet,
					kind: "function",
					name: "greet",
					range: range(0, 0, 0, 20),
					selectionRange: range(0, 9, 0, 14),
					visibility: "public",
				} as StoredDeclaration,
			],
			references: [
				{
					factId: `ref:${greet}`,
					module: MODULE,
					name: "greet",
					role: "call",
					targetId: greet,
					fromId: null,
					provenance: "bound",
					startLine: 2,
					startCharacter: 0,
					endLine: 2,
					endCharacter: 5,
				},
			],
		};
	}

	const stepOver = (world: World, between: () => void) =>
		stepWith(
			{
				planner: plannerFor(world),
				currentHashOf: (module) => (module === MODULE ? hashContent(world.text) : null),
				declarationsIn: () => world.declarations,
				store: storeFor(world),
				textOf: (module) => (module === MODULE ? world.text : ""),
			},
			"refactorRename",
			{ symbolId: id("greet"), newName: "shout" },
			between,
		);

	it("lands when the rows stand as the plan read them", async () => {
		const world = worldFor();

		const { outcome, written } = await stepOver(world, () => {});

		expect(outcome).toMatchObject({ renamed: true, modules: [MODULE] });
		expect(written).toEqual([{ module: MODULE, text: ["function shout() {}", "", "shout();", ""].join("\n") }]);
	});

	// An unchanged hash does not mean unchanged rows.
	it("refuses when the module was indexed again between the plan and the write", async () => {
		const world = worldFor();

		const { outcome, written } = await stepOver(world, () => {
			world.stamp = { depth: "full", indexedAt: 2 };
		});

		expect(outcome).toMatchObject({ renamed: false, reason: expect.stringMatching(/indexed again/) });
		expect(written).toEqual([]);
	});
});

// The write must prove the plan's reads did not move.
describe("writing a move only over the rows the plan read", () => {
	const text = "function alpha() {}\n";

	function worldFor(): World {
		const alpha = id("alpha");
		return {
			text,
			declarations: [
				{
					factId: `decl:${alpha}`,
					module: MODULE,
					symbolId: alpha,
					kind: "function",
					name: "alpha",
					range: range(0, 0, 0, 19),
					selectionRange: range(0, 9, 0, 14),
					visibility: "public",
				} as StoredDeclaration,
			],
		};
	}

	const stepOver = (world: World, between: () => void) =>
		stepWith(
			{
				planner: plannerFor(world),
				currentHashOf: (module) => (module === MODULE ? hashContent(world.text) : null),
				declarationsIn: () => world.declarations,
				store: storeFor(world),
			},
			"refactorMove",
			{ symbolId: id("alpha"), toModule: TARGET },
			between,
		);

	it("lands when the rows stand as the plan read them", async () => {
		const world = worldFor();

		const { outcome, written } = await stepOver(world, () => {});

		expect(outcome).toMatchObject({ moved: true, toModule: TARGET });
		expect(written).toEqual([
			{ module: MODULE, text: "\n" },
			{ module: TARGET, text: "function alpha() {}\n" },
		]);
	});

	// An unchanged hash does not mean unchanged rows.
	it("refuses when the module was indexed again between the plan and the write", async () => {
		const world = worldFor();

		const { outcome, written } = await stepOver(world, () => {
			world.stamp = { depth: "full", indexedAt: 2 };
		});

		expect(outcome).toMatchObject({ moved: false, reason: expect.stringMatching(/indexed again/) });
		expect(written).toEqual([]);
	});
});

////////////////////////////////
//  Import-only races: the module whose only stake in the plan is an import row

interface ImportWorld {
	texts: Record<string, string>;
	declarations: StoredDeclaration[];
	references?: StoredReference[];
	imports: StoredImport[];
	/** Per-module stamp; absent falls back to `INDEXED`. */
	stamps?: Record<string, FactsStamp | null>;
	/** Disk text overrides indexed text. */
	disk?: Record<string, string>;
}

function staleIn(world: ImportWorld, modules: string[]): string[] {
	return modules.filter((module) => {
		const disk = world.disk?.[module];
		return disk !== undefined && disk !== world.texts[module];
	});
}

function multiStoreFor(world: ImportWorld): IndexStore {
	return {
		declaration: (symbolId: string) => world.declarations.find((d) => d.symbolId === symbolId) ?? null,
		declarationsIn: (module: string) => world.declarations.filter((d) => d.module === module),
		declarationsNamed: () => [],
		referencesTo: (symbolId: string) => (world.references ?? []).filter((row) => row.targetId === symbolId),
		referencesIn: (module: string) => (world.references ?? []).filter((row) => row.module === module),
		referencesSpelled: () => [],
		importsBinding: () => [],
		importsNamed: (name: string) => world.imports.filter((row) => row.name === name),
		importsIn: (module: string) => world.imports.filter((row) => row.module === module),
		symbolIdsIn: (module: string) => world.declarations.filter((d) => d.module === module).map((d) => d.symbolId),
		contentHashOf: (module: string) => {
			const text = world.texts[module];
			return text === undefined ? null : hashContent(text);
		},
		stampOf: (module: string) => world.stamps?.[module] ?? INDEXED,
	} as unknown as IndexStore;
}

function multiPlannerFor(world: ImportWorld, resolve: ResolveSpecifier): RefactorPlanner {
	const source = {
		symbolSourceRead: (address: { symbolId?: string }) => {
			const found = world.declarations.find((d) => d.symbolId === address.symbolId);
			if (found === undefined) throw new Error(`the world declares no ${address.symbolId}`);
			const fileText = world.texts[found.module] as string;
			const text = sliced(fileText, found.range);
			return {
				found: true,
				module: found.module,
				name: found.name,
				kind: found.kind,
				range: found.range,
				text,
				contentHash: hashContent(fileText),
				spanHash: hashContent(text),
				fileText,
			};
		},
		symbolSource: (address: { symbolId?: string }) => {
			const found = world.declarations.find((d) => d.symbolId === address.symbolId);
			if (found === undefined) return { found: false, reason: "not found" };
			const fileText = world.texts[found.module] as string;
			const text = sliced(fileText, found.range);
			return {
				found: true,
				module: found.module,
				name: found.name,
				kind: found.kind,
				range: found.range,
				text,
				contentHash: hashContent(fileText),
				spanHash: hashContent(text),
			};
		},
		writable: (module: string) => {
			const text = world.disk?.[module] ?? world.texts[module];
			return { text: text === undefined ? null : text };
		},
		staleModules: (modules: string[]) => staleIn(world, modules),
	};

	const probe: ProviderProbe = {
		owner: () => ({ owned: true, providerId: "test" }),
		declares: () => true,
		words: () => ({ keywords: [], builtins: [], literals: [] }),
		parseCandidate: (): Promise<CandidateParse> => Promise.reject(new Error("not asked")),
		renameEdits: async (_module, request) => ({
			status: "ready",
			edits: request.sites.map((site) => ({ range: site.range, newText: request.newName })),
			blocked: [],
		}),
		moveEdits: async (_module, request) => {
			const removal = request.role.removal;
			if (removal !== undefined) {
				return { status: "ready", edits: [{ range: removal, newText: "" }], blocked: [] };
			}
			const insertion = request.role.insertion;
			if (insertion !== undefined) {
				const at = { line: 0, character: 0 };
				return {
					status: "ready",
					edits: [{ range: { start: at, end: at }, newText: `${insertion.text}\n` }],
					blocked: [],
				};
			}
			return { status: "ready", edits: [], blocked: [] };
		},
	};

	const imports = new ImportResolver(multiStoreFor(world), resolve);

	return new RefactorPlanner(multiStoreFor(world), imports, source as unknown as SourceWorkspace, probe);
}

// An import-only site is still a plan dependency.
describe("writing a rename only over the import row the plan read", () => {
	const LIB = "src/lib.ts";
	const helper = id("helper", LIB);
	const libText = "export function helper() {}\n";
	const importerText = "import { helper } from './lib.ts';\n";

	function worldFor(): ImportWorld {
		return {
			texts: { [LIB]: libText, [MODULE]: importerText },
			declarations: [
				{
					factId: `decl:${helper}`,
					module: LIB,
					symbolId: helper,
					kind: "function",
					name: "helper",
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 27 } },
					selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
					visibility: "public",
				} as StoredDeclaration,
			],
			imports: [
				{
					factId: "import:helper",
					module: MODULE,
					specifier: "./lib.ts",
					reExport: false,
					name: "helper",
					range: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
				},
			],
		};
	}

	const resolve: ResolveSpecifier = async (fromModule, specifier) =>
		fromModule === MODULE && specifier === "./lib.ts"
			? ({ status: "resolved", module: LIB } satisfies ImportResolution)
			: ({ status: "unresolved", reason: "NotIndexed" } satisfies ImportResolution);

	const stepOver = (world: ImportWorld, between: () => void) =>
		stepWith(
			{
				planner: multiPlannerFor(world, resolve),
				currentHashOf: (module) => {
					const text = world.texts[module];
					return text === undefined ? null : hashContent(text);
				},
				declarationsIn: (module) => world.declarations.filter((d) => d.module === module),
				store: multiStoreFor(world),
				textOf: (module) => world.texts[module] ?? "",
			},
			"refactorRename",
			{ symbolId: helper, newName: "shout" },
			between,
		);

	it("lands when the rows stand as the plan read them", async () => {
		const world = worldFor();

		const { outcome, written } = await stepOver(world, () => {});

		expect(outcome).toMatchObject({ renamed: true });
		expect(written).toContainEqual({ module: LIB, text: "export function shout() {}\n" });
		expect(written).toContainEqual({ module: MODULE, text: "import { shout } from './lib.ts';\n" });
	});

	// An unchanged hash does not mean unchanged rows.
	it("refuses when the importer's row was re-committed between the plan and the write", async () => {
		const world = worldFor();

		const { outcome, written } = await stepOver(world, () => {
			world.imports = [
				{
					...(world.imports[0] as StoredImport),
					range: { start: { line: 0, character: 10 }, end: { line: 0, character: 16 } },
				},
			];
			world.stamps = { [MODULE]: { depth: "full", indexedAt: 2 } };
		});

		expect(outcome).toMatchObject({ renamed: false, reason: expect.stringMatching(/indexed again/) });
		expect(written).toEqual([]);
	});
});

// The importer's reference stamp covers its import row too.
describe("refusing a move when the importer's rows moved, covered by its reference stamp", () => {
	const IMPORTER = "src/importer.ts";
	const alpha = id("alpha", MODULE);
	const moduleText = "function alpha() {}\n";
	const importerText = "import { alpha } from './mod.ts';\n\nalpha();\n";

	function worldFor(): ImportWorld {
		return {
			texts: { [MODULE]: moduleText, [IMPORTER]: importerText },
			declarations: [
				{
					factId: `decl:${alpha}`,
					module: MODULE,
					symbolId: alpha,
					kind: "function",
					name: "alpha",
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 19 } },
					selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
					visibility: "public",
				} as StoredDeclaration,
			],
			references: [
				{
					factId: "ref:alpha",
					module: IMPORTER,
					name: "alpha",
					role: "call",
					targetId: alpha,
					fromId: null,
					provenance: "bound",
					startLine: 2,
					startCharacter: 0,
					endLine: 2,
					endCharacter: 5,
				},
			],
			imports: [
				{
					factId: "import:alpha",
					module: IMPORTER,
					specifier: "./mod.ts",
					reExport: false,
					name: "alpha",
					range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
				},
			],
		};
	}

	const resolve: ResolveSpecifier = async (fromModule, specifier) =>
		fromModule === IMPORTER && specifier === "./mod.ts"
			? ({ status: "resolved", module: MODULE } satisfies ImportResolution)
			: ({ status: "unresolved", reason: "NotIndexed" } satisfies ImportResolution);

	const stepOver = (world: ImportWorld, between: () => void) =>
		stepWith(
			{
				planner: multiPlannerFor(world, resolve),
				currentHashOf: (module) => {
					const text = world.texts[module];
					return text === undefined ? null : hashContent(text);
				},
				declarationsIn: (module) => world.declarations.filter((d) => d.module === module),
				store: multiStoreFor(world),
			},
			"refactorMove",
			{ symbolId: alpha, toModule: TARGET },
			between,
		);

	it("lands when the rows stand as the plan read them", async () => {
		const world = worldFor();

		const { outcome, written } = await stepOver(world, () => {});

		expect(outcome).toMatchObject({ moved: true, toModule: TARGET });
		expect(written).toContainEqual({ module: MODULE, text: "\n" });
		expect(written).toContainEqual({ module: TARGET, text: "function alpha() {}\n" });
	});

	it("refuses when the importer's row was re-committed between the plan and the write", async () => {
		const world = worldFor();

		const { outcome, written } = await stepOver(world, () => {
			world.imports = [
				{
					...(world.imports[0] as StoredImport),
					range: { start: { line: 0, character: 10 }, end: { line: 0, character: 15 } },
				},
			];
			world.stamps = { [IMPORTER]: { depth: "full", indexedAt: 2 } };
		});

		expect(outcome).toMatchObject({ moved: false, reason: expect.stringMatching(/indexed again/) });
		expect(written).toEqual([]);
	});

	const previewOver = (world: ImportWorld) =>
		askWith(
			{
				planner: multiPlannerFor(world, resolve),
				currentHashOf: (module) => {
					const text = world.disk?.[module] ?? world.texts[module];
					return text === undefined ? null : hashContent(text);
				},
				declarationsIn: (module) => world.declarations.filter((d) => d.module === module),
				store: multiStoreFor(world),
				staleModules: (modules) => staleIn(world, modules),
			},
			"previewMove",
			{ symbolId: alpha, toModule: TARGET },
		);

	it("previews each file as the edits that make its text, writing nothing", async () => {
		const world = worldFor();

		const { answer, written } = await previewOver(world);

		const preview = answer as ResponseOf<"previewMove">;
		expect(preview.ok).toBe(true);
		expect(preview.files.map((file) => file.module).sort()).toEqual([MODULE, TARGET]);
		for (const file of preview.files) {
			const base = file.created ? "" : (world.texts[file.module] as string);
			expect(applyEdits(base, file.edits)).toEqual({ text: file.text });
		}
		expect(written).toEqual([]);
	});

	// Move edits depend on stored ranges.
	it("refuses a preview when the source or an importer changed since indexing", async () => {
		for (const module of [MODULE, IMPORTER]) {
			const world = worldFor();
			world.disk = { [module]: `// edited\n${world.texts[module]}` };

			const { answer } = await previewOver(world);

			expect(answer).toMatchObject({ ok: false, files: [] });
		}
	});
});
