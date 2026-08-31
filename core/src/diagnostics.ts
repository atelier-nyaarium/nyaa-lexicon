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
import { hostMemory, processMemory, runtimeVerdict, storePaths } from "@nyaa-lexicon/client";
import { z } from "zod";
import { type Clock, systemClock, type TimerHandle } from "./clock.js";
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
/** Fractions of the host's memory the daemon's resident size may hold: write above the first, re-arm below the second. */
const HIGH_WATER = 0.85;
const LOW_WATER = 0.6;
/** Overwrites itself; pruning never counts it. */
export const SELF_REPORT = "daemon-high.json";
export const HEAP_SNAPSHOT_ENV = "LEXICON_HEAP_SNAPSHOT";
/** Crash reports keep node's naming; the stamp inside sorts oldest first. */
const NODE_REPORT_RE = /^report\..*\.json$/;
const SNAPSHOT_RE = /^Heap\..*\.heapsnapshot$/;

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

/** No heap limit: the runtime states none, and the OS kills at exhaustion, so memory is judged against the host. */
const HostSchema = z.object({
	runtime: z.enum(["bun", "node"]),
	memTotal: z.number().nullable(),
	memAvailable: z.number().nullable(),
	memoryLimit: z
		.object({ bytes: z.number(), source: z.enum(["cgroupV1", "cgroupV2"]) })
		.nullable()
		.optional(),
	sampler: z.enum(["procfs", "none"]),
});

const CollectionSchema = z.object({
	writtenAt: z.number(),
	workspaceRoot: z.string(),
	daemon: z.object({ pid: z.number(), version: z.string(), startedAt: z.number() }),
	peaks: z.array(PeakSchema),
	incidents: z.array(IncidentSchema),
	samples: z.array(SampleSchema),
});

export const DiagnosticsSchema = CollectionSchema.extend({ version: z.literal(2), host: HostSchema });

/** Version 1, read as the current shape and never written. */
const LegacyDiagnosticsSchema = CollectionSchema.extend({
	version: z.literal(1),
	host: z.object({
		nodeHeapLimit: z.number(),
		memTotal: z.number().nullable(),
		memAvailable: z.number().nullable(),
		sampler: z.enum(["procfs", "none"]),
		signal: z.string(),
		reportsExcludeEnv: z.boolean(),
	}),
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
}

export interface CollectorOptions {
	file: string;
	reportsDir: string;
	workspaceRoot: string;
	daemon: { pid: number; version: string; startedAt: number };
	/** The children alive right now. */
	processes: () => Array<{ role: string; pid: number }>;
	context: () => SampleContext;
	/** Told about a failure. Never thrown: diagnostics must not take the daemon down. */
	onError?: (message: string) => void;
	/** Injected so tests decide rather than wait. */
	clock?: Clock;
	selfMemory?: () => SelfMemory;
	readMemory?: (pid: number) => { rss: number; hwm: number } | null;
	readHost?: () => {
		memTotal: number;
		memAvailable: number;
		memoryLimit?: { bytes: number; source: "cgroupV1" | "cgroupV2" } | null;
	} | null;
	/** Writes the high-water report; the default writes a sample under `SELF_REPORT`. */
	writeSelfReport?: (file: string, sample: Sample, hostTotal: number) => void;
	/** Writes a heap snapshot into the reports directory; the default asks the runtime. */
	writeSnapshot?: (reportsDir: string, stamp: number) => void;
	env?: Record<string, string | undefined>;
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
			rss: number | null;
			hostTotal: number | null;
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

function runtimeName(): "bun" | "node" {
	return runtimeVerdict().kind === "notBun" ? "node" : "bun";
}

/**
 * Reports hold stacks and the command line. Owner only, tightened even where the directory already
 * existed wider, and pruned here too: a daemon dying before its collector's first write would
 * otherwise leave one report per death, unbounded.
 */
export function makeReportsDir(reportsDir: string): void {
	mkdirSync(reportsDir, { recursive: true, mode: 0o700 });
	chmodSync(reportsDir, 0o700);
	pruneReports(reportsDir);
}

function stale(names: string[], pattern: RegExp, keep: number): string[] {
	return names
		.filter((name) => pattern.test(name))
		.sort()
		.reverse()
		.slice(keep);
}

/** A write killed between temp and rename leaves this; it is nobody's once the writer is gone. */
function abandonedTemp(name: string): boolean {
	if (!name.endsWith(".tmp")) return false;
	const target = name.slice(0, -".tmp".length);
	return target === SELF_REPORT || SNAPSHOT_RE.test(target) || NODE_REPORT_RE.test(target);
}

/** The newest reports and snapshots survive. Answers what it removed. */
export function pruneReports(dir: string, keep = REPORTS_KEPT, keepSnapshots = SNAPSHOTS_KEPT): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of [
		...stale(names, NODE_REPORT_RE, keep),
		...stale(names, SNAPSHOT_RE, keepSnapshots),
		...names.filter(abandonedTemp),
	]) {
		try {
			unlinkSync(path.join(dir, name));
			removed.push(name);
		} catch {
			// Gone already.
		}
	}
	return removed;
}

/** Temp then rename, so a reader never meets half a file. A failed temp is removed. */
function writeAtomically(file: string, content: string): void {
	const temp = `${file}.tmp`;
	try {
		writeFileSync(temp, content);
		renameSync(temp, file);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// Not ours, or gone.
		}
		throw error;
	}
}

/**
 * The high-water report shares a crash report's header and heap block, so one reader renders
 * both.
 */
function writeSelfReportFile(file: string, sample: Sample, hostTotal: number): void {
	const own = sample.processes.find((row) => row.role === "daemon");
	const report = {
		header: {
			event: "high-water",
			trigger: "rss",
			dumpEventTimeStamp: String(sample.at),
			processId: own?.pid ?? null,
		},
		javascriptHeap: { usedMemory: own?.heapUsed ?? null, memoryLimit: null },
		resident: { rss: own?.rss ?? null, hostTotal },
		sample,
	};
	writeAtomically(file, JSON.stringify(report));
}

/**
 * A heap snapshot in the format the browser devtools read, named like a crash-time snapshot so
 * pruning and listing treat both alike. Reached through the global rather than a `bun:` import,
 * which core never carries.
 */
export function writeHeapSnapshot(reportsDir: string, stamp: number): void {
	const file = path.join(reportsDir, `Heap.${stamp}.${process.pid}.heapsnapshot`);
	const bun = (globalThis as { Bun?: { generateHeapSnapshot(format: "v8"): string } }).Bun;
	if (bun === undefined) throw new Error("heap snapshots come from bun, and this is not bun");
	writeAtomically(file, bun.generateHeapSnapshot("v8"));
}

/** A regular file, or why not. A link or a directory wearing the name is not the file. */
function regularFile(file: string): string | null {
	try {
		return lstatSync(file).isFile() ? null : "not a regular file";
	} catch (error) {
		return describe(error);
	}
}

/** Version 1, read as the current shape. */
function fromLegacy(legacy: z.infer<typeof LegacyDiagnosticsSchema>): Diagnostics {
	const { version: _version, host, ...rest } = legacy;
	return {
		...rest,
		version: 2,
		host: {
			runtime: "node",
			memTotal: host.memTotal,
			memAvailable: host.memAvailable,
			memoryLimit: null,
			sampler: host.sampler,
		},
	};
}

/** Three answers, because a missing file and a corrupt one call for different next steps. Takes
 * the store directory as the listing showed it. */
export function readDiagnostics(directory: string): ReadDiagnostics {
	const file = storePaths(directory).diagnosticsFile;
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
	if (checked.success) return { state: "present", file, data: checked.data };
	const legacy = LegacyDiagnosticsSchema.safeParse(parsed);
	if (legacy.success) return { state: "present", file, data: fromLegacy(legacy.data) };
	return { state: "unreadable", file, reason: checked.error.message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function summarizeReport(file: string): ReportSummary {
	// One stat: the daemon prunes while this lists, so a file present a moment ago may be gone.
	let size: number;
	try {
		const found = lstatSync(file);
		if (!found.isFile()) return { kind: "unreadable", file, reason: "not a regular file" };
		size = found.size;
	} catch (error) {
		return { kind: "unreadable", file, reason: describe(error) };
	}
	if (SNAPSHOT_RE.test(path.basename(file))) return { kind: "snapshot", file, bytes: size };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { kind: "unreadable", file, reason: describe(error) };
	}
	const header = asRecord(asRecord(parsed)?.["header"]);
	if (header === null) return { kind: "unreadable", file, reason: "no report header" };
	const heap = asRecord(asRecord(parsed)?.["javascriptHeap"]) ?? {};
	const resident = asRecord(asRecord(parsed)?.["resident"]) ?? {};
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
		rss: count(resident["rss"]),
		hostTotal: count(resident["hostTotal"]),
	};
}

/** Newest first. No directory is empty; one that cannot be read, or is a link, says so. */
export function listReports(directory: string): ReportSummary[] {
	const dir = storePaths(directory).reportsDir;
	let names: string[];
	try {
		if (!lstatSync(dir).isDirectory()) return [{ kind: "unreadable", file: dir, reason: "not a directory" }];
		names = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [{ kind: "unreadable", file: dir, reason: describe(error) }];
	}
	return names
		.filter((name) => NODE_REPORT_RE.test(name) || SNAPSHOT_RE.test(name) || name === SELF_REPORT)
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
	};
}

function push<T>(ring: T[], item: T, size: number): void {
	ring.push(item);
	if (ring.length > size) ring.splice(0, ring.length - size);
}

////////////////////////////////
//  Collector

export function startDiagnostics(options: CollectorOptions): Collector {
	const clock = options.clock ?? systemClock;
	const now = () => clock.now();
	const setTimer = (fn: () => void, ms: number) => clock.setTimer(fn, ms);
	const clearTimer = (handle: TimerHandle) => clock.clearTimer(handle);
	const selfMemory = options.selfMemory ?? defaultSelfMemory;
	const readMemory = options.readMemory ?? processMemory;
	const readHost = options.readHost ?? hostMemory;
	const writeSelfReport = options.writeSelfReport ?? writeSelfReportFile;
	const writeSnapshot = options.writeSnapshot ?? writeHeapSnapshot;
	const snapshotWanted = heapSnapshotWanted(options.env ?? process.env);
	const sampleMs = options.sampleMs ?? SAMPLE_MS;
	const writeMs = options.writeMs ?? WRITE_MS;

	// Decided once: a host has procfs or it does not.
	const sampler = readHost() === null ? "none" : "procfs";
	const runtime = runtimeName();

	const samples: Sample[] = [];
	const incidents: Incident[] = [];
	const peaks = new Map<string, Peak>();
	/** Latched above the high mark until the heap comes back down. */
	let highWaterWritten = false;
	let lastWrite: number | null = null;
	let timer: TimerHandle | null = null;
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

	/**
	 * The daemon judges its own resident size against the host's memory, the one limit the runtime
	 * has; a child is another process, and asking it costs its life on bun.
	 */
	function watchHighWater(sample: Sample, hostTotal: number | null): void {
		if (hostTotal === null || hostTotal <= 0) return;
		const measure = sample.processes.find((row) => row.role === "daemon")?.rss ?? null;
		if (measure === null) return;
		if (measure >= hostTotal * HIGH_WATER) {
			if (highWaterWritten) return;
			highWaterWritten = true;
			try {
				makeReportsDir(options.reportsDir);
				writeSelfReport(path.join(options.reportsDir, SELF_REPORT), sample, hostTotal);
				if (snapshotWanted) writeSnapshot(options.reportsDir, sample.at);
			} catch (error) {
				options.onError?.(`high-water report failed: ${describe(error)}`);
			}
		} else if (measure < hostTotal * LOW_WATER) highWaterWritten = false;
	}

	/** Contained, because a thrown sample would surface in the daemon's timer. */
	function observe(): void {
		try {
			const taken = takeSample();
			push(samples, taken, SAMPLE_RING);
			notePeaks(taken);
			const host = readHost();
			watchHighWater(taken, host?.memoryLimit?.bytes ?? host?.memTotal ?? null);
		} catch (error) {
			options.onError?.(`diagnostics sample failed: ${describe(error)}`);
		}
	}

	function current(): Diagnostics {
		const host = readHost();
		return {
			version: 2,
			writtenAt: now(),
			workspaceRoot: options.workspaceRoot,
			daemon: options.daemon,
			host: {
				runtime,
				memTotal: host?.memTotal ?? null,
				memAvailable: host?.memAvailable ?? null,
				memoryLimit: host?.memoryLimit ?? null,
				sampler,
			},
			peaks: [...peaks.values()],
			incidents: [...incidents],
			samples: [...samples],
		};
	}

	function write(): void {
		const snapshot = current();
		mkdirSync(path.dirname(options.file), { recursive: true });
		writeAtomically(options.file, JSON.stringify(snapshot));
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
