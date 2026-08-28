// A name chain inside one module, answered from the wire: the one declaration it names, every
// candidate when it names several, or the reason there was nothing to walk.
//
// The walk follows `containerId`, so a segment reaches any declaration beneath the previous ones
// however many unnamed layers sit between. Coordinates are the protocol's, 0-based, untouched.

import {
	isParameterSymbol,
	ownerOf,
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
}

export type ChainAnswer =
	| { kind: "exact"; candidate: ChainCandidate }
	| { kind: "ambiguous"; candidates: ChainCandidate[] }
	| { kind: "none"; reason: "unclaimed" | "unread" | "missing" | "noMatch" };

/** A declaration the walk reached, or a declaration's parameter list reached through `arguments`. */
type Step =
	| { kind: "declaration"; declaration: StoredDeclaration }
	| { kind: "arguments"; owner: StoredDeclaration; parameters: StoredDeclaration[]; span: Range };

interface ModuleTree {
	/** Document order. */
	declarations: StoredDeclaration[];
	byId: Map<string, StoredDeclaration>;
}

////////////////////////////////
//  Constants

/** Both spellings of a qualified name mean the same. */
const QUALIFIER = /::|\./;

/** `name[n]`, counted from 1 in document order. */
const ORDINAL = /^(.+)\[([0-9]+)\]$/;

const ARGUMENTS = "arguments";

////////////////////////////////
//  Functions & Helpers

function documentOrder(a: { range: Range; symbolId: string }, b: { range: Range; symbolId: string }): number {
	const byPosition = a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
	if (byPosition !== 0) return byPosition;
	return a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0;
}

/** Whether `declaration` sits beneath any of `ancestors`. A container the module does not hold ends the climb. */
function beneath(tree: ModuleTree, declaration: StoredDeclaration, ancestors: ReadonlySet<string>): boolean {
	const seen = new Set<string>();
	let id = declaration.containerId;
	while (id !== undefined && !seen.has(id)) {
		if (ancestors.has(id)) return true;
		seen.add(id);
		id = tree.byId.get(id)?.containerId;
	}
	return false;
}

function containerPath(tree: ModuleTree, declaration: StoredDeclaration): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	let id = declaration.containerId;
	while (id !== undefined && !seen.has(id)) {
		seen.add(id);
		const container = tree.byId.get(id);
		if (container === undefined) break;
		names.unshift(container.name);
		id = container.containerId;
	}
	return names;
}

/** Declarations passing `test` beneath `from`, or anywhere in the module when `from` is null. */
function named(
	tree: ModuleTree,
	from: ReadonlySet<string> | null,
	test: (name: string) => boolean,
): StoredDeclaration[] {
	return tree.declarations.filter((d) => test(d.name) && (from === null || beneath(tree, d, from)));
}

/** `Acme.Services` and `Acme::Services` are the same name; so is a declaration spelled either way. */
function sameName(name: string, parts: string[]): boolean {
	const own = name.split(QUALIFIER);
	return own.length === parts.length && own.every((part, i) => part === parts[i]);
}

/** A segment names a declaration whose own name is the qualified name, or the end of a run of nested names. */
function matchSegment(tree: ModuleTree, from: ReadonlySet<string> | null, segment: string): StoredDeclaration[] {
	const parts = segment.split(QUALIFIER);
	const found = new Map<string, StoredDeclaration>();
	for (const d of named(tree, from, (name) => sameName(name, parts))) found.set(d.symbolId, d);

	if (parts.length > 1 && parts.every((part) => part !== "")) {
		let scope = from;
		let run: StoredDeclaration[] = [];
		for (const part of parts) {
			run = named(tree, scope, (name) => name === part);
			if (run.length === 0) break;
			scope = new Set(run.map((d) => d.symbolId));
		}
		for (const d of run) found.set(d.symbolId, d);
	}
	return [...found.values()].sort(documentOrder);
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

/** One segment, before its ordinal, applied to the steps so far; null steps is the module itself. */
function advanceName(tree: ModuleTree, steps: Step[] | null, segment: string): Step[] {
	if (steps?.some((step) => step.kind === "arguments")) {
		return steps
			.flatMap((step) => (step.kind === "arguments" ? step.parameters : []))
			.filter((parameter) => parameter.name === segment)
			.sort(documentOrder)
			.map((declaration) => ({ kind: "declaration", declaration }));
	}
	if (segment === ARGUMENTS) {
		return (steps ?? []).flatMap((step) =>
			step.kind === "declaration" ? argumentsOf(tree, step.declaration) : [],
		);
	}
	const from = steps === null ? null : new Set(steps.map((step) => stepId(step)));
	return matchSegment(tree, from, segment).map((declaration) => ({ kind: "declaration", declaration }));
}

function stepId(step: Step): string {
	return step.kind === "declaration" ? step.declaration.symbolId : step.owner.symbolId;
}

function advance(tree: ModuleTree, steps: Step[] | null, segment: string): Step[] {
	const ordinal = ORDINAL.exec(segment);
	const base = ordinal?.[1];
	if (ordinal === null || base === undefined) return advanceName(tree, steps, segment);
	const n = Number(ordinal[2]);
	const picked = advanceName(tree, steps, base)[n - 1];
	return n >= 1 && picked !== undefined ? [picked] : [];
}

function candidateOf(tree: ModuleTree, step: Step): ChainCandidate {
	if (step.kind === "arguments") {
		return {
			symbolId: step.owner.symbolId,
			kind: step.owner.kind,
			name: ARGUMENTS,
			range: step.span,
			containerPath: [...containerPath(tree, step.owner), step.owner.name],
		};
	}
	const { declaration } = step;
	return {
		symbolId: declaration.symbolId,
		kind: declaration.kind,
		name: declaration.name,
		range: declaration.range,
		...(declaration.selectionRange === undefined ? {} : { selectionRange: declaration.selectionRange }),
		containerPath: containerPath(tree, declaration),
	};
}

/**
 * Resolve `segments` inside `module`.
 *
 * The first segment matches any declaration in the module; each later one any declaration beneath
 * the previous candidates. A segment is a name, a qualified name (`Acme.Services` or
 * `Physics::World`, matching a declaration named so or a run of nested names), `name[n]` for the
 * n-th match in document order, `arguments` for the previous candidate's parameter list, or, after
 * `arguments`, one parameter's name. Ambiguity is an answer, never an error.
 */
export async function resolveChain(
	session: Pick<Session, "ask">,
	module: string,
	segments: string[],
): Promise<ChainAnswer> {
	if (segments.length === 0 || segments.includes("")) return { kind: "none", reason: "noMatch" };

	const status = await session.ask("moduleStatus", { module });
	if (!status.exists) return { kind: "none", reason: "missing" };
	if (!status.claimed) return { kind: "none", reason: "unclaimed" };
	if (!status.indexed) return { kind: "none", reason: "unread" };

	const declarations = [...(await session.ask("declarationsIn", { module }))].sort(documentOrder);
	const tree: ModuleTree = { declarations, byId: new Map(declarations.map((d) => [d.symbolId, d])) };

	let steps: Step[] | null = null;
	for (const segment of segments) {
		steps = advance(tree, steps, segment);
		if (steps.length === 0) return { kind: "none", reason: "noMatch" };
	}

	const candidates = (steps ?? []).map((step) => candidateOf(tree, step)).sort(documentOrder);
	const [only, second] = candidates;
	if (only === undefined) return { kind: "none", reason: "noMatch" };
	if (second === undefined) return { kind: "exact", candidate: only };
	return { kind: "ambiguous", candidates };
}
