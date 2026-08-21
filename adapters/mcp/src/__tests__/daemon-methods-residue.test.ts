import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Holds the daemon-backed backend to methods the daemon actually has.
 *
 * Bug class killed: a tool wired end to end through the in-process backend, green in every unit
 * test, answering `unknown method` from the real server. Nothing in the unit path crosses the
 * daemon wire, so the gap is invisible until someone drives the built binary.
 *
 * DERIVED from both files rather than listed, because a hand-kept list of method names is the same
 * defect one layer up: it would go stale the first time somebody forgot to add to it.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..", "..");

function methodsAsked(): string[] {
	const source = readFileSync(path.join(ROOT, "adapters", "mcp", "src", "main.ts"), "utf8");
	return [...new Set([...source.matchAll(/ask\("([A-Za-z]+)"/g)].map((match) => match[1] as string))].sort();
}

function methodsDispatched(): Set<string> {
	const source = readFileSync(path.join(ROOT, "core", "src", "dispatch.ts"), "utf8");
	return new Set([...source.matchAll(/case "([A-Za-z]+)":/g)].map((match) => match[1] as string));
}

describe("what the MCP server asks a daemon for", () => {
	it("finds methods to check, so a passing run is never vacuous", () => {
		expect(methodsAsked().length).toBeGreaterThan(20);
		expect(methodsDispatched().size).toBeGreaterThan(20);
	});

	it("asks for nothing the daemon cannot answer", () => {
		const dispatched = methodsDispatched();
		const missing = methodsAsked().filter((method) => !dispatched.has(method));

		expect(
			missing,
			"every method the daemon-backed backend asks for needs a case in core/src/dispatch.ts, or the built server answers `unknown method` while every unit test stays green.",
		).toEqual([]);
	});
});
