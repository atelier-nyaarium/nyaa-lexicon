import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { JsonProvider, TIERS } from "../main.js";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-json-"));
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

function parse(module: string, text: string) {
	return new JsonProvider().parseFile({ module, contentHash: "h", text });
}

describe("line-delimited records", () => {
	const text = '{"a": 1}\n{"a": 2}\n';

	it("gives each record its own path, so keys do not collide", () => {
		const ids = parse("log.jsonl", text).declarations.map((d) => d.symbolId);
		expect(new Set(ids).size).toBe(2);
		expect(ids[0]).toContain("[0]");
		expect(ids[1]).toContain("[1]");
	});

	it("addresses a later record against the file, not against its own line", () => {
		const facts = parse("log.jsonl", text);
		const coordinates = coordinatesOf(text);
		for (const declaration of facts.declarations)
			expect(coordinates.sliceRange(declaration.selectionRange)).toBe('"a"');
		expect(facts.declarations[1]?.selectionRange.start.line).toBe(1);
	});

	it("skips a blank line without spending an ordinal on it", () => {
		const ids = parse("log.ndjson", '{"a": 1}\n\n{"a": 2}\n').declarations.map((d) => d.symbolId);
		expect(ids[1]).toContain("[1]");
	});

	it("reports one record's failure without losing the others", () => {
		const facts = parse("log.jsonl", '{"a": 1}\n{oops\n{"a": 3}\n');
		expect(facts.diagnostics.length).toBeGreaterThan(0);
		expect(facts.declarations.length).toBeGreaterThanOrEqual(2);
	});
});

describe("dialect by extension", () => {
	it("treats a whole-file object as one root", () => {
		expect(parse("data.json", '{"a": 1}\n').declarations).toHaveLength(1);
	});

	it("drops literals and comments at a shallow depth", () => {
		const facts = new JsonProvider().parseFile({
			module: "data.jsonc",
			contentHash: "h",
			text: '{\n\t// note\n\t"a": 1\n}\n',
			depth: "outline",
		});
		expect(facts.declarations).toHaveLength(1);
		expect(facts.literals).toEqual([]);
		expect(facts.comments).toEqual([]);
	});

	it("reads a comment under any extension, noting it only where the dialect lacks one", () => {
		const commented = '{\n\t// note\n\t"a": 1\n}\n';
		const jsonc = parse("a.jsonc", commented);
		expect(jsonc.comments.map((c) => c.text)).toEqual(["// note"]);
		expect(jsonc.diagnostics).toEqual([]);

		const json = parse("a.json", commented);
		expect(json.declarations.map((d) => d.name)).toEqual(["a"]);
		expect(json.comments.map((c) => c.text)).toEqual(["// note"]);
		expect(json.diagnostics.map((d) => [d.severity, d.message])).toEqual([
			["info", expect.stringContaining("1 comment")],
		]);
	});
});

describe("discovery", () => {
	it("finds every claimed extension and skips excluded directories", () => {
		const root = workspace({
			"a.json": "{}\n",
			"b.jsonc": "{}\n",
			"nested/c.jsonl": '{"a":1}\n',
			"d.ndjson": '{"a":1}\n',
			"node_modules/e.json": "{}\n",
			"f.json5": "{}\n",
		});
		expect(new JsonProvider().discoverProject(root).files).toEqual([
			"a.json",
			"b.jsonc",
			"d.ndjson",
			"nested/c.jsonl",
		]);
	});

	it("reports a diagnostic for a root that is not there", () => {
		const model = new JsonProvider().discoverProject(path.join(tmpdir(), "lexicon-absent-root"));
		expect(model.files).toEqual([]);
		expect(model.diagnostics).toHaveLength(1);
	});
});

describe("contract", () => {
	it("carries a reason on every tier it does not answer, rather than an absence", () => {
		const provider = new JsonProvider();
		expect(TIERS.docs).toBe(false);

		const binding = provider.bind({ module: "a.json", name: "x" });
		expect(binding.status === "unbound" && binding.reason).toBe("NotImplemented");

		const resolved = provider.resolveImport({ fromModule: "a.json", specifier: "./b" });
		expect(resolved.status === "unresolved" && resolved.reason).toBe("NotImplemented");

		const type = provider.typeOf({ symbolId: "x" });
		expect(type.status === "unknown" && type.reason).toBe("NotImplemented");
	});
});
