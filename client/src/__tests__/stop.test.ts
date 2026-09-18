import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DAEMON_STOPPING_MESSAGE } from "@nyaa-lexicon/protocol";
import { DaemonError } from "../errors";
import { requestShutdown, shutdownDaemon } from "../stop";
import { type FakeDaemon, fakeDaemon, ownLock } from "./fakeDaemon";

////////////////////////////////
//  Helpers

const TOKEN = "t".repeat(32);

let dir: string;
let lockFile: string;
const fakes: FakeDaemon[] = [];

// A real socket's round trip takes real time; racing it against an instant fake sleep would
// always call it a timeout, so every test here waits on a real (small) clock instead.
const realSleeper = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-stop-"));
	lockFile = path.join(dir, "daemon.json");
});

afterEach(async () => {
	for (const fake of fakes.splice(0)) await fake.close();
	rmSync(dir, { recursive: true, force: true });
});

async function daemon(answer: Parameters<typeof fakeDaemon>[0]["answer"]) {
	const fake = await fakeDaemon({ token: TOKEN, answer });
	fakes.push(fake);
	const lock = ownLock({
		port: fake.port,
		token: TOKEN,
		workspaceRoot: "/w",
		buildVersion: "1.0.0",
		bundleStamp: null,
	});
	writeFileSync(lockFile, JSON.stringify(lock));
	return { fake, lock };
}

////////////////////////////////
//  Tests

describe("asking a daemon to stop", () => {
	it("reports stopped once the ask lands and the lock clears", async () => {
		const { lock } = await daemon(() => {
			rmSync(lockFile, { force: true });
			return { ok: true, result: { stopping: true } };
		});

		const result = await requestShutdown(lock, lockFile, { timeoutMs: 300, clock: realSleeper });

		expect(result).toEqual({ outcome: "stopped" });
	});

	// A large watcher batch finishing under its own gate: the ask succeeded, the lock just has not
	// gone yet. Not a refusal.
	it("reports stopping, not refused, when an acknowledged ask outlives the wait", async () => {
		const { lock } = await daemon(() => ({ ok: true, result: { stopping: true } }));

		const result = await requestShutdown(lock, lockFile, { timeoutMs: 150, clock: realSleeper });

		expect(result.outcome).toBe("stopping");
		expect(result.outcome !== "stopped" && result.detail).toContain("still holds");
	});

	// Someone else already asked it: the daemon's own refusal is itself the evidence of a stop in
	// progress, not proof nothing was ever asked.
	it("reports stopping when the daemon answers that it is already stopping", async () => {
		const { lock } = await daemon(() => ({ ok: false, error: DAEMON_STOPPING_MESSAGE }));

		const result = await requestShutdown(lock, lockFile, { timeoutMs: 150, clock: realSleeper });

		expect(result.outcome).toBe("stopping");
	});

	it("reports refused when the ask fails for any other reason and the lock persists", async () => {
		const { lock } = await daemon(() => ({ ok: false, error: "unknown method: shutdown" }));

		const result = await requestShutdown(lock, lockFile, { timeoutMs: 150, clock: realSleeper });

		expect(result.outcome).toBe("refused");
		expect(result.outcome !== "stopped" && result.detail).toContain("could not be asked");
	});

	// shutdownDaemon keeps its own throwing contract for a session's stopDaemon(), whichever way
	// requestShutdown classified the wait.
	it("still throws a DaemonError on anything but stopped", async () => {
		const { lock } = await daemon(() => ({ ok: false, error: "unknown method: shutdown" }));

		await expect(shutdownDaemon(lock, lockFile, { timeoutMs: 150, clock: realSleeper })).rejects.toThrow(
			DaemonError,
		);
	});

	// A daemon that never answers must not eat the poll's share of the wait on top of its own.
	it("cuts a hung ask off inside the one budget instead of hanging on it", async () => {
		const { lock } = await daemon(() => new Promise(() => {}));

		const result = await requestShutdown(lock, lockFile, { timeoutMs: 150, clock: realSleeper });

		expect(result.outcome).toBe("refused");
	});

	// A fresh daemon may have already claimed the lock by the time this one's token is gone; the
	// tool must never read that as nothing serving the project.
	it("names who replaced it, when a fresh daemon already claims the lock", async () => {
		const { lock } = await daemon(() => {
			const fresh = ownLock({
				port: 1,
				token: "f".repeat(32),
				workspaceRoot: "/w",
				buildVersion: "1.0.0",
				bundleStamp: null,
			});
			writeFileSync(lockFile, JSON.stringify({ ...fresh, pid: 9999 }));
			return { ok: true, result: { stopping: true } };
		});

		const result = await requestShutdown(lock, lockFile, { timeoutMs: 300, clock: realSleeper });

		expect(result.outcome).toBe("stopped");
		expect(result.outcome === "stopped" && result.detail).toContain("pid 9999");
	});

	// A delete's placeholder lock names no daemon at all, so it must never read as a replacement.
	it("does not read a delete's placeholder lock as a replacement", async () => {
		const { lock } = await daemon(() => {
			writeFileSync(
				lockFile,
				JSON.stringify({ ...lock, token: "d".repeat(32), pid: 4242, role: "delete", workspaceRoot: dir }),
			);
			return { ok: true, result: { stopping: true } };
		});

		const result = await requestShutdown(lock, lockFile, { timeoutMs: 300, clock: realSleeper });

		expect(result).toEqual({ outcome: "stopped" });
	});
});
