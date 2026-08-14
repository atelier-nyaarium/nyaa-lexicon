import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Holds IndexReadModel to a store. A query that could start a provider is not knowably cheap. */
const MODULE = join(import.meta.dirname, "..", "indexReads.ts");

/** Reaching any of these means a read is no longer only a read. */
const FORBIDDEN = [
	{ pattern: /\bfrom "node:fs"/, why: "a read must not touch the disk" },
	{ pattern: /\bfrom "\.\/supervisor\.js"/, why: "a read must not be able to start or ask a provider" },
	{ pattern: /\bfrom "\.\/sourceWriter\.js"/, why: "a read must not write" },
	{ pattern: /\bfrom "\.\/workspaceGate\.js"/, why: "a read must not take a lock" },
	{ pattern: /\bfrom "\.\/fileScope\.js"/, why: "scope belongs to the indexer, not to a query" },
	{ pattern: /\bfrom "\.\/resultCache\.js"/, why: "caching a query is the caller's decision" },
	{ pattern: /\bfrom "\.\/service\.js"/, why: "the read model is upstream of the service, never the reverse" },
	{ pattern: /\bstore\.(?:replaceFile|forgetFile|record|write)/, why: "a read must not mutate the index" },
];

////////////////////////////////
//  Tests

describe("the index read model reaches nothing but its store", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		const source = readFileSync(MODULE, "utf8");
		expect(source).toContain("export class IndexReadModel");
		expect(source.length).toBeGreaterThan(5_000);
	});

	it("reaches no provider, no disk, no lock, no cache and no write", () => {
		const source = readFileSync(MODULE, "utf8");
		const offenders = FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(
			({ pattern, why }) => `${pattern.source}: ${why}`,
		);

		expect(offenders, "a query that can do more than read the index is not a query any more").toEqual([]);
	});

	// The constructor is the enforcement. A second dependency would have to be added there first.
	it("takes one dependency and it is the store", () => {
		const source = readFileSync(MODULE, "utf8");
		const parameters = /constructor\(([^)]*)\)/.exec(source)?.[1] ?? "";

		expect(parameters.trim().replace(/,$/, "")).toBe("private readonly store: IndexStore");
	});
});
