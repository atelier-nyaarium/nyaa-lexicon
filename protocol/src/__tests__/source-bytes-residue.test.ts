import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Enforces the two character rules that were prose with nothing behind them.
 *
 * Bug class killed: a byte that is legal to every behavioural gate and ruins the FILE. A raw NUL
 * used as a cache-key separator renders as whitespace, compiles, and passes every test, while
 * making git call the file binary and grep return nothing for any pattern in it. Behaviour is never
 * wrong, so no behavioural gate can catch it.
 *
 * Checked over what git tracks rather than a hand-listed set of directories, so a new package is
 * covered the day it is added rather than the day someone remembers to add it here.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** The shipped bundle is generated, and its contents are its inputs' problem rather than its own. */
const SKIP_PREFIXES = ["dist/", "tmp/"];

const CHECKED_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".gd", ".md", ".json", ".yml", ".yaml"];

// Both sets are NUMBERS on purpose, never literal characters and never escape sequences.
//
// A literal would plant in this file exactly what it forbids, and the run would still pass because
// a pattern always matches itself. An escape sequence is worse in a subtler way: it is one lost
// backslash away from being that literal, and the loss is invisible in every editor. Numbers cannot
// be mangled into the thing they describe.

/** Tab, newline and carriage return are the only control characters a source file may contain. */
const ALLOWED_CONTROL = new Set([9, 10, 13]);

/**
 * Em dash, the four smart quotes, and the zero-width characters, by code point.
 *
 * U+FEFF is one of them and is the one that arrives by accident: an editor writing a byte order
 * mark, or a tool turning an escape back into the character it names. Nothing here needs the byte,
 * and a fixture that means to test one builds it from its code point.
 */
const BANNED_CODES = new Set([0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x200b, 0x200c, 0x200d, 0xfeff]);

////////////////////////////////
//  Functions & Helpers

/** Asked of git, so an ignored file and a build artefact are excluded the way they are everywhere else. */
function trackedFiles(): string[] {
	const stdout = execFileSync("git", ["ls-files", "-z"], {
		cwd: REPO_ROOT,
		maxBuffer: 64 * 1024 * 1024,
		encoding: "utf8",
	});
	return stdout
		.split("\0")
		.filter((path) => path.length > 0)
		.filter((path) => !SKIP_PREFIXES.some((prefix) => path.startsWith(prefix)))
		.filter((path) => CHECKED_EXTENSIONS.some((extension) => path.endsWith(extension)));
}

function isRawControl(code: number): boolean {
	return code < 32 && !ALLOWED_CONTROL.has(code);
}

/** Reports the line and the code point, since a character this invisible is not findable otherwise. */
function offendersIn(offends: (code: number) => boolean): string[] {
	const found: string[] = [];
	for (const path of trackedFiles()) {
		// Tracked but gone is an ordinary state mid-delete or mid-rename. Reading it threw ENOENT and
		// failed the whole sweep, which reads as a byte violation in a file nobody can open.
		const absolute = join(REPO_ROOT, path);
		if (!existsSync(absolute)) continue;
		const lines = readFileSync(absolute, "utf8").split("\n");
		for (const [index, line] of lines.entries()) {
			for (const character of line) {
				const code = character.codePointAt(0) ?? 0;
				if (!offends(code)) continue;
				found.push(`${path}:${index + 1} contains U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
				break;
			}
		}
	}
	return found;
}

////////////////////////////////
//  Tests

describe("what bytes a source file may contain", () => {
	it("finds files to check, so a passing run is never vacuous", () => {
		expect(trackedFiles().length).toBeGreaterThan(50);
	});

	it("has no raw control byte in any tracked source file", () => {
		expect(
			offendersIn(isRawControl),
			"write a control character as an escape, which is byte-identical at runtime and keeps the file readable to git and grep. See CLAUDE.md > Development.",
		).toEqual([]);
	});

	it("has no em dash, smart quote or zero-width character", () => {
		expect(
			offendersIn((code) => BANNED_CODES.has(code)),
			"reword rather than substitute: these are banned in every file, markdown included.",
		).toEqual([]);
	});
});
