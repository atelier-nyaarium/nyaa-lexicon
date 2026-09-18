import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { readSwept, sourceFiles } from "@nyaa-lexicon/protocol";
import { parseSource, reachedCalls } from "@nyaa-lexicon/protocol/ast";

/**
 * Holds protocol/src/boundedChild.ts as the one owner of a bounded, reaped child process.
 *
 * Bug class killed: three modules each hand-copied the same spawn, reap and process-group-kill
 * machinery, and three audit rounds each found a defect that then had to be fixed three times. A
 * new caller reaches `runBounded` instead of writing a fourth copy.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

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
const MEMBERS = new Set(["spawn", "execFile"]);

/** Every other reach of `spawn` or `execFile`, and why it is not routed through the owner. */
const ALLOWED = new Map<string, string>([
	["core/src/supervisor.ts", "spawns long-lived providers; a different lifecycle than a bounded run"],
	["client/src/discover.ts", "spawns the daemon, detached and unref'd to outlive the caller; a different lifecycle"],
	[
		"protocol/src/conformance/runner.ts",
		"spawns a long-lived provider connection for a conformance run; a different lifecycle",
	],
	["core/src/__tests__/gitFixture.ts", "test fixture execFile via promisify, not the hand-copied reap machinery"],
	[
		"protocol/src/__tests__/source-bytes-residue.test.ts",
		"test-only git ls-files via promisify(execFile), not the hand-copied reap machinery",
	],
	[
		"core/src/__tests__/daemonAnswers.test.ts",
		"test fixture execFile via promisify, not the hand-copied reap machinery",
	],
	[
		"client/src/__tests__/procfs.test.ts",
		"spawns a live process for a liveness-probe fixture, not a bounded command",
	],
	[
		"client/src/__tests__/discover.test.ts",
		"spawns a live process for a liveness-probe fixture, not a bounded command",
	],
]);

////////////////////////////////
//  Tests

describe("one owner spawns and reaps a bounded child", () => {
	it("finds source files in every swept tree, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP_DIRS).length, dir).toBeGreaterThan(0);
	});

	it("sees the owner's own spawn, so the rule is checking real calls", () => {
		const owner = join(ROOT, "protocol", "src", "boundedChild.ts");
		const parsed = parseSource(owner, readSwept(owner) as string);
		expect(reachedCalls(parsed.source, MODULES, MEMBERS).length).toBeGreaterThan(0);
	});

	it("reaches spawn or execFile nowhere but the owner and the allowlisted exceptions", () => {
		const offenders: string[] = [];
		for (const dir of SWEPT) {
			for (const file of sourceFiles(dir, SKIP_DIRS)) {
				const here = relative(ROOT, file).split("\\").join("/");
				if (here === "protocol/src/boundedChild.ts" || ALLOWED.has(here)) continue;
				const source = readSwept(file);
				if (source === null) continue;
				const parsed = parseSource(file, source);
				for (const reach of reachedCalls(parsed.source, MODULES, MEMBERS)) {
					offenders.push(`${here}: ${reach.name}`);
				}
			}
		}

		expect(
			offenders,
			"route a bounded, one-shot child through protocol/src/boundedChild.ts's runBounded, or add a named, reasoned exception to this test's ALLOWED map for a genuinely different lifecycle",
		).toEqual([]);
	});
});
