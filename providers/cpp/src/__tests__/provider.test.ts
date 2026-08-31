import { afterEach, describe, expect, test } from "bun:test";
import {
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
	InitializeResponseSchema,
	type Range,
} from "@nyaa-lexicon/protocol";
import { CppProvider, REFERENCE_ROLES, TIERS } from "../main.js";
import { parseCppFile } from "../parser.js";

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
		const provider = new CppProvider();
		const info = provider.initialize(process.cwd());

		expect(InitializeResponseSchema.parse(info).language).toBe("cpp");
		expect(info.extensions).toEqual([".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]);
		expect(info.referenceRoles).toEqual([...REFERENCE_ROLES]);
		expect(info.tiers).toEqual(TIERS);
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
		const provider = new CppProvider();
		provider.initialize(process.cwd());
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
		const provider = new CppProvider();
		provider.initialize(root);
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

	test("returns declared and inferred types and reports syntax errors", () => {
		const provider = new CppProvider();
		provider.initialize(process.cwd());
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
		const provider = new CppProvider();
		provider.initialize(process.cwd());
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
		const provider = new CppProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({ module: "schema.cpp", contentHash: "schema", text: "int value = 1;\n" });

		expect(FileFactsSchema.safeParse(facts).success).toBe(true);
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

test("parses every owned nlohmann/json corpus file when available", () => {
	if (!corpusPresent) throw new Error("C++ corpus is absent");
	const started = performance.now();
	const provider = new CppProvider();
	provider.initialize(corpusRoot);
	const files = corpusSourceFiles(corpusRoot);
	const errorFiles: string[] = [];
	// A span whose range does not cut its own text back out attaches to the wrong symbol,
	// and only real source has the string forms that break that.
	const strayed: string[] = [];
	let spans = 0;
	for (const module of files) {
		const text = readFileSync(path.join(corpusRoot, module), "utf8");
		const facts = provider.parseFile({ module, contentHash: `corpus:${module}`, text });
		if (facts.diagnostics.some((diagnostic) => diagnostic.severity === "error")) errorFiles.push(module);

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
	expect(strayed).toEqual([]);
	expect(spans).toBeGreaterThan(0);
}, 120_000);
