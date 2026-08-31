import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, type Declaration } from "@nyaa-lexicon/protocol";
import { storeCompatibilityKey } from "../fingerprint";
import { IndexStore } from "../store";

////////////////////////////////
//  Helpers

const roots: string[] = [];

function root(manifest: string | null): string {
	const dir = mkdtempSync(path.join(tmpdir(), "lexicon-compat-"));
	roots.push(dir);
	if (manifest !== null) writeFileSync(path.join(dir, "package.json"), manifest);
	return dir;
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("what decides that stored facts expired", () => {
	// Patch and minor share a major.
	it("answers the same for a patch and a minor, and differently for a major", () => {
		const key = (version: string) => storeCompatibilityKey(root(`{"version": "${version}"}`));

		expect(key("1.12.0")).toBe(key("1.12.1"));
		expect(key("1.12.0")).toBe(key("1.13.0"));
		expect(key("1.12.0")).not.toBe(key("2.0.0"));
	});

	// Null skips comparison.
	it("declines to answer when there is no readable version", () => {
		expect(storeCompatibilityKey(root(null))).toBeNull();
		expect(storeCompatibilityKey(root("{ not json"))).toBeNull();
		expect(storeCompatibilityKey(root('{"name": "x"}'))).toBeNull();
		expect(storeCompatibilityKey(root('{"version": "nonsense"}'))).toBeNull();
		expect(storeCompatibilityKey(root('{"version": "1.x"}'))).toBeNull();
		expect(storeCompatibilityKey(root('{"version": 1}'))).toBeNull();
	});

	// A prerelease of a major is that major.
	it("reads a prerelease as its own major", () => {
		expect(storeCompatibilityKey(root('{"version": "2.0.0-rc.1"}'))).toBe("2");
	});

	// Both halves together: real release strings driving a real store.
	it("keeps facts through a patch and a minor, and drops them on a major", () => {
		const file = path.join(root(null), "series.sqlite");
		const point = { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };
		const declaration: Declaration = {
			symbolId: composeSymbolId({
				language: "ts",
				module: "src/a.ts",
				descriptors: [{ kind: "term", name: "add" }],
			}),
			kind: "function",
			name: "add",
			range: point,
			selectionRange: point,
			visibility: "public",
		};
		const openAt = (version: string) =>
			IndexStore.open(file, storeCompatibilityKey(root(`{"version": "${version}"}`)));

		const first = openAt("1.12.0");
		first.store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [declaration],
			references: [],
		});
		first.store.close();

		for (const release of ["1.12.1", "1.13.0"]) {
			const next = openAt(release);
			expect(next.rebuilt, release).toBe(false);
			expect(next.store.declarationsIn("src/a.ts"), release).toHaveLength(1);
			next.store.close();
		}

		const major = openAt("2.0.0");
		expect(major.rebuilt).toBe(true);
		expect(major.store.declarationsIn("src/a.ts")).toEqual([]);
		major.store.close();
	});
});
