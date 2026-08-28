// Bring one module into the index from the wire, and read the daemon's outcome as one answer.
//
// The strings matched are the indexer's own. An outcome this file does not know is a
// `DaemonError` carrying it, never a guess at one of the closed reasons.

import type { Session } from "./connect.js";
import { DaemonError } from "./errors.js";

////////////////////////////////
//  Interfaces & Types

export type IndexedAnswer = { indexed: true } | { indexed: false; reason: "unclaimed" | "missing" };

////////////////////////////////
//  Constants

/** A skip that means the index already holds this version. */
const CURRENT = "already indexed at this depth";

/** Skips that mean nothing will ever index it. */
const UNCLAIMED = new Set(["unclaimed", "denied by scope"]);
const CONTESTED = "claimed by ";

////////////////////////////////
//  Functions & Helpers

/** Index `module` now, under the daemon's write gate. A parse failure throws `DaemonError` with the provider's reason. */
export async function awaitIndexed(session: Pick<Session, "ask">, module: string): Promise<IndexedAnswer> {
	const outcome = await session.ask("indexFile", { module });
	if (outcome.failure !== undefined) throw new DaemonError(outcome.failure);
	if (outcome.action === "indexed") return { indexed: true };
	if (outcome.action === "forgotten") return { indexed: false, reason: "missing" };

	const reason = outcome.reason ?? "";
	if (reason === CURRENT) return { indexed: true };
	if (UNCLAIMED.has(reason) || reason.startsWith(CONTESTED)) return { indexed: false, reason: "unclaimed" };
	throw new DaemonError(`${module} was not indexed: ${reason === "" ? "no reason given" : reason}`);
}
