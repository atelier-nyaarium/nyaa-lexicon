// The SOLE owner of the diagnostics collection and its file.
//
// A collection, never a stream: rings bound it and the file is rewritten whole.

import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { z } from "zod";
import { currentHost, type PlatformEnv, storePaths } from "./paths.js";
import { hostMemory, processMemory } from "./procfs.js";
import type { ProviderExit } from "./supervisor.js";

////////////////////////////////
//  Constants

export const SAMPLE_MS = 10_000;
export const WRITE_MS = 30_000;
/** An hour at the sample rate. */
export const SAMPLE_RING = 360;
export const INCIDENT_RING = 20;
export const REPORTS_KEPT = 8;
/** Opt-in and gigabytes each, so fewer. */
export const SNAPSHOTS_KEPT = 2;
/** Fractions of the heap limit: ask above the first, re-arm below the second. */
const HIGH_WATER = 0.85;
const LOW_WATER = 0.6;
export const HIGH_WATER_SIGNAL = "SIGUSR2";
/** Relative, so `process.report.directory` places it. Overwrites itself; pruning never counts it. */
export const SELF_REPORT = "daemon-high.json";
export const HEAP_SNAPSHOT_ENV = "LEXICON_HEAP_SNAPSHOT";
/** Node's own naming; the stamp inside sorts oldest first. */
const NODE_REPORT_RE = /^report\..*\.json$/;
const NODE_SNAPSHOT_RE = /^Heap\..*\.heapsnapshot$/;

////////////////////////////////
//  Schemas

const ContextSchema = z.object({
	index: z.object({ state: z.string(), done: z.number(), total: z.number() }),
	inFlight: z.number(),
	connections: z.number(),
});

/** Bytes. `rss` and `hwm` are null where procfs cannot say; the heap fields are the daemon's own. */
const ProcessSampleSchema = z.object({
	role: z.string(),
	pid: z.number(),
	rss: z.number().nullable(),
	hwm: z.number().nullable(),
	heapUsed: z.number().optional(),
	heapTotal: z.number().optional(),
	external: z.number().optional(),
	arrayBuffers: z.number().optional(),
});

const SampleSchema = z.object({
	at: z.number(),
	context: ContextSchema,
	processes: z.array(ProcessSampleSchema),
});

/** `rss` and `context` come from the last sample before the death. */
const IncidentSchema = z.object({
	at: z.number(),
	role: z.string(),
	pid: z.number().nullable(),
	code: z.number().nullable(),
	signal: z.string().nullable(),
	rss: z.number().nullable(),
	context: ContextSchema.nullable(),
});

const PeakSchema = z.object({ role: z.string(), pid: z.number(), rss: z.number(), at: z.number() });

export const DiagnosticsSchema = z.object({
	version: z.literal(1),
	writtenAt: z.number(),
	workspaceRoot: z.string(),
	daemon: z.object({ pid: z.number(), version: z.string(), startedAt: z.number() }),
	host: z.object({
		/** Shared by every process here: one executable, no heap flag. */
		nodeHeapLimit: z.number(),
		memTotal: z.number().nullable(),
		memAvailable: z.number().nullable(),
		sampler: z.enum(["procfs", "none"]),
		signal: z.enum(["SIGUSR2", "unavailable"]),
		/** Whether node's reports here omit the environment. */
		reportsExcludeEnv: z.boolean(),
	}),
	peaks: z.array(PeakSchema),
	incidents: z.array(IncidentSchema),
	samples: z.array(SampleSchema),
});

export type Diagnostics = z.infer<typeof DiagnosticsSchema>;
export type SampleContext = z.infer<typeof ContextSchema>;
export type Sample = z.infer<typeof SampleSchema>;
export type ProcessSample = z.infer<typeof ProcessSampleSchema>;
export type Incident = z.infer<typeof IncidentSchema>;
type Peak = z.infer<typeof PeakSchema>;

////////////////////////////////
//  Interfaces & Types

export interface SelfMemory {
	rss: number;
	heapUsed: number;
	heapTotal: number;
	external: number;
	arrayBuffers: number;
	heapLimit: number;
}

/** What a node child is launched with, and which signals it then survives. */
export interface NodeReportSetup {
	argv: string[];
	handles: NodeJS.Signals[];
	/** False on a node too old to exclude it, so the report carries the environment. */
	excludesEnv: boolean;
	/** Why there are no reports, when the directory could not be made. Argv is empty then. */
	failure?: string;
}

export interface CollectorOptions {
	file: string;
	reportsDir: string;
	workspaceRoot: string;
	daemon: { pid: number; version: string; startedAt: number };
	/** The children alive right now. */
	processes: () => Array<{ role: string; pid: number }>;
	context: () => SampleContext;
	/**
	 * Asks a child for a report. Must go through the owner of the child handle, never a bare
	 * `process.kill`: a reused pid is a stranger, and a process without the handler dies.
	 */
	signal: (pid: number, signal: NodeJS.Signals) => boolean;
	/** Told about a failure. Never thrown: diagnostics must not take the daemon down. */
	onError?: (message: string) => void;
	/** Injected so tests decide rather than wait. */
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	selfMemory?: () => SelfMemory;
	readMemory?: (pid: number) => { rss: number; hwm: number } | null;
	readHost?: () => { memTotal: number; memAvailable: number } | null;
	writeSelfReport?: (name: string) => void;
	platform?: NodeJS.Platform;
	reportsExcludeEnv?: boolean;
	sampleMs?: number;
	writeMs?: number;
}

export interface Collector {
	/** One now, outside the schedule. */
	sample(): void;
	recordExit(exit: ProviderExit): void;
	/** Write now, whatever the rate limit says. */
	flush(): void;
	/** Final sample and write, then silence. */
	stop(): void;
	/** As it would be written. */
	current(): Diagnostics;
}

export type ReadDiagnostics =
	| { state: "absent"; file: string }
	| { state: "unreadable"; file: string; reason: string }
	| { state: "present"; file: string; data: Diagnostics };

/** One file in `reports/`. */
export type ReportSummary =
	| {
			kind: "report";
			file: string;
			at: number | null;
			event: string;
			trigger: string;
			pid: number | null;
			heapUsed: number | null;
			heapLimit: number | null;
	  }
	| { kind: "snapshot"; file: string; bytes: number }
	| { kind: "unreadable"; file: string; reason: string };

////////////////////////////////
//  Functions & Helpers

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function heapSnapshotWanted(env: Record<string, string | undefined> = process.env): boolean {
	const value = env[HEAP_SNAPSHOT_ENV];
	return value !== undefined && value !== "" && value !== "0";
}

/**
 * Whether this node's report API has a setting. Asked of THIS process, which is right for its
 * children too: they run the same executable. Bun has no report API at all.
 */
function reportSupports(setting: "excludeEnv" | "excludeNetwork"): boolean {
	const report = (process as { report?: object }).report;
	return report !== undefined && setting in report;
}

/** A report carries every environment variable unless node is new enough to leave them out. */
export function reportsExcludeEnv(): boolean {
	return reportSupports("excludeEnv");
}

/**
 * Reports hold stacks, the command line and, on old node, the environment. Owner only, tightened
 * even where the directory already existed wider, and pruned here too: a daemon dying before its
 * collector's first write would otherwise leave one report per death, unbounded.
 */
function makeReportsDir(reportsDir: string): void {
	mkdirSync(reportsDir, { recursive: true, mode: 0o700 });
	chmodSync(reportsDir, 0o700);
	pruneReports(reportsDir);
}

/**
 * Argv for a node child: a report on a fatal error, and one on demand while alive.
 *
 * Creates the directory, since a report aimed at a missing one is lost without a word. Never
 * throws: a directory that cannot be made costs the reports, never the caller.
 */
export function nodeReportSetup(
	reportsDir: string,
	host: { env: Record<string, string | undefined>; platform: NodeJS.Platform } = currentHost(),
): NodeReportSetup {
	try {
		makeReportsDir(reportsDir);
	} catch (error) {
		return { argv: [], handles: [], excludesEnv: false, failure: describe(error) };
	}
	const argv = ["--report-on-fatalerror", "--report-compact", `--report-directory=${reportsDir}`];
	const excludesEnv = reportsExcludeEnv();
	if (excludesEnv) argv.push("--report-exclude-env");
	if (reportSupports("excludeNetwork")) argv.push("--report-exclude-network");
	const handles: NodeJS.Signals[] = [];
	// No signal handler on Windows.
	if (host.platform !== "win32") {
		argv.push("--report-on-signal", `--report-signal=${HIGH_WATER_SIGNAL}`);
		handles.push(HIGH_WATER_SIGNAL);
	}
	if (heapSnapshotWanted(host.env)) argv.push("--heapsnapshot-near-heap-limit=1", `--diagnostic-dir=${reportsDir}`);
	return { argv, handles, excludesEnv };
}

/**
 * The daemon's own settings, the same its children get on argv. A snapshot lands in the cwd.
 * Answers why the reports are off, or null.
 */
export function enableSelfReports(
	reportsDir: string,
	host: { env: Record<string, string | undefined>; platform: NodeJS.Platform } = currentHost(),
): string | null {
	try {
		makeReportsDir(reportsDir);
	} catch (error) {
		return describe(error);
	}
	process.report.directory = reportsDir;
	process.report.compact = true;
	process.report.reportOnFatalError = true;
	if (reportSupports("excludeEnv")) process.report.excludeEnv = true;
	// Typed nowhere yet; the runtime check above is the only guard it needs.
	if (reportSupports("excludeNetwork")) (process.report as { excludeNetwork?: boolean }).excludeNetwork = true;
	if (host.platform !== "win32") process.report.reportOnSignal = true;
	if (heapSnapshotWanted(host.env)) v8.setHeapSnapshotNearHeapLimit(1);
	return null;
}

function stale(names: string[], pattern: RegExp, keep: number): string[] {
	return names
		.filter((name) => pattern.test(name))
		.sort()
		.reverse()
		.slice(keep);
}

/** The newest of node's own reports and snapshots survive. Answers what it removed. */
export function pruneReports(dir: string, keep = REPORTS_KEPT, keepSnapshots = SNAPSHOTS_KEPT): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of [...stale(names, NODE_REPORT_RE, keep), ...stale(names, NODE_SNAPSHOT_RE, keepSnapshots)]) {
		try {
			unlinkSync(path.join(dir, name));
			removed.push(name);
		} catch {
			// Gone already.
		}
	}
	return removed;
}

/** Three answers, because a missing file and a corrupt one call for different next steps. */
/** A regular file, or why not. A link or a directory wearing the name is not the file. */
function regularFile(file: string): string | null {
	try {
		return lstatSync(file).isFile() ? null : "not a regular file";
	} catch (error) {
		return describe(error);
	}
}

export function readDiagnostics(key: string, host: PlatformEnv = currentHost()): ReadDiagnostics {
	const file = storePaths(host, key).diagnosticsFile;
	let raw: string;
	try {
		const refused = regularFile(file);
		if (refused !== null) throw new Error(refused);
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || describe(error).startsWith("ENOENT")) {
			return { state: "absent", file };
		}
		return { state: "unreadable", file, reason: describe(error) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { state: "unreadable", file, reason: describe(error) };
	}
	const checked = DiagnosticsSchema.safeParse(parsed);
	if (!checked.success) return { state: "unreadable", file, reason: checked.error.message };
	return { state: "present", file, data: checked.data };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function summarizeReport(file: string): ReportSummary {
	if (NODE_SNAPSHOT_RE.test(path.basename(file))) {
		const refused = regularFile(file);
		if (refused !== null) return { kind: "unreadable", file, reason: refused };
		return { kind: "snapshot", file, bytes: lstatSync(file).size };
	}
	const refused = regularFile(file);
	if (refused !== null) return { kind: "unreadable", file, reason: refused };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { kind: "unreadable", file, reason: describe(error) };
	}
	const header = asRecord(asRecord(parsed)?.["header"]);
	if (header === null) return { kind: "unreadable", file, reason: "no report header" };
	const heap = asRecord(asRecord(parsed)?.["javascriptHeap"]) ?? {};
	const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
	const count = (value: unknown) => (typeof value === "number" ? value : null);
	// Millis, as a string.
	const stamp = Number(header["dumpEventTimeStamp"]);
	return {
		kind: "report",
		file,
		at: Number.isFinite(stamp) && stamp > 0 ? stamp : null,
		event: text(header["event"], "unknown"),
		trigger: text(header["trigger"], "unknown"),
		pid: count(header["processId"]),
		heapUsed: count(heap["usedMemory"]),
		heapLimit: count(heap["memoryLimit"]),
	};
}

/** Newest first. No directory is empty; one that cannot be read says so. */
export function listReports(key: string, host: PlatformEnv = currentHost()): ReportSummary[] {
	const dir = storePaths(host, key).reportsDir;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [{ kind: "unreadable", file: dir, reason: describe(error) }];
	}
	return names
		.filter((name) => NODE_REPORT_RE.test(name) || NODE_SNAPSHOT_RE.test(name) || name === SELF_REPORT)
		.sort()
		.reverse()
		.map((name) => summarizeReport(path.join(dir, name)));
}

function defaultSelfMemory(): SelfMemory {
	const usage = process.memoryUsage();
	return {
		rss: usage.rss,
		heapUsed: usage.heapUsed,
		heapTotal: usage.heapTotal,
		external: usage.external,
		arrayBuffers: usage.arrayBuffers,
		heapLimit: v8.getHeapStatistics().heap_size_limit,
	};
}

function push<T>(ring: T[], item: T, size: number): void {
	ring.push(item);
	if (ring.length > size) ring.splice(0, ring.length - size);
}

////////////////////////////////
//  Collector

export function startDiagnostics(options: CollectorOptions): Collector {
	const now = options.now ?? (() => Date.now());
	const setTimer =
		options.setTimer ??
		((fn, ms) => {
			const handle = setTimeout(fn, ms);
			handle.unref?.();
			return handle;
		});
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const selfMemory = options.selfMemory ?? defaultSelfMemory;
	const readMemory = options.readMemory ?? processMemory;
	const readHost = options.readHost ?? hostMemory;
	const writeSelfReport = options.writeSelfReport ?? ((name) => void process.report.writeReport(name));
	const platform = options.platform ?? process.platform;
	const sampleMs = options.sampleMs ?? SAMPLE_MS;
	const writeMs = options.writeMs ?? WRITE_MS;

	const heapLimit = selfMemory().heapLimit;
	// Decided once: a host has procfs or it does not.
	const sampler = readHost() === null ? "none" : "procfs";
	const signalState = platform === "win32" ? "unavailable" : HIGH_WATER_SIGNAL;
	const excludesEnv = options.reportsExcludeEnv ?? reportsExcludeEnv();

	const samples: Sample[] = [];
	const incidents: Incident[] = [];
	const peaks = new Map<string, Peak>();
	/** Pids already asked, until they come back down. */
	const asked = new Set<number>();
	let lastWrite: number | null = null;
	let timer: unknown = null;
	let stopped = false;

	function takeSample(): Sample {
		const self = selfMemory();
		const own = readMemory(options.daemon.pid);
		const rows: ProcessSample[] = [
			{
				role: "daemon",
				pid: options.daemon.pid,
				rss: self.rss,
				hwm: own?.hwm ?? null,
				heapUsed: self.heapUsed,
				heapTotal: self.heapTotal,
				external: self.external,
				arrayBuffers: self.arrayBuffers,
			},
		];
		for (const child of options.processes()) {
			const memory = readMemory(child.pid);
			rows.push({ role: child.role, pid: child.pid, rss: memory?.rss ?? null, hwm: memory?.hwm ?? null });
		}
		return { at: now(), context: options.context(), processes: rows };
	}

	function notePeaks(sample: Sample): void {
		for (const row of sample.processes) {
			if (row.rss === null) continue;
			const peak = peaks.get(row.role);
			if (peak === undefined || row.rss > peak.rss) {
				peaks.set(row.role, { role: row.role, pid: row.pid, rss: row.rss, at: sample.at });
			}
		}
	}

	/** The daemon is judged on its heap, a child on its RSS: the proxy available for each. */
	function watchHighWater(sample: Sample): void {
		for (const row of sample.processes) {
			const own = row.role === "daemon";
			const measure = own ? (row.heapUsed ?? null) : row.rss;
			if (measure === null) continue;
			if (measure >= heapLimit * HIGH_WATER) {
				// Latched either way: a refused signal is refused until the process comes down too.
				if (asked.has(row.pid)) continue;
				asked.add(row.pid);
				try {
					if (own) writeSelfReport(SELF_REPORT);
					else if (!options.signal(row.pid, HIGH_WATER_SIGNAL)) {
						options.onError?.(`high-water report for ${row.role} not delivered: no handler, or gone`);
					}
				} catch (error) {
					options.onError?.(`high-water report for ${row.role} failed: ${describe(error)}`);
				}
			} else if (measure < heapLimit * LOW_WATER) asked.delete(row.pid);
		}
	}

	/** Contained, because a thrown sample would surface in the daemon's timer. */
	function observe(): void {
		try {
			const taken = takeSample();
			push(samples, taken, SAMPLE_RING);
			notePeaks(taken);
			watchHighWater(taken);
		} catch (error) {
			options.onError?.(`diagnostics sample failed: ${describe(error)}`);
		}
	}

	function current(): Diagnostics {
		const host = readHost();
		return {
			version: 1,
			writtenAt: now(),
			workspaceRoot: options.workspaceRoot,
			daemon: options.daemon,
			host: {
				nodeHeapLimit: heapLimit,
				memTotal: host?.memTotal ?? null,
				memAvailable: host?.memAvailable ?? null,
				sampler,
				signal: signalState,
				reportsExcludeEnv: excludesEnv,
			},
			peaks: [...peaks.values()],
			incidents: [...incidents],
			samples: [...samples],
		};
	}

	/** Temp then rename: atomic. A failed temp is removed, or every later write meets it. */
	function write(): void {
		const snapshot = current();
		mkdirSync(path.dirname(options.file), { recursive: true });
		const temp = `${options.file}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify(snapshot));
			renameSync(temp, options.file);
		} catch (error) {
			try {
				unlinkSync(temp);
			} catch {
				// Not ours, or gone.
			}
			throw error;
		}
		lastWrite = snapshot.writtenAt;
		pruneReports(options.reportsDir);
	}

	function flush(): void {
		try {
			write();
		} catch (error) {
			options.onError?.(`diagnostics not written: ${describe(error)}`);
		}
	}

	/** A clock stepped backwards counts as due, or writes stall until it catches up. */
	function due(): boolean {
		return lastWrite === null || now() < lastWrite || now() - lastWrite >= writeMs;
	}

	function sample(): void {
		if (stopped) return;
		observe();
		if (due()) flush();
	}

	function recordExit(exit: ProviderExit): void {
		if (stopped) return;
		const last = samples.at(-1);
		const row = exit.pid === null ? undefined : last?.processes.find((p) => p.pid === exit.pid);
		push(
			incidents,
			{
				at: now(),
				role: `provider:${exit.providerId}`,
				pid: exit.pid,
				code: exit.code,
				signal: exit.signal,
				rss: row?.rss ?? null,
				context: last?.context ?? null,
			},
			INCIDENT_RING,
		);
		if (exit.pid !== null) asked.delete(exit.pid);
		flush();
	}

	function tick(): void {
		timer = null;
		sample();
		if (!stopped) timer = setTimer(tick, sampleMs);
	}

	function stop(): void {
		if (stopped) return;
		if (timer !== null) clearTimer(timer);
		timer = null;
		observe();
		stopped = true;
		flush();
	}

	// The file exists before anything can die.
	tick();
	return { sample, recordExit, flush, stop, current };
}
