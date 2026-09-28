import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	composeSymbolId,
	coordinatesOf,
	FileFactsSchema,
	handlersFor,
	InitializeResponseSchema,
	PROTOCOL_VERSION,
	parseSymbolId,
	type Range,
} from "@nyaa-lexicon/protocol";
import { CppProvider, REFERENCE_ROLES, TIERS } from "../main.js";
import type { CppFacts, ImportFact } from "../model.js";
import { parseCppFile } from "../parser.js";
import { reachesOf } from "../reach.js";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-cpp-provider-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function wire(root = process.cwd()) {
	const handlers = handlersFor(new CppProvider());
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return handlers;
}

function span(text: string, value: string, from = 0): Range {
	const offset = text.indexOf(value, from);
	if (offset < 0) throw new Error(`missing test span: ${value}`);
	const range = coordinatesOf(text).rangeAt(offset, offset + value.length);
	if (range === undefined) throw new Error(`invalid test span: ${value}`);
	return range;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C++ provider contract", () => {
	test("qualifies out-of-line definitions and merges their prototypes", () => {
		const text = "namespace Physics { class World { public: void step(); }; }\nvoid Physics::World::step() {}\n";
		const facts = parseCppFile("qualified.cpp", text);
		const steps = facts.declarations.filter((declaration) => declaration.name === "step");

		expect(steps).toHaveLength(1);
		expect(steps[0]?.symbolId).toBe(
			composeSymbolId({
				language: "cpp",
				module: "qualified.cpp",
				descriptors: [
					{ kind: "namespace", name: "Physics" },
					{ kind: "type", name: "World" },
					{ kind: "method", name: "step" },
				],
			}),
		);
		expect(steps[0]?.range.start.line).toBe(1);
	});

	test("declares its supported extensions, roles, and tiers", () => {
		const handlers = handlersFor(new CppProvider());
		const info = handlers.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
		handlers.discoverProject({ workspaceRoot: process.cwd() });

		expect(InitializeResponseSchema.parse(info).language).toBe("cpp");
		expect(info.extensions).toEqual([".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]);
		expect(info.referenceRoles).toEqual([...REFERENCE_ROLES]);
		expect(info.tiers).toEqual(TIERS);
	});

	test("marks a global main definition as the file entry", () => {
		const module = "src/main.cpp";
		const text = "int main() { return 0; }\n";
		const facts = parseCppFile(module, text);
		const main = facts.declarations.find((declaration) => declaration.name === "main");

		if (main === undefined) throw new Error("no main declaration");
		expect(facts.role).toEqual({ kind: "entry", how: "main", symbolId: main.symbolId });

		const handlers = wire();
		const request = { module, contentHash: "main", text };
		expect(handlers.parseFile(request).role).toEqual(facts.role);
		expect(handlers.probeFile(request).role).toEqual(facts.role);
	});

	test("treats prototypes and scoped main functions as library files", () => {
		const facts = parseCppFile(
			"src/library.cpp",
			"int main();\nnamespace app { int main() { return 0; } }\nclass Program { int main() { return 0; } };\n",
		);

		expect(facts.role).toEqual({ kind: "library" });
	});

	test("extracts nested namespaces, templates, members, enums, aliases, and overloads", () => {
		const text = [
			"namespace outer {",
			"inline namespace v1 {",
			"template <typename T>",
			"struct Box {",
			"private:",
			"\tT hidden;",
			"public:",
			"\tBox();",
			"\t~Box();",
			"\tT value;",
			"\tvoid set(T value) { this->value = value; }",
			"};",
			"enum class State { Ready, Done = 2 };",
			"using Alias = Box<int>;",
			"}",
			"}",
			"int add(int value) { return value; }",
			"int add(double value) { return 1; }",
		].join("\n");
		const facts = parseCppFile("src/model.cpp", text);
		const byName = (name: string) => facts.declarations.filter((declaration) => declaration.name === name);

		expect(facts.diagnostics).toEqual([]);
		expect(byName("outer")[0]?.kind).toBe("namespace");
		expect(byName("v1")[0]?.languageKind).toBe("inline");
		expect(byName("Box").some((declaration) => declaration.kind === "struct")).toBe(true);
		expect(byName("set").some((declaration) => declaration.kind === "method")).toBe(true);
		expect(byName("~Box")[0]?.kind).toBe("constructor");
		expect(byName("hidden")[0]?.visibility).toBe("private");
		expect(byName("value")[0]?.visibility).toBe("public");
		expect(byName("State")[0]?.kind).toBe("enum");
		expect(byName("Ready")[0]?.containerId).toContain("State#");
		expect(byName("Alias")[0]?.languageKind).toBe("using alias");
		expect(byName("T")[0]?.kind).toBe("typeParameter");
		expect(byName("Box").find((declaration) => declaration.kind === "struct")?.signature).toContain("template");
		expect(byName("add").map((declaration) => declaration.symbolId)).toEqual([
			composeSymbolId({
				language: "cpp",
				module: "src/model.cpp",
				descriptors: [{ kind: "method", name: "add" }],
			}),
			composeSymbolId({
				language: "cpp",
				module: "src/model.cpp",
				descriptors: [{ kind: "method", name: "add", disambiguator: "1" }],
			}),
		]);
	});

	test("reports operator overloads with source ranges", () => {
		const text = [
			"/// Adds two values.",
			"struct Number {",
			"\tNumber operator+(const Number& other) const;",
			"};",
		].join("\n");
		const facts = parseCppFile("number.hpp", text);
		const operatorDeclaration = facts.declarations.find((declaration) => declaration.name === "operator+");

		expect(operatorDeclaration?.kind).toBe("operator");
		expect(operatorDeclaration?.languageKind).toBe("operator");
		expect(operatorDeclaration?.containerId).toContain("Number#");
		expect(operatorDeclaration?.selectionRange?.start.line).toBe(2);
	});

	test("counts astral characters as two UTF-16 code units", () => {
		const facts = parseCppFile("utf16.cpp", "/* 😀 */ class Cart {};\n");
		const declaration = facts.declarations.find((candidate) => candidate.name === "Cart");

		expect(declaration?.selectionRange?.start).toEqual({ line: 0, character: 15 });
		expect(declaration?.selectionRange?.end).toEqual({ line: 0, character: 19 });
	});

	test("extracts literals with the nearest declaration container", () => {
		const facts = parseCppFile(
			"literals.cpp",
			[
				"const int LIMIT = 3;",
				"bool enabled = true;",
				'const char* text = "hello";',
				"int run() { double value = 2.5; return enabled; }",
			].join("\n"),
		);
		const values = facts.literals.map((literal) => [literal.kind, literal.value]);

		expect(values).toEqual([
			["number", "3"],
			["boolean", "true"],
			["string", "hello"],
			["number", "2.5"],
		]);
		const value = facts.declarations.find((declaration) => declaration.name === "value");
		expect(facts.literals.find((literal) => literal.value === "2.5")?.containerId).toBe(value?.symbolId);
	});

	test("emits using references without turning them into imports", () => {
		const facts = parseCppFile("using.cpp", "using namespace std;\nusing std::vector;\nint size = 1;\n");

		expect(facts.imports).toEqual([]);
		expect(
			facts.references.filter((reference) => reference.role === "import").map((reference) => reference.name),
		).toEqual(["std", "std", "vector"]);
	});

	test("binds same-file names and reports overload ambiguity", () => {
		const provider = wire();
		const text = [
			"int add(int value) { return value; }",
			"int add(double value) { return 1; }",
			"int run() { int local = 1; return add(local); }",
		].join("\n");
		const facts = provider.parseFile({ module: "bind.cpp", contentHash: "bind", text });
		const call = facts.references.find((reference) => reference.name === "add");
		const local = facts.references.find((reference) => reference.name === "local");

		expect(call?.binding.status).toBe("ambiguous");
		expect(local?.binding).toMatchObject({ status: "bound" });
		expect(
			provider.bind({ module: "bind.cpp", name: "add", range: call?.range ?? span(text, "add(local)") }).status,
		).toBe("ambiguous");
	});

	test("resolves quoted includes in the workspace and marks angle includes external", () => {
		const root = workspace({
			"src/cart.cpp":
				'#include "item.hpp"\n#include <vector>\nusing api::Item;\nItem make() { return Item{}; }\n',
			"src/item.hpp": "namespace api { struct Item {}; }\n",
		});
		const provider = wire(root);
		provider.parseFile({
			module: "src/item.hpp",
			contentHash: "item",
			text: readFileSync(path.join(root, "src/item.hpp"), "utf8"),
		});
		const text = readFileSync(path.join(root, "src/cart.cpp"), "utf8");
		const facts = provider.parseFile({ module: "src/cart.cpp", contentHash: "cart", text });

		expect(provider.resolveImport({ fromModule: "src/cart.cpp", specifier: "item.hpp" })).toEqual({
			status: "resolved",
			module: "src/item.hpp",
		});
		expect(provider.resolveImport({ fromModule: "src/cart.cpp", specifier: "vector" })).toEqual({
			status: "external",
			packageName: "vector",
		});
		expect(facts.imports.map((item) => item.specifier)).toEqual(["item.hpp", "vector"]);
		expect(
			facts.references.find((reference) => reference.name === "Item" && reference.role === "import")?.binding
				.status,
		).toBe("bound");
	});

	test("searches the includer's directory, then include directories and the root, and binds what reached headers declare, nearest first", () => {
		const root = workspace({
			"include/lib/thing.hpp": '#include "detail.hpp"\nnamespace lib { struct Thing { int size; }; int twin; }\n',
			"include/lib/detail.hpp": '#include "thing.hpp"\nnamespace lib { int helper(); int twin; }\n',
			"include/config.hpp": "int shared_only;\n",
			"include/foo": "int foo_plain;\n",
			"src/config.hpp": "int local_only;\n",
			"src/foo.hpp": "int foo_hpp;\n",
			"hidden.hpp": "int hidden;\n",
			"src/main.cpp": [
				"#include <lib/thing.hpp>",
				'#include "config.hpp"',
				"#include <config.hpp>",
				'#include "foo"',
				"int run(lib::Thing* t) { return t->size + lib::helper() + lib::twin + local_only + shared_only + hidden; }",
				"int more() { return foo_plain + foo_hpp; }",
			].join("\n"),
		});
		const provider = wire(root);
		const facts = provider.parseFile({
			module: "src/main.cpp",
			contentHash: "main",
			text: readFileSync(path.join(root, "src/main.cpp"), "utf8"),
		});
		const home = (name: string) => {
			const binding = facts.references.find(
				(reference) => reference.name === name && reference.role !== "import",
			)?.binding;
			return binding?.status === "bound" ? parseSymbolId(binding.symbolId)?.module : binding?.status;
		};
		const resolve = (specifier: string) => provider.resolveImport({ fromModule: "src/main.cpp", specifier });

		// A name is looked up as written: `"foo"` never finds foo.hpp. A bare name takes the kind it is
		// written with, and written both ways to different files, none.
		expect(
			["<lib/thing.hpp>", '"config.hpp"', "<config.hpp>", '"foo"', "lib/thing.hpp", "config.hpp"].map(resolve),
		).toEqual([
			{ status: "resolved", module: "include/lib/thing.hpp" },
			{ status: "resolved", module: "src/config.hpp" },
			{ status: "resolved", module: "include/config.hpp" },
			{ status: "resolved", module: "include/foo" },
			{ status: "resolved", module: "include/lib/thing.hpp" },
			{ status: "unresolved", reason: "Ambiguous", detail: expect.any(String) },
		]);
		// Through thing.hpp to detail.hpp, whose include of thing.hpp again ends the walk; the nearer
		// `twin` wins, and hidden.hpp is never reached.
		expect(
			["Thing", "size", "helper", "twin", "local_only", "shared_only", "hidden", "foo_plain", "foo_hpp"].map(
				home,
			),
		).toEqual([
			"include/lib/thing.hpp",
			"include/lib/thing.hpp",
			"include/lib/detail.hpp",
			"include/lib/thing.hpp",
			"src/config.hpp",
			"include/config.hpp",
			"unbound",
			"include/foo",
			"unbound",
		]);
	});

	test("searches a compilation database's lists and forced includes for its units, and moves the fingerprint when they change", () => {
		const database = (mode: string, prelude: string) =>
			JSON.stringify([
				{
					directory: ".",
					file: "../src/app.cpp",
					arguments: [
						"c++",
						"-I../vendor/api",
						"-iquote",
						"../quoted",
						"-include",
						`../forced/${prelude}`,
						`-DMODE=${mode}`,
						"-c",
						"../src/app.cpp",
					],
				},
				{
					directory: ".",
					file: "../src/split.cpp",
					arguments: ["c++", "-I../early", "-I-", "-I../late", "-c", "../src/split.cpp"],
				},
			]);
		const root = workspace({
			"build/compile_commands.json": database("1", "prelude.hpp"),
			"forced/prelude.hpp": "int prelude_value;\n",
			"forced/other.hpp": "int other_value;\n",
			"vendor/api/api.hpp": "int api_value;\n",
			"vendor/api/bare.hpp": "int bare_value;\n",
			"include/api.hpp": "int api_value;\n",
			"quoted/q.hpp": "int q_value;\n",
			"early/cfg.hpp": "int early_cfg;\n",
			"late/cfg.hpp": "int late_cfg;\n",
			"src/cfg.hpp": "int sibling_cfg;\n",
			"src/app.cpp":
				'#include "api.hpp"\n#include "q.hpp"\n#include <q.hpp>\nint read() { return api_value + prelude_value; }\n',
			"src/split.cpp": '#include "cfg.hpp"\n#include <cfg.hpp>\n',
		});
		const provider = wire(root);
		const facts = provider.parseFile({
			module: "src/app.cpp",
			contentHash: "app",
			text: readFileSync(path.join(root, "src/app.cpp"), "utf8"),
		});
		const resolve = (specifier: string) => provider.resolveImport({ fromModule: "src/app.cpp", specifier });
		const home = (name: string) => {
			const binding = facts.references.find((reference) => reference.name === name)?.binding;
			return binding?.status === "bound" ? parseSymbolId(binding.symbolId)?.module : binding?.status;
		};
		const first = provider.discoverProject({ workspaceRoot: root });
		writeFileSync(path.join(root, "build/compile_commands.json"), database("1", "other.hpp"));
		const second = provider.discoverProject({ workspaceRoot: root });
		writeFileSync(path.join(root, "build/compile_commands.json"), database("2", "other.hpp"));
		const third = provider.discoverProject({ workspaceRoot: root });

		// The database's lists replace the conventional ones; an angle include skips `-iquote`, and a
		// name is looked up as written, never with an extension added.
		expect(["api.hpp", '"q.hpp"', "<q.hpp>", '"bare"'].map(resolve)).toEqual([
			{ status: "resolved", module: "vendor/api/api.hpp" },
			{ status: "resolved", module: "quoted/q.hpp" },
			{ status: "external", packageName: "q.hpp" },
			{ status: "unresolved", reason: "NotIndexed", detail: expect.any(String) },
		]);
		// After `-I-`, the `-I` before it serve quoted includes only, and the includer's own directory none.
		expect(
			['"cfg.hpp"', "<cfg.hpp>"].map((specifier) =>
				provider.resolveImport({ fromModule: "src/split.cpp", specifier }),
			),
		).toEqual([
			{ status: "resolved", module: "early/cfg.hpp" },
			{ status: "resolved", module: "late/cfg.hpp" },
		]);
		// A forced include is read before the unit's first line.
		expect(["api_value", "prelude_value"].map(home)).toEqual(["vendor/api/api.hpp", "forced/prelude.hpp"]);
		expect(first.configFiles).toContain("build/compile_commands.json");
		expect(second.fingerprint).not.toBe(first.fingerprint);
		expect(third.fingerprint).not.toBe(second.fingerprint);
	});

	test("resolves a file several entries build only where they agree, whatever their order, and roots its forced includes", () => {
		const entry = (config: string) => ({
			directory: ".",
			file: "../src/app.cpp",
			arguments: ["c++", `-I../${config}`, "-I../shared", "-include", "early.hpp", "-c", "../src/app.cpp"],
		});
		const root = workspace({
			"build/early.hpp": "int early_value;\n",
			"debug/cfg.hpp": "int debug_value;\n",
			"release/cfg.hpp": "int release_value;\n",
			"shared/common.hpp": "int common_value;\n",
			"src/app.cpp": "#include <cfg.hpp>\n#include <common.hpp>\n",
		});
		const provider = wire(root);
		const discover = (configs: string[]) => {
			writeFileSync(path.join(root, "build/compile_commands.json"), JSON.stringify(configs.map(entry)));
			const project = provider.discoverProject({ workspaceRoot: root });
			return {
				resolved: ["<cfg.hpp>", "<common.hpp>"].map((specifier) =>
					provider.resolveImport({ fromModule: "src/app.cpp", specifier }),
				),
				fingerprint: project.fingerprint,
				rooted: project.files.includes("build/early.hpp"),
			};
		};
		const forward = discover(["debug", "release"]);

		expect(forward.resolved).toEqual([
			{ status: "unresolved", reason: "Ambiguous", detail: expect.any(String) },
			{ status: "resolved", module: "shared/common.hpp" },
		]);
		expect(discover(["release", "debug"])).toEqual(forward);
		// A forced include in an excluded directory is still a file of the project.
		expect(forward.rooted).toBe(true);
	});

	test("reads a header it could not read again on the next request, and lists past a directory it cannot", () => {
		// Permissions do not stop an administrator, and mean something else on Windows.
		if (process.platform === "win32" || process.getuid?.() === 0) return;
		const text = '#include "locked.hpp"\n#include <api.hpp>\nint read() { return locked_value; }\n';
		const root = workspace({
			"include/api.hpp": "int api_value;\n",
			"closed/include/other.hpp": "int other_value;\n",
			"src/locked.hpp": "int locked_value;\n",
			"src/use.cpp": text,
		});
		const header = path.join(root, "src/locked.hpp");
		const closed = path.join(root, "closed");
		chmodSync(header, 0o000);
		chmodSync(closed, 0o000);
		try {
			const provider = wire(root);
			const project = provider.discoverProject({ workspaceRoot: root });
			const bound = () =>
				provider.bind({ module: "src/use.cpp", name: "locked_value", range: span(text, "locked_value") })
					.status;
			const before = bound();
			chmodSync(header, 0o644);

			expect({
				diagnostics: project.diagnostics,
				api: provider.resolveImport({ fromModule: "src/use.cpp", specifier: "<api.hpp>" }),
				bound: [before, bound()],
			}).toEqual({
				diagnostics: [],
				api: { status: "resolved", module: "include/api.hpp" },
				bound: ["unbound", "bound"],
			});
		} finally {
			chmodSync(header, 0o644);
			chmodSync(closed, 0o755);
		}
	});

	test("searches a shared header's includes under the lists of the unit that reaches it, or every unit's alone", () => {
		const entry = (unit: string, directory: string) => ({
			directory: ".",
			file: `../src/${unit}.cpp`,
			arguments: ["c++", `-I../${directory}`, "-c", `../src/${unit}.cpp`],
		});
		const root = workspace({
			"build/compile_commands.json": JSON.stringify([entry("a", "a_config"), entry("b", "b_config")]),
			"common/shared.hpp": "#include <config.hpp>\n",
			"a_config/config.hpp": "int from_a;\n",
			"b_config/config.hpp": "int from_b;\n",
			"src/a.cpp": '#include "../common/shared.hpp"\nint read() { return from_a + from_b; }\n',
			"src/b.cpp": '#include "../common/shared.hpp"\nint read() { return from_a + from_b; }\n',
		});
		const provider = wire(root);
		const bindings = (unit: string) =>
			provider
				.parseFile({
					module: `src/${unit}.cpp`,
					contentHash: unit,
					text: readFileSync(path.join(root, `src/${unit}.cpp`), "utf8"),
				})
				.references.filter((reference) => reference.name.startsWith("from_"))
				.map((reference) =>
					reference.binding.status === "bound"
						? parseSymbolId(reference.binding.symbolId)?.module
						: reference.binding.status,
				);

		expect(bindings("a")).toEqual(["a_config/config.hpp", "unbound"]);
		expect(bindings("b")).toEqual(["unbound", "b_config/config.hpp"]);
		// Read on its own, the header is every unit's, and they disagree.
		expect(provider.resolveImport({ fromModule: "common/shared.hpp", specifier: "<config.hpp>" })).toMatchObject({
			status: "unresolved",
			reason: "Ambiguous",
		});
	});

	test("never finds a header the read policy denies, as an include directory or a file", () => {
		const root = workspace({
			"secret/include/hidden.hpp": "int hidden_value;\n",
			"secret/api.hpp": "int secret_value;\n",
			"lib/include/open.hpp": "int open_value;\n",
			"src/main.cpp": '#include <hidden.hpp>\n#include "../secret/api.hpp"\n#include <open.hpp>\n',
		});
		const provider = handlersFor(new CppProvider());
		provider.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION, deny: ["secret/**"] });
		provider.discoverProject({ workspaceRoot: root });
		const resolve = (specifier: string) => provider.resolveImport({ fromModule: "src/main.cpp", specifier });

		expect(["<hidden.hpp>", '"../secret/api.hpp"', "<open.hpp>"].map(resolve)).toEqual([
			{ status: "external", packageName: "hidden.hpp" },
			{ status: "unresolved", reason: "NotIndexed", detail: expect.any(String) },
			{ status: "resolved", module: "lib/include/open.hpp" },
		]);
	});

	test("walks each reached header once and reads each scope from the headers declaring in it", () => {
		const count = 2_000;
		/** A header's facts as the walk reads them, counting each scope looked up in it. */
		let scopeReads = 0;
		const header = (index: number, chained: boolean): CppFacts => {
			const members = new Map([[`n${index}`, new Map([[`v${index}`, []]])]]);
			const counted = new Map(members);
			counted.get = (path: string) => {
				scopeReads++;
				return members.get(path);
			};
			const next = chained && index + 1 < count ? [includeOf(`h${index + 1}`, 0)] : [];
			return { importFacts: next, membersByPath: counted, references: [] } as unknown as CppFacts;
		};
		const includeOf = (name: string, at: number): ImportFact => ({
			imported: { specifier: name, imported: [], reExport: false },
			quoted: false,
			tokenStart: at,
			tokenEnd: at + 1,
		});
		const walk = (chained: boolean) => {
			const headers = new Map(Array.from({ length: count }, (_, index) => [`h${index}`, header(index, chained)]));
			let resolved = 0;
			const unit = {
				importFacts: Array.from({ length: count }, (_, index) => includeOf(`h${index}`, index)),
				references: [{ tokenIndex: count, macro: false }],
			} as unknown as CppFacts;
			const reaches = reachesOf("main.cpp", [], unit, {
				resolve: (_includer, include) => {
					resolved++;
					return { status: "resolved", module: include.imported.specifier };
				},
				load: (module) => headers.get(module),
			});
			scopeReads = 0;
			const reach = reaches.before(count);
			const found = Array.from({ length: count }, (_, index) => reach.declared(`n${index}`, `v${index}`).length);
			return { resolved, scopeReads, found: found.filter((groups) => groups === 1).length };
		};

		const chained = walk(true);
		const spread = walk(false);

		// Every header included, each also including the next: rewalking the chain from each later
		// include reads count squared.
		expect(chained.resolved).toBeLessThanOrEqual(4 * count);
		// Each scope in one header: scanning every header per scope reads count squared.
		expect(spread.found).toBe(count);
		expect(spread.scopeReads).toBeLessThanOrEqual(2 * count);
	});

	test("binds names reached through many headers in time near linear in their count", () => {
		const shapes: Record<string, (count: number) => string[]> = {
			interleaved: (count) =>
				Array.from({ length: count }, (_, index) => `#include <h${index}.hpp>\nint u${index} = v${index};`),
			chained: (count) => [
				"#include <h0.hpp>",
				...Array.from({ length: count }, (_, index) => `int u${index} = v${index};`),
			],
		};
		// Names no reference asks for, so a scan of every header per name costs more than a parse.
		const unused = (index: number) => Array.from({ length: 8 }, (_, slot) => `int w${index}_${slot};\n`).join("");
		const headers = (count: number, chained: boolean) =>
			Object.fromEntries(
				Array.from({ length: count }, (_, index) => [
					`include/h${index}.hpp`,
					`${chained && index + 1 < count ? `#include <h${index + 1}.hpp>\n` : ""}int v${index};\n${unused(index)}`,
				]),
			);
		const timed = (shape: string, count: number) => {
			const root = workspace(headers(count, shape === "chained"));
			const text = (shapes[shape] as (count: number) => string[])(count).join("\n");
			let best = Number.POSITIVE_INFINITY;
			let bound = 0;
			for (let round = 0; round < 3; round++) {
				const provider = wire(root);
				const started = performance.now();
				const facts = provider.parseFile({ module: "src/main.cpp", contentHash: "main", text });
				best = Math.min(best, performance.now() - started);
				bound = facts.references.filter((reference) => reference.binding.status === "bound").length;
			}
			return { best, bound };
		};
		// Linear reads 8x; a walk or a scan of every header per include or per name reads 64x.
		for (const shape of Object.keys(shapes)) {
			const small = timed(shape, 100);
			const large = timed(shape, 800);
			expect([small.bound, large.bound]).toEqual([100, 800]);
			expect(large.best / small.best).toBeLessThan(24);
		}
	});

	test("answers a probe from the candidate, then binds includes into what the index holds", () => {
		const use = '#include "cart.hpp"\nint run() { return total() + discount(); }\n';
		const root = workspace({ "src/cart.hpp": "int total();\n", "src/use.cpp": use });
		const handlers = wire(root);
		const included = () =>
			["total", "discount"].map(
				(name) => handlers.bind({ module: "src/use.cpp", name, range: span(use, name) }).status,
			);
		handlers.parseFile({ module: "src/cart.hpp", contentHash: "old", text: "int total();\n" });
		handlers.moduleAdmission?.({ module: "src/cart.hpp", contentHash: "old", outcome: { status: "admitted" } });
		// The file changed on disk and its parse is outstanding across the probe.
		writeFileSync(path.join(root, "src/cart.hpp"), "int renamed();\n");
		handlers.parseFile({ module: "src/cart.hpp", contentHash: "disk", text: "int renamed();\n" });
		const probed = handlers.probeFile({
			module: "src/cart.hpp",
			contentHash: "candidate",
			text: "int total();\nint discount();\n",
		});
		const pending = included();
		handlers.moduleAdmission?.({
			module: "src/cart.hpp",
			contentHash: "disk",
			outcome: { status: "refused", reason: "refused" },
		});

		expect({
			candidate: probed.declarations.map((declaration) => declaration.name),
			pending,
			settled: included(),
		}).toEqual({
			candidate: ["total", "discount"],
			pending: ["unbound", "unbound"],
			settled: ["bound", "unbound"],
		});
	});

	test("returns declared and inferred types and reports syntax errors", () => {
		const provider = wire();
		const text = "const int LIMIT = 1;\nauto enabled = true;\n";
		const facts = provider.parseFile({ module: "types.cpp", contentHash: "types", text });
		const limit = facts.declarations.find((declaration) => declaration.name === "LIMIT");
		const enabled = facts.declarations.find((declaration) => declaration.name === "enabled");

		if (limit === undefined || enabled === undefined) throw new Error("type declarations missing");
		expect(provider.typeOf({ symbolId: limit.symbolId })).toMatchObject({
			status: "known",
			display: "int",
			provenance: "declared",
		});
		expect(provider.typeOf({ symbolId: enabled.symbolId })).toMatchObject({ status: "inferred", display: "bool" });
		expect(
			provider
				.parseFile({ module: "broken.cpp", contentHash: "broken", text: "int add( {\n" })
				.diagnostics.some((item) => item.severity === "error"),
		).toBe(true);
	});

	test("returns reasoned refusals for edit methods", () => {
		const provider = wire();
		const rename = provider.renameEdits({
			module: "a.cpp",
			text: "int value;",
			oldName: "value",
			newName: "next",
			sites: [],
		});
		const move = provider.moveEdits({
			module: "a.cpp",
			text: "int value;",
			exists: true,
			symbolId: composeSymbolId({
				language: "cpp",
				module: "a.cpp",
				descriptors: [{ kind: "term", name: "value" }],
			}),
			name: "value",
			fromModule: "a.cpp",
			toModule: "b.cpp",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(rename).toMatchObject({ status: "refused", reason: "NotImplemented" });
		expect(move).toMatchObject({ status: "refused", reason: "NotImplemented" });
	});

	test("validates complete file facts against the protocol schema", () => {
		const provider = wire();
		const facts = provider.parseFile({ module: "schema.cpp", contentHash: "schema", text: "int value = 1;\n" });

		expect(FileFactsSchema.safeParse(facts).success).toBe(true);
	});

	test("writes the tables that find a draft again only where drafts are added", () => {
		const sources = path.join(import.meta.dirname, "..");
		// Kept in step with `drafts` by `addDraft`; the layers above only read them.
		const uses = readdirSync(sources)
			.filter((file) => file.endsWith(".ts") && file !== "drafts.ts")
			.flatMap((file) =>
				[
					...readFileSync(path.join(sources, file), "utf8").matchAll(
						/this\.(declaredIn|typeNames)\s*\.(\w+)/g,
					),
				].map((found) => `${file}: ${found[1]}.${found[2]}`),
			);

		expect(uses.length).toBeGreaterThan(0);
		expect(uses.filter((use) => !use.endsWith(".get") && !use.endsWith(".has"))).toEqual([]);
	});
});

const corpusRoot = path.join(process.cwd(), "temp", "json");
const corpusPresent = existsSync(corpusRoot) && statSync(corpusRoot).isDirectory();
const corpusExtensions = new Set([".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]);

function corpusSourceFiles(root: string): string[] {
	const files: string[] = [];
	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(absolute);
				continue;
			}
			if (entry.isFile() && corpusExtensions.has(path.extname(entry.name))) {
				files.push(path.relative(root, absolute).replace(/\\/g, "/"));
			}
		}
	}
	visit(root);
	return files.sort();
}

// A missing corpus is a local mistake and a CI fact, `temp/` being ignored and never cloned there.
// Skipping in CI keeps the throw below meaningful where the corpus is supposed to exist.
const corpusTest = corpusPresent || !Reflect.get(process.env, "CI") ? test : test.skip;

corpusTest(
	"parses every owned nlohmann/json corpus file",
	async () => {
		if (!corpusPresent) throw new Error("C++ corpus is absent; run bun run corpora");
		const started = performance.now();
		const provider = wire(corpusRoot);
		const files = corpusSourceFiles(corpusRoot);
		const errorFiles: string[] = [];
		const sharedIds: string[] = [];
		// A span whose range does not cut its own text back out attaches to the wrong symbol,
		// and only real source has the string forms that break that.
		const strayed: string[] = [];
		let spans = 0;
		for (const module of files) {
			// Yields, so the timeout can fire.
			await new Promise((resolve) => setImmediate(resolve));
			const text = readFileSync(path.join(corpusRoot, module), "utf8");
			const facts = provider.parseFile({ module, contentHash: `corpus:${module}`, text });
			if (facts.diagnostics.some((diagnostic) => diagnostic.severity === "error")) errorFiles.push(module);
			const ids = facts.declarations.map((declaration) => declaration.symbolId);
			if (new Set(ids).size !== ids.length) sharedIds.push(module);

			const coordinates = coordinatesOf(text);
			for (const comment of facts.comments ?? []) {
				spans++;
				if (coordinates.sliceRange(comment.range) !== comment.text) {
					strayed.push(`${module}: ${JSON.stringify(comment.text)}`);
				}
			}
		}
		const wallMs = Math.round(performance.now() - started);
		console.log(
			`[cpp corpus] files=${files.length} comments=${spans} errorFiles=${errorFiles.length} wallMs=${wallMs}`,
		);
		expect(files.length).toBeGreaterThan(0);
		expect(errorFiles).toEqual([]);
		expect(sharedIds).toEqual([]);
		expect(strayed).toEqual([]);
		expect(spans).toBeGreaterThan(0);
	},
	120_000,
);
