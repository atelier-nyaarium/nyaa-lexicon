import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { storePaths } from "@nyaa-lexicon/client";
import { z } from "zod";
import { TimingsSchema } from "./timings.js";

////////////////////////////////
//  Constants

/** Overwrites itself; pruning never counts it. */
export const SELF_REPORT = "daemon-high.json";
/** Crash reports keep node's naming; the stamp inside sorts oldest first. */
export const NODE_REPORT_RE = /^report\..*\.json$/;
export const SNAPSHOT_RE = /^Heap\..*\.heapsnapshot$/;

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
	/** Absent from a daemon that kept none. */
	timings: TimingsSchema.optional(),
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
export type Peak = z.infer<typeof PeakSchema>;

////////////////////////////////
//  Interfaces & Types

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

export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
