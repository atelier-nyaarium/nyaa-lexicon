// Tools about this MACHINE's indexes rather than about one workspace's code.
//
// Kept out of tools.ts because two of these WRITE, and a delete sitting among two dozen read-only
// lookups is one autocomplete away from being called like one.
//
// They bypass the daemon: the daemon they could ask serves THIS workspace, the question is about
// the others, and for diagnostics the daemon may be the thing that died.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	currentHost,
	DaemonError,
	findDaemon,
	lockHolderAlive,
	shutdownDaemon,
	storePaths,
} from "@nyaa-lexicon/client";
import {
	type DeleteOutcome,
	type Diagnostics,
	deleteProjectStore,
	findProjectStore,
	listProjectStores,
	listReports,
	ownSource,
	type ProjectStore,
	type ReadDiagnostics,
	type ReportSummary,
	readDiagnostics,
	type SampleContext,
} from "@nyaa-lexicon/core";
import { type DaemonLock, DaemonLockSchema } from "@nyaa-lexicon/protocol";
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
	remove: (store: ProjectStore) => DeleteOutcome;
	lock: (store: ProjectStore) => DaemonLock | null;
	/** Asks the daemon behind `lock` to stop and returns once the store's lock no longer names it. */
	stop: (store: ProjectStore, lock: DaemonLock) => Promise<void>;
	gone: (store: ProjectStore, holder: { pid: number; pidStart?: string | undefined }) => boolean;
	diagnostics: (directory: string) => ReadDiagnostics;
	reports: (directory: string) => ReportSummary[];
}

/** A bound project, as much of it as a store can be matched against. */
export interface BoundStore {
	key: string;
	stateDir?: string;
}

////////////////////////////////
//  Constants

export const LIST_STORES_DESCRIPTION = `
# \`list_project_stores\`

List local indexes with directory, size, write time, daemon state, and workspace state.

Use a row's key or directory with \`project_diagnostics\`, \`delete_project_store\` or \`stop_project_daemon\`.
`.trim();

export const PROJECT_DIAGNOSTICS_DESCRIPTION = `
# \`project_diagnostics\`

Read a store's daemon, providers, and adjacent reports from disk. Works after the daemon dies.

Pass a key or directory from \`list_project_stores\`. Shows peaks against host memory, newest incidents first with daemon activity, sampled range, report triggers and memory, and snapshot sizes.
`.trim();

export const DELETE_STORE_DESCRIPTION = `
# \`delete_project_store\`

Permanently delete an index and its recorded answers. **Irreversible.**

Confirm the store row with the user first. Refused while its daemon serves it.

Call \`stop_project_daemon\` first. Existing workspaces reindex on use.
`.trim();

export const STOP_DAEMON_DESCRIPTION = `
# \`stop_project_daemon\`

Stop the daemon serving an index. Already stopped succeeds.

Refused while the project is bound. Call \`unbind_project\` first. Use before \`delete_project_store\` for a live daemon.
`.trim();

export const ListStoresInput = {};

export const DeleteStoreInput = {
	store: z.string().min(1).describe(`Store key or directory shown by \`list_project_stores\`.`),
};

export const StopDaemonInput = DeleteStoreInput;

export const ProjectDiagnosticsInput = DeleteStoreInput;

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * BYTES_PER_MB;
/** Pruning keeps eight reports and two snapshots; anything beyond this is counted, not listed. */
const REPORTS_SHOWN = 20;
/** What `workspaceKey` mints. Anything else is a directory name, not a key. */
const STORE_KEY_RE = /^[A-Za-z0-9._-]+$/;
const STOP_TIMEOUT_MS = 5_000;

////////////////////////////////
//  Functions & Helpers

function text(body: string, isError = false): ToolResult {
	return {
		content: [{ type: "text", text: body }],
		...(isError ? { isError: true } : {}),
	};
}

function daemonLockFile(store: ProjectStore): string {
	return storePaths(store.directory).lockFile;
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
		remove: (store) => deleteProjectStore(store, lockHolderAlive),
		lock: (store) => {
			if (store.workspaceRoot === null) return legacyDaemonLock(store);
			// The listing's directory, never one re-derived from the workspace: a store renamed by
			// hand or chosen by its project is found where it is.
			const decision = findDaemon(store.workspaceRoot, ownSource(), currentHost(), store.directory);
			if (decision.action === "connect") return decision.lock;
			if (decision.action === "replace" && decision.lock.workspaceRoot === store.workspaceRoot) {
				return decision.lock;
			}
			return null;
		},
		stop: (store, lock) => shutdownDaemon(lock, daemonLockFile(store), { timeoutMs: STOP_TIMEOUT_MS }),
		gone: (store, holder) => {
			// Identity, not bare liveness: a reused pid must read as gone, not as a refusal to stop.
			if (!lockHolderAlive(holder)) return true;
			return !existsSync(daemonLockFile(store));
		},
		diagnostics: (directory) => readDiagnostics(directory),
		reports: (directory) => listReports(directory),
	};
}

/** How a store is named back to the user: a default one by key, a custom one by directory. */
function storeLabel(store: ProjectStore): string {
	return store.custom ? store.directory : store.key;
}

/** JSON-quoted, so a reference holding a newline or a backtick cannot shape the markdown around it. */
function quoted(reference: string): string {
	return JSON.stringify(reference);
}

/**
 * The store a reference names, resolved against the live listing and nothing else. A key-shaped
 * reference is matched on default stores' keys, an absolute path on every store's directory;
 * anything else is refused before the listing is read at all.
 */
function resolveStore(deps: ManageDeps, reference: string): ProjectStore | ToolResult {
	const isKey = STORE_KEY_RE.test(reference);
	if (!isKey && !path.isAbsolute(reference)) {
		return text(
			`# Store not found\n\n${quoted(reference)} is neither a store key nor a directory; call \`list_project_stores\` for the real ones.`,
			true,
		);
	}
	const store = findProjectStore(reference, deps.list());
	if (store === null) {
		const named = isKey ? `named \`${reference}\`` : `at ${quoted(reference)}`;
		return text(`# Store not found\n\nNo store ${named}; call \`list_project_stores\` for the real ones.`, true);
	}
	return store;
}

function isToolResult(value: ProjectStore | ToolResult): value is ToolResult {
	return "content" in value;
}

/** Whether a bound project answers from this store: the same key in the same directory. */
function servesBound(store: ProjectStore, bound: BoundStore[]): boolean {
	return bound.some((project) =>
		store.custom
			? project.stateDir === store.directory
			: project.key === store.key && project.stateDir === undefined,
	);
}

/** A size that cannot be is a question mark, and nothing is rounded up to a kilobyte. */
function describeSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	if (bytes < 1024) return `${Math.round(bytes)}B`;
	if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(2)}GB`;
	return bytes < BYTES_PER_MB ? `${Math.round(bytes / 1024)}KB` : `${(bytes / BYTES_PER_MB).toFixed(1)}MB`;
}

function describeElapsed(ms: number): string {
	if (ms < 0) return "in the future";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** Against the heap limit, or honest about there being nothing to compare. */
function againstHost(bytes: number, total: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "size unknown";
	return total > 0 ? `${Math.round((100 * bytes) / total)}% of host memory` : "host memory unknown";
}

function describeContext(context: SampleContext | null): string {
	if (context === null) return "before any sample";
	const { index, inFlight, connections } = context;
	const scan =
		index.state === "ready" || index.state === "unstarted"
			? index.state
			: `${index.state} ${index.done}/${index.total}`;
	return `index ${scan}, ${inFlight} in flight, ${connections} connected`;
}

function describeDeath(code: number | null, signal: string | null): string {
	return signal !== null ? `died on ${signal}` : `exited with code ${code}`;
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
			store.custom ? `## \`${store.key}\` (custom directory)` : `## \`${store.key}\``,
			"",
			`- Directory: ${store.directory}`,
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

export function renderDiagnostics(
	label: string,
	file: string,
	data: Diagnostics,
	reports: ReportSummary[],
	now: number,
): string {
	const { memTotal, memAvailable } = data.host;
	const total = memTotal ?? 0;
	const host =
		memTotal === null || memAvailable === null
			? "host memory unknown"
			: `host ${describeSize(memAvailable)} of ${describeSize(memTotal)} available`;

	const peaks = [...data.peaks]
		.sort((a, b) => b.rss - a.rss)
		.map(
			(peak) =>
				`- ${peak.role}: ${describeSize(peak.rss)} (${againstHost(peak.rss, total)}) ${describeElapsed(now - peak.at)}`,
		);

	const incidents = [...data.incidents].reverse().map((incident) => {
		const size = incident.rss === null ? "" : ` at ${describeSize(incident.rss)}`;
		return `- ${describeElapsed(now - incident.at)}: ${incident.role} pid ${incident.pid ?? "?"} ${describeDeath(incident.code, incident.signal)}${size}; ${describeContext(incident.context)}`;
	});

	const ranges = new Map<string, { min: number; max: number }>();
	for (const sample of data.samples) {
		for (const row of sample.processes) {
			if (row.rss === null) continue;
			const range = ranges.get(row.role);
			if (range === undefined) ranges.set(row.role, { min: row.rss, max: row.rss });
			else {
				range.min = Math.min(range.min, row.rss);
				range.max = Math.max(range.max, row.rss);
			}
		}
	}
	const first = data.samples[0];
	const last = data.samples.at(-1);
	const span =
		first === undefined || last === undefined || last.at - first.at < 1000
			? ""
			: ` over ${describeElapsed(last.at - first.at).replace(" ago", "")}`;
	const sampled =
		data.samples.length === 0
			? ["None yet."]
			: [
					`${data.samples.length} samples${span}, the last ${describeElapsed(now - (last?.at ?? now))}, ${describeContext(last?.context ?? null)}.`,
					...[...ranges.entries()].map(
						([role, range]) => `- ${role}: ${describeSize(range.min)} to ${describeSize(range.max)}`,
					),
				];

	const shown = reports.slice(0, REPORTS_SHOWN);
	const reportLines = shown.map((report) => {
		const name = path.basename(report.file);
		if (report.kind === "snapshot") return `- ${name}: heap snapshot, ${describeSize(report.bytes)}`;
		if (report.kind === "unreadable") return `- ${name}: unreadable (${report.reason})`;
		const memory =
			report.rss !== null && report.hostTotal !== null
				? `resident ${describeSize(report.rss)} of host ${describeSize(report.hostTotal)}`
				: report.heapUsed !== null && report.heapLimit !== null
					? `heap ${describeSize(report.heapUsed)} of ${describeSize(report.heapLimit)}`
					: "memory unknown";
		const when = report.at === null ? "" : `, ${describeElapsed(now - report.at)}`;
		return `- ${name}: ${report.event} (${report.trigger}), pid ${report.pid ?? "?"}, ${memory}${when}`;
	});
	if (reports.length > shown.length) reportLines.push(`- and ${reports.length - shown.length} older, not listed`);

	return [
		`# Diagnostics for \`${label}\``,
		"",
		`- Written: ${describeElapsed(now - data.writtenAt)}`,
		`- Daemon: pid ${data.daemon.pid}, ${data.daemon.version}, started ${describeElapsed(now - data.daemon.startedAt)}`,
		`- Workspace: ${data.workspaceRoot}`,
		`- Memory: ${host}`,
		`- Sampler: ${data.host.sampler}; runtime: ${data.host.runtime}`,
		"",
		"## Peaks",
		"",
		...(peaks.length === 0 ? ["None yet."] : peaks),
		"",
		"## Incidents",
		"",
		...(incidents.length === 0 ? ["None recorded."] : incidents),
		"",
		"## Samples",
		"",
		...sampled,
		"",
		"## Reports",
		"",
		...(reportLines.length === 0
			? ["None. Nothing has died of its memory or crossed the high-water mark."]
			: reportLines),
		...(reports.some((report) => report.kind === "snapshot")
			? []
			: [
					"",
					"A report says where a heap went, not what held it. That needs a heap snapshot, which is opt-in: `LEXICON_HEAP_SNAPSHOT=1` on the daemon, gigabytes each.",
				]),
		"",
		`Raw: ${file}`,
	].join("\n");
}

////////////////////////////////
//  Tools

export function listProjectStoresTool(deps: ManageDeps, now = Date.now()): ToolResult {
	return text(renderStores(deps.list(), now));
}

export function projectDiagnosticsTool(deps: ManageDeps, args: { store: string }, now = Date.now()): ToolResult {
	const store = resolveStore(deps, args.store);
	if (isToolResult(store)) return store;
	const label = storeLabel(store);

	const read = deps.diagnostics(store.directory);
	if (read.state === "absent") {
		return text(
			`# No diagnostics yet\n\nNothing at \`${read.file}\`. A daemon writes it on its first sample, and none has written one for \`${label}\` yet.`,
		);
	}
	if (read.state === "unreadable") {
		return text(`# Diagnostics unreadable\n\n\`${read.file}\`: ${read.reason}`, true);
	}
	return text(renderDiagnostics(label, read.file, read.data, deps.reports(store.directory), now));
}

export function deleteProjectStoreTool(deps: ManageDeps, args: { store: string }): ToolResult {
	const store = resolveStore(deps, args.store);
	if (isToolResult(store)) return store;

	const outcome = deps.remove(store);
	if (!outcome.deleted) return text(outcome.reason, true);
	const label = store.custom ? outcome.directory : outcome.key;
	return text(
		`# Project index deleted\n\nDeleted \`${label}\`, freeing ${describeSize(outcome.bytes)}. It rebuilds on next use if its workspace still exists.`,
	);
}

export async function stopProjectDaemonTool(
	deps: ManageDeps,
	bound: () => BoundStore[],
	args: { store: string },
): Promise<ToolResult> {
	const store = resolveStore(deps, args.store);
	if (isToolResult(store)) return store;
	const label = storeLabel(store);

	if (servesBound(store, bound())) {
		return text(
			`# Daemon not stopped\n\nRefusing to stop \`${label}\`: it is bound in this session. Call \`unbind_project\` first.`,
			true,
		);
	}

	if (store.livePid === null) {
		return text(`# Daemon already stopped\n\nNo daemon is serving \`${label}\`.`);
	}

	const pid = store.livePid;
	const lock = deps.lock(store);
	if (lock === null) {
		if (deps.gone(store, { pid })) {
			return text(`# Daemon already stopped\n\nNo daemon is serving \`${label}\`.`);
		}
		return text(
			`# Daemon not stopped\n\nCould not find a usable daemon lock for \`${label}\`; it is still serving pid ${pid}.`,
			true,
		);
	}

	try {
		await deps.stop(store, lock);
	} catch (error) {
		if (!(error instanceof DaemonError)) throw error;
		return text(`# Daemon not stopped\n\n${error.message}`, true);
	}

	return text(`# Daemon stopped\n\nStopped daemon pid ${pid} serving \`${label}\`.`);
}
