// The workspace as text on disk, and how a symbol maps onto it.
//
// Kept apart from the index because a stale answer IS the two disagreeing. Decides what to write;
// sourceWriter.ts decides how.

import { coordinatesOf, hashContent, type Range, type SymbolSource } from "@nyaa-lexicon/protocol";
import { insideWorkspace } from "./sourceRead.js";
import { writeSourceFile } from "./sourceWriter.js";
import type { IndexStore } from "./store.js";

export type { SymbolSource } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Functions & Helpers

/** Null rather than empty, so "the range does not address text" stays distinguishable from "". */
function sliceRange(text: string, range: Range): string | null {
	return coordinatesOf(text).sliceRange(range) ?? null;
}

////////////////////////////////
//  Class

/** Takes readFile, not node:fs: a fixture and an unsaved buffer are the same question. */
export class SourceWorkspace {
	constructor(
		private readonly store: IndexStore,
		private readonly readFile: (module: string) => string | null,
		private readonly workspaceRoot: string,
	) {}

	/**
	 * The exact source text one address occupies, plus the range a replacement would overwrite.
	 *
	 * Read once and sliced from that same read, so the hash reported is the hash of the text
	 * returned. Hashing a second read would let a file change in between and hand back a slice that
	 * never existed at the hash it claims.
	 *
	 * A stale index refuses rather than slicing: the stored range describes text that has moved, so
	 * cutting at it produces something that looks like source and is not the symbol.
	 */
	symbolSource(address: { symbolId?: string | undefined; factId?: string | undefined }): SymbolSource {
		const located = this.locate(address);
		if ("problem" in located) return { found: false, reason: located.problem };

		const { module, range, name, kind } = located;
		const text = this.readFile(module);
		if (text === null) return { found: false, reason: `${module} is not on disk any more` };

		const stored = this.store.contentHashOf(module);
		if (stored !== null && stored !== hashContent(text)) {
			return {
				found: false,
				reason: `${module} changed since it was indexed, so its ranges are stale`,
				stale: true,
			};
		}

		const sliced = sliceRange(text, range);
		if (sliced === null) return { found: false, reason: `the stored range falls outside ${module}` };

		return { found: true, module, name, kind, range, text: sliced, contentHash: hashContent(text) };
	}

	/**
	 * Modules whose text on disk is not what the index describes.
	 *
	 * Any rewrite planned from stored ranges is wrong for these: the ranges describe text that has
	 * moved. A rename against a stale module rewrites the occurrences it can still find and misses
	 * the ones that shifted, which produces a file where the import says one name and the call says
	 * another.
	 */
	staleModules(modules: Iterable<string>): string[] {
		const stale: string[] = [];
		for (const module of modules) {
			const indexed = this.store.contentHashOf(module);
			if (indexed === null) continue;
			if (this.currentHashOf(module) !== indexed) stale.push(module);
		}
		return stale;
	}

	/** The hash of a module's current text, for a writer proving nothing moved since it planned. */
	currentHashOf(module: string): string | null {
		const text = this.readFile(module);
		return text === null ? null : hashContent(text);
	}

	/**
	 * Writes one module's whole text, temp file then rename.
	 *
	 * The caller holds the workspace gate and has already journaled what was there, so this only
	 * has to make the replacement itself uninterruptible.
	 */
	writeModule(module: string, text: string): void {
		writeSourceFile(insideWorkspace(this.workspaceRoot, module), text);
	}

	/** One address, two spellings. A declaration is named by symbol id and a literal by fact id. */
	private locate(address: {
		symbolId?: string | undefined;
		factId?: string | undefined;
	}): { module: string; range: Range; name: string; kind: string } | { problem: string } {
		if (address.symbolId !== undefined) {
			const declaration = this.store.declaration(address.symbolId);
			if (!declaration) return { problem: `${address.symbolId} is not in the index` };
			return {
				module: declaration.module,
				range: declaration.range,
				name: declaration.name,
				kind: declaration.kind,
			};
		}

		if (address.factId !== undefined) {
			const fact = this.store.factById(address.factId);
			if (!fact) return { problem: `${address.factId} names nothing in the index any more` };
			if (fact.fact !== "literal") {
				return {
					problem: `${address.factId} names a ${fact.fact}, and only a literal is addressable by fact id`,
				};
			}
			return { module: fact.module, range: fact.range, name: fact.value, kind: `${fact.kind} literal` };
		}

		return { problem: "give either a symbolId or a literal's factId" };
	}
}
