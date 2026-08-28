// Bring one module into the index from the wire, and read the daemon's outcome as one answer.
//
// The outcome's closed `cause` is the value read; its prose is the detail. A content refusal is an
// answer a consumer can act on; only the daemon's own trouble, or an outcome without a cause, is a
// `DaemonError`.

import type { Session } from "./connect.js";
import { DaemonError } from "./errors.js";

////////////////////////////////
//  Interfaces & Types

/** Why the module is not indexed, sharing `resolveChain`'s reasons. */
export type IndexedRefusal = "missing" | "binary" | "tooLarge" | "unclaimed" | "parseFailed";

export type IndexedAnswer = { indexed: true } | { indexed: false; reason: IndexedRefusal; detail?: string };

////////////////////////////////
//  Functions & Helpers

/** Index `module` now, under the daemon's write gate. */
export async function awaitIndexed(session: Pick<Session, "ask">, module: string): Promise<IndexedAnswer> {
	const outcome = await session.ask("indexFile", { module });
	if (outcome.action === "indexed") return { indexed: true };
	const detail = outcome.failure ?? outcome.reason;
	switch (outcome.cause) {
		case "current":
			return { indexed: true };
		case "missing":
		case "binary":
		case "tooLarge":
		case "unclaimed":
		case "parseFailed":
			return { indexed: false, reason: outcome.cause, ...(detail === undefined ? {} : { detail }) };
		case "providerDown":
		case "fault":
			throw new DaemonError(`${module} was not indexed: ${detail ?? "a provider is unavailable"}`, "daemon");
		case undefined:
			throw new DaemonError(`${module} was not indexed: ${detail ?? "no reason given"}`, "daemon");
	}
}
