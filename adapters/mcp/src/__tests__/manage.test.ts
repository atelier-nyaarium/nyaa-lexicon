import type { DaemonLock, ProjectStore } from "@nyaa-lexicon/core";
import { describe, expect, it } from "vitest";
import { deleteProjectStoreTool, type ManageDeps, stopProjectDaemonTool } from "../manage";

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

function store(overrides: Partial<ProjectStore> = {}): ProjectStore {
	return {
		key: "proj-abc123",
		workspaceRoot: "/home/dev/proj",
		workspace: "present",
		bytes: 5 * 1024 * 1024,
		modifiedAt: NOW,
		lastIndexedAt: NOW,
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

////////////////////////////////
//  Tests

describe("deleting a project store", () => {
	// A refusal that reads as success is how a user believes they reclaimed space they still owe.
	it("surfaces a refusal as an error rather than as a done deal", () => {
		const result = deleteProjectStoreTool(
			deps([], () => ({ deleted: false, reason: "pid 7 is serving it right now" })),
			{ key: "proj-abc123" },
		);

		expect(result.isError).toBe(true);
	});
});

describe("stopping a project daemon", () => {
	it("succeeds when no daemon is running", async () => {
		const result = await stopProjectDaemonTool(deps([store()]), () => [], { key: "proj-abc123" });

		expect(result.isError).toBeUndefined();
	});

	it("rejects an unknown key", async () => {
		const result = await stopProjectDaemonTool(deps([store()]), () => [], { key: "missing" });

		expect(result.isError).toBe(true);
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
	});
});
