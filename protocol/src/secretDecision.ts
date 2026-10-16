// Shared decision for every secret format.
// Readers report facts; this module decides masking.
// Selectable structure unions consumer readings.
// Checks require agreement; uncertainty hides both outcomes.

import type { OffsetRange } from "./coordinates.js";
import { unionOf } from "./edits.js";
import { parseMatcher } from "./secretMatchers.js";
import {
	complementOf,
	extentOf,
	isInside,
	isVerifiedSyntax,
	SecretBudgetError,
	type SecretFormat,
	type SecretHazard,
	type SecretNode,
	type SecretSyntaxDocument,
	type VerifiedSyntax,
	verifySecretSyntax,
} from "./secretSyntax.js";
import type { ReadableSecretRule, SecretMatcherMap, SecretMode, ValueStatus } from "./secrets.js";

export type { ReadableSecretRule };

////////////////////////////////
//  Interfaces & Types

export type Undecided = "mask" | "withhold";

interface CompiledKey {
	parts: readonly string[];
	mode: SecretMode | null;
	nested: CompiledMap | null;
}

interface CompiledCheck {
	path: readonly string[];
	expect: string;
	/** Matchers enabled by passing checks. */
	applies: CompiledMap;
}

interface CompiledMap {
	keys: readonly CompiledKey[];
	checks: readonly CompiledCheck[];
}

/** Parsed matchers and selectable leaf names. */
export interface SecretPlan {
	whole: boolean;
	maps: readonly CompiledMap[];
	leaves: readonly string[];
}

/** Child array index or key name. */
export type ShownStep = string | number;

/** Key kept visible when masking values. */
export interface ShownKey {
	document: number;
	path: readonly ShownStep[];
	key: OffsetRange;
	status: ValueStatus;
}

export interface DocumentDecision {
	selected: boolean;
	/** Unmerged selected values and contested hazards. */
	hidden: OffsetRange[];
	/** Unmerged omitted extents. */
	omitted: OffsetRange[];
	shown: ShownKey[];
	/** Hazards that may contain selected values. */
	contested: number;
	/** Unpinned checks may reveal more selections. */
	open: boolean;
}

export type SecretDecision =
	| { kind: "plain" }
	| { kind: "unreadable"; reason: "budget" | "undecided" }
	| {
			kind: "redacted";
			documents: number;
			/** Sorted spans hide values, never key names. */
			mask: readonly OffsetRange[];
			/** Omitted spans include their keys. */
			omitted: readonly OffsetRange[];
			shown: readonly ShownKey[];
	  };

type CheckState = "pass" | "fail" | "unpinned";

interface Context {
	format: SecretFormat;
	text: string;
	document: SecretSyntaxDocument;
	nodes: readonly SecretNode[];
	hazards: readonly SecretHazard[];
	checks: Map<string, CheckState>;
}

////////////////////////////////
//  Constants

/**
 * `mask` unions readings and preserves keys.
 * `withhold` hides the whole file.
 */
export const UNDECIDED: Undecided = "mask";

const PLAIN: SecretDecision = { kind: "plain" };
const REDACT = 1;
const OMIT = 2;

////////////////////////////////
//  Rule Planning

function compileMap(map: SecretMatcherMap): CompiledMap {
	const keys: CompiledKey[] = [];
	const checks: CompiledCheck[] = [];
	for (const [matcher, value] of Object.entries(map)) {
		const parsed = parseMatcher(matcher);
		if (parsed?.kind === "document") {
			if (typeof value !== "string")
				checks.push({ path: parsed.path, expect: parsed.expect, applies: compileMap(value) });
		} else if (parsed?.kind === "key") {
			keys.push(
				typeof value === "string"
					? { parts: parsed.path, mode: value, nested: null }
					: { parts: parsed.path, mode: null, nested: compileMap(value) },
			);
		}
	}
	return { keys, checks };
}

function leavesOf(map: CompiledMap, found: Set<string>): void {
	for (const key of map.keys) {
		if (key.nested === null) found.add(key.parts[key.parts.length - 1] as string);
		else leavesOf(key.nested, found);
	}
	for (const check of map.checks) leavesOf(check.applies, found);
}

export function planSecretRule(rule: ReadableSecretRule): SecretPlan {
	const maps = ("matchers" in rule ? rule.matchers : []).map(compileMap);
	const found = new Set<string>();
	for (const map of maps) leavesOf(map, found);
	return { whole: rule.whole === "redact", maps, leaves: [...found] };
}

////////////////////////////////
//  Span Helpers

/** Merged, nonempty spans. */
function mergeSpans(spans: readonly OffsetRange[]): OffsetRange[] {
	return unionOf(spans.filter((span) => span.end > span.start));
}

/** Tests containment; empty regions always fit. */
function holds(merged: readonly OffsetRange[], region: OffsetRange): boolean {
	if (region.end <= region.start) return true;
	let low = 0;
	let high = merged.length - 1;
	let found = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if ((merged[middle] as OffsetRange).start <= region.start) {
			found = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return found >= 0 && (merged[found] as OffsetRange).end >= region.end;
}

function overlaps(a: OffsetRange, b: OffsetRange): boolean {
	return a.start < b.end && b.start < a.end;
}

/** Tests overlap; empty spans may touch boundaries. */
function touches(merged: readonly OffsetRange[], span: OffsetRange): boolean {
	let low = 0;
	let high = merged.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((merged[middle] as OffsetRange).end <= span.start) low = middle + 1;
		else high = middle;
	}
	const found = merged[low];
	return found !== undefined && found.start < Math.max(span.end, span.start + 1);
}

/** Nodes reachable through aliases or merges. */
function readWithin(nodes: readonly SecretNode[], regions: readonly OffsetRange[]): OffsetRange[] {
	const read: OffsetRange[] = [];
	if (regions.length === 0) return read;
	for (let at = 1; at < nodes.length; at++) {
		const node = nodes[at] as SecretNode;
		if (!node.virtual && node.via.length > 0 && touches(regions, extentOf(node))) read.push(...node.via);
	}
	return read;
}

/** Merged bytes outside the cut. */
function subtractSpans(from: readonly OffsetRange[], cut: readonly OffsetRange[]): OffsetRange[] {
	return from.flatMap((span) => complementOf(cut, span));
}

/** Hazard bytes, including reshaped subtrees. */
function regionOf(context: Context, hazard: SecretHazard): OffsetRange {
	const end = hazard.reshapes
		? Math.max(hazard.span.end, (context.nodes[hazard.within] as SecretNode).value.end)
		: hazard.span.end;
	return { start: hazard.span.start, end };
}

////////////////////////////////
//  Selection

function matching(node: SecretNode, part: string): boolean {
	return part === "*" || node.names.includes(part);
}

/** Descendants once, despite alias paths. */
function descendantsOf(context: Context, roots: readonly number[]): number[] {
	const seen = new Uint8Array(context.nodes.length);
	const found: number[] = [];
	const pending: number[] = [];
	const visit = (at: number) => {
		for (const child of (context.nodes[at] as SecretNode).children) pending.push(child);
	};
	for (const root of roots) visit(root);
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		if (seen[at] === 1) continue;
		seen[at] = 1;
		found.push(at);
		visit(at);
	}
	return found;
}

function uniqueNodes(nodes: readonly number[]): number[] {
	return [...new Set(nodes)];
}

/** Bare names match below scope; paths start at root. */
function nodesFor(context: Context, parts: readonly string[], scope: readonly number[] | null): number[] {
	const { nodes } = context;
	if (parts.length === 1) {
		const part = parts[0] as string;
		return descendantsOf(context, scope ?? [0]).filter((at) => matching(nodes[at] as SecretNode, part));
	}
	let current = uniqueNodes((nodes[0] as SecretNode).children);
	parts.forEach((part, index) => {
		current = current.filter((at) => matching(nodes[at] as SecretNode, part));
		if (index < parts.length - 1)
			current = uniqueNodes(current.flatMap((at) => (nodes[at] as SecretNode).children));
	});
	if (scope === null) return current;
	const under = new Set(descendantsOf(context, scope));
	return current.filter((at) => under.has(at));
}

/** Marks a subtree with its strongest mode. */
function mark(context: Context, modes: Uint8Array, start: number, mode: number): void {
	const pending = [start];
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		if ((modes[at] as number) >= mode) continue;
		modes[at] = mode;
		for (const child of (context.nodes[at] as SecretNode).children) pending.push(child);
	}
}

////////////////////////////////
//  Document Checks

/**
 * Checks require reader agreement; ambiguity unpins them.
 */
function checkState(context: Context, path: readonly string[], expect: string): CheckState {
	const key = `${path.join(".")}=${expect}`;
	const cached = context.checks.get(key);
	if (cached !== undefined) return cached;
	const state = evaluateCheck(context, path, expect);
	context.checks.set(key, state);
	return state;
}

function evaluateCheck(context: Context, path: readonly string[], expect: string): CheckState {
	const { nodes, format, document, text } = context;
	const route = new Set<number>([0]);
	let current = [0];
	let merged = false;
	for (const segment of path) {
		const next: number[] = [];
		for (const at of current) {
			for (const child of (nodes[at] as SecretNode).children) {
				const node = nodes[child] as SecretNode;
				if (!node.names.includes(segment)) continue;
				next.push(child);
				if (node.virtual) merged = true;
			}
		}
		current = uniqueNodes(next);
		if (current.length === 0) break;
		for (const at of current) route.add(at);
	}
	if (merged) return "unpinned";
	const last = path[path.length - 1] as string;
	for (const hazard of context.hazards) {
		if (!route.has(hazard.within)) continue;
		if (hazard.reach === "any" || format.mayName(text, regionOf(context, hazard), [last])) return "unpinned";
	}
	if (current.length === 0) return "fail";
	const values = new Set<string>();
	for (const at of current) {
		const node = nodes[at] as SecretNode;
		if (node.children.length > 0) return "unpinned";
		const reading = format.scalar(document, at);
		if (reading.kind === "uncertain") return "unpinned";
		values.add(reading.value);
	}
	if (values.size > 1) return "unpinned";
	return values.has(expect) ? "pass" : "fail";
}

/** Selectable final matcher segments. */
function activeLeaves(context: Context, map: CompiledMap, found: Set<string>): void {
	for (const key of map.keys) {
		if (key.nested === null) found.add(key.parts[key.parts.length - 1] as string);
		else activeLeaves(context, key.nested, found);
	}
	for (const check of map.checks) {
		if (checkState(context, check.path, check.expect) !== "fail") activeLeaves(context, check.applies, found);
	}
}

/** `max` selects broadly; `min` follows pinned passes. */
function select(
	context: Context,
	map: CompiledMap,
	scope: readonly number[] | null,
	pinned: boolean,
	max: Uint8Array,
	min: Uint8Array,
): void {
	for (const key of map.keys) {
		const found = nodesFor(context, key.parts, scope);
		if (key.mode !== null) {
			const mode = key.mode === "omit" ? OMIT : REDACT;
			for (const at of found) {
				mark(context, max, at, mode);
				if (pinned) mark(context, min, at, mode);
			}
		} else if (key.nested !== null) {
			select(context, key.nested, found, pinned, max, min);
		}
	}
	for (const check of map.checks) {
		const state = checkState(context, check.path, check.expect);
		if (state !== "fail") select(context, check.applies, scope, pinned && state === "pass", max, min);
	}
}

function hiddenSpans(nodes: readonly SecretNode[], modes: Uint8Array): OffsetRange[] {
	const spans: OffsetRange[] = [];
	for (let at = 1; at < nodes.length; at++) {
		const mode = modes[at];
		if (mode === 0) continue;
		const node = nodes[at] as SecretNode;
		spans.push(mode === OMIT ? extentOf(node) : node.value, ...node.via);
	}
	return spans;
}

////////////////////////////////
//  Decision

function statusOf(context: Context, at: number): ValueStatus {
	const node = context.nodes[at] as SecretNode;
	if (node.children.length > 0) return "set";
	return context.format.scalar(context.document, at).empty ? "empty" : "set";
}

function pathOf(nodes: readonly SecretNode[], at: number): ShownStep[] | null {
	const steps: ShownStep[] = [];
	for (let cursor = at; cursor > 0; cursor = (nodes[cursor] as SecretNode).parent) {
		const node = nodes[cursor] as SecretNode;
		const step = node.index ?? node.names[0];
		if (step === undefined) return null;
		steps.push(step);
	}
	return steps.reverse();
}

/** Whether a hazard may contain a matched value. */
function isContested(
	context: Context,
	hazard: SecretHazard,
	region: OffsetRange,
	leaves: ReadonlySet<string>,
	max: Uint8Array,
): boolean {
	const { nodes, format, text } = context;
	if (leaves.has("*") || format.mayName(text, region, [...leaves])) return true;
	if (!hazard.reshapes) return false;
	if ((max[hazard.within] as number) > 0) return true;
	const within = (nodes[hazard.within] as SecretNode).value;
	for (let at = 1; at < nodes.length; at++) {
		if ((max[at] as number) === 0) continue;
		const node = nodes[at] as SecretNode;
		if (node.children.length === 0 || !isInside(node.value, within)) continue;
		if (node.value.start <= hazard.span.start && hazard.span.start <= node.value.end) return true;
	}
	return false;
}

/**
 * `max` includes uncertain selections; `min` follows pinned passes.
 * Hides `max` selections and unmasked hazards that may hold a match.
 */
export function decideDocument(
	format: SecretFormat,
	plan: SecretPlan,
	text: string,
	syntax: VerifiedSyntax,
	index: number,
): DocumentDecision {
	if (!isVerifiedSyntax(syntax)) throw new TypeError("decideDocument takes the output of verifySecretSyntax");
	const document = syntax.documents[index] as SecretSyntaxDocument;
	const context: Context = {
		format,
		text,
		document,
		nodes: document.nodes,
		hazards: syntax.hazards[index] as readonly SecretHazard[],
		checks: new Map(),
	};
	const { nodes } = context;
	const max = new Uint8Array(nodes.length);
	const min = new Uint8Array(nodes.length);
	if (plan.whole) {
		for (let at = 1; at < nodes.length; at++) {
			max[at] = REDACT;
			min[at] = REDACT;
		}
	}
	for (const map of plan.maps) select(context, map, null, true, max, min);

	let selected = false;
	let open = false;
	for (let at = 1; at < nodes.length; at++) {
		if ((max[at] as number) > 0) selected = true;
		if (max[at] !== min[at]) open = true;
	}

	const leaves = new Set<string>();
	for (const map of plan.maps) activeLeaves(context, map, leaves);
	const confirmed = mergeSpans(hiddenSpans(nodes, min));
	const contested: OffsetRange[] = [];
	const reshaped: OffsetRange[] = [];
	for (const hazard of context.hazards) {
		const region = regionOf(context, hazard);
		if (hazard.reshapes) reshaped.push(region);
		if (plan.whole || leaves.size === 0 || holds(confirmed, region)) continue;
		if (isContested(context, hazard, region, leaves, max)) contested.push(region);
	}

	const hidden = [...hiddenSpans(nodes, max), ...contested, ...readWithin(nodes, mergeSpans(contested))];
	const omitted: OffsetRange[] = [];
	const shown: ShownKey[] = [];
	for (let at = 1; at < nodes.length; at++) {
		const node = nodes[at] as SecretNode;
		if (max[at] === OMIT) omitted.push(extentOf(node), ...node.via);
		if (max[at] !== REDACT || node.virtual || node.index !== undefined || node.names.length === 0) continue;
		if (node.key.end <= node.key.start) continue;
		if (
			reshaped.some((region) => overlaps(region, node.key)) ||
			contested.some((region) => overlaps(region, node.key))
		)
			continue;
		const path = pathOf(nodes, at);
		if (path === null) continue;
		shown.push({ document: index, path, key: node.key, status: statusOf(context, at) });
	}
	return { selected, hidden, omitted, shown, contested: contested.length, open };
}

////////////////////////////////
//  Text Assessment

/** Masks bytes while preserving line breaks. */
export function applySecretMask(text: string, mask: readonly OffsetRange[]): string {
	const units = text.split("");
	for (const span of mask) {
		for (let at = span.start; at < span.end; at++) {
			if (units[at] !== "\n" && units[at] !== "\r") units[at] = " ";
		}
	}
	return units.join("");
}

/**
 * False proves no matcher has a whole-key spelling.
 */
export function mayHideSecret(format: SecretFormat, rule: ReadableSecretRule, text: string): boolean {
	return mayHide(format, planSecretRule(rule), text);
}

function mayHide(format: SecretFormat, plan: SecretPlan, text: string): boolean {
	if (plan.whole) return true;
	const everything = { start: 0, end: text.length };
	return plan.leaves.some((leaf) => leaf === "*" || format.mayName(text, everything, [leaf]));
}

/** Assessment without prefiltering. */
export function decideSecretText(
	format: SecretFormat,
	rule: ReadableSecretRule,
	text: string,
	undecided: Undecided = UNDECIDED,
): SecretDecision {
	return decide(format, planSecretRule(rule), text, undecided);
}

function decide(format: SecretFormat, plan: SecretPlan, text: string, undecided: Undecided): SecretDecision {
	let verified: VerifiedSyntax;
	try {
		verified = verifySecretSyntax(format, text, format.read(text));
	} catch (failure) {
		if (failure instanceof SecretBudgetError) return { kind: "unreadable", reason: "budget" };
		throw failure;
	}
	const decisions = verified.documents.map((_, index) => decideDocument(format, plan, text, verified, index));
	const contested = decisions.some((decision) => decision.contested > 0);
	if (!plan.whole && !contested && !decisions.some((decision) => decision.selected)) return PLAIN;
	if (undecided === "withhold" && (contested || decisions.some((decision) => decision.open)))
		return { kind: "unreadable", reason: "undecided" };

	const shown = decisions.flatMap((decision) => decision.shown).sort((a, b) => a.key.start - b.key.start);
	const hidden = plan.whole ? [{ start: 0, end: text.length }] : decisions.flatMap((decision) => decision.hidden);
	const omitted = mergeSpans(decisions.flatMap((decision) => decision.omitted));
	const mask = subtractSpans(mergeSpans([...hidden, ...omitted]), mergeSpans(shown.map((key) => key.key)));
	return { kind: "redacted", documents: verified.documents.length, mask, omitted, shown };
}

/**
 * Returns plain, masked, or unreadable assessments.
 * Budget failures and uncertainty produce unreadable assessments.
 */
export function assessSecretText(
	format: SecretFormat,
	rule: ReadableSecretRule,
	text: string,
	undecided: Undecided = UNDECIDED,
): SecretDecision {
	const plan = planSecretRule(rule);
	return mayHide(format, plan, text) ? decide(format, plan, text, undecided) : PLAIN;
}
