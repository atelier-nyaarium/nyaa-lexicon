import { describe, expect, it } from "bun:test";
import { WorkspaceGate } from "../workspaceGate";

////////////////////////////////
//  Helpers

/** A promise a test resolves by hand, so ordering is decided rather than raced. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

////////////////////////////////
//  Tests

describe("serializing workspace mutations", () => {
	it("runs one writer at a time, in arrival order", async () => {
		const gate = new WorkspaceGate();
		const log: string[] = [];
		const first = deferred();

		const a = gate.exclusive(async () => {
			log.push("a:start");
			await first.promise;
			log.push("a:end");
		});
		const b = gate.exclusive(async () => {
			log.push("b:start");
		});

		await tick();
		expect(log).toEqual(["a:start"]);

		first.resolve();
		await Promise.all([a, b]);
		expect(log).toEqual(["a:start", "a:end", "b:start"]);
	});

	it("runs readers together", async () => {
		const gate = new WorkspaceGate();
		const running: string[] = [];
		const held = deferred();

		const readers = [
			gate.shared(async () => {
				running.push("a");
				await held.promise;
			}),
			gate.shared(async () => {
				running.push("b");
				await held.promise;
			}),
		];

		await tick();
		expect(running).toEqual(["a", "b"]);

		held.resolve();
		await Promise.all(readers);
	});

	// The reason the gate exists: a reader must never observe the middle of a multi-file write.
	it("keeps a reader out while a writer holds it", async () => {
		const gate = new WorkspaceGate();
		const log: string[] = [];
		const writing = deferred();

		const writer = gate.exclusive(async () => {
			log.push("write:start");
			await writing.promise;
			log.push("write:end");
		});
		await tick();

		const reader = gate.shared(async () => {
			log.push("read");
		});
		await tick();
		expect(log).toEqual(["write:start"]);

		writing.resolve();
		await Promise.all([writer, reader]);
		expect(log).toEqual(["write:start", "write:end", "read"]);
	});

	// A steady read load must not starve a refactor step forever.
	it("makes a reader arriving behind a waiting writer wait its turn", async () => {
		const gate = new WorkspaceGate();
		const log: string[] = [];
		const firstRead = deferred();

		const early = gate.shared(async () => {
			log.push("read:early");
			await firstRead.promise;
		});
		await tick();

		const writer = gate.exclusive(async () => {
			log.push("write");
		});
		const late = gate.shared(async () => {
			log.push("read:late");
		});

		await tick();
		expect(log).toEqual(["read:early"]);

		firstRead.resolve();
		await Promise.all([early, writer, late]);
		expect(log).toEqual(["read:early", "write", "read:late"]);
	});

	it("releases the gate when work throws, rather than wedging every later caller", async () => {
		const gate = new WorkspaceGate();

		await expect(
			gate.exclusive(async () => {
				throw new Error("step failed");
			}),
		).rejects.toThrow("step failed");

		await expect(gate.exclusive(async () => "next")).resolves.toBe("next");
		expect(gate.stats()).toEqual({ readers: 0, writing: false, waiting: 0 });
	});

	// Admission resumes its caller a microtask later, so state has to be claimed at admit time or
	// two writers both see a free gate and run at once.
	it("never admits two writers from one release", async () => {
		const gate = new WorkspaceGate();
		let concurrent = 0;
		let peak = 0;

		const work = async () => {
			concurrent++;
			peak = Math.max(peak, concurrent);
			await tick();
			concurrent--;
		};

		await Promise.all([gate.exclusive(work), gate.exclusive(work), gate.exclusive(work)]);
		expect(peak).toBe(1);
	});

	it("reports what it is doing, so a stuck workspace is diagnosable", async () => {
		const gate = new WorkspaceGate();
		const held = deferred();

		const writer = gate.exclusive(async () => {
			await held.promise;
		});
		const waiting = gate.shared(async () => {});
		await tick();

		expect(gate.stats()).toEqual({ readers: 0, writing: true, waiting: 1 });

		held.resolve();
		await Promise.all([writer, waiting]);
		expect(gate.stats()).toEqual({ readers: 0, writing: false, waiting: 0 });
	});
});
