import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { codeOnly, readSwept } from "@nyaa-lexicon/protocol";

/**
 * A ranking reader reads the live surfaces, so a dead address cannot reach it. The raw readers
 * exist for recall, doubt and diagnosis, which must still see stranded rows; the ledger's ranking
 * paths are forbidden them, and a fifth ranking reader cannot forget a check it never writes.
 */
const LEDGER = join(import.meta.dirname, "..", "knowledge.ts");

const RAW = /\.(?:allAnswers|doubtedAnswers|gaps)\s*\(/g;

////////////////////////////////
//  Tests

describe("the ledger ranks over live rows", () => {
	it("fires on the spellings it forbids", () => {
		expect("for (const answer of this.store.allAnswers()) {".match(RAW)).toHaveLength(1);
		expect("const all = this.store.gaps(limit * 4);".match(RAW)).toHaveLength(1);
		expect("for (const answer of this.store.doubtedAnswers()) {".match(RAW)).toHaveLength(1);
		expect("this.store.liveGaps(limit)".match(RAW)).toBeNull();
		expect("store.allAnswers ()".match(RAW)).toHaveLength(1);
		expect("store.doubtedAnswers\n()".match(RAW)).toHaveLength(1);
	});

	it("reaches no raw answer or gap reader from the ledger", () => {
		const source = readSwept(LEDGER);
		expect(source).not.toBeNull();
		expect(codeOnly(source as string).match(RAW) ?? []).toEqual([]);
	});
});
