// Tools about this MACHINE's indexes rather than about one workspace's code.
//
// Kept out of tools.ts because these are the only tools here that WRITE, and a delete sitting
// among two dozen read-only lookups is one autocomplete away from being called like one.
//
// They bypass the daemon: the daemon they could ask serves THIS workspace, and the question is
// about the others.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	callDaemon,
	currentHost,
	type DaemonLock,
	DaemonLockSchema,
	deleteProjectStore,
	findDaemon,
	listProjectStores,
	lockHolderAlive,
	type ProjectStore,
	stateRoot,
	workspacePaths,
} from "@nyaa-lexicon/core";
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
	lock: (store: ProjectStore) => DaemonLock | null;
	shutdown: (lock: DaemonLock) => Promise<unknown>;
	gone: (store: ProjectStore, holder: { pid: number; pidStart?: string | undefined }) => boolean;
	wait: (ms: number) => Promise<void>;
	now: () => number;
}

////////////////////////////////
//  Constants

export const LIST_STORES_DESCRIPTION = `
# \`list_project_stores\`

List local indexes with size, write time, daemon state, and workspace state.

Use each row's key with \`delete_project_store\` or \`stop_project_daemon\`.
`.trim();

export const DELETE_STORE_DESCRIPTION = `
# \`delete_project_store\`

Permanently delete an index and its recorded answers. **Irreversible.**

Confirm the store row with the user first. Refused while its daemon is serving it.

Call \`stop_project_daemon\` first. Existing workspaces reindex on use.
`.trim();

export const STOP_DAEMON_DESCRIPTION = `
# \`stop_project_daemon\`

Stop the daemon serving an index. Already stopped is success.

Refused while the project is bound. Call \`unbind_project\` first. Use before \`delete_project_store\` for a live daemon.
`.trim();

export const ListStoresInput = {};

export const DeleteStoreInput = {
	key: z.string().min(1).describe(`Store key shown by \`list_project_stores\`.`),
};

export const StopDaemonInput = DeleteStoreInput;

const BYTES_PER_MB = 1024 * 1024;
const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_MS = 100;

////////////////////////////////
//  Functions & Helpers

function text(body: string, isError = false): ToolResult {
	return {
		content: [{ type: "text", text: body }],
		...(isError ? { isError: true } : {}),
	};
}

function daemonLockFile(store: ProjectStore): string {
	const host = currentHost();
	return store.workspaceRoot === null
		? path.join(stateRoot(host), store.key, "daemon.json")
		: workspacePaths(host, store.workspaceRoot).lockFile;
}

function legacyDaemonLock(store: ProjectStore): DaemonLock | null {
	let raw: string;
	try {
		raw = readFileSync(daemonLockFile(store), "utf8");
	} catch {
		return null;
	}

	try {
		const parsed = DaemonLockSchema.safeParse(JSON.parse(raw));
		return parsed.success && lockHolderAlive(parsed.data) ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Live deps, for production call sites. */
export function liveDeps(): ManageDeps {
	return {
		list: () => listProjectStores(lockHolderAlive),
		remove: (key) => deleteProjectStore(key, lockHolderAlive),
		lock: (store) => {
			if (store.workspaceRoot === null) return legacyDaemonLock(store);
			const decision = findDaemon(store.workspaceRoot);
			if (decision.action === "connect") return decision.lock;
			if (decision.action === "replace" && decision.lock.workspaceRoot === store.workspaceRoot) {
				return decision.lock;
			}
			return null;
		},
		shutdown: (lock) => callDaemon(lock, "shutdown", {}),
		gone: (store, holder) => {
			// Identity, not bare liveness: a reused pid must read as gone, not as a refusal to stop.
			if (!lockHolderAlive(holder)) return true;
			return !existsSync(daemonLockFile(store));
		},
		wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		now: () => Date.now(),
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

/** An index that never recorded its workspace reads as UNVERIFIED, never orphaned: folding the two
 * once offered nine live projects for deletion. */
export function renderStores(stores: ProjectStore[], now: number): string {
	if (stores.length === 0) return "# Project indexes\n\nThis machine holds no indexes.";

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
		return [
			`## \`${store.key}\``,
			"",
			`- Workspace: ${where}`,
			`- Size: ${describeSize(store.bytes)}`,
			`- Written: ${describeAge(store.modifiedAt, now)}`,
			`- State: ${state}`,
		].join("\n");
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

	return [
		`# ${stores.length} indexed ${stores.length === 1 ? "project" : "projects"}`,
		"",
		lines.join("\n\n"),
		"",
		"## Notes",
		"",
		notes.map((note) => `- ${note}`).join("\n"),
	].join("\n");
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
		`# Project index deleted\n\nDeleted \`${outcome.key}\`, freeing ${describeSize(outcome.bytes)}. It rebuilds on next use if its workspace still exists.`,
	);
}

function shutdownWasAccepted(reply: unknown): boolean {
	return typeof reply === "object" && reply !== null && "stopping" in reply && reply.stopping === true;
}

export async function stopProjectDaemonTool(
	deps: ManageDeps,
	bound: () => Array<{ key: string }>,
	args: { key: string },
): Promise<ToolResult> {
	const store = deps.list().find((candidate) => candidate.key === args.key);
	if (store === undefined) {
		return text(
			`# Store not found\n\nNo store named \`${args.key}\`; call \`list_project_stores\` to get a real store key.`,
			true,
		);
	}

	if (bound().some((project) => project.key === args.key)) {
		return text(
			`# Daemon not stopped\n\nRefusing to stop \`${args.key}\`: it is bound in this session. Call \`unbind_project\` first.`,
			true,
		);
	}

	if (store.livePid === null) {
		return text(`# Daemon already stopped\n\nNo daemon is serving \`${args.key}\`.`);
	}

	const pid = store.livePid;
	const lock = deps.lock(store);
	if (lock === null) {
		if (deps.gone(store, { pid })) {
			return text(`# Daemon already stopped\n\nNo daemon is serving \`${args.key}\`.`);
		}
		return text(
			`# Daemon not stopped\n\nCould not find a usable daemon lock for \`${args.key}\`; it is still serving pid ${pid}.`,
			true,
		);
	}

	let reply: unknown;
	try {
		reply = await deps.shutdown(lock);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return text(
			`# Daemon not stopped\n\nCould not ask pid ${pid} to stop serving \`${args.key}\`: ${reason}`,
			true,
		);
	}
	if (!shutdownWasAccepted(reply)) {
		return text(
			`# Daemon not stopped\n\nDaemon pid ${pid} did not acknowledge the shutdown request for \`${args.key}\`.`,
			true,
		);
	}

	const started = deps.now();
	while (!deps.gone(store, lock)) {
		if (deps.now() - started >= STOP_TIMEOUT_MS) {
			return text(
				`# Daemon not stopped\n\nDaemon pid ${pid} did not stop serving \`${args.key}\` within ${STOP_TIMEOUT_MS}ms.`,
				true,
			);
		}
		await deps.wait(STOP_POLL_MS);
	}

	return text(`# Daemon stopped\n\nStopped daemon pid ${pid} serving \`${args.key}\`.`);
}
