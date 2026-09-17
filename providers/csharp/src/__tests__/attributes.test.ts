import { describe, expect, it } from "bun:test";
import type { Declaration, Reference } from "@nyaa-lexicon/protocol";
import { CsharpProvider } from "../main.js";

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

type Facts = ReturnType<CsharpProvider["parseFile"]>;

function parse(text = TEXT): { provider: CsharpProvider; facts: Facts } {
	const provider = new CsharpProvider();
	provider.initialize("/workspace");
	return { provider, facts: provider.parseFile({ module: "attributes.cs", contentHash: "hash", text }) };
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
});
