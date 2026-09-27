import { describe, expect, test } from "bun:test";
import { TOO_DEEP } from "@nyaa-lexicon/protocol";
import { parseKotlinSyntax } from "../grammar.js";
import { lexKotlin } from "../lexer.js";
import { nodesOf, type SyntaxNode, type SyntaxTree } from "../tree.js";

/** Kotlin's template opener, spelled apart from a TypeScript placeholder. */
const D = "$";

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

function read(text: string): { tree: SyntaxTree; problems: string[] } {
	const lexed = lexKotlin(text);
	const { tree, problems } = parseKotlinSyntax(text, lexed.tokens, lexed.comments);
	return { tree, problems: [...lexed.problems, ...problems].map((problem) => problem.message) };
}

/** Broken parent links, spans outside the text or the parent, and children out of order. */
function lineageBreaks(text: string, tree: SyntaxTree): number {
	return nodesOf(tree.root).filter((node) => {
		if (node.start < 0 || node.end > text.length || node.start > node.end) return true;
		return node.children.some(
			(child, index) =>
				child.parent !== node ||
				child.start < node.start ||
				child.end > node.end ||
				(index > 0 && child.start < (node.children[index - 1] as SyntaxNode).end),
		);
	}).length;
}

/** Node types in source order, with the text of each leaf. */
function shape(text: string, type: string): string[] {
	const { tree } = read(text);
	const found = nodesOf(tree.root).find((node) => node.type === type);
	if (found === undefined) return [];
	return nodesOf(found)
		.sort((a, b) => a.start - b.start || b.end - a.end)
		.map((node) => (node.children.length === 0 ? `${node.type}:${text.slice(node.start, node.end)}` : node.type));
}

describe("the Kotlin grammar", () => {
	test("each form reads with no problem over one tree lineage", () => {
		const forms = [
			"val x = 1\n",
			`val json = ${D}${D}"""{ "a": ${D}${D}{x} }"""\nval after = 1\n`,
			`val cost = ${D}${D}"at ${D}amount ${D}${D}{x}"\n`,
			'val q = """a""""\nval e = "\\u0041\\"$"\n',
			"class A { class B { val x = 1 } }\n",
			"val a = listOf(1).filter { open }\nfun open() = true\n",
			"@Target(AnnotationTarget.CLASS) annotation class Marker\n",
			"class A(val d: I) : I by d {\n    fun f() = d\n}\n",
			"val x = 1\n/* c */ fun f() = x\n",
			"fun f() { loop@ for (i in 0 until 3) { if (i > 1) break@loop else continue@loop } }\n",
			"fun g() = listOf(1).forEach { return@forEach }\n",
			"val r = String::length\nval k = List<Int>::size\nval c = Foo::class\n",
			"fun <T : Any> T.f(): T & Any where T : Comparable<T> = this\n",
			"val f: suspend Int.(String?) -> Unit = {}\n",
			"typealias Handler = (Int) -> Unit\n",
			"enum class E(val v: Int) { A(1), B(2) { override fun f() = 2 }; open fun f() = 1 }\n",
			"sealed interface S\ndata object O : S\nvalue class V(val x: Int)\nfun interface F { fun f() }\n",
			"val (a, b) = pair\nval t = try { 1 } catch (e: Exception) { 2 } finally { }\n",
			"val w = when (val s = get()) { in 1..2, 3 -> 1; is String -> 2; !is Int -> 3; else -> 4 }\n",
			"val v = x as? String ?: y!!.z?.w ?: return\n",
			"object : Base(), Iface by impl { }\n",
			'@file:JvmName("Main")\npackage p\n\nimport a.b.C as D\nimport e.*\n',
		];

		for (const text of forms) {
			const { tree, problems } = read(text);
			expect({ text, problems, breaks: lineageBreaks(text, tree) }).toEqual({ text, problems: [], breaks: 0 });
		}
	});

	test("line breaks end statements except inside parentheses and brackets", () => {
		expect(shape("val a = f(1\n    + 2)\n", "value_argument")).toEqual([
			"value_argument",
			"binary_expression",
			"number_literal:1",
			"+:+",
			"number_literal:2",
		]);
		expect(read("val a = 1\n+ 2\n").tree.root.children.map((node) => node.type)).toEqual([
			"property_declaration",
			"unary_expression",
		]);
		expect(read("val a = b\n    .c()\n    ?.d\n").problems).toEqual([]);
		expect(read("val a = xs[1\n    + 2]\n").tree.root.children.map((node) => node.type)).toEqual([
			"property_declaration",
		]);
		expect(read("val a = if (c) 1\nelse 2\n").tree.root.children.map((node) => node.type)).toEqual([
			"property_declaration",
		]);
		expect(read("val a = 1 /* spans\n */ val b = 2\n").tree.root.children.map((node) => node.type)).toEqual([
			"property_declaration",
			"block_comment",
			"property_declaration",
		]);
	});

	test("prefix operators bind looser than postfix, and generic calls stay calls", () => {
		expect(shape("val a = !x.y()\n", "unary_expression")).toEqual([
			"unary_expression",
			"!:!",
			"call_expression",
			"navigation_expression",
			"identifier:x",
			".:.",
			"identifier:y",
			"value_arguments",
			"(:(",
			"):)",
		]);
		expect(shape("val a = runBlocking<Int> { 1 }\n", "call_expression").slice(0, 3)).toEqual([
			"call_expression",
			"identifier:runBlocking",
			"type_arguments",
		]);
	});

	test("templates read as interpolations, and a bare dollar is content", () => {
		const types = (text: string) =>
			(read(text).tree.root.children[0]?.children.at(-1)?.children ?? []).map((node) => node.type);

		expect(types(`val s = "a ${D}name ${D}{x + 1} ${D} b"\n`)).toEqual([
			'"',
			"string_content",
			"interpolation",
			"string_content",
			"interpolation",
			"string_content",
			"string_content",
			"string_content",
			'"',
		]);
		expect(types(`val s = ${D}${D}"${D}x ${D}${D}y"\n`)).toEqual([
			'"',
			"string_content",
			"string_content",
			"interpolation",
			'"',
		]);
	});

	test("nesting past the limit answers one problem instead of exhausting the stack", () => {
		for (const text of [
			`val x = ${"(".repeat(50_000)}1${")".repeat(50_000)}\n`,
			`${"class A { ".repeat(50_000)}${"} ".repeat(50_000)}\n`,
			`val x = ${`"${D}{`.repeat(50_000)}x${'}"'.repeat(50_000)}\n`,
		])
			expect(read(text).problems).toEqual([TOO_DEEP]);
		expect(read(`val x = ${"!".repeat(50_000)}a\n`).problems).toEqual([]);
	});

	test("thousands of one-line delegations each own a class body, in time linear in the owners", () => {
		const count = 4000;
		const text = Array.from(
			{ length: count },
			(_, index) => `interface I${index}\nclass A${index}(val d: I${index}) : I${index} by d { fun f() = d }\n`,
		).join("");
		const started = performance.now();
		const { tree, problems } = read(text);
		const elapsed = performance.now() - started;
		const owners = nodesOf(tree.root).filter((node) => node.type === "class_declaration");

		expect({
			problems,
			breaks: lineageBreaks(text, tree),
			bodied: owners.filter((owner) => owner.children.some((child) => child.type === "class_body")).length,
			lambdas: nodesOf(tree.root).filter((node) => node.type === "annotated_lambda").length,
		}).toEqual({ problems: [], breaks: 0, bodied: count, lambdas: 0 });
		expect(elapsed).toBeLessThan(5000);
	});
});

describe("the Kotlin lexer", () => {
	test("reads each token the specification defines, with its position", () => {
		const tokens = (text: string) => lexKotlin(text).tokens.map((token) => `${token.kind}:${token.text}`);

		expect(tokens("a !in b !is C !invalid as? D")).toEqual([
			"identifier:a",
			"keyword:!in",
			"identifier:b",
			"keyword:!is",
			"identifier:C",
			"punct:!",
			"identifier:invalid",
			"keyword:as?",
			"identifier:D",
			"eof:",
		]);
		expect(tokens("1_000L 0xFFu 1.5f 1e10 .5 'x' '\\u0041'")).toEqual([
			"number:1_000L",
			"number:0xFFu",
			"float:1.5f",
			"float:1e10",
			"float:.5",
			"char:'x'",
			"char:'\\u0041'",
			"eof:",
		]);
		expect(tokens("loop@ for (x in y) break@loop; return@f this@A")).toContain("jump:break@");
		const lead = `${BYTE_ORDER_MARK}#!/usr/bin/env kotlin\n/* a /* b */ c */ `;
		const lexed = lexKotlin(`${lead}val x = 1`);
		expect(lexed.comments.map((comment) => comment.type)).toEqual(["shebang", "block_comment"]);
		expect(lexed.tokens[0]?.start).toBe(lead.length);
	});

	test("an unterminated literal or comment is a problem that runs to the end of the text", () => {
		for (const text of ['val s = "open', 'val s = """open\nclass A\n', "val c = 'x", "/* open\nval x = 1"])
			expect({ text, problems: lexKotlin(text).problems.length }).toEqual({ text, problems: 1 });
	});

	test("a literal the specification does not define is a problem", () => {
		for (const text of ["val n = 0x", "val n = 1_", "val n = 0x_1", "val c = ''", `val s = "${D}\`open\n"`])
			expect({ text, problems: lexKotlin(text).problems.length > 0 }).toEqual({ text, problems: true });
	});
});
