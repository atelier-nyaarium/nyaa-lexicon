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

function wire(root = process.cwd()) {
	const handlers = handlersFor(new CppProvider());
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return handlers;
}

function declarationNames(text: string, module = "edge.cpp") {
	return parseCppFile(module, text).declarations;
}

/** The best of three parses and bindings of `text`, in milliseconds. */
function parseTime(text: string): number {
	let best = Number.POSITIVE_INFINITY;
	for (let round = 0; round < 3; round++) {
		const handlers = wire();
		const started = performance.now();
		handlers.parseFile({ module: "scaling.cpp", contentHash: String(round), text });
		best = Math.min(best, performance.now() - started);
	}
	return best;
}

/** The last descriptor of an id: what a test names a declaration by. */
function shortId(symbolId: string): string {
	return symbolId.split(" ").at(-1) ?? "";
}

/** Each reference to one of `names`, in order, with its bound id, its candidates, or its reason. */
function targets(facts: ReturnType<ReturnType<typeof wire>["parseFile"]>, names: readonly string[]): string[][] {
	return facts.references
		.filter((reference) => names.includes(reference.name))
		.map((reference) => {
			const binding = reference.binding;
			if (binding.status === "bound") return [reference.name, shortId(binding.symbolId)];
			if (binding.status === "ambiguous") return [reference.name, binding.candidates.map(shortId).join(" | ")];
			return [reference.name, binding.reason];
		});
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
		const nested = parseCppFile("aliases.cpp", "using Map = std::map<int, std::vector<int>>;\n");
		expect([...nested.typeAnswers.values()]).toEqual([
			{ status: "known", display: "std::map<int, std::vector<int>>", provenance: "declared" },
		]);
	});

	test("declares every declarator of a statement, each with its own type", () => {
		const facts = parseCppFile(
			"declarators.cpp",
			[
				"int *p, *q;",
				"int a = 1, b = 2;",
				"int f(), g();",
				"std::function<int(int)> handler;",
				"std::function<void(std::vector<int>)> cb;",
				"int (*callback)(int);",
				"size_t (Dispatcher::*method)(int);",
				"struct { int x; } origin = {1};",
				"struct Named named = {3};",
				"typedef struct { int y; } Point;",
				"typedef enum { RED, GREEN } Color;",
				"typedef struct Node { int value; } Node;",
			].join("\n"),
		);
		const byName = (name: string) => facts.declarations.find((declaration) => declaration.name === name);
		const type = (name: string) => facts.typeAnswers.get(byName(name)?.symbolId ?? "");

		expect(
			facts.declarations
				.filter((declaration) => declaration.containerId === undefined)
				.map((declaration) => [declaration.name, declaration.kind]),
		).toEqual([
			["p", "variable"],
			["q", "variable"],
			["a", "variable"],
			["b", "variable"],
			["f", "function"],
			["g", "function"],
			["handler", "variable"],
			["cb", "variable"],
			["callback", "variable"],
			["method", "variable"],
			["(anonymous)", "struct"],
			["origin", "variable"],
			["named", "variable"],
			["Point", "class"],
			["Color", "class"],
			["Node", "struct"],
		]);
		expect(new Set(facts.declarations.map((declaration) => declaration.symbolId)).size).toBe(
			facts.declarations.length,
		);
		expect(byName("Node")?.range.end).toEqual({ line: 11, character: 40 });
		expect(type("q")).toMatchObject({ display: "int *" });
		expect(byName("g")?.signature).toBe("int g()");
		expect(type("handler")).toMatchObject({ display: "std::function<int (int)>" });
		expect(byName("y")?.containerId).toBe(byName("Point")?.symbolId);
		expect([byName("RED")?.containerId, byName("GREEN")?.containerId]).toEqual([
			byName("Color")?.symbolId,
			byName("Color")?.symbolId,
		]);
		expect(facts.references.find((reference) => reference.name === "Named")?.role).toBe("typeUse");
	});

	test("reads braced member initializers apart from the constructor's body", () => {
		const facts = parseCppFile(
			"initializers.cpp",
			[
				"struct Foo {",
				"\tint a; int b;",
				"\tFoo() : a{1}, b{2} { int inner = a; }",
				"\tFoo(int v, int w);",
				"};",
				"Foo::Foo(int v, int w) try : a{v}, b{w} {} catch (const Error& error) { report(error); }",
				"int after;",
			].join("\n"),
		);
		const constructors = facts.declarations.filter((declaration) => declaration.kind === "constructor");
		const containerOf = (name: string) =>
			facts.declarations.find((declaration) => declaration.name === name)?.containerId;

		expect(constructors.map((declaration) => [declaration.range.start.line, declaration.range.end])).toEqual([
			[2, { line: 2, character: 38 }],
			[5, { line: 5, character: 88 }],
		]);
		expect(containerOf("inner")).toBe(constructors[0]?.symbolId);
		expect(containerOf("error")).toBe(constructors[1]?.symbolId);
		expect(containerOf("after")).toBeUndefined();
	});

	test("names conversion and comparison operators from their declarations", () => {
		const facts = parseCppFile(
			"operators.cpp",
			[
				"struct Value {",
				"Value operator()(int index) const;",
				"Value operator<=>(const Value& other) const;",
				"operator bool() const;",
				"operator const char*() const;",
				"Value& operator=(const Value&) = default;",
				"Value& operator=(Value&&) = delete;",
				"bool operator>(const Value& other) const;",
				"};",
			].join("\n"),
		);
		const operators = facts.declarations.filter((declaration) => declaration.kind === "operator");

		expect(operators.map((declaration) => declaration.name)).toEqual([
			"operator()",
			"operator<=>",
			"operator bool",
			"operator const char *",
			"operator=",
			"operator=",
			"operator>",
		]);
		expect(operators.every((declaration) => declaration.languageKind === "operator")).toBe(true);
		expect(new Set(operators.map((declaration) => declaration.symbolId)).size).toBe(operators.length);
		// A conversion's type is the one it converts to.
		expect(operators.slice(2, 4).map((declaration) => facts.typeAnswers.get(declaration.symbolId))).toMatchObject([
			{ status: "known", display: "bool" },
			{ status: "known", display: "char *" },
		]);
	});

	test("declares a friend only when the friend's definition is written there", () => {
		const facts = parseCppFile(
			"friends.cpp",
			[
				"class A {",
				"friend class B;",
				"friend struct ::ns::C;",
				"friend void helper(A&);",
				"template <typename T> friend class Box;",
				"friend bool operator==(const A&, const A&) { return true; }",
				"};",
			].join("\n"),
		);
		const roles = (name: string) =>
			facts.references.filter((reference) => reference.name === name).map((reference) => reference.role);

		expect(facts.declarations.map((declaration) => [declaration.name, declaration.kind])).toEqual([
			["A", "class"],
			["operator==", "operator"],
		]);
		expect(facts.declarations[1]?.visibility).toBe("public");
		expect([...roles("B"), ...roles("C"), ...roles("Box")]).toEqual(["typeUse", "typeUse", "typeUse"]);
		expect(roles("helper")).toEqual(["read"]);
		expect(facts.diagnostics).toEqual([]);
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

	test("names a defaulted template parameter by its own name, and leaves an unnamed one out", () => {
		const facts = parseCppFile(
			"defaults.cpp",
			[
				"template <typename T = int, std::size_t N = sizeof(T), typename = std::enable_if_t<(N > 1)>,",
				"          typename U = std::vector<std::vector<T>>> struct Grid {};",
				"template <typename T> struct Box<T, std::enable_if_t<A<T>::value && B<T>::value>> { int inside; };",
				"template <value_t> struct external_constructor;",
			].join("\n"),
		);
		const parameters = facts.declarations.filter((declaration) => declaration.kind === "typeParameter");
		const u = parameters.find((declaration) => declaration.name === "U");

		expect(parameters.map((declaration) => declaration.name)).toEqual(["T", "N", "U", "T"]);
		// `>>` closes both lists; U's range takes the first half.
		expect(u?.range).toEqual({ start: { line: 1, character: 10 }, end: { line: 1, character: 50 } });
		expect(facts.declarations.find((declaration) => declaration.name === "inside")?.kind).toBe("field");
	});

	test("reads a `<` after a declared variable as a comparison, and after a declared template as a list", () => {
		const text = [
			"int a, b, c, d;",
			"bool f() { return a < b && c > ::d; }",
			"template <bool> void g() {}",
			"void h() { g<true && false>(); }",
		].join("\n");
		const facts = wire().parseFile({ module: "angles.cpp", contentHash: "angles", text });

		expect(
			facts.references.map((reference) => [
				reference.name,
				reference.role,
				reference.binding.status === "bound" ? reference.binding.symbolId.split(" ").at(-1) : "",
			]),
		).toEqual([
			["a", "read", "a."],
			["b", "read", "b."],
			["c", "read", "c."],
			["d", "read", "d."],
			["g", "call", "g()."],
		]);
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

		const unnamed = parseCppFile("members.cpp", "void f(int, double = 1e-4);\n");
		expect(unnamed.declarations.map((declaration) => declaration.name)).toEqual(["f"]);
		expect(unnamed.declarations[0]?.metrics?.parameters).toBe(2);
	});

	const LOCALS = [
		"int run(int value) {",
		"\tint total = 0;",
		"\tauto scale = [total, &factor = value](int value) { int doubled = value * 2; return doubled + factor; };",
		"\tfor (int index = 0; index < 3; index++) { int value = index; total += value; }",
		"\tif (auto [first, second] = split(value); first && second) { total += first; }",
		"\tfor (const auto& [key, item] : table) total += item;",
		"\ttry { total++; } catch (const Error& failure) { return failure.code; }",
		"\twhile (int step = next()) total += step;",
		"\tCHECK(*it == total);",
		"\tif (ready && total) {}",
		"\treturn scale(value);",
		"}",
	].join("\n");

	test("declares the locals of blocks, conditions, handlers and lambdas under their function, in source order", () => {
		const facts = parseCppFile("locals.cpp", LOCALS);
		const run = facts.declarations.find((declaration) => declaration.name === "run");
		const locals = facts.declarations.filter((declaration) => declaration.visibility === "local");

		expect(locals.map((declaration) => [declaration.name, declaration.languageKind ?? ""])).toEqual([
			["value", "parameter"],
			["total", ""],
			["scale", ""],
			["factor", "capture"],
			["value", "lambda parameter"],
			["doubled", ""],
			["index", ""],
			["value", ""],
			["first", "structured binding"],
			["second", "structured binding"],
			["key", "structured binding"],
			["item", "structured binding"],
			["failure", "constant"],
			["step", ""],
		]);
		expect(locals.every((declaration) => declaration.containerId === run?.symbolId)).toBe(true);
		expect(new Set(locals.map((declaration) => declaration.symbolId)).size).toBe(locals.length);
	});

	test("binds a name to the innermost local in view, then to the parameter", () => {
		const facts = wire().parseFile({ module: "locals.cpp", contentHash: "locals", text: LOCALS });
		const kindOf = (symbolId: string) =>
			facts.declarations.find((declaration) => declaration.symbolId === symbolId)?.languageKind ?? "";
		const values = facts.references
			.filter((reference) => reference.name === "value")
			.map((reference) =>
				reference.binding.status === "bound"
					? [reference.range.start.line, kindOf(reference.binding.symbolId)]
					: reference.binding.status,
			);

		expect(values).toEqual([
			[2, "parameter"],
			[2, "lambda parameter"],
			[3, ""],
			[4, "parameter"],
			[10, "parameter"],
		]);

		const captured = wire().parseFile({
			module: "capture.cpp",
			contentHash: "capture",
			text: "void l() { int x = 1; auto g = [x = x + 1]() { return x; }; }\n",
		});
		// The initializer's `x` is the outer one; the body's is the capture.
		expect(
			captured.references
				.filter((reference) => reference.name === "x")
				.map((reference) =>
					reference.binding.status === "bound" ? reference.binding.symbolId.split(" ").at(-1) : "",
				),
		).toEqual(["l().x.", "l().x[2]."]);
	});

	test("reads a body's declarations apart from its expressions", () => {
		const facts = parseCppFile(
			"body.cpp",
			[
				"struct Item {};",
				"int f(int a, int b) {",
				"\ta * b;",
				"\ta & b;",
				"\tItem* p;",
				"\tWidget* w = make();",
				"\tstruct { int x; } origin = {1};",
				"\tusing Alias = int;",
				"\tAlias n;",
				"\treturn 0;",
				"}",
			].join("\n"),
		);

		expect(
			facts.declarations
				.filter((declaration) => declaration.visibility === "local")
				.map((declaration) => [declaration.name, declaration.range.start.line]),
		).toEqual([
			["a", 1],
			["b", 1],
			["p", 4],
			["w", 5],
			["(anonymous)", 6],
			["origin", 6],
			["Alias", 7],
			["n", 8],
		]);
		// A local aggregate holds its members.
		const aggregate = facts.declarations.find((declaration) => declaration.name === "(anonymous)");
		expect(facts.declarations.find((declaration) => declaration.name === "x")?.containerId).toBe(
			aggregate?.symbolId,
		);

		// What the nearest scope declares a name as decides: a value multiplies, a class's own name is a type.
		const values = parseCppFile(
			"values.cpp",
			[
				"int Widget = 1;",
				"int a;",
				"void f(int c) { Widget * y; a * b = c; }",
				"struct Node { Node(); void g() { Node& parent = self(); } };",
			].join("\n"),
		);
		expect(
			values.declarations.filter((declaration) => declaration.visibility === "local").map((d) => d.name),
		).toEqual(["c", "parent"]);
	});

	test("binds an unqualified name only through the scopes around it, their usings and a class's bases", () => {
		const text = [
			"namespace b { int foo; }",
			"namespace a { int f() { return foo; } }",
			"namespace c { using namespace b; int g() { return foo; } }",
			"namespace d { using b::foo; int h() { return foo; } }",
			"namespace a { int bar; } namespace a { int k() { return bar; } }",
			"namespace { int hidden; } int m() { return hidden; }",
			"struct Base { int member; };",
			"struct Derived : Base { Derived(); int n() { return member; } Derived copy() { return Derived(); } };",
		].join("\n");
		const facts = wire().parseFile({ module: "lookup.cpp", contentHash: "lookup", text });
		const bindings = facts.references
			.filter((reference) => reference.role !== "import" && reference.role !== "extends")
			.map((reference) => [
				reference.name,
				reference.binding.status === "bound"
					? reference.binding.symbolId.split(" ").at(-1)
					: reference.binding.status,
			]);

		expect(bindings).toEqual([
			["foo", "unbound"],
			["foo", "b/foo."],
			["foo", "b/foo."],
			["bar", "a/bar."],
			["hidden", "`(anonymous)`/hidden."],
			["member", "Base#member."],
			["Derived", "Derived#"],
			["Derived", "Derived#"],
		]);
	});

	test("binds a member only through its receiver's declared type", () => {
		const text = [
			"struct Item { int field; };",
			"int field;",
			"Item* make();",
			"Item items[2];",
			"typedef Item* ItemPtr;",
			"int read(Item* p, Item& r, ItemPtr q) {",
			"\tItem* P = p;",
			"\tauto a = *p;",
			"\treturn p->field + P->field + make()->field + items[0].field + r.field + q->field + a.field + p.field;",
			"}",
		].join("\n");
		const facts = wire().parseFile({ module: "members.cpp", contentHash: "members", text });

		// Never the global `field`: an `auto` receiver and `.` through a pointer reach nothing known.
		expect(targets(facts, ["field"])).toEqual([
			...Array(6).fill(["field", "Item#field."]),
			["field", "NotImplemented"],
			["field", "NotImplemented"],
		]);
	});

	test("follows a class's bases by what its base clause names where it stands, into an included file too", () => {
		const root = makeWorkspace({
			"src/base.hpp": "struct Shared { int inherited; };\n",
			"src/use.cpp": [
				'#include "base.hpp"',
				"namespace B { struct Base { int member; }; }",
				"namespace A {",
				"struct Base { int other; };",
				"struct Derived : Base { int n() { return member + other; } };",
				"struct Leaf : Shared { int m() { return inherited; } };",
				"}",
			].join("\n"),
		});
		const provider = wire(root);
		provider.parseFile({
			module: "src/base.hpp",
			contentHash: "base",
			text: readFileSync(path.join(root, "src/base.hpp"), "utf8"),
		});
		const facts = provider.parseFile({
			module: "src/use.cpp",
			contentHash: "use",
			text: readFileSync(path.join(root, "src/use.cpp"), "utf8"),
		});

		expect(targets(facts, ["Base", "member", "other", "Shared", "inherited"])).toEqual([
			["Base", "A/Base#"],
			["member", "NotIndexed"],
			["other", "A/Base#other."],
			["Shared", "Shared#"],
			["inherited", "Shared#inherited."],
		]);
	});

	test("combines what sibling bases find: two members are ambiguous, one member through two paths is not", () => {
		const text = [
			"struct A { int x; int only_a; };",
			"struct B { int x; };",
			"struct V { int y; };",
			"struct L : V {};",
			"struct R : V {};",
			"struct D : A, B, L, R { int f() { return x + only_a + y; } };",
		].join("\n");
		const facts = wire().parseFile({ module: "siblings.cpp", contentHash: "siblings", text });

		expect(targets(facts, ["x", "only_a", "y"]).slice(-3)).toEqual([
			["x", "A#x. | B#x."],
			["only_a", "A#only_a."],
			["y", "V#y."],
		]);
	});

	test("looks a member up through a deep chain of bases", () => {
		const count = 20_000;
		const chain = Array.from({ length: count }, (_, index) => `struct C${index + 1} : C${index} {};`);
		const text = ["struct C0 { int deep; };", ...chain, `int read(C${count}* p) { return p->deep; }`].join("\n");
		const facts = wire().parseFile({ module: "chain.cpp", contentHash: "chain", text });

		expect(targets(facts, ["deep"]).at(-1)).toEqual(["deep", "C0#deep."]);
	});

	test("follows a namespace alias in a qualifier, a using-directive and another alias", () => {
		const text = [
			"namespace real { namespace inner { int value; } }",
			"namespace alias = real::inner;",
			"namespace again = alias;",
			"int a() { return alias::value; }",
			"int b() { return again::value; }",
			"int c() { using namespace alias; return value; }",
		].join("\n");
		const facts = wire().parseFile({ module: "aliases.cpp", contentHash: "aliases", text });

		expect(targets(facts, ["value"]).slice(-3)).toEqual(Array(3).fill(["value", "real/inner/value."]));
	});

	test("applies a block's using-directive to its block alone", () => {
		const text = [
			"namespace b { int only; int shared; }",
			"int shared;",
			"void f() {",
			"\t{ using namespace b; only = 1; shared = 1; }",
			"\tonly = 2; shared = 2;",
			"}",
		].join("\n");
		const facts = wire().parseFile({ module: "block-using.cpp", contentHash: "block", text });

		expect(targets(facts, ["only", "shared"])).toEqual([
			["only", "b/only."],
			["shared", "shared. | b/shared."],
			["only", "NotIndexed"],
			["shared", "shared."],
		]);
	});

	test("gathers a namespace's overloads from every opening", () => {
		const text = "namespace a { void f(int); }\nnamespace a { void f(double); void g() { f(1); } }\n";
		const facts = wire().parseFile({ module: "openings.cpp", contentHash: "openings", text });

		expect(targets(facts, ["f"]).at(-1)).toEqual(["f", "a/f(). | a/f(1)."]);
	});

	test("sees what an include declares only after it", () => {
		const root = makeWorkspace({
			"src/defs.hpp": "int Thing;\n",
			"src/use.cpp": 'int before = Thing;\n#include "defs.hpp"\nint after = Thing;\n',
		});
		const provider = wire(root);
		const facts = provider.parseFile({
			module: "src/use.cpp",
			contentHash: "use",
			text: readFileSync(path.join(root, "src/use.cpp"), "utf8"),
		});

		expect(targets(facts, ["Thing"])).toEqual([
			["Thing", "NotIndexed"],
			["Thing", "Thing."],
		]);
	});

	test("sees an inline namespace's names through a qualifier and a using-directive", () => {
		const text = [
			"namespace api { inline namespace v1 { struct Item {}; } }",
			"api::Item qualified;",
			"using namespace api;",
			"Item nominated;",
		].join("\n");
		const facts = wire().parseFile({ module: "inline.cpp", contentHash: "inline", text });

		expect(targets(facts, ["Item"])).toEqual([
			["Item", "api/v1/Item#"],
			["Item", "api/v1/Item#"],
		]);
	});

	test("sees a namespace's names from their declaration on, and a class's members from all its member bodies", () => {
		const text = [
			"void f() { later(); }",
			"void later() {}",
			"void g() { later(); }",
			"struct S { int h() { return count; } int k = count; void set(int value = count); Later make(); int count; struct Later {}; };",
		].join("\n");
		const facts = wire().parseFile({ module: "points.cpp", contentHash: "points", text });

		// A return type is no member body: a member type declared later is not in view there.
		expect(targets(facts, ["later", "count", "Later"])).toEqual([
			["later", "NotIndexed"],
			["later", "later()."],
			["count", "S#count."],
			["count", "S#count."],
			["count", "S#count."],
			["Later", "NotIndexed"],
		]);
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

	test("marks names reached through a receiver or path as qualified", () => {
		const text = [
			"namespace api { struct Item { int value; void run(); }; int count; }",
			"using namespace api;",
			"using api::count;",
			"void api::Item::run() { value = 1; this->value = 2; }",
			"int use(api::Item item, api::Item* pointer) {",
			"\titem.value = ::api::count;",
			"\tpointer->run();",
			"\titem.template get<int>();",
			"\treturn count;",
			"}",
		].join("\n");
		const facts = wire().parseFile({ module: "qualified.cpp", contentHash: "qualified", text });
		const flags = (name: string) =>
			facts.references.filter((reference) => reference.name === name).map((reference) => reference.qualified);

		expect(flags("value")).toEqual([false, true, true]);
		expect(flags("count")).toEqual([false, true, false]);
		expect(flags("api")).toEqual([false, false, false, false, false, true]);
		expect(flags("Item")).toEqual([true, true, true]);
		// Prototype name is bare.
		expect(flags("run")).toEqual([false, true]);
		expect(flags("get")).toEqual([true]);
		expect(flags("item")).toEqual([false, false]);
		expect(facts.references.every((reference) => typeof reference.qualified === "boolean")).toBe(true);

		// A one-letter receiver, a call's result and a subscript's reach through `->` too.
		const reached = parseCppFile(
			"receivers.cpp",
			"int use(Item* P) { P->run(); return make()->value + items[0]->count; }\n",
		).references.filter((reference) => ["run", "value", "count"].includes(reference.name));
		expect(reached.map((reference) => reference.qualified)).toEqual([true, true, true]);
	});

	test("keeps trailing returns, member pointers and macro bodies unqualified", () => {
		const text = [
			"#define FIELD(object) object.field",
			"struct Box { int field; };",
			"auto make() -> Box;",
			"auto build() noexcept -> Box { return make(); }",
			"int read(Box box, int Box::*member, Box* pointer) {",
			"\tauto pick = [](Box b) -> Box { return b; };",
			"\treturn box.*member + pointer->*member + make().field + FIELD(box);",
			"}",
		].join("\n");
		const references = parseCppFile("unqualified.cpp", text).references;
		const flags = (name: string) =>
			references.filter((reference) => reference.name === name).map((reference) => reference.qualified);

		expect(flags("Box")).toEqual(Array(7).fill(false));
		expect(flags("member")).toEqual([false, false]);
		expect(flags("object")).toEqual([false, false]);
		expect(flags("field")).toEqual([false, true]);
	});

	test("binds qualified names in the same file and keeps overloads ambiguous", () => {
		const provider = wire();
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

	test("binds a prototype to its own definition and a qualifier to its type", () => {
		const text = [
			"struct Foo { Foo(int); Foo(); void run(int); void run(double); };",
			"Foo::Foo(int) {}",
			"Foo::Foo() {}",
			"void Foo::run(double) {}",
			"template <typename T> struct Box { static void g(); };",
			"template <> void Box<std::vector<int>>::g() {}",
			"template <> void Box<int>::g() {}",
		].join("\n");
		const facts = wire().parseFile({ module: "prototypes.cpp", contentHash: "prototypes", text });
		const declared = (symbolId: string) => {
			const declaration = facts.declarations.find((candidate) => candidate.symbolId === symbolId);
			return declaration === undefined ? "" : `${declaration.name}@${declaration.range.start.line}`;
		};
		const bindings = facts.references
			.filter((reference) => reference.name === "Foo" || reference.name === "run")
			.map((reference) =>
				reference.binding.status === "bound" ? declared(reference.binding.symbolId) : reference.binding.status,
			);

		expect(bindings).toEqual(["Foo@1", "Foo@2", "run@3", "Foo@0", "Foo@0", "Foo@0"]);
		expect(
			facts.declarations.filter((declaration) => declaration.name === "g").map((d) => d.range.start.line),
		).toEqual([5, 6]);
		const vector = facts.references.find((reference) => reference.name === "vector");
		expect(vector?.role).toBe("typeUse");
	});

	test("reports honest binding reasons for external and missing includes", () => {
		const root = makeWorkspace({
			"src/use.cpp": '#include <lib/vector.hpp>\n#include "missing.hpp"\nstd::vector<int> values;\n',
		});
		const provider = wire(root);
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
		const provider = wire(root);

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
		const provider = wire();
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
		const provider = wire();
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

	test("keeps template-dependent types unresolved, binds a template's own names, and answers a concrete type in a template", () => {
		const provider = wire();
		const facts = provider.parseFile({
			module: "dependent.cpp",
			contentHash: "dependent",
			text: [
				"template <typename T> T call(T value) { return value; }",
				"template <typename T> int count(T item, const bool strict) { int n = 0; T copy = item; return n; }",
				"template <typename T> using Vec = std::vector<T>;",
			].join("\n"),
		});
		const value = facts.references.find((reference) => reference.name === "value");
		const typeOf = (name: string) => {
			const declaration = facts.declarations.find((candidate) => candidate.name === name);
			return declaration === undefined ? undefined : provider.typeOf({ symbolId: declaration.symbolId });
		};
		const aliased = facts.references.filter((reference) => reference.name === "T").at(-1);

		// A parameter of type `T` is still that parameter.
		expect(value?.binding).toMatchObject({ status: "bound", symbolId: expect.stringContaining("call().(value)") });
		expect(typeOf("call")).toMatchObject({ status: "unknown", reason: "NotImplemented" });
		expect(["count", "strict", "n", "copy"].map((name) => typeOf(name)?.status)).toEqual([
			"known",
			"known",
			"known",
			"unknown",
		]);
		expect(typeOf("n")).toMatchObject({ display: "int" });
		expect(aliased?.binding).toMatchObject({ status: "bound", symbolId: expect.stringContaining("Vec#[T]") });
	});

	test("parses and binds a file of many same-named members in time linear in their count", () => {
		const members = (count: number) =>
			Array.from(
				{ length: count },
				(_, index) =>
					`struct S${index} { int field; int get(int a) { int b = a + field; if (b) return b; return get(b); } };`,
			).join("\n");
		// Linear reads 8x; a scan of every same-named declaration per use reads 64x.
		expect(parseTime(members(2_000)) / parseTime(members(250))).toBeLessThan(24);
	});

	// Linear reads 8x in each of these; the scans they replace read 64x.
	test("finds each nested template name's follower in time linear in their depth", () => {
		const nested = (count: number) =>
			`template <typename T> struct Box {};\nvoid f() { sizeof(${"Box<".repeat(count)}int${">".repeat(count)}); }\n`;

		expect(parseTime(nested(4_000)) / parseTime(nested(500))).toBeLessThan(24);
	});

	test(
		"binds the locals of sibling blocks in time linear in their count",
		() => {
			const blocks = (count: number) =>
				`void run() {\n${"\t{ int x; x; x; x; x; x; x; x; x; }\n".repeat(count)}}\n`;

			expect(parseTime(blocks(8_000)) / parseTime(blocks(1_000))).toBeLessThan(24);
		},
		{ timeout: 30_000 },
	);

	test(
		"finds the namespace of qualified definitions in time linear in its openings",
		() => {
			const reopened = (count: number) =>
				Array.from(
					{ length: count },
					(_, index) => `namespace a { void f${index}(); }\nvoid a::f${index}() {}\n`,
				).join("");

			expect(parseTime(reopened(4_000)) / parseTime(reopened(500))).toBeLessThan(24);
		},
		{ timeout: 30_000 },
	);

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
		const provider = wire(root);

		expect(provider.discoverProject({ workspaceRoot: root }).files).toEqual([
			"header.hh",
			"header.hpp",
			"header.hxx",
			"main.cpp",
		]);
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
