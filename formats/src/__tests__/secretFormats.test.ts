import { describe, expect, it } from "bun:test";
import type { ReadableSecretRule } from "@nyaa-lexicon/protocol/secretDecision";
import type { ScalarReading, SecretFormat } from "@nyaa-lexicon/protocol/secretSyntax";
import { ruleFor } from "../../../protocol/src/__tests__/fixtures/secrets/judge.js";
import { dotenvFormat, jsonFormat, yamlFormat } from "../secret/index.js";
import {
	type CorpusName,
	contractViolations,
	expectationViolations,
	fuzzCases,
	fuzzViolations,
	loadCorpus,
	prefilterViolations,
	providerNames,
	random,
} from "./secretConformance.js";
import { anchoredTexts, grammarTexts, hashTexts } from "./secretGrammar.js";
import {
	checkScenario,
	dotenvReadings,
	leafScenario,
	leakViolations,
	shellReadings,
	textLeaks,
} from "./secretOracles.js";
import { EMBEDDED, SPELLED } from "./secretSpellings.js";

////////////////////////////////
//  Fixtures

const FORMATS = [
	["dotenv", dotenvFormat],
	["json", jsonFormat],
	["yaml", yamlFormat],
] as const;

const FUZZ_ROUNDS = 1500;
const ORACLE_ROUNDS = 3000;
const GRAMMAR_ROUNDS = 3000;
const BUILT_ROUNDS = 1200;
const GRAMMAR_NAMES = ["data", "stringData", "it's", "to ken", "d a", 'a"b'];

function ruleOf(name: string): ReadableSecretRule {
	return { matchers: [{ [name]: "redact" }] } as unknown as ReadableSecretRule;
}

/** Rewrites its nodes after every read. */
function rewritten(
	format: SecretFormat,
	edit: (node: ReturnType<SecretFormat["read"]>["documents"][number]["nodes"][number]) => typeof node,
): SecretFormat {
	return {
		...format,
		read(text) {
			return {
				documents: format.read(text).documents.map((document) => ({
					...document,
					nodes: document.nodes.map((node, at) => (at === 0 ? node : edit(node))),
				})),
			};
		},
	};
}

////////////////////////////////
//  Tests

describe.each(FORMATS)("%s secret format", (id, format) => {
	const corpus = loadCorpus(id as CorpusName);
	const provider = id === "dotenv" ? undefined : (text: string) => providerNames(id, text);
	const spellings = [...SPELLED, ...EMBEDDED].filter((entry) => entry.id === id);
	const seeds = [...corpus.map((entry) => entry.text), ...spellings.map((entry) => entry.text)];

	it("decides every corpus entry as expected", () => {
		expect(corpus.length).toBeGreaterThan(0);
		expect(corpus.flatMap((entry) => expectationViolations(entry))).toEqual([]);
	});

	it("accounts for every byte of the corpus", () => {
		const cases = corpus.map(({ name, text }) => ({ name, text }));
		expect(contractViolations(format, cases, provider)).toEqual([]);
	});

	it("accounts for every byte of mutated corpus texts", () => {
		expect(fuzzViolations(format, seeds, FUZZ_ROUNDS, 1, provider).slice(0, 5)).toEqual([]);
	});

	it("hides what an independent reader takes as selected", () => {
		for (const scenario of [leafScenario(id as CorpusName), checkScenario(id as CorpusName)])
			expect(leakViolations(format, id as CorpusName, scenario, seeds, ORACLE_ROUNDS, 1).slice(0, 3)).toEqual([]);
	});

	it("accounts for every spelling of a generated key", () => {
		const cases = grammarTexts(id as CorpusName, GRAMMAR_ROUNDS, 3).map((text, at) => ({
			name: `grammar 3/${at}`,
			text,
		}));

		// Corpus fuzz covers odd bytes; this grades names only.
		expect(
			contractViolations(format, cases)
				.filter((found) => !found.includes("residual"))
				.slice(0, 3),
		).toEqual([]);
		for (const name of GRAMMAR_NAMES)
			expect(prefilterViolations(format, ruleOf(name), cases).slice(0, 3), name).toEqual([]);
	});

	it("finds in a wider span whatever a narrower one finds", () => {
		const next = random(5);
		const found: string[] = [];
		for (const { text } of fuzzCases(seeds, FUZZ_ROUNDS, 4)) {
			for (const name of new Set(spellings.map((entry) => entry.name))) {
				if (format.mayName(text, { start: 0, end: text.length }, [name])) continue;
				for (let round = 0; round < 3; round++) {
					const first = Math.floor(next() * (text.length + 1));
					const second = Math.floor(next() * (text.length + 1));
					const span = { start: Math.min(first, second), end: Math.max(first, second) };
					if (format.mayName(text, span, [name]))
						found.push(
							`${id} ${JSON.stringify(name)} in ${JSON.stringify(text)} over ${span.start}-${span.end}`,
						);
				}
			}
		}

		expect(found.slice(0, 3)).toEqual([]);
	});

	it("never prefilters away a text the decision selects from", () => {
		const rules = [
			...(id === "dotenv" ? [] : [ruleFor(`deploy/all.${id}`, {}, false) as ReadableSecretRule]),
			...[...new Set(spellings.map((entry) => entry.name))].map(ruleOf),
		];
		const cases = fuzzCases(seeds, FUZZ_ROUNDS, 2);

		for (const rule of rules) expect(prefilterViolations(format, rule, cases).slice(0, 3)).toEqual([]);
	});
});

describe.each([
	["dotenv", dotenvFormat, hashTexts],
	["yaml", yamlFormat, anchoredTexts],
] as const)("%s documents built to disagree", (id, format, build) => {
	it("hides what an independent reader takes as selected", () => {
		const built = build(BUILT_ROUNDS, 1);

		for (const scenario of [leafScenario(id), checkScenario(id)]) {
			expect(textLeaks(format, id, scenario, built, 1).slice(0, 3)).toEqual([]);
			expect(leakViolations(format, id, scenario, built.slice(0, 200), BUILT_ROUNDS, 2).slice(0, 3)).toEqual([]);
		}
	});
});

describe("the leak oracles", () => {
	it("read a text as dotenv-js and a shell do", () => {
		const names = (readings: ReturnType<typeof dotenvReadings>) => readings.map((reading) => reading.name);

		expect(names(dotenvReadings("X-Y:\r\nA\n=x"))).toEqual(["X-Y"]);
		expect(dotenvReadings("A=\r\nB=1")[0]?.key).toEqual({ start: 4, end: 5 });
		expect(names(shellReadings("x#;A=1\n"))).toEqual(["A"]);
		expect(names(shellReadings("DATA = #c x;DATA=3\n"))).toEqual([]);
	});
});

describe("the conformance suite", () => {
	const cases = (id: CorpusName) => loadCorpus(id).map(({ name, text }) => ({ name, text }));

	it("finds a reader that drops a value", () => {
		for (const [id, format] of FORMATS) {
			const dropped = rewritten(format, (node) =>
				node.children.length === 0 && node.value.end - node.value.start > 3
					? { ...node, value: { start: node.value.end, end: node.value.end } }
					: node,
			);
			expect(
				contractViolations(dropped, cases(id)).some((found) => found.includes("residual")),
				id,
			).toBe(true);
		}
	});

	it("finds a reader that leaves out the provider's spelling of a key", () => {
		const sourceOnly = rewritten(yamlFormat, (node) => ({ ...node, names: node.names.slice(-1) }));
		const found = contractViolations(sourceOnly, cases("yaml"), (text) => providerNames("yaml", text));

		expect(found.some((entry) => entry.includes('provider name "10"'))).toBe(true);
	});

	it("finds a prefilter that ignores escapes", () => {
		const blind: SecretFormat = {
			...jsonFormat,
			mayName: (text, span, names) => names.some((name) => text.slice(span.start, span.end).includes(name)),
		};
		const found = contractViolations(blind, cases("json"));

		expect(found.some((entry) => entry.includes("prefilter skips") && entry.includes("data"))).toBe(true);
	});

	it("finds a reader that decides what its consumers disagree on", () => {
		let last = "";
		const bold: SecretFormat = {
			...dotenvFormat,
			read(text) {
				last = text;
				return dotenvFormat.read(text);
			},
			scalar(document, at): ScalarReading {
				const node = document.nodes[at];
				return { kind: "decided", value: last.slice(node?.value.start, node?.value.end), empty: false };
			},
		};
		const found = loadCorpus("dotenv").flatMap((entry) => expectationViolations(entry, bold));

		expect(found.length).toBeGreaterThan(0);
	});

	it("finds a reader that takes every hash as a comment", () => {
		const lax: SecretFormat = {
			...dotenvFormat,
			read: (text) => dotenvFormat.read(text.replace(/#[^\n]*/g, (comment) => " ".repeat(comment.length))),
		};
		const found = [leafScenario("dotenv"), checkScenario("dotenv")].flatMap((scenario) =>
			textLeaks(lax, "dotenv", scenario, hashTexts(BUILT_ROUNDS, 1), 1),
		);

		expect(found.length).toBeGreaterThan(0);
	});

	it("finds a reader that forgets what an alias reads", () => {
		const blind = rewritten(yamlFormat, (node) => ({ ...node, via: [] }));
		const seeds = [...loadCorpus("yaml").map((entry) => entry.text), ...anchoredTexts(100, 1)];
		const found = [leafScenario("yaml"), checkScenario("yaml")].flatMap((scenario) =>
			leakViolations(blind, "yaml", scenario, seeds, ORACLE_ROUNDS, 1),
		);

		expect(found.length).toBeGreaterThan(0);
	});
});
