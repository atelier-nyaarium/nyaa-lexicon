import { coordinatesOf } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";
import { readYaml, readYamlComments } from "../yaml.js";

function read(text: string) {
	const coordinates = coordinatesOf(text);
	return {
		...readYaml({ language: "yaml", module: "a.yml", text, offset: 0, coordinates }),
		comments: readYamlComments(text, 0, coordinates),
		coordinates,
	};
}

function names(text: string): string[] {
	return read(text).declarations.map((declaration) => declaration.name);
}

function values(text: string): string[] {
	return read(text).literals.map((literal) => `${literal.kind}:${literal.value}`);
}

describe("keys", () => {
	it("names every key, nested by container", () => {
		const facts = read("meta:\n  owner: nyaa\n");
		expect(facts.declarations.map((d) => d.name)).toEqual(["meta", "owner"]);
		const [meta, owner] = facts.declarations;
		expect(owner?.containerId).toBe(meta?.symbolId);
		expect(meta?.containerId).toBeUndefined();
	});

	it("keeps a key whose value it cannot hold", () => {
		expect(names("empty:\nblob: !!binary aGk=\nkept: 1\n")).toEqual(["empty", "blob", "kept"]);
		expect(values("empty:\nblob: !!binary aGk=\nkept: 1\n")).toEqual(["number:1"]);
	});

	it("adds no declaration for a sequence element", () => {
		expect(names("tags:\n  - alpha\n  - beta\n")).toEqual(["tags"]);
		expect(values("tags:\n  - alpha\n  - beta\n")).toEqual(["string:alpha", "string:beta"]);
	});

	it("declares the keys inside a sequence element", () => {
		expect(names("steps:\n  - run: build\n    shell: sh\n")).toEqual(["steps", "run", "shell"]);
	});

	it("tells sibling elements apart, so a repeated key is not one symbol", () => {
		const ids = read("items:\n  - name: a\n  - name: b\n").declarations.map((d) => d.symbolId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("spans a sequence-valued key through its value", () => {
		const facts = read("tags: [alpha, beta]\n");
		expect(facts.coordinates.sliceRange(facts.declarations[0]?.range as never)).toBe("tags: [alpha, beta]");
	});

	it("reads every document, and a second one is not an error", () => {
		const facts = read("first: 1\n---\nsecond: 2\n");
		expect(facts.declarations.map((d) => d.name)).toEqual(["first", "second"]);
		expect(facts.diagnostics).toEqual([]);
	});

	it("keeps same-named keys in different documents apart", () => {
		const ids = read("a: 1\n---\na: 2\n").declarations.map((d) => d.symbolId);
		expect(new Set(ids).size).toBe(2);
	});

	it("leaves a single document's ids unprefixed", () => {
		expect(read("a: 1\n").declarations[0]?.symbolId).not.toContain("[0]");
	});

	it("reads a file whose root is a sequence", () => {
		expect(names("- name: a\n- name: b\n")).toEqual(["name", "name"]);
		expect(values("- one\n- 2\n- true\n")).toEqual(["string:one", "number:2", "boolean:true"]);
	});

	it("reads a file whose root is a scalar", () => {
		expect(values("just a string\n")).toEqual(["string:just a string"]);
	});

	it("resolves an alias without repeating the anchored value", () => {
		const facts = read("base: &b value\nuse: *b\n");
		expect(facts.declarations.map((d) => d.name)).toEqual(["base", "use"]);
		expect(facts.literals.map((l) => l.value)).toEqual(["value"]);
	});

	it("reads a timestamp as the string the file holds", () => {
		expect(values("when: 2020-01-01\n")).toEqual(["string:2020-01-01"]);
	});

	it("decides on the resolved value, not the tag", () => {
		expect(values("a: !!str hello\n")).toEqual(["string:hello"]);
		expect(values("b: !!int 7\n")).toEqual(["number:7"]);
		expect(values("c: !custom thing\n")).toEqual(["string:thing"]);
		expect(values("d: !!timestamp 2020-01-01\n")).toEqual([]);
		expect(names("d: !!timestamp 2020-01-01\n")).toEqual(["d"]);
	});
});

describe("comments", () => {
	it("takes a marker inside a scalar as content", () => {
		const text = 'a: 1 # real\nb: "not # a comment"\nc: |\n  # not one either\n';
		expect(read(text).comments.map((c) => c.text)).toEqual(["# real"]);
	});

	it("gives every comment a range that cuts its own text", () => {
		const text = "# leading\na: 1 # trailing\n\n# standalone\n";
		const facts = read(text);
		for (const comment of facts.comments) expect(facts.coordinates.sliceRange(comment.range)).toBe(comment.text);
		expect(facts.comments).toHaveLength(3);
	});

	it("stops a comment before a carriage return", () => {
		expect(read("a: 1 # trailing\r\n").comments.map((c) => c.text)).toEqual(["# trailing"]);
	});
});

describe("failure", () => {
	it("reports a diagnostic for text that cannot parse", () => {
		expect(read("a: [1,\n").diagnostics.length).toBeGreaterThan(0);
	});

	it("reports nothing and no error for an empty document", () => {
		const facts = read("\n");
		expect(facts.declarations).toEqual([]);
		expect(facts.diagnostics).toEqual([]);
	});
});
