import { describe, expect, it } from "vitest";
import { coalesce, decideInvalidation, type FileEvent, type InvalidationContext } from "../invalidation";
import type { Route } from "../routing";

////////////////////////////////
//  Helpers

function context(overrides: Partial<InvalidationContext> = {}): InvalidationContext {
	return {
		route: (): Route => ({ owned: true, providerId: "ts" }),
		indexedHash: () => null,
		...overrides,
	};
}

const CHANGED: FileEvent = { kind: "changed", module: "src/a.ts", contentHash: "h2" };

////////////////////////////////
//  Tests

describe("deciding what a change costs", () => {
	it("reindexes a claimed file whose content moved", () => {
		expect(decideInvalidation(CHANGED, context())).toEqual({
			action: "reindex",
			module: "src/a.ts",
			contentHash: "h2",
			providerId: "ts",
		});
	});

	it("ignores a save that changed nothing, since editors write on every save", () => {
		const decision = decideInvalidation(CHANGED, context({ indexedHash: () => "h2" }));
		expect(decision).toMatchObject({ action: "ignore", reason: "content is unchanged" });
	});

	it("reindexes a file the index has never seen", () => {
		expect(decideInvalidation(CHANGED, context({ indexedHash: () => null }))).toMatchObject({ action: "reindex" });
	});

	it("ignores a change to a file no provider claims", () => {
		const decision = decideInvalidation(
			{ kind: "changed", module: "README.md", contentHash: "h1" },
			context({ route: () => ({ owned: false, reason: "unclaimed" }) }),
		);
		expect(decision).toMatchObject({ action: "ignore", reason: "unclaimed" });
	});

	it("ignores a contested file and names the claimants, rather than picking one", () => {
		const decision = decideInvalidation(
			CHANGED,
			context({ route: () => ({ owned: false, reason: "contested", providerIds: ["a", "b"] }) }),
		);
		expect(decision).toMatchObject({ action: "ignore", reason: "claimed by a, b" });
	});

	it("checks content before ownership, so a no-op save costs nothing either way", () => {
		const decision = decideInvalidation(
			CHANGED,
			context({ indexedHash: () => "h2", route: () => ({ owned: false, reason: "unclaimed" }) }),
		);
		expect(decision).toMatchObject({ reason: "content is unchanged" });
	});
});

describe("deleting", () => {
	it("forgets a deleted file", () => {
		expect(decideInvalidation({ kind: "deleted", module: "src/a.ts" }, context())).toEqual({
			action: "forget",
			module: "src/a.ts",
		});
	});

	it("forgets even an unclaimed file, since the index may hold rows from when it was claimed", () => {
		const decision = decideInvalidation(
			{ kind: "deleted", module: "src/a.ts" },
			context({ route: () => ({ owned: false, reason: "unclaimed" }) }),
		);
		expect(decision).toMatchObject({ action: "forget" });
	});
});

describe("coalescing a burst", () => {
	it("keeps only the last event per module", () => {
		const events: FileEvent[] = [
			{ kind: "changed", module: "a.ts", contentHash: "h1" },
			{ kind: "changed", module: "a.ts", contentHash: "h2" },
		];
		expect(coalesce(events)).toEqual([{ kind: "changed", module: "a.ts", contentHash: "h2" }]);
	});

	it("lets a delete win over an earlier change to the same file", () => {
		const events: FileEvent[] = [
			{ kind: "changed", module: "a.ts", contentHash: "h1" },
			{ kind: "deleted", module: "a.ts" },
		];
		expect(coalesce(events)).toEqual([{ kind: "deleted", module: "a.ts" }]);
	});

	it("preserves order by first appearance, so a rename's delete precedes its create", () => {
		const events: FileEvent[] = [
			{ kind: "deleted", module: "old.ts" },
			{ kind: "changed", module: "new.ts", contentHash: "h1" },
			{ kind: "changed", module: "new.ts", contentHash: "h2" },
		];
		expect(coalesce(events).map((e) => e.module)).toEqual(["old.ts", "new.ts"]);
	});

	it("leaves unrelated modules alone", () => {
		const events: FileEvent[] = [
			{ kind: "changed", module: "a.ts", contentHash: "h1" },
			{ kind: "changed", module: "b.ts", contentHash: "h1" },
		];
		expect(coalesce(events)).toHaveLength(2);
	});
});
