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
	callDaemon,
	currentHost,
	type DaemonLock,
	DaemonLockSchema,
	type Diagnostics,
	deleteProjectStore,
	findDaemon,
	listProjectStores,
	listReports,
	lockHolderAlive,
	type ProjectStore,
	type ReadDiagnostics,
	type ReportSummary,
	readDiagnostics,
	type SampleContext,
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
	diagnostics: (key: string) => ReadDiagnostics;
	reports: (key: string) => ReportSummary[];
}

////////////////////////////////
//  Constants

export const LIST_STORES_DESCRIPTION = `
# \`list_project_stores\`

List local indexes with size, write time, daemon state, and workspace state.

Use each row's key with \`project_diagnostics\`, \`delete_project_store\` or \`stop_project_daemon\`.
`.trim();

export const PROJECT_DIAGNOSTICS_DESCRIPTION = `
# \`project_diagnostics\`

Memory record of a store's daemon and providers, and node's crash reports beside it. Read from disk, so it answers for a daemon that has died.

Pass a key from \`list_project_stores\`. Answers peaks against the heap limit, incidents newest first with what the daemon was doing, the sampled range, each node report's trigger and heap, and each snapshot's size.
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

export const ProjectDiagnosticsInput = DeleteStoreInput;

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * BYTES_PER_MB;
/** Pruning keeps eight reports and two snapshots; anything beyond this is counted, not listed. */
const REPORTS_SHOWN = 20;
/** What `workspaceKey` mints. Anything else is a directory name, not a key. */
const STORE_KEY_RE = /^[A-Za-z0-9._-]+$/;
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
		diagnostics: (key) => readDiagnostics(key),
		reports: (key) => listReports(key),
	};
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
function againstLimit(bytes: number, limit: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "size unknown";
	return limit > 0 ? `${Math.round((100 * bytes) / limit)}% of the limit` : "limit unknown";
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

export function renderDiagnostics(
	key: string,
	file: string,
	data: Diagnostics,
	reports: ReportSummary[],
	now: number,
): string {
	const limit = data.host.nodeHeapLimit;
	const { memTotal, memAvailable } = data.host;
	const host =
		memTotal === null || memAvailable === null
			? "host memory unknown"
			: `host ${describeSize(memAvailable)} of ${describeSize(memTotal)} available`;

	const peaks = [...data.peaks]
		.sort((a, b) => b.rss - a.rss)
		.map(
			(peak) =>
				`- ${peak.role}: ${describeSize(peak.rss)} (${againstLimit(peak.rss, limit)}) ${describeElapsed(now - peak.at)}`,
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
		const heap =
			report.heapUsed === null || report.heapLimit === null
				? "heap unknown"
				: `heap ${describeSize(report.heapUsed)} of ${describeSize(report.heapLimit)}`;
		const when = report.at === null ? "" : `, ${describeElapsed(now - report.at)}`;
		return `- ${name}: ${report.event} (${report.trigger}), pid ${report.pid ?? "?"}, ${heap}${when}`;
	});
	if (reports.length > shown.length) reportLines.push(`- and ${reports.length - shown.length} older, not listed`);

	return [
		`# Diagnostics for \`${key}\``,
		"",
		`- Written: ${describeElapsed(now - data.writtenAt)}`,
		`- Daemon: pid ${data.daemon.pid}, ${data.daemon.version}, started ${describeElapsed(now - data.daemon.startedAt)}`,
		`- Workspace: ${data.workspaceRoot}`,
		`- Heap limit: ${limit > 0 ? `${describeSize(limit)} per process` : "unknown"}; ${host}`,
		`- Sampler: ${data.host.sampler}; signal: ${data.host.signal}; reports exclude the environment: ${data.host.reportsExcludeEnv ? "yes" : "no"}`,
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
			? ["None. Nothing has died of its heap or been asked for a report."]
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

export function projectDiagnosticsTool(deps: ManageDeps, args: { key: string }, now = Date.now()): ToolResult {
	if (!STORE_KEY_RE.test(args.key)) {
		return text(
			`# Store not found\n\nThat is not a store key; call \`list_project_stores\` to get a real one.`,
			true,
		);
	}
	const store = deps.list().find((candidate) => candidate.key === args.key);
	if (store === undefined) {
		return text(
			`# Store not found\n\nNo store named \`${args.key}\`; call \`list_project_stores\` to get a real store key.`,
			true,
		);
	}

	const read = deps.diagnostics(args.key);
	if (read.state === "absent") {
		return text(
			`# No diagnostics yet\n\nNothing at \`${read.file}\`. A daemon writes it on its first sample, and none has written one for \`${args.key}\` yet.`,
		);
	}
	if (read.state === "unreadable") {
		return text(`# Diagnostics unreadable\n\n\`${read.file}\`: ${read.reason}`, true);
	}
	return text(renderDiagnostics(args.key, read.file, read.data, deps.reports(args.key), now));
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
