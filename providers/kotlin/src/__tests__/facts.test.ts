import { describe, expect, test } from "bun:test";
import { coordinatesOf, type Declaration } from "@nyaa-lexicon/protocol";
import { KotlinProvider } from "../main.js";
import { parseKotlin } from "../parse.js";

/** Kotlin's template opener, spelled apart from a TypeScript placeholder. */
const D = "$";

function named(declarations: Declaration[], name: string, kind?: string): Declaration | undefined {
	return declarations.find((item) => item.name === name && (kind === undefined || item.kind === kind));
}

function errors(text: string): boolean {
	return parseKotlin("F.kt", text).diagnostics.some((item) => item.severity === "error");
}

describe("declarations", () => {
	test("every form reports its kind, language kind, container, visibility and id", () => {
		const text = [
			"package demo",
			"",
			"data class Cart(val id: Int, private var label: String, count: Int) {",
			"    companion object { const val LIMIT = 3 }",
			'    private val hidden = "x"',
			'    suspend fun fetch(item: Int): String { if (item > 0) return label; return "none" }',
			"    inner class Detail",
			"    private constructor(code: String) : this(1, code, 0)",
			"    init { val seed = 1 }",
			"}",
			"interface Service",
			"sealed abstract class State",
			"enum class Mode { READY, DONE(1) }",
			"object Registry",
			"typealias Alias = Cart",
			"fun String.ext(): Int = length",
			"internal val visible = true",
			"protected fun hiddenFunction() {}",
			"abstract class Outer private constructor(seed: Int) { companion object Factory }",
			"fun same(value: Int) {}",
			"fun same(value: String) {}",
			"fun local() { val x = 1; run { val x = 2 } }",
			"",
		].join("\n");
		const facts = parseKotlin("demo/Cart.kt", text);
		const byId = new Map(facts.declarations.map((item) => [item.symbolId, item]));
		const rows = facts.declarations.map((item) => [
			item.symbolId.replace("lexicon kotlin demo/Cart.kt ", ""),
			item.kind,
			item.languageKind ?? null,
			item.containerId === undefined ? null : (byId.get(item.containerId)?.symbolId.split(" ").at(-1) ?? null),
			item.visibility,
			item.exported,
		]);

		expect(rows).toEqual([
			["demo/", "package", "package", null, "public", true],
			["Cart#", "class", "data", null, "public", true],
			["Cart#Cart().", "constructor", "primaryConstructor", "Cart#", "public", true],
			["Cart#id.", "property", "constructorVal", "Cart#", "public", true],
			["Cart#label.", "property", "constructorVar", "Cart#", "private", false],
			["Cart#Cart().(count)", "variable", "parameter", "Cart#Cart().", "local", false],
			["Cart#Companion#", "class", "companionObject", "Cart#", "public", true],
			["Cart#Companion#LIMIT.", "constant", "constVal", "Cart#Companion#", "public", true],
			["Cart#hidden.", "property", "val", "Cart#", "private", false],
			["Cart#fetch().", "method", "suspend", "Cart#", "public", true],
			["Cart#fetch().(item)", "variable", "parameter", "Cart#fetch().", "local", false],
			["Cart#Detail#", "class", "inner", "Cart#", "public", true],
			["Cart#Cart(1).", "constructor", "secondaryConstructor", "Cart#", "private", false],
			["Cart#Cart(1).(code)", "variable", "parameter", "Cart#Cart(1).", "local", false],
			["Cart#init:seed.", "variable", "val", "Cart#", "local", false],
			["Service#", "interface", "interface", null, "public", true],
			["State#", "class", "sealed abstract", null, "public", true],
			["Mode#", "enum", "enum", null, "public", true],
			["Mode#READY.", "constant", "enumEntry", "Mode#", "public", true],
			["Mode#DONE.", "constant", "enumEntry", "Mode#", "public", true],
			["Registry#", "class", "object", null, "public", true],
			["Alias#", "class", "typealias", null, "public", true],
			["ext().", "function", "extensionFunction", null, "public", true],
			["visible.", "property", "val", null, "internal", true],
			["hiddenFunction().", "function", null, null, "protected", false],
			["Outer#", "class", "abstract", null, "public", true],
			["Outer#Outer().", "constructor", "primaryConstructor", "Outer#", "private", false],
			["Outer#Outer().(seed)", "variable", "parameter", "Outer#Outer().", "local", false],
			["Outer#Factory#", "class", "companionObject", "Outer#", "public", true],
			["same().", "function", null, null, "public", true],
			["same().(value)", "variable", "parameter", "same().", "local", false],
			["same(1).", "function", null, null, "public", true],
			["same(1).(value@1)", "variable", "parameter", "same(1).", "local", false],
			["local().", "function", null, null, "public", true],
			["local().x.", "variable", "val", "local().", "local", false],
			["local().x@1.", "variable", "val", "local().", "local", false],
		]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("signatures carry modifiers, receivers and type parameters; metrics count the body", () => {
		const facts = parseKotlin(
			"Functions.kt",
			[
				"suspend fun List<String>.join(separator: String): String = joinToString(separator)",
				"abstract fun <T> Iterable<Flow<T>>.merge(): Flow<T>",
				"internal var <T> WorkaroundAtomicReference<T>.value: T",
				'fun fetch(item: Int): String { if (item > 0) { return "a" }; return "none" }',
				"fun use(values: List<Int>) = values.filter { it > 0 }.map { it + 1 }",
			].join("\n"),
		);

		expect(named(facts.declarations, "join")).toMatchObject({
			languageKind: "suspend extensionFunction",
			signature: "suspend fun List<String>.join(separator: String): String",
		});
		expect(named(facts.declarations, "merge")?.signature).toContain("<T> Iterable<Flow<T>>.merge(): Flow<T>");
		expect(named(facts.declarations, "value")?.signature).toContain("<T> WorkaroundAtomicReference<T>.value: T");
		expect(named(facts.declarations, "fetch")?.metrics).toMatchObject({ parameters: 1, branches: 2, nesting: 1 });
		expect(named(facts.declarations, "use")?.metrics?.parameters).toBe(1);
		expect(
			new Set(
				facts.references.filter((item) => item.reference.role === "typeUse").map((item) => item.reference.name),
			),
		).toEqual(new Set(["List", "String", "T", "Iterable", "Flow", "WorkaroundAtomicReference", "Int"]));
	});

	test("ranges count UTF-16 units, cover bodies, and stop at a semicolon or before a trailing newline", () => {
		const text = [
			'/* 😀 */ val before = "😀"; val name = 2',
			"class Box {",
			"    fun get(): Int { return 1 }",
			"}",
			"class First; class Second {}",
			"enum class Color { RED(1), GREEN }",
			"val café = 1",
			"",
			"",
		].join("\n");
		const facts = parseKotlin("Ranges.kt", text);
		const cut = (item: Declaration | undefined) =>
			item === undefined ? undefined : coordinatesOf(text).sliceRange(item.range);

		expect(named(facts.declarations, "name")?.selectionRange).toEqual({
			start: { line: 0, character: 32 },
			end: { line: 0, character: 36 },
		});
		expect(cut(named(facts.declarations, "Box"))).toBe("class Box {\n    fun get(): Int { return 1 }\n}");
		expect(cut(named(facts.declarations, "get"))).toBe("fun get(): Int { return 1 }");
		expect(cut(named(facts.declarations, "First"))).toBe("class First");
		expect(cut(named(facts.declarations, "Second"))).toBe("class Second {}");
		expect(cut(named(facts.declarations, "RED"))).toBe("RED(1)");
		expect(named(facts.declarations, "café")?.selectionRange?.start).toEqual({ line: 6, character: 4 });
	});

	test("valid source the grammar reads only after repair declares everything and notes nothing", () => {
		const forms: Array<[string, string[]]> = [
			["/**\n * Example:\n * /* nested sample */\n * Text after.\n */\nclass Box\n", ["Box"]],
			[
				`val pattern = Regex("""([a-z]+\\s*=\\s*"([^"]*)"""")\nval text = """outer ${D}{"""inner"""} C:\\path"""\n`,
				["pattern", "text"],
			],
			["val `class` = 1\nfun `when`(): Int = `class`\n", ["class", "when"]],
			[
				"fun choose(raw: String) = when {\n    raw.contains('{') && !raw.contains('}') -> raw\n    else -> raw\n}\n",
				["choose", "raw"],
			],
			[
				"fun collect() { consume(object : Collector { }) }\nfun make() { consume(object { }) }\n",
				["collect", "make"],
			],
			["#!/usr/bin/env kotlin\nval x = 1\n", ["x"]],
			[
				"val open = 1\nval final = 2\nfun f(sealed: Names) = open(sealed.names) + final\nprivate val data = open\n",
				["open", "final", "f", "sealed", "data"],
			],
			["class A : Base<List<Set<Foo>>>(1), Iface\n", ["A"]],
			[`val json = ${D}${D}"""{ "a": ${D}${D}{x} }"""\nval after = 1\n`, ["json", "after"]],
			["@Target(AnnotationTarget.CLASS) annotation class Marker\n", ["Marker"]],
			["class Box { companion object { val size = 1 } }\n", ["Box", "Companion", "size"]],
			["class A(val d: I) : I by d {\n    fun f() = d\n}\n", ["A", "A", "d", "f"]],
		];

		for (const [text, names] of forms) {
			const facts = parseKotlin("Form.kt", text);
			expect({ text, names: facts.declarations.map((item) => item.name), notes: facts.diagnostics }).toEqual({
				text,
				names,
				notes: [],
			});
		}
	});

	test("a modifier stays a modifier while the same word as a name stays a name", () => {
		const facts = parseKotlin(
			"Modifiers.kt",
			"private open class A { protected open val open = 1; internal lateinit var final: String }\n",
		);

		expect(facts.declarations.map((item) => [item.name, item.kind, item.visibility])).toEqual([
			["A", "class", "private"],
			["open", "property", "protected"],
			["final", "property", "internal"],
		]);
	});

	test("KDoc prose spelling a modifier promotes nothing", () => {
		const facts = parseKotlin("Doc.kt", "class A(/** val */ x: Int, /** private */ val y: Int)\n");

		expect(named(facts.declarations, "x")).toMatchObject({ kind: "variable", languageKind: "parameter" });
		expect(named(facts.declarations, "y")).toMatchObject({ kind: "property", visibility: "public" });
	});
});

describe("literals", () => {
	test("decode by meaning, belong to a declaration, and skip null", () => {
		const facts = parseKotlin(
			"Literals.kt",
			[
				'val escaped = "line\\n\\u0041"',
				'val raw = """raw',
				'line"""',
				"val letter = 'x'",
				"val truth = false",
				"val hex = 0xFF",
				"val bits = 0b1010",
				"val decimal = 1_000.5",
				"val longValue = 4L",
				"val floatValue = 2.5f",
				"val nothing = null",
			].join("\n"),
		);

		expect(facts.literals.map((item) => [item.kind, item.value, item.number])).toEqual([
			["string", "line\nA", undefined],
			["string", "raw\nline", undefined],
			["string", "x", undefined],
			["boolean", "false", undefined],
			["number", "0xFF", 255],
			["number", "0b1010", 10],
			["number", "1_000.5", 1000.5],
			["number", "4L", 4],
			["number", "2.5f", 2.5],
		]);
		expect(facts.literals.every((item) => item.containerId !== undefined)).toBe(true);
	});

	test("an interpolated string is one literal, its value carrying the interpolation's raw source", () => {
		const text = ['val name = "world"', `val greeting = "hello ${D}{name}!"`, `val short = "hi ${D}name"`].join(
			"\n",
		);
		const facts = parseKotlin("Interpolate.kt", text);

		expect(facts.literals.map((item) => item.value)).toEqual(["world", "hello ${name}!", "hi $name"]);
		for (const literal of facts.literals) expect(coordinatesOf(text).sliceRange(literal.range)).toBeDefined();
	});
});

describe("comments", () => {
	const texts = (text: string) => parseKotlin("Comments.kt", text).comments.map((item) => item.text);

	test("every shape is a span that cuts its own text, and none declares anything", () => {
		const text = [
			"#!/usr/bin/env kotlin",
			"// val fake = 1",
			"/** Documented. */",
			"fun work(first: Int /* inline */, second: Int): Int = first + second // trailing",
			"/* outer /* inner */ still outer */",
			"val after = 1\r",
			"// next\r",
			"",
		].join("\n");
		const facts = parseKotlin("Shapes.kt", text);

		expect(facts.comments.map((item) => item.text)).toEqual([
			"#!/usr/bin/env kotlin",
			"// val fake = 1",
			"/** Documented. */",
			"/* inline */",
			"// trailing",
			"/* outer /* inner */ still outer */",
			"// next",
		]);
		for (const comment of facts.comments) expect(coordinatesOf(text).sliceRange(comment.range)).toBe(comment.text);
		expect(facts.declarations.map((item) => item.name)).toEqual(["work", "first", "second", "after"]);
	});

	test("a marker inside any literal is text, and a comment inside a template is a comment", () => {
		expect(
			texts(
				[
					'val url = "https://example.com/path"',
					'val block = "/* not a comment */"',
					'val escaped = "he said \\"// no\\""',
					"val slash = '/'",
					'val raw = """',
					"not // a comment",
					'"""',
					`val s = "${D}{ if (a) "//x" else "" }"`,
					`val plain = "${D}{ 1 /* here */ }"`,
					`val lined = """${D}{ 2 // line`,
					' }"""',
				].join("\n"),
			),
		).toEqual(["/* here */", "// line"]);
	});

	test("a block comment opening a line of code is trivia, and still a span", () => {
		const forms: Array<[string, string[], string[]]> = [
			["val x = 1\n/* c */ fun f() = x\n", ["x", "f"], ["/* c */"]],
			["val x = 1\n/*c*/fun f() = x\n", ["x", "f"], ["/*c*/"]],
			["/** doc */ fun f() = 1\n/** doc */ class C\n", ["f", "C"], ["/** doc */", "/** doc */"]],
			["val t = 1\r\n\t/** doc */\tfun f() = t\r\n", ["t", "f"], ["/** doc */"]],
			["val x = 1\n/* a\n b */ fun g() = x\n", ["x", "g"], ["/* a\n b */"]],
			[
				"class A {\n    val x = 1\n    /** d */ fun f() = x\n    /* a */ /* b */ val y = 2\n}\n",
				["A", "x", "f", "y"],
				["/** d */", "/* a */", "/* b */"],
			],
		];

		for (const [text, names, comments] of forms) {
			const facts = parseKotlin("Lead.kt", text);
			const declared = new Set(facts.declarations.map((item) => JSON.stringify(item.selectionRange?.start)));
			expect({
				text,
				names: facts.declarations.map((item) => item.name),
				comments: facts.comments.map((item) => item.text),
				notes: facts.diagnostics,
				usesAtNames: facts.references.filter((item) =>
					declared.has(JSON.stringify(item.reference.range.start)),
				),
			}).toEqual({ text, names, comments, notes: [], usesAtNames: [] });
			for (const comment of facts.comments)
				expect(coordinatesOf(text).sliceRange(comment.range)).toBe(comment.text);
		}
	});

	test("an unterminated block runs to end of file as one span and refuses the file", () => {
		for (const text of [
			"val before = 1\n/* opened",
			"val x = 1\n/* outer /* inner */ open",
			"class Foo\n/* open\nclass Extra\n",
		]) {
			const facts = parseKotlin("Open.kt", text);
			expect(facts.comments.map((item) => item.text)).toEqual([text.slice(text.indexOf("/*"))]);
			expect(facts.diagnostics.some((item) => item.severity === "error")).toBe(true);
		}
	});
});

describe("syntax diagnostics", () => {
	test("text no valid source produces is refused", () => {
		const refused = [
			'val text = "unterminated',
			'val s = """unterminated\nclass Foo\n',
			"fun add( {\n",
			"class {",
			"@Ann(",
			"class Box ]",
			"val x: Int = (\n",
			"import",
			"package p\nimport\nclass Foo\n",
			"package\nclass A\n",
			"import a.\nclass B\n",
			"class Cut {\n    val kept = 1\n    fun open() {\n",
			"package p\nfun f(limit: Int) =",
		];

		expect(refused.filter((text) => !errors(text))).toEqual([]);
	});

	test("text ending in an annotation with no newline parses rather than stalling the scanner", () => {
		for (const text of ["class A\n@Target(X)", "val a = 1\n@T"])
			expect(parseKotlin("Tail.kt", text).declarations.length).toBeGreaterThan(0);
	});

	test("a grammar gap in valid source only warns, naming the region, and keeps what parsed", () => {
		const facts = parseKotlin("Gap.kt", 'fun f() {\n    @Suppress("x") while (true) { }\n}\nval after = 1\n');

		expect(facts.diagnostics.map((item) => [item.severity, item.range?.start.line])).toEqual([["warning", 1]]);
		expect(facts.declarations.map((item) => item.name)).toEqual(["f", "after"]);
	});
});

describe("types", () => {
	test("declared annotations are known, direct literals inferred, anything else unknown", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const text = [
			"const val count = 1",
			'val label = "ready"',
			"val letter = 'x'",
			"val enabled = true",
			"val big = 2L",
			"val ratio = 1.25",
			"val sum = 1 + 2",
			"val unknown = makeValue()",
			"val maybe: String? = null",
			"val values: List<String> = emptyList()",
			"fun fetch(id: Long): Map<String, Int> = emptyMap()",
		].join("\n");
		const facts = provider.parseFile({ module: "Types.kt", contentHash: "types", text });
		const typeOf = (name: string) => {
			const answer = provider.typeOf({ symbolId: named(facts.declarations, name)?.symbolId ?? "" });
			return answer.status === "unknown" ? [answer.status, answer.reason] : [answer.status, answer.display];
		};

		expect(["count", "label", "letter", "enabled", "big", "ratio", "sum", "unknown"].map(typeOf)).toEqual([
			["inferred", "Int"],
			["inferred", "String"],
			["inferred", "Char"],
			["inferred", "Boolean"],
			["inferred", "Long"],
			["inferred", "Double"],
			["unknown", "NotImplemented"],
			["unknown", "NotImplemented"],
		]);
		expect(["maybe", "values", "fetch", "id"].map(typeOf)).toEqual([
			["known", "String?"],
			["known", "List<String>"],
			["known", "Map<String, Int>"],
			["known", "Long"],
		]);
		const range = named(facts.declarations, "fetch")?.selectionRange;
		expect(range === undefined ? undefined : provider.typeOf({ module: "Types.kt", range })).toMatchObject({
			status: "known",
			display: "Map<String, Int>",
		});
	});

	test("an id that names nothing, an unindexed module and a refused file are closed reasons", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		provider.parseFile({ module: "bad.kt", contentHash: "bad", text: "val x: Int = (\n" });
		const start = { line: 0, character: 4 };

		expect(provider.typeOf({ symbolId: "not a Kotlin id" })).toMatchObject({
			status: "unknown",
			reason: "ParseError",
		});
		expect(provider.typeOf({ module: "missing.kt", range: { start, end: start } })).toMatchObject({
			status: "unknown",
			reason: "NotIndexed",
		});
		expect(provider.typeOf({ module: "bad.kt", range: { start, end: start } })).toMatchObject({
			status: "unknown",
			reason: "ParseError",
		});
	});
});
