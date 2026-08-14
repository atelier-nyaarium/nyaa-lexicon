import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Holds IndexReadModel to the one property that makes it worth having: a store and nothing else.
 *
 * The point is not tidiness. A caller asking the index a question needs to know it is cheap and
 * safe, and that stops being knowable the moment one query can start a provider, read a file or
 * take a lock. service.ts had exactly that mix, which is why nothing there could be reasoned about
 * without reading the body.
 *
 * Written as a sweep over what the module REACHES rather than over what it is called, since the
 * whole file is read queries and any of them could grow a dependency.
 */
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
