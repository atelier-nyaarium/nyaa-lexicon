import { describe, expect, it } from "bun:test";
import type { Range } from "@nyaa-lexicon/protocol";
import { pickSymbol } from "../paintFacts";

////////////////////////////////
//  Helpers

function range(startLine: number, start: number, endLine: number, end: number): Range {
	return { start: { line: startLine, character: start }, end: { line: endLine, character: end } };
}

// class Outer {            line 0
//   method() {             line 1
//     call(helper.run);    line 2: `call` 4..8 bound, `helper` 9..15 unbound, `run` 16..19 bound
//   }                      line 3
// }                        line 4
const REFERENCES = [
	{ range: range(2, 4, 2, 8), target: "call." },
	{ range: range(2, 9, 2, 15), target: null },
	{ range: range(2, 16, 2, 19), target: "Helper#run()." },
];
const DECLARATIONS = [
	{ range: range(0, 0, 4, 1), symbolId: "Outer#" },
	{ range: range(1, 2, 3, 3), symbolId: "Outer#method()." },
];

const at = (line: number, character: number) => pickSymbol(REFERENCES, DECLARATIONS, { line, character });

////////////////////////////////
//  Tests

describe("the symbol under a cursor", () => {
	it("takes a bound reference, else the innermost declaration, and never guesses", () => {
		expect({
			onCall: at(2, 5),
			justPastRun: at(2, 19),
			onUnboundHelper: at(2, 11),
			inMethodBody: at(3, 2),
			inClassOnly: at(4, 0),
			outside: at(6, 0),
		}).toEqual({
			onCall: { symbolId: "call.", via: "reference" },
			justPastRun: { symbolId: "Helper#run().", via: "reference" },
			onUnboundHelper: { symbolId: "Outer#method().", via: "declaration" },
			inMethodBody: { symbolId: "Outer#method().", via: "declaration" },
			inClassOnly: { symbolId: "Outer#", via: "declaration" },
			outside: null,
		});
	});

	it("prefers the reference under the cursor over one ending at it", () => {
		const touching = [
			{ range: range(0, 0, 0, 3), target: "a." },
			{ range: range(0, 3, 0, 6), target: "b." },
		];
		expect(pickSymbol(touching, [], { line: 0, character: 3 })).toEqual({ symbolId: "b.", via: "reference" });
	});
});
