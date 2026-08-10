// Tools about this MACHINE's indexes rather than about one workspace's code.
//
// Kept out of tools.ts because these are the only tools here that WRITE, and a delete sitting
// among two dozen read-only lookups is one autocomplete away from being called like one.
//
// They bypass the daemon: the daemon they could ask serves THIS workspace, and the question is
// about the others.

import { deleteProjectStore, listProjectStores, type ProjectStore, processIsAlive } from "@nyaa-lexicon/core";
import { z } from "zod";

////////////////////////////////
//  Interfaces & Types

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

/** Injected so a test drives real directories without real daemons. */
export interface ManageDeps {
	list: () => ProjectStore[];
	remove: (key: string) => ReturnType<typeof deleteProjectStore>;
}

////////////////////////////////
//  Constants

export const LIST_STORES_DESCRIPTION = `
Every code index this machine holds, across all projects, with its size, when it was last written,
whether a daemon is serving it now, and whether the project it indexed still exists on disk.

Use it to find indexes worth reclaiming: a store whose workspace is GONE can never be useful again,
since nothing will re-index a directory that is not there. Sizes are real; a large repository's
index runs to hundreds of megabytes.

The key each row reports is what delete_project_store requires.
`.trim();

export const DELETE_STORE_DESCRIPTION = `
Permanently delete one project's index, by the key list_project_stores reports.

IRREVERSIBLE, and it takes the recorded ANSWERS with it, which are the one thing here that no
re-index can regenerate. Show the user the row you are about to delete and get their agreement
before calling this.

Refused while a daemon is serving that store; stop it first. A store for a workspace still on disk
is rebuilt on next use, so deleting it costs a re-scan rather than the project.
`.trim();

export const ListStoresInput = {};

export const DeleteStoreInput = {
	key: z.string().min(1).describe("The store key, exactly as list_project_stores reports it"),
};

const BYTES_PER_MB = 1024 * 1024;

////////////////////////////////
//  Functions & Helpers

function text(body: string, isError = false): ToolResult {
	return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

/** Live deps, for production call sites. */
export function liveDeps(): ManageDeps {
	return {
		list: () => listProjectStores(processIsAlive),
		remove: (key) => deleteProjectStore(key, processIsAlive),
	};
}

function describeSize(bytes: number): string {
	return bytes < BYTES_PER_MB
		? `${Math.max(1, Math.round(bytes / 1024))}KB`
		: `${(bytes / BYTES_PER_MB).toFixed(1)}MB`;
}

function describeAge(modifiedAt: number | null, now: number): string {
	if (modifiedAt === null) return "never written";
	const days = Math.floor((now - modifiedAt) / 86_400_000);
	if (days < 1) return "today";
	if (days === 1) return "yesterday";
	return `${days} days ago`;
}

/**
 * One row per store, with the reclaimable ones called out rather than left to be spotted.
 *
 * An index that never recorded its workspace reads as UNVERIFIED, never orphaned: a probe on real
 * state found nine live projects offered for deletion because a boolean had folded the two.
 */
export function renderStores(stores: ProjectStore[], now: number): string {
	if (stores.length === 0) return "This machine holds no indexes.";

	const lines = stores.map((store) => {
		const where = store.workspaceRoot ?? "(this index predates recording its workspace)";
		const state =
			store.livePid !== null
				? `in use by pid ${store.livePid}`
				: store.workspace === "present"
					? "idle"
					: store.workspace === "missing"
						? "ORPHANED, its workspace is gone"
						: "UNVERIFIED, it does not say what it indexed";
		return `${store.key}\n  ${where}\n  ${describeSize(store.bytes)}, written ${describeAge(store.modifiedAt, now)}, ${state}`;
	});

	const orphaned = stores.filter((store) => store.workspace === "missing");
	const unverified = stores.filter((store) => store.workspace === "unknown");
	const reclaimable = orphaned.reduce((total, store) => total + store.bytes, 0);

	const notes: string[] = [];
	if (orphaned.length === 0 && unverified.length === 0) {
		notes.push("Every index here belongs to a project still on disk.");
	}
	if (orphaned.length > 0) {
		notes.push(
			`${orphaned.length} index a workspace that no longer exists, holding ${describeSize(reclaimable)}. Nothing can rebuild those, though deleting one still destroys any recorded answers about that project.`,
		);
	}
	if (unverified.length > 0) {
		notes.push(
			`${unverified.length} were written before the workspace path was recorded, so whether their project still exists is unknown rather than no. Each is re-stamped the next time its daemon runs; do not treat one as abandoned on the strength of this listing.`,
		);
	}

	return `${stores.length} indexed ${stores.length === 1 ? "project" : "projects"}:\n\n${lines.join("\n\n")}\n\n${notes.join(" ")}`;
}

////////////////////////////////
//  Tools

export function listProjectStoresTool(deps: ManageDeps, now = Date.now()): ToolResult {
	return text(renderStores(deps.list(), now));
}

export function deleteProjectStoreTool(deps: ManageDeps, args: { key: string }): ToolResult {
	const outcome = deps.remove(args.key);
	if (!outcome.deleted) return text(outcome.reason, true);
	return text(
		`Deleted ${outcome.key}, freeing ${describeSize(outcome.bytes)}. It rebuilds on next use if its workspace still exists.`,
	);
}
