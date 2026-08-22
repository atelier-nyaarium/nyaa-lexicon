// The SOLE reader of /proc. Null where there is no procfs, never a guess.

import { readFileSync } from "node:fs";

////////////////////////////////
//  Interfaces & Types

export interface ProcessIdentity {
	startTicks: string;
	zombie: boolean;
}

/** Bytes. `hwm` is the resident peak since birth. */
export interface ProcessMemory {
	rss: number;
	hwm: number;
}

/** Bytes. */
export interface HostMemory {
	memTotal: number;
	memAvailable: number;
}

////////////////////////////////
//  Functions & Helpers

/** Fields from /proc/<pid>/stat. comm may hold spaces and parens, so parsing is only stable after
 * the LAST ')'. Exported pure so hostile comm shapes are testable. */
export function parseProcStat(stat: string): ProcessIdentity | null {
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const state = fields[0];
	const startTicks = fields[19];
	if (state === undefined || startTicks === undefined || !/^\d+$/.test(startTicks)) return null;
	return { startTicks, zombie: state === "Z" };
}

/** One `Name:   123 kB` row, as status and meminfo both spell them. */
function kbField(text: string, name: string): number | null {
	const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text);
	return match?.[1] === undefined ? null : Number(match[1]) * 1024;
}

/** A zombie has no Vm rows, so it answers null. */
export function parseProcStatus(status: string): ProcessMemory | null {
	const rss = kbField(status, "VmRSS");
	const hwm = kbField(status, "VmHWM");
	return rss === null || hwm === null ? null : { rss, hwm };
}

export function parseMeminfo(meminfo: string): HostMemory | null {
	const memTotal = kbField(meminfo, "MemTotal");
	const memAvailable = kbField(meminfo, "MemAvailable");
	return memTotal === null || memAvailable === null ? null : { memTotal, memAvailable };
}

function readProc(relative: string): string | null {
	try {
		return readFileSync(`/proc/${relative}`, "utf8");
	} catch {
		return null;
	}
}

/** A pid's birth, where the platform can say. Reuse mints new ticks, so equal ticks IS identity;
 * kill(0) alone reads a reused pid and a zombie both as our daemon. */
export function processIdentity(pid: number): ProcessIdentity | null {
	const stat = readProc(`${pid}/stat`);
	return stat === null ? null : parseProcStat(stat);
}

export function processMemory(pid: number): ProcessMemory | null {
	const status = readProc(`${pid}/status`);
	return status === null ? null : parseProcStatus(status);
}

export function hostMemory(): HostMemory | null {
	const meminfo = readProc("meminfo");
	return meminfo === null ? null : parseMeminfo(meminfo);
}
