import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DAEMON_STOPPING_MESSAGE } from "@nyaa-lexicon/protocol";
import type { DaemonSource } from "../discover";
import { ensureDaemon, ensureFailure } from "../ensure";
import { DaemonError, NotInstalled } from "../errors";
import type { LockDecision } from "../lock";
import { fakeDaemon } from "./fakeDaemon";

////////////////////////////////
//  Helpers

const LOCK = {
	port: 1234,
	token: "t",
	pid: 1,
	protocolVersion: "1.0.0",
	workspaceRoot: "/w",
	startedAt: 0,
};

/** Answers a scripted sequence of decisions, so "not there, then there" is expressible. */
function looking(sequence: LockDecision[]) {
	let index = 0;
	return () => sequence[Math.min(index++, sequence.length - 1)] as LockDecision;
}

/** A root holding a bundle, so spawning has a command to hand the injected `start`. */
let source: DaemonSource;

beforeAll(() => {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-ensure-"));
	mkdirSync(path.join(root, "dist"), { recursive: true });
	writeFileSync(path.join(root, "dist", "daemon.js"), "// bundle\n");
	source = { root, buildVersion: "1.10.2", bundleStamp: null };
});

afterAll(() => rmSync(source.root, { recursive: true, force: true }));

const options = {
	workspaceRoot: "/w",
	get source() {
		return source;
	},
	clock: { sleep: async () => {} },
	timeoutMs: 500,
	alive: () => true,
};

/** A real socket's round trip takes real time; racing it against an instant fake sleep would
 * always call it a timeout. Only the "over the wire" test, which asks a real fakeDaemon, needs this. */
const realSleeper = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

////////////////////////////////
//  Tests

describe("getting a daemon", () => {
	it("connects to one already running without starting anything", async () => {
		let started = 0;
		const result = await ensureDaemon({
			...options,
			look: looking([{ action: "connect", lock: LOCK }]),
			start: () => {
				started++;
			},
		});

		expect(result).toEqual({ connected: true, lock: LOCK });
		expect(started).toBe(0);
	});

	// The whole point: `spawn` was a decision nothing carried out, so every client quietly indexed
	// in its own process instead.
	it("starts one when none is registered, then connects to it", async () => {
		let started = 0;
		const result = await ensureDaemon({
			...options,
			look: looking([
				{ action: "spawn", reason: "no daemon is registered" },
				{ action: "spawn", reason: "still coming up" },
				{ action: "connect", lock: LOCK },
			]),
			start: () => {
				started++;
			},
		});

		expect(started).toBe(1);
		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	it("starts the bundle under the source it is given, against this workspace", async () => {
		const commands: string[][] = [];
		await ensureDaemon({
			...options,
			look: looking([
				{ action: "spawn", reason: "no daemon is registered" },
				{ action: "connect", lock: LOCK },
			]),
			start: (command) => {
				commands.push(command);
			},
		});

		expect(commands).toEqual([[process.execPath, path.join(source.root, "dist", "daemon.js"), "/w"]]);
	});

	it("uses the bundle when its bun is newer than the running bun", async () => {
		const bundled = path.join(source.root, "newer-bun");
		writeFileSync(bundled, "#!/bin/sh\necho 99.0.0\n", { mode: 0o755 });
		const commands: string[][] = [];
		await ensureDaemon({
			...options,
			bundledBun: bundled,
			look: looking([
				{ action: "spawn", reason: "no daemon is registered" },
				{ action: "connect", lock: LOCK },
			]),
			start: (command) => {
				commands.push(command);
			},
		});

		expect(commands.map((command) => command[0])).toEqual([bundled]);
	});

	it("refuses to start from a source that was never built, and says so", async () => {
		let started = 0;
		const result = await ensureDaemon({
			...options,
			source: { root: path.join(source.root, "nowhere"), buildVersion: "1.10.2", bundleStamp: null },
			look: looking([{ action: "spawn", reason: "no daemon is registered" }]),
			start: () => {
				started++;
			},
		});

		expect(started).toBe(0);
		expect(result).toMatchObject({
			connected: false,
			reason: "unbuilt",
			detail: expect.stringContaining("no built daemon"),
		});
	});

	it("gives up with a reason rather than waiting forever", async () => {
		const result = await ensureDaemon({
			...options,
			look: looking([{ action: "spawn", reason: "no daemon is registered" }]),
			start: () => undefined,
		});

		expect(result).toMatchObject({ connected: false });
		expect((result as { detail: string }).detail).toContain("did not publish a lock");
	});

	// Issue #7: a crashing daemon read as "did not publish a lock within 10000ms", every time,
	// whatever actually killed it.
	it("reports how the spawned daemon died instead of waiting out the clock", async () => {
		let looks = 0;
		const result = await ensureDaemon({
			...options,
			look: () => {
				looks++;
				return { action: "spawn", reason: "no daemon is registered" };
			},
			start: () => ({ death: () => "exited with code 3" }),
		});

		expect(result).toMatchObject({ connected: false });
		expect((result as { detail: string }).detail).toContain("exited with code 3");
		// Reported on the first poll, not after the full timeout's worth of looking.
		expect(looks).toBeLessThan(4);
	});

	it("keeps waiting while the spawned daemon is merely slow", async () => {
		const result = await ensureDaemon({
			...options,
			look: looking([
				{ action: "spawn", reason: "no daemon is registered" },
				{ action: "spawn", reason: "still coming up" },
				{ action: "connect", lock: LOCK },
			]),
			start: () => ({ death: () => null }),
		});

		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	// Callers ensure a daemon on every request, so this runs constantly. Spawning a second one
	// whenever the first is already up would put two writers on one index.
	it("never starts a second daemon while the first is answering", async () => {
		let started = 0;
		const start = () => {
			started++;
		};
		const look = looking([{ action: "connect", lock: LOCK }]);

		for (let call = 0; call < 5; call++) await ensureDaemon({ ...options, look, start });

		expect(started).toBe(0);
	});

	// Killing a daemon another session is using is not a call a client makes unprompted.
	it("refuses to take over a daemon serving someone else, and says why", async () => {
		let started = 0;
		let stopped = 0;
		const result = await ensureDaemon({
			...options,
			look: looking([
				{ action: "replace", lock: LOCK, reason: "the daemon serves /other", cause: "otherWorkspace" },
			]),
			start: () => {
				started++;
			},
			stop: () => {
				stopped++;
			},
		});

		expect(started).toBe(0);
		expect(stopped).toBe(0);
		expect(result).toEqual({ connected: false, reason: "otherWorkspace", detail: "the daemon serves /other" });
	});
});

// A daemon on our own workspace that cannot answer us is not somebody else's to protect: every
// session reaching it is as stuck as we are. Retiring it is still gated on evidence, since its
// transaction journal holds the only copy of what an undo would restore.
describe("retiring a daemon that cannot serve this workspace", () => {
	const stale: LockDecision = {
		action: "replace",
		lock: LOCK,
		reason: "the daemon runs 1.9.0, we run 1.10.2",
		cause: "build",
	};

	// Asked, never signalled, when asking is enough: the daemon settles its answers and drops its
	// own lock, which a signal would cut short.
	it("asks it to stop, then starts ours once its lock is gone, with no signal sent", async () => {
		const events: string[] = [];
		let started = 0;
		const result = await ensureDaemon({
			...options,
			// Gone by the time the ask's wait looks, and still gone when the spawn's wait looks again.
			look: looking([
				stale,
				{ action: "spawn", reason: "gone" },
				{ action: "spawn", reason: "gone" },
				{ action: "connect", lock: LOCK },
			]),
			ask: async (_lock, method) => {
				events.push(`ask:${method}`);
				return { open: false };
			},
			stop: (pid) => {
				events.push(`stop:${pid}`);
			},
			start: () => {
				started++;
			},
		});

		expect(events).toEqual(["ask:refactorStatus", "ask:shutdown"]);
		expect(started).toBe(1);
		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	// Through the real socket, not an injected ask: the daemon being retired is behind this major,
	// and the welcome check must not refuse the conversation that retires it.
	it("asks a daemon of an older protocol major to stop over the wire", async () => {
		const fake = await fakeDaemon({
			token: "t".repeat(32),
			protocolVersion: "1.0.0",
			answer: () => ({ ok: true, result: { open: false } }),
		});
		const older = { ...LOCK, port: fake.port, token: "t".repeat(32) };
		const events: string[] = [];
		try {
			const result = await ensureDaemon({
				...options,
				clock: realSleeper,
				look: looking([
					{
						action: "replace",
						lock: older,
						reason: "the daemon speaks 1.0.0, we speak 3.0.0",
						cause: "protocol",
					},
					{ action: "spawn", reason: "gone" },
					{ action: "spawn", reason: "gone" },
					{ action: "connect", lock: older },
				]),
				stop: (pid) => {
					events.push(`stop:${pid}`);
				},
				start: () => {
					events.push("start");
				},
			});

			expect(fake.asked).toEqual(["refactorStatus", "shutdown"]);
			expect(events).toEqual(["start"]);
			expect(result).toEqual({ connected: true, lock: older });
		} finally {
			await fake.close();
		}
	});

	// Its warmup failed, so it refuses the question; it could not have opened a transaction either.
	it("retires a daemon that refuses the question because its warmup failed", async () => {
		const events: string[] = [];
		const result = await ensureDaemon({
			...options,
			look: looking([
				stale,
				{ action: "spawn", reason: "gone" },
				{ action: "spawn", reason: "gone" },
				{ action: "connect", lock: LOCK },
			]),
			ask: async (_lock, method) => {
				events.push(`ask:${method}`);
				if (method === "refactorStatus")
					throw new Error("warmup failed: a provider was unavailable; restart the daemon");
				return { stopping: true };
			},
			stop: (pid) => {
				events.push(`stop:${pid}`);
			},
			start: () => {
				events.push("start");
			},
		});

		expect(events).toEqual(["ask:refactorStatus", "ask:shutdown", "start"]);
		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	// It already told us it is on its way out, so there is nothing left to ask and nothing to signal.
	it("waits for a daemon that already answers it is stopping, then starts ours", async () => {
		const events: string[] = [];
		let started = 0;
		const result = await ensureDaemon({
			...options,
			look: looking([
				stale,
				{ action: "spawn", reason: "gone" },
				{ action: "spawn", reason: "gone" },
				{ action: "connect", lock: LOCK },
			]),
			ask: async (_lock, method) => {
				events.push(`ask:${method}`);
				throw new Error(DAEMON_STOPPING_MESSAGE);
			},
			stop: (pid) => {
				events.push(`stop:${pid}`);
			},
			start: () => {
				started++;
			},
		});

		expect(events).toEqual(["ask:refactorStatus"]);
		expect(started).toBe(1);
		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	// The code is read first, so a build that changed its own prose is still recognized.
	it("waits on a typed stopping code even when the message itself does not match", async () => {
		const result = await ensureDaemon({
			...options,
			look: looking([
				stale,
				{ action: "spawn", reason: "gone" },
				{ action: "spawn", reason: "gone" },
				{ action: "connect", lock: LOCK },
			]),
			ask: async () => {
				throw new DaemonError("refused", "daemon", undefined, "stopping");
			},
			stop: () => {
				throw new Error("must not signal a daemon already on its way out");
			},
			start: () => {},
		});

		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	// The lock-lost refusal is a longer sentence that happens to end the same way; only an exact
	// match may read as "already stopping", or this case would wrongly wait instead of reconnecting.
	it("does not read the lock-lost refusal as a stopping daemon", async () => {
		let stopped = 0;
		const result = await ensureDaemon({
			...options,
			timeoutMs: 20,
			look: looking([stale]),
			ask: async () => {
				throw new Error("the workspace lock now names pid 4242; the daemon is stopping");
			},
			stop: () => {
				stopped++;
			},
			start: () => {},
		});

		expect(stopped).toBe(0);
		expect(result).toMatchObject({ connected: false, reason: "spawnFailed" });
	});

	it("refuses with a timeout, never spawnFailed, when a stopping daemon outlives the wait", async () => {
		const result = await ensureDaemon({
			...options,
			timeoutMs: 50,
			look: looking([stale]),
			ask: async () => {
				throw new Error(DAEMON_STOPPING_MESSAGE);
			},
			stop: () => {
				throw new Error("must not signal a daemon already on its way out");
			},
			start: () => {
				throw new Error("must not spawn while it still holds the lock");
			},
		});

		expect(result).toMatchObject({ connected: false, reason: "timeout" });
		expect(result.connected === false && result.detail).toContain("stopping");
	});

	// An ask that never answers must not eat the poll's share of the wait on top of its own.
	it("cuts an ask off inside the one budget instead of hanging on it", async () => {
		const result = await ensureDaemon({
			...options,
			timeoutMs: 20,
			look: looking([stale]),
			ask: () => new Promise(() => {}),
			stop: () => {},
			start: () => {},
		});

		expect(result).toMatchObject({ connected: false });
	});

	// A delete may claim the slot in the window between the old daemon clearing and this session
	// looking again; that is never a daemon to spawn over.
	it("waits out a delete that claims the lock once a stopping daemon clears, never spawning over it", async () => {
		const events: string[] = [];
		let started = 0;
		const deleting: LockDecision = {
			action: "awaitDelete",
			lock: { ...LOCK, port: 1 },
			reason: "pid 9999 is deleting /w right now",
		};
		const result = await ensureDaemon({
			...options,
			look: looking([
				stale,
				deleting,
				deleting,
				{ action: "spawn", reason: "gone" },
				{ action: "connect", lock: LOCK },
			]),
			ask: async (_lock, method) => {
				events.push(`ask:${method}`);
				throw new Error(DAEMON_STOPPING_MESSAGE);
			},
			stop: (pid) => {
				events.push(`stop:${pid}`);
			},
			start: () => {
				started++;
			},
		});

		expect(events).toEqual(["ask:refactorStatus"]);
		expect(result).toEqual({ connected: true, lock: LOCK });
		expect(started).toBe(1);
	});

	it("refuses rather than spawning over a delete that outlives the wait", async () => {
		let started = 0;
		const deleting: LockDecision = {
			action: "awaitDelete",
			lock: { ...LOCK, port: 1 },
			reason: "pid 9999 is deleting /w right now",
		};
		const result = await ensureDaemon({
			...options,
			timeoutMs: 20,
			look: looking([stale, deleting]),
			ask: async () => {
				throw new Error(DAEMON_STOPPING_MESSAGE);
			},
			stop: () => {},
			start: () => {
				started++;
				throw new Error("must not spawn over a delete in flight");
			},
		});

		expect(started).toBe(0);
		expect(result).toMatchObject({ connected: false, reason: "timeout" });
		expect(result.connected === false && result.detail).toContain("deleting");
	});

	it("falls back to the signal only once the lock has outlived the ask, and only after asking", async () => {
		const events: string[] = [];
		const afterSignal = looking([
			{ action: "spawn", reason: "gone" },
			{ action: "connect", lock: LOCK },
		]);
		const result = await ensureDaemon({
			...options,
			timeoutMs: 20,
			// Held until the signal lands, however long the graceful wait looks.
			look: () => (events.includes(`stop:${LOCK.pid}`) ? afterSignal() : stale),
			ask: async (_lock, method) => {
				events.push(`ask:${method}`);
				return { open: false };
			},
			stop: (pid) => {
				events.push(`stop:${pid}`);
			},
			start: () => {},
		});

		expect(events).toEqual(["ask:refactorStatus", "ask:shutdown", `stop:${LOCK.pid}`]);
		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	it("signals a daemon too old to know shutdown once the wait finds it still holding the lock", async () => {
		const events: string[] = [];
		const afterSignal = looking([
			{ action: "spawn", reason: "gone" },
			{ action: "connect", lock: LOCK },
		]);
		const result = await ensureDaemon({
			...options,
			timeoutMs: 20,
			// The refused ask proves nothing about the lock; only the wait does, so it is held here.
			look: () => (events.includes(`stop:${LOCK.pid}`) ? afterSignal() : stale),
			ask: async (_lock, method) => {
				events.push(`ask:${method}`);
				if (method === "shutdown") throw new Error("unknown method: shutdown");
				return { open: false };
			},
			stop: (pid) => {
				events.push(`stop:${pid}`);
			},
			start: () => {},
		});

		expect(events).toEqual(["ask:refactorStatus", "ask:shutdown", `stop:${LOCK.pid}`]);
		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	it("sends no signal when the lock goes on its own after a refused ask", async () => {
		const events: string[] = [];
		const result = await ensureDaemon({
			...options,
			look: looking([stale, { action: "spawn", reason: "gone" }, { action: "connect", lock: LOCK }]),
			ask: async (_lock, method) => {
				events.push(`ask:${method}`);
				if (method === "shutdown") throw new Error("unknown method: shutdown");
				return { open: false };
			},
			stop: (pid) => {
				events.push(`stop:${pid}`);
			},
			start: () => {},
		});

		expect(events).toEqual(["ask:refactorStatus", "ask:shutdown"]);
		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	it("leaves it alone while a refactor transaction is open on it", async () => {
		let stopped = 0;
		const result = await ensureDaemon({
			...options,
			look: looking([stale]),
			ask: async () => ({ open: true }),
			stop: () => {
				stopped++;
			},
			start: () => {},
		});

		expect(stopped).toBe(0);
		expect(result).toMatchObject({ connected: false });
		expect(result.connected === false && result.detail).toMatch(/refactor transaction is open/);
	});

	// An unclear answer is the one case we can reason least about, so it must not read as consent.
	it("leaves alone a daemon too old to answer the question", async () => {
		let stopped = 0;
		const result = await ensureDaemon({
			...options,
			look: looking([stale]),
			ask: async () => {
				throw new Error("unknown method: refactorStatus");
			},
			stop: () => {
				stopped++;
			},
			start: () => {},
		});

		expect(stopped).toBe(0);
		expect(result.connected === false && result.detail).toMatch(/would not say/);
	});

	it("leaves alone a daemon whose answer has no open flag at all", async () => {
		let stopped = 0;
		const result = await ensureDaemon({
			...options,
			look: looking([stale]),
			ask: async () => ({ steps: [] }),
			stop: () => {
				stopped++;
			},
			start: () => {},
		});

		expect(stopped).toBe(0);
		expect(result.connected === false && result.detail).toMatch(/did not answer/);
	});

	// A signal sent on the old number lands on whoever wears it now, so a holder that stopped being
	// itself between the lock read and the kill must not be signalled, even when the ask changed nothing.
	it("never signals a pid that is no longer the daemon that wrote the lock", async () => {
		const stopped: number[] = [];
		await ensureDaemon({
			...options,
			timeoutMs: 20,
			look: looking([stale]),
			ask: async () => ({ open: false }),
			alive: () => false,
			stop: (pid) => {
				stopped.push(pid);
			},
			start: () => undefined,
		});

		expect(stopped).toEqual([]);
	});

	// Spawning over an unreleased lock hands the newcomer a claim it must lose; refusing names the
	// actual holdout instead of reporting the newcomer's confusion as ours.
	it("refuses to spawn while the stopped daemon still holds its lock", async () => {
		let started = 0;
		const result = await ensureDaemon({
			...options,
			timeoutMs: 20,
			look: looking([stale]),
			ask: async () => ({ open: false }),
			stop: () => {},
			start: () => {
				started++;
				return undefined;
			},
		});

		expect(started).toBe(0);
		expect(result.connected === false && result.detail).toMatch(/still holds the lock/);
	});

	it("connects instead when someone else replaced it first", async () => {
		let started = 0;
		const result = await ensureDaemon({
			...options,
			look: looking([stale, { action: "connect", lock: LOCK }]),
			ask: async () => ({ open: false }),
			stop: () => {},
			start: () => {
				started++;
				return undefined;
			},
		});

		expect(started).toBe(0);
		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	it("retires a protocol mismatch on our workspace too, not just a build one", async () => {
		const asked: string[] = [];
		await ensureDaemon({
			...options,
			look: looking([
				{ action: "replace", lock: LOCK, reason: "wrong protocol", cause: "protocol" },
				{ action: "spawn", reason: "gone" },
				{ action: "connect", lock: LOCK },
			]),
			ask: async (_lock, method) => {
				asked.push(method);
				return { open: false };
			},
			stop: () => {},
			start: () => {},
		});

		expect(asked).toEqual(["refactorStatus", "shutdown"]);
	});
});

// A delete's lock is never a daemon: no port to dial, no transaction to protect.
describe("waiting out a delete instead of touching its placeholder lock", () => {
	const deleting: LockDecision = {
		action: "awaitDelete",
		lock: { ...LOCK, port: 1 },
		reason: "pid 9999 is deleting /w right now",
	};

	it("waits for the delete to clear, then spawns, with nothing asked or signalled", async () => {
		const events: string[] = [];
		let started = 0;
		const result = await ensureDaemon({
			...options,
			look: looking([deleting, deleting, { action: "spawn", reason: "gone" }, { action: "connect", lock: LOCK }]),
			ask: async (_lock, method) => {
				events.push(`ask:${method}`);
				return { open: false };
			},
			stop: (pid) => {
				events.push(`stop:${pid}`);
			},
			start: () => {
				started++;
			},
		});

		expect(events).toEqual([]);
		expect(started).toBe(1);
		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	it("connects straight away when someone else's daemon already answers by the next look", async () => {
		const result = await ensureDaemon({
			...options,
			look: looking([deleting, { action: "connect", lock: LOCK }]),
			start: () => {
				throw new Error("must not spawn while a daemon already answers");
			},
		});

		expect(result).toEqual({ connected: true, lock: LOCK });
	});

	it("refuses with a timeout, never spawnFailed, when the delete outlives the wait", async () => {
		const result = await ensureDaemon({
			...options,
			timeoutMs: 50,
			look: looking([deleting]),
			start: () => {
				throw new Error("must not spawn over a delete still in flight");
			},
		});

		expect(result).toMatchObject({ connected: false, reason: "timeout" });
		expect(result.connected === false && result.detail).toContain("deleting");
	});

	// A poll that does not divide the timeout evenly must never push the real wait past it.
	it("never waits past the timeout, even when the poll does not divide it evenly", async () => {
		const waits: number[] = [];
		const result = await ensureDaemon({
			...options,
			timeoutMs: 250,
			clock: {
				sleep: async (ms) => {
					waits.push(ms);
				},
			},
			look: looking([deleting]),
			start: () => {
				throw new Error("must not spawn over a delete still in flight");
			},
		});

		expect(result).toMatchObject({ connected: false, reason: "timeout" });
		expect(waits.reduce((total, ms) => total + ms, 0)).toBe(250);
	});
});

// A consumer with no install rides whatever daemon serves it. It has no build to spawn and none to
// put in a retired daemon's place, so it never touches one.
describe("with no install known", () => {
	const missing = new NotInstalled("no lexicon is installed here");

	it("rides a daemon already running without starting anything", async () => {
		let started = 0;
		const result = await ensureDaemon({
			...options,
			source: missing,
			look: looking([{ action: "connect", lock: LOCK }]),
			start: () => {
				started++;
			},
		});

		expect(result).toEqual({ connected: true, lock: LOCK });
		expect(started).toBe(0);
	});

	it("reports nothing installed instead of spawning when no daemon runs", async () => {
		let started = 0;
		const result = await ensureDaemon({
			...options,
			source: missing,
			look: looking([{ action: "spawn", reason: "no daemon is registered" }]),
			start: () => {
				started++;
			},
		});

		expect(result).toMatchObject({ connected: false, reason: "notInstalled", root: undefined });
		expect(result.connected === false && result.detail).toBe(
			"no lexicon is installed here, and no daemon is registered",
		);
		expect(started).toBe(0);
	});

	it("leaves a daemon it cannot use untouched: nothing asked, signalled or started", async () => {
		const asked: string[] = [];
		let signalled = 0;
		let started = 0;
		const result = await ensureDaemon({
			...options,
			source: missing,
			look: looking([
				{
					action: "replace",
					lock: LOCK,
					reason: "the daemon speaks 0.9.0, older than this client's 1.0.0",
					cause: "protocol",
				},
			]),
			ask: async (_lock, method) => {
				asked.push(method);
				return {};
			},
			stop: () => {
				signalled++;
			},
			start: () => {
				started++;
			},
		});

		expect(result).toMatchObject({ connected: false, reason: "notInstalled" });
		expect({ asked, signalled, started }).toEqual({ asked: [], signalled: 0, started: 0 });
	});

	it("still names another workspace's daemon as that, not as nothing installed", async () => {
		const result = await ensureDaemon({
			...options,
			source: missing,
			look: looking([
				{ action: "replace", lock: LOCK, reason: "the daemon serves /other", cause: "otherWorkspace" },
			]),
		});

		expect(result).toMatchObject({ connected: false, reason: "otherWorkspace" });
	});

	it("becomes NotInstalled carrying the root the install was expected at", async () => {
		const result = await ensureDaemon({
			...options,
			source: () => new NotInstalled("not where lexicon was last seen: /gone", "/gone"),
			look: looking([{ action: "spawn", reason: "pid 9 is gone" }]),
		});

		expect(result).toMatchObject({ connected: false, reason: "notInstalled", root: "/gone" });
		if (result.connected) throw new Error("expected a refusal");
		const error = ensureFailure(result);
		expect(error).toBeInstanceOf(NotInstalled);
		expect(error).toMatchObject({
			root: "/gone",
			message: "not where lexicon was last seen: /gone, and pid 9 is gone",
		});
	});
});
