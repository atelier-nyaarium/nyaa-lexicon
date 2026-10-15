// Owns collection and writes.
//
// A collection, never a stream: rings bound it and the file is rewritten whole.

import { chmodSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { hostMemory, processMemory, runtimeVerdict } from "@nyaa-lexicon/client";
import { atomicWrite, atomicWriteJson, atomicWriteTempTarget } from "./atomicJson.js";
import { type Clock, systemClock, type TimerHandle } from "./clock.js";
import {
	type Diagnostics,
	describe,
	type Incident,
	NODE_REPORT_RE,
	type Peak,
	type ProcessSample,
	type Sample,
	type SampleContext,
	SELF_REPORT,
	SNAPSHOT_RE,
} from "./diagnosticFiles.js";
import type { ProviderExit } from "./supervisor.js";
import type { Recorded } from "./timings.js";

export {
	type Diagnostics,
	DiagnosticsSchema,
	type Incident,
	listReports,
	type ProcessSample,
	type ReadDiagnostics,
	type ReportSummary,
	readDiagnostics,
	type Sample,
	type SampleContext,
} from "./diagnosticFiles.js";
export { SELF_REPORT };

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
export const HEAP_SNAPSHOT_ENV = "LEXICON_HEAP_SNAPSHOT";

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
	/** The daemon's sparse timings, written with its samples. */
	timings?: () => Recorded;
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

////////////////////////////////
//  Functions & Helpers

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
	const targets = [atomicWriteTempTarget(name), name.endsWith(".tmp") ? name.slice(0, -".tmp".length) : undefined];
	return targets.some(
		(target) =>
			target === SELF_REPORT ||
			(target !== undefined && (SNAPSHOT_RE.test(target) || NODE_REPORT_RE.test(target))),
	);
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
	atomicWriteJson(file, report);
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
	atomicWrite(file, bun.generateHeapSnapshot("v8"));
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
		const recorded = options.timings?.();
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
			...(recorded === undefined ? {} : { timings: recorded }),
		};
	}

	function write(): void {
		const snapshot = current();
		mkdirSync(path.dirname(options.file), { recursive: true });
		atomicWriteJson(options.file, snapshot, { temporaryPath: `${options.file}.tmp` });
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
