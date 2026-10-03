// A parse's import edges and `__all__` targets, settled against the modules they reach.

import { type AllList, type ExportTarget, type Import, type ImportEdge, sameRange } from "@nyaa-lexicon/protocol";
import { type Binder, submoduleSpecifier } from "./binding";
import type { Range } from "./facts/types";
import type { MappedFacts } from "./mapped";

////////////////////////////////
//  Constants

const AMBIGUOUS: ExportTarget = { kind: "unknown", reason: "Ambiguous" };

////////////////////////////////
//  Functions & Helpers

/** A named edge rewritten as the namespace binding of the submodule it names. */
function namespaceEdge(edge: ImportEdge): ImportEdge {
	const { name, range, local, localRange, ...rest } = edge;
	return { ...rest, kind: "namespace", local: local ?? name, localRange: localRange ?? range };
}

/**
 * Each `from pkg import mod` that binds a submodule, as a namespace edge on `pkg.mod`. A statement
 * left with no edge on `pkg` still loads it, which its load edge says.
 */
export async function wireImports(module: string, facts: MappedFacts, binder: Binder): Promise<Import[]> {
	const wired: Import[] = [];
	for (const statement of facts.imports) {
		const kept: ImportEdge[] = [];
		const submodules: Import[] = [];
		for (const edge of statement.edges) {
			const name = edge.kind === "named" ? edge.name : undefined;
			const moduleLevel = facts.importBindings.some(
				(binding) => binding.scopePath.length === 0 && sameRange(binding.span, edge.span),
			);
			const own = moduleLevel ? edge.span : undefined;
			if (name === undefined || (await binder.fromSubmodule(module, statement.specifier, name, own)) === null) {
				kept.push(edge);
				continue;
			}
			submodules.push({ specifier: submoduleSpecifier(statement.specifier, name), edges: [namespaceEdge(edge)] });
		}
		const load = facts.loads.get(statement);
		if (kept.length > 0) wired.push({ specifier: statement.specifier, edges: kept });
		else if (load !== undefined) wired.push({ specifier: statement.specifier, edges: [load] });
		wired.push(...submodules);
	}
	return wired;
}

/** What a static `__all__` entry names once its competing stars are read. */
async function starTarget(
	module: string,
	facts: MappedFacts,
	binder: Binder,
	entry: { name: string; target: ExportTarget },
	stars: readonly Range[],
): Promise<ExportTarget> {
	const offering: Array<{ span: Range; conditional: boolean; proved: boolean }> = [];
	for (const span of stars) {
		const star = facts.importBindings.find((binding) => binding.star && sameRange(binding.span, span));
		if (star === undefined) return AMBIGUOUS;
		const offer = await binder.starOffers(module, star, entry.name);
		if (offer !== "absent") offering.push({ span, conditional: star.conditional, proved: offer === "brings" });
	}
	const [only] = offering;
	if (only === undefined) return entry.target;
	// A later star outranks a binder only once proved to bring the name.
	if (offering.length > 1 || only.conditional || (entry.target.kind !== "unknown" && !only.proved)) return AMBIGUOUS;
	return { kind: "import", span: only.span };
}

/** `__all__`, with each entry a star may bind decided by what the stars bring. */
export async function wireAllList(module: string, facts: MappedFacts, binder: Binder): Promise<AllList | undefined> {
	const { allList } = facts;
	if (allList?.state !== "static") return allList;
	const entries: typeof allList.entries = [];
	for (const [index, entry] of allList.entries.entries()) {
		const stars = facts.allListStars[index] ?? [];
		entries.push(
			stars.length === 0 ? entry : { ...entry, target: await starTarget(module, facts, binder, entry, stars) },
		);
	}
	return { state: "static", entries };
}
