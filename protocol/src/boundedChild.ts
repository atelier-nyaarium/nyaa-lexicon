// The one owner of a bounded child process: spawn, cap its output, bound its wait, and reap the
// whole process group if it wedges. A git call, a runtime probe and the python helper all need
// exactly this, so it is written once rather than copied per caller.

import { type ChildProcess, spawn } from "node:child_process";

////////////////////////////////
//  Interfaces & Types

/** The timer a caller injects, so a clock-driven caller and a plain setTimeout caller share this module. */
export interface BoundedTimer {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface BoundedChildOptions {
	cwd?: string | undefined;
	/** Written to stdin, then closed. Stdin is left closed when omitted. */
	input?: string | Buffer | undefined;
	/** Caps stdout and stderr alike; either crossing it kills and reaps the child. */
	maxBytes: number;
	timeoutMs: number;
	timer: BoundedTimer;
	/** Handed the spawned child, so a test can assert the reap without a second process listing. */
	onSpawn?: ((child: ChildProcess) => void) | undefined;
}

/** Never rejects: a spawn failure, a timeout and an overflow are answers, not exceptions. */
export type BoundedResult =
	| { kind: "exited"; code: number | null; signal: string | null; stdout: Buffer; stderr: Buffer }
	| { kind: "spawnFailed"; error: NodeJS.ErrnoException }
	| { kind: "timedOut" }
	| { kind: "overflowed" };

////////////////////////////////
//  Constants

/** Every spawned group's pid still without a close, so this process's own exit can reap what it forked. */
const liveGroups = new Set<number>();

////////////////////////////////
//  Functions & Helpers

/** Kills every process group this module still tracks. A SIGKILL of that process itself cannot be covered. */
export function killLiveGroups(): void {
	for (const pid of liveGroups) {
		try {
			process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	liveGroups.clear();
}

process.on("exit", killLiveGroups);

/** setTimeout, unrefed. The default `BoundedTimer` for a caller with no clock of its own to inject. */
export const systemTimer: BoundedTimer = {
	set: (fn, ms) => {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return handle;
	},
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

class TimedOut extends Error {}

/** The count of process groups this module still tracks; a test's proof that a terminal path leaked none. */
export function liveGroupCount(): number {
	return liveGroups.size;
}

/** Awaits the one `closed` shared by every caller, never a fresh `once("close", ...)` (fires once, so a late listener waits forever); kills the whole group whenever close has not fired, since a pgid stays reserved while any member lives and ESRCH just means it is already empty. */
async function reap(child: ChildProcess, closed: Promise<void>, hasClosed: () => boolean): Promise<void> {
	if (!hasClosed()) {
		try {
			if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			else child.kill("SIGKILL");
		} catch {
			// The group, or the lone process, is already gone.
		}
	}
	await closed;
}

/** Runs one command, bounded by `options.timeoutMs`, killing and reaping a wedged child rather than waiting on it. */
export async function runBounded(
	command: string,
	args: string[],
	options: BoundedChildOptions,
): Promise<BoundedResult> {
	let child: ChildProcess;
	try {
		child = spawn(command, args, {
			cwd: options.cwd,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			// Its own process group, so a wedged reap can kill what it forked, not only itself.
			detached: process.platform !== "win32",
		});
	} catch (error) {
		// Nothing spawned: no group to reap.
		return { kind: "spawnFailed", error: error as NodeJS.ErrnoException };
	}

	// A stream error, an EPIPE writing to a child that already exited say, is not a terminal result
	// by itself; the child's own close still decides that. Attached before anything below can write.
	child.stdin?.on("error", () => {});
	child.stdout?.on("error", () => {});
	child.stderr?.on("error", () => {});

	if (child.pid !== undefined) liveGroups.add(child.pid);

	// One listener for the whole run, shared by settling and reaping: see reap's own comment.
	// Established before anything below that could throw, so a throw there can still reap through it.
	let closeCode: number | null = null;
	let closeSignal: string | null = null;
	let hasClosed = false;
	const closed = new Promise<void>((resolve) => {
		child.once("close", (code, signal) => {
			closeCode = code;
			closeSignal = signal;
			hasClosed = true;
			if (child.pid !== undefined) liveGroups.delete(child.pid);
			resolve();
		});
	});

	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	// Set the moment the cap is crossed, synchronously within its handler: no later event can run
	// before it, so the timeout road below never starts a second reap of the same child.
	let overflowed = false;
	let killedForOverflow: Promise<void> | null = null;
	const overflow = (): void => {
		if (overflowed) return;
		overflowed = true;
		// Past the cap: killed now, not waited out to exit or the timeout.
		killedForOverflow = reap(child, closed, () => hasClosed);
	};

	child.stdout?.on("data", (chunk: Buffer) => {
		if (overflowed) return;
		stdoutBytes += chunk.length;
		if (stdoutBytes > options.maxBytes) {
			overflow();
			return;
		}
		stdoutChunks.push(chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		if (overflowed) return;
		stderrBytes += chunk.length;
		if (stderrBytes > options.maxBytes) {
			overflow();
			return;
		}
		stderrChunks.push(chunk);
	});

	let timerHandle: unknown;
	let result: { code: number | null; signal: string | null };
	try {
		// onSpawn, the stdin write and arming the timer all run here, so a throw from any of them,
		// or from settling (a genuine spawn-adjacent 'error', or the timeout), lands in the one catch.
		options.onSpawn?.(child);

		if (options.input !== undefined) {
			if (typeof options.input === "string") child.stdin?.end(options.input, "utf8");
			else child.stdin?.end(options.input);
		}

		const settled = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
			child.once("error", reject);
			closed.then(() => resolve({ code: closeCode, signal: closeSignal }));
		});
		const bounded = new Promise<never>((_, reject) => {
			timerHandle = options.timer.set(() => reject(new TimedOut()), options.timeoutMs);
		});

		result = await Promise.race([settled, bounded]);
	} catch (error) {
		await (killedForOverflow ?? reap(child, closed, () => hasClosed));
		return error instanceof TimedOut
			? { kind: "timedOut" }
			: { kind: "spawnFailed", error: error as NodeJS.ErrnoException };
	} finally {
		options.timer.clear(timerHandle);
	}
	if (killedForOverflow !== null) await killedForOverflow;
	if (overflowed) return { kind: "overflowed" };
	return {
		kind: "exited",
		code: result.code,
		signal: result.signal,
		stdout: Buffer.concat(stdoutChunks),
		stderr: Buffer.concat(stderrChunks),
	};
}
