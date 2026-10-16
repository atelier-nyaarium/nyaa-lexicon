import { describe, expect, it } from "bun:test";
import { applySecretMask, assessSecretText, type ReadableSecretRule } from "@nyaa-lexicon/protocol/secretDecision";
import type { ScalarReading, SecretSyntaxDocument } from "@nyaa-lexicon/protocol/secretSyntax";
import { dotenvFormat } from "../secret/index.js";

////////////////////////////////
//  Fixtures

function read(text: string): SecretSyntaxDocument {
	const document = dotenvFormat.read(text).documents[0];
	if (document === undefined) throw new Error("a dotenv file is always one document");
	return document;
}

function keys(text: string) {
	const document = read(text);
	return document.nodes.slice(1).map((node, at) => ({
		name: node.names[0],
		key: text.slice(node.key.start, node.key.end),
		value: text.slice(node.value.start, node.value.end),
		reading: dotenvFormat.scalar(document, at + 1),
	}));
}

const decided = (value: string): ScalarReading => ({ kind: "decided", value, empty: value === "" });
const uncertain = (empty = false): ScalarReading => ({ kind: "uncertain", empty });

function hidden(text: string, matchers: Record<string, unknown>): string {
	const rule = { matchers: [matchers] } as unknown as ReadableSecretRule;
	const decision = assessSecretText(dotenvFormat, rule, text);
	return decision.kind === "redacted" ? applySecretMask(text, decision.mask) : text;
}

////////////////////////////////
//  Tests

describe("dotenv secret reader", () => {
	it("reads assignments with the spans of their keys and values", () => {
		const text = '\u{FEFF}# header\r\nexport TOKEN = "two words" # ignored\r\nTOKEN=three\r\nEMPTY=\r\n';
		const read_ = keys(text);

		expect(read_.map((key) => [key.name, key.key, key.value])).toEqual([
			["TOKEN", "TOKEN", '"two words"'],
			["TOKEN", "TOKEN", "three"],
			["EMPTY", "EMPTY", ""],
		]);
		expect(read_.map((key) => key.reading)).toEqual([uncertain(), decided("three"), decided("")]);
	});

	it("keeps every key around an unterminated quote and hazards what a shell would swallow", () => {
		const text = 'GOOD=value\nBROKEN="unterminated\nLATER=x';
		const document = read(text);
		const swallowed = { start: text.indexOf("BROKEN"), end: text.length };

		expect(keys(text).map((key) => [key.name, key.value])).toEqual([
			["GOOD", "value"],
			["BROKEN", '"unterminated'],
			["LATER", "x"],
		]);
		expect(document.hazards).toEqual([{ span: swallowed, within: 0, reach: "spelled", reshapes: false }]);
	});

	it("reads colon assignments and treats other lines as commands", () => {
		const colon = keys("PASSWORD: hidden\n");
		const unknown = read("not an assignment\n");

		expect(colon.map((key) => [key.name, key.value])).toEqual([["PASSWORD", "hidden"]]);
		expect(colon[0]?.reading.kind).toBe("uncertain");
		expect(unknown.nodes).toHaveLength(1);
		expect(unknown.hazards).toEqual([{ span: { start: 0, end: 17 }, within: 0, reach: "any", reshapes: false }]);
	});

	it("leaves a value uncertain unless every consumer reads it alike", () => {
		const text = [
			"HASH=Secret#suffix",
			"TICK=`printf Secret`",
			"COMMAND=$(printf Secret)",
			"INTERPOLATION=${SECRET_KIND}",
			'STABLE="Secret#suffix"',
			"TILDE=~",
			"SPACED=a b",
			"SEMICOLON=a;b",
			"PLAIN=Secret",
			"SINGLE='${KIND:-Secret}'",
			'DOUBLE="${KIND:-Secret}"',
			"NAME=$NAME",
			'DOUBLE_NAME="$NAME"',
			"SINGLE_NAME='$NAME'",
			"",
		].join("\n");

		expect(
			Object.fromEntries(
				keys(text).map((key) => [key.name, key.reading.kind === "decided" ? key.reading.value : null]),
			),
		).toEqual({
			HASH: null,
			TICK: null,
			COMMAND: null,
			INTERPOLATION: null,
			STABLE: "Secret#suffix",
			TILDE: null,
			SPACED: null,
			SEMICOLON: null,
			PLAIN: "Secret",
			SINGLE: "${KIND:-Secret}",
			DOUBLE: null,
			NAME: null,
			DOUBLE_NAME: null,
			SINGLE_NAME: "$NAME",
		});
	});

	it("gives a command only where a shell would run one", () => {
		const hazardous = (line: string) => read(`${line}\n`).hazards.filter((hazard) => hazard.reach === "any").length;

		for (const line of [
			"A=foo bar",
			"A=1;B=2",
			"A=`x`",
			'A="$(x)"',
			"A = b",
			"A= b",
			"declare A=1",
			"source other",
			"A.B=1",
		])
			expect(hazardous(line), line).toBeGreaterThan(0);
		for (const line of ["A=~", "A=$B", 'A="x y"', "A='x y'", "A=x # y", "export A=1", "A=", "A=x#y"])
			expect(hazardous(line), line).toBe(0);
	});

	it("takes whitespace around a separator as dotenv-js does", () => {
		const crossed = "DATA\n=FIXTURE_ONE\n";
		const next = "DATA:\nFIXTURE_TWO\nB=1\n";
		const quoted = 'DATA=\n  "FIXTURE_THREE"\n';
		const bare = "# note\rDATA=FIXTURE_FOUR\rB=1\n";

		for (const text of [crossed, next, quoted, bare])
			expect(hidden(text, { DATA: "redact" }), text).not.toMatch(/FIXTURE_(ONE|TWO|THREE|FOUR)/);
		expect(keys(crossed).map((key) => key.name)).toEqual(["DATA"]);
		expect(keys(bare).map((key) => key.name)).toEqual(["DATA", "B"]);
	});

	it("starts a comment only where a shell does", () => {
		const blank = "\u{00A0}";
		const hides = [
			`B=x${blank}#;A=FIXTURE_ONE\n`,
			"B=x\v#;A=FIXTURE_TWO\n",
			`B=${blank}#;A=FIXTURE_THREE\n`,
			`${blank}# c;A=FIXTURE_FOUR\n`,
			" \r# c;A=FIXTURE_FIVE\n",
			"\u{FEFF}# c;A=FIXTURE_SIX\n",
			`export B=x${blank}#;A=FIXTURE_SEVEN\n`,
			"A=''\v#'\nFIXTURE_EIGHT\n",
			"\"\" #\rA='\nFIXTURE_NINE'#",
		];
		const comments = ["B=x #;A=1\n", "  # c;A=1\n", "\t# c;A=1\nB=1\n", "B= #;A=1\n"];

		expect(hides.filter((text) => /FIXTURE_/.test(hidden(text, { A: "redact" })))).toEqual([]);
		expect(comments.filter((text) => hidden(text, { A: "redact" }) !== text)).toEqual([]);
	});

	it("keeps a hash in its word after a quote or an escape", () => {
		const hides = [
			"K=a'x #y';A=FIXTURE_ONE\n",
			'K=a"x #y";A=FIXTURE_TWO\n',
			"K=x\\ #;A=FIXTURE_THREE\n",
			"K=\\\t# c;A=FIXTURE_FOUR\n",
			'A=\\\t#"\nFIXTURE_FIVE"\n',
		];
		const comments = ["K='x' #;A=1\n", 'K="x" #;A=1\n'];

		expect(hides.filter((text) => /FIXTURE_/.test(hidden(text, { A: "redact" })))).toEqual([]);
		expect(comments.filter((text) => hidden(text, { A: "redact" }) !== text)).toEqual([]);
	});

	it("reads the shell lines that a key or a quote opens", () => {
		const hides = [
			"b\rÉ\n=;A=\rFIXTURE_ONE",
			"b\rA:\nA=\rFIXTURE_TWO",
			"É:\nA\n=FIXTURE_THREE",
			"TOKEexport :\r\tA\n=FIXTURE_FOUR",
			"É=`\nA:\n`\nFIXTURE_FIVE`",
			'"\rY="\nA="\rFIXTURE_SIX',
		];

		expect(hides.filter((text) => /FIXTURE_/.test(hidden(text, { A: "redact" })))).toEqual([]);
		expect(keys("É=`\nA:\n`\nd`").map((key) => key.name)).toEqual(["É", "A"]);
	});

	it("rereads the lines after a quote that closes among words", () => {
		const text = "A='one\nB='two\nC=three'\nD=four\n";
		const masked = hidden(text, { C: "redact" });

		expect(masked).not.toContain("three");
		expect(masked).not.toContain("two");
	});

	it("matches dotenv files by name", () => {
		for (const path of [".env", "app/.env.local", "x/.ENV.production", ".envrc"])
			expect(dotenvFormat.matches(path), path).toBe(true);
		for (const path of ["env", "app/config.env", "app/.environment/file.txt"])
			expect(dotenvFormat.matches(path), path).toBe(false);
	});
});
