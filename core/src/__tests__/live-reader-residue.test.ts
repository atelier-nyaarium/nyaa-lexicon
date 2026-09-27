import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readSwept } from "@nyaa-lexicon/protocol";
import { memberCalls, parseSource } from "@nyaa-lexicon/protocol/ast";

/**
 * A ranking reader reads the live surfaces, so a dead address cannot reach it. The raw readers
 * exist for recall, doubt and diagnosis, which must still see stranded rows; the ledger's ranking
 * paths are forbidden them, and a fifth ranking reader cannot forget a check it never writes.
 */
const LEDGER = join(import.meta.dirname, "..", "knowledge.ts");

const RAW = ["allAnswers", "doubtedAnswers", "gaps"];

function rawReads(code: string): string[] {
	return memberCalls(parseSource("probe.ts", code).source, RAW).map(({ name }) => name);
}

////////////////////////////////
//  Tests

describe("the ledger ranks over live rows", () => {
	it("fires on the spellings it forbids", () => {
		expect(rawReads("for (const answer of this.store.allAnswers()) {}")).toHaveLength(1);
		expect(rawReads("const all = this.store.gaps(limit * 4);")).toHaveLength(1);
		expect(rawReads("for (const answer of this.store.doubtedAnswers()) {}")).toHaveLength(1);
		expect(rawReads("this.store.liveGaps(limit)")).toEqual([]);
		expect(rawReads("store.allAnswers ()")).toHaveLength(1);
		expect(rawReads("store.doubtedAnswers\n()")).toHaveLength(1);
		expect(rawReads('store["gaps"](1)')).toHaveLength(1);
	});

	it("reaches no raw answer or gap reader from the ledger", () => {
		const source = readSwept(LEDGER);
		expect(source).not.toBeNull();
		expect(rawReads(source as string)).toEqual([]);
	});
});
