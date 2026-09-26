import { describe, expect, test } from "bun:test";
import { composeSymbolId, FOLD_MARK } from "@nyaa-lexicon/protocol";
import { extractDeclarationsCore } from "../extractCore.js";

function signatures(text: string, module = "scripts/header.gd"): Record<string, string | undefined> {
	return Object.fromEntries(
		extractDeclarationsCore(module, text, composeSymbolId).map((declaration) => [
			declaration.name,
			declaration.signature,
		]),
	);
}

function fold(open: string, close: string): string {
	return `${open}${FOLD_MARK}${close}`;
}

describe("a GDScript header", () => {
	test("a multi-line function header joins, keeps its annotation and return type, and drops comments", () => {
		const found = signatures(
			[
				"class_name Shapes",
				"",
				"## Doc.",
				'@warning_ignore("unused")',
				"# why",
				"static func solve(",
				"\tvalue: int, # the value",
				"\tother := [1, 2],",
				") -> Array[int]:",
				"\treturn [value]",
				"",
			].join("\r\n"),
		);

		expect(found).toEqual({
			Shapes: "class_name Shapes",
			solve: `@warning_ignore("unused") static func solve(value: int, other := ${fold("[", "]")}) -> Array[int]:`,
			value: undefined,
			other: undefined,
		});
	});

	test("a value keeps its initializer with each literal folded, and types, subscripts and calls whole", () => {
		const found = signatures(
			[
				"const TABLE = [",
				'\t"a", # first',
				"]",
				"var typed: Array[int] = [1] + [] if ready else [2]",
				'var data := {"k": [1]}',
				'var first = "abc"[0] + items[1]',
				"var made := Vector2(1, 2)",
				"var sum = 1 + \\",
				"\t2",
				"const A := 1; var b := {}",
				"",
			].join("\n"),
		);

		expect(found).toMatchObject({
			TABLE: `const TABLE = ${fold("[", "]")}`,
			typed: `var typed: Array[int] = ${fold("[", "]")} + [] if ready else ${fold("[", "]")}`,
			data: `var data := ${fold("{", "}")}`,
			first: 'var first = "abc"[0] + items[1]',
			made: "var made := Vector2(1, 2)",
			sum: "var sum = 1 + 2",
			A: "const A := 1",
			b: "var b := {}",
		});
	});

	test("a lambda body folds to the mark alone, inline, indented or inside a call", () => {
		const found = signatures(
			[
				"var handler = func(value: int) -> int: # c",
				"\t# note",
				"\treturn value",
				'var inline = func(): return "x"',
				"var passed = run(func(a):",
				"\treturn a",
				")",
				"var listed = run(func(): return [1], 2)",
				"",
			].join("\n"),
		);

		expect(found).toMatchObject({
			handler: `var handler = func(value: int) -> int: ${FOLD_MARK}`,
			inline: `var inline = func(): ${FOLD_MARK}`,
			passed: `var passed = run(func(a): ${FOLD_MARK})`,
			listed: `var listed = run(func(): ${FOLD_MARK}, 2)`,
		});
	});

	test("owned annotations above join the header, and script or group annotations do not", () => {
		const found = signatures(
			[
				"@tool",
				"class_name Box extends Node",
				"",
				'@export_group("Stats")',
				"@export var hp := 1",
				'@export_category("X") @export var mp := 2',
				"@onready",
				"# note",
				"var label: Label = $Label",
				"",
			].join("\n"),
		);

		expect(found).toMatchObject({
			Box: "class_name Box extends Node",
			hp: "@export var hp := 1",
			mp: "@export var mp := 2",
			label: "@onready var label: Label = $Label",
		});
	});

	test("a block header ends at its colon, and an enum at its brace", () => {
		const found = signatures(
			[
				"var health: int = 10:",
				"\tget:",
				"\t\treturn health",
				"var shown:",
				"\tget:",
				"\t\treturn 1",
				"class Inner extends Node:",
				"\tfunc call() -> void: pass",
				"enum State { READY, DONE = 2 }",
				"enum Wide {",
				"\tFIRST, # first",
				"\tSECOND = (1 +",
				"\t\t2),",
				"}",
				"signal changed(",
				"\tvalue: int,",
				")",
				"func loop():",
				"\tfor index: int in range(2):",
				"\t\tpass",
				"",
			].join("\n"),
		);

		expect(found).toMatchObject({
			health: "var health: int = 10:",
			shown: "var shown:",
			Inner: "class Inner extends Node:",
			call: "func call() -> void:",
			State: "enum State",
			READY: "READY",
			DONE: "DONE = 2",
			Wide: "enum Wide",
			FIRST: "FIRST",
			SECOND: "SECOND = (1 + 2)",
			changed: "signal changed(value: int)",
			index: "for index: int in range(2):",
		});
	});

	test("a string keeps its spacing, a line break in it is escaped, and it holds the header open", () => {
		const found = signatures(
			[
				'@rpc("any  peer")',
				'func tagged(label := "x  y") -> String:',
				"\treturn label",
				'const DOC = """one',
				'\ttwo  # kept"""',
				'const NAME := &"a  b"; const PATH := ^"x\ty"',
				'var list = ["a  b"]',
				"",
			].join("\n"),
		);

		expect(found).toMatchObject({
			tagged: '@rpc("any  peer") func tagged(label := "x  y") -> String:',
			DOC: 'const DOC = """one\\n\\ttwo  # kept"""',
			NAME: 'const NAME := &"a  b"',
			PATH: 'const PATH := ^"x\\ty"',
			list: `var list = ${fold("[", "]")}`,
		});
	});

	test("renders a line of many declarations in time linear in their count", () => {
		const timed = (count: number) => {
			const segments = Array.from({ length: count }, (_, index) => `var a${index} = "s  ${index}"`).join("; ");
			const members = Array.from({ length: count }, (_, index) => `M${index} = ${index}`).join(", ");
			const text = `${segments}\nenum Big { ${members} }\n`;
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				extractDeclarationsCore("scripts/many.gd", text, composeSymbolId);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		// Linear reads 8x; a walk of every sibling per declaration reads 64x.
		expect(timed(4_000) / timed(500)).toBeLessThan(24);
	});
});
