import { afterEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { killLiveGroups, liveGroupCount, runBounded, systemTimer } from "../boundedChild";

////////////////////////////////
//  Functions & Helpers

/**
 * A killed grandchild leaves a zombie until its adoptive reaper (init) waits on it, which is not
 * bounded by anything this module controls. Polls signal 0 instead of asserting it once, so system
 * load widening that window is not read as the group surviving.
 */
async function expectGroupGone(pid: number, withinMs = 2_000): Promise<void> {
	const deadline = Date.now() + withinMs;
	for (;;) {
		try {
			process.kill(-pid, 0);
		} catch {
			return;
		}
		if (Date.now() >= deadline) throw new Error(`process group ${pid} still answers signal 0 after ${withinMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

////////////////////////////////
//  Tests

describe("runBounded", () => {
	// Every terminal path removes what it added, whichever it was: spawnFailed before anything was
	// tracked, a clean exit through `closed`, or a reap through the timeout or the cap.
	afterEach(() => {
		expect(liveGroupCount()).toBe(0);
	});

	it("answers within the timeout for a command that exits cleanly, not only for one that hangs", async () => {
		const result = await runBounded("sh", ["-c", "exit 0"], {
			maxBytes: 1024,
			timeoutMs: 5_000,
			timer: systemTimer,
		});
		expect(result).toEqual({
			kind: "exited",
			code: 0,
			signal: null,
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
		});
	});

	it("carries stdin through to the child and captures a non-zero exit code", async () => {
		const result = await runBounded("sh", ["-c", "cat; exit 3"], {
			input: "hello",
			maxBytes: 1024,
			timeoutMs: 5_000,
			timer: systemTimer,
		});
		expect(result).toEqual({
			kind: "exited",
			code: 3,
			signal: null,
			stdout: Buffer.from("hello"),
			stderr: Buffer.alloc(0),
		});
	});

	/**
	 * The proven bug class: a synchronous exec can lose a child's exit under load and busy-wait
	 * forever with a defunct process beneath it. This is the fix's own test, over a real process
	 * standing in for a wedged child.
	 */
	it("is killed at the timeout, answers timedOut, and its exit is awaited rather than left defunct", async () => {
		let reaped = false;
		const result = await runBounded("sleep", ["999"], {
			maxBytes: 1024,
			timeoutMs: 200,
			timer: systemTimer,
			onSpawn: (child) => {
				child.once("close", () => {
					reaped = true;
				});
			},
		});

		expect(result).toEqual({ kind: "timedOut" });
		expect(reaped).toBe(true);
	}, 10_000);

	/**
	 * A second bug class in the same fix: `close` fires once, and `error` fires first for a command
	 * that cannot even be spawned, so a reap registered only after that already left nothing to await.
	 */
	it("answers spawnFailed rather than hanging for a command that cannot be spawned at all", async () => {
		let reaped = false;
		const result = await runBounded("lexicon-test-nonexistent-executable", [], {
			maxBytes: 1024,
			timeoutMs: 5_000,
			timer: systemTimer,
			onSpawn: (child) => {
				child.once("close", () => {
					reaped = true;
				});
			},
		});

		expect(result.kind).toBe("spawnFailed");
		expect(result.kind === "spawnFailed" && result.error.code).toBe("ENOENT");
		expect(reaped).toBe(true);
	});

	/**
	 * Past the cap the child is killed at once, not waited out to its own exit or the timeout.
	 */
	it("kills a child that prints past a small cap then sleeps, well inside the test's own bound", async () => {
		let reaped = false;
		const result = await runBounded("sh", ["-c", "printf 'xxxxxxxxxx'; sleep 999"], {
			maxBytes: 4,
			timeoutMs: 5_000,
			timer: systemTimer,
			onSpawn: (child) => {
				child.once("close", () => {
					reaped = true;
				});
			},
		});

		expect(result).toEqual({ kind: "overflowed" });
		expect(reaped).toBe(true);
	}, 10_000);

	/**
	 * reap() must kill the whole group whenever close has not fired, never only while the direct
	 * child is still alive: a backgrounded grandchild inheriting the pipe outlives the parent's own
	 * exit, and this one never dies on its own, so only a genuine group kill lets this resolve.
	 */
	it("kills the whole process group within the timeout, even though the direct child exits at once", async () => {
		let reaped = false;
		let pid: number | undefined;

		const result = await runBounded("sh", ["-c", "sleep 999 & exit 0"], {
			maxBytes: 1024,
			timeoutMs: 300,
			timer: systemTimer,
			onSpawn: (child) => {
				pid = child.pid;
				child.once("close", () => {
					reaped = true;
				});
			},
		});

		expect(result).toEqual({ kind: "timedOut" });
		expect(reaped).toBe(true);
		expect(pid).toBeDefined();
		// The grandchild inherited the same group; signal 0 stops answering once nothing remains.
		await expectGroupGone(pid as number);
	}, 10_000);

	it("kills every live group killLiveGroups still tracks, from outside the run that owns it", async () => {
		let pid: number | undefined;
		const call = runBounded("sleep", ["999"], {
			maxBytes: 1024,
			timeoutMs: 60_000,
			timer: systemTimer,
			onSpawn: (child) => {
				pid = child.pid;
			},
		});
		// Real time for the spawn to land before the group is killed out from under the wait.
		await new Promise((resolve) => setTimeout(resolve, 100));
		killLiveGroups();

		const result = await call;
		expect(result.kind).toBe("exited");
		expect(result.kind === "exited" && result.signal).toBe("SIGKILL");
		expect(pid).toBeDefined();
		await expectGroupGone(pid as number);
	}, 10_000);

	/**
	 * An EPIPE writing to a child that already exited must not surface as an unhandled 'error' on
	 * the stdin stream: that crashes the whole process, not merely this call, which is why the
	 * proof is that the run answers at all.
	 */
	it("does not crash when a large stdin write hits a child that has already exited", async () => {
		const result = await runBounded("sh", ["-c", "exit 0"], {
			input: Buffer.alloc(20 * 1024 * 1024, 65),
			maxBytes: 1024,
			timeoutMs: 5_000,
			timer: systemTimer,
		});

		expect(result).toEqual({
			kind: "exited",
			code: 0,
			signal: null,
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
		});
	});

	it("answers exited with the signal when something outside kills the child directly", async () => {
		let pid: number | undefined;
		const call = runBounded("sleep", ["999"], {
			maxBytes: 1024,
			timeoutMs: 60_000,
			timer: systemTimer,
			onSpawn: (child) => {
				pid = child.pid;
			},
		});
		// Real time for the spawn to land before the outside kill targets it.
		await new Promise((resolve) => setTimeout(resolve, 100));
		process.kill(pid as number, "SIGTERM");

		const result = await call;
		expect(result).toEqual({
			kind: "exited",
			code: null,
			signal: "SIGTERM",
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
		});
	});

	it("kills a child that prints past a small cap on stderr, not only on stdout", async () => {
		let reaped = false;
		const result = await runBounded("sh", ["-c", "printf 'xxxxxxxxxx' 1>&2; sleep 999"], {
			maxBytes: 4,
			timeoutMs: 5_000,
			timer: systemTimer,
			onSpawn: (child) => {
				child.once("close", () => {
					reaped = true;
				});
			},
		});

		expect(result).toEqual({ kind: "overflowed" });
		expect(reaped).toBe(true);
	}, 10_000);

	it("answers spawnFailed with EACCES for a file that cannot be executed", async () => {
		const file = path.join(tmpdir(), `lexicon-noexec-${Date.now()}`);
		writeFileSync(file, "not a script\n", { mode: 0o644 });
		try {
			const result = await runBounded(file, [], { maxBytes: 1024, timeoutMs: 5_000, timer: systemTimer });

			expect(result.kind).toBe("spawnFailed");
			expect(result.kind === "spawnFailed" && result.error.code).toBe("EACCES");
		} finally {
			rmSync(file, { force: true });
		}
	});

	it("settles cleanly however a very short timeout lands against a fast, natural exit", async () => {
		for (let i = 0; i < 20; i++) {
			const result = await runBounded("sh", ["-c", "exit 0"], {
				maxBytes: 1024,
				timeoutMs: 1,
				timer: systemTimer,
			});
			expect(["exited", "timedOut"]).toContain(result.kind);
		}
	}, 10_000);
});
