import { describe, expect, it } from "bun:test";
import { Python3Dispatch } from "../python3";

////////////////////////////////
//  Tests
//
//  The reap, timeout and cap machinery itself lives in, and is proven by, boundedChild.test.ts.
//  These are runJson's own mapping from a BoundedResult to what it has always answered.

describe("runJson", () => {
	it("throws its own message once output crosses the cap", async () => {
		const dispatch = new Python3Dispatch("sh");

		await expect(dispatch.runJson<unknown>(["-c", "printf 'xxxxxxxxxx'"], { maxBuffer: 4 })).rejects.toThrow(
			"sh produced more output than the buffer allows",
		);
	});

	it("throws the child's stderr for a non-zero exit", async () => {
		const dispatch = new Python3Dispatch("sh");

		await expect(dispatch.runJson<unknown>(["-c", "echo custom-error 1>&2; exit 7"])).rejects.toThrow(
			"custom-error",
		);
	});

	it("parses stdout as JSON on a clean exit", async () => {
		const dispatch = new Python3Dispatch("sh");

		expect(await dispatch.runJson<{ ok: boolean }>(["-c", "printf '{\"ok\":true}'"])).toEqual({ ok: true });
	});
});
