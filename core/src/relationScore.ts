// How two symbols' evidence becomes a relation: the parts, their weights, the kind and the health.
// Pure, so every reader of relations scores alike.

import type { RelationEvidence, RelationHealth, RelationKind, RelationParts } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

type Part = keyof RelationParts;

////////////////////////////////
//  Constants

/** A caller's or a commit's agreement says more than a shared word or a shared folder. */
export const PART_WEIGHTS: Readonly<Record<Part, number>> = {
	callers: 0.35,
	cochange: 0.2,
	words: 0.2,
	imports: 0.15,
	file: 0.1,
};

/** Below this a pair is not reported as related, unless someone stated it. */
export const RELATION_FLOOR = 0.12;

/** Each part's kind, in the order a tie resolves. */
const PART_KINDS: ReadonlyArray<[Part, RelationKind]> = [
	["callers", "usedTogether"],
	["cochange", "changedTogether"],
	["words", "namedAlike"],
	["imports", "imported"],
	["file", "sameFile"],
];

/** Words too common in names to say two symbols relate. */
const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"get",
	"set",
	"has",
	"new",
	"from",
	"with",
	"into",
	"this",
	"that",
	"all",
	"any",
	"of",
	"to",
	"is",
	"on",
	"by",
	"as",
	"at",
	"in",
	"or",
	"id",
	"ids",
	"do",
	"make",
	"create",
	"init",
	"impl",
	"self",
	"value",
	"values",
	"data",
	"item",
	"items",
	"result",
	"results",
	"test",
	"tests",
	"util",
	"utils",
	"helper",
	"helpers",
]);

/** Type words every signature shares. */
const PRIMITIVE_TYPES = new Set([
	"string",
	"number",
	"boolean",
	"bool",
	"void",
	"any",
	"unknown",
	"never",
	"null",
	"undefined",
	"none",
	"int",
	"float",
	"double",
	"str",
	"bytes",
	"object",
	"promise",
	"array",
	"list",
	"dict",
	"map",
	"set",
	"record",
	"readonly",
	"optional",
	"partial",
	"function",
	"const",
	"async",
	"return",
	"returns",
]);

////////////////////////////////
//  Functions & Helpers

/** A name's words: camel, Pascal, snake and kebab split, lowercased, short and common ones out. */
export function wordsOf(name: string): string[] {
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z]+/)
		.map((word) => word.toLowerCase())
		.filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
	return [...new Set(words)];
}

/** The words of the type names a signature spells, primitives left out. */
export function typeWordsOf(signature: string | undefined): string[] {
	if (signature === undefined) return [];
	const types = signature.match(/\b[A-Z][A-Za-z0-9_]*/g) ?? [];
	return [...new Set(types.flatMap(wordsOf).filter((word) => !PRIMITIVE_TYPES.has(word)))];
}

/** Shared size over the geometric mean of the sizes; 0 when either is empty. */
export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): { shared: string[]; score: number } {
	if (a.size === 0 || b.size === 0) return { shared: [], score: 0 };
	const shared = [...a].filter((word) => b.has(word)).sort();
	return { shared, score: shared.length / Math.sqrt(a.size * b.size) };
}

/** Shared over union. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): { shared: number; score: number } {
	let shared = 0;
	for (const item of a) if (b.has(item)) shared++;
	const union = a.size + b.size - shared;
	return { shared, score: union === 0 ? 0 : shared / union };
}

/** A caller using many symbols says less about any two of them. */
export function callerWeight(targets: number): number {
	return 1 / Math.log2(2 + targets);
}

/** The weighted parts, over the weight of the parts that could be read; missing history is not zero. */
export function combine(parts: RelationParts): number {
	let sum = 0;
	let weight = 0;
	for (const [part, value] of Object.entries(parts) as Array<[Part, number | null]>) {
		if (value === null) continue;
		sum += PART_WEIGHTS[part] * value;
		weight += PART_WEIGHTS[part];
	}
	return weight === 0 ? 0 : Math.min(1, sum / weight);
}

/** The kind whose weighted part is largest; `stated` when every part is zero. */
export function kindOf(parts: RelationParts): RelationKind {
	let best: RelationKind = "stated";
	let top = 0;
	for (const [part, kind] of PART_KINDS) {
		const value = (parts[part] ?? 0) * PART_WEIGHTS[part];
		if (value > top) {
			top = value;
			best = kind;
		}
	}
	return best;
}

/** Accepts lift a relation, rejects sink it, both bounded so feedback never outweighs the evidence. */
export function feedbackFactor(counts: { accepted: number; rejected: number } | null): number {
	if (counts === null) return 1;
	return Math.min(2, Math.max(0.5, (1 + counts.accepted) / (1 + counts.rejected)));
}

/** Two independent items at least, or the score rests on one. */
export function computedHealth(evidence: RelationEvidence): RelationHealth {
	const items =
		evidence.holders +
		(evidence.commits ?? 0) +
		(evidence.sameModule ? 1 : 0) +
		(evidence.words.length > 0 ? 1 : 0) +
		(evidence.imports > 1 ? 1 : 0);
	return items >= 2 ? "current" : "insufficientEvidence";
}

/** A stated relation: an end gone, an end's source moved since it was stated or judged, or neither. */
export function statedHealth(ends: {
	state: "bound" | "orphaned";
	otherState: "bound" | "orphaned";
	digest: string | null;
	lastDigest: string | null;
	otherDigest: string | null;
	otherLastDigest: string | null;
}): RelationHealth {
	if (ends.state === "orphaned" || ends.otherState === "orphaned") return "orphaned";
	const moved = (saved: string | null, now: string | null) => saved !== null && now !== null && saved !== now;
	return moved(ends.digest, ends.lastDigest) || moved(ends.otherDigest, ends.otherLastDigest)
		? "sourceChanged"
		: "current";
}
