import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	BindingSchema,
	type Declaration,
	FileFactsSchema,
	ImportResolutionSchema,
	parseSymbolId,
	type Reference,
	TypeInfoSchema,
} from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CsharpProvider } from "../main.js";

const roots: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-csharp-coverage-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function one<T>(values: T[], message: string): T {
	const value = values[0];
	if (value === undefined) throw new Error(message);
	return value;
}

function declaration(facts: { declarations: Declaration[] }, name: string) {
	return one(
		facts.declarations.filter((item) => item.name === name),
		`declaration missing: ${name}`,
	);
}

function reference(
	facts: {
		references: Reference[];
	},
	name: string,
	role: string,
) {
	return one(
		facts.references.filter((item) => item.name === name && item.role === role),
		`reference missing: ${name} (${role})`,
	);
}

function indexed(files: Record<string, string>, module: string) {
	const root = makeWorkspace(files);
	const provider = new CsharpProvider();
	provider.initialize(root);
	const model = provider.discoverProject(root);
	expect(model.diagnostics).toEqual([]);
	const text = files[module];
	if (text === undefined) throw new Error(`fixture missing: ${module}`);
	const facts = provider.parseFile({ module, contentHash: "coverage", text });
	return { provider, facts, root };
}

function parse(text: string, module = "main.cs") {
	const provider = new CsharpProvider();
	provider.initialize("/workspace");
	const facts = provider.parseFile({ module, contentHash: "coverage", text });
	return { provider, facts };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C# import-driven type answers", () => {
	it("resolves plain, aliased generic, and static imports independently", () => {
		const files = {
			"src/box.cs": [
				"namespace Lib {",
				"public class Box<T> {",
				"public static int Count;",
				"public static void Touch() {}",
				"}",
				"}",
			].join("\n"),
			"src/plain.cs": "using Lib; public class PlainUse { public Box<int> Value; }\n",
			"src/alias.cs": "using Alias = Lib.Box; public class AliasUse { public Alias<int> Value; }\n",
			"src/static.cs":
				"using static Lib.Box; public class StaticUse { public int Read() { return Count; } public void Call() { Touch(); } }\n",
		};
		const { provider, facts: plainFacts } = indexed(files, "src/plain.cs");
		const aliasFacts = provider.parseFile({
			module: "src/alias.cs",
			contentHash: "coverage",
			text: files["src/alias.cs"],
		});
		const staticFacts = provider.parseFile({
			module: "src/static.cs",
			contentHash: "coverage",
			text: files["src/static.cs"],
		});
		const boxFacts = provider.parseFile({
			module: "src/box.cs",
			contentHash: "coverage",
			text: files["src/box.cs"],
		});
		const box = declaration(boxFacts, "Box");
		const count = declaration(boxFacts, "Count");
		const touch = declaration(boxFacts, "Touch");
		expect(provider.resolveImport({ fromModule: "src/plain.cs", specifier: "Lib" })).toEqual({
			status: "resolved",
			module: "src/box.cs",
		});
		expect(provider.resolveImport({ fromModule: "src/alias.cs", specifier: "Lib.Box" })).toEqual({
			status: "resolved",
			module: "src/box.cs",
		});
		const plainType = reference(plainFacts, "Box", "typeUse");
		const aliasType = reference(aliasFacts, "Alias", "typeUse");
		const countRead = reference(staticFacts, "Count", "read");
		const touchCall = reference(staticFacts, "Touch", "call");
		expect(plainType.binding).toEqual({ status: "bound", symbolId: box.symbolId, provenance: "bound" });
		expect(aliasType.binding).toEqual({ status: "bound", symbolId: box.symbolId, provenance: "bound" });
		expect(countRead.binding).toEqual({ status: "bound", symbolId: count.symbolId, provenance: "bound" });
		expect(touchCall.binding).toEqual({ status: "bound", symbolId: touch.symbolId, provenance: "bound" });
		const plainValue = declaration(plainFacts, "Value");
		const aliasValue = declaration(aliasFacts, "Value");
		expect(provider.typeOf({ symbolId: plainValue.symbolId })).toMatchObject({
			status: "known",
			display: "Box<int>",
			symbolId: box.symbolId,
		});
		expect(provider.typeOf({ symbolId: aliasValue.symbolId })).toMatchObject({
			status: "known",
			display: "Alias<int>",
			symbolId: box.symbolId,
		});
		for (const facts of [plainFacts, aliasFacts, staticFacts, boxFacts]) FileFactsSchema.parse(facts);
	});

	it("keeps unresolved aliases separate from external namespaces", () => {
		const files = {
			"src/external.cs":
				"using System; public class ExternalUse { public Console Value; public void Run() { Console.WriteLine(); } }\n",
			"src/missing.cs": "using Alias = Missing.Type; public class MissingUse { public Alias Value; }\n",
		};
		const { provider, facts: externalFacts } = indexed(files, "src/external.cs");
		const missingFacts = provider.parseFile({
			module: "src/missing.cs",
			contentHash: "coverage",
			text: files["src/missing.cs"],
		});
		const consoleType = reference(externalFacts, "Console", "typeUse");
		const consoleRead = reference(externalFacts, "Console", "read");
		const writeLine = reference(externalFacts, "WriteLine", "call");
		const aliasType = reference(missingFacts, "Alias", "typeUse");
		expect(consoleType.binding).toMatchObject({ status: "unbound", reason: "ExternalDependency" });
		expect(consoleRead.binding).toMatchObject({ status: "unbound", reason: "ExternalDependency" });
		expect(writeLine.binding).toMatchObject({ status: "unbound", reason: "ExternalDependency" });
		expect(aliasType.binding).toMatchObject({ status: "unbound", reason: "NotIndexed" });
		const external = provider.resolveImport({ fromModule: "src/external.cs", specifier: "System.Text" });
		const missing = provider.resolveImport({ fromModule: "src/missing.cs", specifier: "Missing.Type" });
		ImportResolutionSchema.parse(external);
		ImportResolutionSchema.parse(missing);
		expect(external).toEqual({ status: "external", packageName: "System.Text" });
		expect(missing).toMatchObject({ status: "unresolved", reason: "NotIndexed" });
		BindingSchema.parse(consoleType.binding);
		BindingSchema.parse(aliasType.binding);
	});

	it("reports ambiguous namespace resolution instead of choosing a file", () => {
		const files = {
			"src/one.cs": "namespace Shared { public class One {} }\n",
			"src/two.cs": "namespace Shared { public class Two {} }\n",
			"src/use.cs": "using Shared; public class Use { public One Value; }\n",
		};
		const { provider, facts } = indexed(files, "src/use.cs");
		const resolution = provider.resolveImport({ fromModule: "src/use.cs", specifier: "Shared" });
		const use = reference(facts, "One", "typeUse");
		ImportResolutionSchema.parse(resolution);
		expect(resolution).toMatchObject({ status: "unresolved", reason: "Ambiguous" });
		expect(use.binding).toMatchObject({ status: "unbound", reason: "Ambiguous" });
		BindingSchema.parse(use.binding);
	});
});

describe("C# role-specific binding", () => {
	it("binds inheritance, implementation, construction, and imported type uses", () => {
		const files = {
			"src/base.cs": [
				"namespace Lib {",
				"public class Base {}",
				"public interface Contract {}",
				"public class Created {}",
				"}",
			].join("\n"),
			"src/derived.cs": [
				"using Lib;",
				"public class Derived : Base, Contract {",
				"public Base Make() { return new Base(); }",
				"public void Build() { var item = new Created(); }",
				"}",
			].join("\n"),
		};
		const { provider, facts } = indexed(files, "src/derived.cs");
		const baseFacts = provider.parseFile({
			module: "src/base.cs",
			contentHash: "coverage",
			text: files["src/base.cs"],
		});
		const base = declaration(baseFacts, "Base");
		const contract = declaration(baseFacts, "Contract");
		const created = declaration(baseFacts, "Created");
		const extendsRef = reference(facts, "Base", "extends");
		const implementsRef = reference(facts, "Contract", "implements");
		const returnType = reference(facts, "Base", "typeUse");
		const constructBase = reference(facts, "Base", "instantiate");
		const constructCreated = reference(facts, "Created", "instantiate");
		expect(extendsRef.binding).toEqual({ status: "bound", symbolId: base.symbolId, provenance: "bound" });
		expect(implementsRef.binding).toEqual({
			status: "bound",
			symbolId: contract.symbolId,
			provenance: "bound",
		});
		expect(returnType.binding).toEqual({ status: "bound", symbolId: base.symbolId, provenance: "bound" });
		expect(constructBase.binding).toEqual({ status: "bound", symbolId: base.symbolId, provenance: "bound" });
		expect(constructCreated.binding).toEqual({
			status: "bound",
			symbolId: created.symbolId,
			provenance: "bound",
		});
		for (const item of facts.references) BindingSchema.parse(item.binding);
	});

	it("binds types imported from a nested namespace", () => {
		const files = {
			"src/item.cs": "namespace Outer.Inner; public class Item {}\n",
			"src/use.cs": "using Outer.Inner; namespace Outer { public class Holder { public Item Value; } }\n",
		};
		const { provider, facts } = indexed(files, "src/use.cs");
		const itemFacts = provider.parseFile({
			module: "src/item.cs",
			contentHash: "coverage",
			text: files["src/item.cs"],
		});
		const item = declaration(itemFacts, "Item");
		const use = reference(facts, "Item", "typeUse");
		expect(provider.resolveImport({ fromModule: "src/use.cs", specifier: "Outer.Inner" })).toEqual({
			status: "resolved",
			module: "src/item.cs",
		});
		expect(use.binding).toEqual({ status: "bound", symbolId: item.symbolId, provenance: "bound" });
		const value = declaration(facts, "Value");
		expect(provider.typeOf({ symbolId: value.symbolId })).toMatchObject({
			status: "known",
			display: "Item",
			symbolId: item.symbolId,
		});
	});

	it("returns an ambiguous binding for same-file overload calls", () => {
		const text = [
			"public class C {",
			"public void Run() {}",
			"public void Run(int value) {}",
			"public void Call() { Run(); }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const call = reference(facts, "Run", "call");
		if (call.binding.status !== "ambiguous") throw new Error("call did not report ambiguity");
		expect(call.binding.candidates).toHaveLength(2);
		expect(new Set(call.binding.candidates).size).toBe(2);
		BindingSchema.parse(call.binding);
	});
});

describe("C# control-flow metrics", () => {
	it("counts nested blocks, logical decisions, loops, catches, and cases", () => {
		const text = [
			"public class Control {",
			"public void Run(bool ready, int[] values) {",
			"if (ready && values != null || values == null) {",
			"for (int i = 0; i < values.Length; i++) {",
			"foreach (int value in values) {",
			"while (ready) {",
			"try { var fallback = values ?? Array.Empty<int>(); }",
			"catch (Exception error) {",
			"switch (value) { case 1: break; default: break; }",
			"}",
			"}",
			"}",
			"}",
			"}",
			"}",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const run = declaration(facts, "Run");
		expect(run.metrics).toMatchObject({ lines: 14, parameters: 2, nesting: 6, branches: 10 });
		expect(facts.diagnostics).toEqual([]);
	});

	it("leaves metrics absent where a declaration has no body", () => {
		const text = "public interface I { void Run(int value); int Value { get; set; } }";
		const { facts } = parse(text);
		const method = declaration(facts, "Run");
		const property = declaration(facts, "Value");
		expect(method.metrics).toMatchObject({ lines: 1, parameters: 1 });
		expect(method.metrics).not.toHaveProperty("nesting");
		expect(method.metrics).not.toHaveProperty("branches");
		expect(property.metrics).toEqual({ lines: 1 });
	});
});

describe("C# syntax diagnostics", () => {
	it("diagnoses missing type, delegate, using, member, and attribute delimiters", () => {
		const cases = [
			{
				module: "type.cs",
				text: "public class C",
				message: "Type declaration needs a body or semicolon.",
			},
			{
				module: "delegate.cs",
				text: "public delegate void Handler()",
				message: "Delegate declaration has no terminating semicolon.",
			},
			{
				module: "using.cs",
				text: "using Missing.Namespace",
				message: "Using directive has no terminating semicolon.",
			},
			{
				module: "member.cs",
				text: "public class C { public int Value }",
				message: "Member declaration needs a terminating delimiter.",
			},
			{
				module: "attribute.cs",
				text: 'public class C { [Obsolete("x") public int Value; }',
				message: "Attribute list is not closed.",
			},
		];
		for (const item of cases) {
			const { facts } = parse(item.text, item.module);
			const diagnostic = one(
				facts.diagnostics.filter((candidate) => candidate.message === item.message),
				`diagnostic missing for ${item.module}`,
			);
			expect(diagnostic.severity).toBe("error");
			expect(diagnostic.path).toBe(item.module);
			if (diagnostic.range === undefined) throw new Error(`range missing for ${item.module}`);
			expect(diagnostic.range.end.line).toBeGreaterThanOrEqual(diagnostic.range.start.line);
			expect(diagnostic.range.end.character).toBeGreaterThanOrEqual(
				diagnostic.range.start.line === diagnostic.range.end.line ? diagnostic.range.start.character : 0,
			);
		}
	});

	it("diagnoses ordinary strings that cross a physical line", () => {
		const { facts } = parse('public class C { string Value = "broken\ntext"; }', "newline.cs");
		const diagnostic = one(
			facts.diagnostics.filter((item) => item.message === "String literal cannot contain a newline."),
			"newline diagnostic missing",
		);
		expect(diagnostic.severity).toBe("error");
		expect(diagnostic.path).toBe("newline.cs");
	});

	it("does not diagnose valid raw and verbatim multiline strings", () => {
		const text = [
			"public class C {",
			'public string Verbatim = @"line',
			'next";',
			'public string Raw = """line',
			'next""";',
			"}",
		].join("\n");
		const { facts } = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.filter((item) => item.kind === "field")).toHaveLength(2);
	});
});

describe("C# type queries and declaration identity", () => {
	it("returns Ambiguous for an equally ranged comma declaration", () => {
		const { provider, facts } = parse("public class C { public int First, Second; }");
		const fields = facts.declarations.filter((item) => item.kind === "field");
		expect(fields).toHaveLength(2);
		const field = fields[0];
		if (field === undefined) throw new Error("field missing");
		const answer = provider.typeOf({ module: "main.cs", range: field.range });
		TypeInfoSchema.parse(answer);
		expect(answer).toEqual({
			status: "unknown",
			reason: "Ambiguous",
			detail: "the requested range matches equally sized declarations",
		});
	});

	it("preserves descriptor chains and container visibility for nested declarations", () => {
		const text = [
			"namespace Demo {",
			"public class Outer {",
			"private class Inner { public void Run() {} }",
			"}",
			"public enum State { Ready, Done = 2 }",
			"public delegate void Handler(int value);",
			"public interface Contract { int Value { get; set; } void Run(); }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const outer = declaration(facts, "Outer");
		const inner = declaration(facts, "Inner");
		const run = one(
			facts.declarations.filter((item) => item.name === "Run" && item.kind === "method"),
			"nested method missing",
		);
		const state = declaration(facts, "State");
		const ready = declaration(facts, "Ready");
		const handler = declaration(facts, "Handler");
		const contract = declaration(facts, "Contract");
		expect(parseSymbolId(inner.symbolId)?.descriptors).toEqual([
			{ kind: "namespace", name: "Demo" },
			{ kind: "type", name: "Outer" },
			{ kind: "type", name: "Inner" },
		]);
		expect(inner).toMatchObject({
			containerId: outer.symbolId,
			visibility: "private",
			exported: false,
		});
		expect(run).toMatchObject({ containerId: inner.symbolId, exported: false });
		expect(ready).toMatchObject({ containerId: state.symbolId, kind: "constant", languageKind: "enumMember" });
		expect(handler.metrics).toMatchObject({ parameters: 1 });
		expect(contract.visibility).toBe("public");
		expect(facts.declarations.filter((item) => item.name === "Value" && item.kind === "property")).toHaveLength(1);
	});

	it("round-trips local and named symbol ids without confusing modules", () => {
		const { facts } = parse("public class C { public void Run() { var first = 1; var second = 2; } }");
		const locals = facts.declarations.filter((item) => item.name === "first" || item.name === "second");
		expect(locals).toHaveLength(2);
		const parsed = locals.map((item) => parseSymbolId(item.symbolId));
		expect(parsed.every((item) => item?.language === "csharp" && item?.module === "main.cs")).toBe(true);
		expect(parsed.map((item) => item?.local)).toEqual([0, 1]);
	});
});

describe("C# protocol-shaped facts", () => {
	it("reports imported-name ranges and valid facts for global using", () => {
		const text = [
			"global using Lib;",
			"using Alias = Lib.Box;",
			"namespace Lib { public class Box {} }",
			"public class Use { public Alias Value; }",
		].join("\n");
		const { facts } = parse(text);
		const imports = facts.imports;
		expect(imports).toHaveLength(2);
		expect(imports[0]).toMatchObject({ specifier: "Lib", imported: [], reExport: false });
		expect(imports[1]).toMatchObject({
			specifier: "Lib.Box",
			imported: [{ local: "Alias" }],
			reExport: false,
		});
		const local = imports[1]?.imported[0]?.localRange;
		if (local === undefined) throw new Error("alias range missing");
		expect(local.start.line).toBe(1);
		expect(local.end.character).toBeGreaterThan(local.start.character);
		FileFactsSchema.parse(facts);
	});

	it("keeps reference roles distinct from declaration names", () => {
		const text = [
			"public class Base {}",
			"public interface Contract {}",
			"public class Child : Base, Contract {",
			"public int Value;",
			"public void Run() { Value = new Child().Value; Run(); }",
			"}",
		].join("\n");
		const { facts } = parse(text);
		const roles = new Map<string, number>();
		for (const item of facts.references) roles.set(item.role, (roles.get(item.role) ?? 0) + 1);
		expect(roles.get("extends")).toBe(1);
		expect(roles.get("implements")).toBe(1);
		expect(roles.get("instantiate")).toBe(1);
		expect(roles.get("write")).toBe(1);
		expect(roles.get("read")).toBeGreaterThanOrEqual(1);
		expect(roles.get("call")).toBe(1);
		expect(facts.references.every((item) => item.name.length > 0)).toBe(true);
	});
});
