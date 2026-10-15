// Bindings that cross sourced files.

import {
	type Binding,
	comparePositions,
	defined,
	type ImportGraphCallbacks,
	type ImportResolution,
	type Position,
	type UnknownReason,
	walkImportGraph,
} from "@nyaa-lexicon/protocol";
import type { BashDeclaration, BashReference, ParsedBashFile, SourceImport } from "./extract.js";

////////////////////////////////
//  Interfaces & Types

type Unresolved = Exclude<ImportResolution, { status: "resolved" }>;

interface Binder {
	symbolId: string;
	at?: Position;
}

interface BindingState {
	module: string;
	facts?: ParsedBashFile | null;
	factsLoaded: boolean;
	reference: BashReference;
	mode: "settled" | "candidates";
	settled?: Binder | undefined;
	ownLoaded: boolean;
	before?: Position;
	report: (status: Unresolved, specifier: string) => void;
}

interface BindingValue {
	settled?: Binder;
	candidates?: Set<string>;
}

interface BindingContext {
	factsFor: (module: string) => ParsedBashFile | null;
	resolveImport: (params: { fromModule: string; specifier: string }) => ImportResolution;
}

////////////////////////////////
//  Functions & Helpers

function unbound(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function bound(symbolId: string): Binding {
	return { status: "bound", symbolId, provenance: "bound" };
}

function binderOf(facts: ParsedBashFile, declaration: BashDeclaration, before?: Position): Binder {
	let at: Position | undefined;
	const consider = (position: Position) => {
		if (before !== undefined && comparePositions(position, before) >= 0) return;
		if (at === undefined || comparePositions(position, at) > 0) at = position;
	};
	consider(declaration.range.start);
	if (declaration.kind !== "function") {
		for (const reference of facts.references) {
			if (
				reference.role === "write" &&
				reference.fromId === undefined &&
				reference.target === declaration.symbolId
			)
				consider(reference.range.start);
		}
	}
	return { symbolId: declaration.symbolId, ...defined({ at }) };
}

function ownDefinition(facts: ParsedBashFile, reference: BashReference): Binder | undefined {
	const declaration = reference.ofFunction
		? facts.functionsByName.get(reference.name)?.at(-1)
		: facts.globalsByName.get(reference.name);
	return declaration === undefined ? undefined : binderOf(facts, declaration);
}

function reportFailure(state: BindingState, status: Unresolved, specifier: string): void {
	state.report(status, specifier);
}

function factsFor(state: BindingState, context: BindingContext): ParsedBashFile | null {
	if (!state.factsLoaded) {
		state.facts = context.factsFor(state.module);
		state.factsLoaded = true;
	}
	return state.facts ?? null;
}

function callbacks(context: BindingContext): ImportGraphCallbacks<BindingState, SourceImport, BindingValue, string> {
	return {
		module: (state) => state.module,
		key: (state) => state.module,
		imports: (state) => {
			const facts = factsFor(state, context);
			if (facts === null) return [];
			if (state.mode === "candidates") return facts.sources;
			return facts.sources.filter((source) => {
				if (state.before !== undefined && comparePositions(source.range.start, state.before) >= 0) return false;
				return state.settled?.at === undefined || comparePositions(source.range.start, state.settled.at) >= 0;
			});
		},
		resolve: (state, edge) => {
			const resolution = context.resolveImport({ fromModule: state.module, specifier: edge.specifier });
			if (resolution.status !== "resolved") {
				reportFailure(state, resolution, edge.specifier);
				return undefined;
			}
			if (resolution.landing.kind !== "module") return undefined;
			return {
				module: resolution.landing.module,
				reference: state.reference,
				mode: "settled",
				factsLoaded: false,
				ownLoaded: false,
				report: state.report,
			};
		},
		initial: (state) => {
			if (state.mode === "candidates") return { candidates: new Set() };
			if (!state.ownLoaded) {
				const facts = factsFor(state, context);
				state.settled = facts === null ? undefined : ownDefinition(facts, state.reference);
				state.ownLoaded = true;
			}
			return { ...defined({ settled: state.settled }) };
		},
		apply: (state, edge, current, child) => {
			const settled = child?.settled;
			if (settled === undefined) return current;
			if (state.mode === "candidates") {
				current.candidates?.add(settled.symbolId);
				return current;
			}
			return { settled: { symbolId: settled.symbolId, at: edge.range.start } };
		},
	};
}

export function bindBashReference(
	module: string,
	parsed: ParsedBashFile,
	reference: BashReference,
	context: BindingContext,
): Binding {
	if (reference.role === "import") return importBinding(module, reference.name, context);
	const target = reference.target;
	if (target !== undefined && (reference.fromId !== undefined || reference.role === "write")) return bound(target);

	let reason: UnknownReason = "NotIndexed";
	let detail = `no bash declaration matches ${reference.name}`;
	const report = (status: Unresolved, specifier: string) => {
		if (status.status === "external") {
			reason = "ExternalDependency";
			detail = `${reference.name} may come from ${specifier}, outside the workspace`;
		} else {
			reason = status.reason;
			detail = status.detail ?? detail;
		}
	};
	const mode = reference.fromId === undefined ? "settled" : "candidates";
	const declaration = parsed.declarations.find((candidate) => candidate.symbolId === target);
	const state: BindingState = {
		module,
		facts: parsed,
		factsLoaded: true,
		reference,
		mode,
		ownLoaded: true,
		...(mode === "settled"
			? {
					...defined({
						settled:
							declaration === undefined
								? undefined
								: binderOf(parsed, declaration, reference.range.start),
					}),
					before: reference.range.start,
				}
			: {}),
		report,
	};
	const value = walkImportGraph(state, callbacks(context), new Map());
	if (mode === "candidates") {
		const candidates = [...(value.candidates ?? [])];
		if (candidates.length > 1) return { status: "ambiguous", candidates, provenance: "bound" };
		const [only] = candidates;
		return only === undefined ? unbound(reason, detail) : bound(only);
	}
	return value.settled === undefined ? unbound(reason, detail) : bound(value.settled.symbolId);
}

function importBinding(module: string, specifier: string, context: BindingContext): Binding {
	const resolution = context.resolveImport({ fromModule: module, specifier });
	if (resolution.status === "external")
		return unbound("ExternalDependency", "the sourced file is outside the workspace");
	if (resolution.status === "unresolved")
		return unbound(resolution.reason, resolution.detail ?? "the sourced path is unresolved");
	return unbound("NotIndexed", "a sourced path names a module, not a declaration");
}
