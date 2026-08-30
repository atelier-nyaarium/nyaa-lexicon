// Where a vanished declaration may have gone, by name and kind, for a person to read. Nothing is
// ever bound by a candidate; binding is the identity owner's evidence.

import { parseSymbolId, sameNameAndKind } from "@nyaa-lexicon/protocol";
import type { IndexStore } from "./store.js";

////////////////////////////////
//  Constants

/** Past this many, a list of twins says nothing a reader can act on. */
const CANDIDATES_CAP = 64;

////////////////////////////////
//  Functions & Helpers

/** Declarations in other modules carrying the address's name and kind, in module order; none for a local. */
export function candidatesFor(store: IndexStore, symbolId: string): string[] {
	const name = parseSymbolId(symbolId)?.descriptors.at(-1)?.name;
	if (name === undefined) return [];
	return store
		.declarationsNamed(name)
		.map((declaration) => declaration.symbolId)
		.filter((other) => sameNameAndKind(symbolId, other))
		.slice(0, CANDIDATES_CAP);
}
