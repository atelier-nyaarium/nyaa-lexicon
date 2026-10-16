import { describe, expect, it } from "bun:test";
import { applySecretMask, assessSecretText, type ReadableSecretRule } from "@nyaa-lexicon/protocol/secretDecision";
import type { SecretSyntaxDocument } from "@nyaa-lexicon/protocol/secretSyntax";
import { ruleFor } from "../../../protocol/src/__tests__/fixtures/secrets/judge.js";
import { jsonFormat } from "../secret/index.js";

////////////////////////////////
//  Fixtures

function read(text: string): SecretSyntaxDocument {
	const document = jsonFormat.read(text).documents[0];
	if (document === undefined) throw new Error("a JSON file is always one document");
	return document;
}

function decide(text: string, matchers: Record<string, unknown>) {
	return assessSecretText(jsonFormat, { matchers: [matchers] } as unknown as ReadableSecretRule, text);
}

const KUBERNETES = ruleFor("deploy/all.json", {}, false) as ReadableSecretRule;

////////////////////////////////
//  Tests

describe("JSON secret reader", () => {
	it("reads JSONC keys, array items and their statuses", () => {
		const text = '{\n  // retained\n  "outer": {"empty": "", "none": null, "items": [true, "x"]},\n}\n';
		const document = read(text);
		const decision = decide(text, { outer: "redact" });

		expect(document.hazards).toEqual([]);
		expect(document.nodes.map((node) => node.names[0])).toEqual([
			undefined,
			"outer",
			"empty",
			"none",
			"items",
			"0",
			"1",
		]);
		expect(document.nodes.filter((node) => node.index !== undefined).map((node) => node.index)).toEqual([0, 1]);
		expect(
			decision.kind === "redacted" ? decision.shown.map((key) => [key.path.join("."), key.status]) : [],
		).toEqual([
			["outer", "set"],
			["outer.empty", "empty"],
			["outer.none", "empty"],
			["outer.items", "set"],
		]);
		expect(decision.kind === "redacted" ? applySecretMask(text, decision.mask) : text).toContain("// retained");
	});

	it("keeps a recovered tree beside the hazard of a truncated tail", () => {
		const text = '{"kind":"Secret",';
		const document = read(text);

		expect(document.nodes.map((node) => node.names[0])).toEqual([undefined, "kind"]);
		expect(jsonFormat.scalar(document, 1)).toEqual({ kind: "decided", value: "Secret", empty: false });
		expect(document.hazards.some((hazard) => hazard.reach === "any" && hazard.span.start === text.length)).toBe(
			true,
		);
	});

	it("masks truncated kubectl output and leaves a truncated package.json plain", () => {
		const secret = decide('{"data":{"token":"X"},', { "kind=Secret": { data: "redact" } });
		const kubernetes = assessSecretText(jsonFormat, KUBERNETES, '{"data":{"token":"FIXTURE_CUT"},');
		const plain = assessSecretText(jsonFormat, KUBERNETES, '{"name":"x",');

		expect(secret.kind).toBe("redacted");
		expect(kubernetes.kind).toBe("redacted");
		expect(plain).toEqual({ kind: "plain" });
	});

	it("reads nesting past the budget as unreadable", () => {
		const text = `${'{"a":'.repeat(600)}1${"}".repeat(600)}`;
		const whole = ruleFor("secrets/credentials.json", {}, false) as ReadableSecretRule;

		expect(assessSecretText(jsonFormat, whole, text)).toEqual({ kind: "unreadable", reason: "budget" });
		expect(() => jsonFormat.read(`${'{"a":'.repeat(5000)}1${"}".repeat(5000)}`)).toThrow();
	});

	it("names a key by its decoded spelling and its raw one", () => {
		const document = read('{"d\\u0061ta": 1, "plain": 2, "dup": 3, "dup": 4}');

		expect(document.nodes.slice(1).map((node) => node.names)).toEqual([
			["data", "d\\u0061ta"],
			["plain"],
			["dup"],
			["dup"],
		]);
	});

	it("decides only the scalars every parser reads alike", () => {
		const text =
			'{"s":"x","e":"","i":12,"neg":-3,"f":1.0,"big":12345678901234567890,"t":true,"n":null,"o":{},"a":[],"bad":"a\\qb"}';
		const document = read(text);
		const readings = Object.fromEntries(
			document.nodes.slice(1).map((node, at) => [node.names[0], jsonFormat.scalar(document, at + 1)]),
		);

		expect(readings).toEqual({
			s: { kind: "decided", value: "x", empty: false },
			e: { kind: "decided", value: "", empty: true },
			i: { kind: "decided", value: "12", empty: false },
			neg: { kind: "decided", value: "-3", empty: false },
			f: { kind: "uncertain", empty: false },
			big: { kind: "uncertain", empty: false },
			t: { kind: "decided", value: "true", empty: false },
			n: { kind: "uncertain", empty: true },
			o: { kind: "uncertain", empty: true },
			a: { kind: "uncertain", empty: true },
			bad: { kind: "uncertain", empty: false },
		});
	});

	it("scopes a local error to the container it sits in", () => {
		const text = '{"a":{"b":1 "c":2},"d":3}';
		const document = read(text);
		const local = document.hazards.filter((hazard) => hazard.reach === "spelled");

		expect(local.length).toBeGreaterThan(0);
		expect(local.every((hazard) => document.nodes[hazard.within]?.names[0] === "a")).toBe(true);
		expect(document.hazards.some((hazard) => hazard.reach === "any")).toBe(false);
	});

	it("reads everything after the first value as reaching any name", () => {
		const text = '{"a":1} {"b":2}';
		const document = read(text);

		expect(document.hazards.some((hazard) => hazard.reach === "any" && hazard.span.end === text.length)).toBe(true);
		const decision = decide(text, { b: "redact" });
		expect(decision.kind === "redacted" ? applySecretMask(text, decision.mask) : text).not.toContain("2");
	});

	it("reads nothing from an empty or comment-only file", () => {
		for (const text of ["", "  ", "// nothing\n"]) {
			const document = read(text);
			expect(document.nodes).toHaveLength(1);
			expect(document.hazards).toEqual([]);
		}
	});

	it("matches JSON files by extension", () => {
		for (const path of ["a.json", "a/B.JSON", "tsconfig.jsonc"]) expect(jsonFormat.matches(path), path).toBe(true);
		for (const path of ["a.jsonl", "json", "a.json5"]) expect(jsonFormat.matches(path), path).toBe(false);
	});
});
