import { describe, expect, it } from "vitest";
import { type DaemonLock, decideFromLock } from "../lockFile";

////////////////////////////////
//  Helpers

const LOCK: DaemonLock = {
	port: 41234,
	token: "t".repeat(32),
	pid: 4242,
	protocolVersion: "0.2.0",
	workspaceRoot: "/home/me/proj",
	startedAt: 1,
};

function decide(overrides: { lock?: Partial<DaemonLock> | null; alive?: boolean; ours?: string } = {}) {
	const raw = overrides.lock === null ? null : JSON.stringify({ ...LOCK, ...overrides.lock });
	return decideFromLock({
		raw,
		isAlive: () => overrides.alive ?? true,
		ourProtocolVersion: overrides.ours ?? "0.2.0",
		workspaceRoot: "/home/me/proj",
	});
}

////////////////////////////////
//  Tests

describe("finding a daemon", () => {
	it("connects to a live daemon serving this workspace at our major", () => {
		expect(decide()).toMatchObject({ action: "connect" });
	});

	it("spawns when nothing is registered", () => {
		expect(decide({ lock: null })).toMatchObject({ action: "spawn" });
	});

	it("spawns rather than replaces when the pid is gone, since there is nothing to stop", () => {
		const decision = decide({ alive: false });
		expect(decision.action).toBe("spawn");
		expect(decision.action === "spawn" && decision.reason).toMatch(/4242 is gone/);
	});

	it("replaces a daemon on a different major, which is the stale-daemon case", () => {
		const decision = decide({ lock: { protocolVersion: "1.0.0" } });
		expect(decision.action).toBe("replace");
		expect(decision.action === "replace" && decision.reason).toMatch(/1\.0\.0/);
	});

	it("connects across a minor difference, since changes are additive within a major", () => {
		expect(decide({ lock: { protocolVersion: "0.9.0" } })).toMatchObject({ action: "connect" });
	});

	it("replaces a daemon serving another workspace rather than serving its index as ours", () => {
		const decision = decide({ lock: { workspaceRoot: "/home/me/other" } });
		expect(decision.action).toBe("replace");
		expect(decision.action === "replace" && decision.reason).toMatch(/other/);
	});
});

describe("an unusable lock file is spawn, never a guess", () => {
	it("spawns on unreadable JSON", () => {
		expect(
			decideFromLock({
				raw: "{ not json",
				isAlive: () => true,
				ourProtocolVersion: "0.2.0",
				workspaceRoot: "/home/me/proj",
			}),
		).toMatchObject({ action: "spawn" });
	});

	it("spawns on a shape that does not validate", () => {
		expect(decide({ lock: { port: -1 } })).toMatchObject({ action: "spawn" });
		expect(decide({ lock: { token: "short" } })).toMatchObject({ action: "spawn" });
	});

	it("refuses a lock with no token, since binding a port without one is the hole", () => {
		const decision = decideFromLock({
			raw: JSON.stringify({ ...LOCK, token: undefined }),
			isAlive: () => true,
			ourProtocolVersion: "0.2.0",
			workspaceRoot: "/home/me/proj",
		});
		expect(decision).toMatchObject({ action: "spawn" });
	});
});
