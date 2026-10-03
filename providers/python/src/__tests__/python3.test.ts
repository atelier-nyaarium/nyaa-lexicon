import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rethrown } from "@nyaa-lexicon/protocol/rejection";
import { Python3Dispatch, python3Commands } from "../python3";

////////////////////////////////
//  Tests
//
//  The reap, timeout and cap machinery itself lives in, and is proven by, boundedChild.test.ts.
//  These are runJson's own mapping from a BoundedResult to what it has always answered.

describe("runJson", () => {
	it("throws its own message once output crosses the cap", async () => {
		const dispatch = new Python3Dispatch("sh");

		expect(await rethrown(dispatch.runJson<unknown>(["-c", "printf 'xxxxxxxxxx'"], { maxBuffer: 4 }))).toThrow(
			"sh produced more output than the buffer allows",
		);
	});

	it("throws the child's stderr for a non-zero exit", async () => {
		const dispatch = new Python3Dispatch("sh");

		expect(await rethrown(dispatch.runJson<unknown>(["-c", "echo custom-error 1>&2; exit 7"]))).toThrow(
			"custom-error",
		);
	});

	it("parses stdout as JSON on a clean exit", async () => {
		const dispatch = new Python3Dispatch("sh");

		expect(await dispatch.runJson<{ ok: boolean }>(["-c", "printf '{\"ok\":true}'"])).toEqual({ ok: true });
	});

	it("falls through missing launchers to the first that runs, prefix first; none found answers null", async () => {
		const missing = { command: "lexicon-no-such-python", prefix: [] };
		const found = new Python3Dispatch([missing, { command: "sh", prefix: ["-c"] }]);
		const none = new Python3Dispatch([missing]);

		expect({
			found: await found.runJson<{ ok: boolean }>(["printf '{\"ok\":true}'"]),
			none: await none.runJson<unknown>(["-c", "print(1)"]),
			detail: none.unavailableDetail,
		}).toEqual({
			found: { ok: true },
			none: null,
			detail: "Executable not found in $PATH: lexicon-no-such-python",
		});
	});

	it("tries the py launcher before python on Windows, and python3 elsewhere", () => {
		expect({ win32: python3Commands("win32"), linux: python3Commands("linux") }).toEqual({
			win32: [
				{ command: "py", prefix: ["-3"] },
				{ command: "python", prefix: [] },
			],
			linux: [{ command: "python3", prefix: [] }],
		});
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
