// How a thin client finds a running daemon, or learns there is none worth talking to.
//
// The decision this file owns: given what is on disk, connect, replace, spawn, or wait out a delete.

import { type DaemonLock, parseDaemonLock, servesClient } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/**
 * What a client should do about what it found.
 *
 * `replace` is separate from `spawn` because they differ in one step: replacing has a process to
 * stop first. Collapsing them leaves an orphan holding the port.
 *
 * `awaitDelete` is separate from both: nothing here is a daemon to retire or connect to.
 *
 * `outdated` is a newer major that no longer serves this client: its own clients need it, so it is
 * neither ridden nor retired, and this client must update.
 */
export type LockDecision =
	| { action: "connect"; lock: DaemonLock }
	/** `stale`: a lock its holder left behind, so the daemon died rather than stopped. */
	| { action: "spawn"; reason: string; stale?: true }
	| { action: "replace"; lock: DaemonLock; reason: string; cause: ReplaceCause }
	| { action: "awaitDelete"; lock: DaemonLock; reason: string }
	| { action: "outdated"; lock: DaemonLock; reason: string };

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
	/** When this build's bundle was last written, or null where that is unknown. */
	ourBundleWrittenAt?: number | null;
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

/** Whole semver, the only shape a version decision rests on. */
export function isRelease(version: string): boolean {
	return releaseTriple(version) !== null;
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

/** Ours was written after theirs. A lock with no time predates the field; no time of ours is no evidence. */
function writtenAfter(ours: number | null | undefined, theirs: number | undefined): boolean {
	if (theirs === undefined) return true;
	return ours != null && ours > theirs;
}

/**
 * Decide from what is on disk.
 *
 * A dead pid is spawn rather than replace: there is nothing to stop, and treating it as a replace
 * would make a crashed daemon look like a running one for as long as its stale file survives.
 */
export function decideFromLock(context: LockContext): LockDecision {
	if (context.raw === null) return { action: "spawn", reason: "no daemon is registered" };

	const lock = parseDaemonLock(context.raw);
	if (lock === null) return { action: "spawn", reason: "the lock file does not parse as a lock" };

	if (!context.isAlive(lock)) return { action: "spawn", reason: `pid ${lock.pid} is gone`, stale: true };

	// A delete's `workspaceRoot` names the directory it is removing, never a daemon to retire.
	if (lock.role === "delete") {
		return { action: "awaitDelete", lock, reason: `pid ${lock.pid} is deleting ${lock.workspaceRoot} right now` };
	}

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

	// Newer is ridden down to the oldest major it serves, and never retired: two sides replacing each
	// other rebuild the index per flip.
	if (!sameMajor(lock.protocolVersion, context.ourProtocolVersion)) {
		if (newerBuild(lock.protocolVersion, context.ourProtocolVersion)) {
			if (servesClient(lock.protocolVersion, lock.oldestClientMajor, context.ourProtocolVersion))
				return { action: "connect", lock };
			return {
				action: "outdated",
				lock,
				reason: `the daemon speaks ${lock.protocolVersion} and no longer serves protocol ${context.ourProtocolVersion}`,
			};
		}
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

	// Same version, different bundle: a rebuild, or another install such as a dev snapshot. Only
	// checked when we HAVE a stamp, so a checkout with no bundle never replaces on no evidence. Only
	// a bundle written after the daemon's replaces it, or two installs retire each other on every start.
	const ours = context.ourBundleStamp;
	if (ours != null && lock.bundleStamp !== ours && writtenAfter(context.ourBundleWrittenAt, lock.bundleWrittenAt)) {
		return {
			action: "replace",
			lock,
			reason: `the daemon runs an older or undated bundle of ${context.ourBuildVersion}`,
			cause: "build",
		};
	}

	return { action: "connect", lock };
}
