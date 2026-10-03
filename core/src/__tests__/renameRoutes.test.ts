import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type AllList,
	type Certainty,
	type Conflict,
	composeSymbolId,
	type Declaration,
	type Export,
	type Import,
	type Range,
	type Reference,
	type Selector,
} from "@nyaa-lexicon/protocol";
import { ReadContext } from "../readContext";
import {
	allListUnproved,
	exposureRebinds,
	nameAlreadyExposed,
	nameShared,
	newNameUnproved,
	routeUncertain,
	starDropsName,
	stopNotKeepable,
	stopOffRoute,
	stopReceivesNoChange,
	stopUnsupported,
	useUntraced,
	wildcardCaptures,
	wildcardDropsName,
} from "../refusals";
import { type ModuleTiers, mentionsOf, type ResolvedRoutes, resolveRoutes, startKey } from "../renameRoutes";
import { IndexStore, type StoredDeclaration } from "../store";
import { direct, edge, forward, forwarding, landed, named } from "./importEdges";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;

interface Edges {
	imports: Import[];
	exports: Export[];
}

interface Shape extends Partial<Edges> {
	/** Declared one per line from line 0, each exported where it is declared. */
	declares?: string[];
	/** Declared as given, exported only by `exports`. */
	members?: Declaration[];
	references?: Reference[];
	lands?: Record<string, string>;
	allList?: AllList;
	comments?: string[];
	strings?: Array<{ value: string; range: Range }>;
}

const KEEPING: ModuleTiers = { renameKeep: true, comments: true, literals: true };

/** Python's order: the later binder of a name wins. */
const LATER: Conflict = { priority: 0, amongTransfers: "laterWins", againstLocal: "sourceOrder" };

/** No `__all__`: a star brings what `[!_]*` matches. */
const PY_ABSENT: AllList = { state: "absent", fallback: { glob: "[!_]*", caseInsensitive: false } };

const UNKNOWN: Certainty = { status: "unknown", reason: "RuntimeConstructed" };

function idOf(module: string, name: string): string {
	return composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] });
}

function typeOf(module: string, name: string): string {
	return composeSymbolId({ language: "ts", module, descriptors: [{ kind: "type", name }] });
}

/** `name` declared on `line`, exported only by an edge the test writes. */
function declaration(module: string, name: string, line: number): Declaration {
	return {
		symbolId: idOf(module, name),
		kind: "variable",
		name,
		range: at(line, 0, name.length),
		selectionRange: at(line, 0, name.length),
		visibility: "public",
		exported: true,
	};
}

/** `length` characters on `line` from `start`. */
function at(line: number, start: number, length = 1): Range {
	return { start: { line, character: start }, end: { line, character: start + length } };
}

function write(module: string, shape: Shape = {}): void {
	const declarations: Declaration[] = (shape.declares ?? []).map((name, line) => ({
		symbolId: idOf(module, name),
		kind: "variable",
		name,
		range: at(line, 0, name.length),
		selectionRange: at(line, 0, name.length),
		visibility: "public",
		exported: true,
	}));
	const lands = Object.entries(shape.lands ?? {}).map(([specifier, to]) => [specifier, landed(to)] as const);
	store.replaceFile({
		module,
		contentHash: JSON.stringify(shape),
		declarations: [...declarations, ...(shape.members ?? [])],
		references: shape.references ?? [],
		imports: shape.imports ?? [],
		exports: [...declarations.map((each, order) => direct(each, order)), ...(shape.exports ?? [])],
		...(shape.allList === undefined ? {} : { allList: shape.allList }),
		comments: (shape.comments ?? []).map((text, line) => ({
			range: at(100 + line, 0, text.length),
			raw: text,
			normalized: text,
			form: "standalone",
			placement: "above",
			anchorId: null,
		})),
		literals: (shape.strings ?? []).map(({ value, range }) => ({ kind: "string", value, range })),
		provider: "ts",
		resolutions: new Map(lands),
	});
	store.settleProjections();
}

/** `export * from "specifier"` on `line`; or, unexported, a bare wildcard import. */
function star(
	specifier: string,
	line: number,
	fields: { selector?: Selector; binds?: boolean; exported?: boolean; uncertain?: true } = {},
): Edges {
	const span = at(line, 0, 1);
	const bindsLocally = fields.binds ?? false;
	const transfer = edge("wildcard", span, {
		selector: fields.selector ?? { kind: "allButDefault" },
		bindsLocally,
		order: line,
		...(bindsLocally ? { conflict: LATER } : {}),
	});
	const exported = forwarding("star", span, { order: line, ...(fields.uncertain ? { certainty: UNKNOWN } : {}) });
	return { imports: [{ specifier, edges: [transfer] }], exports: fields.exported === false ? [] : [exported] };
}

function joined(...parts: Edges[]): Edges {
	return { imports: parts.flatMap((part) => part.imports), exports: parts.flatMap((part) => part.exports) };
}

/** A read of `name`, bound to `target` (null: unbound), through `origin` when proved. */
function use(
	name: string,
	range: Range,
	target: string | null,
	origin?: Reference["origin"],
	qualified?: true,
): Reference {
	return {
		name,
		range,
		role: "read",
		binding:
			target === null
				? { status: "unbound", reason: "NotIndexed" }
				: { status: "bound", symbolId: target, provenance: "bound" },
		...(origin === undefined ? {} : { origin }),
		...(qualified === undefined ? {} : { qualified }),
	};
}

function routes(
	subject: string,
	newName: string,
	stops: string[] = [],
	tiers: ModuleTiers | null = KEEPING,
): ResolvedRoutes {
	const context = new ReadContext(store);
	const declaration = context.declaration(subject) as StoredDeclaration;
	return resolveRoutes({ subject: declaration, newName, stops: new Set(stops), tiers: () => tiers }, context);
}

/** Each module's sites as `line:character`, a kept one marked. */
function sitesOf(result: ResolvedRoutes): Record<string, string[]> {
	return Object.fromEntries(
		[...result.sites].map(([module, sites]) => [
			module,
			sites.map((site) => `${site.range.start.line}:${site.range.start.character}${site.keep ? " keep" : ""}`),
		]),
	);
}

function edgesOf(result: ResolvedRoutes): string[] {
	return result.routes.edges
		.map(
			(each) =>
				`${each.fact} ${each.from} ${each.state}${each.fact === "export" && each.stoppable ? " stoppable" : ""}`,
		)
		.sort();
}

function blockersOf(result: ResolvedRoutes): Array<{ kind: string; detail: string; sites?: unknown }> {
	return result.blockers.map(({ kind, detail, sites }) => ({
		kind,
		detail,
		...(sites === undefined ? {} : { sites }),
	}));
}

function exportIn(result: ResolvedRoutes, module: string): string {
	const found = result.routes.edges.find((each) => each.fact === "export" && each.from === module);
	if (found === undefined) throw new Error(`no export edge from ${module}`);
	return found.id;
}

function mentions(name: string, result: ResolvedRoutes) {
	const decided = new Map(
		[...result.sites].map(([module, sites]) => [
			module,
			[...sites.map((site) => site.range), ...(result.unchanged.get(module) ?? [])],
		]),
	);
	return mentionsOf(name, decided, new ReadContext(store), () => KEEPING);
}

const N = idOf("d.ts", "N");

/** `d.ts` declares N; `barrel.ts` forwards it, and `outer.ts` the barrel; `use.ts` imports it from the barrel and reads it. */
function barrel(): void {
	write("d.ts", {
		declares: ["N"],
		comments: ["N counts things", "None of this names it"],
		strings: [
			{ value: "use N", range: at(3, 0, 7) },
			{ value: "N", range: at(0, 0, 1) },
		],
	});
	write("barrel.ts", { ...forward("./d", "N", at(0, 9)), lands: { "./d": "d.ts" } });
	write("outer.ts", { ...forward("./barrel", "N", at(0, 9)), lands: { "./barrel": "barrel.ts" } });
	write("use.ts", {
		imports: [named("./barrel", "N", at(0, 9))],
		references: [use("N", at(1, 0), N, { kind: "import", span: at(0, 9) })],
		lands: { "./barrel": "barrel.ts" },
	});
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-routes-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a rename follows its routes", () => {
	it("renames the declaration, the re-export, the importer and its use, and counts mentions outside its sites", () => {
		barrel();
		const result = routes(N, "M");

		expect(sitesOf(result)).toEqual({
			"d.ts": ["0:0"],
			"barrel.ts": ["0:9"],
			"outer.ts": ["0:9"],
			"use.ts": ["0:9", "1:0"],
		});
		expect(edgesOf(result)).toEqual([
			"export barrel.ts renamed stoppable",
			"export d.ts renamed",
			"export outer.ts renamed stoppable",
			"import barrel.ts renamed",
			"import outer.ts renamed",
			"import use.ts renamed",
		]);
		expect(result.blockers).toEqual([]);
		expect(mentions("N", result)).toEqual({ comments: 1, strings: 1 });
	});

	it("keeps the old name at a stopped re-export, so what lies past it stays as written", () => {
		barrel();
		const stop = exportIn(routes(N, "M"), "barrel.ts");
		const result = routes(N, "M", [stop]);

		expect(sitesOf(result)).toEqual({ "d.ts": ["0:0"], "barrel.ts": ["0:9 keep"] });
		expect(edgesOf(result)).toEqual([
			"export barrel.ts stopped stoppable",
			"export d.ts renamed",
			"export outer.ts fixed",
			"import barrel.ts stopped",
			"import outer.ts fixed",
			"import use.ts fixed",
		]);
		expect(result.routes.modules.find((row) => row.module === "use.ts")).toEqual({
			module: "use.ts",
			roles: ["imports", "uses"],
			edited: 0,
			kept: 0,
			unknown: 0,
		});
		expect(result.blockers).toEqual([]);
	});

	it("keeps a stopped import for every export it feeds", () => {
		write("d.ts", { declares: ["N"] });
		const local = (name: string, line: number, alias?: true): Export => ({
			form: "local",
			span: at(line, 9),
			name,
			range: alias ? at(line, 14) : at(line, 9),
			...(alias ? { sourceRange: at(line, 9) } : {}),
			target: { kind: "import", span: at(0, 9) },
			conflict: LATER,
			certainty: { status: "known" },
			order: line,
		});
		write("mid.ts", {
			imports: [named("./d", "N", at(0, 9))],
			exports: [local("N", 1), local("Q", 2, true)],
			lands: { "./d": "d.ts" },
		});
		const stop = routes(N, "M").routes.edges.find(
			(each) => each.fact === "export" && each.from === "mid.ts" && each.name === "N",
		);
		const result = routes(N, "M", [stop?.id ?? ""]);

		expect({ sites: sitesOf(result), blockers: result.blockers }).toEqual({
			sites: { "d.ts": ["0:0"], "mid.ts": ["0:9 keep"] },
			blockers: [],
		});
	});

	it("refuses a stop off its routes, on an edge no alias can keep, past another stop, or where the provider cannot keep a name", () => {
		barrel();
		const plain = routes(N, "M");
		const stop = exportIn(plain, "barrel.ts");
		const details = (result: ResolvedRoutes) => result.blockers.map((blocker) => blocker.detail);

		expect({
			declared: details(routes(N, "M", [exportIn(plain, "d.ts")])),
			offRoute: details(routes(N, "M", ["lexicon export elsewhere.ts 0:0"])),
			pastStop: details(routes(N, "M", [stop, exportIn(plain, "outer.ts")])),
			unsupported: details(routes(N, "M", [stop], null)),
		}).toEqual({
			declared: [stopNotKeepable("d.ts")],
			offRoute: [stopOffRoute("lexicon export elsewhere.ts 0:0")],
			pastStop: [stopReceivesNoChange("outer.ts")],
			unsupported: [stopUnsupported("barrel.ts")],
		});
	});

	it("rewrites an alias's source name and leaves the alias and its uses", () => {
		write("d.ts", { declares: ["N"] });
		write("alias.ts", {
			imports: [named("./d", "N", at(0, 9), { local: "X", localRange: at(0, 14) })],
			references: [use("X", at(1, 0), N, { kind: "import", span: at(0, 9) })],
			lands: { "./d": "d.ts" },
		});
		write("barrel.ts", {
			imports: [named("./d", "N", at(0, 9), { bindsLocally: false })],
			exports: [forwarding("forward", at(0, 9), { name: "Q", range: at(0, 14), sourceRange: at(0, 9) })],
			lands: { "./d": "d.ts" },
		});
		write("use.ts", {
			imports: [named("./barrel", "Q", at(0, 9))],
			references: [use("Q", at(1, 0), N, { kind: "import", span: at(0, 9) })],
			lands: { "./barrel": "barrel.ts" },
		});
		const result = routes(N, "M");

		expect(sitesOf(result)).toEqual({ "d.ts": ["0:0"], "alias.ts": ["0:9"], "barrel.ts": ["0:9"] });
		expect(edgesOf(result)).toContain("export barrel.ts fixed");
		expect(result.blockers).toEqual([]);
	});

	it("leaves a default import's own name, and renames through a star the name it carries apart from an alias", () => {
		write("d.ts", {
			declares: ["N"],
			exports: [
				{
					form: "default",
					span: at(2, 0),
					name: "default",
					range: at(2, 0),
					target: { kind: "symbol", symbolId: N },
					conflict: LATER,
					certainty: { status: "known" },
					order: 1,
				},
				{
					form: "local",
					span: at(1, 0),
					name: "Q",
					range: at(1, 14),
					sourceRange: at(1, 9),
					target: { kind: "symbol", symbolId: N },
					conflict: LATER,
					certainty: { status: "known" },
					order: 2,
				},
			],
		});
		write("barrel.ts", { ...star("./d", 0), lands: { "./d": "d.ts" } });
		write("use.ts", {
			imports: [
				named("./barrel", "N", at(0, 9)),
				{
					specifier: "./d",
					edges: [edge("default", at(1, 7), { local: "D", localRange: at(1, 7), order: 1 })],
				},
			],
			references: [
				use("N", at(2, 0), N, { kind: "import", span: at(0, 9) }),
				use("D", at(3, 0), N, { kind: "import", span: at(1, 7) }),
			],
			lands: { "./barrel": "barrel.ts", "./d": "d.ts" },
		});
		const result = routes(N, "M");

		expect(sitesOf(result)).toEqual({ "d.ts": ["0:0", "1:9"], "use.ts": ["0:9", "2:0"] });
		expect(result.blockers).toEqual([]);
	});

	it("renames a member a namespace, a loaded module or a namespace export reaches, and marks it qualified", () => {
		write("d.ts", { declares: ["N"] });
		write("barrel.ts", {
			imports: [
				{
					specifier: "./d",
					edges: [
						edge("namespace", at(0, 7, 7), { local: "ns", localRange: at(0, 12, 2), bindsLocally: false }),
					],
				},
			],
			exports: [forwarding("namespace", at(0, 7, 7), { name: "ns", range: at(0, 12, 2) })],
			lands: { "./d": "d.ts" },
		});
		write("use.ts", {
			imports: [
				{
					specifier: "./d",
					edges: [edge("namespace", at(0, 7, 7), { local: "d0", localRange: at(0, 12, 2) })],
				},
				{ specifier: "./d", edges: [edge("sideEffect", at(1, 0, 10), { order: 1 })] },
				{
					specifier: "./barrel",
					edges: [edge("named", at(2, 9, 2), { name: "ns", range: at(2, 9, 2), order: 2 })],
				},
			],
			references: [
				use("N", at(3, 3), N, { kind: "import", span: at(0, 7, 7), path: ["N"] }, true),
				use("N", at(4, 5), N, { kind: "import", span: at(1, 0, 10), path: ["N"] }, true),
				use("N", at(5, 3), N, { kind: "import", span: at(2, 9, 2), path: ["N"] }, true),
			],
			lands: { "./d": "d.ts", "./barrel": "barrel.ts" },
		});
		const result = routes(N, "M");

		expect(sitesOf(result)).toEqual({ "d.ts": ["0:0"], "use.ts": ["3:3", "4:5", "5:3"] });
		expect([...result.qualified]).toEqual(
			[3, 4, 5].map((line) => startKey("use.ts", at(line, line === 4 ? 5 : 3).start)),
		);
		expect(result.blockers).toEqual([]);
	});

	it("rewrites a static __all__ entry chosen by its target, keeps it at a stop, and refuses one whose target is unknown", () => {
		write("d.ts", { declares: ["N"], allList: PY_ABSENT });
		write("e.ts", { declares: ["N"] });
		write("pkg/__init__.py", {
			imports: [named("./d", "N", at(0, 14), { conflict: LATER })],
			exports: [forwarding("forward", at(0, 14), { name: "N", range: at(0, 14) })],
			allList: {
				state: "static",
				entries: [{ name: "N", range: at(2, 11, 3), target: { kind: "import", span: at(0, 14) } }],
			},
			strings: [{ value: "N", range: at(2, 11, 3) }],
			lands: { "./d": "d.ts" },
		});
		write("alt/__init__.py", {
			imports: [
				named("./e", "N", at(0, 14), { conflict: LATER }),
				named("./d", "N", at(1, 14), { conflict: LATER, order: 1 }),
			],
			exports: [
				forwarding("forward", at(0, 14), { name: "N", range: at(0, 14), conflict: LATER }),
				forwarding("forward", at(1, 14), { name: "N", range: at(1, 14), conflict: LATER, order: 1 }),
			],
			allList: {
				state: "static",
				entries: [{ name: "N", range: at(3, 11, 3), target: { kind: "import", span: at(0, 14) } }],
			},
			lands: { "./d": "d.ts", "./e": "e.ts" },
		});
		write("star/__init__.py", {
			...star("./d", 0, { selector: { kind: "allList" }, binds: true }),
			allList: {
				state: "static",
				entries: [{ name: "N", range: at(2, 11, 3), target: { kind: "unknown", reason: "Ambiguous" } }],
			},
			lands: { "./d": "d.ts" },
		});
		const renamed = routes(N, "M");
		const kept = routes(N, "M", [exportIn(renamed, "pkg/__init__.py")]);

		expect({
			pkg: sitesOf(renamed)["pkg/__init__.py"],
			alt: sitesOf(renamed)["alt/__init__.py"],
			star: sitesOf(renamed)["star/__init__.py"],
			blockers: blockersOf(renamed).map(({ kind, detail }) => ({ kind, detail })),
		}).toEqual({
			pkg: ["0:14", "2:11"],
			alt: ["1:14"],
			star: undefined,
			blockers: [{ kind: "RouteUnknown", detail: allListUnproved("star/__init__.py", "N") }],
		});
		expect({
			pkg: sitesOf(kept)["pkg/__init__.py"],
			unchanged: kept.unchanged.get("pkg/__init__.py"),
			mentions: mentions("N", kept).strings,
		}).toEqual({ pkg: ["0:14 keep"], unchanged: [at(2, 11, 3)], mentions: 0 });
	});

	it("renames through a star only where its selector carries the new name, and through a wildcard a module also re-exports", () => {
		write("d.py", { declares: ["N"], allList: PY_ABSENT });
		write("pkg/__init__.py", {
			...star("./d", 0, { selector: { kind: "allList" }, binds: true }),
			lands: { "./d": "d.py" },
		});
		write("use.py", {
			imports: [named("pkg", "N", at(0, 16), { conflict: LATER })],
			references: [use("N", at(1, 0), idOf("d.py", "N"), { kind: "import", span: at(0, 16) })],
			lands: { pkg: "pkg/__init__.py" },
		});
		write("user.py", {
			...star("./d", 0, { selector: { kind: "allList" }, binds: true, exported: false }),
			references: [use("N", at(1, 0), idOf("d.py", "N"), { kind: "import", span: at(0, 0) })],
			lands: { "./d": "d.py" },
		});
		write("both.py", {
			...star("./d", 0, { selector: { kind: "allList" }, binds: true }),
			references: [use("N", at(2, 0), idOf("d.py", "N"), { kind: "import", span: at(0, 0) })],
			lands: { "./d": "d.py" },
		});
		const plain = routes(idOf("d.py", "N"), "M");
		const hidden = routes(idOf("d.py", "N"), "_M");

		expect({ sites: sitesOf(plain), blockers: plain.blockers }).toEqual({
			sites: { "d.py": ["0:0"], "use.py": ["0:16", "1:0"], "user.py": ["1:0"], "both.py": ["2:0"] },
			blockers: [],
		});
		expect(blockersOf(hidden).map(({ kind, detail }) => ({ kind, detail }))).toEqual([
			{ kind: "NoExportPath", detail: starDropsName("both.py", "_M") },
			{ kind: "NoExportPath", detail: starDropsName("pkg/__init__.py", "_M") },
			{ kind: "NoExportPath", detail: wildcardDropsName("user.py", "_M") },
		]);
	});
});

describe("a rename refuses what it cannot prove", () => {
	it("blocks a bound use with no origin, and an unbound one where the changing name binds or a loaded module is read", () => {
		write("d.ts", { declares: ["N"] });
		write("use.ts", {
			imports: [
				named("./d", "N", at(0, 9)),
				{
					specifier: "extlib",
					edges: [edge("namespace", at(5, 7, 7), { local: "ext", localRange: at(5, 12, 3), order: 1 })],
				},
			],
			references: [
				use("N", at(1, 0), N),
				use("N", at(2, 0), null),
				use("N", at(3, 5), null, { kind: "declaration" }, true),
				use("N", at(4, 4), null, { kind: "import", span: at(5, 7, 7), path: ["N"] }, true),
			],
			lands: { "./d": "d.ts" },
		});
		write("effect.ts", {
			imports: [{ specifier: "./d", edges: [edge("sideEffect", at(0, 0, 10))] }],
			references: [use("N", at(1, 4), null, undefined, true)],
			lands: { "./d": "d.ts" },
		});
		write("other.ts", { references: [use("N", at(0, 0), null)] });
		const result = routes(N, "M");

		expect(blockersOf(result)).toEqual([
			{
				kind: "RouteUnknown",
				detail: useUntraced("N"),
				sites: [
					{ module: "use.ts", line: 2 },
					{ module: "effect.ts", line: 2 },
					{ module: "use.ts", line: 3 },
				],
			},
		]);
		expect(result.routes.modules.find((row) => row.module === "use.ts")?.unknown).toBe(2);
	});

	it("blocks a new name a landing already exposes: from elsewhere, declared beside a star, or as the subject's own alias", () => {
		write("d1.ts", { declares: ["N"] });
		write("e.ts", { declares: ["X", "M"] });
		write("hub.ts", {
			imports: [
				named("./d1", "N", at(0, 9), { bindsLocally: false }),
				named("./e", "M", at(1, 9), { bindsLocally: false, order: 1 }),
			],
			exports: [
				forwarding("forward", at(0, 9), { name: "N", range: at(0, 9) }),
				forwarding("forward", at(1, 9), { name: "M", range: at(1, 9), order: 1 }),
			],
			lands: { "./d1": "d1.ts", "./e": "e.ts" },
		});
		write("d2.ts", { declares: ["N"] });
		write("sbar.ts", { declares: ["M"], ...star("./d2", 1), lands: { "./d2": "d2.ts" } });
		// Imported, so the star losing N to sbar's own M breaks its importer.
		write("sbuse.ts", { imports: [named("./sbar", "N", at(0, 9))], lands: { "./sbar": "sbar.ts" } });
		write("d3.ts", {
			declares: ["N"],
			exports: [
				{
					form: "local",
					span: at(1, 0),
					name: "M",
					range: at(1, 14),
					sourceRange: at(1, 9),
					target: { kind: "symbol", symbolId: idOf("d3.ts", "N") },
					conflict: LATER,
					certainty: { status: "known" },
					order: 1,
				},
			],
		});
		const taken = (module: string) =>
			blockersOf(routes(idOf(module, "N"), "M")).filter(({ kind }) => kind === "NameTaken");

		expect({ hub: taken("d1.ts"), star: taken("d2.ts"), alias: taken("d3.ts") }).toEqual({
			hub: [
				{ kind: "NameTaken", detail: nameAlreadyExposed("M", "hub.ts"), sites: [{ module: "e.ts", line: 2 }] },
			],
			star: [
				{
					kind: "NameTaken",
					detail: nameAlreadyExposed("M", "sbar.ts"),
					sites: [{ module: "sbar.ts", line: 1 }],
				},
			],
			alias: [
				{ kind: "NameTaken", detail: nameAlreadyExposed("M", "d3.ts"), sites: [{ module: "d3.ts", line: 1 }] },
			],
		});
	});

	it("blocks a collision a stop leaves standing, since another path still brings the new name", () => {
		write("d.ts", { declares: ["N"] });
		write("e.ts", { declares: ["M"] });
		write("b1.ts", { ...forward("./d", "N", at(0, 9)), lands: { "./d": "d.ts" } });
		write("b2.ts", { ...forward("./d", "N", at(0, 9)), lands: { "./d": "d.ts" } });
		write("hub.ts", {
			...joined(star("./b1", 0), star("./b2", 1), star("./e", 2)),
			lands: { "./b1": "b1.ts", "./b2": "b2.ts", "./e": "e.ts" },
		});
		const stop = exportIn(routes(N, "M"), "b1.ts");

		expect(routes(N, "M", [stop]).blockers.map(({ kind }) => kind)).toContain("NameTaken");
	});

	it("blocks an uncertain edge, an uncertain row, and unproved coverage that may bring the new name", () => {
		write("d1.ts", { declares: ["N"] });
		write("c1.ts", { ...forward("./d1", "N", at(0, 9)), lands: { "./d1": "d1.ts" } });
		write("c2.ts", { ...forward("./d1", "N", at(0, 9)), lands: { "./d1": "d1.ts" } });
		write("b1.ts", {
			...joined(star("./c1", 0), star("./c2", 1, { uncertain: true })),
			lands: { "./c1": "c1.ts", "./c2": "c2.ts" },
		});
		write("d2.py", { declares: ["N"], allList: { state: "dynamic", reason: "RuntimeConstructed" } });
		write("b2.py", { ...star("./d2", 0, { selector: { kind: "allList" } }), lands: { "./d2": "d2.py" } });
		write("d3.ts", { declares: ["N"] });
		write("b3.ts", { ...joined(star("./d3", 0), star("lib", 1)), lands: { "./d3": "d3.ts" } });
		const details = (module: string) => routes(idOf(module, "N"), "M").blockers.map((blocker) => blocker.detail);

		expect({ edge: details("d1.ts"), row: details("d2.py"), coverage: details("d3.ts") }).toEqual({
			edge: [routeUncertain("b1.ts", "N")],
			row: [routeUncertain("b2.py", "N")],
			coverage: [newNameUnproved("b3.ts", "M")],
		});
	});

	it("blocks a wildcard bringing the new name beside the one that brings the renamed one", () => {
		write("a.py", { declares: ["N"], allList: PY_ABSENT });
		write("e.py", { declares: ["M"], allList: PY_ABSENT });
		write("use.py", {
			...joined(
				star("./a", 0, { selector: { kind: "allList" }, binds: true, exported: false }),
				star("./e", 1, { selector: { kind: "allList" }, binds: true, exported: false }),
			),
			references: [use("N", at(2, 0), idOf("a.py", "N"), { kind: "import", span: at(0, 0) })],
			lands: { "./a": "a.py", "./e": "e.py" },
		});

		expect(blockersOf(routes(idOf("a.py", "N"), "M"))).toEqual([
			{ kind: "NameImported", detail: wildcardCaptures("use.py", "M"), sites: [{ module: "use.py", line: 2 }] },
		]);
	});
});

describe("a rename reads what it moves downstream", () => {
	/** Python's `from m import *`: binds here, exported, and later binders win. */
	const pyStar = (specifier: string, line: number, exported = true): Edges => ({
		imports: [
			{
				specifier,
				edges: [
					edge("wildcard", at(line, 0), {
						selector: { kind: "allList" },
						bindsLocally: true,
						conflict: LATER,
						order: line,
					}),
				],
			},
		],
		exports: exported ? [forwarding("star", at(line, 0), { order: line, conflict: LATER })] : [],
	});

	it("blocks the new name a star starts carrying where the old one was shadowed or filtered out", () => {
		write("d.ts", { declares: ["N"] });
		write("e.ts", { declares: ["M"] });
		write("hub.ts", {
			declares: ["N"],
			...joined(star("./d", 1), star("./e", 2)),
			lands: { "./d": "d.ts", "./e": "e.ts" },
		});
		write("d.py", { declares: ["N"], allList: PY_ABSENT });
		write("f.py", { declares: ["M"], allList: PY_ABSENT });
		const own = declaration("L.py", "N", 2);
		write("L.py", {
			members: [own],
			imports: [named("./f", "M", at(0, 14), { conflict: LATER }), ...pyStar("./d", 1).imports],
			exports: [
				forwarding("forward", at(0, 14), { name: "M", range: at(0, 14), conflict: LATER }),
				...pyStar("./d", 1).exports,
				{ ...direct(own, 2), conflict: LATER },
			],
			lands: { "./f": "f.py", "./d": "d.py" },
		});
		write("d2.py", { declares: ["_h"], allList: PY_ABSENT });
		write("use2.py", { declares: ["h"], ...pyStar("./d2", 1, false), lands: { "./d2": "d2.py" } });

		expect({
			hub: blockersOf(routes(N, "M")),
			python: blockersOf(routes(idOf("d.py", "N"), "M")),
			filtered: blockersOf(routes(idOf("d2.py", "_h"), "h")),
		}).toEqual({
			hub: [
				{ kind: "NameTaken", detail: exposureRebinds("hub.ts", "M"), sites: [{ module: "hub.ts", line: 3 }] },
			],
			python: [
				{ kind: "NameTaken", detail: exposureRebinds("L.py", "M"), sites: [{ module: "L.py", line: 1 }] },
				{ kind: "NameImported", detail: wildcardCaptures("L.py", "M"), sites: [{ module: "L.py", line: 1 }] },
			],
			filtered: [
				{
					kind: "NameImported",
					detail: wildcardCaptures("use2.py", "h"),
					sites: [{ module: "use2.py", line: 1 }],
				},
			],
		});
	});

	it("blocks a star that gains the new name through one inner path while another keeps the old", () => {
		write("s.ts", {
			declares: ["N"],
			exports: [
				{
					form: "local",
					span: at(1, 0),
					name: "Q",
					range: at(1, 14),
					sourceRange: at(1, 9),
					target: { kind: "symbol", symbolId: idOf("s.ts", "N") },
					conflict: LATER,
					certainty: { status: "known" },
					order: 1,
				},
			],
		});
		write("x.ts", {
			imports: [named("./s", "Q", at(0, 9), { bindsLocally: false })],
			exports: [forwarding("forward", at(0, 9), { name: "N", range: at(0, 14), sourceRange: at(0, 9) })],
			lands: { "./s": "s.ts" },
		});
		write("y.ts", { ...forward("./s", "N", at(0, 9)), lands: { "./s": "s.ts" } });
		write("d.ts", { ...joined(star("./x", 0), star("./y", 1)), lands: { "./x": "x.ts", "./y": "y.ts" } });
		write("e.ts", { declares: ["M"] });
		write("hub.ts", { ...joined(star("./d", 0), star("./e", 1)), lands: { "./d": "d.ts", "./e": "e.ts" } });

		expect(blockersOf(routes(idOf("s.ts", "N"), "M"))).toEqual([
			{ kind: "NameTaken", detail: exposureRebinds("hub.ts", "M"), sites: [{ module: "hub.ts", line: 2 }] },
		]);
	});

	it("renames only what carries the subject's meaning, blocks a token another declaration shares where the subject is read, and keeps it where only the other is", () => {
		const value = declaration("d.ts", "N", 0);
		const type: Declaration = { ...declaration("d.ts", "N", 1), symbolId: typeOf("d.ts", "N"), kind: "interface" };
		write("d.ts", {
			members: [value, type],
			exports: [
				{ ...direct(value, 0), meaning: ["value"] },
				{ ...direct(type, 1), meaning: ["type"] },
			],
		});
		write("use.ts", {
			imports: [named("./d", "N", at(0, 9))],
			references: [use("N", at(1, 0), value.symbolId, { kind: "import", span: at(0, 9) })],
			lands: { "./d": "d.ts" },
		});
		write("typed.ts", {
			imports: [named("./d", "N", at(0, 9))],
			references: [use("N", at(1, 7), type.symbolId, { kind: "import", span: at(0, 9) })],
			lands: { "./d": "d.ts" },
		});
		write("types.ts", {
			imports: [named("./d", "N", at(0, 14), { meaning: ["type"], typeOnly: true })],
			lands: { "./d": "d.ts" },
		});
		write("barrel.ts", {
			imports: [named("./d", "N", at(0, 14), { bindsLocally: false, meaning: ["type"] })],
			exports: [forwarding("forward", at(0, 14), { name: "N", range: at(0, 14), meaning: ["type"] })],
			lands: { "./d": "d.ts" },
		});
		const result = routes(value.symbolId, "M");

		expect({ sites: sitesOf(result), blockers: blockersOf(result) }).toEqual({
			sites: { "d.ts": ["0:0"], "use.ts": ["0:9", "1:0"] },
			blockers: [
				{ kind: "NameTaken", detail: nameShared("use.ts", "N"), sites: [{ module: "use.ts", line: 1 }] },
			],
		});
	});

	it("keeps an alias written as its own source name, so only its source token renames", () => {
		write("d.ts", { declares: ["N"] });
		write("barrel.ts", {
			imports: [named("./d", "N", at(0, 9), { bindsLocally: false })],
			exports: [forwarding("forward", at(0, 9), { name: "N", range: at(0, 14), sourceRange: at(0, 9) })],
			lands: { "./d": "d.ts" },
		});
		write("use.ts", {
			imports: [named("./barrel", "N", at(0, 9))],
			references: [use("N", at(1, 0), N, { kind: "import", span: at(0, 9) })],
			lands: { "./barrel": "barrel.ts" },
		});
		const result = routes(N, "M");

		expect({ sites: sitesOf(result), barrel: edgesOf(result), blockers: result.blockers }).toEqual({
			sites: { "d.ts": ["0:0"], "barrel.ts": ["0:9"] },
			barrel: [
				"export barrel.ts fixed",
				"export d.ts renamed",
				"import barrel.ts renamed",
				"import use.ts fixed",
			],
			blockers: [],
		});
	});

	it("reads a star cycle and an explicit export beside external coverage as unable to bring a rival", () => {
		write("d.ts", { declares: ["N"] });
		write("a.ts", { ...joined(star("./b", 0), star("./d", 1)), lands: { "./b": "b.ts", "./d": "d.ts" } });
		write("b.ts", { ...star("./a", 0), lands: { "./a": "a.ts" } });
		write("use.ts", { imports: [named("./b", "N", at(0, 9))], lands: { "./b": "b.ts" } });
		write("api.ts", { declares: ["build"], ...star("lib", 1) });

		expect({
			cycle: routes(N, "M").blockers,
			explicit: routes(idOf("api.ts", "build"), "make").blockers,
		}).toEqual({ cycle: [], explicit: [] });
	});

	it("passes an uncertain edge where no change arrives", () => {
		write("d.ts", { declares: ["N"] });
		write("mid.ts", {
			imports: [named("./d", "N", at(0, 9), { bindsLocally: false })],
			exports: [forwarding("forward", at(0, 9), { name: "Q", range: at(0, 14), sourceRange: at(0, 9) })],
			lands: { "./d": "d.ts" },
		});
		write("c.ts", {
			imports: [named("./mid", "Q", at(0, 9), { bindsLocally: false, certainty: UNKNOWN })],
			exports: [forwarding("forward", at(0, 9), { name: "Q", range: at(0, 9) })],
			lands: { "./mid": "mid.ts" },
		});

		expect(routes(N, "M").blockers).toEqual([]);
	});

	it("renames a member reached through a declaration or a module's assigned value, and blocks an unbound one under the subject's owner", () => {
		const owner = declaration("d.ts", "Foo", 0);
		const member: Declaration = {
			...declaration("d.ts", "N", 1),
			symbolId: composeSymbolId({
				language: "ts",
				module: "d.ts",
				descriptors: [
					{ kind: "type", name: "Foo" },
					{ kind: "term", name: "N" },
				],
			}),
			containerId: owner.symbolId,
			exported: false,
		};
		write("d.ts", { members: [owner, member], exports: [direct(owner, 0)] });
		write("d2.ts", {
			members: [owner, member].map((each) => ({
				...each,
				symbolId: each.symbolId.replace("d.ts", "d2.ts"),
				...(each.containerId === undefined ? {} : { containerId: owner.symbolId.replace("d.ts", "d2.ts") }),
			})),
			exports: [
				{
					form: "assignment",
					span: at(3, 0),
					target: { kind: "symbol", symbolId: owner.symbolId.replace("d.ts", "d2.ts") },
					conflict: LATER,
					certainty: { status: "known" },
					order: 0,
				},
			],
		});
		const space = edge("namespace", at(0, 7, 7), { local: "ns", localRange: at(0, 12, 2) });
		write("use.ts", {
			imports: [{ specifier: "./d", edges: [space] }],
			references: [
				use("N", at(1, 7), member.symbolId, { kind: "import", span: at(0, 7, 7), path: ["Foo", "N"] }, true),
				use("N", at(2, 7), null, { kind: "import", span: at(0, 7, 7), path: ["Foo", "N"] }, true),
				use("N", at(3, 7), null, { kind: "import", span: at(0, 7, 7), path: ["Bar", "N"] }, true),
			],
			lands: { "./d": "d.ts" },
		});
		write("use2.ts", {
			imports: [
				{ specifier: "./d2", edges: [edge("require", at(0, 0, 9), { local: "x", localRange: at(0, 7) })] },
			],
			references: [
				use(
					"N",
					at(1, 2),
					member.symbolId.replace("d.ts", "d2.ts"),
					{ kind: "import", span: at(0, 0, 9), path: ["N"] },
					true,
				),
			],
			lands: { "./d2": "d2.ts" },
		});
		const plain = routes(member.symbolId, "M");
		const assigned = routes(member.symbolId.replace("d.ts", "d2.ts"), "M");

		expect({
			sites: sitesOf(plain)["use.ts"],
			blockers: blockersOf(plain),
			assigned: { sites: sitesOf(assigned)["use2.ts"], blockers: assigned.blockers },
		}).toEqual({
			sites: ["1:7"],
			blockers: [{ kind: "RouteUnknown", detail: useUntraced("N"), sites: [{ module: "use.ts", line: 3 }] }],
			assigned: { sites: ["1:2"], blockers: [] },
		});
	});

	it("reads importers of a module holding the renamed one as a namespace, by path or unproved", () => {
		write("pkg/d.py", { declares: ["thing"], allList: PY_ABSENT });
		const sub = edge("namespace", at(0, 14), { local: "d", localRange: at(0, 14), conflict: LATER });
		write("pkg/__init__.py", {
			imports: [{ specifier: ".d", edges: [sub] }],
			exports: [forwarding("forward", at(0, 14), { name: "d", range: at(0, 14), conflict: LATER })],
			lands: { ".d": "pkg/d.py" },
		});
		const root = edge("namespace", at(0, 7, 3), { local: "pkg", localRange: at(0, 7, 3), conflict: LATER });
		write("use.py", {
			imports: [{ specifier: "pkg", edges: [root] }],
			references: [
				use("thing", at(1, 6, 5), null, { kind: "import", span: at(0, 7, 3), path: ["d", "thing"] }, true),
			],
			lands: { pkg: "pkg/__init__.py" },
		});
		write("use2.py", {
			imports: [named("pkg", "d", at(0, 16), { conflict: LATER })],
			references: [use("thing", at(1, 2, 5), null, undefined, true)],
			lands: { pkg: "pkg/__init__.py" },
		});
		const result = routes(idOf("pkg/d.py", "thing"), "other");

		expect({ sites: sitesOf(result)["use.py"], blockers: blockersOf(result), readers: result.readers }).toEqual({
			sites: ["1:6"],
			blockers: [{ kind: "RouteUnknown", detail: useUntraced("thing"), sites: [{ module: "use2.py", line: 2 }] }],
			readers: ["pkg/__init__.py", "use.py", "use2.py"],
		});
	});
});

describe("a rename checks every landing that gains its new name", () => {
	it("blocks unknown coverage or an unknown __all__ entry where a landing off the old routes starts carrying the new name", () => {
		write("d.ts", { declares: ["N"] });
		write("hub.ts", { declares: ["N"], ...joined(star("./d", 1), star("mystery", 2)), lands: { "./d": "d.ts" } });
		write("d.py", {
			declares: ["N"],
			allList: {
				state: "static",
				entries: [
					{ name: "N", range: at(5, 11, 3), target: { kind: "symbol", symbolId: idOf("d.py", "N") } },
					{ name: "M", range: at(5, 16, 3), target: { kind: "unknown", reason: "NotIndexed" } },
				],
			},
		});

		expect({
			coverage: blockersOf(routes(N, "M")),
			allList: blockersOf(routes(idOf("d.py", "N"), "M")),
		}).toEqual({
			coverage: [
				{
					kind: "RouteUnknown",
					detail: newNameUnproved("hub.ts", "M"),
					sites: [{ module: "hub.ts", line: 2 }],
				},
			],
			allList: [
				{ kind: "RouteUnknown", detail: newNameUnproved("d.py", "M"), sites: [{ module: "d.py", line: 6 }] },
			],
		});
	});

	it("blocks a forward meeting the module's own declaration of the new name, though the forward's token binds nothing", () => {
		write("d.ts", { declares: ["N"] });
		write("hub.ts", { declares: ["M"], ...forward("./d", "N", at(1, 9)), lands: { "./d": "d.ts" } });

		expect(blockersOf(routes(N, "M"))).toEqual([
			{ kind: "NameTaken", detail: nameAlreadyExposed("M", "hub.ts"), sites: [{ module: "hub.ts", line: 1 }] },
		]);
	});

	it("projects a module whose whole value is the subject, and keeps a name its renderer writes apart from its token", () => {
		const parse = declaration("d.js", "parse", 0);
		write("d.js", {
			members: [parse],
			exports: [
				{
					form: "assignment",
					span: at(1, 0),
					target: { kind: "symbol", symbolId: parse.symbolId },
					conflict: LATER,
					certainty: { status: "known" },
					order: 0,
				},
			],
		});
		const load = declaration("e.js", "load", 0);
		write("e.js", {
			members: [load],
			exports: [
				{
					form: "local",
					span: at(1, 19, 4),
					name: "load",
					range: at(1, 19, 4),
					sourceRange: at(1, 19, 4),
					target: { kind: "symbol", symbolId: load.symbolId },
					conflict: LATER,
					certainty: { status: "known" },
					order: 0,
				},
			],
		});
		const rows = (result: ResolvedRoutes, module: string) =>
			result.projected
				.filter(({ landing }) => landing.kind === "module" && landing.module === module)
				.flatMap(({ rows: each }) => each.map((row) => row.name));

		expect({
			value: rows(routes(parse.symbolId, "run"), "d.js"),
			shorthand: rows(routes(load.symbolId, "fetch"), "e.js"),
		}).toEqual({ value: [null], shorthand: ["load"] });
	});

	it("lets one star carry a module's merged value and type, and blocks disjoint meanings meeting across two stars", () => {
		const typed = (module: string, value: string, type: string) => {
			const left = declaration(module, value, 0);
			const right: Declaration = {
				...declaration(module, type, 1),
				symbolId: typeOf(module, type),
				kind: "interface",
			};
			write(module, {
				members: [left, right],
				exports: [
					{ ...direct(left, 0), meaning: ["value"] },
					{ ...direct(right, 1), meaning: ["type"] },
				],
			});
			return left.symbolId;
		};
		const merged = typed("d.ts", "N", "M");
		write("hub.ts", { ...star("./d", 0), lands: { "./d": "d.ts" } });
		const apart = typed("d2.ts", "N", "Unused");
		typed("e.ts", "Other", "M");
		write("hub2.ts", { ...joined(star("./d2", 0), star("./e", 1)), lands: { "./d2": "d2.ts", "./e": "e.ts" } });

		expect({
			merged: routes(merged, "M").blockers,
			apart: blockersOf(routes(apart, "M")).map(({ kind, detail }) => ({ kind, detail })),
		}).toEqual({ merged: [], apart: [{ kind: "NameTaken", detail: nameAlreadyExposed("M", "hub2.ts") }] });
	});

	it("reads importers of every alias a namespace holder exports, whichever landing reaches it first", () => {
		write("d.ts", { declares: ["N"] });
		write("a.ts", { ...forward("./d", "N", at(0, 9)), lands: { "./d": "d.ts" } });
		const space = (line: number, local: string) =>
			edge("namespace", at(line, 7, 6), { local, localRange: at(line, 12, 1), bindsLocally: false, order: line });
		write("pkg.ts", {
			imports: [
				{ specifier: "./a", edges: [space(0, "a")] },
				{ specifier: "./d", edges: [space(1, "z")] },
			],
			exports: [
				forwarding("namespace", at(0, 7, 6), { name: "a", range: at(0, 12, 1) }),
				forwarding("namespace", at(1, 7, 6), { name: "z", range: at(1, 12, 1), order: 1 }),
			],
			lands: { "./a": "a.ts", "./d": "d.ts" },
		});
		write("use.ts", { imports: [named("./pkg", "z", at(0, 9))], lands: { "./pkg": "pkg.ts" } });

		expect(routes(N, "M").readers).toContain("use.ts");
	});

	it("lets a Python definition after a wildcard shadow it, and same-origin rebinding imports stand together", () => {
		const wild = (line: number): Edges => ({
			imports: [
				{
					specifier: "./d",
					edges: [
						edge("wildcard", at(line, 0), {
							selector: { kind: "allList" },
							bindsLocally: true,
							conflict: LATER,
							order: line,
						}),
					],
				},
			],
			exports: [],
		});
		const subject = idOf("d.py", "N");
		write("d.py", { declares: ["N"], allList: PY_ABSENT });
		const shaped = (module: string, star: number, def: number, read: number) => {
			const own = declaration(module, "M", def);
			write(module, {
				members: [own],
				...wild(star),
				references: [use("M", at(read, 0), own.symbolId)],
				lands: { "./d": "d.py" },
			});
		};
		shaped("after.py", 0, 1, 2);
		shaped("before.py", 1, 0, 2);
		shaped("between.py", 0, 2, 1);
		const blocked = () =>
			blockersOf(routes(subject, "M")).flatMap(
				({ sites }) => (sites as Array<{ module: string; line: number }> | undefined) ?? [],
			);
		const before = blocked();
		write("before.py", {});
		write("between.py", {});
		const shadowed = blocked();
		write("twice.py", {
			imports: [
				named("./d", "N", at(0, 14), { local: "M", localRange: at(0, 19), conflict: LATER }),
				named("./d", "N", at(1, 14), { conflict: LATER, order: 1 }),
			],
			exports: [
				forwarding("forward", at(0, 14), {
					name: "M",
					range: at(0, 19),
					sourceRange: at(0, 14),
					conflict: LATER,
				}),
				forwarding("forward", at(1, 14), { name: "N", range: at(1, 14), conflict: LATER, order: 1 }),
			],
			lands: { "./d": "d.py" },
		});

		expect({ before, shadowed, twice: routes(subject, "M").blockers }).toEqual({
			before: [
				{ module: "before.py", line: 1 },
				{ module: "between.py", line: 2 },
			],
			shadowed: [],
			twice: [],
		});
	});

	it("lets a landing's own declaration outrank the renamed name where nothing imports that landing", () => {
		write("d.ts", { declares: ["N"] });
		write("hub.ts", { declares: ["M"], ...star("./d", 1), lands: { "./d": "d.ts" } });

		expect(routes(N, "M").blockers).toEqual([]);
	});
});
