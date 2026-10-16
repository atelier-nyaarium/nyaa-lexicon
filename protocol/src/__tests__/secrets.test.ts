import { describe, expect, it } from "bun:test";
import { SecretsConfigSchema } from "../index.js";
import { planSecretRule } from "../secretDecision.js";
import { parseMatcher } from "../secretMatchers.js";

////////////////////////////////
//  Fixtures

type Kind = "key" | "document" | "file" | null;

const MATCHER_KEYS: ReadonlyArray<[string, Kind]> = [
	["password", "key"],
	["a.b.c", "key"],
	["users.*.token", "key"],
	["*", "key"],
	["kind=Secret", "document"],
	["spec.kind=Secret", "document"],
	["kind=a=b", "document"],
	["@untracked", "file"],
	["", null],
	["a..b", null],
	[".a", null],
	["a.b*", null],
	["*a", null],
	["@tracked", null],
	["=x", null],
	["a.*=x", null],
];

////////////////////////////////
//  Tests

describe("secret rules", () => {
	it("accepts normalized prefixes and alternatives and rejects malformed globs", () => {
		expect(SecretsConfigSchema.safeParse({ "./**/*.{yaml,yml}": "redact" }).success).toBe(true);
		expect(SecretsConfigSchema.safeParse({ "**/*.{yaml,}": "redact" }).success).toBe(false);
		expect(SecretsConfigSchema.safeParse({ "**/{yaml,../yml}": "redact" }).success).toBe(false);
	});

	it("rejects an unknown matcher", () => {
		expect(SecretsConfigSchema.safeParse({ "**/*.yaml": { "@tracked": "redact" } }).success).toBe(false);
	});

	it("reads each matcher key alike for the schema and the decision", () => {
		for (const [key, kind] of MATCHER_KEYS) {
			const config = { "**/a.yaml": { [key]: { nested: "redact" } } };
			const leaves = planSecretRule({ matchers: [{ [key]: { nested: "redact" } }] }).leaves;

			expect(parseMatcher(key)?.kind ?? null, key).toBe(kind);
			expect(SecretsConfigSchema.safeParse(config).success, key).toBe(kind !== null);
			expect(leaves.length > 0, key).toBe(kind === "key" || kind === "document");
		}
	});

	it("takes a document check's value as everything after the first equals sign", () => {
		expect(parseMatcher("kind=a=b")).toEqual({ kind: "document", path: ["kind"], expect: "a=b" });
		expect(SecretsConfigSchema.safeParse({ "**/a.yaml": { "kind=Secret": "redact" } }).success).toBe(false);
		expect(SecretsConfigSchema.safeParse({ "**/a.yaml": { password: { "@untracked": "redact" } } }).success).toBe(
			false,
		);
	});
});
