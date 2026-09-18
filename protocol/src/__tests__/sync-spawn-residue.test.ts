import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { readSwept, sourceFiles } from "@nyaa-lexicon/protocol";
import { parseSource, reachedCalls } from "@nyaa-lexicon/protocol/ast";

/**
 * Holds every synchronous child-process wait out of source and tests alike.
 *
 * Bug class killed: a bun process that calls `execFileSync` (or `execSync`, `spawnSync`) can lose
 * its child's exit under CPU load and busy-wait forever, a defunct process left beneath it. The spin
 * that proved this lived in a test worker, not production, so a test helper spawning synchronously
 * is exactly what hangs the suite: it gets no carve-out production code does not also get. Every
 * git call, every runtime probe and every test fixture spawns asynchronously instead, bounded by a
 * timeout that kills a wedged child and still awaits its exit rather than leaving it unreaped. See
 * `core/src/fileScope.ts`'s `runGit`, `client/src/runtime.ts`'s `defaultProbe`, and
 * `client/src/procfs.ts`'s `processesMatching`.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Every provider's src, whichever languages exist; a new provider is swept without editing this. */
function providerSourceDirs(): string[] {
	const providersRoot = join(ROOT, "providers");
	return readdirSync(providersRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(providersRoot, entry.name, "src"))
		.filter((dir) => existsSync(dir));
}

const SWEPT = [
	...["core/src", "client/src", "adapters/mcp/src", "adapters/lsp/src", "protocol/src"].map((dir) => join(ROOT, dir)),
	...providerSourceDirs(),
];

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp"]);

const MODULES = new Set(["node:child_process", "child_process"]);
const MEMBERS = new Set(["execFileSync", "execSync", "spawnSync"]);

////////////////////////////////
//  Tests

describe("nothing here waits on a child synchronously", () => {
	it("finds source files in every swept tree, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP_DIRS).length, dir).toBeGreaterThan(0);
	});

	it("fires on execFileSync reached through an alias", () => {
		const text = 'import { execFileSync as run } from "node:child_process";\nrun("git", ["init"]);\n';
		const parsed = parseSource("planted.ts", text);
		expect(reachedCalls(parsed.source, MODULES, MEMBERS)).toHaveLength(1);
	});

	it("does not fire on an unrelated import of the same name", () => {
		const text = 'import { execFileSync } from "./localHelpers";\nexecFileSync("x");\n';
		const parsed = parseSource("planted.ts", text);
		expect(reachedCalls(parsed.source, MODULES, MEMBERS)).toHaveLength(0);
	});

	it("reaches execFileSync, execSync or spawnSync nowhere, source or tests", () => {
		const offenders: string[] = [];
		for (const dir of SWEPT) {
			for (const file of sourceFiles(dir, SKIP_DIRS)) {
				const source = readSwept(file);
				if (source === null) continue;
				const parsed = parseSource(file, source);
				for (const reach of reachedCalls(parsed.source, MODULES, MEMBERS)) {
					offenders.push(`${relative(ROOT, file).split("\\").join("/")}: ${reach.name}`);
				}
			}
		}

		expect(
			offenders,
			"spawn asynchronously instead (node:child_process's async spawn or execFile, promisified, or Bun.spawn), bounded by a timeout that kills and reaps a wedged child rather than waiting on it forever. A search for live processes reads /proc directly (client/src/procfs.ts's processesMatching) rather than spawning one of its own.",
		).toEqual([]);
	});
});
