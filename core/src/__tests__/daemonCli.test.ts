import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { storePaths } from "@nyaa-lexicon/client";
import { resumeAbandonedDelete, runGuarded } from "../daemonCli";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve: (value: T) => void = () => {};
	let reject: (error: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

////////////////////////////////
//  Helpers

function scratch(): string {
	return mkdtempSync(path.join(tmpdir(), "lexicon-resume-"));
}

////////////////////////////////
//  Tests

// Finishes a dead delete before serving, and leaves anything else exactly as found.
describe("resuming a claim that stole a delete's lock", () => {
	it("finishes it and says so when the claim stole a delete", () => {
		const directory = scratch();
		try {
			writeFileSync(storePaths(directory).index, "stale");

			expect(resumeAbandonedDelete({ stolenRole: "delete" }, directory, false)).toBe(true);
			expect(existsSync(storePaths(directory).index)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("touches nothing when the claim stole a daemon's lock instead", () => {
		const directory = scratch();
		try {
			writeFileSync(storePaths(directory).index, "kept");

			expect(resumeAbandonedDelete({ stolenRole: "daemon" }, directory, false)).toBe(false);
			expect(existsSync(storePaths(directory).index)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("touches nothing when nothing was stolen at all", () => {
		const directory = scratch();
		try {
			writeFileSync(storePaths(directory).index, "kept");

			expect(resumeAbandonedDelete({}, directory, false)).toBe(false);
			expect(existsSync(storePaths(directory).index)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	// A default directory's resume clears the whole of it, not only the enumerated list.
	it("clears a default store whole, including a file the enumerated list does not name", () => {
		const directory = scratch();
		try {
			writeFileSync(storePaths(directory).index, "stale");
			writeFileSync(path.join(directory, "stray.txt"), "not in the list");

			expect(resumeAbandonedDelete({ stolenRole: "delete" }, directory, true)).toBe(true);
			expect(existsSync(storePaths(directory).index)).toBe(false);
			expect(existsSync(path.join(directory, "stray.txt"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("running at most one at a time", () => {
	it("skips a call while the previous one is still running", async () => {
		const started: number[] = [];
		const first = deferred();
		const guard = { busy: false };

		runGuarded(
			guard,
			async () => {
				started.push(1);
				await first.promise;
			},
			() => {},
		);
		runGuarded(
			guard,
			async () => {
				started.push(2);
			},
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(started).toEqual([1]);

		first.resolve();
		await new Promise((resolve) => setImmediate(resolve));
		expect(guard.busy).toBe(false);
	});

	it("logs a rejection through onError rather than leaving it unhandled, and frees the guard", async () => {
		const errors: unknown[] = [];
		const guard = { busy: false };

		runGuarded(
			guard,
			async () => {
				throw new Error("drift check broke");
			},
			(error) => errors.push(error),
		);
		await new Promise((resolve) => setImmediate(resolve));

		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toBe("drift check broke");
		expect(guard.busy).toBe(false);
	});

	// work need not be async: a plain function throwing before returning any promise must still
	// reach onError and free the guard, not escape runGuarded itself and wedge it busy forever.
	it("frees the guard and reports the error when work throws synchronously, not asynchronously", async () => {
		const errors: unknown[] = [];
		const guard = { busy: false };

		runGuarded(
			guard,
			(() => {
				throw new Error("synchronous break");
			}) as unknown as () => Promise<void>,
			(error) => errors.push(error),
		);
		await new Promise((resolve) => setImmediate(resolve));

		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toBe("synchronous break");
		expect(guard.busy).toBe(false);
	});

	it("tries again on the next call once the previous one has settled", async () => {
		const started: number[] = [];
		const guard = { busy: false };

		runGuarded(
			guard,
			async () => {
				started.push(1);
			},
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(guard.busy).toBe(false);

		runGuarded(
			guard,
			async () => {
				started.push(2);
			},
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(started).toEqual([1, 2]);
	});
});
