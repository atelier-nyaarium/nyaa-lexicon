import { describe, expect, it } from "bun:test";
import type { Declaration, handlersFor, Reference } from "@nyaa-lexicon/protocol";
import { CsharpProvider } from "../main.js";
import { parseThroughKit, startProvider } from "./harness.js";

const TEXT = [
	"using System;",
	"[assembly: Marker]",
	"public class MarkerAttribute : Attribute { public MarkerAttribute(Type target = null) { } public int Order; }",
	"public class Base { }",
	"[Marker(typeof(Base))]",
	"public class Holder : Base {",
	"    public const int Limit = 1;",
	"    [Marker] [return: Marker]",
	"    public Base Method([Marker] Base x = null) => x;",
	"    [Marker(Order = Limit)] public Base Field;",
	"    public void Take(Base value, int count = Limit) { }",
	'    public void Named([Marker(Order = Limit)] string text = "x") { }',
	"}",
	"public enum Kinds { [Marker] One, Two }",
	"public class Generic<[Marker] T> { }",
	"",
].join("\n");

type Facts = ReturnType<ReturnType<typeof handlersFor>["parseFile"]>;

function parse(text = TEXT): { provider: CsharpProvider; facts: Facts } {
	const provider = new CsharpProvider();
	startProvider(provider);
	return { provider, facts: parseThroughKit(provider, { module: "attributes.cs", contentHash: "hash", text }) };
}

function declared(facts: Facts, name: string, kind?: Declaration["kind"]): Declaration {
	const found = facts.declarations.find((item) => item.name === name && (kind === undefined || item.kind === kind));
	if (found === undefined) throw new Error(`${name} is not declared`);
	return found;
}

function nameOf(facts: Facts, symbolId: string | undefined): string | null {
	return symbolId === undefined ? null : (facts.declarations.find((item) => item.symbolId === symbolId)?.name ?? "?");
}

function uses(
	facts: Facts,
	name: string,
): Array<{ role: Reference["role"]; line: number; from: string | null; to: string | null }> {
	return facts.references
		.filter((item) => item.name === name)
		.map((item) => ({
			role: item.role,
			line: item.range.start.line,
			from: nameOf(facts, item.fromId),
			to: item.binding.status === "bound" ? nameOf(facts, item.binding.symbolId) : null,
		}));
}

describe("C# attributes", () => {
	it("writes an attribute's name in the declaration it sits on, an assembly attribute in none, and binds it with the suffix", () => {
		const { facts } = parse();
		const marker = { role: "typeUse", to: "MarkerAttribute" } as const;
		expect(uses(facts, "Marker")).toEqual([
			{ ...marker, line: 1, from: null },
			{ ...marker, line: 4, from: "Holder" },
			{ ...marker, line: 7, from: "Method" },
			{ ...marker, line: 7, from: "Method" },
			{ ...marker, line: 8, from: "Method" },
			{ ...marker, line: 9, from: "Field" },
			{ ...marker, line: 11, from: "Named" },
			{ ...marker, line: 13, from: "One" },
			{ ...marker, line: 14, from: "Generic" },
		]);
		expect(facts.references.filter((item) => item.name === "assembly" || item.name === "return")).toEqual([]);
		expect(facts.diagnostics).toEqual([]);
	});

	it("reads attribute arguments and parameter headers as the method's own", () => {
		const { facts } = parse();
		expect(uses(facts, "Base")).toEqual([
			{ role: "typeUse", line: 4, from: "Holder", to: "Base" },
			{ role: "extends", line: 5, from: "Holder", to: "Base" },
			{ role: "typeUse", line: 8, from: "Method", to: "Base" },
			{ role: "typeUse", line: 8, from: "Method", to: "Base" },
			{ role: "typeUse", line: 9, from: "Field", to: "Base" },
			{ role: "typeUse", line: 10, from: "Take", to: "Base" },
		]);
		expect(uses(facts, "Limit")).toEqual([
			{ role: "read", line: 9, from: "Field", to: "Limit" },
			{ role: "read", line: 10, from: "Take", to: "Limit" },
			{ role: "read", line: 11, from: "Named", to: "Limit" },
		]);
		expect(uses(facts, "Order").map((item) => item.role)).toEqual(["write", "write"]);
		const literal = facts.literals.find((item) => item.value === "x");
		expect(nameOf(facts, literal?.containerId)).toBe("Named");
	});

	it("starts an attributed declaration at its attribute and keeps the attribute out of its signature and types", () => {
		const { provider, facts } = parse();
		expect(declared(facts, "Holder").range.start).toEqual({ line: 4, character: 0 });
		expect(declared(facts, "Holder").signature).toBe("public class Holder : Base");
		expect(declared(facts, "Method").range.start).toEqual({ line: 7, character: 4 });
		expect(declared(facts, "Method").signature).toBe("public Base Method([Marker] Base x = null) => x");
		expect(declared(facts, "One").range.start).toEqual({ line: 13, character: 20 });
		expect(declared(facts, "Two", "constant").range.start).toEqual({ line: 13, character: 34 });
		expect(provider.typeOf({ symbolId: declared(facts, "x").symbolId })).toMatchObject({ display: "Base" });
		expect(provider.typeOf({ symbolId: declared(facts, "text").symbolId })).toMatchObject({ display: "string" });
		const generic = declared(facts, "Generic");
		expect(
			facts.declarations.filter((item) => item.containerId === generic.symbolId).map((item) => item.name),
		).toEqual(["T"]);
	});

	it("keeps an enum member's doc comment ahead of its attribute", () => {
		const { facts } = parse(
			[
				"enum E",
				"{",
				"    /// member documentation",
				"    [Marker] Explicit = 2,",
				"    [Marker] Trailing,",
				"}",
				"",
			].join("\n"),
		);
		expect(declared(facts, "Explicit", "constant").range.start).toEqual({ line: 2, character: 4 });
		expect(declared(facts, "Trailing", "constant").range.start).toEqual({ line: 4, character: 4 });
		expect(uses(facts, "Marker").map((item) => item.from)).toEqual(["Explicit", "Trailing"]);
	});

	it("owns an accessor's attribute by the property, indexer or event it accesses", () => {
		const { facts } = parse(
			[
				"using System;",
				"public class MarkerAttribute : Attribute { }",
				"public class Holder {",
				"    public int Value { [Marker] get; [Marker] set; }",
				"    public int Init { get; [Marker] init; }",
				"    public int this[int i] { [Marker] get => i; }",
				"    public event Action Changed { [Marker] add { } [Marker] remove { } }",
				"}",
				"",
			].join("\n"),
		);
		expect(uses(facts, "Marker").map((item) => item.from)).toEqual([
			"Value",
			"Value",
			"Init",
			"this",
			"Changed",
			"Changed",
		]);
		expect(uses(facts, "Marker").every((item) => item.role === "typeUse")).toBe(true);
	});

	it("walks attributes on an indexer parameter, a local function and a lambda", () => {
		const { facts } = parse(
			[
				"using System;",
				"public class MarkerAttribute : Attribute { }",
				"public class Holder {",
				"    public int this[[Marker] int i] => i;",
				"    public void Method() {",
				"        [Marker]",
				"        void Local() { }",
				"        Action<int> a = [Marker] x => { };",
				"    }",
				"}",
				"",
			].join("\n"),
		);
		expect(uses(facts, "Marker").map((item) => item.from)).toEqual(["this", "Method", "Method"]);
		expect(uses(facts, "Marker").every((item) => item.role === "typeUse")).toBe(true);
	});

	it("does not mistake a collection expression or a list pattern for an attribute", () => {
		const { facts } = parse(
			[
				"public class Holder {",
				"    public void Method() {",
				"        int[] arr = [1, 2, 3];",
				"        var result = arr switch {",
				"            [var first, ..] => first,",
				"            _ => 0,",
				"        };",
				"    }",
				"}",
				"",
			].join("\n"),
		);
		expect(facts.diagnostics).toEqual([]);
		expect(uses(facts, "var")).toEqual([]);
	});

	it("walks a local function's attribute inside an accessor body", () => {
		const { facts } = parse(
			[
				"using System;",
				"public class MarkerAttribute : Attribute { }",
				"public class Holder {",
				"    public int Value {",
				"        get {",
				"            [Marker]",
				"            int Local() { return 1; }",
				"            return Local();",
				"        }",
				"    }",
				"}",
				"",
			].join("\n"),
		);
		expect(uses(facts, "Marker").map((item) => ({ role: item.role, from: item.from }))).toEqual([
			{ role: "typeUse", from: "Value" },
		]);
	});

	it("walks an anonymous method's own attribute and its parameter's attribute", () => {
		const { facts } = parse(
			[
				"using System;",
				"public class MarkerAttribute : Attribute { }",
				"public class Holder {",
				"    public void Method() {",
				"        Action<int> a = delegate ([Marker] int x) { };",
				"        Action<int> b = [Marker] delegate (int y) { };",
				"    }",
				"}",
				"",
			].join("\n"),
		);
		expect(uses(facts, "Marker").every((item) => item.role === "typeUse")).toBe(true);
		expect(uses(facts, "Marker").length).toBe(2);
	});
});

describe("C# type references outside attributes", () => {
	it("emits a type use for a generic where-clause constraint, keeping the constrained parameter's own role", () => {
		const { facts } = parse(
			[
				"public class Bound { }",
				"public class Holder<T> where T : Bound {",
				"    public void Method<U>(U value) where U : Bound { }",
				"}",
				"",
			].join("\n"),
		);
		expect(uses(facts, "T").map((item) => item.role)).toEqual(["typeUse"]);
		expect(uses(facts, "U").filter((item) => item.role === "typeUse").length).toBeGreaterThan(0);
		expect(uses(facts, "Bound").map((item) => item.role)).toEqual(["typeUse", "typeUse"]);
	});

	it("keeps a real base type's role separate from a where-clause constraint on the same declaration", () => {
		const { facts } = parse(
			[
				"public class Bound { }",
				"public class IBase { }",
				"public class Holder<T> : IBase where T : Bound {",
				"}",
				"",
			].join("\n"),
		);
		expect(uses(facts, "IBase").map((item) => item.role)).toEqual(["extends"]);
		expect(uses(facts, "Bound").map((item) => item.role)).toEqual(["typeUse"]);
	});

	it("makes nameof a type use only for a generic operand, keeping a bare name or member access a read", () => {
		const { facts } = parse(
			[
				"using System.Collections.Generic;",
				"public class Bound { }",
				"public class Holder {",
				"    public string A = nameof(Bound);",
				"    public string B = nameof(List<Bound>);",
				"    public string C = nameof(this.Bound);",
				"}",
				"",
			].join("\n"),
		);
		expect(uses(facts, "Bound").map((item) => item.role)).toEqual(["read", "typeUse", "read"]);
		expect(uses(facts, "List").map((item) => item.role)).toEqual(["typeUse"]);
	});

	it("names no type for a bare constraint keyword: class, struct, notnull, unmanaged, default, new()", () => {
		const { facts } = parse(
			[
				"public class Holder<A, B, C, D, E> where A : class where B : struct where C : notnull",
				"    where D : unmanaged where E : new() {",
				"}",
				"",
			].join("\n"),
		);
		for (const word of ["class", "struct", "notnull", "unmanaged", "default", "new"]) {
			expect(uses(facts, word)).toEqual([]);
		}
		expect(uses(facts, "A").map((item) => item.role)).toEqual(["typeUse"]);
		expect(uses(facts, "E").map((item) => item.role)).toEqual(["typeUse"]);
	});

	it("marks a nested generic bound and every constraint on one parameter", () => {
		const { facts } = parse(
			[
				"public interface IEnumerable<T> { }",
				"public class Bound { }",
				"public interface IOther { }",
				"public class Holder<T, U> where T : IEnumerable<U> where U : Bound, IOther, new() {",
				"}",
				"",
			].join("\n"),
		);
		expect(uses(facts, "IEnumerable").map((item) => item.role)).toEqual(["typeUse"]);
		expect(uses(facts, "Bound").map((item) => item.role)).toEqual(["typeUse"]);
		expect(uses(facts, "IOther").map((item) => item.role)).toEqual(["typeUse"]);
		expect(uses(facts, "new")).toEqual([]);
	});

	it("keeps a record primary constructor's base type and where-clause bound separate", () => {
		const { facts } = parse(
			["public class Base { }", "public record R<T>(T x) : Base where T : class {", "}", ""].join("\n"),
		);
		expect(uses(facts, "Base").map((item) => item.role)).toEqual(["extends"]);
		expect(uses(facts, "class")).toEqual([]);
		expect(uses(facts, "T").every((item) => item.role === "typeUse")).toBe(true);
	});

	it("keeps a member access after a nameof generic instantiation a read", () => {
		const { facts } = parse(
			[
				"public class A<T> { public static int B; }",
				"public class Holder {",
				"    public string S = nameof(A<int>.B);",
				"}",
				"",
			].join("\n"),
		);
		expect(uses(facts, "A").map((item) => item.role)).toEqual(["typeUse"]);
		expect(uses(facts, "B").map((item) => item.role)).toEqual(["read"]);
	});

	it("marks a qualified generic nameof operand as a type use through its own generic instantiation", () => {
		const { facts } = parse(
			[
				"namespace NS { public class A { public class B<T> { } } }",
				"public class Holder {",
				"    public string S = nameof(global::NS.A.B<int>);",
				"}",
				"",
			].join("\n"),
		);
		expect(uses(facts, "NS").map((item) => item.role)).toEqual(["typeUse"]);
		expect(uses(facts, "A").map((item) => item.role)).toEqual(["typeUse"]);
		expect(uses(facts, "B").map((item) => item.role)).toEqual(["typeUse"]);
	});
});
