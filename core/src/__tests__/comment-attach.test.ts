import { describe, it } from "vitest";
import { attachComments } from "../commentAttach.js";
import { CASES } from "./commentAttachCases";

////////////////////////////////
//  Tests

// The same table runs against each seeded mutant in comment-attach-mutants.test.ts.
describe("attaching comments to what they document", () => {
	for (const testCase of CASES) {
		it(testCase.name, () => testCase.run(attachComments));
	}
});
