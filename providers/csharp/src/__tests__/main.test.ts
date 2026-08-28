import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	BindingSchema,
	composeSymbolId,
	type Declaration,
	FileFactsSchema,
	handlersFor,
	PROVIDER_METHODS,
	TypeInfoSchema,
} from "@nyaa-lexicon/protocol";
import { CsharpProvider, REFERENCE_ROLES, TIERS } from "../main.js";
import { CsharpParser } from "../parser.js";

it("uses qualifier and parameter descriptors", () => {
	const text = "class C { void IFoo.Bar(int name) {} }\n";
	const facts = new CsharpParser("qualified.cs", text, false).parse();
	const method = facts.declarations.find((declaration) => declaration.name === "Bar");
	const parameter = facts.declarations.find((declaration) => declaration.name === "name");

	expect(method?.symbolId).toBe(
		composeSymbolId({
			language: "csharp",
			module: "qualified.cs",
			descriptors: [
				{ kind: "type", name: "C" },
				{ kind: "namespace", name: "IFoo" },
				{ kind: "method", name: "Bar" },
			],
		}),
	);
	expect(parameter?.symbolId).toBe(
		composeSymbolId({
			language: "csharp",
			module: "qualified.cs",
			descriptors: [
				{ kind: "type", name: "C" },
				{ kind: "namespace", name: "IFoo" },
				{ kind: "method", name: "Bar" },
				{ kind: "parameter", name: "name" },
			],
		}),
	);
	expect(method?.containerId).toBe(
		composeSymbolId({
			language: "csharp",
			module: "qualified.cs",
			descriptors: [{ kind: "type", name: "C" }],
		}),
	);
});

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-csharp-provider-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function declaration(facts: { declarations: Declaration[] }, name: string, kind?: Declaration["kind"]) {
	const found = facts.declarations.find((item) => item.name === name && (kind === undefined || item.kind === kind));
	if (found === undefined) throw new Error(`declaration missing: ${name}`);
	return found;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C# declarations", () => {
	it("extracts namespaces, types, members, parameters, docs, and folded accessors", () => {
		const text = [
			"namespace Demo;",
			"",
			"/// The main type.",
			"public partial class Thing<T> : Base, IThing",
			"{",
			"\tpublic const int Limit = 1;",
			'\tprivate string value = "x";',
			"\tpublic string Name { get; set; }",
			"\tpublic event Action Changed;",
			"\tpublic Thing(int input) { value = input.ToString(); }",
			"\tpublic int Add(int amount) { return amount; }",
			"}",
			"",
			"public interface IThing { void Run(); }",
			"public struct Point { public int X; }",
			"public enum State { Ready, Done = 2 }",
			"public record Record(string Name);",
			"public delegate void Handler(string value);",
		].join("\n");
		const provider = new CsharpProvider();
		provider.initialize("/workspace");
		const facts = provider.parseFile({ module: "demo.cs", contentHash: "hash", text });

		expect(facts.diagnostics).toEqual([]);
		expect(declaration(facts, "Demo", "namespace").languageKind).toBe("fileScopedNamespace");
		const thing = declaration(facts, "Thing", "class");
		expect(thing).toMatchObject({ visibility: "public", exported: true });
		expect(declaration(facts, "Name", "property")).toMatchObject({
			visibility: "public",
			containerId: thing.symbolId,
		});
		expect(facts.declarations.filter((item) => item.name === "get" || item.name === "set")).toHaveLength(0);
		expect(declaration(facts, "Changed", "event")).toMatchObject({ containerId: thing.symbolId });
		expect(declaration(facts, "Thing", "constructor")).toMatchObject({
			containerId: thing.symbolId,
			metrics: { parameters: 1 },
		});
		expect(declaration(facts, "amount", "variable")).toMatchObject({ visibility: "local" });
		expect(declaration(facts, "IThing", "interface")).toMatchObject({ visibility: "public", exported: true });
		expect(declaration(facts, "Point", "struct")).toMatchObject({ visibility: "public", exported: true });
		expect(declaration(facts, "State", "enum")).toMatchObject({ visibility: "public", exported: true });
		expect(declaration(facts, "Record", "class").languageKind).toBe("record");
		expect(declaration(facts, "Handler", "function").languageKind).toBe("delegate");
		FileFactsSchema.parse(facts);
	});

	it("counts astral characters as two UTF-16 code units", () => {
		const text = "/* 😀 */ public class Cart {}\n";
		const facts = new CsharpProvider().parseFile({ module: "cart.cs", contentHash: "hash", text });
		const cart = declaration(facts, "Cart", "class");
		expect(cart.selectionRange?.start).toEqual({ line: 0, character: 22 });
		expect(text.slice(cart.selectionRange?.start.character, cart.selectionRange?.end.character)).toBe("Cart");
	});

	it("keeps declaration ids module-relative and distinguishes method overloads", () => {
		const text = "namespace N { public class C { public void Run() {} public void Run(int value) {} } }";
		const facts = new CsharpProvider().parseFile({ module: "src/c.cs", contentHash: "hash", text });
		const methods = facts.declarations.filter((item) => item.name === "Run" && item.kind === "method");
		expect(methods).toHaveLength(2);
		expect(methods.map((item) => item.symbolId)).toEqual([
			composeSymbolId({
				language: "csharp",
				module: "src/c.cs",
				descriptors: [
					{ kind: "namespace", name: "N" },
					{ kind: "type", name: "C" },
					{ kind: "method", name: "Run" },
				],
			}),
			composeSymbolId({
				language: "csharp",
				module: "src/c.cs",
				descriptors: [
					{ kind: "namespace", name: "N" },
					{ kind: "type", name: "C" },
					{ kind: "method", name: "Run", disambiguator: "1" },
				],
			}),
		]);
	});
});

describe("C# facts", () => {
	it("reports decoded literals with the smallest declaration container", () => {
		const text = [
			"namespace N {",
			"public class Values {",
			"public int Count = 1;",
			'public string Label = "ready\\nnow";',
			"public bool Enabled = true;",
			"public void Run() { var local = 2; }",
			"}",
			"}",
		].join("\n");
		const provider = new CsharpProvider();
		provider.initialize("/workspace");
		const facts = provider.parseFile({ module: "values.cs", contentHash: "hash", text });
		const count = declaration(facts, "Count", "field");
		const label = declaration(facts, "Label", "field");
		const enabled = declaration(facts, "Enabled", "field");
		const local = declaration(facts, "local", "variable");
		expect(facts.literals).toEqual(
			expect.arrayContaining([
				{ kind: "number", value: "1", number: 1, range: expect.any(Object), containerId: count.symbolId },
				{ kind: "string", value: "ready\nnow", range: expect.any(Object), containerId: label.symbolId },
				{ kind: "boolean", value: "true", range: expect.any(Object), containerId: enabled.symbolId },
				{ kind: "number", value: "2", number: 2, range: expect.any(Object), containerId: local.symbolId },
			]),
		);
		expect(provider.typeOf({ symbolId: count.symbolId })).toMatchObject({ status: "known", display: "int" });
		expect(provider.typeOf({ symbolId: local.symbolId })).toMatchObject({ status: "inferred", display: "int" });
		TypeInfoSchema.parse(provider.typeOf({ symbolId: local.symbolId }));
	});

	it("binds same-file calls, fields, and parameters", () => {
		const text = [
			"public class C {",
			"public int Value;",
			"public void Add(int amount) { Value = amount; }",
			"public void Run() { Add(Value); }",
			"}",
		].join("\n");
		const provider = new CsharpProvider();
		provider.initialize("/workspace");
		const facts = provider.parseFile({ module: "c.cs", contentHash: "hash", text });
		const add = declaration(facts, "Add", "method");
		const call = facts.references.find((item) => item.name === "Add" && item.role === "call");
		const valueWrite = facts.references.find((item) => item.name === "Value" && item.role === "write");
		const amountRead = facts.references.find((item) => item.name === "amount" && item.role === "read");
		if (call === undefined || valueWrite === undefined || amountRead === undefined)
			throw new Error("reference missing");
		expect(call.binding).toEqual({ status: "bound", symbolId: add.symbolId, provenance: "bound" });
		expect(valueWrite.binding.status).toBe("bound");
		expect(amountRead.binding.status).toBe("bound");
		expect(provider.bind({ module: "c.cs", name: "Add", range: call.range })).toEqual(call.binding);
		for (const reference of facts.references) BindingSchema.parse(reference.binding);
	});

	it("reports a same-class call named add", () => {
		const text = "public class Cart { public void add() {} public void run() { add(); } }";
		const facts = new CsharpProvider().parseFile({ module: "cart.cs", contentHash: "hash", text });
		const method = declaration(facts, "add", "method");
		const call = facts.references.find((item) => item.name === "add" && item.role === "call");
		if (call === undefined) throw new Error("add call reference missing");
		expect(call.binding).toEqual({ status: "bound", symbolId: method.symbolId, provenance: "bound" });
	});
});

describe("C# workspace resolution", () => {
	it("resolves using namespaces to a workspace file and binds imported types", () => {
		const root = workspace({
			"src/item.cs": "namespace Demo.Items { public class Item {} }\n",
			"src/cart.cs":
				"using Demo.Items; namespace Demo { public class Cart { public Item Make() { return new Item(); } } }\n",
		});
		const provider = new CsharpProvider();
		provider.initialize(root);
		provider.discoverProject(root);
		const text =
			"using Demo.Items; namespace Demo { public class Cart { public Item Make() { return new Item(); } } }\n";
		const facts = provider.parseFile({ module: "src/cart.cs", contentHash: "hash", text });
		expect(provider.resolveImport({ fromModule: "src/cart.cs", specifier: "Demo.Items" })).toEqual({
			status: "resolved",
			module: "src/item.cs",
		});
		const itemUse = facts.references.find((item) => item.name === "Item" && item.role === "instantiate");
		if (itemUse === undefined) throw new Error("imported type reference missing");
		expect(itemUse.binding.status).toBe("bound");
	});

	it("classifies standard library namespaces as external and missing namespaces as unresolved", () => {
		const provider = new CsharpProvider();
		provider.initialize("/workspace");
		expect(provider.resolveImport({ fromModule: "main.cs", specifier: "System.Text" })).toEqual({
			status: "external",
			packageName: "System.Text",
		});
		expect(provider.resolveImport({ fromModule: "main.cs", specifier: "Missing.Namespace" })).toMatchObject({
			status: "unresolved",
			reason: "NotIndexed",
		});
	});

	it("reports partial-type member lookup as ambiguous when another file is required", () => {
		const root = workspace({
			"a.cs": "namespace N { public partial class C { public void Use() { Other(); } } }\n",
			"b.cs": "namespace N { public partial class C { public void Other() {} public void Other(int value) {} } }\n",
		});
		const provider = new CsharpProvider();
		provider.initialize(root);
		provider.discoverProject(root);
		const text = "namespace N { public partial class C { public void Use() { Other(); } } }\n";
		const facts = provider.parseFile({ module: "a.cs", contentHash: "hash", text });
		const reference = facts.references.find((item) => item.name === "Other" && item.role === "call");
		if (reference === undefined) throw new Error("partial member reference missing");
		expect(reference.binding).toMatchObject({ status: "ambiguous" });
	});

	it("does not scan other files for an unresolved member in a non-partial type", () => {
		const root = workspace({
			"a.cs": "namespace N { public class C { public void Use() { Other(); } } }\n",
			"b.cs": "namespace N { public class Other { public void Run() {} } }\n",
		});
		const provider = new CsharpProvider();
		provider.initialize(root);
		provider.discoverProject(root);
		const facts = provider.parseFile({
			module: "a.cs",
			contentHash: "hash",
			text: "namespace N { public class C { public void Use() { Other(); } } }\n",
		});
		const reference = facts.references.find((item) => item.name === "Other" && item.role === "call");
		if (reference === undefined) throw new Error("unresolved member reference missing");
		expect(reference.binding).toEqual({
			status: "unbound",
			reason: "NotIndexed",
			detail: "no declaration matches this C# reference",
		});
		const parsedFacts = (provider as unknown as { parsedFacts: Map<string, unknown> }).parsedFacts;
		expect([...parsedFacts.keys()]).toEqual(["a.cs"]);
	});
});

describe("C# protocol behavior", () => {
	it("reports syntax errors and ignores attributes without losing declarations", () => {
		const provider = new CsharpProvider();
		provider.initialize("/workspace");
		const valid = provider.parseFile({
			module: "valid.cs",
			contentHash: "hash",
			text: "[System.Obsolete] public class C { [System.Obsolete] public int Value { get; set; } }",
		});
		const broken = provider.parseFile({ module: "broken.cs", contentHash: "hash", text: "public class {\n" });
		expect(valid.diagnostics).toEqual([]);
		expect(valid.declarations.map((item) => item.name)).toEqual(["C", "Value"]);
		expect(broken.diagnostics.some((item) => item.severity === "error")).toBe(true);
	});

	it("honors outline depth while retaining declarations, imports, and diagnostics", () => {
		const provider = new CsharpProvider();
		provider.initialize("/workspace");
		const outline = provider.parseFile({
			module: "outline.cs",
			contentHash: "hash",
			depth: "outline",
			text: "using Demo; public class C { public void Run() { Missing(); } const int Value = 1; }",
		});
		const broken = provider.parseFile({
			module: "broken-outline.cs",
			contentHash: "hash",
			depth: "outline",
			text: "public class {\n",
		});

		expect(outline.depth).toBe("outline");
		expect(outline.declarations.map((item) => item.name)).toEqual(expect.arrayContaining(["C", "Run", "Value"]));
		expect(outline.imports).toMatchObject([{ specifier: "Demo" }]);
		expect(outline.references).toEqual([]);
		expect(outline.literals).toEqual([]);
		expect(broken.depth).toBe("outline");
		expect(broken.diagnostics.some((item) => item.severity === "error")).toBe(true);
		FileFactsSchema.parse(outline);
		FileFactsSchema.parse(broken);
	});

	it("walks C# files while excluding build outputs", () => {
		const root = workspace({
			"src/a.cs": "public class A {}",
			"bin/ignored.cs": "public class Ignored {}",
			"obj/ignored.cs": "public class Ignored {}",
			"src/project.csproj": "<Project />",
		});
		const model = new CsharpProvider().discoverProject(root);
		expect(model.files).toEqual(["src/a.cs"]);
		expect(model.configFiles).toEqual(["src/project.csproj"]);
	});

	it("answers every protocol method and refuses unsupported edits", () => {
		const provider = new CsharpProvider();
		provider.initialize("/workspace");
		expect(Object.keys(handlersFor(provider)).sort()).toEqual([...PROVIDER_METHODS].sort());
		expect(TIERS).toMatchObject({ projectModel: true, declarations: true, syntaxDiagnostics: true });
		expect(REFERENCE_ROLES).toEqual([
			"call",
			"read",
			"write",
			"import",
			"extends",
			"implements",
			"instantiate",
			"typeUse",
		]);
		expect(provider.renameEdits({ module: "x.cs", text: "", oldName: "x", newName: "y", sites: [] })).toMatchObject(
			{ status: "refused", reason: "NotImplemented" },
		);
		expect(
			provider.moveEdits({
				module: "x.cs",
				text: "",
				exists: true,
				symbolId: composeSymbolId({
					language: "csharp",
					module: "x.cs",
					descriptors: [{ kind: "type", name: "C" }],
				}),
				name: "C",
				fromModule: "x.cs",
				toModule: "y.cs",
				role: {},
				importSites: [],
				dependencies: [],
				sites: [],
			}),
		).toMatchObject({ status: "refused", reason: "NotImplemented" });
	});
});
