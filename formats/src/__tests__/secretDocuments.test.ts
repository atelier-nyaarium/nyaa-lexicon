import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SecretsConfig, SecretsConfigSchema } from "@nyaa-lexicon/protocol";
import { applySecretMask, assessSecretText, type ReadableSecretRule } from "@nyaa-lexicon/protocol/secretDecision";
import { answerFor } from "../../../protocol/src/__tests__/fixtures/secrets/judge.js";
import { secretFormatFor } from "../secret/index.js";

////////////////////////////////
//  Fixtures

interface Fixture {
	path: string;
	config: SecretsConfig;
	untracked: boolean;
	text: string;
	verdict: "plain" | "omit" | "withheld" | "keys" | "masked";
	hiddenValues: string[];
}

const FIXTURES = join(import.meta.dirname, "../../../protocol/src/__tests__/fixtures/secrets/documents.json");

////////////////////////////////
//  Tests

describe("the original secret documents", () => {
	it("hide the same values when a reader that cannot decide masks instead of withholding", () => {
		const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8")) as Fixture[];
		const found: string[] = [];
		for (const fixture of fixtures) {
			const config = SecretsConfigSchema.parse(fixture.config);
			const answer = answerFor(fixture.path, config, fixture.untracked);
			const format = secretFormatFor(fixture.path);
			if (answer.kind === "plain" || answer.kind === "omit") {
				if (fixture.verdict !== answer.kind)
					found.push(`${fixture.path}: ${answer.kind}, not ${fixture.verdict}`);
				continue;
			}
			if (format === null) {
				found.push(`${fixture.path}: no reader`);
				continue;
			}
			const decision = assessSecretText(format, answer.rule as ReadableSecretRule, fixture.text);
			const expected = fixture.verdict === "plain" ? "plain" : "redacted";
			if (decision.kind !== expected) found.push(`${fixture.path}: ${decision.kind}, not ${expected}`);
			if (decision.kind !== "redacted") continue;
			const view = applySecretMask(fixture.text, decision.mask);
			for (const value of fixture.hiddenValues)
				if (view.includes(value)) found.push(`${fixture.path}: ${value} shows`);
		}

		expect(fixtures.length).toBeGreaterThan(0);
		expect(found).toEqual([]);
	});
});
