import { describe, expect, it } from "bun:test";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
import { readJson } from "../json.js";
import { readYaml } from "../yaml.js";

/** The same situation in either format, so the two readers can be compared rather than trusted. */
function bothOn(yamlText: string, jsonText: string) {
	return {
		yaml: readYaml({
			language: "yaml",
			module: "a.yml",
			text: yamlText,
			offset: 0,
			coordinates: coordinatesOf(yamlText),
		}).diagnostics,
		json: readJson({
			language: "json",
			module: "a.json",
			text: jsonText,
			offset: 0,
			coordinates: coordinatesOf(jsonText),
			strict: true,
		}).diagnostics,
	};
}

describe("a dropped key is worded the same in every reader", () => {
	it("agrees on a repeated key", () => {
		const { yaml, json } = bothOn("a: 1\na: 2\n", '{"a": 1, "a": 2}');
		const repeated = (list: typeof yaml) => list.filter((d) => d.message.includes("more than once"));
		expect(repeated(yaml)).toHaveLength(1);
		expect(repeated(json)).toHaveLength(1);
		expect(repeated(yaml)[0]?.severity).toBe(repeated(json)[0]?.severity);
		expect(repeated(yaml)[0]?.message).toBe(repeated(json)[0]?.message);
	});

	it("agrees on a key with no name", () => {
		const { yaml, json } = bothOn('"": one\n', '{"": 1}');
		expect(yaml).toHaveLength(1);
		expect(json).toHaveLength(1);
		expect(yaml[0]?.severity).toBe(json[0]?.severity);
		expect(yaml[0]?.message).toBe(json[0]?.message);
	});

	it("agrees on nesting too deep to index", () => {
		const depth = 200_000;
		const { yaml, json } = bothOn(
			`a: ${"[".repeat(depth)}1${"]".repeat(depth)}\n`,
			`${"[".repeat(depth)}1${"]".repeat(depth)}`,
		);
		const deep = (list: typeof yaml) => list.filter((d) => d.message.includes("too deeply"));
		expect(deep(yaml)).toHaveLength(1);
		expect(deep(json)).toHaveLength(1);
		expect(deep(yaml)[0]?.severity).toBe(deep(json)[0]?.severity);
		expect(deep(yaml)[0]?.message).toBe(deep(json)[0]?.message);
	});
});
