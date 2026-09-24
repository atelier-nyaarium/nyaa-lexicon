import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

	// A python3 child imports from its cwd first, so starting it in the indexed repo let a root
	// json.py stand in for the standard library.
	it("never starts a child in the folder its own process runs in", async () => {
		const hostile = mkdtempSync(path.join(tmpdir(), "lexicon-python3-cwd-"));
		const previous = process.cwd();
		process.chdir(hostile);
		try {
			const answer = await new Python3Dispatch("sh").runJson<{ cwd: string }>([
				"-c",
				`printf '{"cwd":"%s"}' "$(pwd -P)"`,
			]);
			expect({ answered: typeof answer?.cwd, inHostile: answer?.cwd === realpathSync(hostile) }).toEqual({
				answered: "string",
				inHostile: false,
			});
		} finally {
			process.chdir(previous);
			rmSync(hostile, { recursive: true, force: true });
		}
	});
});
