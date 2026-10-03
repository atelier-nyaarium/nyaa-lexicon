import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyEdits,
	coordinatesOf,
	type Export,
	type FileFacts,
	hashContent,
	PROTOCOL_VERSION,
	type Range,
	type Reference,
	sameRange,
} from "@nyaa-lexicon/protocol";
import { PythonProvider, wireHandlers } from "../main";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): PythonProvider {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-python-routes-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	const provider = new PythonProvider();
	const handlers = wireHandlers(provider);
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return provider;
}

async function parse(provider: PythonProvider, module: string, text: string): Promise<FileFacts> {
	return wireHandlers(provider).parseFile({ module, contentHash: hashContent(text), text });
}

function spanOf(text: string, value: string, from = 0): Range {
	const index = text.indexOf(value, from);
	const range = coordinatesOf(text).rangeAt(index, index + value.length);
	if (index === -1 || range === undefined) throw new Error(`${value} is not in the text`);
	return range;
}

/** How a case names an import edge: its local binding, else its source name, else a load's module, else `*`. */
function edgeAt(facts: FileFacts, span: Range): string | undefined {
	for (const { specifier, edges } of facts.imports) {
		const edge = edges.find((each) => sameRange(each.span, span));
		if (edge !== undefined) return edge.local ?? edge.name ?? (edge.kind === "sideEffect" ? specifier : "*");
	}
	return undefined;
}

function describeExport(facts: FileFacts, edge: Export): string {
	const target =
		edge.target.kind === "symbol"
			? facts.declarations.find(
					(declaration) => declaration.symbolId === (edge.target as { symbolId: string }).symbolId,
				)?.name
			: edge.target.kind === "import"
				? `edge ${edgeAt(facts, edge.target.span)}`
				: edge.target.reason;
	return `${edge.form} ${edge.name ?? "*"} -> ${target} ${edge.certainty.status}`;
}

/** Each use of `name` in a role: its binding's module and declaration name, and its origin. */
function uses(facts: FileFacts, name: string, role: Reference["role"] = "call"): string[] {
	return facts.references
		.filter((reference) => reference.name === name && reference.role === role)
		.map((reference) => {
			const binding =
				reference.binding.status === "bound"
					? reference.binding.symbolId
					: `${reference.binding.status} ${"reason" in reference.binding ? reference.binding.reason : ""}`;
			const origin =
				reference.origin === undefined
					? "no origin"
					: reference.origin.kind === "declaration"
						? "declaration"
						: `edge ${edgeAt(facts, reference.origin.span)}${(reference.origin.path ?? []).map((part) => `.${part}`).join("")}`;
			return `${binding} via ${origin}`;
		});
}

const IMPL = "def thing():\n    pass\n\n\ndef _private():\n    pass\n";

describe("Python export facts", () => {
	it("exports every module-level binding, each import as a forward or star export on its own edge", async () => {
		const provider = workspace({});
		const text = [
			"import os",
			"import a.b",
			"from .m import N",
			"from .m import P as Q",
			"from .m import *",
			"if flag:",
			"    from .c import C",
			"def add():",
			"    pass",
			"_hidden = 1",
			"class K:",
			"    def method(self):",
			"        pass",
			"def f():",
			"    from .m import inner",
			"",
		].join("\n");
		const facts = await parse(provider, "pkg/__init__.py", text);
		const exports = facts.exports ?? [];

		expect(exports.map((edge) => describeExport(facts, edge))).toEqual([
			"forward os -> edge os known",
			"forward a -> edge a known",
			"forward N -> edge N known",
			"forward Q -> edge Q known",
			"star * -> edge * known",
			"forward C -> edge C unknown",
			"direct add -> add known",
			"direct _hidden -> _hidden known",
			"direct K -> K known",
			"direct f -> f known",
		]);
		expect(exports.find((edge) => edge.name === "Q")).toMatchObject({
			span: spanOf(text, "P as Q"),
			range: spanOf(text, "Q", text.indexOf("P as Q")),
			sourceRange: spanOf(text, "P", text.indexOf("P as Q")),
		});
		const edges = facts.imports.flatMap((statement) => statement.edges);
		const orders = [...edges.map((edge) => edge.order), ...exports.map((edge) => edge.order)];
		expect(new Set(orders).size).toBe(orders.length);
		for (const edge of exports.filter((each) => each.target.kind === "import")) {
			const transfer = edges.find((each) => sameRange(each.span, edge.span));
			expect(transfer !== undefined && transfer.order < edge.order).toBe(true);
		}
		expect(edges.find((edge) => edge.kind === "sideEffect")).toMatchObject({ bindsLocally: false });
		expect(edges.filter((edge) => edge.kind !== "sideEffect").map((edge) => edge.conflict)).toEqual(
			edges
				.filter((edge) => edge.kind !== "sideEffect")
				.map(() => ({ priority: 0, amongTransfers: "laterWins", againstLocal: "sourceOrder" })),
		);
	});

	it("exports only a name's last binder, and every binder a conditional one after it leaves uncertain", async () => {
		const provider = workspace({});
		const exported = async (text: string) => {
			const facts = await parse(provider, "pkg/barrel.py", text);
			return {
				exports: (facts.exports ?? []).map((edge) => describeExport(facts, edge)),
				listed:
					facts.allList?.state === "static" ? facts.allList.entries.map((entry) => entry.target.kind) : [],
			};
		};

		expect({
			defLast: await exported('__all__ = ["item"]\nfrom .impl import item\n\n\ndef item():\n    pass\n'),
			importLast: await exported("def item():\n    pass\n\n\nfrom .impl import item\n"),
			conditionalLast: await exported("from .impl import item\nif flag:\n\n    def item():\n        pass\n"),
		}).toEqual({
			defLast: { exports: ["direct item -> item known"], listed: ["symbol"] },
			importLast: { exports: ["forward item -> edge item known"], listed: [] },
			conditionalLast: {
				exports: ["forward item -> edge item unknown", "direct item -> item unknown"],
				listed: [],
			},
		});
	});

	it("matches each static __all__ string to its binding, and reports a missing list by its star fallback", async () => {
		const provider = workspace({});
		const listed = '__all__ = ["thing", "Other"]\nfrom .other import Other\n\n\ndef thing():\n    pass\n';
		const facts = await parse(provider, "pkg/mod.py", listed);
		const thing = facts.declarations.find((declaration) => declaration.name === "thing")?.symbolId as string;

		expect(facts.allList).toEqual({
			state: "static",
			entries: [
				{
					name: "thing",
					range: spanOf(listed, '"thing"'),
					target: { kind: "symbol", symbolId: thing },
				},
				{
					name: "Other",
					range: spanOf(listed, '"Other"'),
					target: { kind: "import", span: spanOf(listed, "Other", listed.indexOf("import")) },
				},
			],
		});
		expect((await parse(provider, "pkg/plain.py", "x = 1\n")).allList).toEqual({
			state: "absent",
			fallback: { glob: "[!_]*", caseInsensitive: false },
		});
		const broken = await parse(provider, "pkg/broken.py", "def broken(:\n    pass\n");
		expect([broken.exports, broken.allList]).toEqual([undefined, undefined]);
	});

	it("targets the one star that may bring an `__all__` name, and leaves stars it cannot rank unknown", async () => {
		const THING = "def thing():\n    pass\n";
		const provider = workspace({
			"pkg/__init__.py": "",
			"pkg/one.py": THING,
			"pkg/also.py": THING,
			"pkg/two.py": "def other():\n    pass\n",
			"pkg/listed.py": `__all__ = ["other"]\n${THING}\n\ndef other():\n    pass\n`,
			"pkg/dynamic.py": "__all__ = names()\n",
			"pkg/globalled.py": "def load():\n    global thing\n    thing = 1\n",
		});
		const listed = async (body: string) => {
			const facts = await parse(provider, "pkg/barrel.py", `__all__ = ["thing"]\n${body}`);
			const entry = facts.allList?.state === "static" ? facts.allList.entries[0] : undefined;
			const target = entry?.target;
			if (target?.kind === "symbol") return "symbol";
			if (target?.kind !== "import") return target?.reason;
			return facts.imports.find(({ edges }) => edges.some((edge) => sameRange(edge.span, target.span)))
				?.specifier;
		};

		expect({
			alone: await listed("from .one import *\n"),
			onlyOneBrings: await listed("from .two import *\nfrom .one import *\nfrom .listed import *\n"),
			unprovedAlone: await listed("from .dynamic import *\n"),
			noneBrings: await listed("from .two import *\n"),
			twoBring: await listed("from .one import *\nfrom .also import *\n"),
			twoMay: await listed("from .one import *\nfrom .dynamic import *\n"),
			conditional: await listed("if flag:\n    from .one import *\n"),
			globalWriter: await listed("from .one import *\n\n\ndef load():\n    global thing\n    thing = 1\n"),
		}).toEqual({
			alone: ".one",
			onlyOneBrings: ".one",
			unprovedAlone: ".dynamic",
			noneBrings: "NotIndexed",
			twoBring: "Ambiguous",
			twoMay: "Ambiguous",
			conditional: "Ambiguous",
			globalWriter: "Ambiguous",
		});
		expect({
			starBefore: await listed(`from .one import *\n${THING}`),
			laterAbsent: await listed(`${THING}from .two import *\n`),
			laterBrings: await listed(`${THING}from .one import *\n`),
			laterUnproved: await listed(`${THING}from .dynamic import *\n`),
			laterGlobalOnly: await listed(`${THING}from .globalled import *\n`),
		}).toEqual({
			starBefore: "symbol",
			laterAbsent: "symbol",
			laterBrings: ".one",
			laterUnproved: "Ambiguous",
			laterGlobalOnly: "Ambiguous",
		});
	});
});

describe("Python reference origins and routes", () => {
	it("names the declaration or the import edge a use resolves through, only once nothing competes", async () => {
		const provider = workspace({ "pkg/__init__.py": "", "pkg/add.py": "def add():\n    pass\n" });
		const facts = await parse(
			provider,
			"pkg/use.py",
			"from .add import add as plus\n\n\ndef local():\n    pass\n\n\nplus()\nlocal()\nprint()\n",
		);
		const competing = await parse(
			provider,
			"pkg/both.py",
			"from .add import add\n\n\ndef add():\n    pass\n\n\nadd()\n",
		);
		const declared = (await parse(provider, "pkg/add.py", "def add():\n    pass\n")).declarations[0]?.symbolId;

		expect([uses(facts, "plus"), uses(facts, "local"), uses(facts, "print")]).toEqual([
			[`${declared} via edge plus`],
			[`${facts.declarations.find((declaration) => declaration.name === "local")?.symbolId} via declaration`],
			["unbound NotImplemented via no origin"],
		]);
		expect(uses(competing, "add")).toEqual([
			`${competing.declarations.find((declaration) => declaration.name === "add")?.symbolId} via no origin`,
		]);
	});

	it("leaves a use unbound where an import, not the same-scope declaration, may be what it reads", async () => {
		const provider = workspace({ "pkg/__init__.py": "", "pkg/add.py": "def add():\n    pass\n" });
		const route = async (text: string) => {
			const facts = await parse(provider, "pkg/use.py", text);
			const local = facts.declarations.find((declaration) => declaration.name === "add")?.symbolId as string;
			return uses(facts, "add").map((use) => use.replace(local, "local"));
		};

		expect({
			readFirst: await route("from .add import add\nadd()\n\n\ndef add():\n    pass\n"),
			classBody: await route("from .add import add\n\n\nclass C:\n    x = add()\n\n\ndef add():\n    pass\n"),
			importBetween: await route("def add():\n    pass\n\n\nfrom .add import add\n\nadd()\n"),
			importLast: await route("def add():\n    pass\n\n\nfrom .add import add\n\n\ndef run():\n    add()\n"),
			deferred: await route("from .add import add\n\n\ndef run():\n    add()\n\n\ndef add():\n    pass\n"),
		}).toEqual({
			readFirst: ["unbound Ambiguous via no origin"],
			classBody: ["unbound Ambiguous via no origin"],
			importBetween: ["unbound Ambiguous via no origin"],
			importLast: ["unbound Ambiguous via no origin"],
			deferred: ["local via no origin"],
		});
	});

	it("binds a use through package re-exports and stars to the declaration, and leaves an unproved route unbound", async () => {
		const provider = workspace({
			"pkg/__init__.py": "from .impl import thing\n",
			"pkg/impl.py": IMPL,
			"starred/__init__.py": "from pkg.impl import *\n",
			"dynamic/__init__.py": "from pkg.impl import *\n__all__ = names()\n",
			"twice/__init__.py": "from pkg.impl import thing\n\n\ndef thing():\n    pass\n",
			"loop/__init__.py": "",
			"loop/a.py": "from .b import thing\n",
			"loop/b.py": "from .a import thing\n",
		});
		const thing = (await parse(provider, "pkg/impl.py", IMPL)).declarations[0]?.symbolId;
		const route = async (text: string, name = "thing") => uses(await parse(provider, "use.py", text), name);

		expect({
			named: await route("from pkg import thing\nthing()\n"),
			star: await route("from starred import thing\nthing()\n"),
			hidden: await route("from starred import _private\n_private()\n", "_private"),
			listedNamed: await route("from dynamic import thing\nthing()\n"),
			listedStar: await route("from dynamic import *\nthing()\n"),
			consumerStar: await route("from starred import *\nthing()\n"),
			twice: await route("from twice import thing\nthing()\n"),
			loop: await route("from loop.a import thing\nthing()\n"),
		}).toEqual({
			named: [`${thing} via edge thing`],
			star: [`${thing} via edge thing`],
			hidden: ["unbound NotIndexed via no origin"],
			listedNamed: [`${thing} via edge thing`],
			listedStar: ["unbound Ambiguous via no origin"],
			consumerStar: [`${thing} via edge *`],
			twice: ["unbound Ambiguous via no origin"],
			loop: ["unbound RecursionLimit via no origin"],
		});
	});

	it("routes `ns.N` through a namespace import only while `ns` binds nothing else", async () => {
		const provider = workspace({ "pkg/__init__.py": "from .impl import thing\n", "pkg/impl.py": IMPL });
		const thing = (await parse(provider, "pkg/impl.py", IMPL)).declarations[0]?.symbolId;
		const route = async (text: string, name = "thing") => uses(await parse(provider, "use.py", text), name);

		expect({
			plain: await route("import pkg\npkg.thing()\n"),
			aliased: await route("import pkg.impl as impl\nimpl.thing()\n"),
			dotted: await route("import pkg.impl\npkg.impl.thing()\n"),
			missing: await route("import pkg\npkg.missing()\n", "missing"),
			shadowed: await route("import pkg\n\n\ndef run(pkg):\n    pkg.thing()\n"),
		}).toEqual({
			plain: [`${thing} via edge pkg.thing`],
			aliased: [`${thing} via edge impl.thing`],
			dotted: [`${thing} via edge pkg.impl.thing`],
			missing: ["unbound Ambiguous via edge pkg.missing"],
			shadowed: ["unbound Ambiguous via no origin"],
		});
	});

	it("names the edge that loads a submodule receiver, with the member read from it", async () => {
		const F = "def f():\n    pass\n";
		const G = "def g():\n    pass\n";
		const H = "def h():\n    pass\n";
		const provider = workspace({
			"a/__init__.py": "",
			"a/b/__init__.py": G,
			"a/b/c.py": H,
			"pkg/__init__.py": "",
			"pkg/mod.py": F,
		});
		const declared = async (module: string, text: string) =>
			(await parse(provider, module, text)).declarations[0]?.symbolId;
		const route = async (module: string, text: string, name: string) => {
			const facts = await parse(provider, module, text);
			const use = facts.references.find((reference) => reference.name === name);
			const origin = use?.origin;
			return {
				bound: use?.binding.status === "bound" ? use.binding.symbolId : undefined,
				origin,
				edge: facts.imports.flatMap(({ specifier, edges }) =>
					edges
						.filter((edge) => origin?.kind === "import" && sameRange(edge.span, origin.span))
						.map((edge) => `${edge.kind} ${specifier}`),
				),
			};
		};
		const chain = "import a.b.c\na.b.g()\na.b.c.h()\n";
		const named = "from pkg import mod\nmod.f()\n";
		const relative = "from . import mod\nmod.f()\n";

		expect({
			parent: await route("use.py", chain, "g"),
			leaf: await route("use.py", chain, "h"),
			named: await route("use.py", named, "f"),
			relative: await route("pkg/use.py", relative, "f"),
		}).toEqual({
			parent: {
				bound: await declared("a/b/__init__.py", G),
				origin: { kind: "import", span: spanOf(chain, "a.b"), path: ["g"] },
				edge: ["sideEffect a.b"],
			},
			leaf: {
				bound: await declared("a/b/c.py", H),
				origin: { kind: "import", span: spanOf(chain, "a.b.c"), path: ["h"] },
				edge: ["sideEffect a.b.c"],
			},
			named: {
				bound: await declared("pkg/mod.py", F),
				origin: { kind: "import", span: spanOf(named, "mod"), path: ["f"] },
				edge: ["namespace pkg.mod"],
			},
			relative: {
				bound: await declared("pkg/mod.py", F),
				origin: { kind: "import", span: spanOf(relative, "mod"), path: ["f"] },
				edge: ["namespace .mod"],
			},
		});
	});

	it("reports `from pkg import mod` as the submodule's namespace edge, and as a named edge where pkg binds mod", async () => {
		const F = "def f():\n    pass\n";
		const provider = workspace({
			"pkg/__init__.py": "def helper():\n    pass\n",
			"pkg/mod.py": F,
			"bound/__init__.py": "mod = 1\n",
			"bound/mod.py": F,
		});
		const text = "from pkg import mod as m, helper\nfrom bound import mod\nfrom pkg import mod\n";
		const facts = await parse(provider, "use.py", text);
		const submodule = facts.imports.find((statement) => statement.specifier === "pkg.mod")?.edges[0];
		const edges = facts.imports.flatMap((statement) => statement.edges);
		const load = edges.find((edge) => edge.kind === "sideEffect");

		expect(
			facts.imports.flatMap(({ specifier, edges }) =>
				edges.map((edge) => `${edge.kind} ${specifier} ${edge.local ?? edge.name ?? ""}`.trim()),
			),
		).toEqual([
			"named pkg helper",
			"namespace pkg.mod m",
			"named bound mod",
			"sideEffect pkg",
			"namespace pkg.mod mod",
		]);
		// A statement left with no edge on `pkg` still loads it.
		expect(load).toMatchObject({
			span: spanOf(text, "pkg", text.lastIndexOf("from")),
			bindsLocally: false,
			certainty: { status: "known" },
		});
		expect(new Set(edges.map((edge) => edge.order)).size).toBe(edges.length);
		expect(submodule).toMatchObject({
			span: spanOf(text, "mod as m"),
			local: "m",
			localRange: spanOf(text, "m", text.indexOf(" as ")),
			bindsLocally: true,
		});
		expect(submodule?.name).toBeUndefined();
	});

	it("reads a package's own `from . import d` as its submodule's namespace, unless the package binds d otherwise", async () => {
		const D = "def thing():\n    return 1\n";
		const own = "from . import d\nd.thing()\n";
		const packages: Record<string, string> = {
			"pkg/__init__.py": "from . import d\n",
			"rival/__init__.py": "from . import d\n\n\ndef load():\n    global d\n    d = 1\n",
			"starred/__init__.py": "from . import d\nfrom .more import *\n",
			"local/__init__.py": "def load():\n    from . import d\n    return d\n",
		};
		const provider = workspace({
			...packages,
			"pkg/d.py": D,
			"rival/d.py": D,
			"starred/d.py": D,
			"starred/more.py": "d = 1\n",
			"local/d.py": D,
		});
		const wired = async (module: string) => {
			const facts = await parse(provider, module, packages[module] as string);
			return {
				imports: facts.imports.flatMap(({ specifier, edges }) =>
					edges.map((edge) => `${edge.kind} ${specifier} ${edge.local ?? edge.name ?? ""}`.trim()),
				),
				exports: (facts.exports ?? []).map((edge) => describeExport(facts, edge)),
			};
		};
		const thing = (await parse(provider, "pkg/d.py", D)).declarations[0]?.symbolId;

		expect({
			own: await wired("pkg/__init__.py"),
			rival: (await wired("rival/__init__.py")).imports,
			starred: (await wired("starred/__init__.py")).imports,
			local: (await wired("local/__init__.py")).imports,
		}).toEqual({
			own: { imports: ["sideEffect .", "namespace .d d"], exports: ["forward d -> edge d known"] },
			rival: ["named . d"],
			starred: ["named . d", "wildcard .more"],
			local: ["sideEffect .", "namespace .d d"],
		});
		expect({
			own: uses(await parse(provider, "pkg/__init__.py", own), "thing"),
			named: uses(await parse(provider, "a.py", "from pkg import d\nprint(d)\n"), "d", "read"),
		}).toEqual({
			own: [`${thing} via edge d.thing`],
			named: ["unbound NotIndexed via no origin"],
		});
	});

	it("names the root import and the member path for each member of a chain the provider cannot bind", async () => {
		const provider = workspace({ "pkg/__init__.py": "from . import d\n", "pkg/d.py": IMPL });
		const attributes = async (text: string) =>
			(await parse(provider, "use.py", text)).references
				.filter((reference) => reference.qualified === true)
				.map((reference) => [reference.name, reference.binding.status, reference.origin]);
		const root = "import pkg\nprint(pkg.d.thing())\n";
		const named = "from pkg import d\nprint(d.thing())\n";

		expect({ root: await attributes(root), named: await attributes(named) }).toEqual({
			root: [
				["d", "unbound", { kind: "import", span: spanOf(root, "pkg"), path: ["d"] }],
				["thing", "unbound", { kind: "import", span: spanOf(root, "pkg"), path: ["d", "thing"] }],
			],
			named: [["thing", "unbound", { kind: "import", span: spanOf(named, "d"), path: ["thing"] }]],
		});
	});

	it("leaves a member unbound where its receiver's module is not proved, with the chain from its root's import", async () => {
		const F = "def f():\n    pass\n";
		const provider = workspace({
			"a/__init__.py": "",
			"a/b.py": F,
			"shadow/__init__.py": "b = 1\n",
			"shadow/b.py": F,
			"globalled/__init__.py": "def load():\n    global b\n    b = 1\n",
			"globalled/b.py": F,
			"mm.py": "",
			"mm/sub.py": F,
			"shop.py": "class Shop:\n    def open(self):\n        pass\n",
			"deep/__init__.py": "",
			"deep/c.py": "x = 1\n",
		});
		const route = async (text: string, name = "f") => uses(await parse(provider, "use.py", text), name);

		expect({
			shadowed: await route("import shadow.b\nshadow.b.f()\n"),
			globalled: await route("import globalled.b\ngloballed.b.f()\n"),
			unloaded: await route("import a\na.b.f()\n"),
			notPackage: await route("from mm import sub\nsub.f()\n"),
			instance: await route("from shop import Shop\n\nx = Shop()\nx.open()\nShop.open(x)\n", "open"),
		}).toEqual({
			shadowed: ["unbound Ambiguous via edge shadow.b.f"],
			globalled: ["unbound Ambiguous via edge globalled.b.f"],
			unloaded: ["unbound Ambiguous via edge a.b.f"],
			notPackage: ["unbound Ambiguous via edge sub.f"],
			instance: ["unbound Ambiguous via no origin", "unbound Ambiguous via edge Shop.open"],
		});
		// Past the deepest module the chain loads, the origin starts at that load.
		const pastLoad = "import deep.c\ndeep.c.x.f()\n";
		const facts = await parse(provider, "use.py", pastLoad);
		expect(facts.references.find((reference) => reference.name === "f")?.origin).toEqual({
			kind: "import",
			span: spanOf(pastLoad, "deep.c"),
			path: ["x", "f"],
		});
	});

	it("gives a member no origin, and a name no import, where a nearer binding than the import is read", async () => {
		const provider = workspace({ "pkg/__init__.py": "from .impl import thing\n", "pkg/impl.py": IMPL });
		const route = async (text: string, name = "thing") => uses(await parse(provider, "use.py", text), name);

		expect({
			lambdaReceiver: await route("import pkg\nf = lambda pkg: pkg.thing()\n"),
			lambdaName: await route("from pkg import thing\nf = lambda thing: thing()\n"),
			comprehension: await route("import pkg\n\n\ndef run(y):\n    return [pkg.thing() for pkg in y]\n"),
			conditional: await route("if flag:\n    import pkg\npkg.thing()\n"),
		}).toEqual({
			lambdaReceiver: ["unbound Ambiguous via no origin"],
			lambdaName: ["unbound NotIndexed via no origin"],
			comprehension: ["unbound Ambiguous via no origin"],
			conditional: ["unbound Ambiguous via no origin"],
		});
	});

	it("keeps a conditional star import from binding what it would bring", async () => {
		const provider = workspace({ "pkg/__init__.py": "", "pkg/impl.py": IMPL });
		const facts = await parse(provider, "pkg/use.py", "if flag:\n    from .impl import *\nthing()\n");

		expect(uses(facts, "thing")).toEqual(["unbound Ambiguous via no origin"]);
	});
});

describe("Python kept renames", () => {
	const rename = (provider: PythonProvider, text: string, sites: Array<{ range: Range; keep?: true }>, from = "N") =>
		provider.renameEdits({ module: "pkg/use.py", text, oldName: from, newName: from === "N" ? "N2" : "N", sites });

	const applied = (text: string, response: Awaited<ReturnType<typeof rename>>) => {
		if (response.status !== "ready") return response;
		const result = applyEdits(text, response.edits);
		return "problem" in result ? result : { text: result.text, blocked: response.blocked };
	};

	it("writes a kept import as an alias of its old name, and collapses an alias renamed onto its local", async () => {
		const provider = workspace({});
		const plain = "from .m import N\nN2 = 1\n";
		const aliased = "from .m import N as M\n";
		const listed = '__all__ = ["N"]\nfrom .m import N\n';
		const collapse = "from .m import N2 as N\n";

		expect({
			plain: applied(plain, await rename(provider, plain, [{ range: spanOf(plain, "N"), keep: true }])),
			aliased: applied(aliased, await rename(provider, aliased, [{ range: spanOf(aliased, "N"), keep: true }])),
			listed: applied(listed, await rename(provider, listed, [{ range: spanOf(listed, '"N"'), keep: true }])),
			collapse: applied(collapse, await rename(provider, collapse, [{ range: spanOf(collapse, "N2") }], "N2")),
		}).toEqual({
			plain: { text: "from .m import N2 as N\nN2 = 1\n", blocked: [] },
			aliased: { text: "from .m import N2 as M\n", blocked: [] },
			listed: { text: listed, blocked: [] },
			collapse: { text: "from .m import N\n", blocked: [] },
		});
		expect(await rename(provider, plain, [{ range: spanOf(plain, "N") }])).toMatchObject({
			status: "refused",
			reason: "Collision",
		});
	});

	it("reads a same-named `as` as the written local binding, apart from the source name", async () => {
		const provider = workspace({});
		const text = "from .m import N as N\n";
		const source = spanOf(text, "N");
		const local = spanOf(text, "N", text.indexOf(" as "));
		const facts = await parse(provider, "pkg/__init__.py", text);

		expect(facts.imports[0]?.edges[0]).toMatchObject({ name: "N", range: source, local: "N", localRange: local });
		expect(facts.exports?.[0]).toMatchObject({ form: "forward", range: local, sourceRange: source });
		expect({
			source: applied(text, await rename(provider, text, [{ range: source }])),
			local: applied(text, await rename(provider, text, [{ range: local }])),
		}).toEqual({
			source: { text: "from .m import N2 as N\n", blocked: [] },
			local: { text: "from .m import N as N2\n", blocked: [] },
		});
	});

	it("blocks a kept site it cannot write as an alias", async () => {
		const provider = workspace({});
		const text = "def N():\n    pass\n";

		expect(await rename(provider, text, [{ range: spanOf(text, "N"), keep: true }])).toMatchObject({
			status: "ready",
			edits: [],
			blocked: [{ reason: "NotImplemented" }],
		});
	});
});

describe("Python import resolution", () => {
	it("lands on a package before a same-named module, and on nothing above the workspace root", async () => {
		const provider = workspace({
			"util.py": "",
			"pkg/__init__.py": "",
			"pkg/thing.py": "",
			"pkg/thing/__init__.py": "",
		});
		const resolve = (specifier: string) => provider.resolveImport({ fromModule: "pkg/a.py", specifier });

		expect({
			package: await resolve(".thing"),
			root: await resolve("..util"),
			above: (await resolve("...util")).status,
		}).toEqual({
			package: { status: "resolved", landing: { kind: "module", module: "pkg/thing/__init__.py" } },
			root: { status: "resolved", landing: { kind: "module", module: "util.py" } },
			above: "unresolved",
		});
	});

	it("leaves a relative import in a root module unresolved unless the root is a package", async () => {
		const main = "from .util import f\nf()\n";
		const loose = workspace({ "main.py": main, "util.py": IMPL });
		const packaged = workspace({ "__init__.py": "", "main.py": main, "util.py": IMPL });
		const resolve = (provider: PythonProvider, specifier = ".util") =>
			provider.resolveImport({ fromModule: "main.py", specifier });

		expect({
			loose: await resolve(loose),
			absolute: await resolve(loose, "util"),
			packaged: await resolve(packaged),
			shown: await loose.store.withText("__init__.py", "", () => resolve(loose)),
			use: uses(await parse(loose, "main.py", main), "f"),
		}).toMatchObject({
			loose: { status: "unresolved", reason: "BrokenImport" },
			absolute: { status: "resolved", landing: { kind: "module", module: "util.py" } },
			packaged: { status: "resolved", landing: { kind: "module", module: "util.py" } },
			shown: { status: "resolved", landing: { kind: "module", module: "util.py" } },
			use: ["unbound BrokenImport via no origin"],
		});
	});
});

describe("Python TYPE_CHECKING imports", () => {
	it("reads an `if TYPE_CHECKING:` body as run, so its imports are certain and bind annotations", async () => {
		const THING = "class Thing:\n    pass\n";
		const provider = workspace({ "d.py": THING });
		const thing = (await parse(provider, "d.py", THING)).declarations[0]?.symbolId;
		const guarded = (head: string, test: string, rest = "") =>
			`${head}if ${test}:\n    from d import Thing\n${rest}def f(x: Thing): ...\n`;
		const read = async (text: string) => {
			const facts = await parse(provider, "use.py", text);
			const edge = facts.imports.find((statement) => statement.specifier === "d")?.edges[0];
			return { certainty: edge?.certainty.status, uses: uses(facts, "Thing", "typeUse") };
		};
		const certain = { certainty: "known" as const, uses: [`${thing} via edge Thing`] };
		const unsure = { certainty: "unknown" as const, uses: ["unbound Ambiguous via no origin"] };
		const named = "from __future__ import annotations\nfrom typing import TYPE_CHECKING\n";

		expect({
			named: await read(guarded(named, "TYPE_CHECKING")),
			module: await read(guarded("import typing\n", "typing.TYPE_CHECKING")),
			aliased: await read(guarded("import typing_extensions as te\n", "te.TYPE_CHECKING")),
			shadowed: await read(guarded(`${named}TYPE_CHECKING = False\n`, "TYPE_CHECKING")),
			otherFlag: await read(guarded("", "DEBUG")),
			elseBinds: await read(guarded(named, "TYPE_CHECKING", "else:\n    Thing = object\n")),
		}).toEqual({
			named: certain,
			module: certain,
			aliased: certain,
			shadowed: unsure,
			otherFlag: unsure,
			elseBinds: unsure,
		});
		const declared = await parse(provider, "alias.py", `${named}if TYPE_CHECKING:\n    Alias = int\n`);
		expect(declared.exports?.find((edge) => edge.name === "Alias")?.certainty).toEqual({ status: "known" });
	});
});

describe("Python member renames", () => {
	it("renames a member token, which no name in the module captures, and blocks one kept or in a nested scope", async () => {
		const provider = workspace({});
		const text = [
			"import pkg.d as dd",
			"thing = 1",
			"other = 2",
			"dd.thing()",
			"y = None  # type: dd.thing",
			"f = lambda: dd.thing()",
			"",
		].join("\n");
		const member = (after: string) => spanOf(text, "thing", text.indexOf(after));
		const call = member("dd.thing()");
		const comment = member("# type");
		const nested = member("lambda");
		const rename = (sites: Array<{ range: Range; keep?: true }>) =>
			provider.renameEdits({ module: "use.py", text, oldName: "thing", newName: "other", sites });
		const renamed = await rename([{ range: call }, { range: comment }]);
		if (renamed.status !== "ready") throw new Error(`refused: ${renamed.detail}`);
		const result = applyEdits(text, renamed.edits);

		expect("problem" in result ? result : { text: result.text, blocked: renamed.blocked }).toEqual({
			text: [
				"import pkg.d as dd",
				"thing = 1",
				"other = 2",
				"dd.other()",
				"y = None  # type: dd.other",
				"f = lambda: dd.thing()",
				"",
			].join("\n"),
			blocked: [],
		});
		expect(await rename([{ range: call, keep: true }, { range: nested }])).toMatchObject({
			status: "ready",
			edits: [],
			blocked: [
				{ range: call, reason: "NotImplemented" },
				{ range: nested, reason: "NotImplemented" },
			],
		});
	});
});

describe("Python batch probe", () => {
	it("answers the store's view of a proposed text, with a landing per import", async () => {
		const provider = workspace({
			"pkg/__init__.py": "",
			"pkg/a.py": "def one():\n    pass\n",
			"pkg/b.py": "from .a import one\n\none()\n",
		});
		const proposed = "from .a import one\n\n\ndef seen():\n    pass\n\n\none()\n";
		const contentHash = hashContent(proposed);
		const one = (await parse(provider, "pkg/a.py", "def one():\n    pass\n")).declarations[0]?.symbolId;
		const answer = await provider.store.withText("pkg/b.py", proposed, () =>
			provider.probeBatch({ files: [{ module: "pkg/b.py", contentHash, text: proposed }], answer: ["pkg/b.py"] }),
		);
		if (answer.status !== "ready") throw new Error("the probe was not answered");
		const facts = answer.facts[0] as FileFacts;

		expect({
			hash: facts.contentHash,
			declared: facts.declarations.map((declaration) => declaration.name),
			bound: uses(facts, "one"),
			landings: answer.landings,
		}).toEqual({
			hash: contentHash,
			declared: ["seen"],
			bound: [`${one} via edge one`],
			landings: [
				{
					module: "pkg/b.py",
					specifier: ".a",
					resolution: { status: "resolved", landing: { kind: "module", module: "pkg/a.py" } },
				},
			],
		});
	});

	it("resolves an import to a module the store shows before it exists on disk", async () => {
		const provider = workspace({ "pkg/__init__.py": "" });
		const resolve = () => provider.resolveImport({ fromModule: "pkg/b.py", specifier: ".fresh" });

		expect({
			shown: await provider.store.withText("pkg/fresh.py", "x = 1\n", resolve),
			after: (await resolve()).status,
		}).toEqual({
			shown: { status: "resolved", landing: { kind: "module", module: "pkg/fresh.py" } },
			after: "unresolved",
		});
	});
});
