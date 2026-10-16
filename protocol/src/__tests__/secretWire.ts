import { SecretJudge, type SecretPolicyWire } from "../secretJudge.js";

export function secretWire(deny: readonly string[] = []): SecretPolicyWire {
	return SecretJudge.fromEvidence(
		{ secrets: {}, deny, syntax: 1 },
		{ tracked: null, aliasesByTarget: new Map(), targets: new Map() },
	).wire;
}
