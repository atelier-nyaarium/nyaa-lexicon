import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readSwept } from "@nyaa-lexicon/protocol";
import { memberReads, parseSource, stringsIn } from "@nyaa-lexicon/protocol/ast";

/** Node's report machinery kills a bun child on the signal it arms, so no source may reach for it. */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");

const SWEPT = ["core/src", "client/src", "adapters/mcp/src", "adapters/lsp/src"].map((dir) => path.join(ROOT, dir));

/** Flags inside a string: each one is the report machinery itself, never a word near it. */
const FLAGS = ["--report-on-signal", "--report-signal", "--report-on-fatalerror", "--report-directory"];

////////////////////////////////
//  Helpers

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") out.push(...sourceFiles(file));
		} else if (entry.name.endsWith(".ts") && statSync(file).isFile()) out.push(file);
	}
	return out;
}

////////////////////////////////
//  Tests

describe("no source arms node's report machinery", () => {
	it("sweeps real files, so a clean run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir).length, dir).toBeGreaterThan(0);
	});

	it("finds no report flag or report API outside the tests", () => {
		const offenders: string[] = [];
		for (const file of SWEPT.flatMap(sourceFiles)) {
			const text = readSwept(file);
			if (text === null) continue;
			const { source } = parseSource(file, text);
			const strings = stringsIn(source);
			const found = FLAGS.filter((flag) => strings.some((piece) => piece.text.includes(flag)));
			if (memberReads(source).some(({ receiver, name }) => receiver === "process" && name === "report")) {
				found.push("process.report");
			}
			for (const token of found) offenders.push(`${path.relative(ROOT, file)}: ${token}`);
		}
		expect(offenders, "diagnostics come from process.memoryUsage and the runtime's heap snapshot").toEqual([]);
	});
});
