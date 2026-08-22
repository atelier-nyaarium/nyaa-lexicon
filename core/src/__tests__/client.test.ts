import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { lockHolderAlive, processIsAlive } from "../client";
import { processIdentity } from "../procfs";

////////////////////////////////
//  Helpers

/** A pid that certainly ran and certainly exited, for dead-holder cases. */
function deadPid(): number {
	const child = spawnSync("true");
	if (child.pid === undefined) throw new Error("could not spawn a child to die");
	return child.pid;
}

const onLinux = process.platform === "linux" ? it : it.skip;

////////////////////////////////
//  Tests

// Issue #7: kill(0) said a dead daemon's lock was live, because its pid had been reused. Ticks
// are minted at birth, so a reused pid can never present the old ones.
describe("judging a lock holder", () => {
	it("accepts the very process that wrote the lock", () => {
		const identity = processIdentity(process.pid);
		const holder = identity === null ? { pid: process.pid } : { pid: process.pid, pidStart: identity.startTicks };

		expect(lockHolderAlive(holder)).toBe(true);
	});

	onLinux("rejects a live pid wearing someone else's birth ticks", () => {
		expect(processIsAlive(process.pid)).toBe(true);
		expect(lockHolderAlive({ pid: process.pid, pidStart: "1" })).toBe(false);
	});

	it("rejects a dead pid outright", () => {
		expect(lockHolderAlive({ pid: deadPid() })).toBe(false);
	});

	it("still accepts a lock too old to carry an identity", () => {
		expect(lockHolderAlive({ pid: process.pid })).toBe(true);
	});
});
