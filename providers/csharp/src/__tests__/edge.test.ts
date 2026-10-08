import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BindingSchema, composeSymbolId, parseSymbolId, TypeInfoSchema } from "@nyaa-lexicon/protocol";
import { CsharpProvider } from "../main.js";
import { CsharpParser } from "../parser.js";
import { parseThroughKit, startProvider } from "./harness.js";

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
	startProvider(provider);
	return { provider, facts: parseThroughKit(provider, { module, contentHash: "edge", text }) };
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
			// A hole is code, not text: what it renders to is not known here, so the literal carries
			// the hole's own source, braces included, rather than dropping it.
			["string", "value {Name}"],
			["string", "name"],
		]);
	});

	it("carries a multi-hole interpolated string's holes verbatim in the one literal", () => {
		const { facts } = parse('public class Values {\n\tstring Cmd = $"install {p.Name}@{p.Marketplace}";\n}\n');

		expect(facts.diagnostics).toEqual([]);
		expect(facts.literals.map((item) => [item.kind, item.value])).toEqual([
			["string", "install {p.Name}@{p.Marketplace}"],
		]);
	});

	it("carries a hole verbatim for a verbatim-interpolated and a raw-interpolated string too", () => {
		const { facts: reversed } = parse('public class C { string X = $@"a ""q"" {p.Name} b"; }\n');
		expect(reversed.diagnostics).toEqual([]);
		expect(reversed.literals.map((item) => item.value)).toEqual(['a "q" {p.Name} b']);

		const { facts: raw } = parse('public class C {\n\tstring X = $"""install {p.Name}""";\n}\n');
		expect(raw.diagnostics).toEqual([]);
		expect(raw.literals.map((item) => item.value)).toEqual(["install {p.Name}"]);
	});

	it("does not end an interpolated string at a quote inside a hole", () => {
		const { facts } = parse(
			'public class Values {\n\tvoid M() {\n\t\tvar x = $"a // {"b /* c #"} d"; // real\n\t}\n}\n',
		);

		expect((facts.comments ?? []).map((item) => item.text)).toEqual(["// real"]);
	});

	it("reports a comment inside a hole, which is code", () => {
		const { facts } = parse(
			'public class Values {\n\tvoid M() {\n\t\tvar x = $"a {1 /* here */} b"; // real\n\t}\n}\n',
		);

		expect((facts.comments ?? []).map((item) => item.text)).toEqual(["/* here */", "// real"]);
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

	it("reads a real that starts at its point, and a real suffix on digits", () => {
		const { facts } = parse("public class C { double A = .5; float B = 1e3f; double C = 10000000000000000000d; }");
		expect(facts.diagnostics).toEqual([]);
		expect(facts.literals.map((item) => [item.value, item.number, item.range.start.character])).toEqual([
			[".5", 0.5, 28],
			["1e3f", 1000, 42],
			["10000000000000000000d", 1e19, 59],
		]);
	});

	it("dedents a multi-line raw string by its closing line and drops its delimiter lines", () => {
		const text = [
			"public class C {",
			'\tstring A = """',
			"\t\t{",
			'\t\t  "name": "x"',
			"",
			"\t\t}",
			'\t\t""";',
			'\tstring B = $$"""',
			'\t\t  {"id": {{Id}}, "raw": {braces}}',
			'\t\t""";',
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.literals.map((item) => item.value)).toEqual([
			'{\n  "name": "x"\n\n}',
			'  {"id": {{Id}}, "raw": {braces}}',
		]);
		const crlf = parse(text.replaceAll("\n", "\r\n")).facts;
		expect(crlf.literals.map((item) => item.value)).toEqual([
			'{\r\n  "name": "x"\r\n\r\n}',
			'  {"id": {{Id}}, "raw": {braces}}',
		]);
	});

	it("marks only a multi-line raw string dedented, interpolated or not", () => {
		const text = [
			"public class C {",
			'\tstring Raw = """',
			"\t\tline",
			'\t\t""";',
			'\tstring Longer = """"',
			'\t\tholds """',
			'\t\t"""";',
			'\tstring Hole = $$"""',
			"\t\t{{Id}}",
			'\t\t""";',
			'\tstring Verbatim = @"',
			'\t\tline";',
			'\tstring Single = """line""";',
			'\tstring Plain = "line";',
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.literals.map((item) => [item.value, item.dedented ?? false])).toEqual([
			["line", true],
			['holds """', true],
			["{{Id}}", true],
			["\n\t\tline", false],
			["line", false],
			["line", false],
		]);
	});

	it("reads an interpolation hole as code: its names are uses and its commas its own", () => {
		const text = [
			"class C {",
			'  string A = $"{user.Name,  -5:N2} and {b}", B;',
			'  void M() { var s = $"{x, 3}", t = 1; }',
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.map((item) => [item.name, item.signature])).toEqual([
			["C", "class C"],
			["A", 'string A = $"{user.Name,  -5:N2} and {b}"'],
			["B", "string B"],
			["M", "void M()"],
			["s", 'var s = $"{x, 3}"'],
			["t", "var t = 1"],
		]);
		expect(facts.references.map((item) => item.name)).toEqual(["user", "Name", "b", "x"]);
		expect(facts.literals.map((item) => item.value)).toEqual([
			"{user.Name,  -5:N2} and {b}",
			"5",
			"{x, 3}",
			"3",
			"1",
		]);
		expect(facts.declarations.find((item) => item.name === "M")?.metrics?.nesting).toBe(0);
	});

	it("keeps a UTF-8 suffix inside its string, never a name", () => {
		const { facts } = parse('public class C { byte[] A = "utf8"u8; string B = $"{x}"; }');
		expect(facts.diagnostics).toEqual([]);
		expect(facts.references.map((item) => item.name)).toEqual(["x"]);
		expect(facts.literals[0]).toMatchObject({ value: "utf8", range: { end: { character: 36 } } });
	});

	it("reads an @ or escaped identifier as a name, never a keyword", () => {
		const { facts } = parse(
			[
				"class @event { int @class = 1; void M(int @in) {",
				"var x = @in + cl\\u0061ss;",
				"var tru\\U00000065 = x;",
				"var so\\u00adft = tru\\u0065;",
				"x = soft;",
				"} }",
			].join("\n"),
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["event", "class", "M", "in", "x", "true", "soft"]);
		expect(facts.references.map((item) => [item.name, item.binding.status])).toEqual([
			["in", "bound"],
			["class", "bound"],
			["x", "bound"],
			["true", "bound"],
			["x", "bound"],
			["soft", "bound"],
		]);
		expect(facts.literals.map((item) => item.value)).toEqual(["1"]);
	});

	it("places a token after a lone carriage return or a Unicode line break on the same line, as positions count lines", () => {
		const [nextLine, lineSeparator, paragraphSeparator] = [0x85, 0x2028, 0x2029].map((code) =>
			String.fromCodePoint(code),
		);
		const text = `class C { // note\rint A; // two${lineSeparator}int B;${nextLine}#if false${paragraphSeparator}int C;${lineSeparator}#endif${nextLine}}`;
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect((facts.comments ?? []).map((item) => [item.text, item.codeAfter])).toEqual([
			["// note", true],
			["// two", true],
		]);
		expect(facts.declarations.map((item) => [item.name, item.selectionRange?.start])).toEqual([
			["C", { line: 0, character: 6 }],
			["A", { line: 0, character: 22 }],
			["B", { line: 0, character: 36 }],
		]);
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
	it("reports generic types, generic methods, records, finalizers, extension blocks, and type parameters", () => {
		const text = [
			"namespace Outer {",
			"public record Person(string Name, int Age);",
			"public class Box<T> { public T Get<U>(U value) { return default; } ~Box() { } }",
			"public static class Extensions {",
			"extension<T>(IEnumerable<T> source) { public bool IsEmpty => !source.Any(); }",
			'extension(string) { public static string Empty() => ""; }',
			"}",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const names = facts.declarations.map((item) => `${item.kind}:${item.languageKind}:${item.name}`);
		expect(names).toEqual([
			"namespace:blockNamespace:Outer",
			"class:record:Person",
			"variable:parameter:Name",
			"variable:parameter:Age",
			"class:class:Box",
			"typeParameter:typeParameter:T",
			"method:method:Get",
			"typeParameter:typeParameter:U",
			"variable:parameter:value",
			"method:finalizer:~Box",
			"class:class:Extensions",
			"class:extension:extension",
			"typeParameter:typeParameter:T",
			"variable:parameter:source",
			"property:property:IsEmpty",
			"class:extension:extension",
			"method:method:Empty",
		]);
		expect(new Set(facts.declarations.map((item) => item.symbolId)).size).toBe(facts.declarations.length);
		const source = facts.references.find((item) => item.name === "source");
		expect(source?.binding).toMatchObject({
			status: "bound",
			symbolId: facts.declarations.find((item) => item.name === "source")?.symbolId,
		});
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
		// A generic delegate declares its type parameters, and its signature uses them.
		const delegate = one(
			facts.declarations.filter((item) => item.name === "MethodCall"),
			"delegate missing",
		);
		const parameters = new Map(
			facts.declarations
				.filter((item) => item.kind === "typeParameter" && item.containerId === delegate.symbolId)
				.map((item) => [item.name, item.symbolId]),
		);
		expect([...parameters.keys()]).toEqual(["T", "TResult"]);
		expect(
			facts.references
				.filter((item) => parameters.has(item.name))
				.map((item) => [
					item.name,
					item.binding.status === "bound" ? item.binding.symbolId : item.binding.status,
				]),
		).toEqual([
			["TResult", parameters.get("TResult") as string],
			["T", parameters.get("T") as string],
		]);
	});

	it("folds accessors, walks their bodies, and reports fields split by commas", () => {
		const text = [
			"public class C {",
			"public int A, B = 2;",
			"public int Value { get { var inner = A; return inner; } private set { B = value; } }",
			"public int Backed { get => field; set => field = value; }",
			"public event EventHandler First, Second;",
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.declarations.filter((item) => item.kind === "field").map((item) => item.name)).toEqual(["A", "B"]);
		expect(facts.declarations.filter((item) => item.kind === "property").map((item) => item.name)).toEqual([
			"Value",
			"Backed",
		]);
		const inner = facts.declarations.find((item) => item.name === "inner");
		expect(inner).toMatchObject({ visibility: "local", containerId: facts.declarations[3]?.symbolId });
		expect(facts.references.map((item) => [item.name, item.binding.status])).toEqual([
			["A", "bound"],
			["inner", "bound"],
			["B", "bound"],
			["EventHandler", "unbound"],
		]);
		expect(facts.declarations.filter((item) => item.kind === "event").map((item) => item.name)).toEqual([
			"First",
			"Second",
		]);
		expect(facts.declarations.some((item) => item.name === "get" || item.name === "set")).toBe(false);
	});

	it("reads a lambda initializer as a field holding its locals, and an arrow body as a property", () => {
		const text = [
			"public class C {",
			"public Func<int, int> Tax = amount =>",
			"{",
			"\tvar taxed = amount * 2;",
			"\treturn taxed;",
			"};",
			"public Func<int, int> Half = x => x / 2;",
			"public int Total => Tax(1) + Half(2);",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const names = new Map(facts.declarations.map((item) => [item.symbolId, item.name]));
		expect(facts.declarations.map((item) => [item.kind, item.name, names.get(item.containerId ?? "")])).toEqual([
			["class", "C", undefined],
			["field", "Tax", "C"],
			["variable", "amount", "Tax"],
			["variable", "taxed", "Tax"],
			["field", "Half", "C"],
			["variable", "x", "Half"],
			["property", "Total", "C"],
		]);
	});

	it("gives overloaded indexers and operators each an id, and tells a conversion from an operator", () => {
		const text = [
			"class C {",
			"  int this[int i] => i;",
			"  string this[string s] => s;",
			"  public static C operator +(C a, C b) => a;",
			"  public static C operator +(C a, int b) => a;",
			"  public static implicit operator int(C c) => 0;",
			"  public static explicit operator long(C c) => 0;",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const members = facts.declarations.filter((item) => item.kind === "property" || item.kind === "operator");
		expect(members.map((item) => [item.name, item.languageKind])).toEqual([
			["this", "property"],
			["this", "property"],
			["operator+", "operator"],
			["operator+", "operator"],
			["operator int", "conversionOperator"],
			["operator long", "conversionOperator"],
		]);
		expect(new Set(facts.declarations.map((item) => item.symbolId)).size).toBe(facts.declarations.length);
	});

	it("names every generic type, a delegate too, by its arity, keeps a partial type's second part apart, and binds across the parts", () => {
		const text = [
			"partial class P { int a; }",
			"partial class P { void M() { a = 1; this.a = 2; } }",
			"class G { }",
			"class G<T> { }",
			"class U : P { G plain; G<int> generic; D d; D<int> e; }",
			"class Pair<K, V> { }",
			"delegate void D();",
			"delegate void D<T>(T value);",
		].join("\n");
		const { facts } = parse(text);
		const types = facts.declarations.filter((item) => item.kind === "class" || item.languageKind === "delegate");
		expect(types.map((item) => parseSymbolId(item.symbolId)?.descriptors.at(-1))).toEqual([
			{ kind: "type", name: "P" },
			{ kind: "type", name: "P", occurrence: 2 },
			{ kind: "type", name: "G" },
			{ kind: "type", name: "G", disambiguator: "1" },
			{ kind: "type", name: "U" },
			{ kind: "type", name: "Pair", disambiguator: "2" },
			{ kind: "type", name: "D" },
			{ kind: "type", name: "D", disambiguator: "1" },
		]);
		// A delegate's parameters follow its type id.
		const value = one(
			facts.declarations.filter((item) => item.name === "value"),
			"delegate parameter missing",
		);
		expect(parseSymbolId(value.symbolId)?.descriptors).toEqual([
			{ kind: "type", name: "D", disambiguator: "1" },
			{ kind: "parameter", name: "value" },
		]);
		// One partial type is named by its first part; type arguments pick the generic namesake.
		expect(
			facts.references
				.filter((item) => ["P", "G", "D"].includes(item.name))
				.map((item) =>
					item.binding.status === "bound"
						? parseSymbolId(item.binding.symbolId)?.descriptors.at(-1)
						: item.binding,
				),
		).toEqual([
			{ kind: "type", name: "P" },
			{ kind: "type", name: "G" },
			{ kind: "type", name: "G", disambiguator: "1" },
			{ kind: "type", name: "D" },
			{ kind: "type", name: "D", disambiguator: "1" },
		]);
		const field = one(
			facts.declarations.filter((item) => item.name === "a"),
			"field a missing",
		).symbolId;
		expect(facts.references.filter((item) => item.name === "a").map((item) => item.binding)).toEqual([
			{ status: "bound", symbolId: field, provenance: "bound" },
			{ status: "bound", symbolId: field, provenance: "bound" },
		]);
	});

	it("declares tuple-typed members, locals, delegates and conversions", () => {
		const text = [
			"public class C {",
			"(int count, Customer customer) value;",
			"(int, int)[] pairs = null;",
			"public (int, int)? Pair { get; }",
			"public (int count, Customer customer) Get() {",
			"  (int count, Customer customer) local = default;",
			"  Touch(local);",
			"  (int, string) other;",
			"  return local;",
			"}",
			"Dictionary<int, List<(int id, Customer row)>> rows;",
			"int IPair<(int left, int right)>.Sum() => 0;",
			"public static implicit operator (int, int)(C c) => default;",
			"}",
			"delegate (int, int) Pairing();",
		].join("\n");
		const { provider, facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.map((item) => `${item.kind}:${item.name}`)).toEqual([
			"class:C",
			"field:value",
			"field:pairs",
			"property:Pair",
			"method:Get",
			"variable:local",
			"variable:other",
			"field:rows",
			"method:Sum",
			"operator:operator(int,int)",
			"variable:c",
			"function:Pairing",
		]);
		const display = (name: string) =>
			provider.typeOf({
				symbolId: one(
					facts.declarations.filter((item) => item.name === name),
					`${name} missing`,
				).symbolId,
			});
		expect(display("value")).toEqual({
			status: "known",
			display: "(int count, Customer customer)",
			provenance: "declared",
		});
		expect(display("pairs")).toMatchObject({ display: "(int, int)[]" });
		expect(display("Pair")).toMatchObject({ display: "(int, int)?" });
		expect(display("Get")).toMatchObject({ display: "(int count, Customer customer)" });
		expect(display("local")).toMatchObject({ display: "(int count, Customer customer)" });
		expect(display("operator(int,int)")).toMatchObject({ display: "(int, int)" });
		expect(display("Pairing")).toMatchObject({ display: "(int, int)" });
		// Element names are not references.
		const names = ["count", "customer", "id", "row", "left", "right"];
		expect(facts.references.filter((item) => names.includes(item.name))).toEqual([]);
		expect(facts.references.filter((item) => item.name === "Customer").map((item) => item.role)).toEqual([
			"typeUse",
			"typeUse",
			"typeUse",
			"typeUse",
		]);
	});

	it("declares every local a body writes, however it is spelled", () => {
		const text = [
			"class C {",
			"  void M(object o, int[] xs) {",
			"    int[] counts = new int[3];",
			"    int a = 1, b;",
			"    int c = 2;",
			"    if (o != null) { }",
			"    global::System.String g = null;",
			"    var (d, (e, _)) = (1, (2, 3));",
			"    (var f, int h) = (1, 2);",
			"    (a, b) = (b, a);",
			"    for (int i = 0, j = 1; i < j; i++) { }",
			"    foreach (var (k, v) in pairs) { }",
			"    using (var stream = Open()) { }",
			"    await using var scoped = Open();",
			"    try { } catch (Exception ex) when (ex is IOException io) { }",
			"    if (o is string { Length: > 0 } s && Parse(out var parsed, out _)) { }",
			"    var area = o switch { Circle { Radius: var r } => r, [var first, ..] => first, _ => 0 };",
			"    switch (o) { case int n when n > 0: const int limit = 2; break; }",
			"    static int Local<T>(int m) where T : new() => m;",
			"  }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		const body = facts.declarations.slice(facts.declarations.findIndex((item) => item.name === "xs") + 1);
		expect(body.map((item) => `${item.languageKind}:${item.name}`)).toEqual([
			"local:counts",
			"local:a",
			"local:b",
			"local:c",
			"local:g",
			"local:d",
			"local:e",
			"local:f",
			"local:h",
			"local:i",
			"local:j",
			"local:k",
			"local:v",
			"local:stream",
			"local:scoped",
			"local:ex",
			"local:io",
			"local:s",
			"local:parsed",
			"local:area",
			"local:r",
			"local:first",
			"local:n",
			"local:limit",
			"localFunction:Local",
			"typeParameter:T",
			"parameter:m",
		]);
		expect(
			body.every((item) => item.visibility === "local" && parseSymbolId(item.symbolId)?.local !== undefined),
		).toBe(true);
		expect(body.find((item) => item.name === "b")?.signature).toBe("int b");
		expect(body.find((item) => item.name === "e")?.signature).toBe("var e");
		const types = facts.references.filter((item) => item.role === "typeUse").map((item) => item.name);
		expect(types).toEqual(["System", "String", "Exception", "IOException", "Circle", "T"]);
	});

	it("scopes lambda parameters, query variables and block locals, so each use binds its own", () => {
		const text = [
			"class C {",
			"  void M(int[] xs) {",
			"    var a = xs.Where(x => x > 1).Select((int x) => x * 2);",
			"    var q = from x in xs let y = x * 2 orderby y, x select y into z select x;",
			"    foreach (var item in item) { Use(item); }",
			"    foreach (var item in xs) { Use(item); }",
			"    if (!(xs is int[] leak)) return;",
			"    Use(leak);",
			"    { int block = 0; }block = 1;",
			"    var g = from p in xs join k in xs on p equals k into grp select k;",
			"    int value = 1; Use(value);",
			"    Func<int, int> f = value => value;",
			"    unsafe { fixed (char* pinned = text) { Use(pinned); } }",
			"    var s = from src in src select src;",
			"    var j = from p in xs join key in xs on key equals key let late = late + key select late;",
			"    void Local(int arg){}arg = 1;",
			"  }",
			"  int[] item;",
			"  int value;",
			"  int[] src;",
			"  int key, late, arg;",
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		const at = (symbolId: string | undefined) => {
			const found = facts.declarations.find((item) => item.symbolId === symbolId);
			const start = found?.selectionRange?.start;
			return start === undefined ? "none" : `${found?.languageKind}@${start.line}:${start.character}`;
		};
		const binds = (name: string) =>
			facts.references
				.filter((item) => item.name === name)
				.map((item) => (item.binding.status === "bound" ? at(item.binding.symbolId) : item.binding.status));
		expect(binds("x")).toEqual([
			"lambdaParameter@2:21",
			"lambdaParameter@2:45",
			"rangeVariable@3:17",
			"rangeVariable@3:17",
			"unbound",
		]);
		expect(binds("y")).toEqual(["rangeVariable@3:29", "rangeVariable@3:29"]);
		expect(binds("item")).toEqual(["field@17:8", "local@4:17", "local@5:17"]);
		expect(binds("leak")).toEqual(["local@6:22"]);
		expect(binds("block")).toEqual(["unbound"]);
		expect(binds("k")).toEqual(["rangeVariable@9:30", "unbound"]);
		expect(binds("value")).toEqual(["local@10:8", "lambdaParameter@11:23"]);
		expect(binds("pinned")).toEqual(["local@12:26"]);
		// A range variable is out of scope in its own source or initializer; a join's in its outer key.
		expect(binds("src")).toEqual(["field@19:8", "rangeVariable@13:17"]);
		expect(binds("key")).toEqual(["field@20:6", "rangeVariable@14:30", "rangeVariable@14:30"]);
		expect(binds("late")).toEqual(["field@20:11", "rangeVariable@14:62"]);
		// A use right after a local function's body is past it.
		expect(binds("arg")).toEqual(["field@20:17"]);
		expect(facts.references.map((item) => item.name)).not.toContain("orderby");
	});

	it("reads a function pointer's calling convention inside its type", () => {
		const { facts } = parse(
			"unsafe class C { void M(delegate* unmanaged[Cdecl]<int, void> callback, int* data) { } }",
		);
		expect(facts.declarations.filter((item) => item.languageKind === "parameter").map((item) => item.name)).toEqual(
			["callback", "data"],
		);
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
		startProvider(provider, root);
		const text =
			"using Alias = N.C; using static N.C; public class Use { public Alias Field; public int Read() { return Value; } }\n";
		const facts = parseThroughKit(provider, { module: "src/use.cs", contentHash: "hash", text });
		// One landing per specifier: the static's, where the alias's name reads unknown, never wrong.
		expect(provider.resolveImport({ fromModule: "src/use.cs", specifier: "N.C" })).toEqual({
			status: "resolved",
			landing: {
				kind: "symbolScope",
				providerId: "csharp-provider",
				scopeId: "N.C",
				anchorSymbolId: "lexicon csharp src/types.cs N/C#",
			},
		});
		const alias = facts.references.find((item) => item.name === "Alias" && item.role === "typeUse");
		if (alias === undefined) throw new Error("alias reference missing");
		expect(alias.binding.status).toBe("bound");
		expect(facts.imports.map((item) => item.specifier)).toEqual(["N.C", "N.C"]);
	});

	it("reads a using directive in a namespace block only inside that block and the blocks it holds, relative to it", () => {
		const text = [
			"namespace Lib.One { public class Thing { } public static class Tools { public static void Go() { } } }",
			"namespace Lib.Two { public class Thing { } }",
			"namespace App {",
			"  using Lib.One;",
			"  using static Lib.One.Tools;",
			"  class A { Thing t; void M() { Go(); } }",
			"}",
			"namespace App {",
			"  using Lib.Two;",
			"  using Alias = Lib.One.Thing;",
			"  class B { Thing t; Alias a; void M() { Go(); } }",
			"  namespace Inner { class C { Thing t; } }",
			"}",
			"namespace Other { class D { Thing t; Alias a; } }",
			"namespace Lib { using One; class E { Thing t; } }",
		].join("\n");
		const { facts } = parse(text);
		const path = (symbolId: string) =>
			parseSymbolId(symbolId)
				?.descriptors.map((item) => item.name)
				.join(".");
		expect(
			facts.references
				.filter((item) => item.role !== "import")
				.map((item) => [
					item.range.start.line,
					item.name,
					item.binding.status === "bound" ? path(item.binding.symbolId) : item.binding.status,
				]),
		).toEqual([
			[5, "Thing", "Lib.One.Thing"],
			[5, "Go", "Lib.One.Tools.Go"],
			[10, "Thing", "Lib.Two.Thing"],
			[10, "Alias", "Lib.One.Thing"],
			[10, "Go", "unbound"],
			[11, "Thing", "Lib.Two.Thing"],
			[13, "Thing", "unbound"],
			[13, "Alias", "unbound"],
			[14, "Thing", "Lib.One.Thing"],
		]);
		// `using One;` inside `namespace Lib` names `Lib.One`.
		expect(facts.references.find((item) => item.name === "One")?.binding).toMatchObject({ status: "bound" });
	});

	it("imports an alias target's name without its type arguments, and nothing for a tuple or pointer", () => {
		const text = [
			"using Map = System.Collections.Generic.Dictionary<string, int>;",
			"using global::System.Text;",
			"using Point = (int X, int Y);",
			"using Handle = int*;",
			"class C { }",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.imports.map((item) => item.specifier)).toEqual([
			"System.Collections.Generic.Dictionary",
			"System.Text",
		]);
		expect(facts.references.map((item) => item.name)).toEqual([
			"System.Collections.Generic.Dictionary",
			"System.Text",
		]);
	});

	it("binds a member access through its receiver: this, base or a type's name, never a value", () => {
		const text = [
			"class B { public int P; public void Run() {} }",
			"class C : B {",
			"  new public int P;",
			"  void M(System.Action F, B other) {",
			"    F();",
			"    base.P = 1;",
			"    this.P = 2;",
			"    base.Run();",
			"    this.Run();",
			"    other.P = 3;",
			"    C.Make();",
			"    Make().P = 4;",
			"  }",
			"  void F() {}",
			"  static C Make() => null;",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const names = new Map(facts.declarations.map((item) => [item.symbolId, item]));
		const target = (symbolId: string) => {
			const found = names.get(symbolId);
			return `${names.get(found?.containerId ?? "")?.name}.${found?.name}:${found?.languageKind}`;
		};
		const bindings = facts.references
			.filter((item) => ["F", "P", "Run", "Make"].includes(item.name))
			.map((item) => [
				item.range.start.line,
				item.name,
				item.binding.status === "bound" ? target(item.binding.symbolId) : item.binding.status,
			]);
		expect(bindings).toEqual([
			[4, "F", "M.F:parameter"],
			[5, "P", "B.P:field"],
			[6, "P", "C.P:field"],
			[7, "Run", "B.Run:method"],
			[8, "Run", "B.Run:method"],
			[9, "P", "unbound"],
			[10, "Make", "C.Make:method"],
			[11, "Make", "C.Make:method"],
			[11, "P", "unbound"],
		]);
	});

	it("reads a receiver value of its own type as the type, whatever comment stands in the type's name", () => {
		const text = [
			"namespace Lib {",
			"  public class Color { public static void Paint() {} }",
			"  class Plain { Lib./*<?[*/Color Color; void M() { Color.Paint(); } }",
			"  class Nullable { Color? Color; void M() { Color.Paint(); } }",
			"  class Listed { Color[] Color; void M() { Color.Paint(); } }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(
			facts.references
				.filter((item) => item.name === "Paint")
				.map((item) => [
					item.range.start.line,
					item.binding.status === "unbound" ? item.binding.reason : item.binding.status,
				]),
		).toEqual([
			[2, "bound"],
			[3, "NotImplemented"],
			[4, "NotImplemented"],
		]);
	});

	it("binds a type in the current namespace without an import, and a type parameter only inside its declaration", () => {
		const text = [
			"namespace N { public class Item {} public class Use { public Item Make() { return new Item(); } } }",
			"namespace N { class T {} class Box<T> { T Item; U Get<U>(T t) => default; } class List<T> { T Head; } class Plain { T Other; } }",
		].join("\n");
		const { facts } = parse(text);
		const uses = facts.references.filter((item) => item.name === "Item");
		expect(uses.some((item) => item.role === "instantiate" && item.binding.status === "bound")).toBe(true);
		const owner = (symbolId: string) => {
			const found = facts.declarations.find((item) => item.symbolId === symbolId);
			const container = facts.declarations.find((item) => item.symbolId === found?.containerId);
			return `${found?.kind}:${container?.name ?? ""}`;
		};
		const bindings = facts.references
			.filter((item) => item.name === "T" || item.name === "U")
			.map((item) => (item.binding.status === "bound" ? owner(item.binding.symbolId) : item.binding.status));
		expect(bindings).toEqual([
			"typeParameter:Box",
			"typeParameter:Get",
			"typeParameter:Box",
			"typeParameter:List",
			"class:N",
		]);
	});

	it("reads a base list without its type's members and attributes with them, a nested type before a namespace's", () => {
		const text = [
			"namespace N {",
			"  class File { }",
			"  class Nested { }",
			"  class Base<X> { public class Inherited { } }",
			"  [Marker(typeof(Nested))]",
			"  class C : Base<Nested> {",
			"    class Nested { }",
			"    class File { }",
			"    File file; Inherited inherited; X x;",
			"  }",
			"  class D : N.Base<int> { }",
			"  class MarkerAttribute : System.Attribute { public MarkerAttribute(System.Type type) { } }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const path = (symbolId: string) =>
			parseSymbolId(symbolId)
				?.descriptors.map((item) => item.name)
				.join(".");
		expect(
			facts.references
				.filter((item) => item.range.start.line >= 4 && item.range.start.line <= 10)
				.map((item) => [
					item.name,
					item.role,
					item.binding.status === "bound" ? path(item.binding.symbolId) : item.binding.status,
				]),
		).toEqual([
			["Marker", "typeUse", "N.MarkerAttribute"],
			["Nested", "typeUse", "N.C.Nested"],
			["Base", "extends", "N.Base"],
			["Nested", "typeUse", "N.Nested"],
			["File", "typeUse", "N.C.File"],
			["Inherited", "typeUse", "N.Base.Inherited"],
			["X", "typeUse", "unbound"],
			["N", "typeUse", "unbound"],
			["Base", "extends", "N.Base"],
		]);
	});

	it("reads a cycle through nested base lists, which C# refuses, without looping", () => {
		const text = [
			"namespace N {",
			"  class E : E.T.B1 {",
			"    class T : X {",
			"      class B1 : Y { }",
			"    }",
			"  }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(
			facts.references.filter((item) => item.role === "extends").map((item) => [item.name, item.binding.status]),
		).toEqual([
			["B1", "bound"],
			["X", "unbound"],
			["Y", "unbound"],
		]);
	});

	it("binds a type name only to a type of exactly its arity, and merges partial parts of one identity only", () => {
		const text = [
			"namespace A { class G<T> { } class Use { G none; G<int, string> two; G<int> one; } }",
			"namespace B {",
			"  class Outer { public partial class Inner { void Use() { Extra(); } } }",
			"  class Outer<T> { public partial class Inner { void Extra() { } } }",
			"}",
			"namespace C { partial class P<T> { void M() { Other(); } } partial class P<T, U> { void Other() { } } }",
		].join("\n");
		const { facts } = parse(text);
		expect(
			facts.references.map((item) => [
				item.name,
				item.binding.status === "bound"
					? parseSymbolId(item.binding.symbolId)?.descriptors.at(-1)
					: item.binding.status,
			]),
		).toEqual([
			["G", "unbound"],
			["G", "unbound"],
			["G", { kind: "type", name: "G", disambiguator: "1" }],
			["Extra", "unbound"],
			["Other", "unbound"],
		]);
	});

	it("reads a class's first base as the class it extends only when it is one, and inherits from classes alone", () => {
		const text = [
			"interface I { void M() { } }",
			"class Base { }",
			"class C : I { void Call() { this.M(); M(); } }",
			"class D : Base, I { }",
			"class E : Unknown, I { }",
		].join("\n");
		const { facts } = parse(text);
		expect(
			facts.references.map((item) => [
				item.name,
				item.role,
				item.binding.status === "bound" ? "bound" : "unbound",
			]),
		).toEqual([
			["I", "implements", "bound"],
			["M", "call", "unbound"],
			["M", "call", "unbound"],
			["Base", "extends", "bound"],
			["I", "implements", "bound"],
			["Unknown", "extends", "unbound"],
			["I", "implements", "bound"],
		]);
	});

	it("reads a receiver through its type arguments, and a type's name as a receiver binds the type", () => {
		const text = [
			"class Outer<T> { public class Inner { public static void Go() { } } }",
			"class Color { public static void Paint() { } }",
			"class Use { Outer<int>.Inner value; void M() { Color.Paint(); Outer<int>.Inner.Go(); } }",
		].join("\n");
		const { facts } = parse(text);
		const names = new Map(facts.declarations.map((item) => [item.symbolId, item.name]));
		expect(
			facts.references.map((item) => [
				item.name,
				item.role,
				item.binding.status === "bound" ? names.get(item.binding.symbolId) : item.binding.status,
			]),
		).toEqual([
			["Outer", "typeUse", "Outer"],
			["Inner", "typeUse", "Inner"],
			["Color", "read", "Color"],
			["Paint", "call", "Paint"],
			["Outer", "read", "Outer"],
			["Inner", "read", "Inner"],
			["Go", "call", "Go"],
		]);
	});

	it("reads a long member chain with work linear in its length", () => {
		const work = (count: number) => {
			const text = `class C { void M() { root${".a".repeat(count)}; } }\n`;
			const meter = { steps: 0 };
			new CsharpParser("main.cs", text, false, [], meter).parse();
			return meter.steps;
		};
		// Rescanning the chain head for each name is quadratic.
		const small = work(1_000);
		const large = work(8_000);
		expect(large / small).toBeLessThan(12);
	});

	it("counts nested type argument lists in one walk, lists `>>` closes among them", () => {
		const timed = (depth: number) => {
			const type = `H<${"G<".repeat(depth)}int${">".repeat(depth)}, int>`;
			const text = `class G<T> { } class H<A, B> { } class U { ${type} f; }\n`;
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				const { facts } = parse(text);
				best = Math.min(best, performance.now() - started);
				const bound = facts.references.map((item) =>
					item.binding.status === "bound" ? item.binding.symbolId : item.binding.status,
				);
				expect(bound).toHaveLength(depth + 1);
				expect(new Set(bound)).toEqual(
					new Set(["lexicon csharp main.cs H(2)#", "lexicon csharp main.cs G(1)#"]),
				);
			}
			return best;
		};
		// An odd depth leaves one `>` past the `>>` pairs. One walk scales 8x; a walk per list scales 64x.
		expect(timed(8_001) / timed(1_001)).toBeLessThan(16);
	});

	it("looks a type up among many using directives with work linear in them", () => {
		const work = (count: number) => {
			const numbered = (write: (index: number) => string) =>
				Array.from({ length: count }, (_, index) => write(index));
			const types = numbered((index) => `namespace N${index} { public class T${index} { } }`).join("\n");
			const usings = numbered((index) => `using N${index};`).join("\n");
			const text = `${usings}\nclass Use { ${numbered((index) => `T${index} f${index};`).join(" ")} }\n`;
			const root = makeWorkspace({ "types.cs": types, "use.cs": text });
			const meter = { steps: 0 };
			const provider = new CsharpProvider(meter);
			startProvider(provider, root);
			parseThroughKit(provider, { module: "types.cs", contentHash: "types", text: types });
			meter.steps = 0;
			const facts = parseThroughKit(provider, { module: "use.cs", contentHash: "use", text });
			const uses = facts.references.filter((item) => item.role === "typeUse");
			expect(uses.filter((item) => item.binding.status === "bound")).toHaveLength(count);
			return meter.steps;
		};
		// Scanning every imported type for every name is quadratic.
		const small = work(100);
		const large = work(800);
		expect(large / small).toBeLessThan(12);
	});

	it("reads a name after `alias::` in the namespace the using alias names, never through a namesake", () => {
		const text = [
			"namespace N { public class C { public static void M() { } } }",
			"namespace B { public class C { public static void M() { } } }",
			"namespace E.N { public class C { } }",
			"namespace Use {",
			"  using A = N;",
			"  using Z = E::N.C;",
			"  class C { public static void M() { } }",
			"  class X { int A; A::C field; Z zed; void F() { A::C.M(); B::C.M(); var made = new A::C(); } }",
			"  class Y { class A { public class C { } } A::C nested; }",
			"}",
		].join("\n");
		const { provider, facts } = parse(text);
		const on = (line: number) =>
			facts.references
				.filter((item) => item.range.start.line === line)
				.map((item) => [
					item.name,
					item.binding.status === "bound" ? item.binding.symbolId : item.binding.status,
				]);
		const c = "lexicon csharp main.cs N/C#";
		// No using alias `B`: an extern alias's, which names nothing here; nor does `E::` in a directive.
		expect(on(7)).toEqual([
			["C", c],
			["Z", "unbound"],
			["C", c],
			["M", `${c}M().`],
			["C", "unbound"],
			["M", "unbound"],
			["C", c],
		]);
		expect(on(8)).toEqual([["C", c]]);
		const nested = one(
			facts.declarations.filter((item) => item.name === "nested"),
			"nested missing",
		);
		expect(provider.typeOf({ symbolId: nested.symbolId })).toMatchObject({ status: "known", symbolId: c });
	});

	it("keeps a global using alias out of the references, as any alias", () => {
		const text = ["global using Alias = N.C;", "namespace N { class C { } }", "class Use { Alias value; }"].join(
			"\n",
		);
		const { facts } = parse(text);
		expect(facts.references.map((item) => [item.name, item.role])).toEqual([
			["N.C", "import"],
			["Alias", "typeUse"],
		]);
	});

	it("binds a member of a partial type's part in another file, never a namesake type's in another namespace", () => {
		const root = makeWorkspace({
			"a.cs": "namespace N { public partial class C { public void Use() { Other(); } } }\n",
			"b.cs": "namespace N { public partial class C { public void Other() {} } }\n",
			"c.cs": "namespace M { public partial class C { public void Other() {} } }\n",
		});
		const provider = new CsharpProvider();
		startProvider(provider, root);
		const facts = parseThroughKit(provider, {
			module: "a.cs",
			contentHash: "hash",
			text: "namespace N { public partial class C { public void Use() { Other(); } } }\n",
		});
		const reference = one(
			facts.references.filter((item) => item.name === "Other"),
			"Other missing",
		);
		expect(reference.binding).toEqual({
			status: "bound",
			symbolId: "lexicon csharp b.cs N/C#Other().",
			provenance: "bound",
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

	it("infers a literal's own type: its suffix, or the first integer type its value fits", () => {
		const text = [
			"public class C { void Run() {",
			"var mask = 0x1F; var high = 0xE0; var bits = 0b1; var big = 3000000000; var huge = 0x8000000000000000;",
			"var unsigned = 1u; var wide = 5000000000u; var ulongs = 1UL; var longs = 1L; var real = 1d;",
			'var money = 1.5m; var single = .5f; var letter = \'c\'; var bytes = "x"u8; var text = $"{mask}";',
			"} }",
		].join("\n");
		const { provider, facts } = parse(text);
		const names = ["mask", "high", "bits", "big", "huge", "unsigned", "wide", "ulongs", "longs", "real"];
		const inferred = [...names, "money", "single", "letter", "bytes", "text"].map((name) => {
			const local = one(
				facts.declarations.filter((item) => item.name === name),
				`${name} missing`,
			);
			return provider.typeOf({ symbolId: local.symbolId });
		});

		expect(inferred.map((item) => (item.status === "inferred" ? item.display : item.status))).toEqual([
			"int",
			"int",
			"int",
			"uint",
			"ulong",
			"uint",
			"ulong",
			"ulong",
			"long",
			"double",
			"decimal",
			"float",
			"char",
			"ReadOnlySpan<byte>",
			"string",
		]);
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

	it("reads a declared type and its name from the type's own tokens", () => {
		const text = [
			"interface IFoo { int Bar { get; } }",
			"class Outer<T> { public class Inner {} }",
			"class C : IFoo {",
			"Outer<int>.Inner field1;",
			"global::Outer<int>.Inner field2;",
			"int[] numbers;",
			"int IFoo.Bar => 0;",
			"public static C operator +(C a, C b) => a;",
			"void Extend(this C self, params Outer<int>.Inner[] rest) {}",
			"public Outer<int>.Inner Property { get; }",
			"}",
		].join("\n");
		const { provider, facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		// The last, so `Bar` is the explicit implementation.
		const declared = (name: string) =>
			one(facts.declarations.filter((item) => item.name === name).toReversed(), `${name} missing`);
		const typeOf = (name: string) => provider.typeOf({ symbolId: declared(name).symbolId });
		const inner = declared("Inner").symbolId;
		const c = declared("C").symbolId;
		expect(facts.declarations.filter((item) => item.kind === "field").map((item) => item.name)).toEqual([
			"field1",
			"field2",
			"numbers",
		]);
		expect(typeOf("field1")).toMatchObject({ display: "Outer<int>.Inner", symbolId: inner });
		expect(typeOf("field2")).toMatchObject({ display: "global::Outer<int>.Inner", symbolId: inner });
		expect(typeOf("numbers")).toEqual({ status: "known", display: "int[]", provenance: "declared" });
		expect(typeOf("Bar")).toEqual({ status: "known", display: "int", provenance: "declared" });
		expect(typeOf("operator+")).toMatchObject({ display: "C", symbolId: c });
		expect(typeOf("self")).toMatchObject({ display: "C", symbolId: c });
		expect(typeOf("rest")).toMatchObject({ display: "Outer<int>.Inner[]", symbolId: inner });
		expect(typeOf("Property")).toMatchObject({ display: "Outer<int>.Inner", symbolId: inner });
	});

	it("resolves an annotated workspace type to its declaration", () => {
		const root = makeWorkspace({
			"src/item.cs": "namespace N { public class Item {} }\n",
			"src/use.cs": "using N; public class Use { public Item Value; }\n",
		});
		const provider = new CsharpProvider();
		startProvider(provider, root);
		const facts = parseThroughKit(provider, {
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

	it("marks only the last segment of a qualified new expression as instantiate", () => {
		const text = [
			"namespace N {",
			"    public class Simple { }",
			"    public class Generic<T> { }",
			"    public class Holder {",
			"        public void Run() {",
			"            var a = new N.Simple();",
			"            var b = new global::N.Simple();",
			"            var c = new N.Generic<N.Simple>();",
			"        }",
			"    }",
			"}",
			"",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		const roleOf = (name: string, line: number): string | undefined =>
			facts.references.find((item) => item.name === name && item.range.start.line === line)?.role;
		// `new N.Simple()`: N is the qualifier, Simple is the instantiated type.
		expect(roleOf("N", 5)).toBe("read");
		expect(roleOf("Simple", 5)).toBe("instantiate");
		// `new global::N.Simple()`: global is never reported, N is still the qualifier.
		expect(facts.references.some((item) => item.name === "global")).toBe(false);
		expect(roleOf("N", 6)).toBe("read");
		expect(roleOf("Simple", 6)).toBe("instantiate");
		// `new N.Generic<N.Simple>()`: Generic is instantiated; the generic argument reads as it already did.
		expect(roleOf("N", 7)).toBe("read");
		expect(roleOf("Generic", 7)).toBe("instantiate");
		const line7 = facts.references
			.filter((item) => item.range.start.line === 7)
			.map((item) => [item.name, item.role]);
		expect(line7).toEqual([
			["N", "read"],
			["Generic", "instantiate"],
			["N", "read"],
			["Simple", "read"],
		]);
	});

	it("marks a qualified new's last segment instantiate before an initializer or an array creation too", () => {
		const text = [
			"namespace N {",
			"    public class Simple { public int X; }",
			"    public class Holder {",
			"        public void Run() {",
			"            var a = new N.Simple { X = 1 };",
			"            var b = new N.Simple[5];",
			"        }",
			"    }",
			"}",
			"",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		const roleOf = (name: string, line: number): string | undefined =>
			facts.references.find((item) => item.name === name && item.range.start.line === line)?.role;
		// `new N.Simple { X = 1 }`: an object initializer, no parentheses.
		expect(roleOf("N", 4)).toBe("read");
		expect(roleOf("Simple", 4)).toBe("instantiate");
		// `new N.Simple[5]`: an array creation.
		expect(roleOf("N", 5)).toBe("read");
		expect(roleOf("Simple", 5)).toBe("instantiate");
	});

	it("marks a name right of a member operator or qualifier as qualified", () => {
		const text = [
			"using Alias = System.Text;",
			"namespace N {",
			"[System.Serializable]",
			"class C : Base.Inner {",
			"  int count;",
			"  void Run(C other) {",
			"    count = other.count;",
			"    this.count = other?.count ?? 0;",
			"    base.Run(other);",
			"    Run(null);",
			"    System.Console.WriteLine(Alias.Encoding);",
			"    var c = new global::N.C { count = 1 };",
			"    unsafe { P* p = null; p->X = 1; }",
			"    other",
			"      // trailing",
			"      .Run(x..y);",
			"    Ext::Type t = null;",
			"  }",
			"}",
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		for (const reference of facts.references) expect(typeof reference.qualified).toBe("boolean");
		const onLine = (line: number): Array<[string, boolean | undefined]> =>
			facts.references
				.filter((item) => item.range.start.line === line)
				.map((item) => [item.name, item.qualified]);
		// Import binding.
		expect(onLine(0)).toEqual([["System.Text", false]]);
		expect(onLine(2)).toEqual([
			["System", false],
			["Serializable", true],
		]);
		expect(onLine(3)).toEqual([
			["Base", false],
			["Inner", true],
		]);
		// Implicit member access stays unqualified.
		expect(onLine(6)).toEqual([
			["count", false],
			["other", false],
			["count", true],
		]);
		expect(onLine(7)).toEqual([
			["count", true],
			["other", false],
			["count", true],
		]);
		expect(onLine(8)).toEqual([
			["Run", true],
			["other", false],
		]);
		expect(onLine(9)).toEqual([["Run", false]]);
		expect(onLine(10)).toEqual([
			["System", false],
			["Console", true],
			["WriteLine", true],
			["Alias", false],
			["Encoding", true],
		]);
		expect(onLine(11).filter(([name]) => name !== "c")).toEqual([
			["N", true],
			["C", true],
			["count", false],
		]);
		expect(onLine(12).filter(([name]) => name === "X")).toEqual([["X", true]]);
		expect(onLine(15)).toEqual([
			["Run", true],
			["x", false],
			["y", false],
		]);
		// The alias left of `::` names nothing.
		expect(onLine(16).filter(([name]) => name !== "t")).toEqual([["Type", true]]);
	});

	it("reports nesting past the limit as a problem, never a stack overflow", () => {
		const deep = 3000;
		for (const text of [
			`class C { void M() { ${"{".repeat(deep)}${"}".repeat(deep)} } }`,
			`class C { void M() { var f = ${"x => ".repeat(deep)}1; } }`,
			`class C { void M() { var b = o is ${"{ A: ".repeat(deep)}1${" }".repeat(deep)}; } }`,
			`class C { string s = ${'$"{'.repeat(deep)}1${'}"'.repeat(deep)}; }`,
		]) {
			const { facts } = parse(text);
			expect(facts.diagnostics.some((item) => item.severity === "error")).toBe(true);
		}
		const chain = parse(`class C { void M() { if (a) F(); ${"else if (a) F(); ".repeat(deep)} } }`).facts;
		expect(chain.diagnostics).toEqual([]);
	});

	it.each([
		["expression lambdas", 900, "x => ", "", "x => 1"],
		["block lambdas", 480, "() => { F(", ") }", "() => { F(); }"],
	])("walks %s nested as fast as side by side", (_label, count, open, close, sibling) => {
		const timed = (statement: string) => {
			const text = `class C { void M() { ${statement.repeat(20)} } }`;
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				expect(parse(text).facts.diagnostics).toEqual([]);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		const nested = timed(`F(${open.repeat(count)}1${close.repeat(count)});`);
		const flat = timed(`F(${Array.from({ length: count }, () => sibling).join(", ")});`);
		// Near 1 when each level is walked once; a walk to the statement's end per level read 2.4 to 3.3.
		expect(nested / flat).toBeLessThan(2);
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
			"#define FEATURE",
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

	it("treats a leading byte order mark as trivia, not an unrecognized member", () => {
		const text = `\uFEFF${["namespace N {", "public class C {", "[Marker()]", "public C() { }", "}", "}", ""].join(
			"\n",
		)}`;
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.map((item) => [item.kind, item.name])).toEqual([
			["namespace", "N"],
			["class", "C"],
			["constructor", "C"],
		]);
		const ctor = one(
			facts.declarations.filter((item) => item.kind === "constructor"),
			"constructor is not declared",
		);
		const marker = one(
			facts.references.filter((item) => item.name === "Marker"),
			"Marker is not referenced",
		);
		expect(marker.role).toBe("typeUse");
		expect(marker.fromId).toBe(ctor.symbolId);
	});

	it("rejects an invalid workspace root through the project model", () => {
		const model = new CsharpProvider().discoverProject(
			path.join(tmpdir(), "does-not-exist-csharp-root"),
			undefined,
		).model;
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
