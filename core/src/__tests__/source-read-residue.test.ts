import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { readSwept, sourceFiles } from "@nyaa-lexicon/protocol";
import { calleeOf, callsIn, lineOf, parseSource, reachedCalls } from "@nyaa-lexicon/protocol/ast";

/**
 * Holds sourceRead.ts as the only module that reads a workspace file for indexing.
 *
 * Bug class killed: the watcher decoded every changed file as UTF-8 with no routing, no binary
 * guard and no size bound, while the indexer routed first and read the same file again its own
 * way. Two read sites meant two policies, and a third would have been a fourth.
 */
const CORE_SRC = join(import.meta.dirname, "..");
const ADAPTERS_SRC = join(import.meta.dirname, "..", "..", "..", "adapters");

/**
 * Readers of lexicon's OWN state or of a manifest, never of a workspace source file for indexing.
 * transactions.ts reads a workspace file as BYTES for a revert image, which decoding would corrupt.
 */
const OWNERS = new Set([
	"sourceRead.ts",
	"daemon.ts",
	"diagnostics.ts",
	"drift.ts",
	"fileScope.ts",
	"fingerprint.ts",
	"manage.ts",
	"projectRegistry.ts",
	"projectStores.ts",
	"transactions.ts",
]);

const SKIP = ["__tests__", "dist", "node_modules"];

const FS_MODULES = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);

/**
 * Every way node hands back a file's bytes.
 *
 * Matched by BINDING rather than by spelling, so an alias is caught and an injected `readFile`
 * parameter is not: nothing imported it, so it reaches no capability of its own.
 */
const READERS = new Set([
	"readFile",
	"readFileSync",
	"read",
	"readSync",
	"createReadStream",
	"open",
	"openSync",
	"openAsBlob",
]);

////////////////////////////////
//  Tests

describe("one module reads workspace files", () => {
	const files = [...sourceFiles(CORE_SRC, SKIP), ...sourceFiles(ADAPTERS_SRC, SKIP)];

	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	it("has the owner it names", () => {
		expect(files.map((file) => basename(file))).toContain("sourceRead.ts");
	});

	it("has no second reader outside the owner and the state readers", () => {
		const offenders: string[] = [];
		for (const file of files) {
			if (OWNERS.has(basename(file))) continue;
			const text = readSwept(file);
			if (text === null) continue;
			const parsed = parseSource(file, text);
			for (const { call, name } of reachedCalls(parsed.source, FS_MODULES, READERS)) {
				offenders.push(`${basename(file)}:${lineOf(parsed, call)} ${name}`);
			}
			// Bun's file reader arrives on a global rather than through an import.
			for (const call of callsIn(parsed.source)) {
				const callee = calleeOf(call);
				if (callee?.receiver === "Bun" && (callee.name === "file" || callee.name === "mmap")) {
					offenders.push(`${basename(file)}:${lineOf(parsed, call)} Bun.${callee.name}`);
				}
			}
		}

		expect(
			offenders,
			"a workspace file is read through readSource in sourceRead.ts, which owns the size bound and the binary guard.",
		).toEqual([]);
	});
});
