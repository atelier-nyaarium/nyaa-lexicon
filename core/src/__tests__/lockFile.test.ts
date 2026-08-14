import { describe, expect, it } from "vitest";
import { type DaemonLock, decideFromLock } from "../lockFile";

////////////////////////////////
//  Helpers

const LOCK: DaemonLock = {
	port: 41234,
	token: "t".repeat(32),
	pid: 4242,
	protocolVersion: "0.2.0",
	buildVersion: "1.10.2",
	workspaceRoot: "/home/me/proj",
	startedAt: 1,
};

function decide(
	overrides: { lock?: Partial<DaemonLock> | null; alive?: boolean; ours?: string; ourBuild?: string } = {},
) {
	const raw = overrides.lock === null ? null : JSON.stringify({ ...LOCK, ...overrides.lock });
	return decideFromLock({
		raw,
		isAlive: () => overrides.alive ?? true,
		ourProtocolVersion: overrides.ours ?? "0.2.0",
		ourBuildVersion: overrides.ourBuild ?? "1.10.2",
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

// A real incident, not a hypothetical: a 1.9.0 daemon kept serving this workspace after the
// checkout moved to 1.10.2, and every call to a method added in between answered `unknown method`.
describe("the build version is exact, because the method table is not negotiable", () => {
	it("replaces a daemon from another build even at the same protocol major", () => {
		const decision = decide({ lock: { buildVersion: "1.9.0" } });
		expect(decision.action).toBe("replace");
		expect(decision.action === "replace" && decision.reason).toMatch(/1\.9\.0/);
	});

	it("replaces on a PATCH difference, since a patch can still add a method", () => {
		expect(decide({ lock: { buildVersion: "1.10.1" } })).toMatchObject({ action: "replace" });
	});

	it("replaces a lock too old to name its build rather than hoping it is current", () => {
		const decision = decide({ lock: { buildVersion: undefined } });
		expect(decision.action).toBe("replace");
		expect(decision.action === "replace" && decision.reason).toMatch(/too old/);
	});

	it("still connects when the builds match", () => {
		expect(decide({ lock: { buildVersion: "1.10.2" }, ourBuild: "1.10.2" })).toMatchObject({ action: "connect" });
	});
});

// The version moves once a release; a developer rebuilds many times inside one. Every one of those
// rebuilds used to leave a daemon serving code the checkout no longer had, and it cost a probe run
// that reported success against the previous bundle.
describe("a rebuild at one version is noticed too", () => {
	const stamped = (bundleStamp: string | undefined, ourStamp: string | null | undefined) =>
		decideFromLock({
			raw: JSON.stringify({ ...LOCK, ...(bundleStamp === undefined ? {} : { bundleStamp }) }),
			isAlive: () => true,
			ourProtocolVersion: "0.2.0",
			ourBuildVersion: "1.10.2",
			...(ourStamp === undefined ? {} : { ourBundleStamp: ourStamp }),
			workspaceRoot: "/home/me/proj",
		});

	it("replaces a daemon running a different bundle of the same version", () => {
		const decision = stamped("4000:111", "4100:222");
		expect(decision.action).toBe("replace");
		expect(decision.action === "replace" && decision.reason).toMatch(/rebuilt since it started/);
	});

	it("connects when the bundle is the same one", () => {
		expect(stamped("4000:111", "4000:111")).toMatchObject({ action: "connect" });
	});

	it("replaces a daemon whose lock predates the stamp, since it cannot say what it runs", () => {
		expect(stamped(undefined, "4000:111")).toMatchObject({ action: "replace" });
	});

	// No bundle to compare is no evidence, and no evidence must never justify killing a daemon.
	it("connects when we have no bundle to stamp", () => {
		expect(stamped("4000:111", null)).toMatchObject({ action: "connect" });
		expect(stamped(undefined, null)).toMatchObject({ action: "connect" });
	});
});

describe("an unusable lock file is spawn, never a guess", () => {
	it("spawns on unreadable JSON", () => {
		expect(
			decideFromLock({
				raw: "{ not json",
				isAlive: () => true,
				ourProtocolVersion: "0.2.0",
				ourBuildVersion: "1.10.2",
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
			ourBuildVersion: "1.10.2",
			workspaceRoot: "/home/me/proj",
		});
		expect(decision).toMatchObject({ action: "spawn" });
	});
});
