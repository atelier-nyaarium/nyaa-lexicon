import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { lockHolderAlive, parseProcStat, processIdentity, processIsAlive } from "../client";

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

describe("parsing a stat line", () => {
	// pid (comm) state ppid pgrp session tty tpgid flags min cmin maj cmaj utime stime cutime
	// cstime prio nice threads itreal STARTTIME; comm is attacker-adjacent, the rest is numeric.
	const statLine = (comm: string, state = "S") =>
		`1234 (${comm}) ${state} 1 1234 1234 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 1 0 987654321 123 456`;

	it("reads the start ticks past a well-behaved comm", () => {
		expect(parseProcStat(statLine("node"))).toEqual({ startTicks: "987654321", zombie: false });
	});

	// A process may name itself anything, including field separators.
	it("is not fooled by a comm holding spaces and parens", () => {
		expect(parseProcStat(statLine("my ) evil (comm"))).toEqual({ startTicks: "987654321", zombie: false });
	});

	it("marks a zombie, whose pid answers kill(0) while serving nothing", () => {
		expect(parseProcStat(statLine("node", "Z"))).toEqual({ startTicks: "987654321", zombie: true });
	});

	it("answers null rather than a guess for text that is not a stat line", () => {
		expect(parseProcStat("not a stat line")).toBeNull();
		expect(parseProcStat("1234 (node) S 1 1234")).toBeNull();
		expect(parseProcStat("")).toBeNull();
	});
});

describe("asking who a pid is, not only whether it answers", () => {
	onLinux("reads our own birth ticks, and reads them the same twice", () => {
		const first = processIdentity(process.pid);
		const again = processIdentity(process.pid);

		expect(first).not.toBeNull();
		expect(first?.zombie).toBe(false);
		expect(first?.startTicks).toMatch(/^\d+$/);
		expect(again?.startTicks).toBe(first?.startTicks);
	});

	it("answers null for a pid with no process behind it", () => {
		expect(processIdentity(deadPid())).toBeNull();
	});
});

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
