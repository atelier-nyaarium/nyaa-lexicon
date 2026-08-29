import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "../residue";

/**
 * Keeps the production packages free of `bun:` modules.
 *
 * Bug class killed: a `bun:` import in a package another project runs under node. `protocol/` and
 * `client/` are consumed by node processes; `core/` and the adapters stay node-neutral so the same
 * bundle runs wherever the runtime guard lets it. Bun's own APIs are reached through the global.
 */
const ROOTS = ["protocol", "client", "core", "formats", "adapters"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "tmp"]);

////////////////////////////////
//  Tests

describe("no production source imports a bun: module", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		for (const root of ROOTS) expect(sourceFiles(root, SKIP_DIRS).length, root).toBeGreaterThan(0);
	});

	// The narrowest token: a quoted specifier starting with the scheme, whichever quote and whether
	// it sits in an import, a require or a dynamic import.
	it("names no bun: specifier outside the tests", () => {
		const offenders: string[] = [];
		const pattern = /["'`]bun:/;

		for (const root of ROOTS) {
			for (const file of sourceFiles(root, SKIP_DIRS)) {
				const source = readSwept(file);
				if (source === null) continue;
				const match = pattern.exec(codeOnly(source));
				if (match) offenders.push(`${file}: ${match[0]}`);
			}
		}

		expect(
			offenders,
			"reach bun through `globalThis.Bun`, never a `bun:` module: protocol and client run under node in other projects, and the bundle stays node-neutral.",
		).toEqual([]);
	});
});
