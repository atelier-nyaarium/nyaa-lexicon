import { expect, test } from "bun:test";
import { composeSymbolId, type Declaration } from "@nyaa-lexicon/protocol";
import { extractFile } from "../extract.js";
import { extractTypeAnnotationsCore } from "../extractCore.js";

const MODULE = "scripts/spans.gd";

function lines(...text: string[]): string {
	return `${text.join("\n")}\n`;
}

function declared(text: string): (name: string) => Declaration | undefined {
	const declarations = extractFile(MODULE, text).declarations;
	return (name) => declarations.find((declaration) => declaration.name === name);
}

function span(declaration: Declaration | undefined): string {
	return `${declaration?.range.start.line}-${declaration?.range.end.line}`;
}

function returnTypes(text: string, declaration: Declaration | undefined): string[] {
	return extractTypeAnnotationsCore(MODULE, text, composeSymbolId)
		.filter((fact) => fact.symbolId === declaration?.symbolId)
		.map((fact) => fact.display);
}

////////////////////////////////
//  Headers and bodies

test("a one-line function ends on its line, and the lines after it are not its body", () => {
	const text = lines(
		"func a() -> int: return 1 if ready else 2",
		"var b = c",
		"func d():",
		"\tpass",
		"class Inner:",
		"\tfunc e(): return 1",
		"\t# still Inner's",
		"\tfunc f(): pass;",
		"func g(): if ready: pass",
	);
	const found = declared(text);
	const scope = extractFile(MODULE, text).references.find((reference) => reference.name === "c")?.fromId;

	expect(["a", "d", "Inner", "e", "f", "g"].map((name) => span(found(name)))).toEqual([
		"0-0",
		"2-3",
		"4-7",
		"5-5",
		"7-7",
		"8-8",
	]);
	expect(found("a")?.metrics).toEqual({ lines: 1, parameters: 0, nesting: 0, branches: 2 });
	expect(scope).toBe(found("spans")?.symbolId);
});

test("a header's parameters and return type come from its tokens, past annotations, strings and comments", () => {
	const text = lines(
		'@warning_ignore("unused") func tagged(a, b, c):',
		"\tpass",
		'func quoted(a = "(:", b = {"k": ")"}) -> String: # (x: y',
		"\treturn a",
		"func keyed(opts = {",
		'\t"k":',
		"\t\t1}) -> int:",
		"\treturn 1",
	);
	const found = declared(text);
	const headers = ["tagged", "quoted", "keyed"].map(found);

	expect(headers.map((declaration) => declaration?.metrics?.parameters)).toEqual([3, 2, 1]);
	expect(headers.map(span)).toEqual(["0-1", "2-3", "4-7"]);
	expect([returnTypes(text, found("quoted")), returnTypes(text, found("keyed"))]).toEqual([["String"], ["int"]]);
});

test("a body runs through a string that closes at column zero and the code after it", () => {
	const text = lines("func f():", '\tvar s = """', 'text""" + x', "\treturn s", "func g():", "\tpass");
	const found = declared(text);
	const scopes = extractFile(MODULE, text).references.map((reference) => reference.fromId);

	expect([span(found("f")), span(found("g"))]).toEqual(["0-3", "4-5"]);
	expect(scopes).toEqual([found("f")?.symbolId, found("f")?.symbolId]);
});

test("a continuation line closes no scope, whether code or a string starts it", () => {
	const text = lines("func f():", "\tvar a = 1 + \\", "2", "\tvar b = 2", '\tvar s = "a" + \\', '"b"', "\tvar t = 1");
	const found = declared(text);

	expect(["b", "t"].map((name) => found(name)?.containerId)).toEqual([found("f")?.symbolId, found("f")?.symbolId]);
});

////////////////////////////////
//  Line heads

test("a spaced annotation's arguments and a byte order mark are tokens apart from the declaration", () => {
	const annotated = declared(lines('@export_enum ("A", "B") var shape: int'));
	const marked = declared(`${String.fromCharCode(0xfeff)}class_name Marked\nvar x = 1\n`);

	expect(annotated("shape")?.signature).toBe('@export_enum ("A", "B") var shape: int');
	expect(marked("Marked")?.languageKind).toBe("class_name");
});
