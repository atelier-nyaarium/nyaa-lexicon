import { describe, expect, it } from "bun:test";
import { composeSymbolId, type Declaration, type Range } from "@nyaa-lexicon/protocol";
import {
	maskForDecision,
	protectSecretFacts,
	type RedactedDecision,
	type SecretMask,
	type ShownRange,
	secretDeclarations,
} from "../secrets";

////////////////////////////////
//  Fixtures

const MODULE = "deploy/all.yaml";

function range(line: number): Range {
	return { start: { line, character: 0 }, end: { line, character: 4 } };
}

function shown(path: ShownRange["path"], line: number, document = 0): ShownRange {
	return { document, path, range: range(line), status: "set" };
}

function idOf(...names: Array<string | number>): string {
	return composeSymbolId({
		language: "yaml",
		module: MODULE,
		descriptors: names.map((name) =>
			typeof name === "number"
				? { kind: "namespace" as const, name: `[${name}]` }
				: { kind: "term" as const, name },
		),
	});
}

////////////////////////////////
//  Tests

describe("secret declarations", () => {
	it("declares each shown key under its nearest keyed ancestor, array items passing through", () => {
		const declarations = secretDeclarations(
			"yaml",
			MODULE,
			[shown(["items"], 0), shown(["items", 0, "data"], 1), shown(["items", 0, "data", "token"], 2)],
			1,
		);

		expect(declarations.map(({ symbolId, containerId }) => [symbolId, containerId])).toEqual([
			[idOf("items"), undefined],
			[idOf("items", 0, "data"), idOf("items")],
			[idOf("items", 0, "data", "token"), idOf("items", 0, "data")],
		]);
		expect(declarations.map(({ name, valueStatus }) => [name, valueStatus])).toEqual([
			["items", "set"],
			["data", "set"],
			["token", "set"],
		]);
	});

	it("keeps the last of repeated keys, and numbers the documents of a stream", () => {
		const repeated = secretDeclarations("yaml", MODULE, [shown(["kind"], 0), shown(["kind"], 3)], 1);
		const streamed = secretDeclarations("yaml", MODULE, [shown(["data"], 5, 1)], 2);

		expect(repeated.map(({ selectionRange }) => selectionRange?.start.line)).toEqual([3]);
		expect(streamed.map(({ symbolId }) => symbolId)).toEqual([idOf(1, "data")]);
	});

	it("declares nothing for an array item or an empty list, and never throws", () => {
		expect(secretDeclarations("yaml", MODULE, [shown(["items", 0], 1)], 1)).toEqual([]);
		expect(secretDeclarations("yaml", MODULE, [], 0)).toEqual([]);
	});
});

describe("provider facts under a mask", () => {
	const at = (line: number, from: number, to: number): Range => ({
		start: { line, character: from },
		end: { line, character: to },
	});
	const property = (name: string, line: number, valueEnd: number): Declaration => ({
		symbolId: idOf(name),
		kind: "property",
		name,
		range: at(line, 0, valueEnd),
		selectionRange: at(line, 0, name.length),
		visibility: "public",
		signature: `${name}: value`,
	});
	const facts = {
		module: MODULE,
		contentHash: "hash",
		declarations: [
			property("kept", 0, 7),
			property("shown", 1, 13),
			property("dropped", 2, 12),
			property("tail", 3, 8),
		],
		references: [],
		imports: [],
		literals: [
			{ kind: "string", value: "one", range: at(0, 6, 9) },
			{ kind: "string", value: "HIDDEN", range: at(1, 7, 13) },
			{ kind: "string", value: "OMITTED", range: at(2, 9, 16) },
		],
		comments: [{ range: at(1, 9, 22), text: "HIDDEN note" }],
		diagnostics: [],
	} as unknown as Parameters<typeof protectSecretFacts>[0];
	const mask: SecretMask = {
		wholeFile: false,
		spans: [at(1, 7, 13)],
		omitted: [at(2, 0, 16)],
		shown: [{ document: 0, path: ["shown"], range: at(1, 0, 5), status: "set" }],
	};

	it("clamps a shown key to its name and drops what the mask covers or removes", () => {
		const protectedFacts = protectSecretFacts(facts, mask);
		const shown = protectedFacts.declarations.find(({ name }) => name === "shown");

		expect(protectedFacts.declarations.map(({ name }) => name)).toEqual(["kept", "shown", "tail"]);
		expect(shown).toMatchObject({ range: at(1, 0, 5), valueStatus: "set" });
		expect(shown?.signature).toBeUndefined();
		expect(protectedFacts.literals.map(({ value }) => value)).toEqual(["one"]);
		expect(protectedFacts.comments).toEqual([]);
	});

	it("keeps everything under a mask that hides nothing", () => {
		const nothing: SecretMask = { wholeFile: false, spans: [], omitted: [], shown: [] };
		const protectedFacts = protectSecretFacts(facts, nothing);

		expect(protectedFacts.declarations).toEqual(facts.declarations);
		expect(protectedFacts.literals).toEqual(facts.literals);
	});
});

describe("a decision's mask", () => {
	const decision = (mask: Array<{ start: number; end: number }>): RedactedDecision => ({
		kind: "redacted",
		documents: 1,
		mask,
		omitted: [],
		shown: [],
	});

	it("places each span in line and character positions", () => {
		const placed = maskForDecision("ab\ncd\n", decision([{ start: 1, end: 4 }]), false);

		expect(placed?.spans).toEqual([{ start: { line: 0, character: 1 }, end: { line: 1, character: 1 } }]);
		expect(placed?.wholeFile).toBe(false);
	});

	it("refuses a span the text cannot address rather than clamp it", () => {
		expect(maskForDecision("ab", decision([{ start: 0, end: 9 }]), true)).toBeNull();
	});
});
