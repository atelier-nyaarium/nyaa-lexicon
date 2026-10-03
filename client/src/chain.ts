// A name chain inside one module, answered from ONE daemon snapshot: the protocol's walk over the
// module's declarations, or the reason there was nothing to walk, with the hash the index holds and
// the hash on disk on every answer.

import { type ChainCandidate, type ChainFrontier, chainAvailable, defined, walkChain } from "@nyaa-lexicon/protocol";
import type { Session } from "./connect.js";

export type { ChainCandidate, ChainFrontier };

////////////////////////////////
//  Interfaces & Types

/** The hash the index holds and the hash of the file as read; either null when there is none. */
export interface ChainHashes {
	contentHash: string | null;
	diskHash: string | null;
}

export type ChainNoneReason = "missing" | "binary" | "tooLarge" | "unclaimed" | "parseFailed" | "unread" | "noMatch";

export type ChainAnswer =
	| ({ kind: "exact"; candidate: ChainCandidate } & ChainHashes)
	| ({ kind: "ambiguous"; candidates: ChainCandidate[] } & ChainHashes)
	| ({
			kind: "none";
			reason: ChainNoneReason;
			detail?: string;
			matched: ChainFrontier;
			/** Declaration names beneath the frontier, deduped, document order, capped. */
			available: string[];
			availableTotal: number;
	  } & ChainHashes);

////////////////////////////////
//  Functions & Helpers

/** Resolve `segments` inside `module`; `walkChain` owns the grammar. */
export async function resolveChain(
	session: Pick<Session, "ask">,
	module: string,
	segments: string[],
): Promise<ChainAnswer> {
	const held = await session.ask("moduleDeclarations", { module });
	const hashes: ChainHashes = { contentHash: held.contentHash, diskHash: held.diskHash };
	const nothing = (reason: ChainNoneReason, detail?: string): ChainAnswer => ({
		kind: "none",
		reason,
		...defined({ detail }),
		matched: { containerPaths: [], consumed: 0, count: 0 },
		...chainAvailable(held.declarations),
		...hashes,
	});

	// First: a module no provider reads, a scope-denied one included, answers alike whether or not it exists.
	if (!held.claimed) return nothing("unclaimed", held.unclaimedReason);
	if (held.read.kind === "missing") return nothing("missing");
	if (held.read.kind === "binary" || held.read.kind === "tooLarge") return nothing(held.read.kind, held.read.detail);
	if (held.failure !== undefined && held.declarations.length === 0) return nothing("parseFailed", held.failure);
	if (!held.indexed) return nothing("unread");

	const walked = walkChain(held.declarations, segments);
	return walked.kind === "none" ? { ...walked, reason: "noMatch", ...hashes } : { ...walked, ...hashes };
}
