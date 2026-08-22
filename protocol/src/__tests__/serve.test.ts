import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { exitWhenClosed, type ProviderHandlers, serveProvider } from "../serve";

describe("the shared server, before any handler", () => {
	it("refuses a module no symbol id can name, and lets a workspace-relative one through", async () => {
		const toProvider = new PassThrough();
		const toDaemon = new PassThrough();
		const provider = createMessageConnection(
			new StreamMessageReader(toProvider),
			new StreamMessageWriter(toDaemon),
		);
		const daemon = createMessageConnection(new StreamMessageReader(toDaemon), new StreamMessageWriter(toProvider));
		const asked: string[] = [];
		// Only the module check matters.
		const handlers = new Proxy({} as ProviderHandlers, {
			get: () => (params: { module?: string }) => {
				asked.push(params.module ?? "?");
				return {};
			},
		});
		serveProvider(provider, handlers);
		provider.listen();
		daemon.listen();

		await expect(
			daemon.sendRequest("parseFile", { module: "../x.ts", contentHash: "h", text: "" }),
		).rejects.toThrow(/escape the workspace/);
		await expect(daemon.sendRequest("parseFile", { module: "/x.ts", contentHash: "h", text: "" })).rejects.toThrow(
			/absolute/,
		);
		await expect(daemon.sendRequest("moveEdits", { module: "src/a.ts", toModule: "../out.ts" })).rejects.toThrow(
			/escape the workspace/,
		);
		await expect(
			daemon.sendRequest("parseFile", { module: "src/a.ts", contentHash: "h", text: "" }),
		).resolves.toEqual({});
		expect(asked).toEqual(["src/a.ts"]);

		provider.dispose();
		daemon.dispose();
	});
});

////////////////////////////////
//  Tests

// Issue #7: providers outlived a dead daemon because nothing told them to stop.
describe("a provider whose daemon is gone", () => {
	it("exits cleanly when its stdin ends", () => {
		const stdin = new PassThrough();
		const exits: number[] = [];
		exitWhenClosed(stdin, (code) => exits.push(code));

		stdin.end();
		// 'end' only fires once the stream is read; a provider is always reading.
		stdin.resume();

		return new Promise<void>((resolve) => {
			setImmediate(() => {
				expect(exits).toEqual([0]);
				resolve();
			});
		});
	});

	it("exits once, not once per close event", () => {
		const stdin = new PassThrough();
		const exits: number[] = [];
		exitWhenClosed(stdin, (code) => exits.push(code));

		stdin.resume();
		stdin.end();
		stdin.destroy();

		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(exits).toEqual([0]);
				resolve();
			}, 20);
		});
	});
});
