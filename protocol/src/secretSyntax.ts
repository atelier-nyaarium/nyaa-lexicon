// Readers account for every byte.
// Gaps become hazards, not inert text.
// Policy decides secrecy.

import type { OffsetRange } from "./coordinates.js";
import { unionOf } from "./edits.js";

////////////////////////////////
//  Interfaces & Types

/** Key, item, or value node; spans use UTF-16 offsets. */
export interface SecretNode {
	/** Parent node index; root is -1. */
	parent: number;
	/** Provider, reader, and source spellings; empty if nameless. */
	names: readonly string[];
	/** Array index; absent for keyed children. */
	index?: number;
	/** Empty for roots and array items. */
	key: OffsetRange;
	value: OffsetRange;
	/** Aliases and merges may share children. */
	children: readonly number[];
	/** External bytes read as this value. */
	via: readonly OffsetRange[];
	/** Merge-supplied child. */
	virtual: boolean;
}

/** Bytes readers cannot agree on. */
export interface SecretHazard {
	/** Empty at truncation points. */
	span: OffsetRange;
	/** Affected subtree root. */
	within: number;
	/** `any` hazards can introduce unspelled names. */
	reach: "spelled" | "any";
	/** Nodes after the offset may be elsewhere. */
	reshapes: boolean;
}

/** First node is the document root. */
export interface SecretSyntaxDocument {
	nodes: readonly SecretNode[];
	hazards: readonly SecretHazard[];
}

export interface SecretSyntax {
	documents: readonly SecretSyntaxDocument[];
}

export type ScalarReading = { kind: "decided"; value: string; empty: boolean } | { kind: "uncertain"; empty: boolean };

export interface SecretFormat {
	id: string;
	/** Consumers whose readings form the union. */
	consumers: readonly string[];
	matches(module: string): boolean;
	/** Matches one inert whitespace, comment, or punctuation token. */
	inert: RegExp;
	/** Throws only `SecretBudgetError`. */
	read(text: string): SecretSyntax;
	/** Returns stable values only when readers agree. */
	scalar(document: SecretSyntaxDocument, node: number): ScalarReading;
	/** False only when no reader can find a name. */
	mayName(text: string, span: OffsetRange, names: readonly string[]): boolean;
}

const verified: unique symbol = Symbol("verified");

/** Only verification can mint this syntax. */
export interface VerifiedSyntax extends SecretSyntax {
	readonly [verified]: true;
	/** Declared hazards widened over non-inert gaps. */
	readonly hazards: readonly (readonly SecretHazard[])[];
	/** Unclaimed non-inert bytes. */
	readonly residual: number;
}

/** Thrown when a read exceeds its budget. */
export class SecretBudgetError extends Error {
	constructor(readonly limit: "depth" | "size") {
		super(`secret text exceeds the ${limit} budget`);
	}
}

////////////////////////////////
//  Constants

const MAX_FAILING_GAPS = 256;

////////////////////////////////
//  Functions & Helpers

/** Span from key start through value end. */
export function extentOf(node: SecretNode): OffsetRange {
	return { start: Math.min(node.key.start, node.value.start), end: Math.max(node.key.end, node.value.end) };
}

export function isInside(inner: OffsetRange, outer: OffsetRange): boolean {
	return inner.start >= outer.start && inner.end <= outer.end;
}

function isSpan(span: OffsetRange, length: number): boolean {
	return (
		Number.isInteger(span.start) &&
		Number.isInteger(span.end) &&
		span.start >= 0 &&
		span.start <= span.end &&
		span.end <= length
	);
}

function worstHazard(span: OffsetRange): SecretHazard {
	return { span, within: 0, reach: "any", reshapes: true };
}

/** Conservative node for untrusted structure. */
function untrusted(length: number): SecretSyntaxDocument {
	const whole = { start: 0, end: length };
	return {
		nodes: [
			{ parent: -1, names: [], key: { start: 0, end: 0 }, value: whole, children: [], via: [], virtual: false },
		],
		hazards: [worstHazard(whole)],
	};
}

/** Node ordering and ownership metadata. */
function structureHolds(document: SecretSyntaxDocument, length: number): boolean {
	const { nodes, hazards } = document;
	const count = nodes.length;
	if (count === 0 || nodes[0]?.parent !== -1) return false;
	for (let at = 0; at < count; at++) {
		const node = nodes[at] as SecretNode;
		if (!isSpan(node.key, length) || !isSpan(node.value, length)) return false;
		if (!node.via.every((span) => isSpan(span, length))) return false;
		if (at > 0 && !(Number.isInteger(node.parent) && node.parent >= 0 && node.parent < count && node.parent !== at))
			return false;
	}
	for (const hazard of hazards) {
		if (!isSpan(hazard.span, length) || !Number.isInteger(hazard.within)) return false;
		if (hazard.within < 0 || hazard.within >= count) return false;
	}
	const listed = new Uint8Array(count);
	for (let at = 0; at < count; at++) {
		const node = nodes[at] as SecretNode;
		const starts: number[] = [];
		const ends: number[] = [];
		for (const child of node.children) {
			if (!Number.isInteger(child) || child <= 0 || child >= count || child === at) return false;
			const owned = nodes[child] as SecretNode;
			const first = Math.min(owned.key.start, owned.value.start);
			const last = Math.max(owned.key.end, owned.value.end);
			const inside = first >= node.value.start && last <= node.value.end;
			if (owned.parent === at) {
				listed[child] = 1;
				if (!owned.virtual) {
					if (!inside) return false;
					if (starts.length > 0 && first < (ends[ends.length - 1] as number)) return false;
					starts.push(first);
					ends.push(last);
				}
			}
			if (!inside && !node.via.some((span) => first >= span.start && last <= span.end)) return false;
		}
	}
	for (let at = 1; at < count; at++) if (listed[at] !== 1) return false;
	return true;
}

/**
 * Returns uncovered gaps between sorted spans.
 */
export function complementOf(spans: readonly OffsetRange[], within: OffsetRange): OffsetRange[] {
	let low = 0;
	let high = spans.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((spans[middle] as OffsetRange).end <= within.start) low = middle + 1;
		else high = middle;
	}
	const inside: OffsetRange[] = [];
	for (let at = low; at < spans.length && (spans[at] as OffsetRange).start < within.end; at++)
		inside.push(spans[at] as OffsetRange);
	const edges = [{ start: within.start, end: within.start }, ...inside, { start: within.end, end: within.end }];
	const gaps: OffsetRange[] = [];
	for (let at = 1; at < edges.length; at++) {
		const gap = {
			start: Math.max((edges[at - 1] as OffsetRange).end, within.start),
			end: Math.min((edges[at] as OffsetRange).start, within.end),
		};
		if (gap.end > gap.start) gaps.push(gap);
	}
	return gaps;
}

/** Whether the child belongs to this value. */
function ownsChild(nodes: readonly SecretNode[], at: number): boolean {
	for (const child of (nodes[at] as SecretNode).children) {
		const owned = nodes[child] as SecretNode;
		if (owned.parent === at && !owned.virtual) return true;
	}
	return false;
}

/** Claimed key, value, and hazard spans. */
function claimedSpans(documents: readonly SecretSyntaxDocument[], hazards: readonly (readonly SecretHazard[])[]) {
	const claimed: OffsetRange[] = [];
	documents.forEach((document, index) => {
		const { nodes } = document;
		for (let at = 0; at < nodes.length; at++) {
			const node = nodes[at] as SecretNode;
			if (node.virtual) continue;
			if (node.key.end > node.key.start) claimed.push(node.key);
			if (node.value.end > node.value.start && !ownsChild(nodes, at)) claimed.push(node.value);
		}
		for (const hazard of hazards[index] ?? []) if (hazard.span.end > hazard.span.start) claimed.push(hazard.span);
	});
	return claimed;
}

/** Whether a gap contains only bounded inert tokens. */
function isInert(inert: RegExp, text: string, gap: OffsetRange): boolean {
	let at = gap.start;
	while (at < gap.end) {
		inert.lastIndex = at;
		const token = inert.exec(text);
		if (token === null || token.index !== at || token[0].length === 0) return false;
		if (at + token[0].length > gap.end) return isInertWithin(inert, text.slice(at, gap.end));
		at += token[0].length;
	}
	return true;
}

function isInertWithin(inert: RegExp, bytes: string): boolean {
	let at = 0;
	while (at < bytes.length) {
		inert.lastIndex = at;
		const token = inert.exec(bytes);
		if (token === null || token.index !== at || token[0].length === 0) return false;
		at += token[0].length;
	}
	return true;
}

function commonAncestor(nodes: readonly SecretNode[], first: number, second: number): number {
	const ancestors = new Set<number>();
	for (let at = first; at >= 0; at = (nodes[at] as SecretNode).parent) ancestors.add(at);
	for (let at = second; at >= 0; at = (nodes[at] as SecretNode).parent) if (ancestors.has(at)) return at;
	return 0;
}

/** Merges overlapping or adjacent hazards. */
function coalesce(hazards: readonly SecretHazard[], nodes: readonly SecretNode[]): SecretHazard[] {
	const sorted = [...hazards].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
	const merged: SecretHazard[] = [];
	for (const hazard of sorted) {
		const last = merged[merged.length - 1];
		if (last === undefined || hazard.span.start > last.span.end) {
			merged.push(hazard);
			continue;
		}
		merged[merged.length - 1] = {
			span: { start: last.span.start, end: Math.max(last.span.end, hazard.span.end) },
			within: commonAncestor(nodes, last.within, hazard.within),
			reach: last.reach === "any" || hazard.reach === "any" ? "any" : "spelled",
			reshapes: last.reshapes || hazard.reshapes,
		};
	}
	return merged;
}

/**
 * Verifies coverage; non-inert gaps widen or create hazards.
 * Residual gaps use worst-case scope; touching hazards merge.
 */
export function verifySecretSyntax(format: SecretFormat, text: string, syntax: SecretSyntax): VerifiedSyntax {
	const length = text.length;
	let residual = 0;
	const documents: SecretSyntaxDocument[] = [];
	const hazards: SecretHazard[][] = [];
	for (const document of syntax.documents) {
		if (structureHolds(document, length)) {
			documents.push(document);
			hazards.push([...document.hazards]);
		} else {
			const replaced = untrusted(length);
			documents.push(replaced);
			hazards.push([...replaced.hazards]);
			residual += 1;
		}
	}

	const gaps = complementOf(unionOf(claimedSpans(documents, hazards)), { start: 0, end: length });
	const failing = gaps.filter((gap) => !isInert(format.inert, text, gap));
	if (failing.length > 0) {
		const whole = failing.length > MAX_FAILING_GAPS;
		const unplaced = whole ? [{ start: failing[0]?.start ?? 0, end: length }] : failing;
		for (const span of unplaced) {
			let touched = false;
			for (const list of hazards) {
				for (let at = 0; at < list.length; at++) {
					const hazard = list[at] as SecretHazard;
					if (hazard.span.start > span.end || span.start > hazard.span.end) continue;
					list[at] = {
						...hazard,
						span: {
							start: Math.min(hazard.span.start, span.start),
							end: Math.max(hazard.span.end, span.end),
						},
					};
					touched = true;
				}
			}
			if (touched) continue;
			residual += 1;
			if (documents.length === 0) {
				const replaced = untrusted(length);
				documents.push(replaced);
				hazards.push([...replaced.hazards]);
			} else {
				const owner = documents.findLastIndex(
					(document) => (document.nodes[0] as SecretNode).value.start <= span.start,
				);
				(hazards[Math.max(owner, 0)] as SecretHazard[]).push(worstHazard(span));
			}
		}
	}

	return {
		documents,
		hazards: hazards.map((list, index) => coalesce(list, (documents[index] as SecretSyntaxDocument).nodes)),
		residual,
		[verified]: true,
	};
}

/** True only for verifier-minted syntax. */
export function isVerifiedSyntax(syntax: SecretSyntax): syntax is VerifiedSyntax {
	return (syntax as { [verified]?: true })[verified] === true;
}
