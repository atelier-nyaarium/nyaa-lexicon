import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { codeOnly, sourceFiles } from "@nyaa-lexicon/protocol";

/**
 * One executable owner. `runtime.ts` chooses the bun a child runs on and `paths.ts` is the seam
 * that reads the live process into a `PlatformEnv`; every spawn site takes the owner's answer.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const SWEPT = ["client/src", "core/src", "adapters/mcp/src", "adapters/lsp/src", "formats/src", "protocol/src"].map(
	(dir) => join(ROOT, dir),
);

const OWNERS = new Set(["client/src/runtime.ts", "client/src/paths.ts"]);

const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "tmp"]);

/** Either spelling of the read: a property or a bracket. */
const EXEC_PATH = /\bprocess\s*(?:\.\s*execPath\b|\[\s*["'`]execPath["'`]\s*\])/;

////////////////////////////////
//  Tests

describe("no production source chooses its own executable", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP_DIRS).length, dir).toBeGreaterThan(0);
	});

	it("reads process.execPath only inside the owner and the host seam", () => {
		const offenders: string[] = [];
		for (const dir of SWEPT) {
			for (const file of sourceFiles(dir, SKIP_DIRS)) {
				const name = relative(ROOT, file);
				if (OWNERS.has(name)) continue;
				if (EXEC_PATH.test(codeOnly(readFileSync(file, "utf8")))) offenders.push(name);
			}
		}

		expect(offenders, "spawn through bunExecutable(currentHost()); the executable has one owner").toEqual([]);
	});
});
