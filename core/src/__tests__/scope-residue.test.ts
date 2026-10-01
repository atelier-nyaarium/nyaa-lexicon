import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { readSwept } from "@nyaa-lexicon/protocol";
import { callsTo, parseSource } from "@nyaa-lexicon/protocol/ast";

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(file) : file.endsWith(".ts") ? [file] : [];
	});
}

describe("scope containment ownership", () => {
	it("keeps structural containment calls in the scope owner and rename planner", () => {
		const root = path.resolve(import.meta.dirname, "..");
		const files = sourceFiles(root).filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`));
		const matches = files.filter((file) => {
			const source = readSwept(file);
			return source !== null && callsTo(parseSource(file, source).source, "isWithin").length > 0;
		});
		expect(matches.length).toBeGreaterThan(0);
		// Planner containment is a rename, move or arrangement closure, not search scope.
		expect(matches.map((file) => path.relative(root, file)).sort()).toEqual([
			"arrangePlanner.ts",
			"refactorPlanner.ts",
			"scope.ts",
		]);
		expect(existsSync(path.join(root, "scope.ts"))).toBe(true);
	});
});
