// Independent readers check mask coverage.

import type { OffsetRange } from "@nyaa-lexicon/protocol";
import { applySecretMask, assessSecretText, type ReadableSecretRule } from "@nyaa-lexicon/protocol/secretDecision";
import type { SecretFormat } from "@nyaa-lexicon/protocol/secretSyntax";
import { parseTree } from "jsonc-parser/lib/esm/main.js";
import { type Document, isAlias, isMap, isNode, isPair, isScalar, isSeq, parseAllDocuments } from "yaml";
import { ruleFor } from "../../../protocol/src/__tests__/fixtures/secrets/judge.js";
import { type CorpusName, mutate, random } from "./secretConformance.js";

////////////////////////////////
//  Interfaces & Types

interface Reading {
	name: string;
	key: OffsetRange;
	value: OffsetRange;
	/** Anchored nodes read by aliases. */
	reach?: OffsetRange[];
	/** Stream document index. */
	document: number;
	/** Key depth from the document root. */
	depth: number;
	/** Root key name or own name. */
	top?: string;
	/** Scalar text, or null. */
	scalar: string | null;
}

interface MustHide {
	spans: OffsetRange[];
}

export interface Scenario {
	name: string;
	rule: ReadableSecretRule;
	/** Hidden bytes from reader results. */
	required(readings: readonly Reading[]): MustHide[];
}

////////////////////////////////
//  Readers

const DOTENV_LINE =
	/(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/dgm;

const ASSIGNMENT = /(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=/y;

/** Shell word end across quoted continuations. */
function wordEnd(text: string, from: number): number {
	let at = from;
	while (at < text.length) {
		const char = text[at] as string;
		if (char === "\\") {
			at += 2;
		} else if (char === "'") {
			const close = text.indexOf("'", at + 1);
			at = close === -1 ? text.length : close + 1;
		} else if (char === '"' || char === "`") {
			at += 1;
			while (at < text.length && text[at] !== char) at += text[at] === "\\" ? 2 : 1;
			at += 1;
		} else if (" \t\n;&|<>()".includes(char)) {
			break;
		} else {
			at += 1;
		}
	}
	return Math.min(at, text.length);
}

/** Plain shell assignments in the text. */
export function shellReadings(text: string): Reading[] {
	const found: Reading[] = [];
	let at = 0;
	while (at < text.length) {
		const char = text[at] as string;
		if (char === " " || char === "\t" || char === "\n" || char === ";") {
			at += 1;
		} else if (char === "#") {
			while (at < text.length && text[at] !== "\n") at += 1;
		} else {
			ASSIGNMENT.lastIndex = at;
			const match = ASSIGNMENT.exec(text);
			if (match !== null) {
				const keyEnd = at + match[0].length - 1;
				const end = wordEnd(text, keyEnd + 1);
				const raw = text.slice(keyEnd + 1, end);
				found.push({
					name: match[1] as string,
					key: { start: keyEnd - (match[1] as string).length, end: keyEnd },
					value: { start: keyEnd + 1, end },
					document: 0,
					depth: 0,
					scalar: /^[\w./-]*$/.test(raw) ? raw : null,
				});
				at = Math.max(end, keyEnd + 1);
			} else {
				// Command words run to the line's hash comment.
				while (at < text.length && text[at] !== "\n" && text[at] !== ";") {
					if (text[at] === "#") {
						while (at < text.length && text[at] !== "\n") at += 1;
						break;
					}
					const end = wordEnd(text, at);
					at = end > at ? end : at + 1;
					while (text[at] === " " || text[at] === "\t") at += 1;
				}
			}
		}
	}
	return found;
}

/** LF-normalized text with original offsets. */
function normalized(text: string): { lines: string; origin: number[] } {
	const origin: number[] = [];
	let lines = "";
	for (let at = 0; at < text.length; at++) {
		origin.push(at);
		if (text[at] === "\r") {
			lines += "\n";
			if (text[at + 1] === "\n") at += 1;
		} else {
			lines += text[at];
		}
	}
	origin.push(text.length);
	return { lines, origin };
}

/** dotenv-js pairs from its own regular expression. */
export function dotenvReadings(text: string): Reading[] {
	const found: Reading[] = [];
	const { lines, origin } = normalized(text);
	const at = (offset: number) => origin[offset] as number;
	for (const match of lines.matchAll(DOTENV_LINE)) {
		const key = match.indices?.[1];
		const value = match.indices?.[2];
		if (key === undefined || value === undefined) continue;
		const raw = (match[2] as string).trim();
		const quoted = /^(['"`])(.*)\1$/s.exec(raw);
		found.push({
			name: match[1] as string,
			key: { start: at(key[0]), end: at(key[1]) },
			value: { start: at(value[0]), end: at(value[1]) },
			document: 0,
			depth: 0,
			scalar: quoted === null ? raw : (quoted[2] as string),
		});
	}
	return found;
}

/** Anchors read recursively through aliases. */
function aliasTargets(node: unknown, document: Document.Parsed): OffsetRange[] {
	const found: OffsetRange[] = [];
	const seen = new Set<unknown>();
	const walk = (item: unknown, depth: number): void => {
		if (depth > 200 || item == null || seen.has(item)) return;
		seen.add(item);
		if (isAlias(item)) {
			const target = item.resolve(document);
			if (target?.range != null) found.push({ start: target.range[0], end: target.range[1] });
			walk(target, depth + 1);
		} else if (isPair(item)) {
			walk(item.key, depth + 1);
			walk(item.value, depth + 1);
		} else if (isMap(item) || isSeq(item)) {
			for (const child of item.items) walk(child, depth + 1);
		}
	};
	walk(node, 0);
	return found;
}

/** Pairs read by YAML 1.2 and 1.1. */
function yamlReadings(text: string): Reading[] {
	const found: Reading[] = [];
	for (const options of [{ version: "1.2" }, { version: "1.1", merge: true }] as const) {
		parseAllDocuments(text, { ...options, uniqueKeys: false }).forEach((document, index) => {
			const readPair = (pair: unknown, depth: number, above: string): void => {
				if (!isPair(pair) || pair.key == null) return;
				const named = isAlias(pair.key) ? pair.key.resolve(document) : pair.key;
				if (!isScalar(named) || !isNode(pair.key) || pair.key.range == null) return;
				const key = pair.key.range;
				const value = pair.value;
				const target = isAlias(value) ? value.resolve(document) : value;
				const reach = aliasTargets(value, document);
				const top = depth === 0 ? String(named.value) : above;
				for (const item of [value, target]) {
					const range = isNode(item) ? item.range : null;
					if (range == null) continue;
					found.push({
						name: String(named.value),
						key: { start: key[0], end: key[1] },
						value: { start: range[0], end: range[1] },
						reach,
						document: index,
						depth,
						top,
						scalar: isScalar(target) ? String(target.value) : null,
					});
				}
				visit(value, depth + 1, top);
			};
			const visit = (node: unknown, depth: number, above: string): void => {
				if (depth > 200) return;
				if (isMap(node)) {
					for (const pair of node.items) readPair(pair, depth, above);
				} else if (isSeq(node)) {
					for (const item of node.items) {
						if (isPair(item)) readPair(item, depth + 1, above);
						else visit(item, depth + 1, above);
					}
				}
			};
			visit(document.contents, 0, "");
		});
	}
	return found;
}

function jsonReadings(text: string): Reading[] {
	const found: Reading[] = [];
	const visit = (node: ReturnType<typeof parseTree>, depth: number, above: string): void => {
		if (node === undefined || depth > 200) return;
		for (const child of node.children ?? []) {
			if (child.type !== "property") {
				visit(child, depth + 1, above);
				continue;
			}
			const [key, value] = child.children ?? [];
			const top = depth === 0 ? String(key?.value) : above;
			if (key !== undefined && value !== undefined && typeof key.value === "string")
				found.push({
					name: key.value,
					key: { start: key.offset, end: key.offset + key.length },
					value: { start: value.offset, end: value.offset + value.length },
					document: 0,
					depth,
					top,
					scalar: value.type === "string" ? String(value.value) : null,
				});
			visit(value, depth + 1, top);
		}
	};
	visit(parseTree(text, [], { allowTrailingComma: true, allowEmptyContent: true }), 0, "");
	return found;
}

const READERS: Record<CorpusName, (text: string) => Reading[]> = {
	dotenv: (text) => [...dotenvReadings(text), ...shellReadings(text)],
	yaml: yamlReadings,
	json: jsonReadings,
};

////////////////////////////////
//  Scenarios

const LEAVES: Record<CorpusName, Readonly<Record<string, "redact" | "omit">>> = {
	json: { token: "redact", data: "redact", password: "omit" },
	yaml: { token: "redact", data: "redact", password: "omit" },
	dotenv: { TOKEN: "redact", DATA: "redact", A: "redact", PASSWORD: "omit", B: "omit" },
};

/** Key names selected by readers. */
export function leafScenario(id: CorpusName): Scenario {
	const leaves = LEAVES[id];
	return {
		name: "leaves",
		rule: { matchers: [leaves] } as unknown as ReadableSecretRule,
		required: (readings) =>
			readings.flatMap((reading) => {
				const mode = leaves[reading.name];
				if (mode === undefined) return [];
				return [
					{ spans: [...(mode === "omit" ? [reading.key] : []), reading.value, ...(reading.reach ?? [])] },
				];
			}),
	};
}

/** Keys selected in Secret documents only. */
export function checkScenario(id: CorpusName): Scenario {
	if (id === "dotenv") {
		return {
			name: "checks",
			rule: {
				matchers: [{ "KIND=Secret": { DATA: "redact", PASSWORD: "omit" } }],
			} as unknown as ReadableSecretRule,
			required: (readings) =>
				readings.some((reading) => reading.name === "KIND" && reading.scalar === "Secret")
					? readings.flatMap((reading) => {
							if (reading.name === "DATA") return [{ spans: [reading.value] }];
							return reading.name === "PASSWORD" ? [{ spans: [reading.key, reading.value] }] : [];
						})
					: [],
		};
	}
	const rule = ruleFor("deploy/all.yaml", {}, false) as ReadableSecretRule;
	return {
		name: "checks",
		rule,
		required: (readings) => {
			const kinded = (kind: string) =>
				new Set(
					readings
						.filter((reading) => reading.depth === 0 && reading.name === "kind" && reading.scalar === kind)
						.map((reading) => reading.document),
				);
			const secrets = kinded("Secret");
			const lists = kinded("List");
			return readings
				.filter(
					(reading) =>
						(reading.name === "data" || reading.name === "stringData") &&
						((secrets.has(reading.document) && reading.depth === 0) ||
							(lists.has(reading.document) && reading.depth === 2 && reading.top === "items")),
				)
				.map((reading) => ({ spans: [reading.value, ...(reading.reach ?? [])] }));
		},
	};
}

////////////////////////////////
//  Grading

/**
 * Checks selected bytes, visible keys, and omitted extents.
 */
export function leakViolations(
	format: SecretFormat,
	id: CorpusName,
	scenario: Scenario,
	seeds: readonly string[],
	rounds: number,
	seed: number,
): string[] {
	const next = random(seed);
	const texts: string[] = [];
	for (let round = 0; round < rounds; round++) {
		let text = seeds[Math.floor(next() * seeds.length)] as string;
		for (let edits = 0; edits < 1 + Math.floor(next() * 3); edits++) text = mutate(text, next);
		texts.push(text);
	}
	return textLeaks(format, id, scenario, texts, seed);
}

/** Grades texts with `leakViolations`. */
export function textLeaks(
	format: SecretFormat,
	id: CorpusName,
	scenario: Scenario,
	texts: readonly string[],
	seed: number,
): string[] {
	const found: string[] = [];
	texts.forEach((text, round) => {
		const decision = assessSecretText(format, scenario.rule, text);
		if (decision.kind === "unreadable") return;
		const view = decision.kind === "redacted" ? applySecretMask(text, decision.mask) : text;
		const names = decision.kind === "redacted" ? decision.shown.map((shown) => shown.key) : [];
		for (const { spans } of scenario.required(READERS[id](text))) {
			for (const span of spans) {
				for (let at = span.start; at < Math.min(span.end, text.length); at++) {
					if (!/\w/.test(text[at] as string) || view[at] === " ") continue;
					if (names.some((name) => name.start <= at && at < name.end)) continue;
					found.push(
						`${id} ${scenario.name} ${seed}/${round}: byte ${at} of ${JSON.stringify(text)} stays visible in ${JSON.stringify(view)}`,
					);
					break;
				}
			}
		}
	});
	return found;
}
