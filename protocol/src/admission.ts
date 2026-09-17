// What the index admitted, as a provider holds it: the one gate its cross-file state passes.

import type { z } from "zod";
import type { NOTIFICATION_SCHEMAS } from "./methods.js";

////////////////////////////////
//  Interfaces & Types

export type ModuleAdmission = z.infer<(typeof NOTIFICATION_SCHEMAS)["moduleAdmission"]>;

/** What a module's cross-file state must hold; absent `facts` means hold nothing for it. */
export interface RestoredFacts<T> {
	module: string;
	facts: T | undefined;
}

/** A parse whose verdict has not arrived, with what its facts displaced. */
interface Staged<T> {
	contentHash: string;
	replaced: T | undefined;
}

/** One module's outstanding parses, oldest first. */
type Chain<T> = Array<Staged<T>>;

////////////////////////////////
//  Class

/**
 * One record of the index's word per module, and the tombstone a fill honours.
 *
 * `T` is whatever the provider holds for a module, so a refusal puts back exactly what the parse
 * displaced rather than leaving the provider to reconstruct it. A provider that would rather hold
 * nothing stages `undefined`.
 */
export class AdmissionLedger<T> {
	/**
	 * Parses answered and not yet settled, oldest first per module.
	 *
	 * A chain rather than one entry, because a module can be parsed again before the first verdict
	 * arrives. Keeping only the newest lost what the older parse displaced, so refusing both left
	 * the provider on facts the index never admitted.
	 */
	private readonly pending = new Map<string, Chain<T>>();
	/** Modules the index does not hold; a fill reading one back would undo the correction. */
	private readonly withheld = new Set<string>();

	/** A parse answered and its facts are in the cross-file state, displacing `replaced`. */
	staged(module: string, contentHash: string, replaced: T | undefined): void {
		const chain = this.pending.get(module);
		if (chain === undefined) this.pending.set(module, [{ contentHash, replaced }]);
		else chain.push({ contentHash, replaced });
		this.withheld.delete(module);
	}

	/**
	 * The index's word. Answers what the cross-file state must hold, or null when it stands.
	 *
	 * Verdicts for one module arrive in parse order, since the core publishes each on the queue the
	 * parse rode. So a verdict naming anything but the OLDEST outstanding parse describes one
	 * already settled, and settles nothing.
	 */
	settle(verdict: ModuleAdmission): RestoredFacts<T> | null {
		const chain = this.pending.get(verdict.module);
		const oldest = chain?.[0];
		if (chain === undefined || oldest === undefined || oldest.contentHash !== verdict.contentHash) return null;
		chain.shift();
		if (chain.length === 0) this.pending.delete(verdict.module);

		if (verdict.outcome.status === "admitted") {
			// The index holds this module again, whatever an earlier refusal withheld.
			this.withheld.delete(verdict.module);
			return null;
		}
		this.withheld.add(verdict.module);

		// A refused parse never landed, so what the parse AFTER it displaced is what this one did.
		// Restoring now would instead throw away a later parse that may yet be admitted.
		const next = chain[0];
		if (next !== undefined) {
			next.replaced = oldest.replaced;
			return null;
		}
		return { module: verdict.module, facts: oldest.replaced };
	}

	/** The index holds nothing for this module, and no fill reads it until a parse names it. */
	forgotten(module: string): void {
		this.pending.delete(module);
		this.withheld.add(module);
	}

	/** Whether a read off disk may fill this module. */
	fillable(module: string): boolean {
		return !this.withheld.has(module);
	}

	/** A new workspace; nothing carried over. */
	reset(): void {
		this.pending.clear();
		this.withheld.clear();
	}
}
