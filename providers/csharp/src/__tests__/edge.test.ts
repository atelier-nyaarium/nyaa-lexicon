import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BindingSchema, composeSymbolId, parseSymbolId, TypeInfoSchema } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CsharpProvider } from "../main.js";

const roots: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-csharp-edge-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function parse(text: string, module = "main.cs") {
	const provider = new CsharpProvider();
	provider.initialize("/workspace");
	return { provider, facts: provider.parseFile({ module, contentHash: "edge", text }) };
}

function one<T>(values: T[], message: string): T {
	const value = values[0];
	if (value === undefined) throw new Error(message);
	return value;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C# lexical facts", () => {
	it("decodes escaped, verbatim, raw, and interpolated strings", () => {
		const text = [
			"public class Values {",
			'string Escaped = "line\\nnext";',
			'string Verbatim = @"a ""quote""";',
			'string Reversed = @$"b ""quote""";',
			'string Raw = """raw { value }""";',
			'string Interpolated = $"value {Name}";',
			'string Name = "name";',
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.literals.map((item) => [item.kind, item.value])).toEqual([
			["string", "line\nnext"],
			["string", 'a "quote"'],
			["string", 'b "quote"'],
			["string", "raw { value }"],
			// A hole is code, not text: what it renders to is not known here.
			["string", "value "],
			["string", "name"],
		]);
	});

	it("does not end an interpolated string at a quote inside a hole", () => {
		const { facts } = parse(
			'public class Values {\n\tvoid M() {\n\t\tvar x = $"a // {"b /* c #"} d"; // real\n\t}\n}\n',
		);

		expect(facts.comments.map((item) => item.text)).toEqual(["// real"]);
	});

	it("reports a comment inside a hole, which is code", () => {
		const { facts } = parse(
			'public class Values {\n\tvoid M() {\n\t\tvar x = $"a {1 /* here */} b"; // real\n\t}\n}\n',
		);

		expect(facts.comments.map((item) => item.text)).toEqual(["/* here */", "// real"]);
	});

	it("recognizes decimal, hexadecimal, binary, and suffixed numeric literals", () => {
		const text =
			"public class Numbers { uint A = 0xff; uint B = 0xffu; ulong C = 0XFFFFFFFFUL; ulong D = 0b1010_1010uL; long E = 1_000_000L; double F = 1.5e2; ulong Safe = 9007199254740991UL; ulong Unsafe = 0x20000000000000UL; }";
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.literals.filter((item) => item.kind === "number").map((item) => item.number)).toEqual([
			255,
			255,
			4294967295,
			170,
			1000000,
			150,
			9007199254740991,
			undefined,
		]);
		expect(facts.literals.filter((item) => item.kind === "number").map((item) => item.value)).toEqual([
			"0xff",
			"0xffu",
			"0XFFFFFFFFUL",
			"0b1010_1010uL",
			"1_000_000L",
			"1.5e2",
			"9007199254740991UL",
			"0x20000000000000UL",
		]);
		expect(facts.literals.find((item) => item.value === "0x20000000000000UL")).not.toHaveProperty("number");
	});

	it("keeps braces in comments and strings out of structural ranges", () => {
		const text = [
			"/* { not a type body } */",
			"public class C {",
			'public string Text = "}";',
			'public void Run() { if (Text.Length > 0) { Text = "ok"; } }',
			"}",
		].join("\n");
		const { facts } = parse(text);
		const type = one(
			facts.declarations.filter((item) => item.name === "C"),
			"type missing",
		);
		const run = one(
			facts.declarations.filter((item) => item.name === "Run"),
			"method missing",
		);
		expect(type.range.start).toEqual({ line: 1, character: 0 });
		expect(run.metrics).toMatchObject({ nesting: 1, branches: 2 });
		expect(facts.diagnostics).toEqual([]);
	});
});

describe("C# declaration structure", () => {
	it("reports generic types, generic methods, records, and type parameters", () => {
		const text = [
			"namespace Outer {",
			"public record Person(string Name, int Age);",
			"public class Box<T> { public T Get<U>(U value) { return default; } }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const names = facts.declarations.map((item) => `${item.kind}:${item.name}`);
		expect(names).toEqual([
			"namespace:Outer",
			"class:Person",
			"variable:Name",
			"variable:Age",
			"class:Box",
			"typeParameter:T",
			"method:Get",
			"typeParameter:U",
			"variable:value",
		]);
		const typeParameter = one(
			facts.declarations.filter((item) => item.kind === "typeParameter" && item.name === "T"),
			"type parameter missing",
		);
		expect(parseSymbolId(typeParameter.symbolId)?.descriptors.at(-1)).toEqual({ kind: "typeParameter", name: "T" });
		expect(facts.diagnostics).toEqual([]);
	});

	it("parses verbatim strings, conversion operators, generic delegates, and nullable generic fields", () => {
		const text = [
			"public class C {",
			'public string Line = @"first',
			' second";',
			'public string Quote = @"""";',
			'public string Interpolated = $@"first {Name}',
			' second";',
			'public string Property { get; } = "value";',
			"public static explicit operator bool?(C? value) { return null; }",
			"private readonly Store<Pair<string?, string>, Type> cache;",
			"}",
			"internal delegate TResult MethodCall<T, TResult>(T target, params object?[] args);",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(
			facts.declarations.filter((item) => ["Line", "Quote", "Interpolated", "Property"].includes(item.name)),
		).toHaveLength(4);
		expect(facts.declarations.some((item) => item.name === "cache" && item.kind === "field")).toBe(true);
		expect(facts.declarations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "operator bool?",
					kind: "operator",
					languageKind: "conversionOperator",
				}),
				expect.objectContaining({ name: "MethodCall", kind: "function", languageKind: "delegate" }),
			]),
		);
	});

	it("folds accessors and reports fields split by commas", () => {
		const text = [
			"public class C {",
			"public int A, B = 2;",
			"public int Value { get { return A; } private set { B = value; } }",
			"public event EventHandler First, Second;",
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.declarations.filter((item) => item.kind === "field").map((item) => item.name)).toEqual(["A", "B"]);
		expect(facts.declarations.filter((item) => item.kind === "property").map((item) => item.name)).toEqual([
			"Value",
		]);
		expect(facts.declarations.filter((item) => item.kind === "event").map((item) => item.name)).toEqual([
			"First",
			"Second",
		]);
		expect(facts.declarations.some((item) => item.name === "get" || item.name === "set")).toBe(false);
	});

	it("maps default, explicit, protected, file, and local visibility", () => {
		const text = [
			"public class PublicType {}",
			"class InternalType {}",
			"file class FileType {}",
			"public class Container {",
			"protected int Protected;",
			"private int Private;",
			"public void Run() { var local = 1; }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const item = (name: string) =>
			one(
				facts.declarations.filter((candidate) => candidate.name === name),
				`${name} missing`,
			);
		expect(item("PublicType")).toMatchObject({ visibility: "public", exported: true });
		expect(item("InternalType")).toMatchObject({ visibility: "internal", exported: true });
		expect(item("FileType")).toMatchObject({ visibility: "fileLocal", exported: false });
		expect(item("Protected")).toMatchObject({ visibility: "protected", exported: false });
		expect(item("Private")).toMatchObject({ visibility: "private", exported: false });
		expect(item("local")).toMatchObject({ visibility: "local", exported: false });
	});

	it("keeps declaration ranges through multiline methods and properties", () => {
		const text = [
			"public class C",
			"{",
			"    public int Value",
			"    {",
			"        get { return 1; }",
			"        set { }",
			"    }",
			"    public void Run()",
			"    {",
			"        Value = 2;",
			"    }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const value = one(
			facts.declarations.filter((item) => item.name === "Value"),
			"Value missing",
		);
		const run = one(
			facts.declarations.filter((item) => item.name === "Run"),
			"Run missing",
		);
		expect(value.range).toEqual({ start: { line: 2, character: 4 }, end: { line: 6, character: 5 } });
		expect(run.range).toEqual({ start: { line: 7, character: 4 }, end: { line: 10, character: 5 } });
	});
});

describe("C# imports and binding", () => {
	it("resolves aliases and static using directives", () => {
		const root = makeWorkspace({
			"src/types.cs": "namespace N { public class C { public static int Value; } }\n",
			"src/use.cs":
				"using Alias = N.C; using static N.C; public class Use { public Alias Field; public int Read() { return Value; } }\n",
		});
		const provider = new CsharpProvider();
		provider.initialize(root);
		provider.discoverProject(root);
		const text =
			"using Alias = N.C; using static N.C; public class Use { public Alias Field; public int Read() { return Value; } }\n";
		const facts = provider.parseFile({ module: "src/use.cs", contentHash: "hash", text });
		expect(provider.resolveImport({ fromModule: "src/use.cs", specifier: "N.C" })).toEqual({
			status: "resolved",
			module: "src/types.cs",
		});
		const alias = facts.references.find((item) => item.name === "Alias" && item.role === "typeUse");
		if (alias === undefined) throw new Error("alias reference missing");
		expect(alias.binding.status).toBe("bound");
		expect(facts.imports.map((item) => item.specifier)).toEqual(["N.C", "N.C"]);
	});

	it("binds a type in the current namespace without an import", () => {
		const text =
			"namespace N { public class Item {} public class Use { public Item Make() { return new Item(); } } }";
		const { facts } = parse(text);
		const uses = facts.references.filter((item) => item.name === "Item");
		expect(uses.some((item) => item.role === "instantiate" && item.binding.status === "bound")).toBe(true);
	});

	it("returns a reasoned Ambiguous answer for one unresolved partial member", () => {
		const root = makeWorkspace({
			"a.cs": "namespace N { public partial class C { public void Use() { Other(); } } }\n",
			"b.cs": "namespace N { public partial class C { public void Other() {} } }\n",
		});
		const provider = new CsharpProvider();
		provider.initialize(root);
		provider.discoverProject(root);
		const facts = provider.parseFile({
			module: "a.cs",
			contentHash: "hash",
			text: "namespace N { public partial class C { public void Use() { Other(); } } }\n",
		});
		const reference = one(
			facts.references.filter((item) => item.name === "Other"),
			"Other missing",
		);
		expect(reference.binding).toEqual({
			status: "unbound",
			reason: "Ambiguous",
			detail: "member lookup requires another partial type declaration",
		});
		BindingSchema.parse(reference.binding);
	});
});

describe("C# type answers", () => {
	it("answers declaration and range type requests", () => {
		const text = "public class C { public int Value; public void Run(string input) { var local = 1; } }";
		const { provider, facts } = parse(text);
		const value = one(
			facts.declarations.filter((item) => item.name === "Value"),
			"Value missing",
		);
		const input = one(
			facts.declarations.filter((item) => item.name === "input"),
			"input missing",
		);
		const local = one(
			facts.declarations.filter((item) => item.name === "local"),
			"local missing",
		);
		expect(provider.typeOf({ symbolId: value.symbolId })).toMatchObject({ status: "known", display: "int" });
		expect(
			provider.typeOf({
				module: "main.cs",
				range: input.selectionRange as NonNullable<typeof input.selectionRange>,
			}),
		).toMatchObject({
			status: "known",
			display: "string",
		});
		expect(
			provider.typeOf({
				module: "main.cs",
				range: local.selectionRange as NonNullable<typeof local.selectionRange>,
			}),
		).toMatchObject({
			status: "inferred",
			display: "int",
		});
	});

	it("returns honest answers for dynamic and unsupported types", () => {
		const text = "public class C { public dynamic Value; public C() {} }";
		const { provider, facts } = parse(text);
		const value = one(
			facts.declarations.filter((item) => item.name === "Value"),
			"Value missing",
		);
		const ctor = one(
			facts.declarations.filter((item) => item.kind === "constructor"),
			"constructor missing",
		);
		expect(provider.typeOf({ symbolId: value.symbolId })).toMatchObject({
			status: "unknown",
			reason: "DynamicallyTyped",
		});
		expect(provider.typeOf({ symbolId: ctor.symbolId })).toMatchObject({ status: "known", display: "C" });
		expect(provider.typeOf({ symbolId: "not-an-id" })).toMatchObject({ status: "unknown", reason: "ParseError" });
		expect(
			provider.typeOf({
				symbolId: composeSymbolId({
					language: "python",
					module: "main.cs",
					descriptors: [{ kind: "type", name: "C" }],
				}),
			}),
		).toMatchObject({ status: "unknown", reason: "ParseError" });
		TypeInfoSchema.parse(provider.typeOf({ symbolId: value.symbolId }));
	});

	it("resolves an annotated workspace type to its declaration", () => {
		const root = makeWorkspace({
			"src/item.cs": "namespace N { public class Item {} }\n",
			"src/use.cs": "using N; public class Use { public Item Value; }\n",
		});
		const provider = new CsharpProvider();
		provider.initialize(root);
		provider.discoverProject(root);
		const facts = provider.parseFile({
			module: "src/use.cs",
			contentHash: "hash",
			text: "using N; public class Use { public Item Value; }\n",
		});
		const value = one(
			facts.declarations.filter((item) => item.name === "Value"),
			"Value missing",
		);
		const type = provider.typeOf({ symbolId: value.symbolId });
		expect(type).toMatchObject({
			status: "known",
			display: "Item",
			symbolId: expect.stringContaining("src/item.cs"),
		});
	});
});

describe("C# references and diagnostics", () => {
	it("emits the declared role set for calls, reads, writes, inheritance, and construction", () => {
		const text = [
			"public class Base {}",
			"public interface I {}",
			"public class Derived : Base, I {",
			"public int Value;",
			"public void Run() { Value = new Derived().Value; Run(); }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const roles = new Set(facts.references.map((item) => item.role));
		expect(roles).toEqual(new Set(["extends", "implements", "instantiate", "write", "read", "call"]));
		expect(facts.references.find((item) => item.name === "Base")?.role).toBe("extends");
		expect(facts.references.find((item) => item.name === "I")?.role).toBe("implements");
		expect(facts.references.find((item) => item.name === "Derived")?.role).toBe("instantiate");
		for (const reference of facts.references) BindingSchema.parse(reference.binding);
	});

	it("reports unclosed strings and delimiters as errors", () => {
		const { facts: stringFacts } = parse('public class C { string Value = "broken; }', "broken-string.cs");
		const { facts: delimiterFacts } = parse("public class C { public void Run( { }", "broken-delimiter.cs");
		const { facts: memberFacts } = parse("public class C { public int Value }", "broken-member.cs");
		expect(stringFacts.diagnostics.some((item) => item.message.includes("String literal"))).toBe(true);
		expect(
			delimiterFacts.diagnostics.some(
				(item) => item.message.includes("Parameter list") || item.message.includes("not closed"),
			),
		).toBe(true);
		expect(memberFacts.diagnostics.some((item) => item.message.includes("terminating delimiter"))).toBe(true);
	});

	it("does not diagnose valid conditional directives and attributes", () => {
		const text = [
			"#if FEATURE",
			'[Obsolete("{")]',
			"public class C {",
			"#endif",
			'public string Value = @"}";',
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.map((item) => item.name)).toEqual(["C", "Value"]);
	});

	it("rejects an invalid workspace root through the project model", () => {
		const model = new CsharpProvider().discoverProject(path.join(tmpdir(), "does-not-exist-csharp-root"));
		expect(model.files).toEqual([]);
		expect(model.diagnostics[0]).toMatchObject({ severity: "error" });
	});

	it("round-trips ids with spaces and unicode module paths", () => {
		const id = composeSymbolId({
			language: "csharp",
			module: "src/space name/文件.cs",
			descriptors: [{ kind: "type", name: "C" }],
		});
		expect(parseSymbolId(id)).toEqual({
			language: "csharp",
			module: "src/space name/文件.cs",
			descriptors: [{ kind: "type", name: "C" }],
		});
	});
});
