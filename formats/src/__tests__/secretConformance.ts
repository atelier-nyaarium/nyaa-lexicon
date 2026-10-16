// Broken readers test each conformance check.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type OffsetRange, type SecretsConfig, SecretsConfigSchema } from "@nyaa-lexicon/protocol";
import {
	applySecretMask,
	assessSecretText,
	decideSecretText,
	mayHideSecret,
	type ReadableSecretRule,
	type SecretDecision,
} from "@nyaa-lexicon/protocol/secretDecision";
import { SecretBudgetError, type SecretFormat, verifySecretSyntax } from "@nyaa-lexicon/protocol/secretSyntax";
import { parseTree } from "jsonc-parser/lib/esm/main.js";
import { isMap, isPair, isScalar, isSeq, parseAllDocuments } from "yaml";
import { answerFor } from "../../../protocol/src/__tests__/fixtures/secrets/judge.js";
import { type RegisteredSecretFormat, secretFormatFor } from "../secret/index.js";

////////////////////////////////
//  Interfaces & Types

export type CorpusName = "dotenv" | "json" | "yaml";

export interface CorpusEntry {
	name: string;
	path: string;
	config: SecretsConfig;
	untracked: boolean;
	text: string;
	decision: SecretDecision["kind"];
	shown?: string[];
	empty?: string[];
	hidden?: string[];
	visible?: string[];
}

interface RawEntry extends Omit<CorpusEntry, "text"> {
	text: string | string[];
}

export interface ReadCase {
	name: string;
	text: string;
}

////////////////////////////////
//  Corpus

const FIXTURES = join(import.meta.dirname, "../../../protocol/src/__tests__/fixtures/secrets/decisions");

/**
 * Expands `{BOM}` and `{LS}`; joins line arrays.
 */
function textOf(text: string | string[]): string {
	return (Array.isArray(text) ? text.join("\n") : text)
		.replaceAll("{BOM}", "\u{FEFF}")
		.replaceAll("{LS}", "\u{2028}");
}

export function loadCorpus(name: CorpusName): CorpusEntry[] {
	const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as RawEntry[];
	return raw.map((entry) => ({
		...entry,
		config: SecretsConfigSchema.parse(entry.config),
		text: textOf(entry.text),
	}));
}

/** Policy rule for an entry, or null. */
export function ruleOf(entry: CorpusEntry): ReadableSecretRule | null {
	const answer = answerFor(entry.path, entry.config, entry.untracked);
	if (answer.kind === "plain") return null;
	if (answer.kind === "omit") throw new Error(`${entry.name}: omitted files have no decision`);
	return answer.rule as ReadableSecretRule;
}

export function formatOf(entry: CorpusEntry): RegisteredSecretFormat {
	const format = secretFormatFor(entry.path);
	if (format === null) throw new Error(`${entry.name}: no secret format for ${entry.path}`);
	return format;
}

export function decide(entry: CorpusEntry, format: SecretFormat = formatOf(entry)): SecretDecision {
	const rule = ruleOf(entry);
	return rule === null ? { kind: "plain" } : assessSecretText(format, rule, entry.text);
}

function shownPaths(decision: SecretDecision): string[] {
	return decision.kind === "redacted" ? decision.shown.map((key) => key.path.join(".")) : [];
}

/** Entry expectation violations. */
export function expectationViolations(entry: CorpusEntry, format: SecretFormat = formatOf(entry)): string[] {
	const found: string[] = [];
	const decision = decide(entry, format);
	if (decision.kind !== entry.decision) return [`${entry.name}: expected ${entry.decision}, got ${decision.kind}`];
	if (decision.kind !== "redacted") return found;
	const view = applySecretMask(entry.text, decision.mask);
	for (const hidden of entry.hidden ?? []) {
		if (!entry.text.includes(hidden)) found.push(`${entry.name}: ${JSON.stringify(hidden)} is not in the text`);
		else if (view.includes(hidden)) found.push(`${entry.name}: ${JSON.stringify(hidden)} stays visible`);
	}
	for (const visible of entry.visible ?? []) {
		if (!view.includes(visible)) found.push(`${entry.name}: ${JSON.stringify(visible)} is hidden`);
	}
	if (entry.shown !== undefined) {
		const shown = shownPaths(decision);
		if (JSON.stringify(shown) !== JSON.stringify(entry.shown))
			found.push(`${entry.name}: shown ${JSON.stringify(shown)}, expected ${JSON.stringify(entry.shown)}`);
	}
	if (entry.empty !== undefined) {
		const empty = decision.shown.filter((key) => key.status === "empty").map((key) => key.path.join("."));
		if (JSON.stringify(empty) !== JSON.stringify(entry.empty))
			found.push(`${entry.name}: empty ${JSON.stringify(empty)}, expected ${JSON.stringify(entry.empty)}`);
	}
	return found;
}

////////////////////////////////
//  Contract

/** Names the provider reads as keys. */
export function providerNames(id: CorpusName, text: string): string[] {
	const names = new Set<string>();
	if (id === "yaml") {
		const visit = (node: unknown, depth: number): void => {
			if (depth > 64) return;
			if (isMap(node)) {
				for (const pair of node.items) {
					if (!isPair(pair)) continue;
					// No declared merge or nameless key.
					if (isScalar(pair.key) && String(pair.key.value) !== "<<" && String(pair.key.value) !== "")
						names.add(String(pair.key.value));
					visit(pair.value, depth + 1);
				}
			} else if (isSeq(node)) {
				for (const item of node.items) visit(item, depth + 1);
			}
		};
		for (const document of parseAllDocuments(text)) visit(document.contents, 0);
	} else if (id === "json") {
		const visit = (node: ReturnType<typeof parseTree>, depth: number): void => {
			if (node === undefined || depth > 64) return;
			for (const child of node.children ?? []) {
				if (child.type === "property") {
					const [key, value] = child.children ?? [];
					if (key !== undefined && typeof key.value === "string") names.add(key.value);
					visit(value, depth + 1);
				} else {
					visit(child, depth + 1);
				}
			}
		};
		visit(parseTree(text, [], { allowTrailingComma: true, allowEmptyContent: true }), 0);
	}
	return [...names];
}

/** Matcher names that select nodes alone. */
function selectable(name: string): boolean {
	return name !== "" && !/[.=*@]/.test(name);
}

/**
 * Checks byte coverage, provider names, spellings, and prefilters.
 */
export function contractViolations(
	format: SecretFormat,
	cases: readonly ReadCase[],
	provider?: (text: string) => readonly string[],
): string[] {
	const found: string[] = [];
	if (!format.inert.sticky) found.push(`${format.id}: inert is not sticky`);
	for (const { name, text } of cases) {
		const label = `${format.id} ${name}`;
		const shown = JSON.stringify(text);
		let syntax: ReturnType<SecretFormat["read"]>;
		try {
			syntax = format.read(text);
		} catch (failure) {
			if (failure instanceof SecretBudgetError) continue;
			found.push(`${label}: read threw ${String(failure)}`);
			continue;
		}
		const verified = verifySecretSyntax(format, text, syntax);
		if (verified.residual > 0) found.push(`${label}: ${verified.residual} residual hazards in ${shown}`);
		const names = new Set<string>();
		const whole: OffsetRange = { start: 0, end: text.length };
		for (const document of syntax.documents) {
			document.nodes.forEach((node, at) => {
				if (at === 0) return;
				for (const spelled of node.names) names.add(spelled);
				const spelledAtKey =
					node.virtual || node.names.length === 0 || node.key.end <= node.key.start
						? true
						: format.mayName(text, node.key, node.names);
				if (!spelledAtKey)
					found.push(`${label}: mayName denies ${JSON.stringify(node.names)} at its own key in ${shown}`);
				const first = format.scalar(document, at);
				if (JSON.stringify(first) !== JSON.stringify(format.scalar(document, at)))
					found.push(`${label}: scalar of node ${at} changes between calls`);
			});
		}
		for (const spelled of provider?.(text) ?? []) {
			if (!names.has(spelled))
				found.push(`${label}: provider name ${JSON.stringify(spelled)} is not among the names in ${shown}`);
		}
		for (const spelled of names) {
			if (!selectable(spelled)) continue;
			const rule = { matchers: [{ [spelled]: "redact" }] } as ReadableSecretRule;
			if (!mayHideSecret(format, rule, text))
				found.push(`${label}: the prefilter skips a node named ${JSON.stringify(spelled)} in ${shown}`);
			else if (decideSecretText(format, rule, text).kind === "plain")
				found.push(`${label}: a node named ${JSON.stringify(spelled)} is not selected in ${shown}`);
			if (!format.mayName(text, whole, [spelled]))
				found.push(`${label}: mayName denies ${JSON.stringify(spelled)} over the whole text of ${shown}`);
		}
	}
	return found;
}

/**
 * Finds decided selections skipped by a prefilter.
 */
export function prefilterViolations(
	format: SecretFormat,
	rule: ReadableSecretRule,
	cases: readonly ReadCase[],
): string[] {
	const found: string[] = [];
	for (const { name, text } of cases) {
		if (mayHideSecret(format, rule, text)) continue;
		const decision = decideSecretText(format, rule, text);
		if (decision.kind !== "plain")
			found.push(
				`${format.id} ${name}: the prefilter skips a text decided ${decision.kind}: ${JSON.stringify(text)}`,
			);
	}
	return found;
}

////////////////////////////////
//  Fuzzing

export function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

const TOKENS = [
	'"',
	"'",
	"`",
	"\\",
	"{",
	"}",
	"[",
	"]",
	":",
	",",
	"#",
	"\n",
	"\r\n",
	"---",
	"...",
	"&a",
	"*a",
	"<<",
	"!!str",
	"?",
	"- ",
	"$(",
	"${",
	"$",
	"=",
	" ",
	"\t",
	";",
	"|",
	">",
	"~",
	"&",
	"export ",
	"kind: Secret",
	"data:",
	"\u0000",
	"\u{FEFF}",
	"\u{2028}",
	"\u{2029}",
	"%YAML 1.1\n",
	"/*",
	"*/",
	"//",
	'"\\u00',
	"\\x6",
	"<",
	">",
	"(",
	")",
	"TOKEN=",
	"PASSWORD:",
	"A=1 B=2",
	"token: x",
	"password: y",
	'"token":',
	"DATA:\n",
	"\r",
	"data",
	'"data"',
	"stringData",
	"meta",
	"\\x61",
	"\\u0061",
	"\\q",
	"''",
	"&a,",
	"-",
	".",
	"/",
	"_",
];

/** One random corpus mutation. */
export function mutate(text: string, next: () => number): string {
	const at = Math.floor(next() * (text.length + 1));
	const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T;
	switch (Math.floor(next() * 6)) {
		case 0:
			return text.slice(0, at) + text.slice(at + 1 + Math.floor(next() * 8));
		case 1:
			return text.slice(0, at) + pick(TOKENS) + text.slice(at);
		case 2:
			return text.slice(0, at) + pick(TOKENS) + text.slice(at + 1);
		case 3:
			return text.slice(0, at);
		case 4: {
			const lines = text.split("\n");
			const line = Math.floor(next() * lines.length);
			lines.splice(line, 0, lines[line] ?? "");
			return lines.join("\n");
		}
		default: {
			const lines = text.split("\n");
			const first = Math.floor(next() * lines.length);
			const second = Math.floor(next() * lines.length);
			[lines[first], lines[second]] = [lines[second] ?? "", lines[first] ?? ""];
			return lines.join("\n");
		}
	}
}

/** Seed texts with one to three edits. */
export function fuzzCases(seeds: readonly string[], rounds: number, seed: number): ReadCase[] {
	const next = random(seed);
	const cases: ReadCase[] = [];
	for (let round = 0; round < rounds; round++) {
		let text = seeds[Math.floor(next() * seeds.length)] as string;
		for (let edits = 0; edits < 1 + Math.floor(next() * 3); edits++) text = mutate(text, next);
		cases.push({ name: `fuzz ${seed}/${round}`, text });
	}
	return cases;
}

export function fuzzViolations(
	format: SecretFormat,
	seeds: readonly string[],
	rounds: number,
	seed: number,
	provider?: (text: string) => readonly string[],
): string[] {
	return contractViolations(format, fuzzCases(seeds, rounds, seed), provider);
}
