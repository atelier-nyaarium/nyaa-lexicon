// The SOLE owner of which runtime lexicon runs on and the oldest bun it accepts.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

export type RuntimeVerdict =
	| { kind: "bun"; version: string }
	| { kind: "belowFloor"; version: string; floor: string }
	| { kind: "notBun"; runtime: string };

export type BunExecutable =
	| { kind: "bun"; executable: string; version: string }
	| { kind: "missing"; executable: string }
	| { kind: "malformed"; executable: string; version: string }
	| { kind: "belowFloor"; executable: string; version: string; floor: string };

export type RuntimeProbe = (executable: string) => string | null;

////////////////////////////////
//  Constants

/** Measured: the oldest bun the whole gate, the store, the watcher and the daemon smoke pass on. */
export const BUN_FLOOR = "1.4.0";

/** One answer per executable per probe: the live probe runs `--version` once per process. */
const probes = new WeakMap<RuntimeProbe, Map<string, string | null>>();

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
	const floor = BUN_FLOOR.split(".").map(Number);
	const actual = release.split(".").map(Number);
	let below = false;
	for (let index = 0; index < 3; index++) {
		if ((actual[index] as number) === (floor[index] as number)) continue;
		below = (actual[index] as number) < (floor[index] as number);
		break;
	}
	if (below || (release === BUN_FLOOR && match[2] !== undefined)) {
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

function defaultProbe(executable: string): string | null {
	const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
	if (result.error !== undefined || result.status !== 0) return null;
	return result.stdout.trim();
}

function probeOnce(executable: string, probe: RuntimeProbe): string | null {
	let known = probes.get(probe);
	if (known === undefined) {
		known = new Map();
		probes.set(probe, known);
	}
	if (!known.has(executable)) known.set(executable, probe(executable));
	return known.get(executable) ?? null;
}

function pathBun(host: { platform: NodeJS.Platform; env: Record<string, string | undefined> }): string | undefined {
	const name = host.platform === "win32" ? "bun.exe" : "bun";
	const pathApi = host.platform === "win32" ? path.win32 : path.posix;
	const separator = host.platform === "win32" ? ";" : path.delimiter;
	for (const directory of (host.env["PATH"] ?? "").split(separator)) {
		if (directory === "") continue;
		const candidate = pathApi.resolve(directory, name);
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return undefined;
}

export function bunExecutable(
	host: { platform: NodeJS.Platform; env: Record<string, string | undefined>; execPath?: string },
	probe: RuntimeProbe = defaultProbe,
): BunExecutable {
	const running = host.execPath ?? "";
	const base = path.basename(running.replaceAll("\\", "/")).toLowerCase();
	const pathApi = host.platform === "win32" ? path.win32 : path.posix;
	const pathExecutable = pathBun(host);
	const candidates = ["bun", "bun.exe", "bun-profile", "bun-debug"].includes(base)
		? [running]
		: [
				...(pathExecutable === undefined ? [host.platform === "win32" ? "bun.exe" : "bun"] : [pathExecutable]),
				...(host.env["BUN_INSTALL"]
					? [
							pathApi.join(
								host.env["BUN_INSTALL"] as string,
								"bin",
								host.platform === "win32" ? "bun.exe" : "bun",
							),
						]
					: []),
			];
	let last: BunExecutable = { kind: "missing", executable: candidates[0] as string };
	for (const executable of candidates) {
		const version = probeOnce(executable, probe);
		if (version === null) {
			last = { kind: "missing", executable };
			continue;
		}
		const verdict = runtimeVerdict({ bun: version });
		if (verdict.kind === "bun") return { kind: "bun", executable, version };
		if (verdict.kind === "belowFloor") return { kind: "belowFloor", executable, version, floor: verdict.floor };
		return { kind: "malformed", executable, version };
	}
	return last;
}
