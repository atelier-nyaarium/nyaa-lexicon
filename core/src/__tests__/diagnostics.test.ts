import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type PlatformEnv, processMemory, stateRoot, storePaths } from "@nyaa-lexicon/client";
import {
	type CollectorOptions,
	DiagnosticsSchema,
	HEAP_SNAPSHOT_ENV,
	heapSnapshotWanted,
	INCIDENT_RING,
	listReports,
	makeReportsDir,
	pruneReports,
	readDiagnostics,
	SAMPLE_RING,
	type SampleContext,
	SELF_REPORT,
	startDiagnostics,
	writeHeapSnapshot,
} from "../diagnostics";
import { ProviderSupervisor } from "../supervisor";
import { fakeClock } from "./fakeClock";

////////////////////////////////
//  Helpers

const KEY = "proj-abc";
const DAEMON = 7;
const REFERENCE = path.join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"protocol",
	"src",
	"conformance",
	"referenceProvider.ts",
);
const CHILD = 42;
/** What a node crash report states; nothing written today carries one. */
const LIMIT = 4_000_000_000;
/** The host's memory as the harness's procfs states it. */
const HOST = 32e9;
const SAMPLE = 10;
const WRITE = 30;

const roots: string[] = [];

/** For the one case that steps a clock the harness does not own. */
let clockValue = 5_000_000;

function scratch(): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-diag-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(overrides: Partial<CollectorOptions> = {}, { realReports = false } = {}) {
	const root = scratch();
	const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
	const paths = storePaths(path.join(stateRoot(host), KEY));
	const clock = fakeClock();
	const memory = new Map<number, { rss: number; hwm: number }>([[CHILD, { rss: 1000, hwm: 1000 }]]);
	const selfReports: string[] = [];
	const snapshots: string[] = [];
	const errors: string[] = [];
	const state = {
		self: { rss: 100, heapUsed: 50, heapTotal: 80, external: 5, arrayBuffers: 1 },
		context: { index: { state: "ready", done: 3, total: 3 }, inFlight: 0, connections: 1 } as SampleContext,
		children: [{ role: "provider:alpha", pid: CHILD }],
	};
	const options: CollectorOptions = {
		file: paths.diagnosticsFile,
		reportsDir: paths.reportsDir,
		workspaceRoot: "/w",
		daemon: { pid: DAEMON, version: "2.0.0", startedAt: 1 },
		processes: () => state.children,
		context: () => state.context,
		onError: (message) => errors.push(message),
		clock,
		selfMemory: () => state.self,
		readMemory: (pid) => memory.get(pid) ?? null,
		readHost: () => ({ memTotal: HOST, memAvailable: HOST / 2 }),
		...(realReports
			? {}
			: {
					writeSelfReport: (file: string) => {
						selfReports.push(path.basename(file));
					},
				}),
		writeSnapshot: (dir, stamp) => {
			snapshots.push(`${dir}:${stamp}`);
		},
		env: {},
		sampleMs: SAMPLE,
		writeMs: WRITE,
		...overrides,
	};
	const collector = startDiagnostics(options);
	const read = () => DiagnosticsSchema.parse(JSON.parse(readFileSync(paths.diagnosticsFile, "utf8")));
	return { root, host, paths, clock, memory, selfReports, snapshots, errors, state, collector, read };
}

////////////////////////////////
//  Tests

describe("the collection on disk", () => {
	it("exists after the first sample, before anything can die", () => {
		const { paths, read, clock } = harness();

		expect(existsSync(paths.diagnosticsFile)).toBe(true);
		const written = read();
		expect(written.samples).toHaveLength(1);
		expect(written.samples[0]?.at).toBe(clock.now());
		expect(written.host).toMatchObject({ memTotal: HOST, sampler: "procfs", runtime: "bun" });
		expect(written.samples[0]?.processes.map((p) => p.role)).toEqual(["daemon", "provider:alpha"]);
	});

	it("writes at most every writeMs from samples, and immediately on an incident", () => {
		const { clock, read, collector } = harness();
		const first = read().writtenAt;

		clock.advance(SAMPLE);
		expect(read().writtenAt).toBe(first);
		clock.advance(WRITE - SAMPLE);
		expect(read().writtenAt).toBe(first + WRITE);

		clock.advance(SAMPLE);
		collector.recordExit({ providerId: "alpha", pid: CHILD, code: null, signal: "SIGABRT" });
		expect(read().writtenAt).toBe(clock.now());
	});

	it("leaves no temp file behind, and a file that always parses", () => {
		const { clock, paths, collector } = harness();
		clock.advance(WRITE * 3);
		collector.recordExit({ providerId: "alpha", pid: CHILD, code: 1, signal: null });

		expect(readdirSync(paths.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(readDiagnostics(paths.dir).state).toBe("present");
	});

	it("reports a write failure rather than throwing it into the daemon, and keeps sampling", () => {
		const root = scratch();
		writeFileSync(path.join(root, "blocker"), "");
		const { errors, clock, collector } = harness({
			file: path.join(root, "blocker", "diagnostics.json"),
			reportsDir: path.join(root, "reports"),
		});

		expect(errors).toHaveLength(1);
		// Nothing landed, so every sample retries rather than waiting out the rate limit.
		clock.advance(SAMPLE);
		expect(errors).toHaveLength(2);
		expect(collector.current().samples).toHaveLength(2);
	});

	it("leaves the previous file intact when a write fails midway", () => {
		const { paths, read, clock, errors, collector } = harness();
		clock.advance(SAMPLE);
		// A directory at the temp path makes the temp write itself fail.
		mkdirSync(`${paths.diagnosticsFile}.tmp`);
		collector.recordExit({ providerId: "alpha", pid: CHILD, code: 137, signal: null });

		expect(errors).toHaveLength(1);
		expect(read().incidents).toEqual([]);

		rmSync(`${paths.diagnosticsFile}.tmp`, { recursive: true });
		collector.flush();
		expect(read().incidents.map((incident) => incident.code)).toEqual([137]);
	});

	it("reports a failing sample source rather than throwing it into the daemon's timer", () => {
		let broken = true;
		const { errors, clock, collector } = harness({
			context: () => {
				if (broken) throw new Error("store closed");
				return { index: { state: "ready", done: 1, total: 1 }, inFlight: 0, connections: 0 };
			},
		});

		expect(errors).toHaveLength(1);
		expect(collector.current().samples).toEqual([]);
		broken = false;
		clock.advance(SAMPLE);
		expect(collector.current().samples).toHaveLength(1);
	});

	it("keeps writing when the clock steps backwards", () => {
		const { read, collector } = harness({ clock: { ...fakeClock(), now: () => clockValue } });
		const first = read().writtenAt;
		clockValue = first - 3_600_000;
		collector.sample();

		expect(read().writtenAt).toBe(clockValue);
	});

	it("prunes node's reports on every write, not only when asked", () => {
		const { paths, collector } = harness();
		mkdirSync(paths.reportsDir, { recursive: true });
		for (let n = 0; n < 10; n++)
			writeFileSync(path.join(paths.reportsDir, `report.2026082${n}.1.1.0.001.json`), "{}");
		collector.flush();

		expect(readdirSync(paths.reportsDir)).toHaveLength(8);
	});

	it("stops with a final sample and then goes silent", () => {
		const { clock, read, collector } = harness();
		clock.advance(SAMPLE);
		collector.stop();

		const written = read();
		expect(written.samples).toHaveLength(3);
		expect(written.writtenAt).toBe(clock.now());
		clock.advance(WRITE * 4);
		expect(collector.current().samples).toHaveLength(3);
		expect(clock.pending()).toBe(0);
	});
});

describe("what the collection keeps", () => {
	it("keeps the newest samples and drops the oldest, so uptime cannot grow it", () => {
		const { clock, collector } = harness();
		const first = collector.current().samples[0]?.at ?? 0;
		clock.advance(SAMPLE * (SAMPLE_RING + 40));

		const samples = collector.current().samples;
		expect(samples).toHaveLength(SAMPLE_RING);
		expect(samples[0]?.at).toBe(first + SAMPLE * 41);
		expect(samples.at(-1)?.at).toBe(clock.now());
	});

	it("keeps the newest incidents", () => {
		const { collector } = harness();
		for (let n = 1; n <= INCIDENT_RING + 5; n++) {
			collector.recordExit({ providerId: "alpha", pid: CHILD, code: n, signal: null });
		}

		const incidents = collector.current().incidents;
		expect(incidents).toHaveLength(INCIDENT_RING);
		expect(incidents[0]?.code).toBe(6);
		expect(incidents.at(-1)?.code).toBe(INCIDENT_RING + 5);
	});

	it("keeps a peak after the sample that set it has been rung out", () => {
		const { clock, memory, collector } = harness();
		memory.set(CHILD, { rss: 5000, hwm: 5000 });
		clock.advance(SAMPLE);
		const when = clock.now();
		memory.set(CHILD, { rss: 1000, hwm: 5000 });
		clock.advance(SAMPLE * (SAMPLE_RING + 10));

		expect(collector.current().samples.some((s) => s.processes.some((p) => p.rss === 5000))).toBe(false);
		expect(collector.current().peaks).toContainEqual({ role: "provider:alpha", pid: CHILD, rss: 5000, at: when });
	});

	it("records what the daemon was doing and the provider's last size in an incident", () => {
		const { clock, state, memory, collector } = harness();
		state.context = { index: { state: "warming", done: 5, total: 100 }, inFlight: 2, connections: 3 };
		memory.set(CHILD, { rss: 3_500_000_000, hwm: 3_600_000_000 });
		clock.advance(SAMPLE);
		collector.recordExit({ providerId: "alpha", pid: CHILD, code: null, signal: "SIGABRT" });

		expect(collector.current().incidents).toEqual([
			{
				at: clock.now(),
				role: "provider:alpha",
				pid: CHILD,
				code: null,
				signal: "SIGABRT",
				rss: 3_500_000_000,
				context: { index: { state: "warming", done: 5, total: 100 }, inFlight: 2, connections: 3 },
			},
		]);
	});

	it("says when procfs cannot be read rather than pretending zero", () => {
		const { collector } = harness({ readHost: () => null, readMemory: () => null });
		const written = collector.current();

		expect(written.host).toMatchObject({ sampler: "none", memTotal: null, memAvailable: null });
		expect(written.samples[0]?.processes).toEqual([
			expect.objectContaining({ role: "daemon", rss: 100, hwm: null }),
			{ role: "provider:alpha", pid: CHILD, rss: null, hwm: null },
		]);
		expect(written.peaks.map((p) => p.role)).toEqual(["daemon"]);
	});

	it("never writes a report where procfs cannot say what the host has", () => {
		const { clock, state, selfReports, collector } = harness({ readHost: () => null });
		state.self = { ...state.self, rss: HOST };
		clock.advance(SAMPLE);

		expect(collector.current().host).toMatchObject({ memTotal: null, sampler: "none" });
		expect(selfReports).toEqual([]);
	});
});

// The runtime states no heap limit; the host's memory is the one the OS enforces.
describe("writing a report near the host's memory", () => {
	it("uses and records the cgroup limit when it is lower than host memory", () => {
		const limit = HOST / 2;
		const { clock, state, selfReports, collector } = harness({
			readHost: () => ({
				memTotal: HOST,
				memAvailable: HOST / 2,
				memoryLimit: { bytes: limit, source: "cgroupV2" },
			}),
		});
		state.self = { ...state.self, rss: limit * 0.9 };
		clock.advance(SAMPLE);

		expect(selfReports).toEqual([SELF_REPORT]);
		expect(collector.current().host.memoryLimit).toEqual({ bytes: limit, source: "cgroupV2" });
	});

	it("writes its own report once above the high mark, and again only after its size has come down", () => {
		const { clock, state, selfReports } = harness();
		state.self = { ...state.self, rss: HOST * 0.9 };
		clock.advance(SAMPLE);
		clock.advance(SAMPLE);
		expect(selfReports).toEqual([SELF_REPORT]);

		state.self = { ...state.self, rss: HOST * 0.7 };
		clock.advance(SAMPLE);
		state.self = { ...state.self, rss: HOST * 0.9 };
		clock.advance(SAMPLE);
		expect(selfReports).toEqual([SELF_REPORT]);

		state.self = { ...state.self, rss: HOST * 0.5 };
		clock.advance(SAMPLE);
		state.self = { ...state.self, rss: HOST * 0.9 };
		clock.advance(SAMPLE);
		expect(selfReports).toEqual([SELF_REPORT, SELF_REPORT]);
	});

	it("writes at exactly the high mark, not only above it", () => {
		const { clock, state, selfReports } = harness();
		state.self = { ...state.self, rss: HOST * 0.85 };
		clock.advance(SAMPLE);

		expect(selfReports).toEqual([SELF_REPORT]);
	});

	it("judges by resident size, not by the heap, which the runtime lets grow past any figure it states", () => {
		const { clock, state, selfReports } = harness();
		state.self = { ...state.self, heapUsed: HOST * 0.9, heapTotal: HOST * 0.9 };
		clock.advance(SAMPLE * 3);

		expect(selfReports).toEqual([]);
	});

	it("judges a child by nothing: its size never triggers a report, and it is never signalled", () => {
		const { clock, memory, selfReports, snapshots, errors } = harness();
		memory.set(CHILD, { rss: HOST * 0.9, hwm: HOST * 0.9 });
		clock.advance(SAMPLE * 3);

		expect(selfReports).toEqual([]);
		expect(snapshots).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("adds a heap snapshot only when the environment asks", () => {
		const asked = harness({ env: { [HEAP_SNAPSHOT_ENV]: "1" } });
		asked.state.self = { ...asked.state.self, rss: HOST * 0.9 };
		asked.clock.advance(SAMPLE);
		expect(asked.snapshots).toEqual([`${asked.paths.reportsDir}:${asked.clock.now()}`]);

		const quiet = harness();
		quiet.state.self = { ...quiet.state.self, rss: HOST * 0.9 };
		quiet.clock.advance(SAMPLE);
		expect(quiet.snapshots).toEqual([]);
	});

	it("writes a report the listing renders, in a crash report's shape", () => {
		const { clock, state, paths } = harness({}, { realReports: true });
		state.self = { ...state.self, rss: HOST * 0.9 };
		clock.advance(SAMPLE);

		expect(listReports(paths.dir)).toEqual([
			{
				kind: "report",
				file: path.join(paths.reportsDir, SELF_REPORT),
				at: clock.now(),
				event: "high-water",
				trigger: "rss",
				pid: DAEMON,
				heapUsed: 50,
				heapLimit: null,
				rss: HOST * 0.9,
				hostTotal: HOST,
			},
		]);
	});

	it("reports a writer that fails, once, and stays latched rather than retrying", () => {
		const { clock, state, errors } = harness({
			writeSelfReport: () => {
				throw new Error("disk full");
			},
		});
		state.self = { ...state.self, rss: HOST * 0.9 };
		clock.advance(SAMPLE * 3);

		expect(errors).toHaveLength(1);
	});
});

describe("fed by a real supervisor", () => {
	// The two halves each pass alone; this is the seam between them.
	it("turns a provider's death into an incident carrying its signal and last size", async () => {
		const supervisor = new ProviderSupervisor();
		try {
			await supervisor.start({ command: [process.execPath, "run", REFERENCE], timeoutMs: 25_000 }, tmpdir());
			const pid = supervisor.pidOf("reference-provider") as number;
			const { collector } = harness({
				processes: () => [{ role: "provider:reference-provider", pid }],
				readMemory: processMemory,
			});
			supervisor.observeExits((exit) => collector.recordExit(exit));

			process.kill(pid, "SIGKILL");
			const deadline = Date.now() + 10_000;
			while (collector.current().incidents.length === 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}

			const [incident] = collector.current().incidents;
			expect(incident).toMatchObject({ role: "provider:reference-provider", pid, code: null, signal: "SIGKILL" });
			if (process.platform === "linux") expect(incident?.rss).toBeGreaterThan(0);
		} finally {
			supervisor.stopAll();
		}
	}, 30_000);
});

describe("reading the collection back", () => {
	it("answers absent, unreadable and present, each honestly", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		const paths = storePaths(path.join(stateRoot(host), KEY));

		expect(readDiagnostics(paths.dir)).toEqual({ state: "absent", file: paths.diagnosticsFile });

		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.diagnosticsFile, "{ not json");
		expect(readDiagnostics(paths.dir)).toMatchObject({ state: "unreadable", file: paths.diagnosticsFile });

		writeFileSync(paths.diagnosticsFile, JSON.stringify({ version: 2 }));
		expect(readDiagnostics(paths.dir)).toMatchObject({ state: "unreadable" });
	});

	it("round-trips what the collector wrote", () => {
		const { paths, collector } = harness();
		collector.recordExit({ providerId: "alpha", pid: CHILD, code: 134, signal: null });

		const back = readDiagnostics(paths.dir);
		expect(back.state).toBe("present");
		if (back.state !== "present") return;
		expect({ ...back.data, writtenAt: 0 }).toEqual({ ...collector.current(), writtenAt: 0 });
	});

	it("tells a file it may not read apart from one that is not there", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		const paths = storePaths(path.join(stateRoot(host), KEY));
		mkdirSync(paths.diagnosticsFile, { recursive: true });

		expect(readDiagnostics(paths.dir).state).toBe("unreadable");
	});
});

describe("listing node's reports", () => {
	it("reads each report's header, sizes a snapshot, and names a file it cannot parse", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		const store = path.join(stateRoot(host), KEY);
		const dir = storePaths(store).reportsDir;
		mkdirSync(dir, { recursive: true });
		const report = {
			header: { event: "SIGUSR2", trigger: "Signal", processId: 77, dumpEventTimeStamp: "1787360823480" },
			javascriptHeap: { usedMemory: 4_057_720, memoryLimit: LIMIT },
		};
		writeFileSync(path.join(dir, "report.20260821.180703.77.0.001.json"), JSON.stringify(report));
		writeFileSync(path.join(dir, "report.20260821.180800.78.0.001.json"), "{ not json");
		writeFileSync(path.join(dir, "report.20260821.180900.79.0.001.json"), "null");
		mkdirSync(path.join(dir, "report.20260821.181000.80.0.001.json"));
		const self = { header: { event: "JavaScript API", trigger: "JavaScript API", processId: 7 } };
		writeFileSync(path.join(dir, SELF_REPORT), JSON.stringify(self));
		writeFileSync(path.join(dir, "Heap.20260821.180900.77.0.001.heapsnapshot"), "x".repeat(2048));
		mkdirSync(path.join(dir, "Heap.20260821.181000.77.0.001.heapsnapshot"));
		writeFileSync(path.join(dir, "notes.txt"), "ignored");

		expect(listReports(store)).toEqual([
			{
				kind: "unreadable",
				file: path.join(dir, "report.20260821.181000.80.0.001.json"),
				reason: expect.any(String),
			},
			{
				kind: "unreadable",
				file: path.join(dir, "report.20260821.180900.79.0.001.json"),
				reason: "no report header",
			},
			{
				kind: "unreadable",
				file: path.join(dir, "report.20260821.180800.78.0.001.json"),
				reason: expect.any(String),
			},
			{
				kind: "report",
				file: path.join(dir, "report.20260821.180703.77.0.001.json"),
				at: 1787360823480,
				event: "SIGUSR2",
				trigger: "Signal",
				pid: 77,
				heapUsed: 4_057_720,
				heapLimit: LIMIT,
				rss: null,
				hostTotal: null,
			},
			{
				kind: "report",
				file: path.join(dir, SELF_REPORT),
				at: null,
				event: "JavaScript API",
				trigger: "JavaScript API",
				pid: 7,
				heapUsed: null,
				heapLimit: null,
				rss: null,
				hostTotal: null,
			},
			{
				kind: "unreadable",
				file: path.join(dir, "Heap.20260821.181000.77.0.001.heapsnapshot"),
				reason: "not a regular file",
			},
			{ kind: "snapshot", file: path.join(dir, "Heap.20260821.180900.77.0.001.heapsnapshot"), bytes: 2048 },
		]);
	});

	// A link wearing a report's name reaches whatever it points at; a report is a regular file or nothing.
	it("refuses a link wearing a report's name, or the collection's, rather than following it", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		const paths = storePaths(path.join(stateRoot(host), KEY));
		mkdirSync(paths.reportsDir, { recursive: true });
		const outside = path.join(root, "outside.json");
		writeFileSync(outside, JSON.stringify({ header: { event: "OUTSIDE", trigger: "x", processId: 99 } }));
		symlinkSync(outside, path.join(paths.reportsDir, "report.20260821.180703.77.0.001.json"));
		symlinkSync(outside, paths.diagnosticsFile);

		expect(listReports(paths.dir)).toEqual([
			{
				kind: "unreadable",
				file: path.join(paths.reportsDir, "report.20260821.180703.77.0.001.json"),
				reason: "not a regular file",
			},
		]);
		expect(readDiagnostics(paths.dir)).toMatchObject({ state: "unreadable", reason: "not a regular file" });
	});

	it("refuses a link wearing the reports directory's name too", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		const paths = storePaths(path.join(stateRoot(host), KEY));
		const elsewhere = path.join(root, "elsewhere");
		mkdirSync(elsewhere);
		mkdirSync(paths.dir, { recursive: true });
		symlinkSync(elsewhere, paths.reportsDir);

		expect(listReports(paths.dir)).toEqual([
			{ kind: "unreadable", file: paths.reportsDir, reason: "not a directory" },
		]);
	});

	it("answers nothing for a store with no reports directory, and says so for one it may not read", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		const store = path.join(stateRoot(host), KEY);
		expect(listReports(store)).toEqual([]);

		if (process.platform === "win32" || process.getuid?.() === 0) return;
		const dir = storePaths(store).reportsDir;
		mkdirSync(path.dirname(dir), { recursive: true });
		mkdirSync(dir, { mode: 0o000 });
		try {
			expect(listReports(store)).toEqual([
				{ kind: "unreadable", file: dir, reason: expect.stringMatching(/EACCES/) },
			]);
		} finally {
			chmodSync(dir, 0o700);
		}
	});
});

describe("the reports directory", () => {
	it("prunes to the newest few, leaving the self report alone", () => {
		const dir = path.join(scratch(), "reports");
		mkdirSync(dir);
		const names = Array.from({ length: 10 }, (_, n) => `report.20260821.18070${n}.1.0.001.json`);
		for (const name of names) writeFileSync(path.join(dir, name), "{}");
		writeFileSync(path.join(dir, SELF_REPORT), "{}");

		expect(pruneReports(dir).sort()).toEqual(names.slice(0, 2));
		expect(readdirSync(dir).sort()).toEqual([SELF_REPORT, ...names.slice(2)].sort());
	});

	// Each is gigabytes, so the directory stays bounded with the opt-in on as well.
	it("keeps only the newest two heap snapshots", () => {
		const dir = path.join(scratch(), "reports");
		mkdirSync(dir);
		const names = Array.from({ length: 4 }, (_, n) => `Heap.2026082${n}.180700.1.0.001.heapsnapshot`);
		for (const name of names) writeFileSync(path.join(dir, name), "");

		expect(pruneReports(dir).sort()).toEqual(names.slice(0, 2));
		expect(readdirSync(dir).sort()).toEqual(names.slice(2));
	});

	it("answers nothing for a directory that is not there", () => {
		expect(pruneReports(path.join(scratch(), "missing"))).toEqual([]);
	});

	it("makes the reports directory readable by its owner alone, even one that already existed wider", () => {
		const dir = path.join(scratch(), "reports");
		mkdirSync(dir, { mode: 0o755 });
		makeReportsDir(dir);

		expect(existsSync(dir)).toBe(true);
		if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	// A daemon dying before its collector's first write leaves a report per death.
	it("prunes when the directory is made, before any collector has written", () => {
		const dir = path.join(scratch(), "reports");
		mkdirSync(dir);
		for (let n = 0; n < 12; n++) writeFileSync(path.join(dir, `report.202608${10 + n}.1.1.0.001.json`), "{}");
		makeReportsDir(dir);

		expect(readdirSync(dir)).toHaveLength(8);
	});

	it("reads the heap snapshot opt-in from the environment", () => {
		expect(heapSnapshotWanted({ [HEAP_SNAPSHOT_ENV]: "1" })).toBe(true);
		expect(heapSnapshotWanted({ [HEAP_SNAPSHOT_ENV]: "0" })).toBe(false);
		expect(heapSnapshotWanted({ [HEAP_SNAPSHOT_ENV]: "" })).toBe(false);
		expect(heapSnapshotWanted({})).toBe(false);
	});

	it("writes a heap snapshot from the runtime under the name pruning and listing know", () => {
		const dir = path.join(scratch(), "reports");
		mkdirSync(dir);
		writeHeapSnapshot(dir, 1787360823480);

		const [name] = readdirSync(dir);
		expect(name).toMatch(/^Heap\.1787360823480\.\d+\.heapsnapshot$/);
		expect(statSync(path.join(dir, name as string)).size).toBeGreaterThan(0);
		expect(listReports(path.dirname(dir)).map((report) => report.kind)).toEqual(["snapshot"]);
	});
});

describe("collections older daemons wrote", () => {
	it("reads a version 1 file as the current shape", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		const paths = storePaths(path.join(stateRoot(host), KEY));
		mkdirSync(paths.dir, { recursive: true });
		const legacy = {
			version: 1,
			writtenAt: 5,
			workspaceRoot: "/w",
			daemon: { pid: DAEMON, version: "2.2.0", startedAt: 1 },
			host: {
				nodeHeapLimit: LIMIT,
				memTotal: 32e9,
				memAvailable: 16e9,
				sampler: "procfs",
				signal: "SIGUSR2",
				reportsExcludeEnv: true,
			},
			peaks: [],
			incidents: [],
			samples: [],
		};
		writeFileSync(paths.diagnosticsFile, JSON.stringify(legacy));

		expect(readDiagnostics(paths.dir)).toMatchObject({
			state: "present",
			data: { version: 2, host: { runtime: "node", sampler: "procfs", memTotal: 32e9 } },
		});
	});
});

describe("a write killed between temp and rename", () => {
	it("leaves a temp file the next prune removes, and nothing else is touched", () => {
		const dir = path.join(scratch(), "reports");
		mkdirSync(dir);
		writeFileSync(path.join(dir, `${SELF_REPORT}.tmp`), "");
		writeFileSync(path.join(dir, "Heap.1.7.heapsnapshot.tmp"), "");
		writeFileSync(path.join(dir, "notes.tmp"), "");

		expect(pruneReports(dir).sort()).toEqual(["Heap.1.7.heapsnapshot.tmp", `${SELF_REPORT}.tmp`]);
		expect(readdirSync(dir)).toEqual(["notes.tmp"]);
	});
});
