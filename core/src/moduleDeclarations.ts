// One module's status, both hashes and its rows as ONE snapshot: no await and no async here, so a
// watcher batch cannot land between the read and the rows.

import type { ModuleDeclarations, ModuleStatus, StoredDeclaration } from "@nyaa-lexicon/protocol";
import { type SourceRead, type SourceReader, unreadableReason } from "./sourceRead.js";
import { hashContent } from "./watcher.js";

////////////////////////////////
//  Interfaces & Types

export type ModuleClaim = { claimed: true; provider: string } | { claimed: false; unclaimedReason: string };

/** The synchronous reads the snapshot is made of. */
export interface ModuleStoreReads {
	depthOf(module: string): ModuleStatus["depth"] | null;
	parseFailureOf(module: string): { reason: string } | null;
	contentHashOf(module: string): string | null;
	declarationsIn(module: string): StoredDeclaration[];
}

export interface ModuleDeclarationsDeps {
	claimOf(module: string): ModuleClaim;
	readSource: SourceReader;
	store: ModuleStoreReads;
}

////////////////////////////////
//  Functions & Helpers

/** What `moduleStatus` answers, from a claim and a read already made. */
export function statusOf(module: string, claim: ModuleClaim, read: SourceRead, store: ModuleStoreReads): ModuleStatus {
	const depth = store.depthOf(module);
	const failure = store.parseFailureOf(module);
	return {
		module,
		exists: read.kind !== "missing",
		claimed: claim.claimed,
		...(claim.claimed ? { provider: claim.provider } : { unclaimedReason: claim.unclaimedReason }),
		indexed: depth !== null,
		...(depth === null ? {} : { depth }),
		...(failure === null ? {} : { failure: failure.reason }),
	};
}

export function moduleDeclarations(module: string, deps: ModuleDeclarationsDeps): ModuleDeclarations {
	const read = deps.readSource(module);
	const contentHash = deps.store.contentHashOf(module);
	return {
		...statusOf(module, deps.claimOf(module), read, deps.store),
		read:
			read.kind === "binary" || read.kind === "tooLarge"
				? { kind: read.kind, detail: unreadableReason(read) }
				: { kind: read.kind },
		contentHash,
		diskHash: read.kind === "text" ? hashContent(read.text) : null,
		declarations: contentHash === null ? [] : deps.store.declarationsIn(module),
	};
}
