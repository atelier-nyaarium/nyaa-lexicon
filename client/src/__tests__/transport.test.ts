import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Socket } from "node:net";
import { DaemonError, Incompatible } from "../errors";
import { connectFrames, notifyWaiting, requestOnce } from "../transport";
import { type FakeAnswer, type FakeDaemon, fakeDaemon } from "./fakeDaemon";

////////////////////////////////
//  Helpers

const TOKEN = "t".repeat(32);

const STARTING: FakeAnswer = {
	ok: false,
	error: "the daemon is starting, waiting on the language providers to start",
	starting: true,
	retryInMs: 60_000,
	waitingFor: "the language providers to start",
};

const fakes: FakeDaemon[] = [];

async function daemonAnswering(answer: FakeDaemonAnswer, protocolVersion?: string): Promise<FakeDaemon> {
	const fake = await fakeDaemon({
		token: TOKEN,
		answer,
		...(protocolVersion === undefined ? {} : { protocolVersion }),
	});
	fakes.push(fake);
	return fake;
}

type FakeDaemonAnswer = Parameters<typeof fakeDaemon>[0]["answer"];

async function settledAt(fake: FakeDaemon, want: number): Promise<number> {
	for (let waited = 0; waited < 2_000 && fake.connections() !== want; waited += 20) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return fake.connections();
}

afterEach(async () => {
	for (const fake of fakes.splice(0)) await fake.close();
});

////////////////////////////////
//  Tests

describe("the welcome check", () => {
	// The lock's rule, applied again at the socket, so a direct connection cannot skip it.
	it("refuses a daemon greeting with a lower major, naming both versions, and closes the socket", async () => {
		const fake = await daemonAnswering(() => ({ ok: true, result: null }), "1.0.0");

		const refused = connectFrames(fake.port, TOKEN);

		await expect(refused).rejects.toThrow(Incompatible);
		await expect(refused).rejects.toMatchObject({ installed: "1.0.0", client: expect.stringMatching(/^\d/) });
		expect(await settledAt(fake, 0)).toBe(0);
	});

	it("rides a daemon greeting with a higher major", async () => {
		const fake = await daemonAnswering(() => ({ ok: true, result: "served" }), "99.0.0");

		const client = await connectFrames(fake.port, TOKEN);
		await expect(client.request("overview", {})).resolves.toBe("served");
		client.close();
	});

	// Retirement is the one conversation with an older daemon, and it must be able to happen.
	it("accepts a lower major when the caller is retiring it", async () => {
		const fake = await daemonAnswering(() => ({ ok: true, result: { open: false } }), "1.0.0");

		const client = await connectFrames(fake.port, TOKEN, { acceptOlder: true });
		await expect(client.request("refactorStatus", {})).resolves.toEqual({ open: false });
		client.close();
	});
});

describe("patience with a starting daemon", () => {
	it("does not let waiting callbacks reject or throw into the request", () => {
		const events: string[] = [];
		notifyWaiting(
			() => {
				throw new Error("ignored");
			},
			{ waitingFor: "index", retryInMs: 0, elapsedMs: 0 },
		);
		notifyWaiting(() => Promise.reject(new Error("ignored")), {
			waitingFor: "providers",
			retryInMs: 0,
			elapsedMs: 0,
		});
		notifyWaiting(() => void events.push("continued"), { waitingFor: "done", retryInMs: 0, elapsedMs: 0 });
		expect(events).toEqual(["continued"]);
	});

	it("keeps asking while the daemon says it still needs time, then takes the answer", async () => {
		let answered = 0;
		const fake = await daemonAnswering(() => (answered++ < 2 ? STARTING : { ok: true, result: "warm" }));

		const client = await connectFrames(fake.port, TOKEN);
		await expect(client.request("overview", {})).resolves.toBe("warm");
		expect(fake.asked).toHaveLength(3);
		client.close();
	});

	it("gives up at its own patience before the daemon's countdown, naming what it waited on", async () => {
		const fake = await daemonAnswering(() => STARTING);
		const client = await connectFrames(fake.port, TOKEN, { patience: 300 });

		const started = Date.now();
		const failed = client.request("overview", {});
		await expect(failed).rejects.toThrow(DaemonError);
		await expect(failed).rejects.toMatchObject({ waitingFor: "the language providers to start" });

		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(250);
		expect(elapsed).toBeLessThan(5_000);
		expect(fake.asked.length).toBeGreaterThanOrEqual(2);
		client.close();
	});

	it("asks exactly once with no patience at all", async () => {
		const fake = await daemonAnswering(() => STARTING);
		const client = await connectFrames(fake.port, TOKEN, { patience: 0 });

		await expect(client.request("overview", {})).rejects.toThrow(DaemonError);
		expect(fake.asked).toHaveLength(1);
		client.close();
	});
});

describe("answer budgets", () => {
	it("fails only the late request: the socket stays open, the late reply is dropped, later requests answer", async () => {
		const fake = await daemonAnswering((method) =>
			method === "cacheStats"
				? { ok: true, result: "now" }
				: new Promise((resolve) => setTimeout(() => resolve({ ok: true, result: "late" }), 150)),
		);
		const client = await connectFrames(fake.port, TOKEN, { budgetMs: () => 50 });

		const [read, write] = await Promise.allSettled([
			client.request("overview", {}),
			client.request("refactorCommit", {}),
		]);
		const failure = (outcome: PromiseSettledResult<unknown>) =>
			outcome.status === "rejected"
				? { cause: outcome.reason.cause, unknown: outcome.reason.message.includes("outcome is unknown") }
				: "answered";
		expect([failure(read), failure(write)]).toEqual([
			{ cause: "requestTimeout", unknown: false },
			{ cause: "requestTimeout", unknown: true },
		]);
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(client.closed).toBe(false);
		await expect(client.request("cacheStats", {})).resolves.toBe("now");
		expect(fake.asked).toEqual(["overview", "refactorCommit", "cacheStats"]);
		client.close();
	});
});

describe("daemon refusal causes", () => {
	it("recognizes the dispatcher's module refusal prefix", async () => {
		const fake = await daemonAnswering(() => ({
			ok: false,
			error: "overview refused: within.filter: module path must stay inside the workspace",
		}));
		const client = await connectFrames(fake.port, TOKEN);

		await expect(client.request("overview", {})).rejects.toMatchObject({ cause: "refusedModule" });
		client.close();
	});

	it("does not classify a handler message that only quotes the refusal words", async () => {
		const fake = await daemonAnswering(() => ({
			ok: false,
			error: "handler failed: within filter echoes 'module path must stay inside the workspace'",
		}));
		const client = await connectFrames(fake.port, TOKEN);

		await expect(client.request("overview", {})).rejects.toMatchObject({ cause: "daemon" });
		client.close();
	});
});

describe("aborting", () => {
	it("closes a socket still waiting on its welcome, and opens none once aborted", async () => {
		const sockets: Socket[] = [];
		const silent = createServer((socket) => {
			sockets.push(socket);
			socket.on("error", () => socket.destroy());
			socket.resume();
		});
		await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
		const { port } = silent.address() as { port: number };
		try {
			const abort = new AbortController();
			const handshake = connectFrames(port, TOKEN, { signal: abort.signal });
			while (sockets.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
			const closed = new Promise((resolve) => sockets[0]?.once("close", resolve));
			abort.abort();

			await expect(handshake).rejects.toThrow();
			await closed;
			await expect(connectFrames(port, TOKEN, { signal: abort.signal })).rejects.toThrow();
			expect(sockets).toHaveLength(1);
		} finally {
			await new Promise((resolve) => silent.close(resolve));
		}
	});

	it("closes a one-shot request mid-answer", async () => {
		const fake = await daemonAnswering(() => new Promise<never>(() => {}));
		const abort = new AbortController();

		const asked = requestOnce(fake.port, TOKEN, "overview", {}, { signal: abort.signal });
		while (fake.asked.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		abort.abort();

		await expect(asked).rejects.toThrow();
		expect(await settledAt(fake, 0)).toBe(0);
	});
});
