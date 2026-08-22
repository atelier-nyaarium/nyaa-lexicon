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
import { afterEach, describe, expect, it } from "vitest";
import {
	type CollectorOptions,
	DiagnosticsSchema,
	HEAP_SNAPSHOT_ENV,
	heapSnapshotWanted,
	INCIDENT_RING,
	listReports,
	nodeReportSetup,
	pruneReports,
	readDiagnostics,
	SAMPLE_RING,
	type SampleContext,
	SELF_REPORT,
	startDiagnostics,
} from "../diagnostics";
import { type PlatformEnv, storePaths } from "../paths";
import { processMemory } from "../procfs";
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
const LIMIT = 4_000_000_000;
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

function harness(overrides: Partial<CollectorOptions> = {}) {
	const root = scratch();
	const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
	const paths = storePaths(host, KEY);
	const clock = fakeClock();
	const memory = new Map<number, { rss: number; hwm: number }>([[CHILD, { rss: 1000, hwm: 1000 }]]);
	const signals: number[] = [];
	const selfReports: string[] = [];
	const errors: string[] = [];
	const state = {
		self: { rss: 100, heapUsed: 50, heapTotal: 80, external: 5, arrayBuffers: 1, heapLimit: LIMIT },
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
		readHost: () => ({ memTotal: 32e9, memAvailable: 16e9 }),
		signal: (pid, signal) => {
			signals.push(pid);
			return signal === "SIGUSR2";
		},
		writeSelfReport: (name) => {
			selfReports.push(name);
		},
		platform: "linux",
		reportsExcludeEnv: true,
		sampleMs: SAMPLE,
		writeMs: WRITE,
		...overrides,
	};
	const collector = startDiagnostics(options);
	const read = () => DiagnosticsSchema.parse(JSON.parse(readFileSync(paths.diagnosticsFile, "utf8")));
	return { root, host, paths, clock, memory, signals, selfReports, errors, state, collector, read };
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
		expect(written.host).toMatchObject({
			nodeHeapLimit: LIMIT,
			sampler: "procfs",
			signal: "SIGUSR2",
			reportsExcludeEnv: true,
		});
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
		expect(
			readDiagnostics(KEY, {
				platform: "linux",
				env: { XDG_STATE_HOME: paths.dir.split("/nyaa-lexicon/")[0] },
				home: "/",
			}).state,
		).toBe("present");
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

	it("records that the signal is unavailable off POSIX", () => {
		expect(harness({ platform: "win32" }).collector.current().host.signal).toBe("unavailable");
	});
});

describe("asking for a report near the limit", () => {
	it("asks a provider once above the high mark, and again only after it has come down", () => {
		const { clock, memory, signals } = harness();
		memory.set(CHILD, { rss: LIMIT * 0.9, hwm: LIMIT * 0.9 });
		clock.advance(SAMPLE);
		clock.advance(SAMPLE);
		expect(signals).toEqual([CHILD]);

		memory.set(CHILD, { rss: LIMIT * 0.7, hwm: LIMIT * 0.9 });
		clock.advance(SAMPLE);
		memory.set(CHILD, { rss: LIMIT * 0.9, hwm: LIMIT * 0.9 });
		clock.advance(SAMPLE);
		expect(signals).toEqual([CHILD]);

		memory.set(CHILD, { rss: LIMIT * 0.5, hwm: LIMIT * 0.9 });
		clock.advance(SAMPLE);
		memory.set(CHILD, { rss: LIMIT * 0.9, hwm: LIMIT * 0.9 });
		clock.advance(SAMPLE);
		expect(signals).toEqual([CHILD, CHILD]);
	});

	it("asks at exactly the high mark, not only above it", () => {
		const { clock, memory, signals } = harness();
		memory.set(CHILD, { rss: LIMIT * 0.85, hwm: LIMIT * 0.85 });
		clock.advance(SAMPLE);

		expect(signals).toEqual([CHILD]);
	});

	it("reports a signal that was not delivered, once, and stays latched rather than retrying", () => {
		const { clock, memory, errors, signals } = harness({
			signal: (pid) => {
				signals.push(pid);
				return false;
			},
		});
		memory.set(CHILD, { rss: LIMIT * 0.9, hwm: LIMIT * 0.9 });
		clock.advance(SAMPLE * 3);

		expect(signals).toEqual([CHILD]);
		expect(errors).toHaveLength(1);
	});

	it("writes its own report when the daemon's heap nears the limit, and signals nobody for it", () => {
		const { clock, state, signals, selfReports } = harness();
		state.self = { ...state.self, heapUsed: LIMIT * 0.9 };
		clock.advance(SAMPLE);
		clock.advance(SAMPLE);

		expect(selfReports).toEqual([SELF_REPORT]);
		expect(signals).toEqual([]);
	});

	it("re-arms a provider that died, so its replacement is judged afresh", () => {
		const { clock, memory, signals, collector } = harness();
		memory.set(CHILD, { rss: LIMIT * 0.9, hwm: LIMIT * 0.9 });
		clock.advance(SAMPLE);
		collector.recordExit({ providerId: "alpha", pid: CHILD, code: null, signal: "SIGABRT" });
		clock.advance(SAMPLE);

		expect(signals).toEqual([CHILD, CHILD]);
	});
});

describe("fed by a real supervisor", () => {
	// The two halves each pass alone; this is the seam between them.
	it("turns a provider's death into an incident carrying its signal and last size", async () => {
		const supervisor = new ProviderSupervisor();
		try {
			await supervisor.start({ command: ["bun", "run", REFERENCE], timeoutMs: 25_000 }, tmpdir());
			const pid = supervisor.pidOf("reference-provider") as number;
			const { collector } = harness({
				processes: () => [{ role: "provider:reference-provider", pid }],
				readMemory: processMemory,
				signal: (target, signal) => supervisor.signal(target, signal),
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
		const paths = storePaths(host, KEY);

		expect(readDiagnostics(KEY, host)).toEqual({ state: "absent", file: paths.diagnosticsFile });

		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.diagnosticsFile, "{ not json");
		expect(readDiagnostics(KEY, host)).toMatchObject({ state: "unreadable", file: paths.diagnosticsFile });

		writeFileSync(paths.diagnosticsFile, JSON.stringify({ version: 2 }));
		expect(readDiagnostics(KEY, host)).toMatchObject({ state: "unreadable" });
	});

	it("round-trips what the collector wrote", () => {
		const { host, collector } = harness();
		collector.recordExit({ providerId: "alpha", pid: CHILD, code: 134, signal: null });

		const back = readDiagnostics(KEY, host);
		expect(back.state).toBe("present");
		if (back.state !== "present") return;
		expect({ ...back.data, writtenAt: 0 }).toEqual({ ...collector.current(), writtenAt: 0 });
	});

	it("tells a file it may not read apart from one that is not there", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		const paths = storePaths(host, KEY);
		mkdirSync(paths.diagnosticsFile, { recursive: true });

		expect(readDiagnostics(KEY, host).state).toBe("unreadable");
	});
});

describe("listing node's reports", () => {
	it("reads each report's header, sizes a snapshot, and names a file it cannot parse", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		const dir = storePaths(host, KEY).reportsDir;
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

		expect(listReports(KEY, host)).toEqual([
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
		const paths = storePaths(host, KEY);
		mkdirSync(paths.reportsDir, { recursive: true });
		const outside = path.join(root, "outside.json");
		writeFileSync(outside, JSON.stringify({ header: { event: "OUTSIDE", trigger: "x", processId: 99 } }));
		symlinkSync(outside, path.join(paths.reportsDir, "report.20260821.180703.77.0.001.json"));
		symlinkSync(outside, paths.diagnosticsFile);

		expect(listReports(KEY, host)).toEqual([
			{
				kind: "unreadable",
				file: path.join(paths.reportsDir, "report.20260821.180703.77.0.001.json"),
				reason: "not a regular file",
			},
		]);
		expect(readDiagnostics(KEY, host)).toMatchObject({ state: "unreadable", reason: "not a regular file" });
	});

	it("refuses a link wearing the reports directory's name too", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		const paths = storePaths(host, KEY);
		const elsewhere = path.join(root, "elsewhere");
		mkdirSync(elsewhere);
		mkdirSync(paths.dir, { recursive: true });
		symlinkSync(elsewhere, paths.reportsDir);

		expect(listReports(KEY, host)).toEqual([
			{ kind: "unreadable", file: paths.reportsDir, reason: "not a directory" },
		]);
	});

	it("answers nothing for a store with no reports directory, and says so for one it may not read", () => {
		const root = scratch();
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: root }, home: root };
		expect(listReports(KEY, host)).toEqual([]);

		if (process.platform === "win32" || process.getuid?.() === 0) return;
		const dir = storePaths(host, KEY).reportsDir;
		mkdirSync(path.dirname(dir), { recursive: true });
		mkdirSync(dir, { mode: 0o000 });
		try {
			expect(listReports(KEY, host)).toEqual([
				{ kind: "unreadable", file: dir, reason: expect.stringMatching(/EACCES/) },
			]);
		} finally {
			chmodSync(dir, 0o700);
		}
	});
});

describe("node's own reports", () => {
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

	it("turns on the fatal and signal reports for a node child, and says which signal it then survives", () => {
		const dir = path.join(scratch(), "reports");
		const setup = nodeReportSetup(dir, { env: {}, platform: "linux" });

		expect(existsSync(dir)).toBe(true);
		expect(setup.argv).toContain("--report-on-fatalerror");
		expect(setup.argv).toContain(`--report-directory=${dir}`);
		expect(setup.argv).toContain("--report-on-signal");
		expect(setup.argv).toContain("--report-signal=SIGUSR2");
		expect(setup.handles).toEqual(["SIGUSR2"]);
		expect(setup.argv.some((flag) => flag.startsWith("--heapsnapshot"))).toBe(false);
	});

	// A report carries every environment variable, API keys included, unless told not to.
	it("keeps the environment out of reports where node can, and says so either way", () => {
		const dir = path.join(scratch(), "reports");
		const setup = nodeReportSetup(dir, { env: {}, platform: "linux" });
		const supported = "excludeEnv" in process.report;

		expect(setup.excludesEnv).toBe(supported);
		expect(setup.argv.includes("--report-exclude-env")).toBe(supported);
		expect(harness({ reportsExcludeEnv: false }).collector.current().host.reportsExcludeEnv).toBe(false);
	});

	it("makes the reports directory readable by its owner alone, even one that already existed wider", () => {
		const dir = path.join(scratch(), "reports");
		mkdirSync(dir, { mode: 0o755 });
		nodeReportSetup(dir, { env: {}, platform: "linux" });

		if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	// The LSP runs this outside any guard; a throw here would cost it the whole local index.
	it("answers empty argv and the reason, rather than throwing, when the directory cannot be made", () => {
		const root = scratch();
		writeFileSync(path.join(root, "blocker"), "");
		const setup = nodeReportSetup(path.join(root, "blocker", "reports"), { env: {}, platform: "linux" });

		expect(setup.argv).toEqual([]);
		expect(setup.handles).toEqual([]);
		expect(setup.failure).toBeDefined();
	});

	// A daemon dying before its collector's first write leaves a report per death.
	it("prunes at setup, before any collector has written", () => {
		const dir = path.join(scratch(), "reports");
		mkdirSync(dir);
		for (let n = 0; n < 12; n++) writeFileSync(path.join(dir, `report.202608${10 + n}.1.1.0.001.json`), "{}");
		nodeReportSetup(dir, { env: {}, platform: "linux" });

		expect(readdirSync(dir)).toHaveLength(8);
	});

	// Without the handler the default action is death, so the child must not be declared to survive it.
	it("leaves the signal off on Windows, and declares no handler there", () => {
		const setup = nodeReportSetup(path.join(scratch(), "reports"), { env: {}, platform: "win32" });
		expect(setup.argv).toContain("--report-on-fatalerror");
		expect(setup.argv.some((flag) => flag.includes("signal"))).toBe(false);
		expect(setup.handles).toEqual([]);
	});

	it("adds the heap snapshot only when asked by the environment", () => {
		const dir = path.join(scratch(), "reports");
		expect(nodeReportSetup(dir, { env: { [HEAP_SNAPSHOT_ENV]: "1" }, platform: "linux" }).argv).toContain(
			"--heapsnapshot-near-heap-limit=1",
		);
		expect(heapSnapshotWanted({ [HEAP_SNAPSHOT_ENV]: "0" })).toBe(false);
		expect(heapSnapshotWanted({ [HEAP_SNAPSHOT_ENV]: "" })).toBe(false);
		expect(heapSnapshotWanted({})).toBe(false);
	});
});
