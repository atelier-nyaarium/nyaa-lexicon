import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeOnly } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";

/**
 * Holds factAdmission.ts as the one reading of a provider's symbol ids, taken before the store
 * writes. Bug class killed: every reader re-deciding what an id meant, and the third forgetting.
 */
const STORE = join(import.meta.dirname, "..", "store.ts");

////////////////////////////////
//  Tests

describe("one module admits a provider's facts", () => {
	it("admits before the store's write path opens its transaction", () => {
		const code = codeOnly(readFileSync(STORE, "utf8"));
		const write = code.indexOf("replaceFile(");
		expect(write, "the store's write path is replaceFile").toBeGreaterThan(-1);

		const transaction = code.indexOf("this.inTransaction(", write);
		const admission = code.indexOf("admitFacts(", write);
		expect(transaction).toBeGreaterThan(write);
		expect(
			admission,
			"replaceFile must call admitFacts from core/src/factAdmission.ts before it writes anything",
		).toBeGreaterThan(write);
		expect(admission).toBeLessThan(transaction);
	});
});
