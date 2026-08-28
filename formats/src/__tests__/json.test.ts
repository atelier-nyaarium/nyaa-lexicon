import { describe, expect, it } from "bun:test";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
import { readJson } from "../json.js";

function read(text: string, strict = true) {
	const coordinates = coordinatesOf(text);
	return {
		...readJson({ language: "json", module: "a.json", text, offset: 0, coordinates, strict }),
		coordinates,
	};
}

function names(text: string, strict = true): string[] {
	return read(text, strict).declarations.map((declaration) => declaration.name);
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
			strict: true,
			parents: [{ kind: "namespace", name: "[0]" }],
		});
		expect(facts.declarations[0]?.symbolId).toContain("[0]");
	});
});

describe("dialect", () => {
	const commented = '{\n\t// nope\n\t"a": 1\n}\n';

	// Refusing loses the file; silence hides the dialect.
	it("reads a comment in the strict dialect, keeps the keys, and notes it once at info", () => {
		const facts = read(commented);
		expect(facts.declarations.map((d) => d.name)).toEqual(["a"]);
		expect(facts.comments.map((c) => c.text)).toEqual(["// nope"]);
		expect(facts.diagnostics).toEqual([
			{
				severity: "info",
				message: expect.stringContaining("1 comment"),
				path: "a.json",
				range: facts.comments[0]?.range,
			},
		]);
	});

	it("reads a comment in the lenient dialect with nothing to note", () => {
		const facts = read(commented, false);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.comments.map((c) => c.text)).toEqual(["// nope"]);
	});

	it("reads trailing commas, noting them once and only in the strict dialect", () => {
		const strict = read('{"a": [1,], "b": 2,}');
		expect(strict.declarations.map((d) => d.name)).toEqual(["a", "b"]);
		expect(strict.diagnostics.map((d) => [d.severity, d.message])).toEqual([
			["info", expect.stringContaining("2 trailing commas")],
		]);
		expect(strict.coordinates.sliceRange(strict.diagnostics[0]?.range as never)).toBe(",");
		expect(read('{"a": 1,}', false).diagnostics).toEqual([]);
	});

	it("does not take a comma before a string's closing quote for a trailing one", () => {
		expect(read('{"a": "x,", "b": [1, 2]}').diagnostics).toEqual([]);
	});

	it("tells a leading comma from a trailing one, and sees through a comment before the closer", () => {
		expect(read("[,]").diagnostics.map((d) => d.severity)).toEqual(["error"]);
		expect(read("[1, /* c */ ]").diagnostics.map((d) => d.message)).toEqual([
			expect.stringContaining("1 comment"),
			expect.stringContaining("1 trailing comma"),
		]);
	});

	it("addresses the file, not the record, when read at an offset", () => {
		const file = 'ignored\n{"a": 1,}';
		const coordinates = coordinatesOf(file);
		const facts = readJson({
			language: "json",
			module: "a.jsonl",
			text: '{"a": 1,}',
			offset: 8,
			coordinates,
			strict: true,
		});
		expect(coordinates.sliceRange(facts.diagnostics[0]?.range as never)).toBe(",");
	});

	it("gives every comment a range that cuts its own text", () => {
		const facts = read('// leading\n{\n\t"a": 1 /* inline */\n}\n', false);
		for (const comment of facts.comments) expect(facts.coordinates.sliceRange(comment.range)).toBe(comment.text);
		expect(facts.comments).toHaveLength(2);
	});

	it("takes a marker inside a string as content", () => {
		expect(read('{"url": "https://example.com/p"}').comments).toEqual([]);
	});
});

describe("failure", () => {
	it("keeps an unterminated block comment inside its own text", () => {
		const text = "{} /*";
		const facts = read(text, false);
		for (const comment of facts.comments) expect(facts.coordinates.sliceRange(comment.range)).toBe(comment.text);
		for (const diagnostic of facts.diagnostics)
			expect(diagnostic.range?.end.character).toBeLessThanOrEqual(text.length);
	});

	it("reports nothing and no error for an empty document", () => {
		const facts = read("\n");
		expect(facts.declarations).toEqual([]);
		expect(facts.diagnostics).toEqual([]);
	});

	it("diagnoses nesting too deep to index rather than throwing", () => {
		const depth = 200_000;
		const facts = read(`${"[".repeat(depth)}1${"]".repeat(depth)}`);
		expect(facts.diagnostics.length).toBeGreaterThan(0);
	});

	it("declares a repeated key once, warns, and keeps the value a reader would get", () => {
		const facts = read('{"a": 1, "a": 2}');
		expect(facts.declarations.map((d) => d.name)).toEqual(["a"]);
		expect(facts.literals.map((l) => l.value)).toEqual(["2"]);
		expect(facts.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
	});

	it("keeps a repeated key from silencing its siblings, at any depth", () => {
		expect(names('{"o": {"a": 1, "a": 2, "b": 3}}')).toEqual(["o", "a", "b"]);
	});

	it("says so when a key cannot be named, rather than reporting an empty file", () => {
		const facts = read('{"": 1}');
		expect(facts.declarations).toEqual([]);
		expect(facts.diagnostics.map((d) => d.severity)).toEqual(["info"]);
	});
});
