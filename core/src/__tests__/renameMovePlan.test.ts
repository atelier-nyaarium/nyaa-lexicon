import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	composeSymbolId,
	hashContent,
	type ImportResolution,
	type Landing,
	type Range,
	type ResponseOf,
} from "@nyaa-lexicon/protocol";
import { ImportResolver, type ResolveSpecifier } from "../imports";
import type { CandidateParse, ProviderProbe } from "../providerProbe";
import { ReadContext } from "../readContext";
import { RefactorPlanner } from "../refactorPlanner";
import { routeChanged } from "../refusals";
import type { SourceWorkspace } from "../sourceWorkspace";
import type { FactsStamp, IndexStore, StoredDeclaration, StoredImport, StoredReference } from "../store";
import { EMPTY_READS } from "./emptyReads";
import { edge, landed } from "./importEdges";
import { askWith, stepWith } from "./steppedPlan";

////////////////////////////////
//  Helpers

const MODULE = "src/mod.ts";
const TARGET = "src/moved.ts";

const INDEXED: FactsStamp = { depth: "full", indexedAt: 1 };

/** The candidate proof has its own tests; these test what surrounds it. */
const PROVED = async () => [];

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
		...EMPTY_READS,
		declaration: (symbolId: string) => world.declarations.find((d) => d.symbolId === symbolId) ?? null,
		declarationsIn: (module: string) => world.declarations.filter((d) => d.module === module),
		referencesTo: (symbolId: string) => (world.references ?? []).filter((row) => row.targetId === symbolId),
		referencesIn: (module: string) => (world.references ?? []).filter((row) => row.module === module),
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
				const newText = `${insertion.exported === true ? "export " : ""}${insertion.text}`;
				return { status: "ready", edits: [{ range: { start: at, end: at }, newText }], blocked: [] };
			}
			return { status: "ready", edits: [], blocked: [] };
		},
		arrangeEdits: () => Promise.reject(new Error("not asked")),
		importEdits: () => Promise.reject(new Error("not asked")),
		probeBatch: () => Promise.reject(new Error("not asked")),
	};

	const imports = {
		importSitesResolvingTo: async () => [],
	} as unknown as ImportResolver;

	return new RefactorPlanner(storeFor(world), imports, source as unknown as SourceWorkspace, probe, PROVED);
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
					qualified: null,
					provenance: "bound",
					startLine: 2,
					startCharacter: 0,
					endLine: 2,
					endCharacter: 5,
					origin: { kind: "declaration" },
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

describe("moving a declaration something left behind still uses", () => {
	it("asks the target to export it when it is not exported now", async () => {
		const alpha = id("alpha");
		const world: World = {
			text: "function alpha() {}\n\nalpha();\n",
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
					exported: false,
				} as StoredDeclaration,
			],
			references: [
				{
					factId: `ref:${alpha}`,
					module: MODULE,
					name: "alpha",
					role: "call",
					targetId: alpha,
					fromId: null,
					qualified: null,
					provenance: "bound",
					startLine: 2,
					startCharacter: 0,
					endLine: 2,
					endCharacter: 5,
					origin: null,
				},
			],
		};

		const { written } = await stepWith(
			{
				planner: plannerFor(world),
				currentHashOf: (module) => (module === MODULE ? hashContent(world.text) : null),
				declarationsIn: () => world.declarations,
				store: storeFor(world),
			},
			"refactorMove",
			{ symbolId: alpha, toModule: TARGET },
			() => {},
		);

		expect(written).toContainEqual({ module: TARGET, text: "export function alpha() {}\n" });
	});
});

// The write must prove the plan's reads did not move.
// The undo of a move: the old home still imports what moves back into it.
describe("moving a declaration into a module that imports it", () => {
	it("asks that module once, with its import sites, so its edits share one base and land as one file", async () => {
		const texts: Record<string, string> = {
			[MODULE]: "export function greet() {}\n",
			[TARGET]: 'import { greet } from "./mod";\ngreet();\n',
		};
		const site = {
			range: range(0, 9, 0, 14),
			specifier: "./mod",
			importKind: "named",
			importedName: "greet",
			reExport: false,
		} as const;
		const asked: string[] = [];
		const probe: ProviderProbe = {
			owner: () => ({ owned: true, providerId: "test" }),
			declares: () => true,
			words: () => ({ keywords: [], builtins: [], literals: [] }),
			parseCandidate: (): Promise<CandidateParse> => Promise.reject(new Error("not asked")),
			renameEdits: () => Promise.reject(new Error("not asked")),
			moveEdits: async (module, request) => {
				asked.push(`${module} ${Object.keys(request.role).join("+")} ${request.importSites.length}`);
				const edits = [
					...(request.role.removal === undefined ? [] : [{ range: request.role.removal, newText: "" }]),
					...request.importSites.map(() => ({ range: range(0, 0, 1, 0), newText: "" })),
					...(request.role.insertion === undefined
						? []
						: [{ range: range(2, 0, 2, 0), newText: request.role.insertion.text }]),
				];
				return { status: "ready", edits, blocked: [] };
			},
			arrangeEdits: () => Promise.reject(new Error("not asked")),
			importEdits: () => Promise.reject(new Error("not asked")),
			probeBatch: () => Promise.reject(new Error("not asked")),
		};
		const imports = {
			importSitesResolvingTo: async () => [{ module: TARGET, site }],
		} as unknown as ImportResolver;
		const source = { writable: (module: string) => ({ text: texts[module] ?? null }) };
		const planner = new RefactorPlanner(
			storeFor({ text: "", declarations: [] }),
			imports,
			source as unknown as SourceWorkspace,
			probe,
		);

		const outcome = await planner.moveEdits(
			{
				ok: true,
				symbolId: id("greet"),
				name: "greet",
				fromModule: MODULE,
				toModule: TARGET,
				text: "export function greet() {}",
				removal: range(0, 0, 1, 0),
				closure: [],
				dependencies: [],
				referencing: [TARGET],
				usedAtSource: false,
				exportsAtTarget: false,
				baseHash: hashContent(texts[MODULE] as string),
			},
			{} as never,
		);

		expect({
			asked: asked.sort(),
			files: outcome.ok ? outcome.files.map((file) => [file.module, file.text]) : outcome,
		}).toEqual({
			asked: [`${MODULE} removal 0`, `${TARGET} insertion 1`],
			files: [
				[MODULE, ""],
				[TARGET, "greet();\nexport function greet() {}\n"],
			],
		});
	});
});

describe("moving a declaration that shares its line", () => {
	it("takes the `;` joining it to its neighbor, and none it ends with", async () => {
		const moved = async (text: string, removal: Range) => {
			const probe: ProviderProbe = {
				owner: () => ({ owned: true, providerId: "test" }),
				declares: () => true,
				words: () => ({ keywords: [], builtins: [], literals: [] }),
				parseCandidate: (): Promise<CandidateParse> => Promise.reject(new Error("not asked")),
				renameEdits: () => Promise.reject(new Error("not asked")),
				moveEdits: async (_module, request) => ({
					status: "ready",
					edits: request.role.removal === undefined ? [] : [{ range: request.role.removal, newText: "" }],
					blocked: [],
				}),
				arrangeEdits: () => Promise.reject(new Error("not asked")),
				importEdits: () => Promise.reject(new Error("not asked")),
				probeBatch: () => Promise.reject(new Error("not asked")),
			};
			const source = { writable: (module: string) => ({ text: module === MODULE ? text : "" }) };
			const planner = new RefactorPlanner(
				storeFor({ text: "", declarations: [] }),
				{ importSitesResolvingTo: async () => [] } as unknown as ImportResolver,
				source as unknown as SourceWorkspace,
				probe,
			);
			const outcome = await planner.moveEdits(
				{
					ok: true,
					symbolId: id("f"),
					name: "f",
					fromModule: MODULE,
					toModule: TARGET,
					text: sliced(text, removal),
					removal,
					closure: [],
					dependencies: [],
					referencing: [],
					usedAtSource: false,
					exportsAtTarget: false,
					baseHash: hashContent(text),
				},
				{} as never,
			);
			return outcome.ok ? outcome.files.find((file) => file.module === MODULE)?.text : outcome;
		};

		expect([
			await moved("var f = 1; var g = 2\n", range(0, 0, 0, 9)),
			await moved("var g = 2; var f = 1\n", range(0, 11, 0, 20)),
			await moved("let g = 2; let f = 1;\n", range(0, 11, 0, 21)),
		]).toEqual(["var g = 2\n", "var g = 2\n", "let g = 2; \n"]);
	});
});

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
			{ module: MODULE, text: "" },
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
		...EMPTY_READS,
		declaration: (symbolId: string) => world.declarations.find((d) => d.symbolId === symbolId) ?? null,
		declarationsIn: (module: string) => world.declarations.filter((d) => d.module === module),
		referencesTo: (symbolId: string) => (world.references ?? []).filter((row) => row.targetId === symbolId),
		referencesIn: (module: string) => (world.references ?? []).filter((row) => row.module === module),
		importsNamed: (name: string) => world.imports.filter((row) => row.name === name),
		importsIn: (module: string) => world.imports.filter((row) => row.module === module),
		symbolIdsIn: (module: string) => world.declarations.filter((d) => d.module === module).map((d) => d.symbolId),
		contentHashOf: (module: string) => {
			const text = world.texts[module];
			return text === undefined ? null : hashContent(text);
		},
		modulesExposing: (symbolId: string) =>
			world.declarations.filter((d) => d.symbolId === symbolId).map((d) => d.module),
		fileOf: () => ({ exportsKnown: false, allList: null }),
		exportedDeclarations: (module: string) =>
			world.declarations.filter((d) => d.module === module).map((d) => ({ symbolId: d.symbolId, name: d.name })),
		importEdgesLandingOn: (landing: Landing) =>
			world.imports.filter(
				(row) =>
					landing.kind === "module" &&
					row.landing?.kind === "module" &&
					row.landing.module === landing.module,
			),
		importEdgeAt: (module: string, span: Range) =>
			world.imports.find((row) => row.module === module && JSON.stringify(row.span) === JSON.stringify(span)) ??
			null,
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
					edits: [{ range: { start: at, end: at }, newText: insertion.text }],
					blocked: [],
				};
			}
			return { status: "ready", edits: [], blocked: [] };
		},
		arrangeEdits: () => Promise.reject(new Error("not asked")),
		importEdits: () => Promise.reject(new Error("not asked")),
		probeBatch: () => Promise.reject(new Error("not asked")),
	};

	const imports = new ImportResolver(multiStoreFor(world), resolve);

	return new RefactorPlanner(multiStoreFor(world), imports, source as unknown as SourceWorkspace, probe, PROVED);
}

// An import-only site is still a plan dependency.
describe("writing a rename only over the import row the plan read", () => {
	const LIB = "src/lib.ts";
	const helper = id("helper", LIB);
	const libText = "export function helper() {}\n";
	const importerText = "import { helper } from './lib.ts';\n";
	const HELPER_NAME = { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } };

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
					...edge("named", HELPER_NAME, { name: "helper", range: HELPER_NAME }),
					factId: "import:helper",
					module: MODULE,
					specifier: "./lib.ts",
					landing: { kind: "module", module: LIB },
				},
			],
		};
	}

	/** Set to move the import's landing after the plan reads it. */
	let elsewhere = false;
	const resolve: ResolveSpecifier = async (fromModule, specifier) =>
		fromModule === MODULE && specifier === "./lib.ts"
			? landed(elsewhere ? "src/other.ts" : LIB)
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

	// A config edit moves a landing without re-committing a row.
	it("refuses when an import on its routes lands elsewhere by the write", async () => {
		const world = worldFor();

		const { outcome, written } = await stepOver(world, () => {
			elsewhere = true;
		});
		elsewhere = false;

		expect(outcome).toMatchObject({ renamed: false, reason: routeChanged(1) });
		expect(written).toEqual([]);
	});
});

// The importer's reference stamp covers its import row too.
describe("refusing a move when the importer's rows moved, covered by its reference stamp", () => {
	const IMPORTER = "src/importer.ts";
	const alpha = id("alpha", MODULE);
	const moduleText = "function alpha() {}\n";
	const importerText = "import { alpha } from './mod.ts';\n\nalpha();\n";
	const ALPHA_NAME = { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } };

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
					qualified: null,
					provenance: "bound",
					startLine: 2,
					startCharacter: 0,
					endLine: 2,
					endCharacter: 5,
					origin: null,
				},
			],
			imports: [
				{
					...edge("named", ALPHA_NAME, { name: "alpha", range: ALPHA_NAME }),
					factId: "import:alpha",
					module: IMPORTER,
					specifier: "./mod.ts",
					landing: { kind: "module", module: MODULE },
				},
			],
		};
	}

	const resolve: ResolveSpecifier = async (fromModule, specifier) =>
		fromModule === IMPORTER && specifier === "./mod.ts"
			? landed(MODULE)
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
		expect(written).toContainEqual({ module: MODULE, text: "" });
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

describe("anchoring a move among its siblings", () => {
	const text = [
		"class Box {",
		"\tfirst() {}",
		"",
		"\tsecond() {}",
		"}",
		"",
		"namespace N {",
		"\tfunction inner() {}",
		"}",
		"",
		"function a() {} function b() {}",
		"",
		"function top() {}",
		"",
	].join("\n");
	const at = (descriptors: Parameters<typeof composeSymbolId>[0]["descriptors"]) =>
		composeSymbolId({ language: "test", module: MODULE, descriptors });
	const box = at([{ kind: "type", name: "Box" }]);
	const first = at([
		{ kind: "type", name: "Box" },
		{ kind: "method", name: "first" },
	]);
	const second = at([
		{ kind: "type", name: "Box" },
		{ kind: "method", name: "second" },
	]);
	const n = at([{ kind: "namespace", name: "N" }]);
	const inner = at([
		{ kind: "namespace", name: "N" },
		{ kind: "method", name: "inner" },
	]);
	const a = at([{ kind: "method", name: "a" }]);
	const b = at([{ kind: "method", name: "b" }]);
	const top = at([{ kind: "method", name: "top" }]);
	const declared = (symbolId: string, name: string, kind: string, span: Range, containerId?: string) =>
		({
			factId: `decl:${symbolId}`,
			module: MODULE,
			symbolId,
			kind,
			name,
			range: span,
			selectionRange: span,
			visibility: "public",
			...(containerId === undefined ? {} : { containerId }),
		}) as StoredDeclaration;
	const world: World = {
		text,
		declarations: [
			declared(box, "Box", "class", range(0, 0, 4, 1)),
			declared(first, "first", "method", range(1, 1, 1, 11), box),
			declared(second, "second", "method", range(3, 1, 3, 12), box),
			declared(n, "N", "namespace", range(6, 0, 8, 1)),
			declared(inner, "inner", "function", range(7, 1, 7, 20), n),
			declared(a, "a", "function", range(10, 0, 10, 15)),
			declared(b, "b", "function", range(10, 16, 10, 31)),
			declared(top, "top", "function", range(12, 0, 12, 17)),
		],
	};
	const plan = (symbolId: string, anchor: { symbolId: string; side: "before" | "after" }) =>
		plannerFor(world).planMove(symbolId, MODULE, new ReadContext(storeFor(world)), anchor);

	it("lands a member beside its siblings, and restores it beside them", () => {
		expect(plan(second, { symbolId: first, side: "before" })).toMatchObject({
			ok: true,
			insertion: { line: 1, character: 0 },
			restore: { symbolId: first, side: "after" },
		});
	});

	it("refuses an anchor at another level, or one sharing a line with the sibling it would split from", () => {
		expect(
			[
				plan(top, { symbolId: inner, side: "before" }),
				plan(second, { symbolId: top, side: "before" }),
				plan(top, { symbolId: b, side: "before" }),
				plan(top, { symbolId: a, side: "after" }),
				plan(top, { symbolId: n, side: "after" }),
			].map((planned) => planned.ok),
		).toEqual([false, false, false, false, true]);
	});
});
