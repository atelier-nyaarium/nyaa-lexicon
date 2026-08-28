import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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
		const matches = files.filter((file) => readFileSync(file, "utf8").includes("isWithin("));
		expect(matches.length).toBeGreaterThan(0);
		// Planner containment is rename closure, not search scope.
		expect(matches.map((file) => path.relative(root, file)).sort()).toEqual(["refactorPlanner.ts", "scope.ts"]);
		expect(existsSync(path.join(root, "scope.ts"))).toBe(true);
	});
});
