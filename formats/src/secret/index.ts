// Secret-format registry; readers never decide secrecy.
// Register readers with conformance checks.

import type { SecretFormat } from "@nyaa-lexicon/protocol/secretSyntax";
import { dotenvFormat } from "./dotenv.js";
import { jsonFormat } from "./json.js";
import { yamlFormat } from "./yaml.js";

////////////////////////////////
//  Interfaces & Types

export type SecretFormatId = "dotenv" | "json" | "yaml";

export interface RegisteredSecretFormat extends SecretFormat {
	id: SecretFormatId;
}

////////////////////////////////
//  Constants

/**
 * Reader version pins parser decisions and stored answers.
 * A version change invalidates stored answers for reparse.
 */
export const SECRET_SYNTAX_VERSION = 1;

export const SECRET_READERS = {
	dotenv: dotenvFormat,
	json: jsonFormat,
	yaml: yamlFormat,
} satisfies Record<SecretFormatId, RegisteredSecretFormat>;

const FORMATS = Object.values(SECRET_READERS);

////////////////////////////////
//  Functions & Helpers

export function secretFormatFor(module: string): RegisteredSecretFormat | null {
	return FORMATS.find((format) => format.matches(module)) ?? null;
}

export { dotenvFormat, jsonFormat, yamlFormat };
