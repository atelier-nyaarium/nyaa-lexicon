import { describe, expect, it } from "bun:test";
import { DaemonError, type DaemonLock } from "@nyaa-lexicon/client";
import type { Diagnostics, ProjectStore, ReportSummary } from "@nyaa-lexicon/core";
import {
	deleteProjectStoreTool,
	listProjectStoresTool,
	type ManageDeps,
	projectDiagnosticsTool,
	stopProjectDaemonTool,
} from "../manage";

////////////////////////////////
//  Helpers

const NOW = 1_700_000_000_000;

const LOCK: DaemonLock = {
	port: 42_000,
	token: "a".repeat(32),
	pid: 4242,
	protocolVersion: "1.4.0",
	workspaceRoot: "/home/dev/proj",
	startedAt: NOW,
};

const DIRECTORY = "/state/proj-abc123";
const CUSTOM = "/home/dev/proj/.refs-store";

function store(overrides: Partial<ProjectStore> = {}): ProjectStore {
	return {
		key: "proj-abc123",
		directory: DIRECTORY,
		custom: false,
		workspaceRoot: "/home/dev/proj",
		workspace: "present",
		bytes: 5 * 1024 * 1024,
		modifiedAt: NOW,
		lastIndexedAt: NOW,
		livePid: null,
		...overrides,
	};
}

/** The same workspace's store in a directory it chose. */
function customStore(overrides: Partial<ProjectStore> = {}): ProjectStore {
	return store({ directory: CUSTOM, custom: true, ...overrides });
}

const FILE = "/state/proj-abc123/diagnostics.json";

function deps(stores: ProjectStore[], remove?: ManageDeps["remove"], overrides: Partial<ManageDeps> = {}): ManageDeps {
	return {
		list: () => stores,
		remove: remove ?? (() => ({ deleted: false, reason: "not wired" })),
		lock: () => LOCK,
		stop: async () => {},
		gone: () => true,
		diagnostics: () => ({ state: "absent", file: FILE }),
		reports: () => [],
		...overrides,
	};
}

const LIMIT = 4_000_000_000;

const CONTEXT = { index: { state: "warming", done: 5, total: 100 }, inFlight: 2, connections: 3 };

/** One death, one near-limit peak. */
function collection(overrides: Partial<Diagnostics> = {}): Diagnostics {
	const context = CONTEXT;
	const row = (role: string, pid: number, rss: number) => ({ role, pid, rss, hwm: rss });
	return {
		version: 2,
		writtenAt: NOW - 20_000,
		workspaceRoot: "/home/dev/proj",
		daemon: { pid: 4242, version: "2.1.0", startedAt: NOW - 3_600_000 },
		host: { runtime: "bun", memTotal: 32e9, memAvailable: 16e9, sampler: "procfs" },
		peaks: [
			{ role: "daemon", pid: 4242, rss: 90e6, at: NOW - 60_000 },
			{ role: "provider:alpha", pid: 77, rss: 3.6e9, at: NOW - 30_000 },
		],
		incidents: [
			{ at: NOW - 25_000, role: "provider:alpha", pid: 77, code: null, signal: "SIGABRT", rss: 3.6e9, context },
		],
		samples: [
			{ at: NOW - 40_000, context, processes: [row("daemon", 4242, 80e6), row("provider:alpha", 77, 3.0e9)] },
			{ at: NOW - 30_000, context, processes: [row("daemon", 4242, 90e6), row("provider:alpha", 77, 3.6e9)] },
		],
		...overrides,
	};
}

const REPORT: ReportSummary = {
	kind: "report",
	file: "/state/proj-abc123/reports/report.20260821.180700.77.0.001.json",
	at: NOW - 25_000,
	event: "Allocation failed - JavaScript heap out of memory",
	trigger: "OOMError",
	pid: 77,
	heapUsed: 3.9e9,
	heapLimit: LIMIT,
	rss: null,
	hostTotal: null,
};

////////////////////////////////
//  Tests

describe("naming a store", () => {
	// The listing is the only source of paths: a reference either matches a row exactly or names
	// nothing, and a directory is never joined from what was typed.
	it("resolves a default store by key or directory, a custom one by directory alone", () => {
		let removed: ProjectStore[] = [];
		const remove = (target: ProjectStore) => {
			removed.push(target);
			return { deleted: true as const, key: target.key, directory: target.directory, bytes: 0 };
		};
		const both = deps([store(), customStore()], remove);

		expect(deleteProjectStoreTool(both, { store: "proj-abc123" }).isError).toBeUndefined();
		expect(deleteProjectStoreTool(both, { store: DIRECTORY }).isError).toBeUndefined();
		expect(deleteProjectStoreTool(both, { store: CUSTOM }).isError).toBeUndefined();
		expect(removed.map((target) => target.directory)).toEqual([DIRECTORY, DIRECTORY, CUSTOM]);

		removed = [];
		const onlyCustom = deps([customStore()], remove);
		expect(deleteProjectStoreTool(onlyCustom, { store: "proj-abc123" }).isError).toBe(true);
		expect(removed).toEqual([]);
	});

	it("refuses a reference matching no row, naming what was typed", () => {
		const result = projectDiagnosticsTool(deps([store()]), { store: "/state/elsewhere" });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("/state/elsewhere");
		expect(projectDiagnosticsTool(deps([store()]), { store: "ghost" }).content[0]?.text).toContain("ghost");
	});

	it("refuses a reference that is neither a key nor a directory before looking anything up", () => {
		let listed = false;
		const result = projectDiagnosticsTool(
			deps([store()], undefined, {
				list: () => {
					listed = true;
					return [store()];
				},
			}),
			{ store: "proj\n# injected `key`" },
		);

		expect(result.isError).toBe(true);
		expect(listed).toBe(false);
		expect(result.content[0]?.text).not.toContain("\n# injected");
	});
});

describe("listing stores", () => {
	it("shows every row's directory, and says which directories were the project's choice", () => {
		const body = listProjectStoresTool(deps([store(), customStore()]), NOW).content[0]?.text ?? "";

		expect(body).toContain(`- Directory: ${DIRECTORY}`);
		expect(body).toContain(`- Directory: ${CUSTOM}`);
		expect(body.match(/custom/g)).toHaveLength(1);
	});
});

describe("deleting a project store", () => {
	// A refusal that reads as success is how a user believes they reclaimed space they still owe.
	it("surfaces a refusal as an error rather than as a done deal", () => {
		const result = deleteProjectStoreTool(
			deps([store()], () => ({ deleted: false, reason: "pid 7 is serving it right now" })),
			{ store: "proj-abc123" },
		);

		expect(result.isError).toBe(true);
	});
});

describe("reading a store's diagnostics", () => {
	it("reads from the directory the listing showed", () => {
		const asked: string[] = [];
		const result = projectDiagnosticsTool(
			deps([customStore()], undefined, {
				diagnostics: (directory) => {
					asked.push(directory);
					return { state: "absent", file: `${directory}/diagnostics.json` };
				},
			}),
			{ store: CUSTOM },
		);

		expect(result.isError).toBeUndefined();
		expect(asked).toEqual([CUSTOM]);
	});

	// Absent is the normal state of a store no new daemon has served, not a failure.
	it("says there is nothing yet, without erroring, when no daemon has written one", () => {
		const result = projectDiagnosticsTool(deps([store()]), { store: "proj-abc123" });

		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain(FILE);
	});

	it("errors on a file it cannot read, naming it", () => {
		const result = projectDiagnosticsTool(
			deps([store()], undefined, { diagnostics: () => ({ state: "unreadable", file: FILE, reason: "EACCES" }) }),
			{ store: "proj-abc123" },
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("EACCES");
	});

	it("names the process that peaked, how close to the limit, and what it died of while the daemon did what", () => {
		const result = projectDiagnosticsTool(
			deps([store()], undefined, { diagnostics: () => ({ state: "present", file: FILE, data: collection() }) }),
			{ store: "proj-abc123" },
			NOW,
		);
		const body = result.content[0]?.text ?? "";

		expect(result.isError).toBeUndefined();
		expect(body).toMatch(/provider:alpha: \S+ \(11% of host memory\) 30s ago/);
		expect(body.indexOf("- provider:alpha:")).toBeLessThan(body.indexOf("- daemon:"));
		expect(body).toMatch(
			/provider:alpha pid 77 died on SIGABRT at \S+; index warming 5\/100, 2 in flight, 3 connected/,
		);
		expect(body).toMatch(/provider:alpha: 2\.79GB to 3\.35GB/);
		expect(body).toContain(`Raw: ${FILE}`);
	});

	it("lists the newest reports and counts the rest, rather than dumping a directory someone filled", () => {
		const many = Array.from({ length: 25 }, (_, n) => ({ ...REPORT, file: `/r/report.${100 - n}.json` }));
		const body =
			projectDiagnosticsTool(
				deps([store()], undefined, {
					diagnostics: () => ({ state: "present", file: FILE, data: collection() }),
					reports: () => many,
				}),
				{ store: "proj-abc123" },
				NOW,
			).content[0]?.text ?? "";

		expect(body.match(/^- report\./gm)).toHaveLength(20);
		expect(body).toContain("and 5 older, not listed");
	});

	it("lists incidents newest first", () => {
		const older = {
			at: NOW - 90_000,
			role: "provider:beta",
			pid: 8,
			code: 1,
			signal: null,
			rss: null,
			context: null,
		};
		const newer = {
			at: NOW - 10_000,
			role: "provider:alpha",
			pid: 9,
			code: null,
			signal: "SIGKILL",
			rss: null,
			context: null,
		};
		const body =
			projectDiagnosticsTool(
				deps([store()], undefined, {
					diagnostics: () => ({
						state: "present",
						file: FILE,
						data: collection({ incidents: [older, newer] }),
					}),
				}),
				{ store: "proj-abc123" },
				NOW,
			).content[0]?.text ?? "";

		expect(body.indexOf("provider:alpha pid 9")).toBeLessThan(body.indexOf("provider:beta pid 8"));
	});

	// The owner's first question was what was retained; a report cannot say, and the tool must not imply it can.
	it("says that what a process retained needs the opt-in snapshot, until one is present", () => {
		const present = { state: "present" as const, file: FILE, data: collection() };
		const without = projectDiagnosticsTool(deps([store()], undefined, { diagnostics: () => present }), {
			store: "proj-abc123",
		}).content[0]?.text;
		const withSnapshot = projectDiagnosticsTool(
			deps([store()], undefined, {
				diagnostics: () => present,
				reports: () => [{ kind: "snapshot", file: "/r/Heap.z.heapsnapshot", bytes: 1024 }],
			}),
			{ store: "proj-abc123" },
		).content[0]?.text;

		expect(without).toContain("LEXICON_HEAP_SNAPSHOT=1");
		expect(withSnapshot).not.toContain("LEXICON_HEAP_SNAPSHOT=1");
	});

	it("renders what it does not know as unknown, rather than throwing or inventing", () => {
		const data = collection({
			host: { ...collection().host, memTotal: null, memAvailable: null },
			daemon: { pid: 1, version: "2.1.0", startedAt: NOW + 60_000 },
			peaks: [{ role: "provider:alpha", pid: 77, rss: 0, at: NOW }],
			incidents: [
				{ at: NOW, role: "provider:alpha", pid: null, code: 1, signal: null, rss: null, context: null },
			],
			samples: [
				{ at: NOW, context: CONTEXT, processes: [{ role: "provider:alpha", pid: 77, rss: null, hwm: null }] },
			],
		});
		const reports: ReportSummary[] = [
			{
				kind: "report",
				file: "/r/report.x.json",
				at: null,
				event: "unknown",
				trigger: "unknown",
				pid: null,
				heapUsed: null,
				heapLimit: null,
				rss: null,
				hostTotal: null,
			},
			{ kind: "unreadable", file: "/r/report.y.json", reason: "EACCES" },
			{ kind: "snapshot", file: "/r/Heap.z.heapsnapshot", bytes: 3 * 1024 * 1024 * 1024 },
		];
		const body =
			projectDiagnosticsTool(
				deps([store()], undefined, {
					diagnostics: () => ({ state: "present", file: FILE, data }),
					reports: () => reports,
				}),
				{ store: "proj-abc123" },
				NOW,
			).content[0]?.text ?? "";

		expect(body).toContain("host memory unknown");
		expect(body).toContain("started in the future");
		expect(body).toMatch(/provider:alpha: 0B \(host memory unknown\)/);
		expect(body).not.toContain("%");
		expect(body).toMatch(/pid \? exited with code 1; before any sample/);
		expect(body).toContain("memory unknown");
		expect(body).toContain("unreadable (EACCES)");
		expect(body).toMatch(/heap snapshot, 3\.00GB/);
	});

	it("lists each report with its trigger and heap, and says plainly when there are none", () => {
		const present = { state: "present" as const, file: FILE, data: collection() };
		const withReport = projectDiagnosticsTool(
			deps([store()], undefined, { diagnostics: () => present, reports: () => [REPORT] }),
			{ store: "proj-abc123" },
			NOW,
		).content[0]?.text;
		const without = projectDiagnosticsTool(deps([store()], undefined, { diagnostics: () => present }), {
			store: "proj-abc123",
		}).content[0]?.text;

		expect(withReport).toMatch(
			/report\.20260821\.180700\.77\.0\.001\.json: .*\(OOMError\), pid 77, heap \S+ of \S+/,
		);
		expect(without).toMatch(/## Reports\n\nNone\./);
	});

	it("renders an empty collection without inventing rows", () => {
		const empty = collection({ peaks: [], incidents: [], samples: [] });
		const body = projectDiagnosticsTool(
			deps([store()], undefined, { diagnostics: () => ({ state: "present", file: FILE, data: empty }) }),
			{ store: "proj-abc123" },
			NOW,
		).content[0]?.text;

		expect(body).toContain("None yet.");
		expect(body).toContain("None recorded.");
	});
});

describe("stopping a project daemon", () => {
	it("succeeds when no daemon is running", async () => {
		const result = await stopProjectDaemonTool(deps([store()]), () => [], { store: "proj-abc123" });

		expect(result.isError).toBeUndefined();
	});

	it("rejects an unknown key", async () => {
		const result = await stopProjectDaemonTool(deps([store()]), () => [], { store: "missing" });

		expect(result.isError).toBe(true);
	});

	// A binding names a store, not a workspace: the same key bound in another directory is no
	// reason to keep this daemon up.
	it("refuses a daemon bound in this session, and only that one", async () => {
		let called = false;
		const live = deps([store({ livePid: 4242 }), customStore({ livePid: 4343 })], undefined, {
			stop: async () => {
				called = true;
			},
		});

		const refused = await stopProjectDaemonTool(live, () => [{ key: "proj-abc123" }], { store: "proj-abc123" });
		expect(refused.isError).toBe(true);
		const refusedCustom = await stopProjectDaemonTool(live, () => [{ key: "proj-abc123", stateDir: CUSTOM }], {
			store: CUSTOM,
		});
		expect(refusedCustom.isError).toBe(true);
		expect(called).toBe(false);

		const stopped = await stopProjectDaemonTool(live, () => [{ key: "proj-abc123", stateDir: CUSTOM }], {
			store: "proj-abc123",
		});
		expect(stopped.isError).toBeUndefined();
		expect(called).toBe(true);
	});

	it("stops through the store the listing named and the lock found for it", async () => {
		const asked: Array<[ProjectStore, DaemonLock]> = [];
		const live = customStore({ livePid: 4242 });
		const result = await stopProjectDaemonTool(
			deps([live], undefined, {
				stop: async (target, lock) => {
					asked.push([target, lock]);
				},
			}),
			() => [],
			{ store: CUSTOM },
		);

		expect(result.isError).toBeUndefined();
		expect(asked).toEqual([[live, LOCK]]);
	});

	// A lock still naming the daemon after the wait is the one failure the ask cannot hide.
	it("reports a daemon that would not stop, in the client's words", async () => {
		const result = await stopProjectDaemonTool(
			deps([store({ livePid: 4242 })], undefined, {
				stop: async () => {
					throw new DaemonError("pid 4242 was asked to stop but still holds /state/proj-abc123/daemon.json");
				},
			}),
			() => [],
			{ store: "proj-abc123" },
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("still holds");
	});
});
