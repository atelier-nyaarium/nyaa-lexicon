import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";

////////////////////////////////
//  Helpers

/** Two connections wired to each other through in-memory pipes, no child process. */
function pair(): { a: MessageConnection; b: MessageConnection; dispose: () => void } {
	const aToB = new PassThrough();
	const bToA = new PassThrough();
	const a = createMessageConnection(new StreamMessageReader(bToA), new StreamMessageWriter(aToB));
	const b = createMessageConnection(new StreamMessageReader(aToB), new StreamMessageWriter(bToA));
	a.listen();
	b.listen();
	return {
		a,
		b,
		dispose: () => {
			a.dispose();
			b.dispose();
		},
	};
}

////////////////////////////////
//  Tests

describe("vscode-jsonrpc as the provider transport", () => {
	it("carries a request and its response", async () => {
		const { a, b, dispose } = pair();
		b.onRequest("parseFile", (params: { module: string }) => ({ module: params.module, declarations: [] }));

		await expect(a.sendRequest("parseFile", { module: "src/a.ts" })).resolves.toEqual({
			module: "src/a.ts",
			declarations: [],
		});
		dispose();
	});

	it("correlates concurrent requests, which is the part framing alone does not give", async () => {
		const { a, b, dispose } = pair();
		b.onRequest("echo", async (n: number) => {
			await new Promise((resolve) => setTimeout(resolve, n === 1 ? 20 : 0));
			return n;
		});

		// The slow one is sent first; a correlating transport still returns each to its own caller.
		await expect(Promise.all([a.sendRequest("echo", 1), a.sendRequest("echo", 2)])).resolves.toEqual([1, 2]);
		dispose();
	});

	it("surfaces a handler's failure as a rejection rather than a lost reply", async () => {
		const { a, b, dispose } = pair();
		b.onRequest("boom", () => {
			throw new Error("provider exploded");
		});

		await expect(a.sendRequest("boom", {})).rejects.toThrow(/provider exploded/);
		dispose();
	});

	it("round-trips a payload carrying newlines and unicode", async () => {
		const { a, b, dispose } = pair();
		const payload = { text: "line1\nline2", name: "café", emoji: "\u{1F600}" };
		b.onRequest("echo", (p: unknown) => p);

		await expect(a.sendRequest("echo", payload)).resolves.toEqual(payload);
		dispose();
	});
});
