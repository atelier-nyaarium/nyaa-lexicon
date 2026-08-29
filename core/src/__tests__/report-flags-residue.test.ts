import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { codeOnly, readSwept } from "@nyaa-lexicon/protocol";

/** Node's report machinery kills a bun child on the signal it arms, so no source may reach for it. */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");

const SWEPT = ["core/src", "client/src", "adapters/mcp/src", "adapters/lsp/src"].map((dir) => path.join(ROOT, dir));

/** The narrowest tokens: each one is the report machinery itself, never a word near it. */
const FORBIDDEN = [
	"--report-on-signal",
	"--report-signal",
	"--report-on-fatalerror",
	"--report-directory",
	"process.report",
];

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
			const source = readSwept(file);
			if (source === null) continue;
			const code = codeOnly(source);
			for (const token of FORBIDDEN) {
				if (code.includes(token)) offenders.push(`${path.relative(ROOT, file)}: ${token}`);
			}
		}
		expect(offenders, "diagnostics come from process.memoryUsage and the runtime's heap snapshot").toEqual([]);
	});
});
