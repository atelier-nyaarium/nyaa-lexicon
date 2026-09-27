import { describe, expect, it } from "bun:test";
import { coordinatesOf, MAX_NESTING, type Position, TOO_DEEP } from "@nyaa-lexicon/protocol";
import type * as A from "../syntax/ast.js";
import { walk } from "../syntax/ast.js";
import { parsePowerShell } from "../syntax/parser.js";

function script(text: string): A.ScriptBlock {
	const parsed = parsePowerShell(text);
	if (parsed.script === undefined) throw new Error(parsed.problem?.message);
	return parsed.script;
}

/** Every node as `type pos-end`, as PowerShell's `FindAll` lists them. */
function nodes(text: string): string[] {
	return walk(script(text)).map((node) => `${node.type} ${node.pos}-${node.end}`);
}

function accepts(text: string): boolean {
	return parsePowerShell(text).script !== undefined;
}

describe("PowerShell tokenizer", () => {
	it("places every token on its line and column, and a file token on its text", () => {
		const text = `\r\nfunction f($a) {\r\n  "x $a $(g ""q"") y" | h @'\r\nbody\r\n'@\r\n}\r\n# done\r\n`;
		const parsed = parsePowerShell(text);
		const coordinates = coordinatesOf(text);
		expect(parsed.problem).toBeUndefined();
		for (const token of parsed.tokens) {
			expect({ line: token.line, character: token.column }).toEqual(
				coordinates.positionAt(token.pos) as Position,
			);
			// A string's `$(...)` reads its doubled quotes as one.
			if (!token.text.includes('"q"')) expect(text.slice(token.pos, token.end)).toBe(token.text);
		}
		expect(parsed.tokens.filter((token) => token.kind === "Comment").map((token) => token.text)).toEqual([
			"# done",
		]);
	});
});

describe("PowerShell parser", () => {
	it("spans nodes as PowerShell 7.6 does", () => {
		expect(nodes("function f {}")).toContain("NamedBlockAst 0-0");
		expect(nodes("function f { }")).toContain("NamedBlockAst 12-12");
		expect(nodes("function f {\n}")).toContain("NamedBlockAst 12-12");
		// An expression's pipeline unwraps under an assignment.
		expect(nodes("$x = 1")).toEqual([
			"ScriptBlockAst 0-6",
			"NamedBlockAst 0-6",
			"AssignmentStatementAst 0-6",
			"VariableExpressionAst 0-2",
			"CommandExpressionAst 5-6",
			"ConstantExpressionAst 5-6",
		]);
		expect(nodes('$x = "a$(1 + ""2"")b"')).toContain("BinaryExpressionAst 9-18");
		expect(nodes("Get-Item x\n  | Select y")).toContain("PipelineAst 0-23");
		expect(nodes("$a ? 1 : 2")).toContain("TernaryExpressionAst 0-10");
	});

	it("refuses what PowerShell's parser refuses", () => {
		for (const text of [
			"a,",
			"$x.",
			"function f(",
			"if ($x) {",
			"@{a=1",
			'"open',
			"<# open",
			"$x =",
			"[int",
			"f -p:",
			"a | | b",
			"foreach ($x in) {}",
			"try {}",
			`x $\{}`,
		]) {
			expect([text, accepts(text)]).toEqual([text, false]);
		}
	});

	it("places a refusal where PowerShell does, and still reads comments past it", () => {
		expect(parsePowerShell('$x = @"\nbody\n    "@').problem?.pos).toBe(17);
		const refused = parsePowerShell("f\n}\n# after\n$y = 1 <# open");
		expect(refused.problem?.pos).toBe(2);
		expect(refused.tokens.filter((token) => token.kind === "Comment").map((token) => token.text)).toEqual([
			"# after",
			"<# open",
		]);
	});

	it("types and values numbers as PowerShell's tokenizer does", () => {
		const constant = (text: string) => {
			const statement = script(text).blocks[0]?.statements[0];
			const element = statement?.type === "PipelineAst" ? statement.elements[0] : undefined;
			const expression = element?.type === "CommandExpressionAst" ? element.expression : undefined;
			return expression?.type === "ConstantExpressionAst" ? [expression.staticType, expression.value] : undefined;
		};
		expect(["0xFFFFFFFF", "1e999", "2gb", "1.5u", "2.5y", "7uy", "0b11111111"].map(constant)).toEqual([
			["int", -1],
			["double", Number.POSITIVE_INFINITY],
			["long", 2147483648],
			["uint", 2],
			["sbyte", 2],
			["byte", 7],
			// Eight binary digits read a sign bit.
			["int", -1],
		]);
		for (const text of ["1e30d", "1e999u", "0x10000000000000000", "256uy"])
			expect([text, accepts(text)]).toEqual([text, false]);
	});

	it("leaves semantic checks, #Requires and signature blocks to PowerShell", () => {
		for (const text of [
			"1 = 2",
			"[ValidateSet('a')]'x'",
			"[Parameter(Mandatory, Mandatory)]$x = 1",
			"#requires -version\n",
			"# SIG # Begin signature block\nsignature block\n",
		]) {
			expect([text, accepts(text)]).toEqual([text, true]);
		}
	});

	it("reads the newest grammar and the oldest: 7.x operators, clean blocks, workflows", () => {
		for (const text of [
			"$a ?? $b",
			"$a?.b",
			"a && b || c",
			"a &",
			"function f { clean { } }",
			"workflow w { parallel { a } }",
			"class A : B { A() : base(1) { } [int] $x = 1 }",
		]) {
			expect([text, accepts(text)]).toEqual([text, true]);
		}
	});

	it("refuses a tree deeper than the nesting limit", () => {
		expect(parsePowerShell(`${"(".repeat(MAX_NESTING)}1${")".repeat(MAX_NESTING)}`).problem?.message).toBe(
			TOO_DEEP,
		);
		expect(accepts(`${"(".repeat(100)}1${")".repeat(100)}`)).toBe(true);
		expect(parsePowerShell(`1${" + 1".repeat(MAX_NESTING * 5)}`).problem?.message).toBe(TOO_DEEP);
	});
});
