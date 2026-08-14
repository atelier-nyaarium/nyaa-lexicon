import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Holds ImportResolver to its port, so the language-specific half stays out of it. */
const MODULE = join(import.meta.dirname, "..", "imports.ts");

const FORBIDDEN = [
	{ pattern: /\bfrom "\.\/supervisor\.js"/, why: "providers are reached through the port, not a supervisor" },
	{ pattern: /\bfrom "\.\/resultCache\.js"/, why: "whoever supplies the port owns the caching" },
	{ pattern: /\bfrom "\.\/fileScope\.js"/, why: "surface globs are a workspace decision, not an import one" },
	{ pattern: /\bfrom "node:fs"/, why: "resolution reads the index and the port, never the disk" },
	{ pattern: /\bfrom "\.\/service\.js"/, why: "the resolver is upstream of the service, never the reverse" },
	{ pattern: /\bstore\.(?:replaceFile|forgetFile)/, why: "resolving must not mutate the index" },
];

////////////////////////////////
//  Tests

describe("the import resolver reaches its store and one port", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		const source = readFileSync(MODULE, "utf8");
		expect(source).toContain("export class ImportResolver");
		expect(source).toContain("export type ResolveSpecifier");
	});

	it("reaches no supervisor, no cache, no scope, no disk and no write", () => {
		const source = readFileSync(MODULE, "utf8");
		const offenders = FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(
			({ pattern, why }) => `${pattern.source}: ${why}`,
		);

		expect(offenders, "language-specific resolution belongs behind ResolveSpecifier").toEqual([]);
	});

	// Two dependencies and no more. A third would have to be added here first.
	it("takes the store and the port, and nothing else", () => {
		const source = readFileSync(MODULE, "utf8");
		const parameters = /constructor\(([\s\S]*?)\)\s*\{/.exec(source)?.[1] ?? "";
		const named = parameters
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		expect(named).toEqual(["private readonly store: IndexStore,", "private readonly resolve: ResolveSpecifier,"]);
	});
});
