import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { codeOnly, DAEMON_CONTROLS, DAEMON_METHODS, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds per-request policy to the declared lifecycle: nothing in the client or the daemon compares a
 * request's name to decide how it is treated.
 *
 * Bug class killed: a request gated by a name check in one place and by its declared rule in
 * another, so the daemon before its handler, the daemon after it and a client disagree about it.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const SWEPT = [join(ROOT, "client", "src"), join(ROOT, "core", "src")];

const SKIP = ["__tests__", "dist", "node_modules", ".tsbuild"];

const NAMES = [...Object.keys(DAEMON_METHODS), ...Object.keys(DAEMON_CONTROLS)].join("|");

/** A quoted request name beside an equality, or as a switch case. */
const COMPARED = new RegExp(
	[
		`[!=]==?\\s*(["'\`])(${NAMES})\\1`,
		`(["'\`])(${NAMES})\\3\\s*[!=]==?`,
		`\\bcase\\s+(["'\`])(${NAMES})\\5\\s*:`,
	].join("|"),
	"g",
);

////////////////////////////////
//  Functions & Helpers

function comparedNames(code: string): string[] {
	return [...code.matchAll(COMPARED)].map((match) => match[2] ?? match[4] ?? match[6] ?? "");
}

////////////////////////////////
//  Tests

describe("request policy lives in the declared lifecycle", () => {
	it("finds source files in every swept tree, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP).length, dir).toBeGreaterThan(0);
	});

	it("catches a planted name branch in each spelling", () => {
		expect(
			comparedNames(
				[
					`if (method === "shutdown") stop();`,
					`if ('indexStatus' !== name) warm();`,
					"switch (method) { case `refactorStatus`: break; }",
					`if (rule.lifecycle === "control") answer();`,
					`callDaemon(lock, "shutdown", {});`,
				].join("\n"),
			),
		).toEqual(["shutdown", "indexStatus", "refactorStatus"]);
	});

	it("has no client or daemon source branching on a request name", () => {
		const found = SWEPT.flatMap((dir) => sourceFiles(dir, SKIP)).flatMap((file) => {
			const source = readSwept(file);
			if (source === null) return [];
			const where = relative(ROOT, file).split("\\").join("/");
			return comparedNames(codeOnly(source)).map((name) => `${where}: ${name}`);
		});

		expect(found, "judge a request by requestRule(name), never by comparing its name").toEqual([]);
	});
});
