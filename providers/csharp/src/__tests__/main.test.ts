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
	PROTOCOL_VERSION,
	PROVIDER_METHODS,
	PROVIDER_NOTIFICATIONS,
	TypeInfoSchema,
} from "@nyaa-lexicon/protocol";
import { CsharpProvider, REFERENCE_ROLES, TIERS } from "../main.js";
import { CsharpParser } from "../parser.js";
import { handlersOf, parseThroughKit, startProvider } from "./harness.js";

/** A type in the global namespace, whose name lands on its module. */
const LOOSE = "public class Item {}\n";

function packageScope(scopeId: string) {
	return { kind: "packageScope" as const, providerId: "csharp-provider", scopeId };
}

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
		startProvider(provider);
		const facts = parseThroughKit(provider, { module: "demo.cs", contentHash: "hash", text });

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
		const provider = new CsharpProvider();
		const facts = parseThroughKit(provider, { module: "cart.cs", contentHash: "hash", text });
		const cart = declaration(facts, "Cart", "class");
		expect(cart.selectionRange?.start).toEqual({ line: 0, character: 22 });
		expect(text.slice(cart.selectionRange?.start.character, cart.selectionRange?.end.character)).toBe("Cart");
	});

	it("keeps declaration ids module-relative and distinguishes method overloads", () => {
		const text = "namespace N { public class C { public void Run() {} public void Run(int value) {} } }";
		const provider = new CsharpProvider();
		const facts = parseThroughKit(provider, { module: "src/c.cs", contentHash: "hash", text });
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
			"public int Count = 1, Total = 3;",
			'public string Label = "ready\\nnow";',
			"public bool Enabled = true;",
			"public void Run() { var local = 2; int other = 4, last = 5; }",
			"}",
			"}",
		].join("\n");
		const provider = new CsharpProvider();
		startProvider(provider);
		const facts = parseThroughKit(provider, { module: "values.cs", contentHash: "hash", text });
		const count = declaration(facts, "Count", "field");
		const total = declaration(facts, "Total", "field");
		const label = declaration(facts, "Label", "field");
		const enabled = declaration(facts, "Enabled", "field");
		const local = declaration(facts, "local", "variable");
		const other = declaration(facts, "other", "variable");
		const last = declaration(facts, "last", "variable");
		expect(facts.literals).toEqual([
			{ kind: "number", value: "1", number: 1, range: expect.any(Object), containerId: count.symbolId },
			{ kind: "number", value: "3", number: 3, range: expect.any(Object), containerId: total.symbolId },
			{ kind: "string", value: "ready\nnow", range: expect.any(Object), containerId: label.symbolId },
			{ kind: "boolean", value: "true", range: expect.any(Object), containerId: enabled.symbolId },
			{ kind: "number", value: "2", number: 2, range: expect.any(Object), containerId: local.symbolId },
			{ kind: "number", value: "4", number: 4, range: expect.any(Object), containerId: other.symbolId },
			{ kind: "number", value: "5", number: 5, range: expect.any(Object), containerId: last.symbolId },
		]);
		expect(provider.typeOf({ symbolId: count.symbolId })).toMatchObject({ status: "known", display: "int" });
		expect(provider.typeOf({ symbolId: local.symbolId })).toMatchObject({ status: "inferred", display: "int" });
		TypeInfoSchema.parse(provider.typeOf({ symbolId: local.symbolId }));
	});

	it("binds same-file calls, fields, and parameters, a parameter hiding a field but never a member access", () => {
		const text = [
			"public class C {",
			"public int Value;",
			"public void Add(int amount) { Value = amount; }",
			"public void Run() { Add(Value); }",
			"public C(int Value) { this.Value = Value; }",
			"}",
		].join("\n");
		const provider = new CsharpProvider();
		startProvider(provider);
		const facts = parseThroughKit(provider, { module: "c.cs", contentHash: "hash", text });
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
		const kinds = (line: number) =>
			facts.references
				.filter((item) => item.name === "Value" && item.range.start.line === line)
				.map((item) => {
					const target = item.binding.status === "bound" ? item.binding.symbolId : "";
					return facts.declarations.find((found) => found.symbolId === target)?.languageKind;
				});
		expect(kinds(4)).toEqual(["field", "parameter"]);
		for (const reference of facts.references) BindingSchema.parse(reference.binding);
	});

	it("reports a same-class call named add", () => {
		const text = "public class Cart { public void add() {} public void run() { add(); } }";
		const provider = new CsharpProvider();
		const facts = parseThroughKit(provider, { module: "cart.cs", contentHash: "hash", text });
		const method = declaration(facts, "add", "method");
		const call = facts.references.find((item) => item.name === "add" && item.role === "call");
		if (call === undefined) throw new Error("add call reference missing");
		expect(call.binding).toEqual({ status: "bound", symbolId: method.symbolId, provenance: "bound" });
	});
});

describe("C# workspace resolution", () => {
	it("resolves a using namespace to its package scope and binds imported types, never a nested namespace's", () => {
		const root = workspace({
			"src/item.cs": "namespace Demo.Items { public class Item {} namespace Deep { public class Buried {} } }\n",
			"src/cart.cs":
				"using Demo.Items; namespace Demo { public class Cart { public Item Make() { return new Item(); } Buried b; } }\n",
		});
		const provider = new CsharpProvider();
		startProvider(provider, root);
		const text =
			"using Demo.Items; namespace Demo { public class Cart { public Item Make() { return new Item(); } Buried b; } }\n";
		const facts = parseThroughKit(provider, { module: "src/cart.cs", contentHash: "hash", text });
		expect(provider.resolveImport({ fromModule: "src/cart.cs", specifier: "Demo.Items" })).toEqual({
			status: "resolved",
			landing: packageScope("Demo.Items"),
		});
		const itemUse = facts.references.find((item) => item.name === "Item" && item.role === "instantiate");
		if (itemUse === undefined) throw new Error("imported type reference missing");
		expect(itemUse.binding.status).toBe("bound");
		expect(facts.references.find((item) => item.name === "Buried")?.binding.status).toBe("unbound");
		expect(provider.store.peek("src/item.cs")?.namespaceNames).toContain("Demo.Items");
		expect(provider.store.peek("src/item.cs")?.metadata.size).toBeGreaterThan(0);
		expect(provider.store.text("src/item.cs")?.depth).toBe("outline");
	});

	it("stops resolving into a file the index let go of, until it is parsed again", () => {
		const root = workspace({ "src/item.cs": LOOSE, "src/copy.cs": LOOSE });
		const provider = new CsharpProvider();
		const handlers = startProvider(provider, root);
		const resolve = () => provider.resolveImport({ fromModule: "src/cart.cs", specifier: "Item" });
		expect(resolve()).toMatchObject({ status: "unresolved", reason: "Ambiguous" });

		handlers.forgetModule?.({ module: "src/copy.cs" });
		expect(resolve()).toEqual({ status: "resolved", landing: { kind: "module", module: "src/item.cs" } });

		handlers.parseFile({ module: "src/copy.cs", contentHash: "back", text: LOOSE });
		expect(resolve()).toMatchObject({ status: "unresolved", reason: "Ambiguous" });
	});

	it("classifies standard library namespaces as external and missing namespaces as unresolved", () => {
		const provider = new CsharpProvider();
		startProvider(provider);
		expect(provider.resolveImport({ fromModule: "main.cs", specifier: "System.Text" })).toEqual({
			status: "external",
			packageName: "System.Text",
		});
		expect(provider.resolveImport({ fromModule: "main.cs", specifier: "Missing.Namespace" })).toMatchObject({
			status: "unresolved",
			reason: "NotIndexed",
		});
	});

	it("finds a type in its namespace's other files, then each enclosing namespace, the global one, an alias, then usings", () => {
		const files: Record<string, string> = {
			"lib/json.cs":
				"namespace Lib { public static class JsonConvert { public static string Write(object value) => null; } public class Shared {} }\n",
			"lib/tests.cs": "namespace Lib.Tests { public class Shared {} }\n",
			"root.cs": "public class Root {}\n",
			"other.cs":
				"namespace Other { public class Root {} public class Imported {} namespace Inner { public class Deep {} } }\n",
			"usings.cs": "global using Other.Inner;\n",
			"use.cs": [
				"using Other;",
				"using Alias = Other.Imported;",
				"namespace Lib.Tests.Unit {",
				"  class Use {",
				"    Shared shared; Root root; Imported imported; Alias alias; Deep deep; global::Other.Inner.Deep qualified;",
				"    void M() { JsonConvert.Write(null); global::System.Console.WriteLine(); }",
				"  }",
				"}",
			].join("\n"),
		};
		const provider = new CsharpProvider();
		startProvider(provider, workspace(files));
		const facts = parseThroughKit(provider, {
			module: "use.cs",
			contentHash: "hash",
			text: files["use.cs"] as string,
		});
		const targets = facts.references
			.filter((item) => item.role === "typeUse" || item.name === "Write")
			.map((item) => [item.name, item.binding.status === "bound" ? item.binding.symbolId : item.binding.status]);
		expect(targets).toEqual([
			["Shared", "lexicon csharp lib/tests.cs `Lib.Tests`/Shared#"],
			["Root", "lexicon csharp root.cs Root#"],
			["Imported", "lexicon csharp other.cs Other/Imported#"],
			["Alias", "lexicon csharp other.cs Other/Imported#"],
			["Deep", "lexicon csharp other.cs Other/Inner/Deep#"],
			["Other", "unbound"],
			["Inner", "unbound"],
			["Deep", "lexicon csharp other.cs Other/Inner/Deep#"],
			["Write", "lexicon csharp lib/json.cs Lib/JsonConvert#Write()."],
		]);
		// Right of `global::`, a namespace outside the workspace.
		expect(facts.references.find((item) => item.name === "System")?.binding).toMatchObject({
			status: "unbound",
			reason: "ExternalDependency",
		});
	});

	it("follows a base chain into other files alike through outline and full reads, and lets a value hide its type unless of it", () => {
		const files: Record<string, string> = {
			"base.cs": [
				"namespace N {",
				"  public class Base { public int Count; public void Run() {} public enum State { Start } public Mode Mode; public Helper Tool; }",
				"  public enum Mode { Fast }",
				"  public class Helper {}",
				"  public class Tool { public static void Go() {} }",
				"}",
			].join("\n"),
			"mid.cs": "namespace N { public class Mid : Base {} }\n",
			"leaf.cs":
				"namespace N { class Leaf : Mid { void M() { Run(); Count = 1; State state = State.Start; var mode = Mode.Fast; Tool.Go(); } } }\n",
		};
		const provider = new CsharpProvider();
		startProvider(provider, workspace(files));
		const bindings = (contentHash: string) =>
			parseThroughKit(provider, { module: "leaf.cs", contentHash, text: files["leaf.cs"] as string })
				.references.filter((item) => ["Run", "Count", "State", "Start", "Fast", "Go"].includes(item.name))
				.map((item) => [
					item.name,
					item.role,
					item.binding.status === "bound" ? item.binding.symbolId : item.binding.status,
				]);
		const throughOutline = bindings("outline");
		expect(throughOutline).toEqual([
			["Run", "call", "lexicon csharp base.cs N/Base#Run()."],
			["Count", "write", "lexicon csharp base.cs N/Base#Count."],
			["State", "typeUse", "lexicon csharp base.cs N/Base#State#"],
			["State", "read", "lexicon csharp base.cs N/Base#State#"],
			["Start", "read", "lexicon csharp base.cs N/Base#State#Start."],
			["Fast", "read", "lexicon csharp base.cs N/Mode#Fast."],
			["Go", "call", "unbound"],
		]);
		parseThroughKit(provider, { module: "mid.cs", contentHash: "mid", text: files["mid.cs"] as string });
		expect(bindings("full")).toEqual(throughOutline);
	});

	it("reads namesake types, partial parts and global usings per project, the referring project's own first", () => {
		const project = '<Project Sdk="Microsoft.NET.Sdk"></Project>\n';
		const files: Record<string, string> = {
			"a/A.csproj": project,
			"a/helper.cs": "namespace App { public class Helper {} }\n",
			"a/use.cs": "namespace App { class Use { Helper helper; } }\n",
			"a/part.cs": "namespace App { public partial class Split { public void Use() { Other(); } } }\n",
			"a/imports.cs": "global using Pick = App.PickA;\n",
			"a/pick.cs": "namespace App { public class PickA {} }\n",
			"b/B.csproj": project,
			"b/helper.cs": "namespace App { public class Helper {} }\n",
			"b/part.cs": "namespace App { public partial class Split { public void Other() {} } }\n",
			"b/imports.cs": "global using Pick = App.PickB;\n",
			"b/pick.cs": "namespace App { public class PickB {} class PickUse { Pick value; } }\n",
			"loose/one.cs": "namespace App { public class Twin {} class Use { Twin twin; } }\n",
			"loose/two.cs": "namespace App { public class Twin {} }\n",
		};
		const provider = new CsharpProvider();
		startProvider(provider, workspace(files));
		const target = (module: string, name: string) =>
			parseThroughKit(provider, { module, contentHash: module, text: files[module] as string }).references.find(
				(item) => item.name === name,
			)?.binding;
		expect(target("a/use.cs", "Helper")).toMatchObject({
			status: "bound",
			symbolId: "lexicon csharp a/helper.cs App/Helper#",
		});
		expect(target("loose/one.cs", "Twin")).toMatchObject({
			status: "bound",
			symbolId: "lexicon csharp loose/one.cs App/Twin#",
		});
		// Partial parts in two projects are two types.
		expect(target("a/part.cs", "Other")).toMatchObject({ status: "unbound" });
		expect(target("b/pick.cs", "Pick")).toMatchObject({
			status: "bound",
			symbolId: "lexicon csharp b/pick.cs App/PickB#",
		});
	});

	it("reads an alias or `using static` target from the namespace holding it, its first name settling there, or from the global one after `global::`", () => {
		const files: Record<string, string> = {
			"root.cs":
				"namespace N { public class Target {} public class C {} public class Outer { public class Inner {} public class Inner<T> {} } }\n",
			"shadow.cs": "namespace Q.N { public class Target {} public class D {} }\n",
			"use.cs":
				"namespace Q { using Rooted = global::N.Target; using Dotted = N.C; class Use { Rooted rooted; Dotted dotted; } }\n",
			"nested.cs": "using static N.Outer; class Nested { Inner plain; Inner<int> generic; }\n",
		};
		const provider = new CsharpProvider();
		startProvider(provider, workspace(files));
		const bindings = (module: string) =>
			parseThroughKit(provider, { module, contentHash: module, text: files[module] as string }).references.map(
				(item) => [item.name, item.binding.status === "bound" ? item.binding.symbolId : item.binding.status],
			);
		expect(bindings("use.cs")).toEqual([
			["N.Target", "lexicon csharp root.cs N/Target#"],
			["N.C", "unbound"],
			["Rooted", "lexicon csharp root.cs N/Target#"],
			["Dotted", "unbound"],
		]);
		expect(bindings("nested.cs")).toEqual([
			["N.Outer", "lexicon csharp root.cs N/Outer#"],
			["Inner", "lexicon csharp root.cs N/Outer#Inner#"],
			["Inner", "lexicon csharp root.cs N/Outer#Inner(1)#"],
		]);
	});

	it("reads a partial type's overloads in another file as ambiguous", () => {
		const root = workspace({
			"a.cs": "namespace N { public partial class C { public void Use() { Other(); } } }\n",
			"b.cs": "namespace N { public partial class C { public void Other() {} public void Other(int value) {} } }\n",
		});
		const provider = new CsharpProvider();
		startProvider(provider, root);
		const text = "namespace N { public partial class C { public void Use() { Other(); } } }\n";
		const facts = parseThroughKit(provider, { module: "a.cs", contentHash: "hash", text });
		const reference = facts.references.find((item) => item.name === "Other" && item.role === "call");
		if (reference === undefined) throw new Error("partial member reference missing");
		expect(reference.binding).toMatchObject({ status: "ambiguous" });
	});

	it("never offers another partial file's locals or parameters", () => {
		const root = workspace({
			"a.cs": "namespace N { public partial class C { public void Use() { Run(count); } } }\n",
			"b.cs": "namespace N { public partial class C { void M(int count) { var total = count; } } }\n",
		});
		const provider = new CsharpProvider();
		startProvider(provider, root);
		const text = "namespace N { public partial class C { public void Use() { Run(count, total); } } }\n";
		const facts = parseThroughKit(provider, { module: "a.cs", contentHash: "hash", text });
		const reads = facts.references.filter((item) => item.role === "read");
		expect(reads.map((item) => [item.name, item.binding.status])).toEqual([
			["count", "unbound"],
			["total", "unbound"],
		]);
	});

	it("never binds an unresolved member of a non-partial type to another file's type of its name", () => {
		const root = workspace({
			"a.cs": "namespace N { public class C { public void Use() { Other(); } } }\n",
			"b.cs": "namespace N { public class Other { public void Run() {} } }\n",
		});
		const provider = new CsharpProvider();
		startProvider(provider, root);
		const facts = parseThroughKit(provider, {
			module: "a.cs",
			contentHash: "hash",
			text: "namespace N { public class C { public void Use() { Other(); } } }\n",
		});
		const reference = facts.references.find((item) => item.name === "Other" && item.role === "call");
		if (reference === undefined) throw new Error("unresolved member reference missing");
		expect(reference.binding).toMatchObject({ status: "unbound", reason: "NotIndexed" });
	});
});

describe("a using directive resolves to what the index holds", () => {
	const ITEM = "namespace Demo.Items { public class Item {} }\n";
	const RENAMED = "namespace Demo.Renamed { public class Item {} }\n";
	const OTHER = "namespace Demo.Other { public class Other {} }\n";

	function scanned(root: string): CsharpProvider {
		const provider = new CsharpProvider();
		startProvider(provider, root);
		return provider;
	}

	/** The index's verdict on a parse, through the kit as the wire delivers it. */
	function verdict(provider: CsharpProvider, hash: string, refusal?: string): void {
		handlersFor(provider).moduleAdmission?.({
			module: "src/item.cs",
			contentHash: hash,
			outcome: refusal === undefined ? { status: "admitted" } : { status: "refused", reason: refusal },
		});
	}

	function parse(provider: CsharpProvider, hash: string, text: string) {
		return handlersFor(provider).parseFile({ module: "src/item.cs", contentHash: hash, text });
	}

	function admitted(root: string): CsharpProvider {
		const provider = scanned(root);
		parse(provider, "v1", ITEM);
		verdict(provider, "v1");
		return provider;
	}

	function resolves(provider: CsharpProvider, specifier: string) {
		return provider.resolveImport({ fromModule: "src/use.cs", specifier });
	}

	/** Which namespace `src/item.cs` answers for, as another module's using directive sees it. */
	function served(provider: CsharpProvider): string[] {
		return ["Demo.Items", "Demo.Renamed", "Demo.Probe"].filter(
			(specifier) => resolves(provider, specifier).status === "resolved",
		);
	}

	it("restores the admitted facts a refused parse displaced, and still fans out to them", () => {
		const root = workspace({ "src/item.cs": ITEM, "src/other.cs": OTHER });
		const provider = admitted(root);
		expect(resolves(provider, "Demo.Items")).toEqual({ status: "resolved", landing: packageScope("Demo.Items") });

		parse(provider, "v2", RENAMED);
		expect(resolves(provider, "Demo.Renamed")).toEqual({
			status: "resolved",
			landing: packageScope("Demo.Renamed"),
		});

		verdict(provider, "v2", "the index refused these facts");
		expect(resolves(provider, "Demo.Items")).toEqual({ status: "resolved", landing: packageScope("Demo.Items") });
		expect(resolves(provider, "Demo.Renamed")).toMatchObject({ status: "unresolved", reason: "NotIndexed" });
	});

	it("ignores a verdict naming bytes a later parse replaced", () => {
		const root = workspace({ "src/item.cs": ITEM, "src/other.cs": OTHER });
		const provider = scanned(root);
		parse(provider, "v1", ITEM);
		parse(provider, "v2", RENAMED);

		verdict(provider, "v1", "a verdict about replaced bytes");
		expect(resolves(provider, "Demo.Renamed")).toEqual({
			status: "resolved",
			landing: packageScope("Demo.Renamed"),
		});
		expect(resolves(provider, "Demo.Items")).toMatchObject({ status: "unresolved", reason: "NotIndexed" });
	});

	it("answers a probe from the candidate, then resolves into what the index holds, never the candidate or the disk", () => {
		const root = workspace({ "src/item.cs": ITEM, "src/other.cs": OTHER });
		const provider = admitted(root);
		// The file changed on disk and its parse is outstanding across the probe.
		writeFileSync(path.join(root, "src/item.cs"), RENAMED);
		parse(provider, "v2", RENAMED);
		const probed = handlersFor(provider).probeFile({
			module: "src/item.cs",
			contentHash: "probe",
			text: "namespace Demo.Probe { public class Probed {} }\n",
		});
		const outstanding = served(provider);
		verdict(provider, "v2", "refused");

		expect({
			candidate: probed.declarations.map((declaration) => declaration.name),
			outstanding,
			settled: served(provider),
		}).toEqual({ candidate: ["Demo.Probe", "Probed"], outstanding: ["Demo.Renamed"], settled: ["Demo.Items"] });
	});

	it("keeps a forgotten module withheld across a re-scan, and drops that only on initialize", () => {
		const root = workspace({ "src/item.cs": LOOSE, "src/copy.cs": LOOSE });
		const provider = scanned(root);
		expect(resolves(provider, "Item")).toMatchObject({ status: "unresolved", reason: "Ambiguous" });

		handlersOf(provider).forgetModule?.({ module: "src/copy.cs" });
		handlersOf(provider).discoverProject({ workspaceRoot: root });
		expect(resolves(provider, "Item")).toEqual({
			status: "resolved",
			landing: { kind: "module", module: "src/item.cs" },
		});

		handlersOf(provider).initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
		handlersOf(provider).discoverProject({ workspaceRoot: root });
		expect(resolves(provider, "Item")).toMatchObject({ status: "unresolved", reason: "Ambiguous" });
	});
});

describe("C# protocol behavior", () => {
	it("holds no state beside its store and the index over it, in any of its layers", () => {
		expect(Object.keys(new CsharpProvider()).sort()).toEqual(["index", "store"]);
	});

	it("reports syntax errors and keeps the declarations under attributes", () => {
		const provider = new CsharpProvider();
		startProvider(provider);
		const valid = parseThroughKit(provider, {
			module: "valid.cs",
			contentHash: "hash",
			text: "[System.Obsolete] public class C { [System.Obsolete] public int Value { get; set; } }",
		});
		const broken = parseThroughKit(provider, {
			module: "broken.cs",
			contentHash: "hash",
			text: "public class {\n",
		});
		expect(valid.diagnostics).toEqual([]);
		expect(valid.declarations.map((item) => item.name)).toEqual(["C", "Value"]);
		expect(broken.diagnostics.some((item) => item.severity === "error")).toBe(true);
	});

	it("honors outline depth while retaining declarations, imports, and diagnostics", () => {
		const provider = new CsharpProvider();
		startProvider(provider);
		const outline = parseThroughKit(provider, {
			module: "outline.cs",
			contentHash: "hash",
			depth: "outline",
			text: "using Demo; public class C { public void Run() { Missing(); } const int Value = 1; }",
		});
		const broken = parseThroughKit(provider, {
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
		const model = new CsharpProvider().discoverProject(root, undefined).model;
		expect(model.files).toEqual(["src/a.cs"]);
		expect(model.configFiles).toEqual(["src/project.csproj"]);
	});

	it("answers every protocol method and refuses unsupported edits", () => {
		const provider = new CsharpProvider();
		const handlers = startProvider(provider);
		expect(Object.keys(handlers).sort()).toEqual([...PROVIDER_METHODS, ...PROVIDER_NOTIFICATIONS].sort());
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
