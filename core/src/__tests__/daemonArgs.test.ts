import { describe, expect, it } from "bun:test";
import { parseDaemonArgs } from "../daemonArgs";

////////////////////////////////
//  Tests

describe("the daemon's command line", () => {
	it("takes one workspace, with warm and a state directory as flags in any order", () => {
		expect(parseDaemonArgs(["/w"])).toEqual({ ok: true, args: { workspace: "/w", warm: false } });
		expect(parseDaemonArgs(["--warm", "/w"])).toEqual({ ok: true, args: { workspace: "/w", warm: true } });
		expect(parseDaemonArgs(["/w", "--state-dir", "/s", "--warm"])).toEqual({
			ok: true,
			args: { workspace: "/w", warm: true, stateDir: "/s" },
		});
	});

	// The filter this replaced ignored what it did not know, so a mistyped flag served silently.
	it("refuses what it does not understand rather than serving something else", () => {
		const refused = [
			[],
			["--warm"],
			["/w", "/other"],
			["/w", "--state-dir"],
			["/w", "--state-dir", "/a", "--state-dir", "/b"],
			["/w", "--verbose"],
			["/w", "--state-dir=/s"],
		];
		for (const argv of refused) expect(parseDaemonArgs(argv)).toMatchObject({ ok: false });
	});
});
