import { describe, expect, it } from "vitest";
import { ensureDaemon } from "../ensureDaemon";
import type { LockDecision } from "../lockFile";

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

const options = {
	workspaceRoot: "/w",
	wait: async () => {},
	timeoutMs: 500,
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

	it("gives up with a reason rather than waiting forever", async () => {
		const result = await ensureDaemon({
			...options,
			look: looking([{ action: "spawn", reason: "no daemon is registered" }]),
			start: () => {},
		});

		expect(result).toMatchObject({ connected: false });
		expect((result as { reason: string }).reason).toContain("did not publish a lock");
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
		const result = await ensureDaemon({
			...options,
			look: looking([{ action: "replace", lock: LOCK, reason: "the daemon serves /other" }]),
			start: () => {
				started++;
			},
		});

		expect(started).toBe(0);
		expect(result).toEqual({ connected: false, reason: "the daemon serves /other" });
	});
});
