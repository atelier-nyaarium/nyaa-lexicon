import type { DaemonLock, ProjectStore } from "@nyaa-lexicon/core";
import { describe, expect, it } from "vitest";
import { deleteProjectStoreTool, listProjectStoresTool, type ManageDeps, stopProjectDaemonTool } from "../manage";

////////////////////////////////
//  Helpers

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const LOCK: DaemonLock = {
	port: 42_000,
	token: "a".repeat(32),
	pid: 4242,
	protocolVersion: "1.4.0",
	workspaceRoot: "/home/dev/proj",
	startedAt: NOW,
};

function store(overrides: Partial<ProjectStore> = {}): ProjectStore {
	return {
		key: "proj-abc123",
		workspaceRoot: "/home/dev/proj",
		workspace: "present",
		bytes: 5 * 1024 * 1024,
		modifiedAt: NOW,
		livePid: null,
		...overrides,
	};
}

function deps(stores: ProjectStore[], remove?: ManageDeps["remove"], overrides: Partial<ManageDeps> = {}): ManageDeps {
	return {
		list: () => stores,
		remove: remove ?? (() => ({ deleted: false, reason: "not wired" })),
		lock: () => LOCK,
		shutdown: async () => ({ stopping: true }),
		gone: () => true,
		wait: async () => {},
		now: () => NOW,
		...overrides,
	};
}

function textOf(result: { content: Array<{ text: string }> }): string {
	return result.content.map((chunk) => chunk.text).join("\n");
}

////////////////////////////////
//  Tests

describe("listing project stores", () => {
	it("says so plainly when this machine holds nothing", () => {
		expect(textOf(listProjectStoresTool(deps([]), NOW))).toContain("no indexes");
	});

	it("gives each store its key, its workspace, its size and its age", () => {
		const shown = textOf(listProjectStoresTool(deps([store({ modifiedAt: NOW - 3 * DAY })]), NOW));

		expect(shown).toContain("proj-abc123");
		expect(shown).toContain("/home/dev/proj");
		expect(shown).toContain("5.0MB");
		expect(shown).toContain("3 days ago");
	});

	// The reason the whole listing exists: an index whose project is gone can never be useful
	// again, and a reader should not have to compare paths by eye to notice.
	it("calls out a store whose workspace is gone, and totals what they hold", () => {
		const shown = textOf(
			listProjectStoresTool(
				deps([
					store({ key: "live-1", workspace: "present" }),
					store({ key: "dead-1", workspace: "missing", bytes: 2 * 1024 * 1024 }),
					store({ key: "dead-2", workspace: "missing", bytes: 4 * 1024 * 1024 }),
				]),
				NOW,
			),
		);

		expect(shown).toContain("ORPHANED");
		expect(shown).toContain("2 index a workspace that no longer exists");
		expect(shown).toContain("6.0MB");
	});

	// An index predating the recorded path looks identical to an abandoned one. Called missing, it
	// listed nine live repositories as orphaned and offered them for deletion.
	it("never calls an index whose workspace it cannot check abandoned", () => {
		const shown = textOf(
			listProjectStoresTool(
				deps([
					store({ key: "old-1", workspaceRoot: null, workspace: "unknown", bytes: 40 * 1024 * 1024 }),
					store({ key: "dead-1", workspace: "missing", bytes: 2 * 1024 * 1024 }),
				]),
				NOW,
			),
		);

		expect(shown).toContain("UNVERIFIED");
		expect(shown).toContain("unknown rather than no");
		// The reclaimable total counts only what is provably gone, never the unverified.
		expect(shown).toContain("2.0MB");
		expect(shown).not.toContain("42.0MB");
	});

	it("states that nothing is reclaimable rather than staying silent about it", () => {
		expect(textOf(listProjectStoresTool(deps([store()]), NOW))).toContain("still on disk");
	});

	it("names the pid holding a store, so the user knows what to stop", () => {
		expect(textOf(listProjectStoresTool(deps([store({ livePid: 4242 })]), NOW))).toContain("pid 4242");
	});

	it("does not claim a workspace it was never told, since the key is a hash", () => {
		const shown = textOf(listProjectStoresTool(deps([store({ workspaceRoot: null, workspace: "unknown" })]), NOW));
		expect(shown).toContain("predates recording its workspace");
	});
});

describe("deleting a project store", () => {
	it("reports what it removed and what that freed", () => {
		const shown = textOf(
			deleteProjectStoreTool(
				deps([], () => ({ deleted: true, key: "proj-abc123", bytes: 3 * 1024 * 1024 })),
				{ key: "proj-abc123" },
			),
		);

		expect(shown).toContain("Deleted proj-abc123");
		expect(shown).toContain("3.0MB");
	});

	// A refusal that reads as success is how a user believes they reclaimed space they still owe.
	it("surfaces a refusal as an error rather than as a done deal", () => {
		const result = deleteProjectStoreTool(
			deps([], () => ({ deleted: false, reason: "pid 7 is serving it right now" })),
			{ key: "proj-abc123" },
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("pid 7");
	});
});

describe("stopping a project daemon", () => {
	it("succeeds when no daemon is running", async () => {
		const result = await stopProjectDaemonTool(deps([store()]), () => [], { key: "proj-abc123" });

		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toContain("already stopped");
	});

	it("names list_project_stores for an unknown key", async () => {
		const result = await stopProjectDaemonTool(deps([store()]), () => [], { key: "missing" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("list_project_stores");
	});

	it("refuses a daemon bound in this session", async () => {
		let called = false;
		const result = await stopProjectDaemonTool(
			deps([store({ livePid: 4242 })], undefined, {
				shutdown: async () => {
					called = true;
					return { stopping: true };
				},
			}),
			() => [{ key: "proj-abc123" }],
			{ key: "proj-abc123" },
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("unbind_project");
		expect(called).toBe(false);
	});

	it("waits until the daemon is gone before succeeding", async () => {
		let stopped = false;
		let calls = 0;
		const result = await stopProjectDaemonTool(
			deps([store({ livePid: 4242 })], undefined, {
				shutdown: async (lock) => {
					calls += 1;
					expect(lock).toEqual(LOCK);
					stopped = true;
					return { stopping: true };
				},
				gone: () => stopped,
			}),
			() => [],
			{ key: "proj-abc123" },
		);

		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toContain("Stopped daemon pid 4242");
		expect(calls).toBe(1);
	});

	it("reports a daemon that does not stop before the deadline", async () => {
		let now = 0;
		const result = await stopProjectDaemonTool(
			deps([store({ livePid: 4242 })], undefined, {
				gone: () => false,
				wait: async (ms) => {
					now += ms;
				},
				now: () => now,
			}),
			() => [],
			{ key: "proj-abc123" },
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("did not stop");
	});
});
