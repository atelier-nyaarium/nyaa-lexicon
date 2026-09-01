import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { declaresName, lineOf, type ParsedSource, parseSource, reachedCalls } from "../astResidue";
import { readSwept } from "../residue";

/** Holds providerKit.ts as the one walk, path conversion and handler table a provider entry point uses. */
const PROVIDERS = join(import.meta.dirname, "..", "..", "..", "providers");

const FS_MODULES = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);
const PATH_MODULES = new Set(["node:path", "path", "node:path/posix", "node:path/win32"]);

/** A directory walk, and the path conversion the kit owns. */
const WALK = new Set(["readdir", "readdirSync", "opendir", "opendirSync", "glob", "globSync"]);
const CONVERT = new Set(["relative"]);

function providerDirectories(): string[] {
	return readdirSync(PROVIDERS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

/** Entry points, plus the one discovery module that lives beside its entry point. */
function candidates(): string[] {
	const mains = providerDirectories().map((name) => join(PROVIDERS, name, "src", "main.ts"));
	return [...mains, join(PROVIDERS, "rust", "src", "project.ts")];
}

/** Only files that READ and parse. A constructed path proves a listing, never that a sweep saw source. */
function swept(): ParsedSource[] {
	const read: ParsedSource[] = [];
	for (const file of candidates()) {
		const text = readSwept(file);
		if (text === null) continue;
		read.push(parseSource(file, text));
	}
	return read;
}

////////////////////////////////
//  Tests

describe("one kit scaffolds every provider", () => {
	// Counting readable files is not enough: a count clears its floor while a named entry point is
	// missing, so the set is compared against the directories themselves.
	it("reads the entry point of every provider directory, so a passing sweep is never vacuous", () => {
		const read = new Set(swept().map((parsed) => parsed.file));
		const missing = providerDirectories().filter((name) => !read.has(join(PROVIDERS, name, "src", "main.ts")));
		expect(providerDirectories().length).toBeGreaterThanOrEqual(12);
		expect(missing).toEqual([]);
	});

	it("has no entry point walking the workspace, converting a path, or wiring handlers itself", () => {
		const offenders: string[] = [];
		for (const parsed of swept()) {
			const here = parsed.file.slice(PROVIDERS.length + 1);
			for (const { call, name } of reachedCalls(parsed.source, FS_MODULES, WALK)) {
				offenders.push(`${here}:${lineOf(parsed, call)} walks with ${name}`);
			}
			for (const { call, name } of reachedCalls(parsed.source, PATH_MODULES, CONVERT)) {
				offenders.push(`${here}:${lineOf(parsed, call)} converts a path with ${name}`);
			}
			if (declaresName(parsed.source, "handlersFor")) offenders.push(`${here}: declares its own handlersFor`);
		}

		expect(
			offenders,
			"walks, path conversion and the handler table belong to protocol/src/providerKit.ts: discoverByWalk, walkWorkspace, workspaceModule, workspaceFile, handlersFor",
		).toEqual([]);
	});
});
