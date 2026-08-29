import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

/**
 * A module reaches the disk through `workspaceFile` (protocol) and its core wrapper alone, which
 * refuse a path that leaves the root. A bare join of the root and a module is the hole a
 * `../secret` module walks through, so the join itself is forbidden here.
 */
const CORE = join(import.meta.dirname, "..");

/** The wrapper that turns a refusal into a read outcome or a named error. */
const OWNER = "sourceRead.ts";

const SKIP = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "tmp"]);

/** The narrowest token: the root joined with a module, whichever object holds either and however the join is reached. */
const BARE_JOIN = /\b(?:join|resolve)(?:["'\]]*)\s*\(\s*(?:this\.)?(?:workspaceRoot|root)\s*,\s*(?:\w+\.)?module\b/;

////////////////////////////////
//  Tests

describe("no module reaches the disk by a bare join", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(sourceFiles(CORE, SKIP).length).toBeGreaterThan(20);
	});

	it("joins a module onto the root only inside the owner", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(CORE, SKIP)) {
			if (basename(file) === OWNER) continue;
			const source = readSwept(file);
			if (source !== null && BARE_JOIN.test(codeOnly(source))) offenders.push(basename(file));
		}

		expect(
			offenders,
			"use insideWorkspace from sourceRead.ts, which refuses a module that leaves the root",
		).toEqual([]);
	});
});
