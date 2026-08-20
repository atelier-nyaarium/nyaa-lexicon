import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { exitWhenClosed } from "../serve";

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
