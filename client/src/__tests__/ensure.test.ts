import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaemonSource } from "../discover";
import { ensureDaemon } from "../ensure";
import type { LockDecision } from "../lock";

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
		expect(result.connected === false && result.reason).toMatch(/no built daemon/);
	});

	it("gives up with a reason rather than waiting forever", async () => {
		const result = await ensureDaemon({
			...options,
			look: looking([{ action: "spawn", reason: "no daemon is registered" }]),
			start: () => undefined,
		});

		expect(result).toMatchObject({ connected: false });
		expect((result as { reason: string }).reason).toContain("did not publish a lock");
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
		expect((result as { reason: string }).reason).toContain("exited with code 3");
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
		expect(result).toEqual({ connected: false, reason: "the daemon serves /other" });
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

	it("falls back to the signal only once the lock has outlived the ask, and only after asking", async () => {
		const events: string[] = [];
		const afterSignal = looking([
			{ action: "spawn", reason: "gone" },
			{ action: "connect", lock: LOCK },
		]);
		const result = await ensureDaemon({
			...options,
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
		expect(result.connected === false && result.reason).toMatch(/refactor transaction is open/);
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
		expect(result.connected === false && result.reason).toMatch(/would not say/);
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
		expect(result.connected === false && result.reason).toMatch(/did not answer/);
	});

	// A signal sent on the old number lands on whoever wears it now, so a holder that stopped being
	// itself between the lock read and the kill must not be signalled, even when the ask changed nothing.
	it("never signals a pid that is no longer the daemon that wrote the lock", async () => {
		const stopped: number[] = [];
		await ensureDaemon({
			...options,
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
			look: looking([stale]),
			ask: async () => ({ open: false }),
			stop: () => {},
			start: () => {
				started++;
				return undefined;
			},
		});

		expect(started).toBe(0);
		expect(result.connected === false && result.reason).toMatch(/still holds the lock/);
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
