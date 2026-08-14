// How a thin client finds a running daemon, or learns there is none worth talking to.
//
// The decision this file owns: given what is on disk, connect, replace, or spawn. Answered as a
// value so a caller cannot invent a fourth outcome, and so the rules are testable without a
// process or a socket.

import { z } from "zod";

////////////////////////////////
//  Schemas

export const DaemonLockSchema = z
	.object({
		/** Localhost port. Chosen by the OS at bind, never fixed, so two workspaces cannot collide. */
		port: z.number().int().positive(),
		/** Presented on every call. Closes the hole that binding a TCP port opens on a shared box. */
		token: z.string().min(32),
		pid: z.number().int().positive(),
		/** Protocol version the daemon speaks, so a client on a different major replaces it. */
		protocolVersion: z.string().min(1),
		/**
		 * The BUILD the daemon runs, which decides its method table.
		 *
		 * Optional only so a lock written before this field existed still parses; absent is read as a
		 * mismatch, which is the truth about any daemon old enough not to stamp it.
		 */
		buildVersion: z.string().min(1).optional(),
		workspaceRoot: z.string().min(1),
		startedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "DaemonLock" });

export type DaemonLock = z.infer<typeof DaemonLockSchema>;

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
 * `otherWorkspace` is somebody else's daemon answering correctly for somebody else, and stopping it
 * is not a call we get to make. The other two are OUR workspace's daemon speaking a dialect we
 * cannot use, where every session reaching it is as stuck as we are, so retiring it helps them too.
 */
export type ReplaceCause = "otherWorkspace" | "protocol" | "build";

export interface LockContext {
	/** Raw file contents, or null when there is no lock file. */
	raw: string | null;
	/** Whether that pid is alive. Injected, since asking is a syscall and this stays pure. */
	isAlive: (pid: number) => boolean;
	ourProtocolVersion: string;
	/** This build's version. A daemon on another build has another method table. */
	ourBuildVersion: string;
	workspaceRoot: string;
}

////////////////////////////////
//  Functions & Helpers

function sameMajor(a: string, b: string): boolean {
	return a.split(".")[0] === b.split(".")[0];
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

	if (!context.isAlive(lock.pid)) return { action: "spawn", reason: `pid ${lock.pid} is gone` };

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

	if (!sameMajor(lock.protocolVersion, context.ourProtocolVersion)) {
		return {
			action: "replace",
			lock,
			reason: `the daemon speaks ${lock.protocolVersion}, we speak ${context.ourProtocolVersion}`,
			cause: "protocol",
		};
	}

	// EXACT, not same-major. The contract between a client and a daemon is the method table, and any
	// release can add to it; a client built after the daemon asks for methods it does not have and
	// gets `unknown method` for a tool that shipped. Measured against a 1.9.0 daemon still serving
	// this workspace after the checkout moved to 1.10.2.
	if (lock.buildVersion !== context.ourBuildVersion) {
		return {
			action: "replace",
			lock,
			reason: `the daemon runs ${lock.buildVersion ?? "a build too old to say"}, we run ${context.ourBuildVersion}`,
			cause: "build",
		};
	}

	return { action: "connect", lock };
}
