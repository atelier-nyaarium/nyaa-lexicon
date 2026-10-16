import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectFrames, DaemonError, storePaths } from "@nyaa-lexicon/client";
import { readLock } from "../daemonLock";
import { lexiconRoot } from "../providers";
import { IndexStore } from "../store";
import { BUILD_MAJOR } from "../version";

/** Requests get starting during rewrite. */

////////////////////////////////
//  Helpers

const ROOT = lexiconRoot();

const ENTRIES: Array<[string, string]> = [
	["from source", path.join(ROOT, "core", "src", "daemonCli.ts")],
	// Shipped bundle entry.
	...(existsSync(path.join(ROOT, "dist", "statementWorker.js"))
		? [["from the bundle", path.join(ROOT, "dist", "daemon.js")] satisfies [string, string]]
		: []),
];

const COMPACTING = "the index to be compacted";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Output {
	readonly lines: string[] = [];

	constructor(...streams: ReadableStream<Uint8Array>[]) {
		for (const stream of streams) void this.read(stream);
	}

	private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let pending = "";
		for await (const chunk of stream) {
			pending += decoder.decode(chunk, { stream: true });
			const parts = pending.split("\n");
			pending = parts.pop() ?? "";
			this.lines.push(...parts);
		}
	}

	async line(text: string, limitMs = 30_000): Promise<string> {
		const deadline = Date.now() + limitMs;
		for (;;) {
			const found = this.lines.find((each) => each.includes(text));
			if (found !== undefined) return found;
			if (Date.now() > deadline)
				throw new Error(`the daemon never said ${text}; it said:\n${this.lines.join("\n")}`);
			await sleep(10);
		}
	}

	count(text: string): number {
		return this.lines.filter((each) => each.includes(text)).length;
	}
}

let state: string;
let workspace: string;
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const holders: DatabaseSync[] = [];

function prepare(marker: "due" | "current"): string {
	const { index } = storePaths(state);
	IndexStore.open(index).store.close();
	if (marker === "due") {
		const raw = new DatabaseSync(index);
		raw.exec("DELETE FROM meta WHERE key = 'scrubbedMajor'");
		raw.close();
	}
	return index;
}

function markerOf(index: string): string | null {
	const raw = new DatabaseSync(index, { readOnly: true });
	try {
		const row = raw.prepare("SELECT value FROM meta WHERE key = 'scrubbedMajor'").get() as
			| { value: string }
			| undefined;
		return row?.value ?? null;
	} finally {
		raw.close();
	}
}

function start(entry: string): Output {
	const child = Bun.spawn([process.execPath, entry, workspace, "--state-dir", state], {
		cwd: tmpdir(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	return new Output(child.stdout as ReadableStream<Uint8Array>, child.stderr as ReadableStream<Uint8Array>);
}

async function ask(): Promise<{ told: Array<{ waitingFor: string; retryInMs: number }>; refusal: unknown }> {
	const lock = readLock(storePaths(state).lockFile);
	if (lock === null) throw new Error("the daemon holds no lock");
	const told: Array<{ waitingFor: string; retryInMs: number }> = [];
	const client = await connectFrames(lock.port, lock.token, {
		timeoutMs: 2_000,
		patience: 0,
		onWaiting: (event) => {
			told.push({ waitingFor: event.waitingFor, retryInMs: event.retryInMs });
		},
	});
	try {
		return {
			told,
			refusal: await client.request("indexStatus", {}).then(
				() => null,
				(error: unknown) => error,
			),
		};
	} finally {
		client.close();
	}
}

beforeEach(() => {
	state = mkdtempSync(path.join(tmpdir(), "lexicon-startup-state-"));
	workspace = mkdtempSync(path.join(tmpdir(), "lexicon-startup-work-"));
});

afterEach(async () => {
	for (const holder of holders.splice(0)) {
		try {
			holder.exec("ROLLBACK");
		} catch {
			// Transaction may already be released.
		}
		holder.close();
	}
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await Promise.race([child.exited, sleep(10_000)]);
		child.kill("SIGKILL");
	}
	for (const dir of [state, workspace]) rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

for (const [name, entry] of ENTRIES) {
	describe(`the daemon ${name}`, () => {
		it("answers starting, naming the rewrite, while a worker rewrites the index, then opens it", async () => {
			const index = prepare("due");
			const holder = new DatabaseSync(index);
			holders.push(holder);
			holder.exec("BEGIN IMMEDIATE");
			const output = start(entry);

			await output.line("rewriting the index's freed pages");
			const { told, refusal } = await ask();
			holder.exec("ROLLBACK");
			await output.line("rewrote the index's freed pages");

			const at = ["listening on", "rewriting the index", "rewrote the index"].map((text) =>
				output.lines.findIndex((each) => each.includes(text)),
			);
			expect({
				refused: refusal instanceof DaemonError ? refusal.waitingFor : refusal,
				told: told.map(({ waitingFor, retryInMs }) => ({ waitingFor, patient: retryInMs > 0 })),
				claimedFirst: at.every(
					(position, each) => position >= 0 && (each === 0 || position > (at[each - 1] ?? 0)),
				),
				rewrites: output.count("rewriting the index"),
				marker: markerOf(index),
			}).toEqual({
				refused: COMPACTING,
				told: [{ waitingFor: COMPACTING, patient: true }],
				claimedFirst: true,
				rewrites: 1,
				marker: String(BUILD_MAJOR),
			});
		}, 60_000);

		it("never names a rewrite for an index already at the current major (the control)", async () => {
			prepare("current");
			const output = start(entry);
			await output.line("listening on");

			const seen = new Set<string>();
			const deadline = Date.now() + 30_000;
			while (!seen.has("the language providers to start") && Date.now() < deadline) {
				const { told, refusal } = await ask();
				for (const { waitingFor } of told) seen.add(waitingFor);
				if (refusal === null) break;
				await sleep(10);
			}
			await output.line("providers:");

			expect({
				asked: seen.size > 0,
				named: [...seen].filter((waitingFor) => /compacted|copied/.test(waitingFor)),
				rewrites: output.count("rewrit"),
			}).toEqual({ asked: true, named: [], rewrites: 0 });
		}, 60_000);
	});
}
