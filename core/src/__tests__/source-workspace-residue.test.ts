import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Holds SourceWorkspace to the disk side of the workspace.
 *
 * This one guards a decision as much as a boundary. `reparseFromDisk` looks like it belongs here
 * and does not: it exists to undo the damage of parsing candidate text through the canonical
 * provider, which is a provider-state problem wearing a source-reading costume. Letting it in would
 * put a supervisor on this class, and then "read the workspace" and "ask a provider" would be the
 * same call again.
 *
 * The right fix for that is an isolated candidate parse that never dirties provider state, which
 * removes the need instead of relocating it. Until that exists, this rule keeps the door shut.
 */
const MODULE = join(import.meta.dirname, "..", "sourceWorkspace.ts");

const FORBIDDEN = [
	{ pattern: /\bfrom "\.\/supervisor\.js"/, why: "reading the workspace must not be able to ask a provider" },
	{ pattern: /\bfrom "\.\/service\.js"/, why: "the source workspace is upstream of the service" },
	{ pattern: /\bstore\.(?:replaceFile|forgetFile)/, why: "the indexer owns what the index holds" },
	{ pattern: /\bfrom "node:fs"/, why: "reads go through the injected readFile, writes through sourceWriter" },
];

////////////////////////////////
//  Tests

describe("the source workspace is the disk side and only that", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		const source = readFileSync(MODULE, "utf8");
		expect(source).toContain("export class SourceWorkspace");
		expect(source).toContain("symbolSource");
	});

	it("reaches no provider, no index write and no direct filesystem", () => {
		const source = readFileSync(MODULE, "utf8");
		const offenders = FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(
			({ pattern, why }) => `${pattern.source}: ${why}`,
		);

		expect(offenders, "the source workspace reads text and writes text; it does not parse it").toEqual([]);
	});

	it("takes a store, a reader and a root, and nothing else", () => {
		const source = readFileSync(MODULE, "utf8");
		const parameters = /constructor\(([\s\S]*?)\)\s*\{/.exec(source)?.[1] ?? "";
		const named = parameters
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		expect(named).toEqual([
			"private readonly store: IndexStore,",
			"private readonly readFile: (module: string) => string | null,",
			"private readonly workspaceRoot: string,",
		]);
	});
});
