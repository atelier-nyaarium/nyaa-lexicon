// What a file change means for the index.
//
// Pure, so the surgical-invalidation rule is testable without a filesystem. The watcher supplies
// events; this decides what the store should be told.

import type { Route } from "./routing.js";

////////////////////////////////
//  Interfaces & Types

export type FileEvent = { kind: "changed"; module: string; contentHash: string } | { kind: "deleted"; module: string };

/** What the store is told. Nothing else is a valid outcome, so a caller cannot invent one. */
export type Invalidation =
	| { action: "reindex"; module: string; contentHash: string; providerId: string }
	| { action: "forget"; module: string }
	| { action: "ignore"; module: string; reason: string };

export interface InvalidationContext {
	route: (module: string) => Route;
	/** The hash the index already holds for this module, or null when it holds none. */
	indexedHash: (module: string) => string | null;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Decide what one file event costs.
 *
 * A delete is always a forget, even for an unclaimed file: the index may hold rows from when a
 * provider did claim it, and leaving them would keep a deleted file answering queries forever.
 *
 * A change whose hash matches what the index holds is ignored. Editors write on save whether or
 * not anything changed, and a formatter run touches every file in the repo, so without this a
 * no-op save re-indexes the world.
 */
export function decideInvalidation(event: FileEvent, context: InvalidationContext): Invalidation {
	if (event.kind === "deleted") return { action: "forget", module: event.module };

	if (context.indexedHash(event.module) === event.contentHash) {
		return { action: "ignore", module: event.module, reason: "content is unchanged" };
	}

	const route = context.route(event.module);
	if (!route.owned) {
		const reason = route.reason === "contested" ? `claimed by ${route.providerIds.join(", ")}` : "unclaimed";
		return { action: "ignore", module: event.module, reason };
	}

	return {
		action: "reindex",
		module: event.module,
		contentHash: event.contentHash,
		providerId: route.providerId,
	};
}

/**
 * Collapse a burst of events per module, keeping the last.
 *
 * A save often arrives as several events, and a branch switch arrives as hundreds. Order is
 * preserved by first appearance so a rename's delete still precedes its create.
 */
export function coalesce(events: FileEvent[]): FileEvent[] {
	const latest = new Map<string, FileEvent>();
	for (const event of events) latest.set(event.module, event);
	return [...latest.values()];
}
