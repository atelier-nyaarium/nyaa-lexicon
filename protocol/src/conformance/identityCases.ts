// Cases about identity: one id names one declaration, in every language that lets a name repeat.

import type { ConformanceCase } from "./types.js";

////////////////////////////////
//  Functions & Helpers

/** Only languages where a repeated name path is legal source have a fixture; the rest skip. */
export function repeatedNamePathCase(): ConformanceCase {
	return {
		id: "a-name-path-declared-twice-in-one-file-mints-two-ids",
		tier: "declarations",
		about: "Two declarations of one name path in one file are two declarations, each with an id of its own.",
		fixtures: {
			reference: {
				files: { "src/twice.ref": "export const work = 1;\nexport const work = 2;\n" },
				subject: "src/twice.ref",
				declarationNames: ["work", "work"],
			},
			typescript: {
				files: {
					"src/twice.ts":
						"export interface Cart {\n\ta: string;\n}\nexport interface Cart {\n\tb: string;\n}\n",
				},
				subject: "src/twice.ts",
				declarationNames: ["Cart", "a", "Cart", "b"],
			},
			python: {
				files: { "src/twice.py": "def work():\n    return 1\n\n\ndef work():\n    return 2\n" },
				subject: "src/twice.py",
				declarationNames: ["work", "work"],
			},
		},
	};
}
