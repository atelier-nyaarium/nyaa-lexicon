import { afterEach, describe, expect, it } from "bun:test";
import { DaemonError, Incompatible } from "../errors";
import { connectFrames } from "../transport";
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
});

describe("patience with a starting daemon", () => {
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
