import { describe, expect, it } from "bun:test";
import { hashContent } from "@nyaa-lexicon/protocol";
import type { SecretFormat } from "@nyaa-lexicon/protocol/secretSyntax";
import { dotenvFormat, jsonFormat, SECRET_SYNTAX_VERSION, yamlFormat } from "../secret/index.js";
import { type CorpusName, decide, formatOf, loadCorpus } from "./secretConformance.js";

////////////////////////////////
//  Constants

/**
 * Reader version pins parser decisions and stored answers.
 * A version change invalidates stored answers for reparse.
 */
const PINNED = { version: 1, digest: "7903f931e50a0fe00b908e83969d1a37" };

const IDS: readonly CorpusName[] = ["dotenv", "json", "yaml"];

////////////////////////////////
//  Functions & Helpers

function corpusDigest(formats: Partial<Record<CorpusName, SecretFormat>> = {}): string {
	const decisions = IDS.flatMap((id) => loadCorpus(id).map((entry) => decide(entry, formats[id] ?? formatOf(entry))));
	return hashContent(JSON.stringify(decisions));
}

/** Reads each value one byte shorter. */
function shortened(format: SecretFormat): SecretFormat {
	return {
		...format,
		read(text) {
			const syntax = format.read(text);
			return {
				documents: syntax.documents.map((document) => ({
					...document,
					nodes: document.nodes.map((node) =>
						node.children.length === 0 && node.value.end - node.value.start > 3
							? { ...node, value: { start: node.value.start, end: node.value.end - 1 } }
							: node,
					),
				})),
			};
		},
	};
}

////////////////////////////////
//  Tests

describe("secret syntax version", () => {
	it("pins the corpus decisions to the version", () => {
		expect(
			{ version: SECRET_SYNTAX_VERSION, digest: corpusDigest() },
			"A secret reader changed what a decision hides. Bump SECRET_SYNTAX_VERSION in formats/src/secret/index.ts and move PINNED.",
		).toEqual(PINNED);
	});

	it("moves when a reader changes its output", () => {
		const base = corpusDigest();

		expect(corpusDigest({ dotenv: shortened(dotenvFormat) })).not.toBe(base);
		expect(corpusDigest({ json: shortened(jsonFormat) })).not.toBe(base);
		expect(corpusDigest({ yaml: shortened(yamlFormat) })).not.toBe(base);
	});
});
