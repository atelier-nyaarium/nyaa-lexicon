import { z } from "zod";
import { expandSecretGlob } from "./glob.js";
import { isMatcherMap, validateMatcherMap } from "./secretMatchers.js";

////////////////////////////////
//  Reader Facts

export const ValueStatusSchema = z.enum(["set", "empty"]).meta({ id: "ValueStatus" });

export type ValueStatus = z.infer<typeof ValueStatusSchema>;

////////////////////////////////
//  Configuration

export const SecretModeSchema = z.enum(["redact", "omit"]).meta({ id: "SecretMode" });

export type SecretMode = z.infer<typeof SecretModeSchema>;

export type SecretMatcherValue = SecretMode | { readonly [matcher: string]: SecretMatcherValue };

const SecretMatcherValueSchema: z.ZodType<SecretMatcherValue> = z.lazy(() =>
	z.union([SecretModeSchema, z.record(z.string(), SecretMatcherValueSchema)]),
);

const SecretGlobSchema = z.string().min(1).max(256);

export const SecretsConfigSchema = z
	.record(SecretGlobSchema, SecretMatcherValueSchema)
	.superRefine((config, context) => {
		for (const [glob, matcher] of Object.entries(config)) {
			if (expandSecretGlob(glob) === null) {
				context.addIssue({ code: "custom", message: "invalid secret glob", path: [glob] });
				continue;
			}
			if (isMatcherMap(matcher))
				for (const issue of validateMatcherMap(matcher, [glob], true))
					context.addIssue({ code: "custom", ...issue });
		}
	})
	.meta({ id: "SecretsConfig" });

export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;

////////////////////////////////
//  Matching Types

export interface SecretRule {
	whole?: "redact";
	matchers: readonly SecretMatcherMap[];
}

export type EffectiveSecretRule = { whole: "omit" } | { whole: "redact" } | SecretRule;

/** Readable rules exclude whole-file omissions. */
export type ReadableSecretRule = Exclude<EffectiveSecretRule, { whole: "omit" }>;

export type SecretMatcherMap = { readonly [matcher: string]: SecretMatcherValue };

export type SecretAnswer =
	| { kind: "plain"; stamp: null }
	| { kind: "omit"; by: "deny" | "secret"; stamp: string }
	| { kind: "wholeRedact"; rule: ReadableSecretRule; stamp: string }
	| { kind: "matchers"; rule: SecretRule; stamp: string };
