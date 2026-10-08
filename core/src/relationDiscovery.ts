// Discovery's export snapshot and queue, with one owner. A shape is recorded seen only as its export
// queues, or by the quiet seed of a store discovery never started on; every other change stays fresh
// for the next observe to admit.

import type { Clock } from "./clock.js";
import { ReadContext } from "./readContext.js";
import { type Discovery, exportsIn } from "./relations.js";
import type { IndexStore, StoredDeclaration } from "./store.js";

////////////////////////////////
//  Interfaces & Types

/** A waiting export, and the facts generation it was read at. */
export interface QueuedExport {
	symbolId: string;
	module: string;
	generation: number;
}

////////////////////////////////
//  Constants

/** Fresh exports one module admits per observe. */
const ADMITTED_PER_MODULE = 20;

/** Exports a store's first start admits from the newest commits' files. */
const SAMPLE_EXPORTS = 30;

/** Suggestions one module keeps. */
const DISCOVERY_PER_MODULE = 10;

/** Below this best relation score, an export with no statement is a model gap. */
export const GAP_SCORE = 0.25;

////////////////////////////////
//  Functions & Helpers

/** What another module sees of an export; a body edit leaves it alone. */
function shapeOf(declaration: StoredDeclaration): string {
	return `${declaration.kind}\n${declaration.signature ?? ""}`;
}

////////////////////////////////
//  Class

export class RelationDiscovery {
	constructor(
		private readonly store: IndexStore,
		private readonly clock: Clock,
	) {}

	/**
	 * One transaction per daemon start. On a store discovery never started on, a module with no
	 * snapshot is recorded quietly, admitting up to `SAMPLE_EXPORTS` from `recent`, newest first;
	 * every module with one, and every module on a started store, is observed.
	 */
	start(recent: readonly string[]): void {
		const now = this.clock.now();
		const rows = this.store.relations;
		this.store.relationWrite(() => {
			const context = new ReadContext(this.store);
			const started = rows.seeded();
			const sampled = new Set(recent);
			let budget = SAMPLE_EXPORTS;
			const modules = new Set([...recent, ...this.store.exportingModules(), ...rows.exportModules()]);
			for (const module of modules) {
				if (started || rows.exportsOf(module) !== null) {
					this.observeIn(context, module, now);
					continue;
				}
				const shapes = this.shapesIn(context, module);
				if (shapes.size === 0) continue;
				const take = sampled.has(module) ? Math.min(budget, ADMITTED_PER_MODULE) : 0;
				const admitted = new Map([...shapes].slice(0, take));
				budget -= admitted.size;
				const quiet = new Map([...shapes].filter(([symbolId]) => !admitted.has(symbolId)));
				rows.recordExports(module, { admitted, quiet }, now);
			}
			rows.markSeeded();
		});
	}

	/** Admits each indexed module's added or reshaped exports, up to the cap; a forgotten module leaves whole. */
	observe(indexed: readonly string[], forgotten: readonly string[]): number {
		const now = this.clock.now();
		return this.store.relationWrite(() => {
			const context = new ReadContext(this.store);
			for (const module of forgotten) this.store.relations.forgetModule(module);
			return indexed.reduce((queued, module) => queued + this.observeIn(context, module, now), 0);
		});
	}

	/** The oldest waiting export and the facts generation it is read at, or null when none waits. */
	next(): QueuedExport | null {
		const queued = this.store.relations.nextQueued();
		return queued === null ? null : { ...queued, generation: this.store.factsGeneration() };
	}

	/**
	 * One export's discovery written, only over the facts it was scored on; otherwise it stays queued
	 * for another slice. A gap opens while nothing relates to it strongly, and closes once something
	 * does. A module whose queue drains admits what its cap left fresh.
	 */
	settle(queued: QueuedExport, found: Discovery | null): boolean {
		if (this.store.factsGeneration() !== queued.generation) return false;
		const { symbolId, module } = queued;
		const now = this.clock.now();
		const rows = this.store.relations;
		this.store.relationWrite(() => {
			rows.dequeue(symbolId);
			if (found !== null && this.store.declaration(symbolId) !== null) {
				rows.replaceDiscovery(symbolId, module, found.modules, now, DISCOVERY_PER_MODULE);
				if (found.best < GAP_SCORE && !found.stated) rows.addGap(symbolId, module, now);
				else rows.closeGap(symbolId);
			}
			if (rows.queuedIn(module) === 0) this.observeIn(new ReadContext(this.store), module, now);
		});
		return true;
	}

	/** One module's fresh exports admitted, up to the cap, and its gone ones forgotten; inside a write. */
	private observeIn(context: ReadContext, module: string, now: number): number {
		const rows = this.store.relations;
		const held = rows.exportsOf(module);
		const current = this.shapesIn(context, module);
		const fresh = [...current].filter(([symbolId, shape]) => held?.get(symbolId) !== shape);
		const admitted = new Map(fresh.slice(0, ADMITTED_PER_MODULE));
		const gone = [...(held?.keys() ?? [])].filter((symbolId) => !current.has(symbolId));
		if (admitted.size > 0 || gone.length > 0) rows.recordExports(module, { admitted, gone }, now);
		return admitted.size;
	}

	private shapesIn(context: ReadContext, module: string): Map<string, string> {
		return new Map(exportsIn(context, module).map((each) => [each.symbolId, shapeOf(each)]));
	}
}
