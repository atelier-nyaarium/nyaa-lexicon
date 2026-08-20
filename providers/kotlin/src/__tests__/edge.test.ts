import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Declaration, parseSymbolId, type Range } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { handlersFor, KotlinProvider, LANGUAGE, REFERENCE_ROLES, TIERS } from "../main.js";
import { parseKotlin, SourceCursor } from "../parser.js";

const roots: string[] = [];
const SWITCHBOARD_ANDROID = "/home/nyaarium/projects/switchboard/android";
/** Kotlin's template opener, spelled out so a fixture does not read as a TypeScript placeholder. */
const DOLLAR = "$";

function makeWorkspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-kotlin-edge-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function declaration(facts: { declarations: Declaration[] }, name: string, kind?: string) {
	return facts.declarations.find((item) => item.name === name && (kind === undefined || item.kind === kind));
}

function comments(facts: { comments: Array<{ text: string }> }): string[] {
	return facts.comments.map((item) => item.text);
}

/** Cuts by range the way an editor would, so a span that lied about its position fails the compare. */
function slice(text: string, range: Range): string {
	const lines = text.split("\n");
	const cut = lines.slice(range.start.line, range.end.line + 1);
	const last = cut.length - 1;
	cut[last] = (cut[last] as string).slice(0, range.end.character);
	cut[0] = (cut[0] as string).slice(range.start.character);
	return cut.join("\n");
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Kotlin lexical coverage", () => {
	test("decodes ordinary, raw, character, boolean, and numeric literals", () => {
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
			].join("\n"),
		);
		const strings = facts.literals.filter((item) => item.kind === "string");
		const numbers = facts.literals.filter((item) => item.kind === "number");
		const booleans = facts.literals.filter((item) => item.kind === "boolean");

		expect(strings.map((item) => item.value)).toEqual(["line\nA", "raw\nline", "x"]);
		expect(numbers.map((item) => item.number)).toEqual([255, 10, 1000.5, 4, 2.5]);
		expect(booleans.map((item) => item.value)).toEqual(["false"]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("keeps comments out of declarations and references", () => {
		const facts = parseKotlin(
			"Comments.kt",
			[
				"// val fake = 1",
				"/* fun ignored() {} */",
				"/** Real documentation. */",
				"fun real(value: Int): Int = value",
			].join("\n"),
		);

		expect(declaration(facts, "fake")).toBeUndefined();
		expect(declaration(facts, "ignored")).toBeUndefined();
		expect(declaration(facts, "real")).toBeDefined();
		expect(facts.references.map((item) => item.reference.name)).toContain("value");
	});

	test("balances nested block comments inside KDoc", () => {
		const facts = parseKotlin(
			"NestedDocs.kt",
			"/**\n * Example:\n * /* nested sample */\n * Text after the nested comment.\n */\nclass Box\n",
		);

		expect(facts.diagnostics).toEqual([]);
		expect(declaration(facts, "Box")).toBeDefined();
	});

	test("lexes raw strings with quote runs and nested templates", () => {
		const facts = parseKotlin(
			"RawStrings.kt",
			[
				'val pattern = Regex("""([a-zA-Z]+\\s*=\\s*"([^"]*)"""")',
				'val name = "inner"',
				'val text = """outer ' + "$" + '{"""inner $name"""} C:\\path"""',
			].join("\n"),
		);

		expect(facts.diagnostics).toEqual([]);
		expect(facts.tokens.filter((token) => token.kind === "string")).toHaveLength(3);
		expect(facts.declarations.map((item) => item.name)).toEqual(["pattern", "name", "text"]);
	});

	test("accepts backticked names without treating their keyword spelling as syntax", () => {
		const facts = parseKotlin("Backticks.kt", "val `class` = 1\nfun `when`(): Int = `class`\n");
		const namedClass = declaration(facts, "class", "property");
		const namedWhen = declaration(facts, "when", "function");

		expect(namedClass).toBeDefined();
		expect(namedWhen).toBeDefined();
		expect(facts.references.some((item) => item.reference.name === "class" && item.reference.role === "read")).toBe(
			true,
		);
	});

	test("handles Unicode identifiers and UTF-16 positions", () => {
		const facts = parseKotlin("UnicodeNames.kt", 'val before = "😀"; val name = 2\nval café = 1\n');
		const cafe = declaration(facts, "café");
		const name = declaration(facts, "name");

		expect(cafe?.selectionRange.start.character).toBe(4);
		expect(name?.selectionRange.start.character).toBe(23);
	});

	test("cursor lookahead is non-consuming for multi-character delimiters", () => {
		const cursor = new SourceCursor("abc*/rest");
		const mark = cursor.mark();

		expect(cursor.startsWith("abc")).toBe(true);
		expect(cursor.offset).toBe(mark.offset);
		expect(cursor.readUntil("*/")).toBe("abc");
		expect(cursor.startsWith("*/")).toBe(true);
	});
});

describe("Kotlin comment spans", () => {
	test("reports line, block, KDoc, inline, and trailing comments as written", () => {
		const facts = parseKotlin(
			"Shapes.kt",
			[
				"// leading",
				"/** Documented. */",
				"fun work(first: Int /* inline */, second: Int): Int {",
				"\treturn first + second",
				"}",
				"",
				"val total = 42 // trailing",
				"",
				"/* standalone */",
			].join("\n"),
		);

		expect(comments(facts)).toEqual([
			"// leading",
			"/** Documented. */",
			"/* inline */",
			"// trailing",
			"/* standalone */",
		]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("nests block comments, so the span ends at the last close", () => {
		const facts = parseKotlin("Nest.kt", "/* outer /* inner */ still outer */\nval after = 1\n");

		expect(comments(facts)).toEqual(["/* outer /* inner */ still outer */"]);
		expect(declaration(facts, "after")).toBeDefined();
	});

	test("every span cuts its own text out of the source", () => {
		const text = "// one\nval x = 1 /* two */\n/**\n * three\n */\nclass Boxed\n";
		const facts = parseKotlin("Ranges.kt", text);

		expect(facts.comments).toHaveLength(3);
		for (const comment of facts.comments) expect(slice(text, comment.range)).toBe(comment.text);
	});

	test("a marker inside a string, char, or raw literal is not a comment", () => {
		const facts = parseKotlin(
			"Markers.kt",
			[
				'val url = "https://example.com/path"',
				'val block = "/* not a comment */"',
				'val escaped = "he said \\"// no\\""',
				"val slash = '/'",
				'val raw = """',
				"not // a comment",
				"nor /* this */",
				'"""',
				"// real",
			].join("\n"),
		);

		expect(comments(facts)).toEqual(["// real"]);
	});

	test("a template holding quotes does not end the string early", () => {
		const facts = parseKotlin("Template.kt", `val s = "${DOLLAR}{ if (a) "//x" else "" }"\nval after = 1\n`);

		expect(comments(facts)).toEqual([]);
		expect(declaration(facts, "after")).toBeDefined();
	});

	test("a comment inside a template expression is a comment", () => {
		const facts = parseKotlin(
			"Inside.kt",
			`val plain = "${DOLLAR}{ 1 /* here */ }"\nval raw = """${DOLLAR}{ 2 // line\n }"""\n`,
		);

		expect(comments(facts)).toEqual(["/* here */", "// line"]);
	});

	test("an unterminated block runs to end of file as one span", () => {
		const facts = parseKotlin("Open.kt", "val before = 1\n/* opened and never closed");

		expect(comments(facts)).toEqual(["/* opened and never closed"]);
		expect(facts.diagnostics.map((item) => item.message)).toContain("Block comment has no closing delimiter.");
	});

	test("an unterminated nested block is still one span", () => {
		const facts = parseKotlin("OpenNest.kt", "val x = 1\n/* outer /* inner */ never closed");

		expect(comments(facts)).toEqual(["/* outer /* inner */ never closed"]);
	});

	test("a shebang line is reported like any other comment", () => {
		const facts = parseKotlin("Tool.kt", "#!/usr/bin/env kotlin\n// real\nval x = 1\n");

		expect(comments(facts)).toEqual(["#!/usr/bin/env kotlin", "// real"]);
		expect(declaration(facts, "x")).toBeDefined();
		expect(facts.diagnostics).toEqual([]);
	});

	test("a carriage return ends a line comment instead of joining it", () => {
		const facts = parseKotlin("Crlf.kt", "val a = 1 // trailing\r\n// next\r\nval b = 2\r\n");

		expect(comments(facts)).toEqual(["// trailing", "// next"]);
	});

	test("comments ride with full facts and are withheld at outline depth", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const text = "// leading\nval x = 1\n";
		const full = provider.parseFile({ module: "Depth.kt", contentHash: "hash", text });
		const outline = provider.parseFile({ module: "Depth.kt", contentHash: "hash", text, depth: "outline" });

		expect(full.comments?.map((comment) => comment.text)).toEqual(["// leading"]);
		expect(outline.comments).toEqual([]);
	});
});

describe("Kotlin declarations", () => {
	test("records package, data, sealed, abstract, inner, object, and companion forms", () => {
		const facts = parseKotlin(
			"Shapes.kt",
			[
				"package sample.shapes",
				"data class Point(val x: Int, val y: Int)",
				"sealed abstract class Result",
				"inner class Nested",
				"companion object Factory",
				"object Global",
				"interface Renderable",
			].join("\n"),
		);
		const packageDeclaration = declaration(facts, "sample.shapes", "package");
		const point = declaration(facts, "Point", "class");
		const result = declaration(facts, "Result", "class");
		const nested = declaration(facts, "Nested", "class");
		const factory = declaration(facts, "Factory", "class");
		const global = declaration(facts, "Global", "class");
		const renderable = declaration(facts, "Renderable", "interface");

		expect(packageDeclaration).toBeDefined();
		expect(parseSymbolId(packageDeclaration?.symbolId ?? "")?.descriptors).toEqual([
			{ kind: "namespace", name: "sample.shapes" },
		]);
		expect(point?.languageKind).toBe("data");
		expect(result?.languageKind).toBe("sealed abstract");
		expect(nested?.languageKind).toBe("inner");
		expect(factory?.languageKind).toBe("companionObject");
		expect(global?.languageKind).toBe("object");
		expect(renderable?.languageKind).toBe("interface");
	});

	test("creates member declarations for primary constructor properties", () => {
		const facts = parseKotlin(
			"User.kt",
			"private data class User(private val id: Long, internal var label: String, count: Int)\n",
		);
		const user = declaration(facts, "User", "class");
		const id = declaration(facts, "id", "property");
		const label = declaration(facts, "label", "property");
		const count = declaration(facts, "count", "variable");

		expect(id?.containerId).toBe(user?.symbolId);
		expect(label?.containerId).toBe(user?.symbolId);
		expect(id).toMatchObject({ visibility: "private", exported: false, languageKind: "constructorVal" });
		expect(label).toMatchObject({ visibility: "internal", exported: true, languageKind: "constructorVar" });
		expect(count).toMatchObject({ languageKind: "parameter", exported: false, visibility: "local" });
	});

	test("records secondary constructors and constructor parameter types", () => {
		const facts = parseKotlin(
			"Constructors.kt",
			["class Ticket(val id: Int) {", "	private constructor(code: String, retry: Boolean) {}", "}"].join("\n"),
		);
		const secondary = facts.declarations.find((item) => item.languageKind === "secondaryConstructor");
		const code = declaration(facts, "code", "variable");
		const retry = declaration(facts, "retry", "variable");

		expect(secondary).toMatchObject({ kind: "constructor", visibility: "private" });
		expect(secondary?.metrics?.parameters).toBe(2);
		expect(code?.containerId).toBe(secondary?.symbolId);
		expect(retry?.containerId).toBe(secondary?.symbolId);
	});

	test("records enum entries, typealiases, and const values", () => {
		const facts = parseKotlin(
			"Constants.kt",
			["enum class State { READY, DONE(1) }", "typealias Identifier = String", "const val LIMIT: Long = 4L"].join(
				"\n",
			),
		);
		const entries = facts.declarations.filter((item) => item.languageKind === "enumEntry");
		const alias = declaration(facts, "Identifier");
		const limit = declaration(facts, "LIMIT", "constant");

		expect(entries.map((item) => item.name)).toEqual(["READY", "DONE"]);
		expect(alias).toMatchObject({ kind: "class", languageKind: "typealias" });
		expect(limit).toMatchObject({ visibility: "public", exported: true });
		expect(facts.typeFacts.find((item) => item.symbolId === limit?.symbolId)?.answer).toMatchObject({
			status: "known",
			display: "Long",
		});
	});

	test("keeps overload descriptors distinct", () => {
		const facts = parseKotlin("Overloads.kt", "fun same(value: Int) {}\nfun same(value: String) {}\n");
		const overloads = facts.declarations.filter((item) => item.name === "same");
		const descriptors = overloads.map((item) => parseSymbolId(item.symbolId)?.descriptors.at(-1));

		expect(overloads).toHaveLength(2);
		expect(descriptors.filter((item) => item?.kind === "method")).toHaveLength(2);
		expect(new Set(overloads.map((item) => item.symbolId)).size).toBe(2);
	});

	test("renders suspend and extension signatures with return types", () => {
		const facts = parseKotlin(
			"Functions.kt",
			"suspend fun List<String>.join(separator: String): String = joinToString(separator)\n",
		);
		const extension = declaration(facts, "join", "function");
		const parameter = declaration(facts, "separator", "variable");

		expect(extension?.languageKind).toBe("suspend extensionFunction");
		expect(extension?.signature).toContain("suspend fun List<String>.join");
		expect(extension?.signature).toContain(": String");
		expect(parameter?.languageKind).toBe("parameter");
	});

	test("parses generic parameters before extension receivers", () => {
		const facts = parseKotlin(
			"GenericExtensions.kt",
			[
				"abstract fun <T> Iterable<Flow<T>>.merge(): Flow<T>",
				"internal var <T> WorkaroundAtomicReference<T>.value: T",
			].join("\n"),
		);
		const merge = declaration(facts, "merge", "function");
		const value = declaration(facts, "value", "property");

		expect(facts.diagnostics).toEqual([]);
		expect(merge?.signature).toContain("<T> Iterable<Flow<T>>.merge");
		expect(value?.signature).toContain("<T> WorkaroundAtomicReference<T>.value");
	});

	test("uses declaration ranges that include bodies but exclude trailing newlines", () => {
		const source = "class Box {\n\tfun get(): Int { return 1 }\n}\n\n";
		const facts = parseKotlin("Ranges.kt", source);
		const box = declaration(facts, "Box", "class");
		const get = declaration(facts, "get", "method");

		expect(box?.range.end.line).toBe(2);
		expect(get?.range.end.line).toBe(1);
		expect(get?.range.start.line).toBe(1);
	});

	test("stops bodyless type readers at semicolon delimiters", () => {
		const facts = parseKotlin("Semicolons.kt", "class First; class Second {}\n");
		const first = declaration(facts, "First", "class");
		const second = declaration(facts, "Second", "class");

		expect(first?.range.end.character).toBe(11);
		expect(second?.range.end.character).toBe(28);
	});
});

describe("Kotlin imports and references", () => {
	test("captures aliases, star imports, and source versus local ranges", () => {
		const facts = parseKotlin(
			"Imports.kt",
			[
				"import package.Item as Product",
				"import package.tools.*",
				"fun use(value: Product): Product = value",
			].join("\n"),
		);
		const alias = facts.imports[0];
		const star = facts.imports[1];

		expect(alias).toMatchObject({ specifier: "package.Item", importedName: "Item", localName: "Product" });
		expect(alias?.imported[0]?.name).toBe("Item");
		expect(alias?.imported[0]?.local).toBe("Product");
		expect(alias?.imported[0]?.range).not.toEqual(alias?.imported[0]?.localRange);
		expect(star).toMatchObject({ specifier: "package.tools.*", star: true });
		expect(star?.imported).toEqual([{ name: "*", range: star?.imported[0]?.range }]);
	});

	test("resolves the deepest workspace package prefix", () => {
		const root = makeWorkspace({
			"src/one.kt": "package org.example.models\nclass One\n",
			"src/two.kt": "package org.example\nclass Two\n",
		});
		const provider = new KotlinProvider();
		provider.initialize(root);

		expect(provider.resolveImport({ fromModule: "src/use.kt", specifier: "org.example.models.One" })).toEqual({
			status: "resolved",
			module: "src/one.kt",
		});
	});

	test("reports ambiguous package resolution when two files declare one package", () => {
		const root = makeWorkspace({
			"a.kt": "package duplicate\nclass A\n",
			"b.kt": "package duplicate\nclass B\n",
		});
		const provider = new KotlinProvider();
		provider.initialize(root);

		expect(provider.resolveImport({ fromModule: "use.kt", specifier: "duplicate.A" })).toMatchObject({
			status: "unresolved",
			reason: "Ambiguous",
		});
	});

	test("distinguishes external roots from missing packages", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());

		expect(provider.resolveImport({ fromModule: "use.kt", specifier: "java.time.Instant" })).toEqual({
			status: "external",
			packageName: "java.time.Instant",
		});
		expect(provider.resolveImport({ fromModule: "use.kt", specifier: "org.missing.Type" })).toMatchObject({
			status: "unresolved",
			reason: "NotIndexed",
		});
		expect(provider.resolveImport({ fromModule: "use.kt", specifier: "" })).toMatchObject({
			status: "unresolved",
			reason: "ParseError",
		});
	});

	test("makes a resolved star import ambiguous even with one matching declaration", () => {
		const root = makeWorkspace({
			"source.kt": "package sample\nclass One\n",
			"use.kt": "package consumer\nimport sample.*\nfun make(): One = One()\n",
		});
		const provider = new KotlinProvider();
		provider.initialize(root);
		const text = readFileSync(path.join(root, "use.kt"), "utf8");
		const facts = provider.parseFile({ module: "use.kt", contentHash: "use", text });
		const reference = facts.references.find((item) => item.name === "One" && item.role !== "import");

		expect(reference?.binding).toMatchObject({ status: "unbound", reason: "Ambiguous" });
	});

	test("emits semantic roles for type annotations, inheritance, calls, and assignments", () => {
		const facts = parseKotlin(
			"Roles.kt",
			[
				"class Parent",
				"class Child : Parent()",
				"var count: Int = 0",
				"fun make(): Child = Child()",
				"fun update() { count += make().hashCode() }",
			].join("\n"),
		);
		const roles = new Set(facts.references.map((item) => item.reference.role));

		expect([...roles].every((role) => (REFERENCE_ROLES as readonly string[]).includes(role))).toBe(true);
		expect(roles).toEqual(new Set(["extends", "typeUse", "instantiate", "read", "write", "call"]));
	});

	test("resolves local shadowing before members and top-level declarations", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({
			module: "Scopes.kt",
			contentHash: "scopes",
			text: [
				'val value: String = "module"',
				"class Box {",
				"	val value: Int = 1",
				"	fun read(value: Boolean): Boolean { return value }",
				"}",
			].join("\n"),
		});
		const parameter = facts.declarations.find((item) => item.name === "value" && item.languageKind === "parameter");
		const reference = facts.references.find((item) => item.name === "value" && item.role === "read");

		expect(parameter).toBeDefined();
		expect(reference?.binding).toMatchObject({ status: "bound", symbolId: parameter?.symbolId });
	});

	test("binds compound writes and increments to the nearest declaration", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({
			module: "Writes.kt",
			contentHash: "writes",
			text: "var count: Int = 0\nfun update() { count += 1; count++ }\n",
		});
		const count = declaration(facts, "count", "property");
		const writes = facts.references.filter((item) => item.name === "count" && item.role === "write");
		const reads = facts.references.filter((item) => item.name === "count" && item.role === "read");

		expect(writes).toHaveLength(2);
		expect(reads.length).toBeGreaterThanOrEqual(1);
		expect(
			writes.every((item) => item.binding.status === "bound" && item.binding.symbolId === count?.symbolId),
		).toBe(true);
	});
});

describe("Kotlin type answers and diagnostics", () => {
	test("answers nullable, generic, parameter, and function return annotations", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({
			module: "Annotated.kt",
			contentHash: "annotated",
			text: [
				"val maybe: String? = null",
				"val values: List<String> = emptyList()",
				"fun fetch(id: Long): Map<String, Int> = emptyMap()",
			].join("\n"),
		});
		const maybe = declaration(facts, "maybe");
		const values = declaration(facts, "values");
		const fetch = declaration(facts, "fetch");
		const id = declaration(facts, "id", "variable");

		expect(provider.typeOf({ symbolId: maybe?.symbolId ?? "" })).toMatchObject({
			status: "known",
			display: "String?",
		});
		expect(provider.typeOf({ symbolId: values?.symbolId ?? "" })).toMatchObject({
			status: "known",
			display: "List<String>",
		});
		expect(provider.typeOf({ symbolId: fetch?.symbolId ?? "" })).toMatchObject({
			status: "known",
			display: "Map<String, Int>",
		});
		expect(provider.typeOf({ symbolId: id?.symbolId ?? "" })).toMatchObject({ status: "known", display: "Long" });
	});

	test("infers only direct literal initializers", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const facts = provider.parseFile({
			module: "Inferred.kt",
			contentHash: "inferred",
			text: [
				'val text = "ready"',
				"val letter = 'x'",
				"val yes = true",
				"val count = 2L",
				"val ratio = 1.25",
				"val missing = make()",
			].join("\n"),
		});

		expect(provider.typeOf({ symbolId: declaration(facts, "text")?.symbolId ?? "" })).toMatchObject({
			status: "inferred",
			display: "String",
		});
		expect(provider.typeOf({ symbolId: declaration(facts, "letter")?.symbolId ?? "" })).toMatchObject({
			status: "inferred",
			display: "Char",
		});
		expect(provider.typeOf({ symbolId: declaration(facts, "yes")?.symbolId ?? "" })).toMatchObject({
			status: "inferred",
			display: "Boolean",
		});
		expect(provider.typeOf({ symbolId: declaration(facts, "count")?.symbolId ?? "" })).toMatchObject({
			status: "inferred",
			display: "Long",
		});
		expect(provider.typeOf({ symbolId: declaration(facts, "ratio")?.symbolId ?? "" })).toMatchObject({
			status: "inferred",
			display: "Double",
		});
		expect(provider.typeOf({ symbolId: declaration(facts, "missing")?.symbolId ?? "" })).toMatchObject({
			status: "unknown",
			reason: "NotImplemented",
		});
	});

	test("attaches a workspace symbol to a named declared type", () => {
		const root = makeWorkspace({
			"model/Entry.kt": "package model\nclass Entry\n",
			"use/Holder.kt": "package use\nimport model.Entry\nval entry: Entry = Entry()\n",
		});
		const provider = new KotlinProvider();
		provider.initialize(root);
		provider.parseFile({
			module: "model/Entry.kt",
			contentHash: "entry",
			text: readFileSync(path.join(root, "model/Entry.kt"), "utf8"),
		});
		const use = provider.parseFile({
			module: "use/Holder.kt",
			contentHash: "holder",
			text: readFileSync(path.join(root, "use/Holder.kt"), "utf8"),
		});
		const entry = declaration(use, "entry");
		const answer = provider.typeOf({ symbolId: entry?.symbolId ?? "" });

		expect(answer.status).toBe("known");
		expect(answer.status === "known" ? parseSymbolId(answer.symbolId ?? "")?.module : undefined).toBe(
			"model/Entry.kt",
		);
	});

	test("returns closed unknown reasons for invalid symbols and parse errors", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const missing = provider.typeOf({ symbolId: "not a Kotlin id" });
		const absent = provider.typeOf({
			module: "missing.kt",
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		});
		const broken = provider.parseFile({ module: "bad.kt", contentHash: "bad", text: "val x: Int = (\n" });
		const brokenType = provider.typeOf({
			module: "bad.kt",
			range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
		});

		expect(missing).toMatchObject({ status: "unknown", reason: "ParseError" });
		expect(absent).toMatchObject({ status: "unknown", reason: "NotIndexed" });
		expect(broken.diagnostics.some((item) => item.severity === "error")).toBe(true);
		expect(brokenType).toMatchObject({ status: "unknown", reason: "ParseError" });
	});

	test("reports malformed imports, annotations, strings, and delimiters", () => {
		const invalid = ["import", "@Ann(", 'val name = "unterminated', "fun run() {", "class Box ]"];

		for (const text of invalid) {
			const facts = parseKotlin("Invalid.kt", text);
			expect(facts.diagnostics.length, text).toBeGreaterThan(0);
			expect(facts.diagnostics.every((item) => item.severity === "error")).toBe(true);
		}
	});

	test("does not report errors for nested lambdas and generic expressions", () => {
		const facts = parseKotlin(
			"ValidExpressions.kt",
			"fun use(values: List<Int>): List<Int> { return values.filter { it > 0 }.map { it + 1 } }\n",
		);

		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.find((item) => item.name === "use")?.metrics?.nesting).toBe(1);
	});

	test("leaves anonymous object expressions in expression parsing", () => {
		const facts = parseKotlin(
			"AnonymousObjects.kt",
			"fun collect() { consume(object : FlowCollector { }) }\nfun make() { consume(object { }) }\n",
		);

		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.filter((item) => item.name === "collect" || item.name === "make")).toHaveLength(2);
		expect(facts.declarations.some((item) => item.name === "object")).toBe(false);
	});

	test("ignores delimiter characters inside character literals", () => {
		const facts = parseKotlin(
			"CharDelimiters.kt",
			[
				"/** Reader docs */",
				"class Reader(",
				"\tprivate val paused: () -> Boolean,",
				") {",
				"\tfun choose(raw: String): String {",
				"\t\treturn when {",
				"\t\t\traw.contains('{') && !raw.contains('}') -> raw",
				'\t\t\telse -> "ok"',
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		);

		expect(facts.diagnostics).toEqual([]);
		expect(declaration(facts, "Reader", "class")).toBeDefined();
		expect(declaration(facts, "choose", "method")).toBeDefined();
	});
});

describe("Kotlin project and protocol wiring", () => {
	test("walks nested source files and excludes common generated directories", () => {
		const files: Record<string, string> = {
			"src/A.kt": "class A\n",
			"src/nested/B.kt": "class B\n",
			".git/Hidden.kt": "class Hidden\n",
			".gradle/Gradle.kt": "class Gradle\n",
			".idea/Idea.kt": "class Idea\n",
			".kotlin/Kotlin.kt": "class Kotlin\n",
			".mvn/Maven.kt": "class Maven\n",
			"build/Build.kt": "class Build\n",
			"dist/Dist.kt": "class Dist\n",
			"generated/Generated.kt": "class Generated\n",
			"node_modules/Node.kt": "class Node\n",
			"out/Out.kt": "class Out\n",
			"target/Target.kt": "class Target\n",
			"README.kt.txt": "class No\n",
		};
		const root = makeWorkspace(files);
		const provider = new KotlinProvider();
		provider.initialize(root);

		expect(provider.discoverProject(root).files).toEqual(["src/A.kt", "src/nested/B.kt"]);
	});

	test("returns stable protocol identity and all declared capabilities", () => {
		const provider = new KotlinProvider();
		const info = provider.initialize(process.cwd());

		expect(info).toMatchObject({ providerId: "kotlin-provider", language: LANGUAGE, extensions: [".kt"] });
		expect(info.tiers).toEqual(TIERS);
		expect(info.referenceRoles).toEqual([...REFERENCE_ROLES]);
		// Names what is unclaimed rather than counting: a new tier then reads as one honest gap
		// instead of a mystery false.
		const unclaimed = Object.entries(TIERS)
			.filter(([, claimed]) => !claimed)
			.map(([tier]) => tier);
		expect(unclaimed).toEqual([]);
	});

	test("keeps parse response identity and includes every fact collection", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const response = provider.parseFile({
			module: "response.kt",
			contentHash: "content-hash",
			text: "package response\nval answer: Int = 1\n",
		});

		expect(response.module).toBe("response.kt");
		expect(response.contentHash).toBe("content-hash");
		expect(Array.isArray(response.declarations)).toBe(true);
		expect(Array.isArray(response.references)).toBe(true);
		expect(Array.isArray(response.imports)).toBe(true);
		expect(Array.isArray(response.literals)).toBe(true);
		expect(Array.isArray(response.comments)).toBe(true);
		expect(Array.isArray(response.diagnostics)).toBe(true);
	});

	test("answers every handler, including explicit write-operation refusals", () => {
		const provider = new KotlinProvider();
		provider.initialize(process.cwd());
		const handlers = handlersFor(provider);
		const shutdown = handlers.shutdown({});
		const rename = handlers.renameEdits({ module: "a.kt", text: "", oldName: "a", newName: "b", sites: [] });
		const move = handlers.moveEdits({
			module: "a.kt",
			text: "",
			exists: false,
			symbolId: "lexicon kotlin a.kt type:a.",
			name: "a",
			fromModule: "a.kt",
			toModule: "b.kt",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		});

		expect(shutdown).toEqual({});
		expect(rename).toMatchObject({ status: "refused", reason: "NotImplemented" });
		expect(move).toMatchObject({ status: "refused", reason: "NotImplemented" });
	});

	test("rejects a workspace file escape when binding an outside module", () => {
		const root = makeWorkspace({ "src/Main.kt": "class Main\n" });
		const provider = new KotlinProvider();
		provider.initialize(root);

		expect(
			provider.bind({
				module: "../outside.kt",
				name: "Main",
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
			}),
		).toMatchObject({ status: "unbound", reason: "NotIndexed" });
	});

	test.skipIf(!existsSync(path.resolve("temp/kotlinx-coroutines")))(
		"parses the full real Kotlin corpus when present",
		() => {
			const corpus = path.resolve("temp/kotlinx-coroutines");
			const provider = new KotlinProvider();
			provider.initialize(corpus);
			const project = provider.discoverProject(corpus);
			const files = project.files.filter((file) => file.endsWith(".kt")).sort();
			let declarations = 0;
			let references = 0;
			let imports = 0;
			let syntaxErrorFiles = 0;
			for (const module of files) {
				const facts = provider.parseFile({
					module,
					contentHash: "edge-corpus",
					text: readFileSync(path.join(corpus, module), "utf8"),
				});
				expect(facts.module).toBe(module);
				expect(Array.isArray(facts.declarations)).toBe(true);
				expect(Array.isArray(facts.references)).toBe(true);
				expect(Array.isArray(facts.imports)).toBe(true);
				declarations += facts.declarations.length;
				references += facts.references.length;
				imports += facts.imports.length;
				if (facts.diagnostics.some((item) => item.severity === "error")) syntaxErrorFiles++;
			}

			console.log(
				`[kotlin corpus edge] files=${files.length} declarations=${declarations} references=${references} imports=${imports} syntaxErrorFiles=${syntaxErrorFiles}`,
			);
			expect(files.length).toBeGreaterThanOrEqual(1000);
			expect(declarations).toBeGreaterThan(10000);
			expect(syntaxErrorFiles).toBe(0);
		},
		60_000,
	);

	test.skipIf(!existsSync(SWITCHBOARD_ANDROID))(
		"parses the Switchboard Android Kotlin tree when present",
		() => {
			const provider = new KotlinProvider();
			provider.initialize(SWITCHBOARD_ANDROID);
			const project = provider.discoverProject(SWITCHBOARD_ANDROID);
			const files = project.files.filter((file) => file.endsWith(".kt")).sort();
			let syntaxErrorFiles = 0;
			for (const module of files) {
				const facts = provider.parseFile({
					module,
					contentHash: "switchboard-android",
					text: readFileSync(path.join(SWITCHBOARD_ANDROID, module), "utf8"),
				});
				expect(facts.module).toBe(module);
				expect(Array.isArray(facts.declarations)).toBe(true);
				expect(Array.isArray(facts.references)).toBe(true);
				expect(Array.isArray(facts.imports)).toBe(true);
				if (facts.diagnostics.some((item) => item.severity === "error")) syntaxErrorFiles++;
			}

			console.log(`[switchboard android corpus] files=${files.length} syntaxErrorFiles=${syntaxErrorFiles}`);
			expect(files.length).toBeGreaterThan(0);
			expect(syntaxErrorFiles).toBe(0);
		},
		60_000,
	);
});
