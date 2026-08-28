import { describe, expect, test } from "bun:test";
import { composeSymbolId } from "@nyaa-lexicon/protocol";
import { CsharpParser } from "../parser.js";

const id = (module: string, descriptors: Parameters<typeof composeSymbolId>[0]["descriptors"]) =>
	composeSymbolId({ language: "csharp", module, descriptors });

function declarations(text: string) {
	return new CsharpParser("identity.cs", text).parse().declarations;
}

describe("C# stable explicit interface identity", () => {
	test("keeps generic method qualifiers when members reorder", () => {
		const first = declarations("class S { void IFoo<int>.Bar() {} void IFoo<T>.Bar() {} }\n");
		const second = declarations("class S { void IFoo<T>.Bar() {} void IFoo<int>.Bar() {} }\n");
		const firstIds = first
			.filter((item) => item.name === "Bar")
			.map((item) => item.symbolId)
			.sort();
		const secondIds = second
			.filter((item) => item.name === "Bar")
			.map((item) => item.symbolId)
			.sort();
		expect(firstIds).toEqual(secondIds);
		expect(firstIds).toContain(
			id("identity.cs", [
				{ kind: "type", name: "S" },
				{ kind: "namespace", name: "IFoo" },
				{ kind: "method", name: "Bar" },
			]),
		);
	});

	test("takes the interface's own descriptor wherever in the file it is declared", () => {
		const expected = id("identity.cs", [
			{ kind: "type", name: "S" },
			{ kind: "type", name: "IFoo" },
			{ kind: "method", name: "Compute" },
		]);
		for (const source of [
			"interface IFoo { void Compute(); } class S : IFoo { void IFoo.Compute() {} }\n",
			"class S : IFoo { void IFoo.Compute() {} } interface IFoo { void Compute(); }\n",
		]) {
			const compute = declarations(source).filter(
				(item) => item.name === "Compute" && item.containerId !== undefined,
			);
			expect(
				compute.map((item) => item.symbolId),
				source,
			).toContain(expected);
		}
	});

	test("reads a nested generic interface as one qualifier", () => {
		const ids = declarations("class S { void IFoo<IBar<int>>.Compute() {} }\n")
			.filter((item) => item.name === "Compute")
			.map((item) => item.symbolId);
		expect(ids).toEqual([
			id("identity.cs", [
				{ kind: "type", name: "S" },
				{ kind: "namespace", name: "IFoo" },
				{ kind: "method", name: "Compute" },
			]),
		]);
	});

	test("qualifies explicit properties and events", () => {
		const first = declarations("class S { int IFoo.Value { get; } event EventHandler IFoo.Changed; }\n");
		const second = declarations("class S { event EventHandler IFoo.Changed; int IFoo.Value { get; } }\n");
		const paths = (items: typeof first) =>
			items
				.filter((item) => item.name === "Value" || item.name === "Changed")
				.map((item) => item.symbolId)
				.sort();
		expect(paths(first)).toEqual(paths(second));
		expect(paths(first)).toEqual([
			id("identity.cs", [
				{ kind: "type", name: "S" },
				{ kind: "namespace", name: "IFoo" },
				{ kind: "term", name: "Changed" },
			]),
			id("identity.cs", [
				{ kind: "type", name: "S" },
				{ kind: "namespace", name: "IFoo" },
				{ kind: "term", name: "Value" },
			]),
		]);
	});
});
