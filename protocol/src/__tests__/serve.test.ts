import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { handlersFor, type ProviderMethods } from "../providerKit";
import { exitWhenClosed, type ProviderHandlers, type ProviderNotificationHandlers, serveProvider } from "../serve";

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

describe("a notification", () => {
	function pair(handlers: ProviderHandlers & ProviderNotificationHandlers) {
		const toProvider = new PassThrough();
		const toDaemon = new PassThrough();
		const provider = createMessageConnection(
			new StreamMessageReader(toProvider),
			new StreamMessageWriter(toDaemon),
		);
		const daemon = createMessageConnection(new StreamMessageReader(toDaemon), new StreamMessageWriter(toProvider));
		serveProvider(provider, handlers);
		provider.listen();
		daemon.listen();
		return { provider, daemon };
	}

	it("reaches a provider that handles it, and a provider without a handler still answers requests", async () => {
		const forgotten: string[] = [];
		const answering = { parseFile: () => ({ declarations: [] }) } as unknown as ProviderHandlers;
		const handled = pair({ ...answering, forgetModule: ({ module }) => forgotten.push(module) });
		const ignoring = pair(answering);

		await handled.daemon.sendNotification("forgetModule", { module: "src/a.kt" });
		await handled.daemon.sendNotification("forgetModule", { module: "../out.kt" });
		await ignoring.daemon.sendNotification("forgetModule", { module: "src/a.kt" });
		// A request after the notifications settles only once they were read.
		await handled.daemon.sendRequest("parseFile", { module: "src/a.kt", contentHash: "h", text: "" });
		await expect(
			ignoring.daemon.sendRequest("parseFile", { module: "src/a.kt", contentHash: "h", text: "" }),
		).resolves.toMatchObject({ declarations: [] });

		expect(forgotten).toEqual(["src/a.kt"]);
		for (const { provider, daemon } of [handled, ignoring]) {
			provider.dispose();
			daemon.dispose();
		}
	});

	// The seam is additive or it is not shippable: a provider written before it must not change.
	it("leaves a provider predating it wired to nothing, and still answering", async () => {
		const answering = { parseFile: () => ({ declarations: [] }) } as unknown as ProviderMethods;
		const wired = handlersFor(answering);
		expect(Object.keys(wired)).not.toContain("moduleAdmission");
		expect(Object.keys(wired)).not.toContain("forgetModule");

		const ignoring = pair(wired);
		await ignoring.daemon.sendNotification("moduleAdmission", {
			module: "src/a.kt",
			contentHash: "h",
			outcome: { status: "refused", reason: "the provider's answer was refused" },
		});
		await expect(
			ignoring.daemon.sendRequest("parseFile", { module: "src/a.kt", contentHash: "h", text: "" }),
		).resolves.toMatchObject({ declarations: [] });

		ignoring.provider.dispose();
		ignoring.daemon.dispose();
	});

	it("reaches a provider that answers it, and refuses a verdict its schema does not admit", async () => {
		const settled: string[] = [];
		const answering = { parseFile: () => ({ declarations: [] }) } as unknown as ProviderHandlers;
		const handled = pair({
			...answering,
			moduleAdmission: ({ module, outcome }) => settled.push(`${module}:${outcome.status}`),
		});

		await handled.daemon.sendNotification("moduleAdmission", {
			module: "src/a.kt",
			contentHash: "h",
			outcome: { status: "admitted" },
		});
		// Refused with no reason: the schema refuses it rather than the handler reading a blank one.
		await handled.daemon.sendNotification("moduleAdmission", {
			module: "src/b.kt",
			contentHash: "h",
			outcome: { status: "refused" },
		});
		await handled.daemon.sendRequest("parseFile", { module: "src/a.kt", contentHash: "h", text: "" });

		expect(settled).toEqual(["src/a.kt:admitted"]);
		handled.provider.dispose();
		handled.daemon.dispose();
	});

	// A daemon that gave up on a slow probe sends on; the probe's restore must still land first.
	it("waits its turn behind a slow async request, and so does the next request", async () => {
		const seen: string[] = [];
		let release = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handled = pair({
			parseFile: async ({ module }: { module: string }) => {
				seen.push(`start ${module}`);
				if (module === "src/slow.py") await slow;
				seen.push(`end ${module}`);
				return { declarations: [] };
			},
			moduleAdmission: ({ module }: { module: string }) => seen.push(`verdict ${module}`),
		} as unknown as ProviderHandlers & ProviderNotificationHandlers);

		const first = handled.daemon.sendRequest("parseFile", { module: "src/slow.py", contentHash: "h", text: "" });
		await handled.daemon.sendNotification("moduleAdmission", {
			module: "src/slow.py",
			contentHash: "h",
			outcome: { status: "admitted" },
		});
		const second = handled.daemon.sendRequest("parseFile", { module: "src/fast.py", contentHash: "h", text: "" });
		await Bun.sleep(20);
		release();
		await Promise.all([first, second]);

		expect(seen).toEqual([
			"start src/slow.py",
			"end src/slow.py",
			"verdict src/slow.py",
			"start src/fast.py",
			"end src/fast.py",
		]);
		handled.provider.dispose();
		handled.daemon.dispose();
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
