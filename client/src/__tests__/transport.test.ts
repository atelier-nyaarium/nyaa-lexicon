import { afterEach, describe, expect, it } from "bun:test";
import { DaemonError, Incompatible } from "../errors";
import { connectFrames, notifyWaiting } from "../transport";
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
