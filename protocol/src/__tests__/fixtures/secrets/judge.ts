// Judge one file without a workspace.

import { SecretJudge } from "../../../secretJudge.js";
import type { EffectiveSecretRule, SecretAnswer, SecretsConfig } from "../../../secrets.js";

////////////////////////////////
//  Interfaces & Types

export interface JudgedFiles {
	deny?: readonly string[];
	/** Tracked paths; null means all untracked. */
	tracked?: readonly string[];
	aliasesByTarget?: ReadonlyMap<string, readonly string[]>;
	targets?: ReadonlyMap<string, string>;
	directoryLinks?: ReadonlyMap<string, string>;
}

////////////////////////////////
//  Functions & Helpers

export function judgeOf(secrets: SecretsConfig = {}, files: JudgedFiles = {}, syntax = 1): SecretJudge {
	return SecretJudge.fromEvidence(
		{ secrets, deny: files.deny ?? [], syntax },
		{
			tracked: files.tracked === undefined ? null : new Set(files.tracked),
			aliasesByTarget: files.aliasesByTarget ?? new Map(),
			targets: files.targets ?? new Map(),
			directoryLinks: files.directoryLinks ?? new Map(),
		},
	);
}

/** Answer for a standalone module. */
export function answerFor(module: string, secrets: SecretsConfig = {}, untracked = false): SecretAnswer {
	return judgeOf(secrets, untracked ? {} : { tracked: [module] }).answer(module);
}

/** Module rule, or null. */
export function ruleFor(module: string, secrets: SecretsConfig = {}, untracked = false): EffectiveSecretRule | null {
	const answer = answerFor(module, secrets, untracked);
	if (answer.kind === "plain") return null;
	return answer.kind === "omit" ? { whole: "omit" } : answer.rule;
}
