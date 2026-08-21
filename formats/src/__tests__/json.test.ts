import { coordinatesOf } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";
import { readJson } from "../json.js";

function read(text: string, lenient = false) {
	const coordinates = coordinatesOf(text);
	return {
		...readJson({ language: "json", module: "a.json", text, offset: 0, coordinates, lenient }),
		coordinates,
	};
}

function names(text: string, lenient = false): string[] {
	return read(text, lenient).declarations.map((declaration) => declaration.name);
}

describe("keys", () => {
	it("names every key, nested by container", () => {
		const facts = read('{"meta": {"owner": "nyaa"}}');
		expect(facts.declarations.map((d) => d.name)).toEqual(["meta", "owner"]);
		const [meta, owner] = facts.declarations;
		expect(owner?.containerId).toBe(meta?.symbolId);
	});

	it("keeps a key whose value it cannot hold", () => {
		expect(names('{"empty": null, "kept": 1}')).toEqual(["empty", "kept"]);
		expect(read('{"empty": null, "kept": 1}').literals.map((l) => l.value)).toEqual(["1"]);
	});

	it("adds no declaration for an array element", () => {
		const facts = read('{"tags": ["alpha", "beta"]}');
		expect(facts.declarations.map((d) => d.name)).toEqual(["tags"]);
		expect(facts.literals.map((l) => l.value)).toEqual(["alpha", "beta"]);
	});

	it("tells sibling elements apart, so a repeated key is not one symbol", () => {
		const ids = read('{"items": [{"name": "a"}, {"name": "b"}]}').declarations.map((d) => d.symbolId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("reads a file whose root is an array", () => {
		expect(names('[{"name": "a"}, {"name": "b"}]')).toEqual(["name", "name"]);
		expect(read('["one", 2, true]').literals.map((l) => `${l.kind}:${l.value}`)).toEqual([
			"string:one",
			"number:2",
			"boolean:true",
		]);
	});

	it("reads a file whose root is a scalar", () => {
		expect(read('"lonely"').literals.map((l) => l.value)).toEqual(["lonely"]);
	});

	it("spans the key as written, quotes included", () => {
		const facts = read('{"a": 1}');
		expect(facts.coordinates.sliceRange(facts.declarations[0]?.selectionRange as never)).toBe('"a"');
	});

	it("carries the parents it was given, so a record keeps its own path", () => {
		const text = '{"a": 1}';
		const facts = readJson({
			language: "json",
			module: "a.jsonl",
			text,
			offset: 0,
			coordinates: coordinatesOf(text),
			lenient: false,
			parents: [{ kind: "namespace", name: "[0]" }],
		});
		expect(facts.declarations[0]?.symbolId).toContain("[0]");
	});
});

describe("dialect", () => {
	const commented = '{\n\t// nope\n\t"a": 1\n}\n';

	it("refuses a comment in the strict dialect", () => {
		expect(read(commented).diagnostics.length).toBeGreaterThan(0);
		expect(read(commented).comments).toEqual([]);
	});

	it("accepts and reports a comment in the lenient one", () => {
		const facts = read(commented, true);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.comments.map((c) => c.text)).toEqual(["// nope"]);
	});

	it("refuses a trailing comma only in the strict dialect", () => {
		expect(read('{"a": 1,}').diagnostics.length).toBeGreaterThan(0);
		expect(read('{"a": 1,}', true).diagnostics).toEqual([]);
	});

	it("gives every comment a range that cuts its own text", () => {
		const facts = read('// leading\n{\n\t"a": 1 /* inline */\n}\n', true);
		for (const comment of facts.comments) expect(facts.coordinates.sliceRange(comment.range)).toBe(comment.text);
		expect(facts.comments).toHaveLength(2);
	});

	it("takes a marker inside a string as content", () => {
		expect(read('{"url": "https://example.com/p"}', true).comments).toEqual([]);
	});
});

describe("failure", () => {
	it("keeps an unterminated block comment inside its own text", () => {
		const text = "{} /*";
		const facts = read(text, true);
		for (const comment of facts.comments) expect(facts.coordinates.sliceRange(comment.range)).toBe(comment.text);
		for (const diagnostic of facts.diagnostics)
			expect(diagnostic.range?.end.character).toBeLessThanOrEqual(text.length);
	});

	it("reports nothing and no error for an empty document", () => {
		const facts = read("\n");
		expect(facts.declarations).toEqual([]);
		expect(facts.diagnostics).toEqual([]);
	});
});
