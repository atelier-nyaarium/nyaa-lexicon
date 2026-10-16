import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECRET_SYNTAX_VERSION } from "@nyaa-lexicon/formats/secret";
import type { SecretsConfig } from "@nyaa-lexicon/protocol";
import { SecretJudge } from "@nyaa-lexicon/protocol/secretJudge";
import { testPolicy } from "./testPolicy";

/** Secret judge golden answers. */

////////////////////////////////
//  Fixtures

interface Scenario {
	name: string;
	secrets: SecretsConfig;
	deny: string[];
	tracking: { kind: "tracked"; files: string[] } | { kind: "noGit" } | { kind: "failed" };
	aliasesByTarget: Array<[string, string[]]>;
	targets: Array<[string, string]>;
	modules: string[];
	answers: Record<string, number>;
	discovery: string[];
	inputs: { tracked: string[]; aliases: Array<[string, string[]]>; targets: Array<[string, string]> };
}

const golden = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/secretJudgeGolden.json"), "utf8")) as {
	answers: string[];
	scenarios: Scenario[];
};

const SCENARIOS = golden.scenarios;

function judgeOf(scenario: Scenario): SecretJudge {
	return SecretJudge.fromEvidence(
		{ secrets: scenario.secrets, deny: scenario.deny, syntax: SECRET_SYNTAX_VERSION },
		{
			tracked: scenario.tracking.kind === "tracked" ? new Set(scenario.tracking.files) : null,
			aliasesByTarget: new Map(scenario.aliasesByTarget),
			targets: new Map(scenario.targets),
		},
	);
}

const byKey = (left: readonly [string, unknown], right: readonly [string, unknown]) =>
	left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;

////////////////////////////////
//  Tests

describe("the secret judge against the policy it replaced", () => {
	it("covers the cases a rewrite could drop", () => {
		expect(SCENARIOS.length).toBeGreaterThan(50);
		const names = SCENARIOS.map((scenario) => scenario.name);
		for (const wanted of [
			"deny globs",
			"omit rules",
			"matchers",
			"empty entry replaces dotenv",
			"aliases in unsorted",
		])
			expect(
				names.some((name) => name.startsWith(wanted)),
				wanted,
			).toBe(true);
		expect(SCENARIOS.every((scenario) => Object.keys(scenario.answers).length > 50)).toBe(true);
	});

	it("stamps for the version of the readers it runs", () => {
		const moved = SCENARIOS.filter((scenario) => judgeOf(scenario).wire.syntax !== SECRET_SYNTAX_VERSION);

		expect(moved.map((scenario) => scenario.name)).toEqual([]);
	});

	it("answers every module with the same kind, rule and stamp", () => {
		const changed: string[] = [];
		for (const scenario of SCENARIOS) {
			const snapshot = judgeOf(scenario);
			for (const [module, index] of Object.entries(scenario.answers)) {
				if (JSON.stringify(snapshot.answer(module)) !== golden.answers[index])
					changed.push(`${scenario.name}: ${module}`);
			}
		}

		expect(changed).toEqual([]);
	});

	it("discovers untracked whole-file answers", () => {
		const changed: string[] = [];
		for (const scenario of SCENARIOS) {
			const policy = testPolicy(".", { secrets: scenario.secrets, deny: scenario.deny });
			const untracked = SecretJudge.fromEvidence(
				{ secrets: scenario.secrets, deny: scenario.deny, syntax: SECRET_SYNTAX_VERSION },
				{ tracked: null, aliasesByTarget: new Map(), targets: new Map() },
			);
			for (const module of scenario.modules) {
				const answer = untracked.answer(module);
				if (
					policy.discovers(module) !==
					(answer.kind === "wholeRedact" || (answer.kind === "omit" && answer.by === "secret"))
				)
					changed.push(`${scenario.name}: ${module} discovery`);
			}
		}

		expect(changed).toEqual([]);
	});

	it("decides from the same tracked files, aliases and targets", () => {
		const changed: string[] = [];
		for (const scenario of SCENARIOS) {
			const { wire } = judgeOf(scenario);
			const aliases = (list: ReadonlyArray<readonly [string, readonly string[]]>) =>
				list.map(([target, names]) => [target, [...names].sort()] as const).sort(byKey);
			if (JSON.stringify(wire.tracked) !== JSON.stringify(scenario.inputs.tracked))
				changed.push(`${scenario.name}: tracked`);
			if (JSON.stringify(aliases(wire.aliases)) !== JSON.stringify(aliases(scenario.inputs.aliases)))
				changed.push(`${scenario.name}: aliases`);
			if (
				JSON.stringify([...wire.targets].sort(byKey)) !==
				JSON.stringify([...scenario.inputs.targets].sort(byKey))
			)
				changed.push(`${scenario.name}: targets`);
		}

		expect(changed).toEqual([]);
	});
});
