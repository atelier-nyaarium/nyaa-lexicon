// The SOLE owner of which runtime lexicon runs on and the oldest bun it accepts.

import { newerBuild } from "./lock.js";

////////////////////////////////
//  Interfaces & Types

export type RuntimeVerdict =
	| { kind: "bun"; version: string }
	| { kind: "belowFloor"; version: string; floor: string }
	| { kind: "notBun"; runtime: string };

////////////////////////////////
//  Constants

/** Measured: the oldest bun the whole gate, the store, the watcher and the daemon smoke pass on. */
export const BUN_FLOOR = "1.4.0";

////////////////////////////////
//  Functions & Helpers

/** What this process runs on, judged from `process.versions`. */
export function runtimeVerdict(versions: Record<string, string | undefined> = process.versions): RuntimeVerdict {
	const bun = versions["bun"];
	if (bun === undefined) return { kind: "notBun", runtime: `node ${versions["node"] ?? "unknown"}` };
	// A prerelease sits below its own release, and a version that does not parse is not bun's.
	const match = /^(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(bun);
	if (match === null) return { kind: "notBun", runtime: `bun ${bun}` };
	const release = match[1] as string;
	if (newerBuild(BUN_FLOOR, release) || (release === BUN_FLOOR && match[2] !== undefined)) {
		return { kind: "belowFloor", version: bun, floor: BUN_FLOOR };
	}
	return { kind: "bun", version: bun };
}

/** The sentence an entry point prints before exiting, or null when the runtime is accepted. */
export function refuseRuntime(what: string, versions?: Record<string, string | undefined>): string | null {
	const verdict = runtimeVerdict(versions);
	switch (verdict.kind) {
		case "bun":
			return null;
		case "belowFloor":
			return `${what} needs bun ${verdict.floor} or newer; this is bun ${verdict.version}`;
		case "notBun":
			return `${what} runs on bun ${BUN_FLOOR} or newer; this is ${verdict.runtime}`;
	}
}
