// Owns GDScript static import facts and loader name resolution.

import { type Certainty, type Conflict, comparePositions, type Import, type ImportEdge } from "@nyaa-lexicon/protocol";
import { type ExtendsPath, extendsPaths, type LoaderCall, loaderCalls } from "./path-syntax.js";
import type { ParsedScript } from "./script.js";

//////// Constants

const KNOWN: Certainty = { status: "known" };

const COMPUTED: Certainty = { status: "unknown", reason: "RuntimeConstructed" };

/** A nested local shadows the member; a second member of one name does not parse. */
const LOADER_CONFLICT: Conflict = { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" };

//////// Edges

type Unordered = Omit<ImportEdge, "order">;

/** A loader bound as a whole initializer is a require; any other loads unbound. */
function loaderEdge(call: LoaderCall): Unordered {
	const certainty = call.literal === undefined ? COMPUTED : KNOWN;
	const binding = call.binding;
	if (binding?.whole !== true) return { kind: "sideEffect", span: call.span, bindsLocally: false, certainty };
	return {
		kind: "require",
		span: call.span,
		local: binding.name,
		localRange: binding.range,
		bindsLocally: true,
		conflict: LOADER_CONFLICT,
		certainty,
	};
}

/** The base script's members, and its own base's in turn, enter the class unbound. */
function extendsEdge(path: ExtendsPath): Unordered {
	return { kind: "injection", span: path.span, selector: { kind: "visible" }, bindsLocally: false, certainty: KNOWN };
}

//////// Imports

export function loaderCallsOf(script: ParsedScript): LoaderCall[] {
	if (!script.module.endsWith(".gd")) return [];
	return loaderCalls(script.lexed.tokens, script.coordinates, script.declarations);
}

/** One statement per loader call and `extends` path, in source order. */
export function importsOf(script: ParsedScript, calls = loaderCallsOf(script)): Import[] {
	if (!script.module.endsWith(".gd")) return [];
	const written = [
		...extendsPaths(script.lexed.tokens).map((path) => ({ specifier: path.path, edge: extendsEdge(path) })),
		...calls.map((call) => ({ specifier: call.specifier, edge: loaderEdge(call) })),
	].sort((left, right) => comparePositions(left.edge.span.start, right.edge.span.start));
	return written.map(({ specifier, edge }, order) => ({ specifier, edges: [{ ...edge, order }] }));
}
