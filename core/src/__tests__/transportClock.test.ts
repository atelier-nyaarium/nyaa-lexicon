import { afterEach, describe, expect, it } from "bun:test";
import { connect as netConnect, type Socket } from "node:net";
import { HELLO_DEADLINE_MS } from "@nyaa-lexicon/protocol";
import { type FrameServer, serveFrames } from "../socketTransport";
import { type FakeClock, fakeClock } from "./fakeClock";

////////////////////////////////
//  Helpers

const TOKEN = "0123456789abcdef0123456789abcdef";
const HEARTBEAT_MS = 1_000;

let server: FrameServer | undefined;
let clock: FakeClock;

async function serve(): Promise<FrameServer> {
	clock = fakeClock(1_000_000);
	server = await serveFrames({
		token: TOKEN,
		handle: async () => ({}),
		clock,
		heartbeatMs: HEARTBEAT_MS,
		missedLimit: 2,
	});
	return server;
}

function rawConnect(port: number, heard: string[]): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ port, host: "127.0.0.1" });
		socket.on("data", (chunk) => heard.push(chunk.toString()));
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

function closedOf(socket: Socket): Promise<void> {
	return new Promise((resolve) => socket.once("close", () => resolve()));
}

/** Frames cross a real socket, so the assertion waits for the wire rather than the fake clock. */
async function until(condition: () => boolean): Promise<void> {
	for (let waited = 0; waited < 2_000 && !condition(); waited += 10) await Bun.sleep(10);
	expect(condition()).toBe(true);
}

const pings = (heard: string[]) =>
	heard
		.join("")
		.split("\n")
		.filter((line) => line.includes('"ping"'));

afterEach(async () => {
	await server?.close();
	server = undefined;
});

////////////////////////////////
//  Tests

describe("the transport's timers on the daemon's clock", () => {
	it("pings once per period on the clock, and drops a peer that stays silent past the limit", async () => {
		const { port } = await serve();
		const heard: string[] = [];
		const socket = await rawConnect(port, heard);
		socket.write(`${JSON.stringify({ kind: "hello", token: TOKEN })}\n`);
		await until(() => heard.join("").includes('"welcome"'));

		clock.advance(HEARTBEAT_MS);
		await until(() => pings(heard).length === 1);
		socket.write(`${JSON.stringify({ kind: "pong", n: 1 })}\n`);
		await Bun.sleep(20);

		// Answered, so the count restarted: the next two silent periods are what end it.
		clock.advance(HEARTBEAT_MS);
		await until(() => pings(heard).length === 2);
		const closed = closedOf(socket);
		clock.advance(HEARTBEAT_MS);
		await closed;
		await until(() => server?.connections() === 0);
		expect(clock.pending()).toBe(0);
	});

	it("closes a peer that never says hello once the deadline passes on the clock", async () => {
		const { port } = await serve();
		const socket = await rawConnect(port, []);
		const closed = closedOf(socket);

		clock.advance(HELLO_DEADLINE_MS);
		await closed;
		await until(() => clock.pending() === 0);
	});
});
