// The SOLE owner of which runtime lexicon runs on and the oldest bun it accepts.

import { statSync } from "node:fs";
import path from "node:path";
import { runBounded, systemTimer } from "@nyaa-lexicon/protocol";
import { newerBuild } from "./lock.js";

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

export type RuntimeProbe = (executable: string) => Promise<string | null>;

////////////////////////////////
//  Constants

/** Measured: the oldest bun the whole gate, the store, the watcher and the daemon smoke pass on. */
export const BUN_FLOOR = "1.4.0";

/** A `--version` probe that never answers is killed rather than waited on. */
const PROBE_TIMEOUT_MS = 10_000;

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

/** Far more than any real `--version` prints; the cap exists so a misbehaving executable cannot flood memory. */
const PROBE_MAX_BYTES = 1024 * 1024;

/** Exported for a test proving the timeout kills a probe that traps its own termination signal. */
export async function defaultProbe(executable: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
	// SIGKILL, not TERM: a probe that traps or ignores TERM must not outlive the timeout.
	const result = await runBounded(executable, ["--version"], {
		maxBytes: PROBE_MAX_BYTES,
		timeoutMs,
		timer: systemTimer,
	});
	if (result.kind !== "exited" || result.code !== 0) return null;
	return result.stdout.toString("utf8").trim();
}

async function probeOnce(executable: string, probe: RuntimeProbe): Promise<string | null> {
	let known = probes.get(probe);
	if (known === undefined) {
		known = new Map();
		probes.set(probe, known);
	}
	if (!known.has(executable)) known.set(executable, await probe(executable));
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

/** Prereleases sort below releases. */
function olderThan(version: string, minimum: string): boolean {
	if (newerBuild(minimum, version)) return true;
	if (newerBuild(version, minimum)) return false;
	return version.includes("-") && !minimum.includes("-");
}

async function judged(executable: string, probe: RuntimeProbe): Promise<BunExecutable> {
	const version = await probeOnce(executable, probe);
	if (version === null) return { kind: "missing", executable };
	const verdict = runtimeVerdict({ bun: version });
	if (verdict.kind === "bun") return { kind: "bun", executable, version };
	if (verdict.kind === "belowFloor") return { kind: "belowFloor", executable, version, floor: verdict.floor };
	return { kind: "malformed", executable, version };
}

/** Format a runtime refusal. */
export function runtimeProblem(runtime: Exclude<BunExecutable, { kind: "bun" }>): string {
	switch (runtime.kind) {
		case "missing":
			return `the daemon needs bun ${BUN_FLOOR} or newer; none runs at ${runtime.executable}`;
		case "malformed":
			return `the daemon needs bun ${BUN_FLOOR} or newer; ${runtime.executable} reported ${runtime.version}`;
		case "belowFloor":
			return `the daemon needs bun ${runtime.floor} or newer; ${runtime.executable} is bun ${runtime.version}`;
	}
}

/** A bun caller keeps its own bun; others try PATH, `$BUN_INSTALL`, then the bundle.
 * An OS bun older than the bundle is skipped. */
export async function bunExecutable(
	host: { platform: NodeJS.Platform; env: Record<string, string | undefined>; execPath?: string },
	probe: RuntimeProbe = defaultProbe,
	bundled?: string,
): Promise<BunExecutable> {
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
	const bundle = bundled === undefined ? null : await judged(bundled, probe);
	const minimum = bundle?.kind === "bun" ? bundle.version : null;
	let failure: BunExecutable | null = null;
	let last: BunExecutable = { kind: "missing", executable: candidates[0] as string };
	for (const executable of candidates) {
		const found = await judged(executable, probe);
		if (found.kind === "bun") {
			if (minimum === null || !olderThan(found.version, minimum)) return found;
			continue;
		}
		if (found.kind === "missing") last = found;
		else failure ??= found;
	}
	if (bundle?.kind === "bun") return bundle;
	if (bundle !== null && bundle.kind !== "missing") failure ??= bundle;
	return failure ?? bundle ?? last;
}
