import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type AllList,
	composeSymbolId,
	type Declaration,
	type Export,
	type Import,
	type ImportEdge,
	type Landing,
	type ScopeContribution,
	type Selector,
} from "@nyaa-lexicon/protocol";
import { exportTracer, type RouteStep, scopeKey, type TracedExport, traceExports } from "../exportProjection";
import { FactAdmissionError } from "../factAdmission";
import { ImportResolver } from "../imports";
import { factsMovedSince, ReadContext } from "../readContext";
import { IndexStore } from "../store";
import { direct, edge, forwarding, landed, named, onLine, TS_CONFLICT } from "./importEdges";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;

interface Shape {
	/** Declared one per line, each exported where it is declared. */
	names?: string[];
	imports?: Import[];
	exports?: Export[];
	allList?: AllList;
	/** Where each specifier lands: a module path, or a scope. */
	lands?: Record<string, string | Landing>;
	provider?: string;
	scopes?: ScopeContribution[];
}

interface Edges {
	imports: Import[];
	exports: Export[];
}

const KNOWN = { status: "known" } as const;

const ACME = { kind: "packageScope", providerId: "ts", scopeId: "com.acme" } as const;

function idOf(module: string, name: string): string {
	return composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] });
}

function declared(module: string, names: readonly string[]): Declaration[] {
	return names.map((name, line) => ({
		symbolId: idOf(module, name),
		kind: "variable",
		name,
		range: onLine(line),
		selectionRange: onLine(line),
		visibility: "public",
		exported: true,
	}));
}

/** Writes a module stating every export, then settles every owed projection unless told not to. */
function write(module: string, shape: Shape = {}, settle = true): void {
	const declarations = declared(module, shape.names ?? []);
	const lands = Object.entries(shape.lands ?? {}).map(([specifier, to]) => {
		const resolution = typeof to === "string" ? landed(to) : ({ status: "resolved", landing: to } as const);
		return [specifier, resolution] as const;
	});
	store.replaceFile({
		module,
		contentHash: JSON.stringify(shape),
		declarations,
		references: [],
		imports: shape.imports ?? [],
		exports: [...declarations.map((each, order) => direct(each, order)), ...(shape.exports ?? [])],
		...(shape.allList === undefined ? {} : { allList: shape.allList }),
		provider: shape.provider ?? "ts",
		scopeContributions: shape.scopes ?? [],
		resolutions: new Map(lands),
	});
	if (settle) store.settleProjections();
}

/** `export { source as name } from "specifier"` on `line`. */
function forwarded(specifier: string, source: string, name: string, line: number, meaning?: string[]): Edges {
	return {
		imports: [
			named(specifier, source, onLine(line), {
				bindsLocally: false,
				order: line,
				...(meaning === undefined ? {} : { meaning }),
			}),
		],
		exports: [forwarding("forward", onLine(line), { name, range: onLine(line), order: line })],
	};
}

/** `export * from "specifier"` on `line`, through the import's selector and the export's filter. */
function star(
	specifier: string,
	line: number,
	selector: Selector = { kind: "allButDefault" },
	filter?: Selector,
	fields: { exported?: Partial<Export>; transfer?: Partial<ImportEdge> } = {},
): Edges {
	return {
		imports: [
			{
				specifier,
				edges: [
					edge("wildcard", onLine(line), { selector, bindsLocally: false, order: line, ...fields.transfer }),
				],
			},
		],
		exports: [
			forwarding("star", onLine(line), {
				order: line,
				...(filter === undefined ? {} : { selector: filter }),
				...fields.exported,
			}),
		],
	};
}

/** `export default name`, `name` declared in the module. */
function defaultOf(module: string, name: string, line: number): Export {
	return {
		form: "default",
		span: onLine(line),
		name: "default",
		range: onLine(line),
		target: { kind: "symbol", symbolId: idOf(module, name) },
		conflict: TS_CONFLICT,
		certainty: KNOWN,
		order: line,
	};
}

function joined(...parts: Edges[]): Edges {
	return { imports: parts.flatMap((part) => part.imports), exports: parts.flatMap((part) => part.exports) };
}

/** Each exposed name, its meaning, what it binds to and why it is unsure, sorted. */
function exposed(module: string): string[] {
	return store
		.effectiveExportsOf(module)
		.map((row) => {
			const origin = row.origin;
			const to =
				origin.kind === "symbol"
					? origin.symbolId
					: origin.kind === "unknown"
						? `unknown ${origin.reason}`
						: origin.kind;
			const meaning = row.meaning === undefined ? "" : `:${row.meaning.join("|")}`;
			const unsure = row.certainty.status === "unknown" ? ` ?${row.certainty.reason}` : "";
			return `${row.name ?? "*"}${meaning} -> ${to}${unsure}`;
		})
		.sort();
}

const bindsTo = (name: string, module: string, as = name) => `${as} -> ${idOf(module, name)}`;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-projection-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the export resolver", () => {
	it("forwards a name under its new one, and a star brings all but default, losing to an explicit export", () => {
		write("a.ts", { names: ["x", "y", "z"], exports: [defaultOf("a.ts", "z", 9)] });
		write("b.ts", {
			names: ["y"],
			...joined(forwarded("./a", "x", "renamed", 5), star("./a", 6)),
			lands: { "./a": "a.ts" },
		});

		expect(exposed("b.ts")).toEqual(
			[bindsTo("x", "a.ts", "renamed"), bindsTo("x", "a.ts"), bindsTo("y", "b.ts"), bindsTo("z", "a.ts")].sort(),
		);
	});

	it("drops a name two stars bring from different declarations, and keeps one they agree on", () => {
		write("a.ts", { names: ["x", "shared"] });
		write("c.ts", { names: ["shared"] });
		write("b.ts", { ...forwarded("./a", "x", "x", 1), lands: { "./a": "a.ts" } });
		write("d.ts", { ...joined(star("./a", 1), star("./c", 2)), lands: { "./a": "a.ts", "./c": "c.ts" } });
		write("e.ts", { ...joined(star("./a", 1), star("./b", 2)), lands: { "./a": "a.ts", "./b": "b.ts" } });

		expect({ clashing: exposed("d.ts"), agreeing: exposed("e.ts") }).toEqual({
			clashing: [bindsTo("x", "a.ts")],
			agreeing: [bindsTo("shared", "a.ts"), bindsTo("x", "a.ts")],
		});
	});

	it("brings what a module's list names through a list star, else what its fallback matches, aliases included", () => {
		const fallback: AllList = { state: "absent", fallback: { glob: "[!_]*", caseInsensitive: false } };
		const listed: AllList = {
			state: "static",
			entries: [
				{ name: "_hidden", range: onLine(8), target: { kind: "symbol", symbolId: idOf("p.py", "_hidden") } },
				{ name: "_alias", range: onLine(9), target: { kind: "import", span: onLine(5) } },
			],
		};
		const p = (allList: AllList) =>
			write("p.py", {
				names: ["shown", "_hidden"],
				...forwarded("./q", "thing", "_alias", 5),
				allList,
				lands: { "./q": "q.py" },
			});
		write("q.py", { names: ["thing"] });
		p(fallback);
		write("m.py", { ...star("./p", 1, { kind: "allList" }), lands: { "./p": "p.py" } });
		const byFallback = exposed("m.py");
		p(listed);

		expect({ byFallback, byList: exposed("m.py") }).toEqual({
			byFallback: [bindsTo("shown", "p.py")],
			byList: [bindsTo("thing", "q.py", "_alias"), bindsTo("_hidden", "p.py")].sort(),
		});
	});

	it("filters a star by names and by pattern", () => {
		write("a.ts", { names: ["x", "y", "yes"] });
		const pattern: Selector = { kind: "pattern", glob: "y*", caseInsensitive: false };
		write("n.ts", {
			...star("./a", 1, { kind: "allButDefault" }, { kind: "names", names: ["x"] }),
			lands: { "./a": "a.ts" },
		});
		write("g.ts", { ...star("./a", 1, pattern), lands: { "./a": "a.ts" } });

		expect({ names: exposed("n.ts"), pattern: exposed("g.ts") }).toEqual({
			names: [bindsTo("x", "a.ts")],
			pattern: [bindsTo("y", "a.ts"), bindsTo("yes", "a.ts")],
		});
	});

	it("reads unknown what it cannot prove: coverage a module never reported, and a name its target lacks", () => {
		write("a.ts", { names: ["x"] });
		store.replaceFile({
			module: "opaque.ts",
			contentHash: "o",
			declarations: declared("opaque.ts", ["seen"]),
			references: [],
		});
		write("u.ts", {
			...joined(star("./opaque", 1), forwarded("./a", "missing", "missing", 2)),
			lands: { "./opaque": "opaque.ts", "./a": "a.ts" },
		});

		expect(exposed("u.ts")).toEqual(
			[
				"* -> unknown NotImplemented ?NotImplemented",
				"missing -> unknown BrokenImport",
				bindsTo("seen", "opaque.ts"),
			].sort(),
		);
	});

	it("settles two modules starring each other, and reads the cycle unknown", () => {
		write("one.ts", { names: ["a1"], ...star("./two", 1), lands: { "./two": "two.ts" } });
		write("two.ts", { names: ["b1"], ...star("./one", 1), lands: { "./one": "one.ts" } });

		const both = [
			bindsTo("a1", "one.ts"),
			bindsTo("b1", "two.ts"),
			"* -> unknown RecursionLimit ?RecursionLimit",
		].sort();
		expect({ one: exposed("one.ts"), two: exposed("two.ts") }).toEqual({ one: both, two: both });
	});

	it("traces a module in a star cycle alike whichever module a shared tracer read first", () => {
		write("d.ts", { names: ["N"] });
		write("one.ts", { ...joined(star("./two", 0), star("./d", 1)), lands: { "./two": "two.ts", "./d": "d.ts" } });
		write("two.ts", { ...star("./one", 0), lands: { "./one": "one.ts" } });
		const named = (rows: readonly TracedExport[]) => rows.flatMap((row) => (row.name === null ? [] : [row.name]));
		const tracer = exportTracer(store);
		tracer.module("one.ts");

		expect({ shared: named(tracer.module("two.ts")), alone: named(traceExports("two.ts", store)) }).toEqual({
			shared: ["N"],
			alone: ["N"],
		});
	});

	it("applies each edge's conflict policy: priority, earlier, later, transfer over local, source order", () => {
		write("a.ts", { names: ["x"] });
		write("b.ts", { names: ["x"] });
		const lands = { "./a": "a.ts", "./b": "b.ts" };
		const policy = (amongTransfers: "exclude" | "earlierWins" | "laterWins", priority = 0) => ({
			exported: { conflict: { ...TS_CONFLICT, priority, amongTransfers } },
		});
		const againstLocal = (rule: "transferWins" | "sourceOrder") => ({
			exported: { conflict: { ...TS_CONFLICT, againstLocal: rule } },
		});
		const both = (first: ReturnType<typeof policy>, second: ReturnType<typeof policy>) =>
			joined(star("./a", 1, undefined, undefined, first), star("./b", 2, undefined, undefined, second));
		write("priority.ts", { ...both(policy("exclude"), policy("exclude", 1)), lands });
		write("earlier.ts", { ...both(policy("earlierWins"), policy("earlierWins")), lands });
		write("later.ts", { ...both(policy("laterWins"), policy("laterWins")), lands });
		write("transfer.ts", {
			names: ["x"],
			...star("./a", 1, undefined, undefined, againstLocal("transferWins")),
			lands,
		});
		write("source.ts", {
			names: ["x"],
			...star("./a", 5, undefined, undefined, againstLocal("sourceOrder")),
			lands,
		});

		expect(["priority.ts", "earlier.ts", "later.ts", "transfer.ts", "source.ts"].map(exposed)).toEqual([
			[bindsTo("x", "b.ts")],
			[bindsTo("x", "a.ts")],
			[bindsTo("x", "b.ts")],
			[bindsTo("x", "a.ts")],
			[bindsTo("x", "a.ts")],
		]);
	});

	it("narrows a forward by the import's meaning, keeping each row's own", () => {
		const thing = (kind: "term" | "type") =>
			composeSymbolId({ language: "ts", module: "a.ts", descriptors: [{ kind, name: "Thing" }] });
		const declarations: Declaration[] = (["term", "type"] as const).map((kind, line) => ({
			symbolId: thing(kind),
			kind: kind === "term" ? "variable" : "interface",
			name: "Thing",
			range: onLine(line),
			selectionRange: onLine(line),
			visibility: "public",
			exported: true,
		}));
		store.replaceFile({
			module: "a.ts",
			contentHash: "a",
			declarations,
			references: [],
			exports: declarations.map((each, order) => ({
				...direct(each, order),
				meaning: [order === 0 ? "value" : "type"],
			})),
		});
		write("typed.ts", { ...forwarded("./a", "Thing", "Thing", 1, ["type"]), lands: { "./a": "a.ts" } });
		write("whole.ts", { ...forwarded("./a", "Thing", "Thing", 1), lands: { "./a": "a.ts" } });

		expect({ typed: exposed("typed.ts"), whole: exposed("whole.ts") }).toEqual({
			typed: [`Thing:type -> ${thing("type")}`],
			whole: [`Thing:type -> ${thing("type")}`, `Thing:value -> ${thing("term")}`],
		});
	});

	it("follows an assignment through a default import to what the default names", () => {
		write("a.ts", { names: ["z"], exports: [defaultOf("a.ts", "z", 9)] });
		write("b.ts", {
			imports: [
				{
					specifier: "./a",
					edges: [edge("default", onLine(1), { local: "foo", localRange: onLine(1), order: 1 })],
				},
			],
			exports: [
				{
					form: "assignment",
					span: onLine(2),
					target: { kind: "import", span: onLine(1) },
					conflict: TS_CONFLICT,
					certainty: KNOWN,
					order: 2,
				},
			],
			lands: { "./a": "a.ts" },
		});

		expect(exposed("b.ts")).toEqual([`* -> ${idOf("a.ts", "z")}`]);
	});

	it("reads one origin known when any path to it is, whatever the order", () => {
		write("a.ts", { names: ["x"] });
		write("b.ts", { ...forwarded("./a", "x", "x", 1), lands: { "./a": "a.ts" } });
		const unsure = { transfer: { certainty: { status: "unknown", reason: "Ambiguous" } as const } };
		const lands = { "./a": "a.ts", "./b": "b.ts" };
		write("c.ts", { ...joined(star("./a", 1, undefined, undefined, unsure), star("./b", 2)), lands });

		expect(exposed("c.ts")).toEqual([bindsTo("x", "a.ts")]);
	});

	it("traces every path of edges to an exposure, two stars reaching one origin included", () => {
		write("a.ts", { names: ["x"] });
		write("b.ts", { ...forwarded("./a", "x", "x", 1), lands: { "./a": "a.ts" } });
		write("c.ts", { ...joined(star("./a", 1), star("./b", 2)), lands: { "./a": "a.ts", "./b": "b.ts" } });
		const steps = (path: RouteStep[]) =>
			path.map(
				(step) => `${step.module} ${step.export.form}${step.import ? ` via ${step.import.landing?.kind}` : ""}`,
			);

		expect(traceExports("c.ts", store).map((row) => ({ name: row.name, paths: row.paths.map(steps) }))).toEqual([
			{
				name: "x",
				paths: [
					["c.ts star via module", "a.ts direct"],
					["c.ts star via module", "b.ts forward via module", "a.ts direct"],
				],
			},
		]);
	});

	it("brings no unknown coverage through a filter that names nothing", () => {
		store.replaceFile({
			module: "opaque.ts",
			contentHash: "o",
			declarations: declared("opaque.ts", ["seen"]),
			references: [],
		});
		write("n.ts", {
			...star("./opaque", 1, undefined, { kind: "names", names: [] }),
			lands: { "./opaque": "opaque.ts" },
		});

		expect(exposed("n.ts")).toEqual([]);
	});
});

describe("settlement", () => {
	it("carries a name a module gains through a star barrel nobody rewrote, as the barrel's move", () => {
		write("d.ts", { names: ["n1"] });
		write("b.ts", { ...star("./d", 1), lands: { "./d": "d.ts" } });
		store.settleMoves(store.surfaceMovesOf(null), []);

		write("d.ts", { names: ["n1", "n2"] });

		expect({ exposed: exposed("b.ts"), gained: store.surfaceMovesOf(["b.ts"]).get("b.ts")?.gained }).toEqual({
			exposed: [bindsTo("n1", "d.ts"), bindsTo("n2", "d.ts")],
			gained: ["n2"],
		});
	});

	it("moves no surface and re-mints no reference when an import moves down a line", () => {
		write("a.ts", { names: ["x"] });
		const at = (line: number) => ({
			module: "c.ts",
			contentHash: `c${line}`,
			declarations: declared("c.ts", ["own"]),
			references: [
				{
					name: "x",
					range: onLine(5),
					role: "read" as const,
					binding: { status: "bound" as const, symbolId: idOf("a.ts", "x"), provenance: "bound" as const },
					origin: { kind: "import" as const, span: onLine(line) },
				},
			],
			imports: [named("./a", "x", onLine(line))],
			resolutions: new Map([["./a", landed("a.ts")]]),
		});
		store.replaceFile(at(1));
		const ids = store.referencesIn("c.ts").map((row) => row.factId);

		expect({ moved: store.replaceFile(at(2)), ids: store.referencesIn("c.ts").map((row) => row.factId) }).toEqual({
			moved: null,
			ids,
		});
	});

	it("reads a landing the index does not hold as unknown, then what it exports once it arrives, even nothing", () => {
		write("b.ts", { ...star("./later", 1), lands: { "./later": "later.ts" } });
		const before = exposed("b.ts");
		write("later.ts");
		const empty = exposed("b.ts");
		write("later.ts", { names: ["x"] });

		expect({ before, empty, after: exposed("b.ts") }).toEqual({
			before: ["* -> unknown NotIndexed ?NotIndexed"],
			empty: [],
			after: [bindsTo("x", "later.ts")],
		});
	});

	it("carries a scope's members and its own exports through a star, and drops a member that leaves", () => {
		const member = (exports: Export[] = []) =>
			write("m.ts", {
				names: ["Foo"],
				exports,
				scopes: [{ kind: "packageScope", scopeId: ACME.scopeId, members: [idOf("m.ts", "Foo")] }],
			});
		member();
		write("b.ts", { ...star("com.acme", 1), lands: { "com.acme": ACME } });
		const members = exposed("b.ts");
		member([{ ...direct(declared("m.ts", ["Foo"])[0] as Declaration, 5), name: "Alias", scopeId: ACME.scopeId }]);
		const exported = exposed("b.ts");
		write("m.ts", { names: ["Foo"] });

		expect({ members, exported, left: exposed("b.ts") }).toEqual({
			members: [bindsTo("Foo", "m.ts")],
			exported: [bindsTo("Foo", "m.ts", "Alias"), bindsTo("Foo", "m.ts")],
			left: ["* -> unknown NotIndexed ?NotIndexed"],
		});
	});

	it("resumes owed projections after the store reopens", () => {
		write("d.ts", { names: ["n1"] });
		write("b.ts", { ...star("./d", 1), lands: { "./d": "d.ts" } });
		write("d.ts", { names: ["n1", "n2"] }, false);
		store.close();
		store = IndexStore.open(path.join(dir, "index.sqlite")).store;
		store.settleProjections();

		expect(exposed("b.ts")).toEqual([bindsTo("n1", "d.ts"), bindsTo("n2", "d.ts")]);
	});

	it("moves nothing held before when it forgets a module only a parse failure named", () => {
		store.recordFailure("broken.ts", "syntax");
		store.forgetFile("broken.ts");

		expect(store.surfaceMovesOf(["broken.ts"]).get("broken.ts")?.heldBefore).toBe(false);
	});
});

describe("stored edges", () => {
	it("reads back every edge, export, list, origin and scope as written", () => {
		write("a.ts", { names: ["x"] });
		const imported = edge("named", onLine(1), {
			name: "x",
			range: onLine(1),
			local: "y",
			localRange: onLine(2),
			typeOnly: true,
			order: 3,
		});
		const exported = forwarding("forward", onLine(1), {
			name: "y",
			range: onLine(2),
			sourceRange: onLine(1),
			order: 3,
		});
		const allList: AllList = { state: "dynamic", reason: "NotIndexed" };
		const origin = { kind: "import" as const, span: onLine(1), path: ["deep"] };
		store.replaceFile({
			module: "r.ts",
			contentHash: "r",
			declarations: declared("r.ts", ["member"]),
			references: [
				{
					name: "y",
					range: onLine(4),
					role: "read",
					binding: { status: "bound", symbolId: idOf("a.ts", "x"), provenance: "bound" },
					origin,
				},
			],
			imports: [{ specifier: "./a", edges: [imported] }],
			exports: [exported],
			allList,
			provider: "ts",
			scopeContributions: [{ kind: "packageScope", scopeId: "com.acme", members: [idOf("r.ts", "member")] }],
			resolutions: new Map([["./a", landed("a.ts")]]),
		});

		expect({
			edges: store.importsIn("r.ts").map(({ factId: _id, module: _module, ...row }) => row),
			exports: store.exportsIn("r.ts").map(({ factId: _id, module: _module, ...row }) => row),
			allList: store.fileOf("r.ts")?.allList,
			origins: store.referencesIn("r.ts").map((row) => row.origin),
			members: store.scopeMembers({ kind: "packageScope", providerId: "ts", scopeId: "com.acme" }),
		}).toEqual({
			edges: [{ ...imported, specifier: "./a", landing: { kind: "module", module: "a.ts" } }],
			exports: [exported],
			allList,
			origins: [origin],
			members: [{ symbolId: idOf("r.ts", "member"), name: "member" }],
		});
	});

	it("refuses a scope member, landing or provider it cannot hold, keeping the facts it had", () => {
		write("r.ts", { names: ["own"] });
		const before = store.contentHashOf("r.ts");
		const refused = [
			{ scopes: [{ kind: "packageScope" as const, scopeId: "p", members: [idOf("other.ts", "X")] }] },
			{ lands: { "./x": "../outside.ts" } },
			{ provider: "", scopes: [{ kind: "packageScope" as const, scopeId: "p", members: [idOf("r.ts", "own")] }] },
		].map((shape) => {
			try {
				write("r.ts", { names: ["own"], ...shape });
				return "written";
			} catch (error) {
				return error instanceof FactAdmissionError ? "refused" : String(error);
			}
		});

		expect({ refused, kept: store.contentHashOf("r.ts") }).toEqual({
			refused: ["refused", "refused", "refused"],
			kept: before,
		});
	});

	it("advances the facts generation on every write, and a scope's only on its contributors' writes", () => {
		const scope = { kind: "packageScope" as const, providerId: "ts", scopeId: "com.acme" };
		const key = scopeKey(scope);
		const contribute = (module: string, members: string[], scopeId = scope.scopeId) =>
			store.replaceFile({
				module,
				contentHash: `${module}:${members.join()}`,
				declarations: declared(module, members),
				references: [],
				provider: "ts",
				scopeContributions: [{ kind: "packageScope", scopeId, members: members.map((m) => idOf(module, m)) }],
			});
		const steps: Array<() => unknown> = [
			() => contribute("s1.ts", []),
			() => write("unrelated.ts", { names: ["u"] }),
			() => contribute("s2.ts", ["m"]),
			() => store.forgetFile("s1.ts"),
		];
		const advanced = steps.map((step) => {
			const before = [store.factsGeneration(), store.scopeGeneration(key)];
			step();
			return [store.factsGeneration() - (before[0] ?? 0), store.scopeGeneration(key) - (before[1] ?? 0)];
		});
		contribute("s3.ts", [], "com.empty");

		expect({
			advanced,
			members: store.scopeMembers(scope),
			heldWhileEmpty: store.scopeMembers({ ...scope, scopeId: "com.empty" }),
			unheld: store.scopeMembers({ ...scope, scopeId: "com.none" }),
		}).toEqual({
			advanced: [
				[1, 1],
				[1, 0],
				[1, 1],
				[1, 1],
			],
			members: [{ symbolId: idOf("s2.ts", "m"), name: "m" }],
			heldWhileEmpty: [],
			unheld: null,
		});
	});
});

describe("reads a plan relies on", () => {
	const acmeMember = (module: string, name: string) => ({
		names: [name],
		scopes: [{ kind: "packageScope" as const, scopeId: ACME.scopeId, members: [idOf(module, name)] }],
	});

	it("go stale when a scope they read moves, or an export they read is projected again", () => {
		write("m.ts", acmeMember("m.ts", "Foo"));
		write("a.ts", { names: ["x"] });
		write("b.ts", { ...forwarded("./a", "x", "x", 1), lands: { "./a": "a.ts" } });
		const context = new ReadContext(store);
		context.scopeMembers(ACME);
		context.exposuresNamed("x");
		const still = factsMovedSince(context.seen(), store);
		write("n.ts", acmeMember("n.ts", "Bar"));
		write("a.ts", { names: ["y"] });

		expect({ still, moved: factsMovedSince(context.seen(), store).sort() }).toEqual({
			still: [],
			moved: ["a.ts", "b.ts", "com.acme"],
		});
	});

	it("take a move site that lands on a scope holding the declaration, and none on another scope", async () => {
		const other = { ...ACME, scopeId: "com.other" };
		write("m.ts", acmeMember("m.ts", "Foo"));
		write("u.ts", { imports: [named("com.acme", "Foo", onLine(1))], lands: { "com.acme": ACME } });
		write("v.ts", { imports: [named("com.other", "Foo", onLine(1))], lands: { "com.other": other } });
		const resolver = new ImportResolver(store, async (_from, specifier) => ({
			status: "resolved",
			landing: specifier === "com.acme" ? ACME : other,
		}));
		const sites = await resolver.importSitesResolvingTo(idOf("m.ts", "Foo"), "m.ts", "Foo", store);

		expect(sites.map((each) => each.module)).toEqual(["u.ts"]);
	});

	it("cite an export exposing the symbol under another name", () => {
		write("a.ts", { names: ["x"] });
		write("b.ts", { ...forwarded("./a", "x", "renamed", 1), lands: { "./a": "a.ts" } });

		expect(store.exportsOf(idOf("a.ts", "x")).map((edge) => `${edge.module} ${edge.name}`)).toEqual([
			"a.ts x",
			"b.ts renamed",
		]);
	});
});
