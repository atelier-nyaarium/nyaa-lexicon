// The thin client's half: find a daemon, or learn what to do instead, and the primitives for
// starting and stopping one.
//
// Every consumer goes through here, so the connect-replace-spawn rules live in one place rather
// than being reimplemented slightly differently by the MCP adapter and the editor adapter.
//
// Nothing here walks up from its own file: every root is an argument.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { type DaemonLock, PROTOCOL_VERSION, TransactionStatusSchema } from "@nyaa-lexicon/protocol";
import { decideFromLock, type LockDecision } from "./lock.js";
import { canonicalRoot, currentHost, type PlatformEnv, workspacePaths } from "./paths.js";
import { processIdentity } from "./procfs.js";
import { requestOnce } from "./transport.js";

////////////////////////////////
//  Interfaces & Types

/** The checkout a daemon is spawned from, and the identity a lock is judged against. */
export interface DaemonSource {
	root: string;
	buildVersion: string;
	bundleStamp: string | null;
}

/** How the spawned daemon died, if it has, so a lock that never appears can name the exit instead. */
export interface SpawnWatch {
	death: () => string | null;
}

/** The seams retiring a daemon needs, injected so a test never asks, signals or probes a real one. */
export interface RetireOptions {
	/** Asks the outgoing daemon whether anything is in flight, and then to stop. */
	ask: (lock: DaemonLock, method: string) => Promise<unknown>;
	/** The signal, once asking was not enough. */
	stop: (pid: number) => void;
	/** Whether the lock's holder still lives as itself. */
	alive: (holder: { pid: number; pidStart?: string | undefined }) => boolean;
	/** Waits for the lock to stop naming the daemon; false when it still does. */
	released: () => Promise<boolean>;
}

////////////////////////////////
//  Constants

/** Rotated once past this, keeping one predecessor. Enough for weeks of a healthy daemon. */
const LOG_ROTATE_BYTES = 1024 * 1024;

////////////////////////////////
//  Liveness

/** True when a signal-zero probe reaches the process, which is how liveness is asked on POSIX. */
export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and belongs to someone else, which still counts as alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Liveness a lock can trust: the pid answers and is still the process that wrote the lock.
 * Unlike processIsAlive, EPERM is not taken on faith: a pid we may not signal is only the holder
 * if its recorded identity says so, since bare existence proves a stranger reused the number. */
export function lockHolderAlive(holder: { pid: number; pidStart?: string | undefined }): boolean {
	try {
		process.kill(holder.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
		const identity = processIdentity(holder.pid);
		return identity !== null && !identity.zombie && identity.startTicks === holder.pidStart;
	}
	const identity = processIdentity(holder.pid);
	// No /proc, no verdict: the plain probe stands, as it always has off Linux.
	if (identity === null) return true;
	if (identity.zombie) return false;
	return holder.pidStart === undefined || identity.startTicks === holder.pidStart;
}

////////////////////////////////
//  Finding

/** Reads the lock file and applies the rules. Absent and unreadable are both "no daemon". */
export function findDaemon(
	workspaceRoot: string,
	source: Pick<DaemonSource, "buildVersion" | "bundleStamp">,
	host: PlatformEnv = currentHost(),
	stateDir?: string,
): LockDecision {
	const paths = workspacePaths(host, workspaceRoot, stateDir);
	let raw: string | null;
	try {
		raw = readFileSync(paths.lockFile, "utf8");
	} catch {
		raw = null;
	}

	return decideFromLock({
		raw,
		isAlive: lockHolderAlive,
		ourProtocolVersion: PROTOCOL_VERSION,
		ourBuildVersion: source.buildVersion,
		ourBundleStamp: source.bundleStamp,
		// The lock holds the real path, so a root reached through a link compares as itself.
		workspaceRoot: canonicalRoot(workspaceRoot),
	});
}

////////////////////////////////
//  Calling

/**
 * One query against a running daemon: connect, authenticate, ask, close.
 *
 * For callers that ask one question and exit. A session that asks many questions holds a
 * persistent connection instead (`connectFrames`), because the open connection is what tells the
 * daemon the session exists.
 */
export async function callDaemon(lock: DaemonLock, method: string, params?: unknown): Promise<unknown> {
	return requestOnce(lock.port, lock.token, method, params);
}

////////////////////////////////
//  The bundle

/** The bundle, run on the shipping runtime. Absent in a source checkout that was never built. */
export function daemonCommand(root: string, workspaceRoot: string, stateDir?: string): string[] | null {
	const bundle = path.join(root, "dist", "daemon.js");
	try {
		// A directory or dangling symlink wearing the name is not a program.
		if (!statSync(bundle).isFile()) return null;
	} catch {
		return null;
	}
	const command = [process.execPath, bundle, workspaceRoot];
	if (stateDir !== undefined) command.push("--state-dir", stateDir);
	return command;
}

/**
 * Which bundle a daemon is running, closely enough to notice a rebuild.
 *
 * A digest of every bundle's BYTES under dist/, so two copies of one release agree whatever their
 * mtimes (two plugin hosts install the same release side by side, and equal-version daemons with
 * different stamps would retire each other forever) and any rebuild, a provider's alone included,
 * differs. Null when unbuilt or unreadable: nothing to compare, never a guess.
 */
export function bundleStamp(root: string): string | null {
	const dist = path.join(root, "dist");
	try {
		if (!statSync(path.join(dist, "daemon.js")).isFile()) return null;
		const files: string[] = [];
		const visit = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) visit(file);
				else if (entry.isFile() && entry.name.endsWith(".js")) files.push(file);
			}
		};
		visit(dist);
		const digest = createHash("sha256");
		for (const file of files.sort()) {
			digest.update(path.relative(dist, file));
			digest.update("\0");
			digest.update(readFileSync(file));
			digest.update("\0");
		}
		return `${files.length}:${digest.digest("hex").slice(0, 16)}`;
	} catch {
		return null;
	}
}

////////////////////////////////
//  Spawning

/** One log per workspace, capped by rotation, or null when it cannot be opened. */
function openLog(logFile: string): number | null {
	try {
		// The store directory is born here on a spawn, so it is as closed as the daemon would make it.
		mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
		if (statSync(logFile).size > LOG_ROTATE_BYTES) {
			rmSync(`${logFile}.old`, { force: true });
			renameSync(logFile, `${logFile}.old`);
		}
	} catch {
		// Absent log or failed rotation both mean: append to whatever opens.
	}
	try {
		return openSync(logFile, "a");
	} catch {
		return null;
	}
}

/**
 * Start a daemon that outlives whoever started it.
 *
 * Detached on purpose: the daemon serves every session that finds its lock, so tying its life to
 * the first session killed it under the second. The questions detaching opens - a stale lock, two
 * writers racing on one index - are answered by the daemon's exclusive lock claim, not here.
 *
 * Its stdio lands in the workspace's daemon.log, so a crash has a record instead of a mute
 * lock-wait timeout. The child handle is watched, never awaited, so its death during our wait is
 * reportable while its life stays its own.
 */
export function spawnDaemonProcess(command: string[], logFile: string): SpawnWatch | undefined {
	const [executable, ...args] = command;
	if (executable === undefined) return undefined;

	const log = openLog(logFile);
	const child = spawn(executable, args, {
		stdio: ["ignore", log ?? "ignore", log ?? "ignore"],
		detached: true,
	});
	if (log !== null) closeSync(log);

	let death: string | null = null;
	child.once("exit", (code, signal) => {
		death = signal !== null ? `died on ${signal}` : `exited with code ${code}`;
	});
	child.once("error", (error) => {
		death = `could not start: ${error.message}`;
	});
	child.unref();
	return { death: () => death };
}

////////////////////////////////
//  Retiring

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Retire a daemon that cannot serve us, but only on positive evidence that nothing is in flight.
 *
 * An open transaction holds the only copy of the images its undo would restore. Anything but a
 * clear no leaves it running, since an unclear answer must never read as consent.
 *
 * Asked before signalled: `shutdown` lets it settle in-flight answers and release its own lock.
 * The signal is for a daemon that does not know the method, or one that holds on past the wait.
 */
export async function retire(
	lock: DaemonLock,
	options: RetireOptions,
): Promise<{ retired: true } | { retired: false; reason: string }> {
	let status: unknown;
	try {
		status = await options.ask(lock, "refactorStatus");
	} catch (error) {
		return { retired: false, reason: `it would not say whether a refactor is open: ${errorText(error)}` };
	}

	// Only `open` decides, so an older daemon's fuller or thinner status still answers the question.
	const parsed = TransactionStatusSchema.pick({ open: true }).safeParse(status);
	const open = parsed.success ? parsed.data.open : null;
	if (open !== false) {
		return {
			retired: false,
			reason:
				open === true ? "a refactor transaction is open on it" : "it did not answer whether a refactor is open",
		};
	}

	try {
		await options.ask(lock, "shutdown");
	} catch {
		// Too old to know the method, or already on its way out; the lock wait tells which.
	}
	if (await options.released()) return { retired: true };

	// Re-judged at the last moment: the pid may have been reused since the lock was read, and a
	// signal sent on the old number lands on whoever wears it now.
	if (!options.alive(lock)) return { retired: true };
	try {
		options.stop(lock.pid);
	} catch (error) {
		return { retired: false, reason: `pid ${lock.pid} could not be stopped: ${errorText(error)}` };
	}
	return { retired: true };
}
