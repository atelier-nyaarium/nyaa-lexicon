import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callsTo, declarationNamed, parseSource, startOf } from "@nyaa-lexicon/protocol/ast";
import type ts from "typescript";

/**
 * Holds factAdmission.ts as the one reading of a provider's symbol ids, taken before the store
 * writes. Bug class killed: every reader re-deciding what an id meant, and the third forgetting.
 */
const STORE = join(import.meta.dirname, "..", "store.ts");

////////////////////////////////
//  Tests

describe("one module admits a provider's facts", () => {
	it("admits before the store's write path opens its transaction", () => {
		const { source } = parseSource(STORE, readFileSync(STORE, "utf8"));
		const write = declarationNamed(source, "replaceFile");
		expect(write, "the store's write path is replaceFile").toBeDefined();

		const transaction = callsTo(write as ts.Node, "inTransaction", "this")[0];
		const admission = callsTo(write as ts.Node, "admitFacts")[0];
		expect(transaction).toBeDefined();
		expect(
			admission,
			"replaceFile must call admitFacts from core/src/factAdmission.ts before it writes anything",
		).toBeDefined();
		expect(startOf(admission as ts.Node)).toBeLessThan(startOf(transaction as ts.Node));
	});
});
