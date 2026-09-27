import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { callsTo, parsedFiles } from "@nyaa-lexicon/protocol/ast";

/**
 * One publisher. The record names the machine's installed lexicon, so only the plugin's MCP server
 * writes it; a daemon, an embedded copy or a dev checkout that wrote it would repoint every client
 * spawning from the record at itself.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const SWEPT = ["client/src", "core/src", "adapters/mcp/src", "adapters/lsp/src", "formats/src", "protocol/src"].map(
	(dir) => join(ROOT, dir),
);

const OWNERS = new Set(["client/src/install.ts", "adapters/mcp/src/serve.ts"]);

const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "tmp"]);

////////////////////////////////
//  Tests

describe("no production source but the MCP server publishes the install record", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP_DIRS).length, dir).toBeGreaterThan(0);
	});

	it("calls writeInstallRecord only in its definition and the MCP server", () => {
		const offenders: string[] = [];
		for (const dir of SWEPT) {
			for (const { file, source } of parsedFiles(dir, SKIP_DIRS)) {
				const name = relative(ROOT, file);
				if (OWNERS.has(name)) continue;
				if (callsTo(source, "writeInstallRecord").length > 0) offenders.push(name);
			}
		}

		expect(offenders, "only the plugin's MCP server, behind --publish-install, records the install").toEqual([]);
	});
});
