// The workspace as text on disk, and how a symbol maps onto it.
//
// Kept apart from the index because a stale answer IS the two disagreeing. Decides what to write;
// sourceWriter.ts decides how.

import { coordinatesOf, hashContent, type Range, type ValueStatus } from "@nyaa-lexicon/protocol";
import type { PlannedSource, PlannedSourceRead } from "./refusalSlots.js";
import type { Refusal } from "./refusals.js";
import * as refusal from "./refusals.js";
import {
	hashOfView,
	insideWorkspace,
	type MaskedView,
	type ViewReader,
	type WritableSource,
	writableSource,
	writableText,
} from "./sourceRead.js";
import { writeSourceFile } from "./sourceWriter.js";
import type { IndexStore } from "./store.js";

export type { SymbolSource } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** Readable module text, its hash, and mask status. */
type ModuleText = { text: string; hash: string; masked?: MaskedView } | { refused: Refusal };

type Address = { symbolId?: string | undefined; factId?: string | undefined };

////////////////////////////////
//  Functions & Helpers

/** Null rather than empty, so "the range does not address text" stays distinguishable from "". */
function sliceRange(text: string, range: Range): string | null {
	return coordinatesOf(text).sliceRange(range) ?? null;
}

////////////////////////////////
//  Class

/** Reads through policy views. */
export class SourceWorkspace {
	constructor(
		private readonly store: IndexStore,
		private readonly readView: ViewReader,
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
	symbolSource(address: Address): PlannedSource {
		const read = this.sliced(
			address,
			(module) => {
				const view = this.readView(module);
				switch (view.kind) {
					case "plain":
						return { text: view.text, hash: view.hash };
					case "masked":
						return { text: view.text, hash: view.hash, masked: view };
					case "refused":
						return { refused: refusal.secretFile(module) };
					case "outside":
						return { refused: refusal.moduleOutsideWorkspace(module) };
					default:
						return { refused: refusal.moduleNotOnDisk(module) };
				}
			},
			true,
		);
		if (!read.found) return read;
		const { fileText: _fileText, ...source } = read;
		return source;
	}

	/** `symbolSource` through the writer's read, with the file text it sliced. */
	symbolSourceRead(address: Address): PlannedSourceRead {
		return this.sliced(address, (module) => {
			const view = this.readView(module);
			const writable = writableSource(module, view);
			if ("refused" in writable) return writable;
			return view.kind === "plain"
				? { text: view.text, hash: view.hash }
				: { refused: refusal.moduleNotOnDisk(module) };
		});
	}

	/** One module through `writableSource`. */
	writable(module: string): WritableSource {
		return writableSource(module, this.readView(module));
	}

	private sliced(address: Address, read: (module: string) => ModuleText, allowKey = false): PlannedSourceRead {
		const located = this.locate(address);
		if ("problem" in located) return { found: false, reason: located.problem };

		const { module, range, name, kind, valueStatus } = located;
		const current = read(module);
		if ("refused" in current) return { found: false, reason: current.refused };
		const { text, hash, masked } = current;
		const selection = located.selectionRange ?? range;
		const valueKey = allowKey && valueStatus !== undefined && address.factId === undefined;
		if (
			masked !== undefined &&
			(masked.omits(selection) ||
				(address.factId !== undefined && masked.touches(range)) ||
				(masked.hidden && valueStatus !== undefined && !valueKey))
		)
			return { found: false, reason: refusal.secretFile(module) };

		const stored = this.store.contentHashOf(module);
		if (stored !== null && stored !== hash) {
			return { found: false, reason: refusal.moduleStale(module), stale: true };
		}

		const selected = valueKey ? selection : range;
		const sliced = valueKey || masked === undefined ? sliceRange(text, selected) : masked.slice(selected);
		if (sliced === null) return { found: false, reason: refusal.rangeOutsideModule(module) };

		return {
			found: true,
			module,
			name,
			kind,
			range: selected,
			...(valueKey && valueStatus !== undefined ? { valueStatus } : {}),
			text: sliced,
			contentHash: hash,
			spanHash: hashContent(sliced),
			fileText: text,
		};
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
		return hashOfView(this.readView(module));
	}

	/** Plain text on disk, or null when unreadable. */
	currentText(module: string): string | null {
		const view = this.readView(module);
		return view.kind === "plain" ? view.text : null;
	}

	/**
	 * Writes via temp file and rename when disk matches `base`.
	 *
	 * The caller holds the workspace gate and has already journaled what was there. Checks the disk
	 * through `writableSource` and the text through `writableText`, so no plan bypasses either.
	 * Returns false when disk no longer matches `base`.
	 */
	writeModule(module: string, text: string, base: string | null): boolean {
		const current = this.writable(module);
		if ("refused" in current) throw new Error(current.refused);
		const unwritable = writableText(module, text);
		if (unwritable !== null) throw new Error(unwritable);
		if ((current.text === null ? null : hashContent(current.text)) !== base) return false;
		writeSourceFile(insideWorkspace(this.workspaceRoot, module), text);
		return true;
	}

	/** One address, two spellings. A declaration is named by symbol id and a literal by fact id. */
	private locate(address: Address):
		| {
				module: string;
				range: Range;
				selectionRange?: Range;
				valueStatus?: ValueStatus;
				name: string;
				kind: string;
		  }
		| { problem: Refusal } {
		if (address.symbolId !== undefined) {
			const declaration = this.store.declaration(address.symbolId);
			if (!declaration) return { problem: refusal.subjectRefused(address.symbolId, this.store) };
			return {
				module: declaration.module,
				range: declaration.range,
				...(declaration.selectionRange === undefined ? {} : { selectionRange: declaration.selectionRange }),
				name: declaration.name,
				kind: declaration.kind,
				...(declaration.valueStatus === undefined ? {} : { valueStatus: declaration.valueStatus }),
			};
		}

		if (address.factId !== undefined) {
			const fact = this.store.factById(address.factId);
			if (!fact) return { problem: refusal.factNamesNothing(address.factId) };
			if (fact.fact !== "literal") {
				return { problem: refusal.factNotAddressable(address.factId, fact.fact) };
			}
			return { module: fact.module, range: fact.range, name: fact.value, kind: `${fact.kind} literal` };
		}

		return { problem: refusal.noAddressGiven() };
	}
}
