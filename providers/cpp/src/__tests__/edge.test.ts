import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	composeSymbolId,
	coordinatesOf,
	FileFactsSchema,
	handlersFor,
	InitializeResponseSchema,
	METHOD_SCHEMAS,
	MoveEditsResponseSchema,
	PROTOCOL_VERSION,
	ProjectModelSchema,
	RenameEditsResponseSchema,
	TypeInfoSchema,
} from "@nyaa-lexicon/protocol";
import { CppProvider } from "../main.js";
import { parseCppFile } from "../parser.js";
import { tokenize } from "../tokens.js";

const roots: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-cpp-edge-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function declarationNames(text: string, module = "edge.cpp") {
	return parseCppFile(module, text).declarations;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C++ parser edges", () => {
	test("consumes compound punctuation as single tokens", () => {
		const tokens = tokenize("api::Thing == other && value->member", "tokens.cpp").tokens.filter(
			(token) => token.kind !== "newline",
		);

		expect(tokens.map((token) => token.text)).toEqual([
			"api",
			"::",
			"Thing",
			"==",
			"other",
			"&&",
			"value",
			"->",
			"member",
		]);
	});

	test("keeps UTF-16 positions through comments and identifiers", () => {
		const facts = parseCppFile("positions.cpp", "// 😀\nnamespace api { struct Thing {}; }\n");
		const thing = facts.declarations.find((declaration) => declaration.name === "Thing");

		expect(thing?.selectionRange?.start).toEqual({ line: 1, character: 23 });
		expect(thing?.selectionRange?.end).toEqual({ line: 1, character: 28 });
	});

	test("decodes escaped and raw strings without losing literal ranges", () => {
		const facts = parseCppFile(
			"strings.cpp",
			'const char* escaped = "line\\nvalue";\nconst char* raw = R"tag(raw::value)tag";\n',
		);
		const strings = facts.literals.filter((literal) => literal.kind === "string");

		expect(strings.map((literal) => literal.value)).toEqual(["line\nvalue", "raw::value"]);
		expect(strings.every((literal) => literal.range.start.line === 0 || literal.range.start.line === 1)).toBe(true);
	});

	test("extracts nested and inline namespace containers", () => {
		const facts = parseCppFile(
			"namespaces.cpp",
			["namespace outer {", "inline namespace version {", "struct Item { int value; };", "}", "}"].join("\n"),
		);
		const item = facts.declarations.find((declaration) => declaration.name === "Item");
		const value = facts.declarations.find((declaration) => declaration.name === "value");

		expect(facts.declarations.filter((declaration) => declaration.kind === "namespace").map((d) => d.name)).toEqual(
			["outer", "version"],
		);
		expect(item?.containerId).toContain("outer/version/");
		expect(value?.containerId).toBe(item?.symbolId);
	});

	test("reports anonymous namespaces with a stable nonempty descriptor", () => {
		const facts = parseCppFile("anonymous.cpp", "namespace { int hidden = 1; }\n");
		const namespaceDeclaration = facts.declarations.find((declaration) => declaration.kind === "namespace");
		const hidden = facts.declarations.find((declaration) => declaration.name === "hidden");

		expect(namespaceDeclaration?.name).toBe("(anonymous)");
		expect(namespaceDeclaration?.symbolId).toContain("(anonymous)");
		expect(hidden?.containerId).toBe(namespaceDeclaration?.symbolId);
	});

	test("distinguishes scoped and unscoped enum members", () => {
		const facts = parseCppFile("enums.cpp", "enum Color { Red, Green = 2 };\nenum class State { Ready, Done };\n");
		const colors = facts.declarations.filter((declaration) => declaration.containerId?.includes("Color"));
		const states = facts.declarations.filter((declaration) => declaration.containerId?.includes("State"));

		expect(facts.declarations.find((declaration) => declaration.name === "Color")?.languageKind).toBe("enum");
		expect(facts.declarations.find((declaration) => declaration.name === "State")?.languageKind).toBe(
			"scoped enum",
		);
		expect(colors.map((declaration) => declaration.name)).toEqual(["Red", "Green"]);
		expect(states.map((declaration) => declaration.name)).toEqual(["Ready", "Done"]);
		expect(colors.every((declaration) => declaration.kind === "constant")).toBe(true);
	});

	test("maps class, struct, and union default visibility", () => {
		const facts = parseCppFile(
			"visibility.cpp",
			[
				"class PrivateType { int field; public: int exposed; };",
				"struct PublicType { int field; private: int hidden; };",
				"union UnionType { int number; double decimal; };",
			].join("\n"),
		);
		const visibility = (name: string) =>
			facts.declarations.find((declaration) => declaration.name === name)?.visibility;

		expect(visibility("field")).toBe("private");
		expect(visibility("exposed")).toBe("public");
		expect(visibility("hidden")).toBe("private");
		expect(visibility("number")).toBe("public");
		expect(visibility("decimal")).toBe("public");
	});

	test("records aliases with their source spelling and declared type", () => {
		const facts = parseCppFile(
			"aliases.cpp",
			"using Count = unsigned long;\ntypedef int Index;\nusing Callback = void(*)(int);\n",
		);
		const count = facts.declarations.find((declaration) => declaration.name === "Count");
		const index = facts.declarations.find((declaration) => declaration.name === "Index");
		const callback = facts.declarations.find((declaration) => declaration.name === "Callback");

		expect(count?.languageKind).toBe("using alias");
		expect(index?.languageKind).toBe("typedef");
		expect(callback?.languageKind).toBe("using alias");
		expect(
			count && parseCppFile("aliases.cpp", "using Count = unsigned long;\n").typeAnswers.get(count.symbolId),
		).toMatchObject({
			status: "known",
			display: "unsigned long",
		});
	});

	test("names conversion and comparison operators from their declarations", () => {
		const facts = parseCppFile(
			"operators.cpp",
			[
				"struct Value {",
				"Value operator()(int index) const;",
				"Value operator<=>(const Value& other) const;",
				"operator bool() const;",
				"};",
			].join("\n"),
		);
		const operators = facts.declarations.filter((declaration) => declaration.kind === "operator");

		expect(operators.map((declaration) => declaration.name)).toEqual([
			"operator()",
			"operator<=>",
			"operator bool",
		]);
		expect(operators.every((declaration) => declaration.languageKind === "operator")).toBe(true);
	});

	test("includes template parameters in signatures and scopes them as type parameters", () => {
		const facts = parseCppFile(
			"templates.cpp",
			[
				"template <typename T, std::size_t N>",
				"class Array { public: T at(std::size_t index); };",
				"template <class T>",
				"T identity(T value) { return value; }",
			].join("\n"),
		);
		const array = facts.declarations.find((declaration) => declaration.name === "Array");
		const identity = facts.declarations.find((declaration) => declaration.name === "identity");

		expect(array?.signature).toContain("template <typename T, std::size_t N>");
		expect(identity?.signature).toContain("template <class T>");
		expect(
			facts.declarations.filter((declaration) => declaration.kind === "typeParameter").map((d) => d.name),
		).toEqual(["T", "N", "T"]);
	});

	test("accepts empty specializations and parameter-list-free instantiations", () => {
		const facts = parseCppFile(
			"template-forms.cpp",
			[
				"template <typename T> struct Box {};",
				"template<> struct Box<int> {};",
				"template<> void run<int>() {}",
				"template class nlohmann::basic_json<>;",
				"template struct nlohmann::basic_json<int>;",
			].join("\n"),
		);
		const boxes = facts.declarations.filter((declaration) => declaration.name === "Box");
		const run = facts.declarations.find((declaration) => declaration.name === "run");

		expect(facts.diagnostics).toEqual([]);
		expect(boxes).toHaveLength(2);
		expect(new Set(boxes.map((declaration) => declaration.symbolId)).size).toBe(2);
		expect(run?.kind).toBe("function");
		if (run === undefined) throw new Error("specialized function missing");
		expect(facts.typeAnswers.get(run.symbolId)).toMatchObject({ status: "known", display: "void" });
		expect(facts.declarations.some((declaration) => declaration.name === "nlohmann")).toBe(false);
		expect(
			facts.references.filter((reference) => reference.role === "instantiate").map((reference) => reference.name),
		).toEqual(["nlohmann", "basic_json", "nlohmann", "basic_json"]);
	});

	test("measures parameters and retains local and field declarations", () => {
		const facts = parseCppFile(
			"members.cpp",
			"struct Box { int field; int read(int first, double second) { int local = first; return local; } };\n",
		);
		const read = facts.declarations.find((declaration) => declaration.name === "read");
		const parameters = facts.declarations.filter((declaration) => declaration.languageKind === "parameter");
		const local = facts.declarations.find((declaration) => declaration.name === "local");

		expect(read?.metrics).toMatchObject({ parameters: 2, branches: 1 });
		expect(parameters.map((declaration) => declaration.name)).toEqual(["first", "second"]);
		expect(local?.visibility).toBe("local");
		expect(local?.containerId).toBe(read?.symbolId);
	});

	test("starts declaration ranges after a leading doc comment", () => {
		const text = ["/** Adds a value. */", "int add(int value) {", "\treturn value + 1;", "}"].join("\n");
		const declaration = declarationNames(text).find((candidate) => candidate.name === "add");

		expect(declaration?.range.start).toEqual({ line: 1, character: 0 });
		expect(declaration?.range.end).toEqual({ line: 3, character: 1 });
		expect(declaration?.selectionRange).toEqual({
			start: { line: 1, character: 4 },
			end: { line: 1, character: 7 },
		});
	});

	test("classifies reads, writes, calls, type uses, and construction", () => {
		const text = [
			"struct Item {};",
			"int make(Item item) {",
			"\tItem* created = new Item();",
			"\tcreated->value = item.value;",
			"\treturn make(item);",
			"}",
		].join("\n");
		const references = parseCppFile("roles.cpp", text).references;
		const roles = (name: string) =>
			new Set(references.filter((reference) => reference.name === name).map((r) => r.role));

		expect(roles("Item")).toContain("typeUse");
		expect(roles("Item")).toContain("instantiate");
		expect(roles("make")).toContain("call");
		expect(roles("created")).toContain("read");
		expect(roles("value")).toContain("write");
		expect(roles("item")).toContain("read");
	});

	test("binds qualified names in the same file and keeps overloads ambiguous", () => {
		const provider = new CppProvider();
		provider.initialize(process.cwd());
		const text = [
			"namespace api { struct Item {}; }",
			"int use() { api::Item item; return item.value; }",
			"int overload(int value) { return value; }",
			"double overload(double value) { return value; }",
			"int call() { return overload(1); }",
		].join("\n");
		const facts = provider.parseFile({ module: "qualified-bind.cpp", contentHash: "qualified", text });
		const item = facts.references.find((reference) => reference.name === "Item");
		const call = facts.references.find((reference) => reference.name === "overload" && reference.role === "call");

		expect(item?.binding.status).toBe("bound");
		expect(call?.binding.status).toBe("ambiguous");
	});

	test("reports honest binding reasons for external and missing includes", () => {
		const root = makeWorkspace({
			"src/use.cpp": '#include <lib/vector.hpp>\n#include "missing.hpp"\nstd::vector<int> values;\n',
		});
		const provider = new CppProvider();
		provider.initialize(root);
		const external = provider.resolveImport({ fromModule: "src/use.cpp", specifier: "lib/vector.hpp" });
		const facts = provider.parseFile({
			module: "src/use.cpp",
			contentHash: "use",
			text: readFileSync(path.join(root, "src/use.cpp"), "utf8"),
		});
		const vector = facts.references.find((reference) => reference.name === "vector");

		expect(vector?.binding).toMatchObject({ status: "unbound", reason: "ExternalDependency" });
		expect(provider.resolveImport({ fromModule: "src/use.cpp", specifier: "missing.hpp" })).toMatchObject({
			status: "unresolved",
			reason: "NotIndexed",
		});
		expect(external).toMatchObject({
			status: "external",
		});
	});

	test("resolves nested workspace headers and refuses path traversal", () => {
		const root = makeWorkspace({
			"src/use.cpp": '#include "detail/item.hpp"\n',
			"src/detail/item.hpp": "struct Item {};\n",
			"outside.hpp": "struct Outside {};\n",
		});
		const provider = new CppProvider();
		provider.initialize(root);

		expect(provider.resolveImport({ fromModule: "src/use.cpp", specifier: "detail/item.hpp" })).toEqual({
			status: "resolved",
			module: "src/detail/item.hpp",
		});
		expect(provider.resolveImport({ fromModule: "src/use.cpp", specifier: "../../outside.hpp" })).toMatchObject({
			status: "unresolved",
			reason: "NotIndexed",
		});
	});

	test("infers simple initializers and auto returns while refusing unknown expressions", () => {
		const provider = new CppProvider();
		provider.initialize(process.cwd());
		const text = [
			"auto count = 1;",
			'auto label = "ok";',
			"auto missing = make_value();",
			"auto answer() { return 1; }",
		].join("\n");
		const facts = provider.parseFile({ module: "inference.cpp", contentHash: "inference", text });
		const answer = (name: string) => {
			const declaration = facts.declarations.find((candidate) => candidate.name === name);
			if (declaration === undefined) throw new Error(`${name} missing`);
			return provider.typeOf({ symbolId: declaration.symbolId });
		};

		expect(answer("count")).toMatchObject({ status: "inferred", display: "int" });
		expect(answer("label")).toMatchObject({ status: "inferred", display: "const char*" });
		expect(answer("missing")).toMatchObject({ status: "unknown", reason: "NotImplemented" });
		expect(answer("answer")).toMatchObject({ status: "inferred", display: "int" });
	});

	test("returns type answers for annotations and ranges", () => {
		const provider = new CppProvider();
		provider.initialize(process.cwd());
		const text = "const unsigned int limit = 3;\n";
		const facts = provider.parseFile({ module: "annotation.cpp", contentHash: "annotation", text });
		const declaration = facts.declarations.find((candidate) => candidate.name === "limit");
		if (declaration === undefined) throw new Error("limit missing");

		expect(provider.typeOf({ symbolId: declaration.symbolId })).toMatchObject({
			status: "known",
			display: "unsigned int",
		});
		expect(
			provider.typeOf({
				module: "annotation.cpp",
				range: declaration.selectionRange as NonNullable<typeof declaration.selectionRange>,
			}),
		).toMatchObject({
			status: "known",
		});
	});

	test("keeps template-dependent declarations and references unresolved", () => {
		const provider = new CppProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({
			module: "dependent.cpp",
			contentHash: "dependent",
			text: "template <typename T> T call(T value) { return value; }\n",
		});
		const value = facts.references.find((reference) => reference.name === "value");
		const call = facts.declarations.find((declaration) => declaration.name === "call");
		if (call === undefined) throw new Error("call missing");

		expect(value?.binding).toMatchObject({ status: "unbound", reason: "NotImplemented" });
		expect(provider.typeOf({ symbolId: call.symbolId })).toMatchObject({
			status: "unknown",
			reason: "NotImplemented",
		});
	});

	test("reports malformed strings, includes, and delimiters as errors", () => {
		const facts = parseCppFile(
			"errors.cpp",
			'#include <vector\nconst char* text = "unterminated;\nint value = (1;\n',
		);
		const messages = facts.diagnostics.map((diagnostic) => diagnostic.message);

		expect(messages.some((message) => message.includes("header is not closed"))).toBe(true);
		expect(messages.some((message) => message.includes("string literal"))).toBe(true);
		expect(messages.some((message) => message.includes("not closed"))).toBe(true);
		expect(facts.diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
	});

	test("does not diagnose balanced comments, strings, or delimiters", () => {
		const facts = parseCppFile("valid.cpp", '/* comment */\nconst char* text = "ok";\nint value = (1 + 2);\n');

		expect(facts.diagnostics).toEqual([]);
	});

	test("walks only the claimed C++ extensions", () => {
		const root = makeWorkspace({
			"main.cpp": "int main() {}\n",
			"header.hpp": "struct Header {};\n",
			"header.hh": "struct Hh {};\n",
			"header.hxx": "struct Hxx {};\n",
			"owned.h": "struct CHeader {};\n",
			"notes.txt": "not source\n",
			"build/generated.cpp": "int generated;\n",
		});
		const provider = new CppProvider();
		provider.initialize(root);

		expect(provider.discoverProject(root).files).toEqual(["header.hh", "header.hpp", "header.hxx", "main.cpp"]);
	});

	test("returns a schema-valid response for every provider handler", () => {
		const root = makeWorkspace({ "source.cpp": "int value = 1;\n" });
		const handlers = handlersFor(new CppProvider());
		const initialize = handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
		const info = InitializeResponseSchema.parse(initialize);
		const project = handlers.discoverProject({ workspaceRoot: root });
		const parsedProject = ProjectModelSchema.parse(project);
		const facts = handlers.parseFile({ module: "source.cpp", contentHash: "source", text: "int value = 1;\n" });
		const parsedFacts = FileFactsSchema.parse(facts);
		const declaration = parsedFacts.declarations.find((candidate) => candidate.name === "value");
		if (declaration === undefined) throw new Error("handler declaration missing");
		const binding = handlers.bind({
			module: "source.cpp",
			name: "value",
			range: declaration.selectionRange as NonNullable<typeof declaration.selectionRange>,
		});
		const type = handlers.typeOf({ symbolId: declaration.symbolId });
		const importResolution = handlers.resolveImport({ fromModule: "source.cpp", specifier: "vector" });
		const rename = handlers.renameEdits({
			module: "source.cpp",
			text: "int value;",
			oldName: "value",
			newName: "next",
			sites: [],
		});
		const move = handlers.moveEdits({
			module: "source.cpp",
			text: "int value;",
			exists: true,
			symbolId: composeSymbolId({
				language: "cpp",
				module: "source.cpp",
				descriptors: [{ kind: "term", name: "value" }],
			}),
			name: "value",
			fromModule: "source.cpp",
			toModule: "target.cpp",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		});
		const shutdown = handlers.shutdown({});

		expect(info.language).toBe("cpp");
		expect(parsedProject.files).toContain("source.cpp");
		expect(parsedFacts.module).toBe("source.cpp");
		expect(METHOD_SCHEMAS.bind.response.parse(binding).status).toBe("bound");
		expect(TypeInfoSchema.parse(type).status).toBe("known");
		expect(METHOD_SCHEMAS.resolveImport.response.parse(importResolution).status).toBe("external");
		expect(RenameEditsResponseSchema.parse(rename).status).toBe("refused");
		expect(MoveEditsResponseSchema.parse(move).status).toBe("refused");
		expect(METHOD_SCHEMAS.shutdown.response.parse(shutdown)).toEqual({});
		expect(coordinatesOf("value").rangeAt(0, 5)).toEqual({
			start: { line: 0, character: 0 },
			end: { line: 0, character: 5 },
		});
	});
});
