import { describe, expect, it } from "bun:test";
import {
	assessSecretText,
	decideSecretText,
	mayHideSecret,
	type ReadableSecretRule,
} from "@nyaa-lexicon/protocol/secretDecision";
import type { SecretFormat } from "@nyaa-lexicon/protocol/secretSyntax";
import { dotenvFormat, jsonFormat, yamlFormat } from "../secret/index.js";
import {
	type CorpusName,
	contractViolations,
	expectationViolations,
	loadCorpus,
	prefilterViolations,
} from "./secretConformance.js";
import { EMBEDDED, SPELLED, type Spelling } from "./secretSpellings.js";

////////////////////////////////
//  Fixtures

const FORMATS: Record<CorpusName, SecretFormat> = { dotenv: dotenvFormat, json: jsonFormat, yaml: yamlFormat };

function ruleOf(name: string): ReadableSecretRule {
	return { matchers: [{ [name]: "redact" }] } as unknown as ReadableSecretRule;
}

function whole(text: string) {
	return { start: 0, end: text.length };
}

function labeled(entry: Spelling): string {
	return `${entry.id} ${JSON.stringify(entry.name)} in ${JSON.stringify(entry.text)}`;
}

/** Bare whole-name spellings only. */
function literalWords(format: SecretFormat): SecretFormat {
	return {
		...format,
		mayName: (text, span, names) =>
			names.some((name) => {
				for (
					let at = text.indexOf(name, span.start);
					at !== -1 && at + name.length <= span.end;
					at = text.indexOf(name, at + 1)
				)
					if (!/\w/.test(text[at - 1] ?? "") && !/\w/.test(text[at + name.length] ?? "")) return true;
				return false;
			}),
	};
}

/** Quoted names under strict parsing. */
function quotedNames(format: SecretFormat): SecretFormat {
	return {
		...format,
		mayName: (text, span, names) =>
			names.some((name) => text.slice(span.start, span.end).includes(`"${name}"`)) ||
			text.slice(span.start, span.end).includes("\\"),
	};
}

function time(run: () => void): number {
	let best = Number.POSITIVE_INFINITY;
	for (let round = 0; round < 4; round++) {
		const started = performance.now();
		run();
		best = Math.min(best, performance.now() - started);
	}
	return best;
}

////////////////////////////////
//  Tests

describe("secret prefilter", () => {
	it("finds every way a reader spells a key", () => {
		const found: string[] = [];
		for (const entry of SPELLED) {
			const format = FORMATS[entry.id];
			const rule = ruleOf(entry.name);
			if (!format.mayName(entry.text, whole(entry.text), [entry.name])) found.push(`${labeled(entry)} is denied`);
			if (!mayHideSecret(format, rule, entry.text)) found.push(`${labeled(entry)} is skipped`);
			if (decideSecretText(format, rule, entry.text).kind === "plain")
				found.push(`${labeled(entry)} is not selected by the reader`);
		}

		expect(SPELLED.length).toBeGreaterThan(0);
		expect(found).toEqual([]);
	});

	it("skips a name that only sits inside another word or a value", () => {
		const found: string[] = [];
		for (const entry of EMBEDDED) {
			const format = FORMATS[entry.id];
			const rule = ruleOf(entry.name);
			if (format.mayName(entry.text, whole(entry.text), [entry.name])) found.push(`${labeled(entry)} is found`);
			if (mayHideSecret(format, rule, entry.text)) found.push(`${labeled(entry)} is not skipped`);
			if (assessSecretText(format, rule, entry.text).kind !== "plain")
				found.push(`${labeled(entry)} is not plain`);
			if (decideSecretText(format, rule, entry.text).kind !== "plain")
				found.push(`${labeled(entry)} is selected by the reader`);
		}

		expect(EMBEDDED.length).toBeGreaterThan(0);
		expect(found).toEqual([]);
	});

	it("reads context from the whole text and the name from the span", () => {
		const embedded: Array<[CorpusName, string, string]> = [
			["dotenv", "DATA", "METADATA=1"],
			["json", "data", '{"metadata":1}'],
			["yaml", "data", "metadata: 1"],
		];
		const alone: Array<[CorpusName, string, string]> = [
			["dotenv", "DATA", "DATA=1"],
			["json", "data", '{"data":1}'],
			["yaml", "data", "data: 1"],
		];

		for (const [id, name, text] of embedded) {
			const at = text.indexOf(name);
			expect(FORMATS[id].mayName(text, { start: at, end: at + name.length }, [name]), text).toBe(false);
		}
		for (const [id, name, text] of alone) {
			const at = text.indexOf(name);
			expect(FORMATS[id].mayName(text, { start: at, end: at + name.length }, [name]), text).toBe(true);
			expect(FORMATS[id].mayName(text, { start: at, end: at + name.length - 1 }, [name]), text).toBe(false);
		}
	});

	it("takes an undefined escape as any name and a defined one as the name it spells", () => {
		const undefinedEscape = '{"x": "a\\qb"}';
		const definedEscapes = '{"x": "a\\nb\\u0063\\"d"}';

		expect(jsonFormat.mayName(undefinedEscape, whole(undefinedEscape), ["zzz"])).toBe(true);
		expect(jsonFormat.mayName(definedEscapes, whole(definedEscapes), ["zzz"])).toBe(false);
		expect(jsonFormat.mayName(definedEscapes, whole(definedEscapes), ["x"])).toBe(true);
	});

	it("reads a text in time linear in its size", () => {
		const rule = ruleOf("data");
		const shapes: Array<[CorpusName, (count: number) => string]> = [
			["json", (count) => `{"a":"${"x \\n".repeat(count)}"}`],
			["json", (count) => `{"a":"${"metadata ".repeat(count)}"}`],
			["json", (count) => `["${"\\u0064\\u0061 ".repeat(count)}"]`],
			["json", (count) => `{"a":"${"\\ud83d\\ude00".repeat(count)}"}`],
			["json", (count) => `{"a":"${"\\\\d".repeat(count)}"}`],
			["yaml", (count) => `a: "${"x \\n".repeat(count)}"\n`],
			["yaml", (count) => "data-x: 1\n".repeat(count)],
			["yaml", (count) => `data${" ".repeat(count)}x`],
			["dotenv", (count) => "METADATA=1\n".repeat(count)],
		];

		for (const [id, shape] of shapes) {
			const small = shape(20_000);
			const large = shape(80_000);
			const smallTime = time(() => mayHideSecret(FORMATS[id], rule, small));
			const largeTime = time(() => mayHideSecret(FORMATS[id], rule, large));

			expect(largeTime / Math.max(smallTime, 1), `${id} ${small.slice(0, 24)}`).toBeLessThan(9);
		}
	});
});

describe("the prefilter checks", () => {
	const cases = (id: CorpusName) =>
		SPELLED.filter((entry) => entry.id === id).map((entry) => ({ name: labeled(entry), text: entry.text }));

	it("finds a prefilter that takes a name only as written", () => {
		const yaml = contractViolations(literalWords(yamlFormat), cases("yaml"));
		const json = contractViolations(literalWords(jsonFormat), cases("json"));

		expect(yaml.some((line) => line.includes(`"it's"`))).toBe(true);
		expect(yaml.some((line) => line.includes('"data"'))).toBe(true);
		expect(json.some((line) => line.includes('"data"'))).toBe(true);
	});

	it("finds a prefilter that knows only quoted names", () => {
		const found = loadCorpus("json").flatMap((entry) => expectationViolations(entry, quotedNames(jsonFormat)));

		expect(found.some((line) => line.includes("a skipped property"))).toBe(true);
	});

	it("finds a prefilter that skips what the decision selects", () => {
		const blind: SecretFormat = {
			...yamlFormat,
			mayName: (text, span, names) =>
				span.start !== 0 || span.end !== text.length ? yamlFormat.mayName(text, span, names) : false,
		};
		const found = prefilterViolations(blind, ruleOf("data"), [{ name: "key", text: "data: 1\n" }]);

		expect(found).toHaveLength(1);
		expect(prefilterViolations(yamlFormat, ruleOf("data"), [{ name: "key", text: "data: 1\n" }])).toEqual([]);
	});
});
