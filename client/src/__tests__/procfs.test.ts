import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { hostMemory, parseMeminfo, parseProcStat, parseProcStatus, processIdentity, processMemory } from "../procfs";

////////////////////////////////
//  Helpers

/** A pid that certainly ran and certainly exited. */
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

describe("parsing memory rows", () => {
	it("reads resident and peak sizes in bytes from a status file", () => {
		const status = "Name:\tnode\nVmHWM:\t    7404 kB\nVmRSS:\t    7000 kB\nVmSwap:\t       0 kB\n";
		expect(parseProcStatus(status)).toEqual({ rss: 7000 * 1024, hwm: 7404 * 1024 });
	});

	it("answers null for a zombie, whose status carries no Vm rows", () => {
		expect(parseProcStatus("Name:\tnode\nState:\tZ (zombie)\n")).toBeNull();
	});

	it("is not fooled by a row whose name merely starts the same", () => {
		expect(parseProcStatus("VmRSSx:\t 1 kB\nVmRSS:\t 2 kB\nVmHWM:\t 3 kB\n")).toEqual({ rss: 2048, hwm: 3072 });
	});

	it("reads total and available from meminfo", () => {
		const meminfo = "MemTotal:       32149904 kB\nMemFree:         1 kB\nMemAvailable:   22342984 kB\n";
		expect(parseMeminfo(meminfo)).toEqual({
			memTotal: 32149904 * 1024,
			memAvailable: 22342984 * 1024,
			memoryLimit: null,
		});
	});
});

describe("asking the live mount", () => {
	onLinux("reads our own birth ticks, and reads them the same twice", () => {
		const first = processIdentity(process.pid);
		const again = processIdentity(process.pid);

		expect(first).not.toBeNull();
		expect(first?.zombie).toBe(false);
		expect(first?.startTicks).toMatch(/^\d+$/);
		expect(again?.startTicks).toBe(first?.startTicks);
	});

	onLinux("reads our own memory, with the peak no lower than the present", () => {
		const memory = processMemory(process.pid);

		expect(memory).not.toBeNull();
		expect(memory?.rss).toBeGreaterThan(0);
		expect(memory?.hwm).toBeGreaterThanOrEqual(memory?.rss ?? 0);
	});

	onLinux("reads the host, with available no more than total", () => {
		const host = hostMemory();

		expect(host).not.toBeNull();
		expect(host?.memAvailable).toBeGreaterThan(0);
		expect(host?.memAvailable).toBeLessThanOrEqual(host?.memTotal ?? 0);
	});

	it("answers null for a pid with no process behind it", () => {
		const gone = deadPid();
		expect(processIdentity(gone)).toBeNull();
		expect(processMemory(gone)).toBeNull();
	});
});
