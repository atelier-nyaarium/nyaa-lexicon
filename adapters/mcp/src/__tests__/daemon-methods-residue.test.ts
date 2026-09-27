import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { daemonHandlers, type LexiconService } from "@nyaa-lexicon/core";
import { DAEMON_METHODS } from "@nyaa-lexicon/protocol";
import { callsTo, literalText, parseSource } from "@nyaa-lexicon/protocol/ast";

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

/** The method each `ask(...)` names as its first argument. */
function methodsAsked(): string[] {
	const file = path.join(ROOT, "adapters", "mcp", "src", "serve.ts");
	const { source } = parseSource(file, readFileSync(file, "utf8"));
	const methods = callsTo(source, "ask").flatMap((call) => literalText(call.arguments[0]) ?? []);
	return [...new Set(methods)].sort();
}

describe("what the MCP server asks a daemon for", () => {
	it("finds methods to check, so a passing run is never vacuous", () => {
		expect(methodsAsked().length).toBeGreaterThan(20);
		expect(Object.keys(DAEMON_METHODS).length).toBeGreaterThan(20);
		expect(Object.keys(daemonHandlers({} as LexiconService)).sort()).toEqual(Object.keys(DAEMON_METHODS).sort());
	});

	it("asks for nothing the daemon cannot answer", () => {
		const dispatched = new Set(Object.keys(DAEMON_METHODS));
		const missing = methodsAsked().filter((method) => !dispatched.has(method));

		expect(
			missing,
			"every method the daemon-backed backend asks for needs a case in core/src/dispatch.ts, or the built server answers `unknown method` while every unit test stays green.",
		).toEqual([]);
	});
});
