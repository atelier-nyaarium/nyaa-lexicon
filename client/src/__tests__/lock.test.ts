import { describe, expect, it } from "bun:test";
import type { DaemonLock } from "@nyaa-lexicon/protocol";
import { decideFromLock, newerBuild } from "../lock";

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

	// Issue #7: liveness got only the pid, so identity could not be judged and a reused pid read
	// as a live daemon. The seam must see the whole holder.
	it("hands the liveness seam the holder's identity, not a bare pid", () => {
		const seen: Array<{ pid: number; pidStart?: string | undefined }> = [];
		decideFromLock({
			raw: JSON.stringify({ ...LOCK, pidStart: "12345" }),
			isAlive: (holder) => {
				seen.push(holder);
				return true;
			},
			ourProtocolVersion: "0.2.0",
			ourBuildVersion: "1.10.2",
			workspaceRoot: "/home/me/proj",
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ pid: 4242, pidStart: "12345" });
	});

	it("replaces a daemon on an OLDER protocol major, which is the stale-daemon case", () => {
		const decision = decide({ lock: { protocolVersion: "1.0.0" }, ours: "2.0.0" });
		expect(decision.action).toBe("replace");
		expect(decision.action === "replace" && decision.reason).toMatch(/1\.0\.0/);
	});

	// Retiring it starts a war: it replaces us back, and every flip rebuilds the index.
	it("connects to a daemon on a NEWER protocol major rather than dragging the workspace back", () => {
		expect(decide({ lock: { protocolVersion: "2.0.0" }, ours: "1.2.0" })).toMatchObject({ action: "connect" });
	});

	// Unreadable is not newer. Riding a daemon whose wire nobody can name is the one outcome worse
	// than replacing it.
	it("replaces a daemon whose protocol version does not parse", () => {
		expect(decide({ lock: { protocolVersion: "2.garbage" }, ours: "1.2.0" })).toMatchObject({ action: "replace" });
		expect(decide({ lock: { protocolVersion: "nonsense" }, ours: "1.2.0" })).toMatchObject({ action: "replace" });
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
describe("the build comparison is ordered, because method tables only grow", () => {
	it("replaces a daemon from an older build even at the same protocol major", () => {
		const decision = decide({ lock: { buildVersion: "1.9.0" } });
		expect(decision.action).toBe("replace");
		expect(decision.action === "replace" && decision.reason).toMatch(/1\.9\.0/);
	});

	it("replaces on an older PATCH, since a patch can still add a method", () => {
		expect(decide({ lock: { buildVersion: "1.10.1" } })).toMatchObject({ action: "replace" });
	});

	// The downgrade war: two sessions on different plugin versions each retiring the other's
	// daemon on every request. A newer daemon serves our whole table, so it stays.
	it("connects to a NEWER daemon instead of dragging it back to our build", () => {
		expect(decide({ lock: { buildVersion: "1.11.0" } })).toMatchObject({ action: "connect" });
		expect(decide({ lock: { buildVersion: "2.0.0" } })).toMatchObject({ action: "connect" });
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

describe("ordering two build versions", () => {
	it("orders by release triple, not by string", () => {
		expect(newerBuild("1.10.0", "1.9.9")).toBe(true);
		expect(newerBuild("1.9.9", "1.10.0")).toBe(false);
		expect(newerBuild("2.0.0", "1.99.99")).toBe(true);
		expect(newerBuild("1.10.2", "1.10.2")).toBe(false);
	});

	it("answers false for anything unparseable, so no decision rests on a guess", () => {
		expect(newerBuild("1.x", "1.10.2")).toBe(false);
		expect(newerBuild("1.10.2", "nonsense")).toBe(false);
		expect(newerBuild("1.14.0garbage", "1.10.2")).toBe(false);
	});

	it("reads a prerelease by its release triple", () => {
		expect(newerBuild("2.0.0-rc.1", "1.10.2")).toBe(true);
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
