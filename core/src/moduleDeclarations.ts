// One module's status, both hashes and its rows as ONE snapshot: no await and no async here, so a
// watcher batch cannot land between the read and the rows.

import {
	defined,
	type ModuleDeclarations,
	type ModuleStatus,
	type SourceReadOutcome,
	type StoredDeclaration,
} from "@nyaa-lexicon/protocol";
import {
	DENIED_BY_SCOPE_REASON,
	OUTSIDE_WORKSPACE_REASON,
	type SealedRead,
	type SealedText,
	type SourceReader,
	unreadableReason,
} from "./sourceRead.js";

////////////////////////////////
//  Interfaces & Types

/** Claimed by the provider or index secret reader. */
export type ModuleClaim = { claimed: true; provider?: string } | { claimed: false; unclaimedReason: string };

/** The synchronous reads the snapshot is made of. */
export interface ModuleStoreReads {
	depthOf(module: string): ModuleStatus["depth"] | null;
	parseFailureOf(module: string): { reason: string } | null;
	contentHashOf(module: string): string | null;
	declarationsIn(module: string): StoredDeclaration[];
}

export interface ModuleDeclarationsDeps {
	claimOf(module: string): ModuleClaim;
	denies(module: string): boolean;
	readSource: SourceReader;
	/** Hash of policy-visible text. */
	hashOfRead(read: SealedText): string;
	store: ModuleStoreReads;
}

////////////////////////////////
//  Functions & Helpers

/** What `moduleStatus` answers, from a claim and a read already made; null for a module scope denies, never read. */
export function statusOf(
	module: string,
	claim: ModuleClaim,
	read: SealedRead | null,
	store: ModuleStoreReads,
): ModuleStatus {
	const depth = store.depthOf(module);
	const failure = store.parseFailureOf(module);
	// An outside read outranks a claim.
	const judged: ModuleClaim =
		read?.kind === "outside" ? { claimed: false, unclaimedReason: OUTSIDE_WORKSPACE_REASON } : claim;
	return {
		module,
		exists: read !== null && read.kind !== "missing" && read.kind !== "outside",
		claimed: judged.claimed,
		...(judged.claimed ? defined({ provider: judged.provider }) : { unclaimedReason: judged.unclaimedReason }),
		indexed: depth !== null,
		...(depth === null ? {} : { depth }),
		...(failure === null ? {} : { failure: failure.reason }),
	};
}

/** An older client's closed enum has no `outside`, so it reads as missing. */
function readOutcome(read: SealedRead | null): SourceReadOutcome {
	if (read === null) return { kind: "missing", detail: DENIED_BY_SCOPE_REASON };
	switch (read.kind) {
		case "binary":
		case "tooLarge":
			return { kind: read.kind, detail: unreadableReason(read) };
		case "outside":
			return { kind: "missing", detail: OUTSIDE_WORKSPACE_REASON };
		default:
			return { kind: read.kind };
	}
}

export function moduleDeclarations(module: string, deps: ModuleDeclarationsDeps): ModuleDeclarations {
	// Neither the presence nor the bytes of a denied file leave the daemon.
	const read = deps.denies(module) ? null : deps.readSource(module);
	const contentHash = deps.store.contentHashOf(module);
	return {
		...statusOf(module, deps.claimOf(module), read, deps.store),
		read: readOutcome(read),
		contentHash,
		diskHash: read?.kind === "text" ? deps.hashOfRead(read) : null,
		declarations: contentHash === null ? [] : deps.store.declarationsIn(module),
	};
}
