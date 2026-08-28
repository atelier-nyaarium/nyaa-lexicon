// How a thin client finds a running daemon, or learns there is none worth talking to.
//
// The decision this file owns: given what is on disk, connect, replace, or spawn. Answered as a
// value so a caller cannot invent a fourth outcome, and so the rules are testable without a
// process or a socket.

import { type DaemonLock, DaemonLockSchema } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/**
 * What a client should do about what it found.
 *
 * `replace` is separate from `spawn` because they differ in one step: replacing has a process to
 * stop first. Collapsing them leaves an orphan holding the port.
 */
export type LockDecision =
	| { action: "connect"; lock: DaemonLock }
	| { action: "spawn"; reason: string }
	| { action: "replace"; lock: DaemonLock; reason: string; cause: ReplaceCause };

/**
 * Why a daemon has to go, which decides whether a client may retire it on its own.
 *
 * `otherWorkspace` is answering correctly for somebody else. The other two are ours on a dialect
 * nobody reaching it can use.
 */
export type ReplaceCause = "otherWorkspace" | "protocol" | "build";

export interface LockContext {
	/** Raw file contents, or null when there is no lock file. */
	raw: string | null;
	/** Whether the lock's HOLDER is alive: the pid answering AND still the process that wrote it.
	 * Injected, since asking is a syscall and this stays pure. */
	isAlive: (holder: { pid: number; pidStart?: string | undefined }) => boolean;
	ourProtocolVersion: string;
	/** This build's version. A daemon on another build has another method table. */
	ourBuildVersion: string;
	/** This build's bundle stamp, or null where there is no bundle to stamp. */
	ourBundleStamp?: string | null;
	workspaceRoot: string;
}

////////////////////////////////
//  Functions & Helpers

function sameMajor(a: string, b: string): boolean {
	return a.split(".")[0] === b.split(".")[0];
}

function releaseTriple(version: string): [number, number, number] | null {
	// Whole semver only: "1.14.0garbage" must not read as a release.
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version.trim());
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Strictly newer release. Unparseable answers false, so no decision rests on a guess. */
export function newerBuild(candidate: string, current: string): boolean {
	const a = releaseTriple(candidate);
	const b = releaseTriple(current);
	if (a === null || b === null) return false;
	for (let i = 0; i < 3; i++) {
		if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
	}
	return false;
}

/**
 * Decide from what is on disk.
 *
 * A dead pid is spawn rather than replace: there is nothing to stop, and treating it as a replace
 * would make a crashed daemon look like a running one for as long as its stale file survives.
 */
export function decideFromLock(context: LockContext): LockDecision {
	if (context.raw === null) return { action: "spawn", reason: "no daemon is registered" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(context.raw);
	} catch {
		return { action: "spawn", reason: "the lock file is not readable JSON" };
	}

	const result = DaemonLockSchema.safeParse(parsed);
	if (!result.success) return { action: "spawn", reason: "the lock file does not match its schema" };
	const lock = result.data;

	if (!context.isAlive(lock)) return { action: "spawn", reason: `pid ${lock.pid} is gone` };

	// A lock naming another workspace means this one's file was overwritten, and connecting would
	// serve a different repo's index under our path.
	if (lock.workspaceRoot !== context.workspaceRoot) {
		return {
			action: "replace",
			lock,
			reason: `the daemon serves ${lock.workspaceRoot}`,
			cause: "otherWorkspace",
		};
	}

	// Newer is ridden, never retired: two sides replacing each other rebuild the index per flip.
	if (!sameMajor(lock.protocolVersion, context.ourProtocolVersion)) {
		if (newerBuild(lock.protocolVersion, context.ourProtocolVersion)) return { action: "connect", lock };
		return {
			action: "replace",
			lock,
			reason: `the daemon speaks ${lock.protocolVersion}, we speak ${context.ourProtocolVersion}`,
			cause: "protocol",
		};
	}

	// ORDERED, not exact: method tables only grow within a protocol major, so a newer daemon serves
	// our whole table and replacing it would start a downgrade war between mixed-version sessions.
	// Only a daemon OLDER than us (or too old to say) cannot serve us.
	if (lock.buildVersion !== context.ourBuildVersion) {
		if (lock.buildVersion !== undefined && newerBuild(lock.buildVersion, context.ourBuildVersion)) {
			return { action: "connect", lock };
		}
		return {
			action: "replace",
			lock,
			reason: `the daemon runs ${lock.buildVersion ?? "a build too old to say"}, we run ${context.ourBuildVersion}`,
			cause: "build",
		};
	}

	// Same version, different bundle: a rebuild. Only checked when we HAVE a stamp to compare, so a
	// checkout with no bundle still connects instead of replacing a daemon on no evidence.
	const ours = context.ourBundleStamp;
	if (ours != null && lock.bundleStamp !== ours) {
		return {
			action: "replace",
			lock,
			reason: `the daemon runs a different bundle of ${context.ourBuildVersion}, so it was rebuilt since it started`,
			cause: "build",
		};
	}

	return { action: "connect", lock };
}
