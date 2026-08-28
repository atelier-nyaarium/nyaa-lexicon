import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, handlersFor } from "@nyaa-lexicon/protocol";
import { CppProvider } from "../main.js";
import { parseCppFile } from "../parser.js";

const roots: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-cpp-coverage-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const absolute = path.join(root, module);
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, text);
	}
	return root;
}

function declarationId(module: string, kind: "method" | "term" | "type", name: string): string {
	return composeSymbolId({ language: "cpp", module, descriptors: [{ kind, name }] });
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C++ structural coverage", () => {
	test("walks claimed files and excludes generated or C-owned directories", () => {
		const root = makeWorkspace({
			"src/main.cpp": "int main() {}\n",
			"src/math.cc": "int add();\n",
			"src/math.cxx": "int sub();\n",
			"include/api.hpp": "struct Api {};\n",
			"include/api.hh": "struct Hh {};\n",
			"include/api.hxx": "struct Hxx {};\n",
			"include/legacy.h": "struct Legacy {};\n",
			"build/generated.cpp": "int generated;\n",
			"node_modules/package/index.cpp": "int packageValue;\n",
			".git/hidden.cpp": "int hidden;\n",
		});
		const provider = new CppProvider();
		provider.initialize(root);

		expect(provider.discoverProject(root)).toMatchObject({
			files: [
				"include/api.hh",
				"include/api.hpp",
				"include/api.hxx",
				"src/main.cpp",
				"src/math.cc",
				"src/math.cxx",
			],
			externalRoots: [],
			configFiles: [],
			diagnostics: [],
		});
	});

	test("reports invalid workspace roots as project diagnostics", () => {
		const provider = new CppProvider();
		provider.initialize(process.cwd());

		expect(provider.discoverProject("/tmp/cpp-provider-path-that-is-not-present")).toMatchObject({
			files: [],
			diagnostics: [{ severity: "error" }],
		});
	});

	test("maps class defaults and access labels to visibility", () => {
		const facts = parseCppFile(
			"access.hpp",
			[
				"class Hidden {",
				"\tint privateField;",
				"protected:",
				"\tint protectedField;",
				"public:",
				"\tint publicField;",
				"};",
				"struct Visible {",
				"\tint publicField;",
				"private:",
				"\tint privateField;",
				"};",
			].join("\n"),
		);
		const visibilityOf = (name: string, container: string) =>
			facts.declarations.find(
				(declaration) => declaration.name === name && declaration.containerId?.includes(container),
			)?.visibility;

		expect(visibilityOf("privateField", "Hidden#")).toBe("private");
		expect(visibilityOf("protectedField", "Hidden#")).toBe("protected");
		expect(visibilityOf("publicField", "Hidden#")).toBe("public");
		expect(visibilityOf("publicField", "Visible#")).toBe("public");
		expect(visibilityOf("privateField", "Visible#")).toBe("private");
	});

	test("extracts class and function template parameters", () => {
		const facts = parseCppFile(
			"templates.cpp",
			[
				"template <class T, int Size>",
				"class Array {",
				"public:",
				"\tT& at(int index);",
				"};",
				"template <typename T>",
				"T identity(T value) { return value; }",
			].join("\n"),
		);
		const templateParameters = facts.declarations.filter((declaration) => declaration.kind === "typeParameter");

		expect(templateParameters.map((declaration) => declaration.name)).toEqual(["T", "Size", "T"]);
		expect(facts.declarations.find((declaration) => declaration.name === "Array")?.signature).toContain("template");
		expect(facts.declarations.find((declaration) => declaration.name === "identity")?.signature).toContain(
			"typename",
		);
		expect(facts.declarations.find((declaration) => declaration.name === "identity")?.kind).toBe("function");
	});

	test("recognizes out-of-class members and constructor kinds", () => {
		const facts = parseCppFile(
			"members.cpp",
			[
				"class Thing {",
				"public:",
				"\tThing();",
				"\t~Thing();",
				"\tint value() const;",
				"};",
				"Thing::Thing() {}",
				"Thing::~Thing() {}",
				"int Thing::value() const { return 1; }",
			].join("\n"),
		);
		const constructors = facts.declarations.filter(
			(declaration) => declaration.name === "Thing" && declaration.kind === "constructor",
		);
		const destructors = facts.declarations.filter((declaration) => declaration.name === "~Thing");
		const methods = facts.declarations.filter((declaration) => declaration.name === "value");

		expect(constructors.every((declaration) => declaration.kind === "constructor")).toBe(true);
		expect(
			destructors.every(
				(declaration) => declaration.kind === "constructor" && declaration.languageKind === "destructor",
			),
		).toBe(true);
		expect(methods.every((declaration) => declaration.containerId?.includes("Thing#"))).toBe(true);
		expect(methods.map((declaration) => declaration.symbolId)).toHaveLength(1);
	});

	test("containers qualified namespace definitions", () => {
		const facts = parseCppFile("qualified.cpp", "namespace api {}\nvoid api::run() {}\n");
		const run = facts.declarations.find((declaration) => declaration.name === "run");

		expect(run?.kind).toBe("function");
		expect(run?.containerId).toContain("api/");
	});

	test("uses the operator symbol spelling for overloaded operators", () => {
		const facts = parseCppFile(
			"operators.cpp",
			[
				"struct Value {",
				"\tValue operator+(const Value& other) const;",
				"\tbool operator==(const Value& other) const;",
				"};",
			].join("\n"),
		);

		expect(
			facts.declarations
				.filter((declaration) => declaration.kind === "operator")
				.map((declaration) => declaration.name),
		).toEqual(["operator+", "operator=="]);
	});

	test("extracts using aliases and typedef names as type declarations", () => {
		const facts = parseCppFile(
			"aliases.hpp",
			[
				"using Name = std::string;",
				"typedef unsigned long Count;",
				"using namespace std;",
				"using std::vector;",
			].join("\n"),
		);
		const aliases = facts.declarations.filter(
			(declaration) => declaration.name === "Name" || declaration.name === "Count",
		);

		expect(aliases.map((declaration) => declaration.languageKind)).toEqual(["using alias", "typedef"]);
		expect(aliases.every((declaration) => declaration.kind === "class")).toBe(true);
		expect(facts.imports).toEqual([]);
		expect(facts.references.filter((reference) => reference.role === "import")).toHaveLength(3);
	});

	test("emits base classes, type uses, construction, calls, reads, and writes", () => {
		const facts = parseCppFile(
			"references.cpp",
			[
				"struct Base {};",
				"struct Other {};",
				"struct Child : public Base, private Other {};",
				"Child make() { Child result; Child* created = new Child(); result = Child{}; return result; }",
			].join("\n"),
		);
		const roles = new Map<string, Set<string>>();
		for (const reference of facts.references) {
			const values = roles.get(reference.name) ?? new Set<string>();
			values.add(reference.role);
			roles.set(reference.name, values);
		}

		expect(roles.get("Base")).toContain("extends");
		expect(roles.get("Other")).toContain("extends");
		expect(roles.get("Child")).toContain("typeUse");
		expect(roles.get("Child")).toContain("instantiate");
		expect(roles.get("Child")).toContain("read");
		expect(roles.get("result")).toContain("write");
	});

	test("binds a qualified workspace declaration through a quoted include", () => {
		const root = makeWorkspace({
			"src/use.cpp": '#include "defs.hpp"\nint run() { return api::Thing{}; }\n',
			"src/defs.hpp": "namespace api { struct Thing {}; }\n",
		});
		const provider = new CppProvider();
		provider.initialize(root);
		const header = readFileSync(path.join(root, "src/defs.hpp"), "utf8");
		provider.parseFile({ module: "src/defs.hpp", contentHash: "defs", text: header });
		const text = readFileSync(path.join(root, "src/use.cpp"), "utf8");
		const facts = provider.parseFile({ module: "src/use.cpp", contentHash: "use", text });
		const thing = facts.references.find((reference) => reference.name === "Thing");

		expect(thing?.binding).toMatchObject({ status: "bound" });
		expect(thing?.binding.status === "bound" ? thing.binding.symbolId : "").toContain("api/Thing#");
	});

	test("distinguishes unresolved quoted includes from external bracket includes", () => {
		const root = makeWorkspace({ "src/use.cpp": '#include "missing.hpp"\n#include <missing>\n' });
		const provider = new CppProvider();
		provider.initialize(root);
		const text = readFileSync(path.join(root, "src/use.cpp"), "utf8");
		provider.parseFile({ module: "src/use.cpp", contentHash: "use", text });

		expect(provider.resolveImport({ fromModule: "src/use.cpp", specifier: "missing.hpp" })).toMatchObject({
			status: "unresolved",
			reason: "NotIndexed",
		});
		expect(provider.resolveImport({ fromModule: "src/use.cpp", specifier: "missing" })).toEqual({
			status: "external",
			packageName: "missing",
		});
	});

	test("keeps template-dependent binding and type answers unknown", () => {
		const provider = new CppProvider();
		provider.initialize(process.cwd());
		const text = "template <typename T> T call(T value) { return value; }";
		const facts = provider.parseFile({ module: "dependent.cpp", contentHash: "dependent", text });
		const value = facts.references.find((reference) => reference.name === "value");
		const functionDeclaration = facts.declarations.find((declaration) => declaration.name === "call");

		expect(value?.binding).toMatchObject({ status: "unbound", reason: "NotImplemented" });
		if (functionDeclaration === undefined) throw new Error("template function missing");
		expect(provider.typeOf({ symbolId: functionDeclaration.symbolId })).toMatchObject({
			status: "unknown",
			reason: "NotImplemented",
		});
	});

	test("answers type requests by declaration range and rejects malformed ids", () => {
		const provider = new CppProvider();
		provider.initialize(process.cwd());
		const text = "int run() { int value = 1; return value; }";
		const facts = provider.parseFile({ module: "ranges.cpp", contentHash: "ranges", text });
		const value = facts.declarations.find((declaration) => declaration.name === "value");
		if (value === undefined) throw new Error("local declaration missing");

		expect(
			provider.typeOf({
				module: "ranges.cpp",
				range: value.selectionRange as NonNullable<typeof value.selectionRange>,
			}),
		).toMatchObject({
			status: "known",
			display: "int",
		});
		expect(provider.typeOf({ symbolId: "not-an-id" })).toMatchObject({ status: "unknown", reason: "ParseError" });
		expect(provider.typeOf({ symbolId: declarationId("missing.cpp", "term", "value") })).toMatchObject({
			status: "unknown",
			reason: "NotIndexed",
		});
	});

	test("decodes string literals and preserves numeric forms", () => {
		const facts = parseCppFile(
			"literal-forms.cpp",
			[
				'const char* one = "a\\n b";',
				'const char* two = R"tag(raw value)tag";',
				"int mask = 0xff;",
				"auto suffixedHex = 0xFFFFFFFFull;",
				"auto suffixedLowerHex = 0xffffffffu;",
				"auto suffixedDecimal = 255ul;",
				"auto tooLargeHex = 0xffffffffffffffff;",
				"auto tooLargeDecimal = 18446744073709551615;",
				"bool ready = false;",
			].join("\n"),
		);
		const strings = facts.literals.filter((literal) => literal.kind === "string");

		expect(strings.map((literal) => literal.value)).toEqual(["a\n b", "raw value"]);
		expect(facts.literals.find((literal) => literal.value === "0xff")?.number).toBe(255);
		expect(facts.literals.find((literal) => literal.value === "0xFFFFFFFFull")?.number).toBe(4294967295);
		expect(facts.literals.find((literal) => literal.value === "0xffffffffu")?.number).toBe(4294967295);
		expect(facts.literals.find((literal) => literal.value === "255ul")?.number).toBe(255);
		expect(facts.literals.find((literal) => literal.value === "0xffffffffffffffff")?.number).toBeUndefined();
		expect(facts.literals.find((literal) => literal.value === "18446744073709551615")?.number).toBeUndefined();
		expect(facts.literals.find((literal) => literal.value === "false")?.kind).toBe("boolean");
	});

	test("reports unmatched delimiters and unterminated block comments", () => {
		const facts = parseCppFile("broken.cpp", "int value = (1;\n/* comment\n");
		const messages = facts.diagnostics.map((diagnostic) => diagnostic.message);

		expect(messages.some((message) => message.includes("not closed"))).toBe(true);
		expect(messages.some((message) => message.includes("block comment"))).toBe(true);
		expect(
			facts.diagnostics.every(
				(diagnostic) => diagnostic.severity === "error" && diagnostic.path === "broken.cpp",
			),
		).toBe(true);
	});

	test("keeps function and class declaration ranges through their bodies", () => {
		const text = ["struct Holder {", "\tint value;", "\tint get() {", "\t\treturn value;", "\t}", "};"].join("\n");
		const facts = parseCppFile("ranges.hpp", text);
		const holder = facts.declarations.find((declaration) => declaration.name === "Holder");
		const get = facts.declarations.find((declaration) => declaration.name === "get");

		expect(holder?.range.end).toEqual({ line: 5, character: 2 });
		expect(get?.range.end).toEqual({ line: 4, character: 2 });
		expect(holder?.metrics?.lines).toBe(6);
		expect(get?.metrics?.parameters).toBe(0);
	});

	test("exposes every protocol handler key", () => {
		const handlers = handlersFor(new CppProvider());

		expect(Object.keys(handlers).sort()).toEqual([
			"bind",
			"discoverProject",
			"initialize",
			"moveEdits",
			"parseFile",
			"renameEdits",
			"resolveImport",
			"shutdown",
			"typeOf",
		]);
	});
});
