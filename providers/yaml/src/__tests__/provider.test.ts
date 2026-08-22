import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { TIERS, YamlProvider } from "../main.js";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-yaml-"));
	roots.push(root);
	for (const [name, text] of Object.entries(files)) {
		const absolute = path.join(root, name);
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, text, "utf8");
	}
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parse(module: string, text: string, depth?: "outline" | "surface") {
	return new YamlProvider().parseFile({ module, contentHash: "h", text, ...(depth === undefined ? {} : { depth }) });
}

describe("parsing", () => {
	const text = "# a note\nserver:\n  port: 8080\n";

	it("answers declarations, literals and comments together", () => {
		const facts = parse("a.yml", text);
		expect(facts.declarations.map((d) => d.name)).toEqual(["server", "port"]);
		expect(facts.literals.map((l) => l.value)).toEqual(["8080"]);
		expect(facts.comments.map((c) => c.text)).toEqual(["# a note"]);
	});

	it("drops literals and comments at a shallow depth", () => {
		const facts = parse("a.yml", text, "outline");
		expect(facts.declarations).toHaveLength(2);
		expect(facts.literals).toEqual([]);
		expect(facts.comments).toEqual([]);
	});

	it("gives every reported span a range that cuts its own text", () => {
		const facts = parse("a.yml", text);
		const coordinates = coordinatesOf(text);
		for (const comment of facts.comments) expect(coordinates.sliceRange(comment.range)).toBe(comment.text);
		for (const declaration of facts.declarations)
			expect(
				coordinates.sliceRange(declaration.selectionRange as NonNullable<typeof declaration.selectionRange>),
			).toBe(declaration.name);
	});

	it("reports a diagnostic rather than throwing on text that cannot parse", () => {
		expect(parse("a.yml", "a: [1,\n").diagnostics.length).toBeGreaterThan(0);
	});
});

describe("discovery", () => {
	it("finds both extensions and skips excluded directories", () => {
		const root = workspace({
			"a.yml": "a: 1\n",
			"nested/b.yaml": "b: 2\n",
			"node_modules/c.yml": "c: 3\n",
			"d.txt": "not mine\n",
		});
		expect(new YamlProvider().discoverProject(root).files).toEqual(["a.yml", "nested/b.yaml"]);
	});

	it("reports a diagnostic for a root that is not there", () => {
		const model = new YamlProvider().discoverProject(path.join(tmpdir(), "lexicon-absent-root"));
		expect(model.files).toEqual([]);
		expect(model.diagnostics).toHaveLength(1);
	});
});

describe("contract", () => {
	it("carries a reason on every tier it does not answer, rather than an absence", () => {
		const provider = new YamlProvider();
		expect(TIERS.docs).toBe(false);

		const binding = provider.bind({ module: "a.yml", name: "x" });
		expect(binding.status === "unbound" && binding.reason).toBe("NotImplemented");

		const resolved = provider.resolveImport({ fromModule: "a.yml", specifier: "./b" });
		expect(resolved.status === "unresolved" && resolved.reason).toBe("NotImplemented");

		const type = provider.typeOf({ symbolId: "x" });
		expect(type.status === "unknown" && type.reason).toBe("NotImplemented");
	});
});
