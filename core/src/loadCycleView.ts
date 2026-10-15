// Runtime load-cycle graph and component views.

import type { ModuleCycle, Range, ReferenceRole } from "@nyaa-lexicon/protocol";
import { spanKey } from "./factAdmission.js";
import { type Edge, findCycles } from "./graph.js";
import type { Gate } from "./stepRunners.js";
import type { IndexStore } from "./store.js";

////////////////////////////////
//  Interfaces & Types

export type Cycle = {
	key: string;
	/** The facts generation of the view it was read from; a newer view supersedes an older one. */
	generation: number;
	modules: string[];
	entries: string[];
	crossingCount: number;
	crossings: ModuleCycle["crossings"];
	uncertainReason: "undecided" | "runtime" | null;
};

/** The components of one facts generation. */
type Held = { generation: number; cycles: Cycle[]; byKey: Map<string, Cycle> };

export type { Held };

/** The candidate graph and what components read from it. */
export type Graph = {
	edges: Edge[];
	/** By module and span. A kept type-only edge loads but carries no value. */
	valueEdges: Map<string, Map<string, string>>;
	importers: Map<string, Set<string>>;
	/** Targets each module reaches through a static edge emit has not decided. */
	undecided: Map<string, Set<string>>;
};

type LoadEdge = ReturnType<IndexStore["loadEdges"]>[number];

////////////////////////////////
//  Constants

/** Uses that read no value at runtime. */
const NOT_READS: readonly ReferenceRole[] = ["typeUse", "import", "export", "implements"];
const CROSSINGS_LISTED = 20;

////////////////////////////////
//  Functions & Helpers

/** Emit's decision wins; a type-only edge it has not decided loads nothing. */
function loadsAtRuntime(edge: LoadEdge): boolean {
	return edge.elided === undefined ? !edge.typeOnly : !edge.elided;
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
	const set = map.get(key);
	if (set === undefined) map.set(key, new Set([value]));
	else set.add(value);
}

export function graphOf(rows: readonly LoadEdge[]): Graph {
	const graph: Graph = { edges: [], valueEdges: new Map(), importers: new Map(), undecided: new Map() };
	for (const edge of rows) {
		if (!loadsAtRuntime(edge)) continue;
		const { module, target } = edge;
		if (!edge.typeOnly) {
			const bySpan = graph.valueEdges.get(module) ?? new Map<string, string>();
			const span = spanKey(edge.span);
			if (!bySpan.has(span)) bySpan.set(span, target);
			graph.valueEdges.set(module, bySpan);
		}
		addTo(graph.importers, target, module);
		if (edge.loads !== "static") continue;
		if (edge.elided === undefined) addTo(graph.undecided, module, target);
		graph.edges.push({ from: module, to: target });
	}
	return graph;
}

/**
 * Each component's value reads through a runtime edge landing inside it, bound or not, and every
 * member's runtime. Inside the gate, so it counts in the store and lists only the first few.
 */
function readDetail(store: IndexStore, components: readonly string[][], graph: Graph) {
	const members = components.flat();
	const counted = new Map<string, Array<{ origin: Range; count: number }>>();
	for (const { module, origin, count } of store.importUseCounts(members, NOT_READS)) {
		const list = counted.get(module);
		if (list === undefined) counted.set(module, [{ origin, count }]);
		else list.push({ origin, count });
	}
	const crossings = components.map((modules) => {
		const group = new Set(modules);
		let crossingCount = 0;
		const listed: Cycle["crossings"] = [];
		for (const module of modules) {
			for (const { origin, count } of counted.get(module) ?? []) {
				const target = graph.valueEdges.get(module)?.get(spanKey(origin));
				if (target === undefined || !group.has(target)) continue;
				crossingCount += count;
				const room = CROSSINGS_LISTED - listed.length;
				if (room <= 0) continue;
				for (const use of store.importUsesThrough(module, origin, NOT_READS, room))
					listed.push({ module, name: use.name, range: use.range, target });
			}
		}
		return { crossingCount, crossings: listed };
	});
	return { generation: store.factsGeneration(), crossings, runtimes: store.runtimesOf(members) };
}

function assemble(
	generation: number,
	components: readonly string[][],
	graph: Graph,
	detail: ReturnType<typeof readDetail>,
): Held {
	const cycles = components.map((modules, index): Cycle => {
		const group = new Set(modules);
		const reached = modules.filter((member) => {
			const from = graph.importers.get(member);
			return from === undefined || [...from].some((importer) => !group.has(importer));
		});
		const undecided = modules.some((member) =>
			[...(graph.undecided.get(member) ?? [])].some((to) => group.has(to)),
		);
		const { crossingCount, crossings } = detail.crossings[index]!;
		return {
			key: modules.join("\u0000"),
			generation,
			modules,
			entries: reached.length === 0 ? modules : reached,
			crossingCount,
			crossings,
			uncertainReason: undecided
				? "undecided"
				: modules.some((member) => (detail.runtimes.get(member) ?? null) === null)
					? "runtime"
					: null,
		};
	});
	return { generation, cycles, byKey: new Map(cycles.map((cycle) => [cycle.key, cycle])) };
}

export function componentsOf(graph: Graph): string[][] {
	return findCycles(graph.edges).map(({ members }) => [...members].sort());
}

/** The whole view from one hold, so its graph, crossings and runtimes share a generation. */
export function buildIn(store: IndexStore): Held {
	const generation = store.factsGeneration();
	const graph = graphOf(store.loadEdges());
	const components = componentsOf(graph);
	return assemble(generation, components, graph, readDetail(store, components, graph));
}

/** Two-read builds tried before one hold builds the whole view, so a view is never two generations. */
const BUILD_ATTEMPTS = 2;

export class LoadCycleView {
	constructor(
		private readonly store: IndexStore,
		private readonly currentHeld: () => Held | null,
		private readonly shortRead: <T>(dispatchGate: Gate | undefined, work: () => T) => Promise<T>,
		private readonly keep: (built: Held) => Held,
	) {}

	private get held(): Held | null {
		return this.currentHeld();
	}

	/**
	 * The components as of now, built once per facts generation. Rows are read inside the gate and
	 * the graph is built outside it; when writes keep landing between the two reads, one hold builds it.
	 */
	async componentsNow(dispatchGate?: Gate): Promise<Held> {
		for (let attempt = 0; attempt < BUILD_ATTEMPTS; attempt++) {
			const read = await this.shortRead(dispatchGate, () => {
				const generation = this.store.factsGeneration();
				const held = this.held;
				return held?.generation === generation ? { held } : { generation, rows: this.store.loadEdges() };
			});
			if ("held" in read) return read.held;
			const graph = graphOf(read.rows);
			const components = componentsOf(graph);
			const detail = await this.shortRead(dispatchGate, () => readDetail(this.store, components, graph));
			if (detail.generation === read.generation)
				return this.keep(assemble(read.generation, components, graph, detail));
		}
		// The hold is the reads every build takes anyway plus the linear graph work between them, shared.
		return this.keep(await this.shortRead(dispatchGate, () => buildIn(this.store)));
	}
}

export function previewComponents(store: IndexStore, facts: readonly import("./store.js").ReplaceFileInput[]): Cycle[] {
	return withPreviewComponents(store, facts, (cycles) => cycles);
}

export function withPreviewComponents<T>(
	store: IndexStore,
	facts: readonly import("./store.js").ReplaceFileInput[],
	read: (cycles: Cycle[]) => T,
): T {
	return store.readOverlaid(facts, () =>
		read(
			buildIn(store).cycles.map((cycle) => ({
				...cycle,
				modules: [...cycle.modules],
				entries: [...cycle.entries],
			})),
		),
	);
}

export function newCycleComponents(candidate: readonly Cycle[], baseline: readonly Cycle[]): Cycle[] {
	return candidate.filter(
		(cycle) => !baseline.some((before) => cycle.modules.every((module) => before.modules.includes(module))),
	);
}
