// A name chain inside one module, answered from ONE daemon snapshot: the declaration it names,
// every candidate when it names several, or the reason there was nothing to walk, with the hash
// the index holds and the hash on disk on every answer.
//
// The walk follows named containers: a declaration's container chain where the module holds it,
// else the descriptor names its own id carries (an out-of-line definition names its scope without
// declaring it). Coordinates are the protocol's, 0-based, untouched.

import {
	isParameterSymbol,
	ownerOf,
	parseSymbolId,
	type Range,
	type StoredDeclaration,
	type SymbolKind,
} from "@nyaa-lexicon/protocol";
import type { Session } from "./connect.js";

////////////////////////////////
//  Interfaces & Types

export interface ChainCandidate {
	/** An `arguments` span carries its owner's id, since a parameter list has none of its own. */
	symbolId: string;
	kind: SymbolKind;
	name: string;
	range: Range;
	/** Absent for an `arguments` span, which has no name in the source. */
	selectionRange?: Range;
	/** The enclosing declarations by name, outermost first. */
	containerPath: string[];
	/** A chain that resolves to exactly this candidate: the container names, `[n]` where needed. */
	segments: string[];
}

/** The hash the index holds and the hash of the file as read; either null when there is none. */
export interface ChainHashes {
	contentHash: string | null;
	diskHash: string | null;
}

export type ChainNoneReason = "missing" | "binary" | "tooLarge" | "unclaimed" | "parseFailed" | "unread" | "noMatch";

/** Where the walk stopped: the paths it stood on, how many segments it consumed, and how many matches the failing one had. */
export interface ChainFrontier {
	containerPaths: string[][];
	consumed: number;
	count: number;
}

export type ChainAnswer =
	| ({ kind: "exact"; candidate: ChainCandidate } & ChainHashes)
	| ({ kind: "ambiguous"; candidates: ChainCandidate[] } & ChainHashes)
	| ({
			kind: "none";
			reason: ChainNoneReason;
			detail?: string;
			matched: ChainFrontier;
			/** Declaration names beneath the frontier, deduped, document order, capped. */
			available: string[];
			availableTotal: number;
	  } & ChainHashes);

/** A named place the walk stands on: a declaration, or a descriptor prefix nothing declares. */
type Place = { kind: "place"; path: string[]; declaration: StoredDeclaration | null; at: Range };

type Step = Place | { kind: "arguments"; owner: StoredDeclaration; parameters: StoredDeclaration[]; span: Range };

interface ModuleTree {
	/** Document order. */
	declarations: StoredDeclaration[];
	/** Each declaration's named containers, outermost first. */
	paths: Map<string, string[]>;
}

/** One fold over the segments: the steps it ended on, or where it stopped. */
type Fold = { done: true; steps: Step[] } | { done: false; consumed: number; steps: Step[]; count: number };

////////////////////////////////
//  Constants

/** Both spellings of a qualified name mean the same. */
const QUALIFIER = /::|\./;

/** `name[n]`, counted from 1 in document order. */
const ORDINAL = /^(.+)\[([0-9]+)\]$/;

const ARGUMENTS = "arguments";

const AVAILABLE_CAP = 50;

////////////////////////////////
//  Functions & Helpers

function documentOrder(a: { range: Range; symbolId: string }, b: { range: Range; symbolId: string }): number {
	const byPosition = a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
	if (byPosition !== 0) return byPosition;
	return a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0;
}

function rangeOrder(a: Range, b: Range): number {
	return a.start.line - b.start.line || a.start.character - b.start.character;
}

function stepOrder(a: Step, b: Step): number {
	const byPosition = rangeOrder(a.kind === "arguments" ? a.span : a.at, b.kind === "arguments" ? b.span : b.at);
	if (byPosition !== 0) return byPosition;
	return stepKey(a) < stepKey(b) ? -1 : stepKey(a) > stepKey(b) ? 1 : 0;
}

function stepKey(step: Step): string {
	if (step.kind === "arguments") return `arguments:${step.owner.symbolId}`;
	return `${step.path.join("\0")}|${step.declaration?.symbolId ?? ""}`;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
	return prefix.length <= path.length && prefix.every((name, i) => nfc(path[i] as string) === nfc(name));
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && startsWith(a, b);
}

/**
 * The id's own descriptor names, the identity every provider mints, so a written scope nothing
 * declares (an out-of-line definition, an explicit interface implementation) is on the path; the
 * container chain only for an id that carries no path of its own.
 */
function containerPathOf(byId: Map<string, StoredDeclaration>, declaration: StoredDeclaration): string[] {
	const parsed = parseSymbolId(declaration.symbolId);
	if (parsed !== null && parsed.descriptors.length > 0) {
		return parsed.descriptors.slice(0, -1).map((descriptor) => descriptor.name);
	}
	if (declaration.containerId !== undefined) {
		const names: string[] = [];
		const seen = new Set<string>();
		let id: string | undefined = declaration.containerId;
		while (id !== undefined && !seen.has(id)) {
			seen.add(id);
			const container = byId.get(id);
			if (container === undefined) break;
			names.unshift(container.name);
			id = container.containerId;
		}
		return names;
	}
	return [];
}

function treeOf(rows: readonly StoredDeclaration[]): ModuleTree {
	const declarations = [...rows].sort(documentOrder);
	const byId = new Map(declarations.map((d) => [d.symbolId, d]));
	return { declarations, paths: new Map(declarations.map((d) => [d.symbolId, containerPathOf(byId, d)])) };
}

function pathOf(tree: ModuleTree, declaration: StoredDeclaration): string[] {
	return tree.paths.get(declaration.symbolId) ?? [];
}

/** Names are source-form and ids NFC; a comparison normalizes both sides. */
function nfc(text: string): string {
	return text.normalize("NFC");
}

/** `Acme.Services` and `Acme::Services` are the same name; so is a declaration spelled either way. */
function sameName(name: string, parts: readonly string[]): boolean {
	const own = name.split(QUALIFIER);
	return own.length === parts.length && own.every((part, i) => nfc(part) === nfc(parts[i] as string));
}

function addPlace(found: Map<string, Place>, place: Place): void {
	found.set(stepKey(place), place);
}

/**
 * Places named `name` beneath `prefix`: every declaration so named at any depth below it, and every
 * descriptor prefix so named that some declaration's path passes through.
 */
function placesNamed(tree: ModuleTree, prefix: readonly string[], name: string): Place[] {
	const found = new Map<string, Place>();
	for (const d of tree.declarations) {
		const path = pathOf(tree, d);
		if (!startsWith(path, prefix)) continue;
		if (nfc(d.name) === nfc(name)) {
			addPlace(found, { kind: "place", path: [...path, d.name], declaration: d, at: d.range });
		}
		for (let depth = prefix.length; depth < path.length; depth++) {
			if (nfc(path[depth] as string) !== nfc(name)) continue;
			const virtual = path.slice(0, depth + 1);
			const key = `${virtual.join("\0")}|`;
			if (!found.has(key)) found.set(key, { kind: "place", path: virtual, declaration: null, at: d.range });
		}
	}
	// A prefix some declaration owns outright is that declaration's place, not a second, empty one.
	for (const place of [...found.values()]) {
		if (place.declaration !== null) continue;
		if ([...found.values()].some((other) => other.declaration !== null && samePath(other.path, place.path))) {
			found.delete(stepKey(place));
		}
	}
	return [...found.values()];
}

/** One segment's parts against every scope: the qualified name in full, or a run of nested names. */
function matchParts(tree: ModuleTree, scopes: readonly (readonly string[])[], parts: readonly string[]): Place[] {
	const found = new Map<string, Place>();
	for (const scope of scopes) {
		if (parts.length > 1) {
			for (const d of tree.declarations) {
				if (!sameName(d.name, parts) || !startsWith(pathOf(tree, d), scope)) continue;
				addPlace(found, { kind: "place", path: [...pathOf(tree, d), d.name], declaration: d, at: d.range });
			}
		}
		let current: Place[] = [
			{
				kind: "place",
				path: [...scope],
				declaration: null,
				at: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
			},
		];
		for (const part of parts) {
			const next = new Map<string, Place>();
			for (const place of current)
				for (const reached of placesNamed(tree, place.path, part)) addPlace(next, reached);
			current = [...next.values()];
			if (current.length === 0) break;
		}
		for (const place of current) addPlace(found, place);
	}
	return [...found.values()].sort(stepOrder);
}

/** The owner's own parameters, by the id grammar's parameter descriptor, in document order. */
function parametersOf(tree: ModuleTree, owner: StoredDeclaration): StoredDeclaration[] {
	return tree.declarations.filter(
		(d) =>
			isParameterSymbol(d.symbolId) &&
			(d.containerId === owner.symbolId || ownerOf(d.symbolId) === owner.symbolId),
	);
}

function argumentsOf(tree: ModuleTree, owner: StoredDeclaration): Step[] {
	const parameters = parametersOf(tree, owner);
	const first = parameters[0];
	const last = parameters[parameters.length - 1];
	if (first === undefined || last === undefined) return [];
	return [{ kind: "arguments", owner, parameters, span: { start: first.range.start, end: last.range.end } }];
}

function scopesOf(steps: Step[] | null): string[][] {
	if (steps === null) return [[]];
	return steps.flatMap((step) => (step.kind === "place" ? [step.path] : []));
}

/** One segment, before its ordinal, applied to the steps so far; null steps is the module itself. */
function advanceName(tree: ModuleTree, steps: Step[] | null, segment: string): Step[] {
	if (steps?.some((step) => step.kind === "arguments")) {
		return steps
			.flatMap((step) => (step.kind === "arguments" ? step.parameters : []))
			.filter((parameter) => nfc(parameter.name) === nfc(segment))
			.sort(documentOrder)
			.map((declaration) => ({
				kind: "place" as const,
				path: [...pathOf(tree, declaration), declaration.name],
				declaration,
				at: declaration.range,
			}));
	}
	if (segment === ARGUMENTS) {
		return (steps ?? []).flatMap((step) =>
			step.kind === "place" && step.declaration !== null ? argumentsOf(tree, step.declaration) : [],
		);
	}
	const parts = segment.split(QUALIFIER);
	if (parts.some((part) => part === "")) return [];
	return matchParts(tree, scopesOf(steps), parts);
}

function advance(tree: ModuleTree, steps: Step[] | null, segment: string): Step[] {
	const ordinal = ORDINAL.exec(segment);
	const base = ordinal?.[1];
	if (ordinal === null || base === undefined) return advanceName(tree, steps, segment);
	const n = Number(ordinal[2]);
	const picked = advanceName(tree, steps, base)[n - 1];
	return n >= 1 && picked !== undefined ? [picked] : [];
}

function fold(tree: ModuleTree, segments: readonly string[]): Fold {
	let steps: Step[] | null = null;
	for (const [consumed, segment] of segments.entries()) {
		const next = advance(tree, steps, segment);
		if (next.length === 0) {
			const base = ORDINAL.exec(segment)?.[1] ?? segment;
			return { done: false, consumed, steps: steps ?? [], count: advanceName(tree, steps, base).length };
		}
		steps = next;
	}
	return { done: true, steps: steps ?? [] };
}

/** The segments that reach exactly this declaration: its path, the last with `[n]` when the path alone is ambiguous. */
function segmentsFor(tree: ModuleTree, declaration: StoredDeclaration): string[] {
	const path = [...pathOf(tree, declaration), declaration.name];
	const reached = fold(tree, path);
	const rivals = reached.done
		? reached.steps.filter((step) => step.kind === "place" && step.declaration !== null)
		: [];
	if (rivals.length <= 1) return path;
	const index = rivals.findIndex(
		(step) => step.kind === "place" && step.declaration?.symbolId === declaration.symbolId,
	);
	if (index < 0) return path;
	return [...path.slice(0, -1), `${declaration.name}[${index + 1}]`];
}

function candidateOf(tree: ModuleTree, step: Step): ChainCandidate | null {
	if (step.kind === "arguments") {
		return {
			symbolId: step.owner.symbolId,
			kind: step.owner.kind,
			name: ARGUMENTS,
			range: step.span,
			containerPath: [...pathOf(tree, step.owner), step.owner.name],
			segments: [...segmentsFor(tree, step.owner), ARGUMENTS],
		};
	}
	const { declaration } = step;
	if (declaration === null) return null;
	return {
		symbolId: declaration.symbolId,
		kind: declaration.kind,
		name: declaration.name,
		range: declaration.range,
		...(declaration.selectionRange === undefined ? {} : { selectionRange: declaration.selectionRange }),
		containerPath: pathOf(tree, declaration),
		segments: segmentsFor(tree, declaration),
	};
}

function candidatesOf(tree: ModuleTree, steps: Step[]): ChainCandidate[] {
	const found = new Map<string, ChainCandidate>();
	for (const step of [...steps].sort(stepOrder)) {
		const candidate = candidateOf(tree, step);
		if (candidate !== null && !found.has(`${candidate.symbolId}:${candidate.name}`)) {
			found.set(`${candidate.symbolId}:${candidate.name}`, candidate);
		}
	}
	return [...found.values()];
}

/** Names beneath the frontier, deduped in document order; every name in the module at the root. */
function availableBeneath(tree: ModuleTree, steps: Step[]): string[] {
	const prefixes = steps.length === 0 ? [[]] : scopesOf(steps);
	const own = new Set(
		steps.flatMap((step) => (step.kind === "place" && step.declaration ? [step.declaration.symbolId] : [])),
	);
	const names: string[] = [];
	for (const d of tree.declarations) {
		if (own.has(d.symbolId) || names.includes(d.name)) continue;
		if (prefixes.some((prefix) => startsWith(pathOf(tree, d), prefix))) names.push(d.name);
	}
	return names;
}

function frontierOf(
	tree: ModuleTree,
	stopped: Fold & { done: false },
): Pick<ChainAnswer & { kind: "none" }, "matched" | "available" | "availableTotal"> {
	const available = availableBeneath(tree, stopped.steps);
	return {
		matched: {
			containerPaths: scopesOf(stopped.steps.length === 0 ? null : stopped.steps).filter(
				(path) => path.length > 0,
			),
			consumed: stopped.consumed,
			count: stopped.count,
		},
		available: available.slice(0, AVAILABLE_CAP),
		availableTotal: available.length,
	};
}

/** Every reading that joins `k` adjacent segments into one qualified name, longest first. */
function joinedReadings(segments: readonly string[]): string[][] {
	const readings: string[][] = [];
	for (let k = segments.length; k >= 2; k--) {
		for (let i = 0; i + k <= segments.length; i++) {
			readings.push([...segments.slice(0, i), segments.slice(i, i + k).join("."), ...segments.slice(i + k)]);
		}
	}
	return readings;
}

/**
 * Resolve `segments` inside `module`.
 *
 * The first segment matches any declaration in the module; each later one any declaration beneath
 * the previous candidates, or a descriptor prefix their ids pass through. A segment is a name; a
 * qualified name (`Acme.Services` or `Physics::World`, matching a declaration named so in full or
 * a run of nested names); `name[n]` for the n-th match in document order; `arguments` for the
 * previous candidate's parameter list; or, after `arguments`, one parameter's name. A run of
 * segments also matches a declaration named by the run joined, never a proper prefix of one: the
 * plain fold is tried first, then the joined readings, and a tie across readings is ambiguous.
 * Ambiguity is an answer, never an error.
 */
export async function resolveChain(
	session: Pick<Session, "ask">,
	module: string,
	segments: string[],
): Promise<ChainAnswer> {
	const held = await session.ask("moduleDeclarations", { module });
	const hashes: ChainHashes = { contentHash: held.contentHash, diskHash: held.diskHash };
	const tree = treeOf(held.declarations);
	const nothing = (reason: ChainNoneReason, detail?: string): ChainAnswer => ({
		kind: "none",
		reason,
		...(detail === undefined ? {} : { detail }),
		matched: { containerPaths: [], consumed: 0, count: 0 },
		available: availableBeneath(tree, []).slice(0, AVAILABLE_CAP),
		availableTotal: availableBeneath(tree, []).length,
		...hashes,
	});

	if (held.read.kind === "missing") return nothing("missing");
	if (held.read.kind === "binary" || held.read.kind === "tooLarge") return nothing(held.read.kind, held.read.detail);
	if (!held.claimed) return nothing("unclaimed", held.unclaimedReason);
	if (held.failure !== undefined && held.declarations.length === 0) return nothing("parseFailed", held.failure);
	if (!held.indexed) return nothing("unread");
	if (segments.length === 0 || segments.includes("")) return nothing("noMatch");

	const plain = fold(tree, segments);
	const answer = (candidates: ChainCandidate[]): ChainAnswer | null => {
		const [only, second] = candidates;
		if (only === undefined) return null;
		if (second === undefined) return { kind: "exact", candidate: only, ...hashes };
		return { kind: "ambiguous", candidates, ...hashes };
	};
	if (plain.done) {
		const direct = answer(candidatesOf(tree, plain.steps));
		if (direct !== null) return direct;
	}

	const joined: ChainCandidate[][] = [];
	for (const reading of joinedReadings(segments)) {
		const read = fold(tree, reading);
		if (!read.done) continue;
		const candidates = candidatesOf(tree, read.steps);
		if (candidates.length > 0) joined.push(candidates);
	}
	if (joined.length > 0) {
		const merged = new Map<string, ChainCandidate>();
		for (const candidate of joined.flat()) merged.set(`${candidate.symbolId}:${candidate.name}`, candidate);
		const all = [...merged.values()].sort(documentOrder);
		return joined.length === 1
			? (answer(joined[0] as ChainCandidate[]) as ChainAnswer)
			: { kind: "ambiguous", candidates: all, ...hashes };
	}

	const stopped: Fold & { done: false } = plain.done
		? { done: false, consumed: segments.length, steps: plain.steps, count: 0 }
		: plain;
	return { kind: "none", reason: "noMatch", ...frontierOf(tree, stopped), ...hashes };
}
