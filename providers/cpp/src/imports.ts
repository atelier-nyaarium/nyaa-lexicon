// A file's imports as transfer edges: an include injects its header, a using-directive a namespace,
// a using-declarator one name of it, and a namespace alias the namespace under a new name.

import type { Certainty, Conflict, Import, ImportEdge, ImportResolution } from "@nyaa-lexicon/protocol";
import type { CppFacts, NamespaceTransfer } from "./model.js";

////////////////////////////////
//  Interfaces & Types

type Edge = Omit<ImportEdge, "order">;

////////////////////////////////
//  Constants

/** A name two injections bring alike is ambiguous; a local declaration hides it. */
const INJECTED: Conflict = { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" };

/** A using-declaration or alias declares its name here, hiding what an injection brings. */
const DECLARED: Conflict = { priority: 1, amongTransfers: "exclude", againstLocal: "localWins" };

////////////////////////////////
//  Functions & Helpers

/** Proved only when the namespace lands on one scope. */
function certaintyOf(resolution: ImportResolution): Certainty {
	if (resolution.status === "resolved") return { status: "known" };
	return { status: "unknown", reason: resolution.status === "external" ? "ExternalDependency" : resolution.reason };
}

function transferEdge({ kind, span, name }: NamespaceTransfer, certainty: Certainty): Edge {
	if (kind === "injection")
		return { kind, span, selector: { kind: "visible" }, bindsLocally: true, conflict: INJECTED, certainty };
	const written =
		name === undefined
			? {}
			: kind === "named"
				? { name: name.text, range: name.range }
				: { local: name.text, localRange: name.range };
	return { kind, span, ...written, bindsLocally: true, conflict: DECLARED, certainty };
}

/** Each include and namespace transfer in source order, `landed` saying where a namespace specifier lands. */
export function importsOf(facts: CppFacts, landed: (specifier: string) => ImportResolution): Import[] {
	const certainties = new Map<string, Certainty>();
	const certainty = (specifier: string) => {
		const known = certainties.get(specifier) ?? certaintyOf(landed(specifier));
		certainties.set(specifier, known);
		return known;
	};
	const written: Array<{ at: number; specifier: string; edge: Edge }> = [
		...facts.importFacts.map(({ tokenStart, specifier, span }) => ({
			at: tokenStart,
			specifier,
			edge: {
				kind: "injection",
				span,
				selector: { kind: "visible" },
				bindsLocally: true,
				conflict: INJECTED,
				certainty: { status: "known" },
			} satisfies Edge,
		})),
		...facts.transfers.map((transfer) => ({
			at: transfer.tokenStart,
			specifier: transfer.specifier,
			edge: transferEdge(transfer, certainty(transfer.specifier)),
		})),
	];
	return written
		.sort((left, right) => left.at - right.at)
		.map(({ specifier, edge }, order) => ({ specifier, edges: [{ ...edge, order }] }));
}
