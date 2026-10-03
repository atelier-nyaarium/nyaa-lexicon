import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileFactsSchema, ImportResolutionSchema } from "@nyaa-lexicon/protocol";
import { CsharpProvider } from "../main.js";
import { parseThroughKit, startProvider } from "./harness.js";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-csharp-transfers-"));
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
	return { provider, facts: parseThroughKit(provider, { module, contentHash: "transfers", text }) };
}

function scope(kind: "packageScope" | "symbolScope", scopeId: string) {
	return { kind, providerId: "csharp-provider", scopeId };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C# using directives as transfers", () => {
	it("reports an injection for a namespace or static, a namespace or named alias, each proved or not", () => {
		const text = [
			"global using Lib.Inner;",
			"using Lib;",
			"using static Lib.Box;",
			"using Short = Lib;",
			"using Alias = Lib.Box;",
			"using Map = System.Collections.Generic.Dictionary<string, int>;",
			"using Text = System.Text;",
			"using Gone = Missing.Thing;",
			"namespace Lib { public class Box {} namespace Inner { public class Deep {} } }",
		].join("\n");
		const { facts } = parse(text);
		expect(
			facts.imports.flatMap(({ specifier, edges }) =>
				edges.map((edge) => [
					edge.order,
					specifier,
					edge.kind,
					edge.local ?? "-",
					edge.name ?? "-",
					edge.visibility,
					edge.certainty.status === "known" ? "known" : edge.certainty.reason,
					edge.conflict?.priority,
				]),
			),
		).toEqual([
			[0, "Lib.Inner", "injection", "-", "-", "internal", "known", 0],
			[1, "Lib", "injection", "-", "-", "fileLocal", "known", 0],
			[2, "Lib.Box", "injection", "-", "-", "fileLocal", "known", 0],
			[3, "Lib", "namespace", "Short", "-", "fileLocal", "known", 1],
			[4, "Lib.Box", "named", "Alias", "Box", "fileLocal", "known", 1],
			[5, "System.Collections.Generic.Dictionary", "named", "Map", "Dictionary", "fileLocal", "known", 1],
			[6, "System.Text", "named", "Text", "Text", "fileLocal", "ExternalDependency", 1],
			[7, "Missing.Thing", "named", "Gone", "Thing", "fileLocal", "NotIndexed", 1],
		]);
		const spans = facts.imports.flatMap(({ edges }) => edges.map((edge) => JSON.stringify(edge.span)));
		expect(new Set(spans).size).toBe(spans.length);
		FileFactsSchema.parse(facts);
	});

	it("lands a namespace, relative ones included, on its package scope and a type alias where its name stands", () => {
		const text = [
			"using G = Loose;",
			"using E = Ext::N.C;",
			"using Text = System.Text;",
			"using Lib.Inner.Deep;",
			"namespace Lib { using Inner; using Rel = Inner.Deep; namespace Inner { public class Deep {} } }",
			"public class Loose {}",
		].join("\n");
		const { provider } = parse(text);
		const resolve = (specifier: string) => {
			const resolution = provider.resolveImport({ fromModule: "main.cs", specifier });
			ImportResolutionSchema.parse(resolution);
			return resolution;
		};
		expect(["Loose", "N.C", "System.Text", "Lib.Inner.Deep", "Inner", "Inner.Deep"].map(resolve)).toEqual([
			{ status: "resolved", landing: { kind: "module", module: "main.cs" } },
			{ status: "external", packageName: "Ext" },
			{ status: "external", packageName: "System.Text" },
			// A using namespace directive names no type.
			expect.objectContaining({ status: "unresolved", reason: "NotIndexed" }),
			{ status: "resolved", landing: scope("packageScope", "Lib.Inner") },
			{ status: "resolved", landing: scope("packageScope", "Lib.Inner") },
		]);
	});

	it("contributes each namespace's reachable types, every partial part, and each type's scope with what using static brings", () => {
		const files = {
			"src/a.cs": [
				"namespace App {",
				"  public partial class Split { public static void Run() {} public void Instance() {} }",
				"  public class Outer {",
				"    public class Nested {}",
				"    private class Secret {}",
				"    public static int Count { get; }",
				"    public static event System.Action Changed;",
				"    public static int Total;",
				"    public const int Max = 1;",
				"    public int Size;",
				"    static Outer() {}",
				"  }",
				"  public enum Color { Red, Green }",
				"  file class Hidden { public static void Go() {} public class Under {} }",
				"  delegate void Handler();",
				"  namespace Inner { class Deep {} }",
				"}",
				"namespace Empty {}",
				"public class Loose {}",
			].join("\n"),
			"src/b.cs":
				"namespace App { public partial class Split { public static void Stop() {} } interface IThing {} }\n",
		};
		const contributed = (provider: CsharpProvider, module: keyof typeof files) => {
			const facts = parseThroughKit(provider, { module, contentHash: module, text: files[module] });
			FileFactsSchema.parse(facts);
			const names = new Map(facts.declarations.map((item) => [item.symbolId, item.name]));
			return facts.scopeContributions?.map(({ kind, scopeId, members }) => [
				kind,
				scopeId,
				members.map((member) => names.get(member)),
			]);
		};
		const both = new CsharpProvider();
		startProvider(both, workspace(files));
		const alone = new CsharpProvider();
		startProvider(alone, workspace({ "src/b.cs": files["src/b.cs"] }));
		expect({ a: contributed(both, "src/a.cs"), b: contributed(both, "src/b.cs") }).toEqual({
			a: [
				["packageScope", "App", ["Split", "Outer", "Color", "Handler"]],
				["packageScope", "App.Inner", ["Deep"]],
				["packageScope", "Empty", []],
				["symbolScope", "App.Split", ["Run"]],
				["symbolScope", "App.Outer", ["Nested", "Count", "Changed", "Total", "Max"]],
				["symbolScope", "App.Outer.Nested", []],
				["symbolScope", "App.Outer.Secret", []],
				["symbolScope", "App.Color", ["Red", "Green"]],
				["symbolScope", "App.Handler", []],
				["symbolScope", "App.Inner.Deep", []],
				["symbolScope", "Loose", []],
			],
			b: [
				["packageScope", "App", ["Split", "IThing"]],
				["symbolScope", "App.Split", ["Stop"]],
				["symbolScope", "App.IThing", []],
			],
		});
		// A part's contribution never depends on which other parts exist.
		expect(contributed(alone, "src/b.cs")).toEqual(contributed(both, "src/b.cs"));
	});

	it("lands using static and a nested type's alias on a type scope its declaring files contribute to", () => {
		const files = {
			"src/a.cs":
				"namespace App { public partial class Split { public static void Run() {} } public class Outer { public class Nested {} } }\n",
			"src/b.cs": "namespace App { public partial class Split { public static void Stop() {} } }\n",
			"src/use.cs": "using static App.Split;\nusing N = App.Outer.Nested;\nclass U {}\n",
		};
		const provider = new CsharpProvider();
		startProvider(provider, workspace(files));
		const members = new Map<string, string[]>();
		for (const module of ["src/a.cs", "src/b.cs"] as const) {
			const facts = parseThroughKit(provider, { module, contentHash: module, text: files[module] });
			const names = new Map(facts.declarations.map((item) => [item.symbolId, item.name]));
			for (const contribution of facts.scopeContributions ?? [])
				if (contribution.kind === "symbolScope")
					members.set(contribution.scopeId, [
						...(members.get(contribution.scopeId) ?? []),
						...contribution.members.map((member) => names.get(member) ?? member),
					]);
		}
		const landed = (specifier: string) => {
			const resolution = provider.resolveImport({ fromModule: "src/use.cs", specifier });
			return resolution.status === "resolved" && resolution.landing.kind === "symbolScope"
				? members.get(resolution.landing.scopeId)
				: resolution;
		};
		expect([landed("App.Split"), landed("App.Outer.Nested")]).toEqual([["Run", "Stop"], ["Nested"]]);
	});

	it("answers Ambiguous when directives of one specifier land apart in different namespace bodies", () => {
		const files = {
			"src/lib.cs": "namespace A.Common { class X {} }\nnamespace Common { class Y {} }\nnamespace B {}\n",
			"src/apart.cs": "namespace A { using Common; }\nnamespace B { using Common; }\n",
			"src/together.cs": "namespace B { using Common; }\nnamespace C { using Common; }\n",
		};
		const provider = new CsharpProvider();
		startProvider(provider, workspace(files));
		const resolve = (fromModule: string) => {
			const resolution = provider.resolveImport({ fromModule, specifier: "Common" });
			ImportResolutionSchema.parse(resolution);
			return resolution;
		};
		expect([resolve("src/apart.cs"), resolve("src/together.cs")]).toEqual([
			expect.objectContaining({ status: "unresolved", reason: "Ambiguous" }),
			{ status: "resolved", landing: scope("packageScope", "Common") },
		]);
	});

	it("binds a file type only from its own file", () => {
		const files = {
			"src/other.cs": "namespace N { file class Hidden {} }\n",
			"src/a.cs": "namespace A { file class X {} }\n",
			"src/b.cs": "namespace B { public class X {} }\n",
			"src/main.cs":
				"using A;\nusing B;\nnamespace N { class U { Hidden h; X x; Mine m; } file class Mine {} }\n",
		};
		const provider = new CsharpProvider();
		startProvider(provider, workspace(files));
		const facts = parseThroughKit(provider, {
			module: "src/main.cs",
			contentHash: "main",
			text: files["src/main.cs"],
		});
		const bound = (name: string) => {
			const binding = facts.references.find((item) => item.name === name && item.role === "typeUse")?.binding;
			return binding?.status === "bound" ? binding.symbolId.split(" ").slice(2).join(" ") : binding?.status;
		};
		expect(["Hidden", "X", "Mine"].map(bound)).toEqual(["unbound", "src/b.cs B/X#", "src/main.cs N/Mine#"]);
	});
});
