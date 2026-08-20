import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	BindingSchema,
	composeSymbolId,
	coordinatesOf,
	FileFactsSchema,
	InitializeResponseSchema,
	type MoveEditsRequest,
	ProjectModelSchema,
	type Range,
	type RenameEditsRequest,
	TypeInfoSchema,
} from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { Cursor } from "../cursor.js";
import { CProvider, handlersFor, REFERENCE_ROLES, TIERS } from "../main.js";
import { bindingCandidates, parseC } from "../parser.js";
import { lexC } from "../tokens.js";

const temporaryRoots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-c-provider-"));
	temporaryRoots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const fullPath = path.join(root, module);
		mkdirSync(path.dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, text);
	}
	return root;
}

function rangeAt(text: string, value: string, from = 0): Range {
	const offset = text.indexOf(value, from);
	if (offset < 0) throw new Error(`test text does not contain ${value}`);
	const range = coordinatesOf(text).rangeAt(offset, offset + value.length);
	if (range === undefined) throw new Error(`test text has no range for ${value}`);
	return range;
}

function facts(provider: CProvider, module: string, text: string) {
	return provider.parseFile({ module, contentHash: `${module}:${text.length}`, text });
}

function declarationOf(parsed: ReturnType<CProvider["parseFile"]>, name: string, kind?: string) {
	return parsed.declarations.find(
		(declaration) => declaration.name === name && (kind === undefined || declaration.kind === kind),
	);
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C provider protocol", () => {
	test("declares C files, supported reference roles, and implemented tiers", () => {
		const provider = new CProvider();
		const response = provider.initialize(process.cwd());

		expect(InitializeResponseSchema.parse(response).language).toBe("c");
		expect(response.providerId).toBe("c-provider");
		expect(response.extensions).toEqual([".c", ".h"]);
		expect(response.referenceRoles).toEqual([...REFERENCE_ROLES]);
		expect(response.tiers).toEqual(TIERS);
	});

	test("exposes every provider method through the handler table", () => {
		const handlers = handlersFor(new CProvider());

		expect(Object.keys(handlers).sort()).toEqual([
			"bind",
			"discoverProject",
			"initialize",
			"moveEdits",
			"parseFile",
			"renameEdits",
			"resolveImport",
			"shutdown",
			"typeOf",
		]);
		expect(handlers.shutdown({})).toEqual({});
	});

	test("walks C and header files while excluding build and cache directories", () => {
		const root = workspace({
			"CMakeLists.txt": "project(sample)\n",
			Makefile: "all:\n\ttrue\n",
			"src/main.c": "int main(void) { return 0; }\n",
			"include/sample.h": "int sample;\n",
			"build/generated.c": "int generated;\n",
			"node_modules/ignored.c": "int ignored;\n",
			"vendor-cache/ignored.h": "int ignored;\n",
			"notes.txt": "not a C module\n",
		});
		const provider = new CProvider();

		const project = provider.discoverProject(root);

		expect(ProjectModelSchema.parse(project).files).toEqual(["include/sample.h", "src/main.c"]);
		expect(project.configFiles).toEqual(["CMakeLists.txt", "Makefile"]);
		expect(project.externalRoots).toEqual([]);
		expect(project.diagnostics).toEqual([]);
	});

	test("reports a project diagnostic for a missing workspace", () => {
		const provider = new CProvider();

		const project = provider.discoverProject(path.join(tmpdir(), "c-provider-no-such-workspace"));

		expect(project.files).toEqual([]);
		expect(project.diagnostics[0]?.severity).toBe("error");
		expect(project.diagnostics[0]?.message).toContain("does not exist");
	});

	test("returns a complete schema-shaped empty file", () => {
		const provider = new CProvider();
		provider.initialize(process.cwd());

		const parsed = facts(provider, "empty.c", "\n");

		expect(FileFactsSchema.safeParse(parsed).success).toBe(true);
		expect(parsed.declarations).toEqual([]);
		expect(parsed.references).toEqual([]);
		expect(parsed.imports).toEqual([]);
		expect(parsed.literals).toEqual([]);
		expect(parsed.comments).toEqual([]);
		expect(parsed.diagnostics).toEqual([]);
	});
});

describe("C lexical cursor and tokens", () => {
	test("counts columns in UTF-16 code units", () => {
		const lexed = lexC("utf16.c", "/* 😀 */ int value;\n");
		const value = lexed.tokens.find((token) => token.value === "value");

		expect(value?.start).toEqual({ line: 0, character: 13 });
		expect(value?.end).toEqual({ line: 0, character: 18 });
		expect(lexed.diagnostics).toEqual([]);
	});

	test("decodes strings, character escapes, and numeric spellings", () => {
		const lexed = lexC("literals.c", "\"a\\n\\x41\" 'A' 0x10 0b11 075 2.5e+1 4UL");
		const values = lexed.tokens.filter((token) => ["string", "char", "number"].includes(token.kind));

		expect(values.map((token) => [token.kind, token.value])).toEqual([
			["string", "a\nA"],
			["char", "A"],
			["number", "0x10"],
			["number", "0b11"],
			["number", "075"],
			["number", "2.5e+1"],
			["number", "4UL"],
		]);
	});

	test("keeps doc comments and diagnoses unterminated quoted text", () => {
		const lexed = lexC("comments.c", '/** API docs */\n/// next docs\nint value;\n"unterminated\n');
		const comments = lexed.tokens.filter((token) => token.kind === "comment");

		expect(comments.map((token) => token.doc)).toEqual(["API docs", "next docs"]);
		expect(lexed.diagnostics).toHaveLength(1);
		expect(lexed.diagnostics[0]?.message).toContain("String literal");
	});

	test("treats a closed block comment as one token", () => {
		const lexed = lexC("comments.c", "/* one */ int value;");
		const symbols = lexed.tokens.filter((token) => token.kind === "symbol").map((token) => token.value);

		expect(symbols).toEqual([";"]);
		expect(lexed.tokens.find((token) => token.kind === "comment")?.raw).toBe("/* one */");
	});
});

describe("C comment spans", () => {
	function commentTexts(text: string) {
		const provider = new CProvider();
		return (facts(provider, "spans.c", text).comments ?? []).map((comment) => comment.text);
	}

	test("declares the comments tier and carries spans through parseFile", () => {
		const provider = new CProvider();
		const text = "// note\nint value = 1;\n";

		const parsed = facts(provider, "spans.c", text);

		expect(TIERS.comments).toBe(true);
		expect(FileFactsSchema.safeParse(parsed).success).toBe(true);
		expect(parsed.comments).toEqual([{ range: rangeAt(text, "// note"), text: "// note" }]);
	});

	test("reports every comment form C has, doc comments included", () => {
		const text =
			"// leading\nint work(int first /* inline */, int second) {\n\treturn first + second;\n}\n\n/// doc line\n/** doc block */\nint total = 42; // trailing\n\n/* standalone */\n";

		expect(commentTexts(text)).toEqual([
			"// leading",
			"/* inline */",
			"/// doc line",
			"/** doc block */",
			"// trailing",
			"/* standalone */",
		]);
	});

	test("does not report a marker written inside a string or character literal", () => {
		const text =
			'const char *url = "https://example.com/path";\nconst char *block = "/* not a comment */";\nchar slash = \'/\';\n// real\n';

		expect(commentTexts(text)).toEqual(["// real"]);
	});

	test("runs an unterminated block comment to end of file as one span", () => {
		const provider = new CProvider();
		const text = "int before = 1;\n/* opened and never closed";

		const parsed = facts(provider, "open.c", text);

		expect(parsed.comments).toEqual([
			{ range: rangeAt(text, "/* opened and never closed"), text: "/* opened and never closed" },
		]);
		expect(declarationOf(parsed, "before")).toBeDefined();
	});

	test("ends a block comment at the first close, since C blocks do not nest", () => {
		const provider = new CProvider();
		const text = "/* outer /* inner */\nint after = 1;\n";

		const parsed = facts(provider, "nest.c", text);

		expect((parsed.comments ?? []).map((comment) => comment.text)).toEqual(["/* outer /* inner */"]);
		expect(declarationOf(parsed, "after")).toBeDefined();
	});

	test("continues a line comment across a backslash newline", () => {
		const provider = new CProvider();
		const text = "// wraps \\\nstill comment\nint after = 1;\n";

		const parsed = facts(provider, "continued.c", text);

		expect(parsed.comments).toEqual([
			{ range: rangeAt(text, "// wraps \\\nstill comment"), text: "// wraps \\\nstill comment" },
		]);
		expect(declarationOf(parsed, "after")).toBeDefined();
	});

	test("spans a comment holding astral text in UTF-16 code units", () => {
		const provider = new CProvider();
		const text = "int value = 1; /* 😀 */\n";

		const parsed = facts(provider, "utf16.c", text);

		expect(parsed.comments).toEqual([{ range: rangeAt(text, "/* 😀 */"), text: "/* 😀 */" }]);
	});

	test("reports a retokenized Ghidra warning line as a single comment", () => {
		const text = "void run(void) {\n  if ((value\n// WARNING: Load size is inaccurate));\n}\n";

		expect(commentTexts(text)).toEqual(["// WARNING: Load size is inaccurate));"]);
	});
});

describe("C cursor boundaries", () => {
	test("owns character access and can restore a marked position", () => {
		const cursor = new Cursor("ab😀cd");
		const start = cursor.mark();

		expect(cursor.peek()).toBe("a");
		expect(cursor.peek(1)).toBe("b");
		expect(cursor.next()).toBe("a");
		expect(cursor.next()).toBe("b");
		expect(cursor.next()).toBe("😀");
		expect(cursor.offset).toBe(4);
		expect(cursor.column).toBe(4);
		cursor.rewind(start);
		expect(cursor.offset).toBe(0);
		expect(cursor.column).toBe(0);
	});

	test("reads Unicode identifiers without consuming the following symbol", () => {
		const cursor = new Cursor("naïve_2+next");
		const identifier = cursor.readIdentifier();

		expect(identifier?.name).toBe("naïve_2");
		expect(cursor.peek()).toBe("+");
		expect(cursor.slice(identifier?.start.offset ?? 0, identifier?.end.offset ?? 0)).toBe("naïve_2");
	});

	test("stops takeWhile at the first delimiter and reaches end exactly", () => {
		const cursor = new Cursor("123;456");

		expect(cursor.takeWhile((character) => /[0-9]/u.test(character))).toBe("123");
		expect(cursor.peek()).toBe(";");
		cursor.next();
		expect(cursor.takeWhile((character) => /[0-9]/u.test(character))).toBe("456");
		expect(cursor.good()).toBe(false);
		expect(cursor.next()).toBe("");
	});

	test("lexes newline continuations as one preprocessor directive", () => {
		const lexed = lexC("directives.c", "#define VALUE(x) \\\n+(x)\nint value;\n");
		const newlines = lexed.tokens.filter((token) => token.kind === "newline");

		expect(newlines).toHaveLength(3);
		expect(lexed.diagnostics).toEqual([]);
	});

	test("diagnoses an unterminated block comment and still returns tokens before it", () => {
		const lexed = lexC("comments.c", "int value; /* missing");

		expect(lexed.tokens.some((token) => token.value === "value")).toBe(true);
		expect(lexed.tokens.find((token) => token.kind === "comment")?.unterminated).toBe(true);
		expect(lexed.diagnostics[0]?.message).toContain("Block comment");
	});

	test("recognizes the longest operators before single symbols", () => {
		const symbols = lexC("operators.c", "a >>= 1; b->field; c...; d == e;")
			.tokens.filter((token) => token.kind === "symbol")
			.map((token) => token.value);

		expect(symbols).toEqual([">>=", ";", "->", ";", "...", ";", "==", ";"]);
	});
});

describe("C declarations", () => {
	const modelText = [
		"/** Packet docs */",
		"struct Packet {",
		"\tint length;",
		"\tunion { int code; long bits; };",
		"\tenum { Ready = 1, Done };",
		"};",
		"typedef unsigned int Count;",
		"#define LIMIT 3",
		"#define APPLY(x) (x)",
		"static int hidden;",
		"int global;",
		"int add(int value);",
		"int add(int value) {",
		"\tint local = value;",
		"\tif (local) { local += 1; }",
		"\treturn local;",
		"}",
	].join("\n");

	test("extracts aggregates, members, typedefs, macros, variables, and functions", () => {
		const parsed = parseC("model.c", modelText);
		const names = parsed.declarations.map((declaration) => declaration.name);

		expect(parsed.diagnostics).toEqual([]);
		expect(names).toEqual([
			"LIMIT",
			"APPLY",
			"Packet",
			"length",
			"code",
			"bits",
			"Ready",
			"Done",
			"Count",
			"hidden",
			"global",
			"add",
			"value",
			"local",
		]);
	});

	test("uses protocol kinds and descriptor paths for C declarations", () => {
		const parsed = parseC("model.c", modelText);
		const packet = parsed.declarations.find((declaration) => declaration.name === "Packet");
		const length = parsed.declarations.find((declaration) => declaration.name === "length");
		const count = parsed.declarations.find((declaration) => declaration.name === "Count");
		const apply = parsed.declarations.find((declaration) => declaration.name === "APPLY");

		if (packet === undefined || length === undefined || count === undefined || apply === undefined) {
			throw new Error("model declarations are missing");
		}
		expect(packet.kind).toBe("struct");
		expect(packet.symbolId).toBe(
			composeSymbolId({ language: "c", module: "model.c", descriptors: [{ kind: "type", name: "Packet" }] }),
		);
		expect(length.kind).toBe("field");
		expect(length.containerId).toBe(packet.symbolId);
		expect(length.symbolId).toBe(
			composeSymbolId({
				language: "c",
				module: "model.c",
				descriptors: [
					{ kind: "type", name: "Packet" },
					{ kind: "term", name: "length" },
				],
			}),
		);
		expect(count.kind).toBe("class");
		expect(count.languageKind).toBe("typedef");
		expect(apply.kind).toBe("function");
		expect(apply.languageKind).toBe("macro");
	});

	test("reports visibility, export state, docs, and function metrics", () => {
		const parsed = parseC("model.c", modelText);
		const packet = parsed.declarations.find((declaration) => declaration.name === "Packet");
		const hidden = parsed.declarations.find((declaration) => declaration.name === "hidden");
		const global = parsed.declarations.find((declaration) => declaration.name === "global");
		const add = parsed.declarations.find((declaration) => declaration.name === "add");
		const value = parsed.declarations.find((declaration) => declaration.name === "value");
		const local = parsed.declarations.find((declaration) => declaration.name === "local");

		expect(packet?.docComment).toBe("Packet docs");
		expect(packet).toMatchObject({ visibility: "public", exported: true });
		expect(hidden).toMatchObject({ visibility: "fileLocal", exported: false });
		expect(global).toMatchObject({ visibility: "public", exported: true });
		expect(add).toMatchObject({
			visibility: "public",
			exported: true,
			metrics: { lines: 5, parameters: 1, branches: 2, nesting: 1 },
		});
		expect(value).toMatchObject({
			kind: "variable",
			languageKind: "parameter",
			visibility: "local",
			exported: false,
		});
		expect(local).toMatchObject({ kind: "variable", visibility: "local", exported: false });
	});

	test("merges a prototype with its later definition", () => {
		const parsed = parseC("model.c", modelText);
		const additions = parsed.declarations.filter((declaration) => declaration.name === "add");

		expect(additions).toHaveLength(1);
		expect(additions[0]?.signature).toContain("int add(int value)");
		expect(additions[0]?.metrics).toMatchObject({ parameters: 1 });
	});

	test("supports function pointers and multiple file-scope declarators", () => {
		const parsed = parseC("pointers.c", "int first, second = 2;\nint (*callback)(int);\n");
		const declarations = parsed.declarations;

		expect(
			declarations.filter((declaration) => ["first", "second", "callback"].includes(declaration.name)),
		).toHaveLength(3);
		expect(declarations.find((declaration) => declaration.name === "callback")?.kind).toBe("variable");
		expect(declarations.find((declaration) => declaration.name === "second")?.visibility).toBe("public");
	});

	test("tolerates Ghidra type names and calling conventions", () => {
		const parsed = parseC(
			"ghidra.c",
			"undefined4 __fastcall FUN_001234(int value);\ncode * __thiscall FUN_001235(byte input) { return 0; }\n",
		);
		const functions = parsed.declarations.filter((declaration) => declaration.kind === "function");

		expect(parsed.diagnostics).toEqual([]);
		expect(functions.map((declaration) => declaration.name)).toEqual(["FUN_001234", "FUN_001235"]);
		expect(parsed.declarations.find((declaration) => declaration.name === "value")?.languageKind).toBe("parameter");
		expect(parsed.declarations.find((declaration) => declaration.name === "input")?.languageKind).toBe("parameter");
	});

	test("reports anonymous aggregate fields under their named outer type", () => {
		const parsed = parseC(
			"anonymous.c",
			"struct Outer { union { int code; long bits; }; enum { Ready, Done }; };\n",
		);
		const outer = parsed.declarations.find((declaration) => declaration.name === "Outer");
		const fields = parsed.declarations.filter((declaration) =>
			["code", "bits", "Ready", "Done"].includes(declaration.name),
		);

		expect(fields).toHaveLength(4);
		expect(fields.every((field) => field.containerId === outer?.symbolId)).toBe(true);
		expect(fields.map((field) => field.kind)).toEqual(["field", "field", "constant", "constant"]);
	});

	test("does not invent a nested type declaration for a tagged type use", () => {
		const parsed = facts(
			new CProvider(),
			"tag-use.c",
			"struct Item { int value; };\nint run(void) { struct Item item; return item.value; }\n",
		);
		const itemTypes = parsed.declarations.filter((declaration) => declaration.name === "Item");
		const typeUse = parsed.references.find(
			(reference) => reference.name === "Item" && reference.role === "typeUse",
		);

		expect(itemTypes).toHaveLength(1);
		expect(typeUse?.binding.status).toBe("bound");
	});

	test("keeps a forward declaration distinct from a later definition", () => {
		const parsed = parseC("forward.c", "struct Item;\nstruct Item;\nstruct Item { int value; };\n");
		const items = parsed.declarations.filter((declaration) => declaration.name === "Item");

		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("struct");
		expect(items[0]?.range.end.line).toBe(2);
	});

	test("marks unions with their language-specific kind", () => {
		const parsed = parseC("union.c", "union Value { int integer; float real; };\n");
		const value = parsed.declarations.find((declaration) => declaration.name === "Value");

		expect(value).toMatchObject({ kind: "struct", languageKind: "union" });
		expect(parsed.declarations.filter((declaration) => declaration.containerId === value?.symbolId)).toHaveLength(
			2,
		);
	});

	test("supports anonymous struct typedefs and points the alias at its declared type", () => {
		const parsed = parseC("alias.c", "typedef struct { int value; } Item;\nItem item;\n");
		const alias = parsed.declarations.find((declaration) => declaration.name === "Item");
		const item = parsed.declarations.find((declaration) => declaration.name === "item");

		expect(alias).toMatchObject({ kind: "class", languageKind: "typedef", exported: true });
		expect(parsed.declarations.find((declaration) => declaration.name === "value")?.containerId).toBe(
			alias?.symbolId,
		);
		expect(item).toBeDefined();
	});

	test("attaches line documentation to the following declaration", () => {
		const parsed = parseC("docs.c", "//! Public value\nint value;\n\n/** Function docs */\nint run(void);\n");

		expect(parsed.declarations.find((declaration) => declaration.name === "value")?.docComment).toBe(
			"Public value",
		);
		expect(parsed.declarations.find((declaration) => declaration.name === "run")?.docComment).toBe("Function docs");
	});

	test("keeps unnamed parameters out of the declaration list", () => {
		const parsed = parseC("parameters.c", "int callback(int, const char *name, void *);\n");
		const parameters = parsed.declarations.filter((declaration) => declaration.languageKind === "parameter");

		expect(parameters.map((parameter) => parameter.name)).toEqual(["name"]);
		expect(parsed.declarations.find((declaration) => declaration.name === "callback")?.metrics?.parameters).toBe(3);
	});
});

describe("Ghidra C syntax", () => {
	test("keeps qualified and global-scope names together in references", () => {
		const parsed = parseC(
			"qualified.c",
			"int global;\nvoid run(void) { int value = owner::member; ::global = &owner::nested::leaf; }\n",
		);

		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.references.find((reference) => reference.name === "owner::member")).toMatchObject({
			name: "owner::member",
			role: "read",
		});
		expect(parsed.references.find((reference) => reference.name === "::global")).toMatchObject({
			name: "::global",
			role: "write",
		});
		expect(parsed.references.find((reference) => reference.name === "owner::nested::leaf")).toMatchObject({
			name: "owner::nested::leaf",
			role: "read",
		});
	});

	test("accepts qualified declarators and labeled statements", () => {
		const parsed = parseC(
			"labels.c",
			"short owner::method(int value);\nvoid run(void) { LAB_2300066c: value = 1; identifier: goto LAB_2300066c; }\n",
		);

		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.declarations.find((declaration) => declaration.name === "owner::method")).toMatchObject({
			kind: "function",
		});
		expect(parsed.declarations.some((declaration) => declaration.name === "LAB_2300066c")).toBe(false);
		expect(parsed.declarations.some((declaration) => declaration.name === "identifier")).toBe(false);
	});

	test("extracts both aliases from a pointer typedef", () => {
		const parsed = parseC("typedef.c", "typedef struct _IO_marker _IO_marker, *P_IO_marker;\n");

		expect(parsed.diagnostics).toEqual([]);
		expect(
			parsed.declarations
				.filter((declaration) => declaration.languageKind === "typedef")
				.map((declaration) => declaration.name),
		).toEqual(["_IO_marker", "P_IO_marker"]);
	});

	test("balances conditional branches and Ghidra warning suffixes", () => {
		const parsed = parseC(
			"conditional-block.c",
			"void run(void) {\n#if FEATURE\n  for (;;) {\n#else\n  for (;;) {\n#endif\n  }\n  if (value\n// WARNING: Load size is inaccurate) {\n    value = 1;\n  }\n}\n",
		);

		expect(parsed.diagnostics).toEqual([]);
	});

	test("retokenizes the complete Ghidra warning suffix", () => {
		const text = "void run(void) {\n  if ((value\n// WARNING: Load size is inaccurate));\n}\n";
		const lexed = lexC("warning-suffix.c", text);
		const parsed = parseC("warning-suffix.c", text);

		expect(parsed.diagnostics).toEqual([]);
		expect(
			lexed.tokens
				.filter((token) => token.start.line === 2 && token.kind === "symbol")
				.map((token) => token.value),
		).toEqual([")", ")", ";"]);
	});

	test("does not retokenize an ordinary comment containing delimiters", () => {
		const text = "void run(void) {\n// ordinary comment ) {\n  return;\n}\n";
		const lexed = lexC("ordinary-comment.c", text);
		const commentLineSymbols = lexed.tokens.filter((token) => token.kind === "symbol" && token.start.line === 1);
		const parsed = parseC("ordinary-comment.c", text);

		expect(commentLineSymbols).toEqual([]);
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.declarations.find((declaration) => declaration.name === "run")).toMatchObject({
			kind: "function",
		});
	});
});

describe("C preprocessor and diagnostics", () => {
	test("reports declarations from every conditional branch", () => {
		const provider = new CProvider();
		const text = "#if FEATURE\nint value;\n#else\nint value;\n#endif\nint run(void) { return value; }\n";
		const parsed = facts(provider, "conditional.c", text);
		const values = parsed.declarations.filter((declaration) => declaration.name === "value");
		const reference = parsed.references.find((candidate) => candidate.name === "value");

		expect(values).toHaveLength(2);
		expect(new Set(values.map((declaration) => declaration.symbolId)).size).toBe(2);
		expect(reference?.binding.status).toBe("ambiguous");
		expect(reference?.binding).toMatchObject({
			status: "ambiguous",
			provenance: "bound",
			detail: "conditional compilation supplies both declarations",
		});
	});

	test("does not expand macro bodies into references", () => {
		const parsed = parseC("macros.c", "#define CALL(name) name()\nint run(void) { return 1; }\n");

		expect(parsed.declarations.find((declaration) => declaration.name === "CALL")?.kind).toBe("function");
		expect(parsed.references.some((reference) => reference.name === "name")).toBe(false);
		expect(parsed.literals.some((literal) => literal.value === "1")).toBe(true);
	});

	test("turns an unfinished initializer into an error without throwing", () => {
		const provider = new CProvider();
		const parsed = facts(provider, "broken.c", "#if ENABLED\nint value = ;\n#endif\n");

		expect(parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
		expect(parsed.diagnostics.map((diagnostic) => diagnostic.message)).toContain("Initializer has no expression.");
	});

	test("reports unmatched delimiters as syntax errors", () => {
		const parsed = parseC("broken.c", "int add( {\n");

		expect(parsed.diagnostics.some((diagnostic) => diagnostic.message.includes("not closed"))).toBe(true);
		expect(parsed.diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
	});

	test("keeps all declaration and reference ranges in source order", () => {
		const parsed = parseC("ranges.c", "int first;\nint run(void) { int second = first; return second; }\n");
		const declarationStarts = parsed.declarations.map((declaration) => declaration.range.start.line);
		const referenceStarts = parsed.references.map((reference) => reference.range.start.line);

		expect(declarationStarts).toEqual([...declarationStarts].sort((left, right) => left - right));
		expect(referenceStarts).toEqual([...referenceStarts].sort((left, right) => left - right));
	});
});

describe("C literals and references", () => {
	test("extracts decoded strings, numbers, booleans, and character literals", () => {
		const provider = new CProvider();
		const text = [
			"const int limit = 3;",
			"bool enabled = true;",
			'const char *label = "hi\\nthere";',
			"int letter = 'A';",
			"int run(void) { double ratio = 2.5; return enabled; }",
		].join("\n");
		const parsed = facts(provider, "literals.c", text);

		expect(parsed.literals.map((literal) => [literal.kind, literal.value, literal.number])).toEqual([
			["number", "3", 3],
			["boolean", "true", undefined],
			["string", "hi\nthere", undefined],
			["number", "'A'", 65],
			["number", "2.5", 2.5],
		]);
	});

	test("preserves all-f hex integers and omits unsafe numeric values", () => {
		const provider = new CProvider();
		const text = [
			"unsigned first = 0xff;",
			"unsigned second = 0xffff;",
			"unsigned third = 0xffffffff;",
			"unsigned fourth = 0xFFFFFFFFu;",
			"unsigned wide = 0xffffffffffffffff;",
			"unsigned decimal = 4294967295;",
		].join("\n");
		const parsed = facts(provider, "integer-masks.c", text);
		const numbers = parsed.literals.filter((literal) => literal.kind === "number");

		expect(numbers.map((literal) => [literal.value, literal.number])).toEqual([
			["0xff", 255],
			["0xffff", 65535],
			["0xffffffff", 4294967295],
			["0xFFFFFFFFu", 4294967295],
			["0xffffffffffffffff", undefined],
			["4294967295", 4294967295],
		]);
		const wide = numbers.find((literal) => literal.value === "0xffffffffffffffff");
		if (wide === undefined) throw new Error("wide integer literal is missing");
		expect(wide).not.toHaveProperty("number");
	});

	test("assigns a function container to literals in its body", () => {
		const parsed = parseC("containers.c", "int run(void) { int value = 2; return value; }\n");
		const run = parsed.declarations.find((declaration) => declaration.name === "run");
		const literal = parsed.literals.find((candidate) => candidate.value === "2");

		expect(run).toBeDefined();
		expect(literal?.containerId).toBe(run?.symbolId);
	});

	test("classifies calls, reads, writes, and compound writes", () => {
		const provider = new CProvider();
		const text =
			"int add(int value) { return value; }\nint run(void) { int local = 1; local += add(local); return local; }\n";
		const parsed = facts(provider, "references.c", text);
		const localReferences = parsed.references.filter((reference) => reference.name === "local");

		expect(parsed.references.find((reference) => reference.name === "add")?.role).toBe("call");
		expect(localReferences.some((reference) => reference.role === "read")).toBe(true);
		expect(localReferences.some((reference) => reference.role === "write")).toBe(true);
		expect(localReferences.filter((reference) => reference.role === "read")).toHaveLength(3);
	});

	test("marks struct and typedef names as type uses", () => {
		const parsed = parseC(
			"type-uses.c",
			"struct Item { int field; };\ntypedef int Count;\nstruct Item *item;\nCount count;\n",
		);
		const uses = parsed.references.filter((reference) => reference.role === "typeUse");

		expect(uses.map((reference) => reference.name)).toEqual(["Item", "Count"]);
	});
});

describe("C binding and imports", () => {
	test("binds a local reference to its declaration rather than its name", () => {
		const provider = new CProvider();
		const text =
			"int add(int value) { return value; }\nint run(void) { int value = 1; return value + add(value); }\n";
		const parsed = facts(provider, "bind.c", text);
		const local = parsed.declarations.find(
			(declaration) => declaration.name === "value" && declaration.containerId?.includes("run()"),
		);
		const use = parsed.references.find(
			(reference) => reference.name === "value" && reference.fromId?.includes("run()"),
		);

		if (local === undefined || use === undefined) throw new Error("local binding fixture is missing");
		expect(use.binding).toMatchObject({ status: "bound", symbolId: local.symbolId, provenance: "bound" });
	});

	test("binds type uses and calls through the same-file index", () => {
		const provider = new CProvider();
		const text =
			"struct Item { int value; };\nint add(void) { return 1; }\nint run(void) { struct Item item; return add(); }\n";
		const parsed = facts(provider, "same-file.c", text);
		const typeReference = parsed.references.find((reference) => reference.name === "Item");
		const callReference = parsed.references.find((reference) => reference.name === "add");

		expect(typeReference?.binding.status).toBe("bound");
		expect(callReference?.binding.status).toBe("bound");
		expect(callReference?.binding.status === "bound" ? callReference.binding.symbolId : "").toContain("add()");
	});

	test("resolves quoted includes beside a file and at workspace root", () => {
		const root = workspace({
			"src/cart.c": '#include "item.h"\n#include "root.h"\n',
			"src/item.h": "int item;\n",
			"root.h": "int root;\n",
		});
		const provider = new CProvider();
		provider.initialize(root);
		const text = readFileSync(path.join(root, "src/cart.c"), "utf8");

		facts(provider, "src/cart.c", text);

		expect(provider.resolveImport({ fromModule: "src/cart.c", specifier: "item.h" })).toEqual({
			status: "resolved",
			module: "src/item.h",
		});
		expect(provider.resolveImport({ fromModule: "src/cart.c", specifier: "root.h" })).toEqual({
			status: "resolved",
			module: "root.h",
		});
	});

	test("marks angle includes external and missing quoted includes unresolved", () => {
		const provider = new CProvider();
		provider.initialize(process.cwd());
		const text = '#include <stdio.h>\n#include "missing.h"\n';
		const parsed = facts(provider, "imports.c", text);

		expect(provider.resolveImport({ fromModule: "imports.c", specifier: "<stdio.h>" })).toEqual({
			status: "external",
			packageName: "stdio.h",
		});
		expect(provider.resolveImport({ fromModule: "imports.c", specifier: "missing.h" })).toMatchObject({
			status: "unresolved",
			reason: "NotIndexed",
		});
		expect(parsed.references.filter((reference) => reference.role === "import")).toHaveLength(2);
		expect(parsed.references.find((reference) => reference.name === "stdio.h")?.binding).toMatchObject({
			status: "unbound",
			reason: "ExternalDependency",
		});
		expect(parsed.references.find((reference) => reference.name === "missing.h")?.binding).toMatchObject({
			status: "unbound",
			reason: "NotIndexed",
		});
	});

	test("binds a declaration reached through a workspace header", () => {
		const root = workspace({
			"src/cart.c": '#include "item.h"\nint run(void) { return item; }\n',
			"src/item.h": "int item;\n",
		});
		const provider = new CProvider();
		provider.initialize(root);
		const source = readFileSync(path.join(root, "src/cart.c"), "utf8");
		const parsed = facts(provider, "src/cart.c", source);
		const reference = parsed.references.find((candidate) => candidate.name === "item");

		if (reference === undefined) throw new Error("workspace reference is missing");
		expect(reference.binding).toMatchObject({ status: "bound", provenance: "bound" });
		expect(reference.binding.status === "bound" ? reference.binding.symbolId : "").toContain("src/item.h");
	});

	test("finds same-file candidates through the parsed declaration index", () => {
		const parsed = parseC("candidates.c", "int add(void) { return 1; }\nint run(void) { return add(); }\n");
		const reference = parsed.references.find((candidate) => candidate.name === "add");

		if (reference === undefined) throw new Error("call reference is missing");
		expect(bindingCandidates(parsed, reference).map((declaration) => declaration.name)).toEqual(["add"]);
	});

	test("binds by a requested reference range and by a declaration range", () => {
		const provider = new CProvider();
		const text = "int add(void) { return 1; }\nint run(void) { return add(); }\n";
		const parsed = facts(provider, "bind-range.c", text);
		const reference = parsed.references.find((candidate) => candidate.name === "add");
		const declaration = declarationOf(parsed, "add", "function");

		if (reference === undefined || declaration === undefined) throw new Error("bind range fixture is missing");
		expect(provider.bind({ module: "bind-range.c", name: "add", range: reference.range })).toMatchObject({
			status: "bound",
			symbolId: declaration.symbolId,
		});
		expect(provider.bind({ module: "bind-range.c", name: "add", range: declaration.selectionRange })).toMatchObject(
			{
				status: "bound",
				symbolId: declaration.symbolId,
			},
		);
	});
});

describe("C type answers", () => {
	test("returns declared primitive, pointer, alias, and function types", () => {
		const provider = new CProvider();
		const text =
			"typedef unsigned int Count;\nconst int limit = 1;\nCount *counter;\nint run(void) { return limit; }\n";
		const parsed = facts(provider, "types.c", text);
		const count = declarationOf(parsed, "Count");
		const limit = declarationOf(parsed, "limit");
		const counter = declarationOf(parsed, "counter");
		const run = declarationOf(parsed, "run", "function");

		if (count === undefined || limit === undefined || counter === undefined || run === undefined) {
			throw new Error("type declarations are missing");
		}
		expect(provider.typeOf({ symbolId: count.symbolId })).toMatchObject({
			status: "known",
			display: "unsigned int",
			provenance: "declared",
		});
		expect(provider.typeOf({ symbolId: limit.symbolId })).toMatchObject({
			status: "known",
			display: "int",
			provenance: "declared",
		});
		expect(provider.typeOf({ symbolId: counter.symbolId })).toMatchObject({
			status: "known",
			display: "Count *",
			provenance: "declared",
		});
		expect(provider.typeOf({ symbolId: run.symbolId })).toMatchObject({
			status: "known",
			display: "int",
			provenance: "declared",
		});
	});

	test("returns the declaration type for a position inside its type range", () => {
		const provider = new CProvider();
		const text = "const unsigned int limit = 1;\n";
		const parsed = facts(provider, "type-range.c", text);
		const limit = declarationOf(parsed, "limit");

		if (limit === undefined) throw new Error("limit declaration is missing");
		const answer = provider.typeOf({ module: "type-range.c", range: rangeAt(text, "unsigned int") });

		expect(answer).toMatchObject({ status: "known", display: "unsigned int", provenance: "declared" });
	});

	test("links named aggregate types from type answers", () => {
		const provider = new CProvider();
		const text = "struct Item { int value; };\nstruct Item item;\n";
		const parsed = facts(provider, "aggregate-type.c", text);
		const item = declarationOf(parsed, "item");

		if (item === undefined) throw new Error("aggregate variable is missing");
		const answer = provider.typeOf({ symbolId: item.symbolId });

		expect(answer).toMatchObject({ status: "known", display: "struct Item", provenance: "declared" });
		expect(answer.status === "known" ? answer.symbolId : "").toContain("Item#");
	});

	test("uses closed unknown reasons for invalid and missing type requests", () => {
		const provider = new CProvider();
		provider.initialize(process.cwd());

		const invalid = provider.typeOf({ symbolId: "not-a-c-symbol" });
		const missing = provider.typeOf({ symbolId: "lexicon c missing.c value." });

		expect(invalid).toMatchObject({ status: "unknown", reason: "ParseError" });
		expect(missing).toMatchObject({ status: "unknown", reason: "NotIndexed" });
		expect(TypeInfoSchema.safeParse(invalid).success).toBe(true);
	});
});

describe("C edge coverage", () => {
	test("parses nested block locals without promoting expressions to declarations", () => {
		const parsed = facts(
			new CProvider(),
			"nested.c",
			"int run(int flag) { if (flag) { int inside = 1; inside++; } for (int index = 0; index < 2; index++) { int loop = index; } return flag; }\n",
		);
		const locals = parsed.declarations.filter((declaration) =>
			["inside", "index", "loop"].includes(declaration.name),
		);
		const keywords = parsed.declarations.filter((declaration) =>
			["if", "for", "return"].includes(declaration.name),
		);

		expect(locals).toHaveLength(3);
		expect(locals.every((declaration) => declaration.visibility === "local")).toBe(true);
		expect(keywords).toEqual([]);
		expect(parsed.references.some((reference) => reference.name === "inside" && reference.role === "write")).toBe(
			true,
		);
	});

	test("handles nested tagged aggregates and their member containers", () => {
		const parsed = parseC("nested-types.c", "struct Outer { struct Inner { int value; } inner; };\n");
		const outer = parsed.declarations.find((declaration) => declaration.name === "Outer");
		const inner = parsed.declarations.find((declaration) => declaration.name === "Inner");
		const value = parsed.declarations.find((declaration) => declaration.name === "value");
		const field = parsed.declarations.find((declaration) => declaration.name === "inner");

		expect(outer?.kind).toBe("struct");
		expect(inner?.kind).toBe("struct");
		expect(inner?.containerId).toBe(outer?.symbolId);
		expect(value?.containerId).toBe(inner?.symbolId);
		expect(field?.containerId).toBe(outer?.symbolId);
	});

	test("keeps static functions file-local while exporting ordinary functions", () => {
		const parsed = facts(
			new CProvider(),
			"functions.c",
			"static int hidden(void) { return 0; }\nint visible(void) { return hidden(); }\n",
		);
		const hidden = parsed.declarations.find((declaration) => declaration.name === "hidden");
		const visible = parsed.declarations.find((declaration) => declaration.name === "visible");

		expect(hidden).toMatchObject({ kind: "function", visibility: "fileLocal", exported: false });
		expect(visible).toMatchObject({ kind: "function", visibility: "public", exported: true });
		expect(parsed.references.find((reference) => reference.name === "hidden")?.binding.status).toBe("bound");
	});

	test("recognizes const objects as constants without changing their public state", () => {
		const parsed = parseC("constants.c", "static const int privateLimit = 1;\nconst int publicLimit = 2;\n");
		const privateLimit = parsed.declarations.find((declaration) => declaration.name === "privateLimit");
		const publicLimit = parsed.declarations.find((declaration) => declaration.name === "publicLimit");

		expect(privateLimit).toMatchObject({ kind: "constant", visibility: "fileLocal", exported: false });
		expect(publicLimit).toMatchObject({ kind: "constant", visibility: "public", exported: true });
	});

	test("keeps declarations inside preprocessor branches even when the condition is unknown", () => {
		const parsed = parseC(
			"branches.c",
			"#ifdef ONE\nint one;\n#elif TWO\nint two;\n#else\nint fallback;\n#endif\n",
		);

		expect(parsed.declarations.map((declaration) => declaration.name)).toEqual(["one", "two", "fallback"]);
		expect(parsed.diagnostics).toEqual([]);
	});

	test("does not treat strings, comments, or include names as references", () => {
		const parsed = parseC("ignored-names.c", '#include "item.h"\n// item\nconst char *text = "item";\nint item;\n');
		const itemReferences = parsed.references.filter((reference) => reference.name === "item");

		expect(itemReferences).toHaveLength(0);
		expect(parsed.references.filter((reference) => reference.role === "import")).toHaveLength(1);
	});

	test("preserves include path ranges and distinguishes angle paths with slashes", () => {
		const parsed = parseC("include-ranges.c", '#include "local/item.h"\n#include <sys/types.h>\n');
		const imports = parsed.references.filter((reference) => reference.role === "import");

		expect(imports.map((reference) => reference.name)).toEqual(["local/item.h", "sys/types.h"]);
		expect(imports[0]?.range.start).toEqual({ line: 0, character: 9 });
		expect(imports[1]?.range.start).toEqual({ line: 1, character: 10 });
	});

	test("resolves extensionless quoted headers using header and source fallbacks", () => {
		const root = workspace({
			"src/header-user.c": '#include "item"\n',
			"src/item.h": "int item;\n",
		});
		const provider = new CProvider();
		provider.initialize(root);
		facts(provider, "src/header-user.c", readFileSync(path.join(root, "src/header-user.c"), "utf8"));

		expect(provider.resolveImport({ fromModule: "src/header-user.c", specifier: "item" })).toEqual({
			status: "resolved",
			module: "src/item.h",
		});
	});

	test("treats standard system families as external dependencies", () => {
		const provider = new CProvider();
		provider.initialize(process.cwd());

		expect(provider.resolveImport({ fromModule: "main.c", specifier: "sys/socket.h" })).toEqual({
			status: "external",
			packageName: "sys/socket.h",
		});
		expect(provider.resolveImport({ fromModule: "main.c", specifier: "linux/input.h" })).toEqual({
			status: "external",
			packageName: "linux/input.h",
		});
	});

	test("returns a reasoned unknown binding for a missing source name", () => {
		const provider = new CProvider();
		const parsed = facts(provider, "unknown.c", "int run(void) { return missing; }\n");
		const reference = parsed.references.find((candidate) => candidate.name === "missing");

		expect(reference?.binding).toMatchObject({ status: "unbound", reason: "NotIndexed" });
		expect(reference?.binding.status === "unbound" ? reference.binding.detail : "").toContain("missing");
	});

	test("reports ordinary duplicate candidates as ambiguous when conditional provenance is absent", () => {
		const provider = new CProvider();
		const text = "int value;\nstatic int value;\nint run(void) { return value; }\n";
		const parsed = facts(provider, "duplicate.c", text);
		const reference = parsed.references.find((candidate) => candidate.name === "value");

		expect(parsed.declarations.filter((declaration) => declaration.name === "value")).toHaveLength(2);
		expect(reference?.binding.status).toBe("ambiguous");
		expect(reference?.binding.status === "ambiguous" ? reference.binding.candidates : []).toHaveLength(2);
	});

	test("resolves an imported function to the header symbol", () => {
		const root = workspace({
			"src/main.c": '#include "api.h"\nint run(void) { return add(); }\n',
			"src/api.h": "int add(void);\n",
		});
		const provider = new CProvider();
		provider.initialize(root);
		const source = readFileSync(path.join(root, "src/main.c"), "utf8");
		const parsed = facts(provider, "src/main.c", source);
		const reference = parsed.references.find((candidate) => candidate.name === "add");

		expect(reference?.role).toBe("call");
		expect(reference?.binding.status).toBe("bound");
		expect(reference?.binding.status === "bound" ? reference.binding.symbolId : "").toContain("src/api.h");
	});

	test("finds type information by a declaration selection range", () => {
		const provider = new CProvider();
		const text = "int value = 1;\n";
		const parsed = facts(provider, "selection-type.c", text);
		const value = declarationOf(parsed, "value");

		if (value === undefined) throw new Error("selection declaration is missing");
		expect(provider.typeOf({ module: "selection-type.c", range: value.selectionRange })).toMatchObject({
			status: "known",
			display: "int",
			provenance: "declared",
		});
	});

	test("loads a header from disk when a type request arrives before parsing it", () => {
		const root = workspace({ "include/value.h": "typedef unsigned long Word;\n" });
		const provider = new CProvider();
		provider.initialize(root);
		const symbolId = composeSymbolId({
			language: "c",
			module: "include/value.h",
			descriptors: [{ kind: "type", name: "Word" }],
		});

		expect(provider.typeOf({ symbolId })).toMatchObject({ status: "known", display: "unsigned long" });
	});

	test("keeps the requested content hash on the wire", () => {
		const provider = new CProvider();

		expect(facts(provider, "hash.c", "int value;\n").contentHash).toBe("hash.c:11");
	});

	test("does not expose preprocessor literals as source literals", () => {
		const parsed = parseC("macro-literals.c", "#define LIMIT 42\nint value = 7;\n");

		expect(parsed.literals.map((literal) => literal.value)).toEqual(["7"]);
		expect(parsed.declarations.find((declaration) => declaration.name === "LIMIT")?.kind).toBe("constant");
	});

	test("keeps declaration comments in the declaration range", () => {
		const parsed = parseC("comment-range.c", "/** docs */\nint value;\n");
		const value = parsed.declarations.find((declaration) => declaration.name === "value");

		expect(value?.range.start).toEqual({ line: 0, character: 0 });
		expect(value?.selectionRange.start).toEqual({ line: 1, character: 4 });
	});

	test("keeps prototype metrics distinct from body metrics", () => {
		const parsed = parseC("metrics.c", "int declared(int a, int b);\nint defined(int a) { return a; }\n");
		const declared = parsed.declarations.find((declaration) => declaration.name === "declared");
		const defined = parsed.declarations.find((declaration) => declaration.name === "defined");

		expect(declared?.metrics).toMatchObject({ parameters: 2 });
		expect(declared?.metrics?.branches).toBeUndefined();
		expect(defined?.metrics).toMatchObject({ parameters: 1, branches: 1, nesting: 0 });
	});

	test("recovers from malformed separators without an infinite scan", () => {
		const parsed = parseC("recovery.c", "int first = ;;;; int second = 2; ??? int third;\n");

		expect(parsed.declarations.map((declaration) => declaration.name)).toContain("second");
		expect(parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
	});
});

describe("C edit refusals and protocol values", () => {
	test("refuses rename and move with a closed reason", () => {
		const provider = new CProvider();
		provider.initialize(process.cwd());
		const rename: RenameEditsRequest = {
			module: "a.c",
			text: "int value;\n",
			oldName: "value",
			newName: "next",
			sites: [],
		};
		const move: MoveEditsRequest = {
			module: "a.c",
			text: "int value;\n",
			exists: true,
			symbolId: composeSymbolId({ language: "c", module: "a.c", descriptors: [{ kind: "term", name: "value" }] }),
			name: "value",
			fromModule: "a.c",
			toModule: "b.c",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		};

		expect(provider.renameEdits(rename)).toMatchObject({ status: "refused", reason: "NotImplemented" });
		expect(provider.moveEdits(move)).toMatchObject({ status: "refused", reason: "NotImplemented" });
	});

	test("validates binding and type values against their schemas", () => {
		const provider = new CProvider();
		const parsed = facts(provider, "schema.c", "int value = 1;\n");
		const value = declarationOf(parsed, "value");

		if (value === undefined) throw new Error("schema declaration is missing");
		const binding = provider.bind({ module: "schema.c", name: "value", range: value.selectionRange });
		const type = provider.typeOf({ symbolId: value.symbolId });

		expect(BindingSchema.parse(binding).status).toBe("bound");
		expect(TypeInfoSchema.parse(type).status).toBe("known");
	});
});

const libuvCorpusRoot = path.join(process.cwd(), "temp", "libuv");
const ghidraCorpusRoot = path.join(process.cwd(), "temp", "bl602-ghidra");
const corpusPresent =
	existsSync(libuvCorpusRoot) &&
	statSync(libuvCorpusRoot).isDirectory() &&
	existsSync(ghidraCorpusRoot) &&
	statSync(ghidraCorpusRoot).isDirectory();

test.skipIf(!corpusPresent)(
	"parses every claimed C file from both requested corpora",
	() => {
		const started = performance.now();
		let files = 0;
		let bytes = 0;
		let declarations = 0;
		let references = 0;
		let imports = 0;
		const rootCounts: Array<{ root: string; files: number }> = [];
		const syntaxErrorFiles: string[] = [];

		for (const root of [libuvCorpusRoot, ghidraCorpusRoot]) {
			const provider = new CProvider();
			provider.initialize(root);
			const project = provider.discoverProject(root);
			expect(project.diagnostics).toEqual([]);
			const modules = project.files.filter((module) => module.endsWith(".c") || module.endsWith(".h"));
			rootCounts.push({ root: path.relative(process.cwd(), root), files: modules.length });

			for (const module of modules) {
				const source = readFileSync(path.join(root, module), "utf8");
				const parsed = facts(provider, module, source);
				files++;
				bytes += source.length;
				declarations += parsed.declarations.length;
				references += parsed.references.length;
				imports += parsed.imports.length;
				if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
					syntaxErrorFiles.push(path.relative(process.cwd(), path.join(root, module)).replace(/\\/gu, "/"));

				if (root === libuvCorpusRoot && module === "src/unix/netbsd.c")
					expect(declarationOf(parsed, "uv__platform_loop_init")).toMatchObject({
						name: "uv__platform_loop_init",
						kind: "function",
					});
				if (root === ghidraCorpusRoot && module === "libwifi1/co_ring.o.c")
					expect(declarationOf(parsed, "Elf32_Shdr", "struct")).toMatchObject({
						name: "Elf32_Shdr",
						kind: "struct",
					});
			}
		}

		const seconds = (performance.now() - started) / 1000;
		console.log(
			`[c corpus] roots=${JSON.stringify(rootCounts)} files=${files} bytes=${bytes} declarations=${declarations} references=${references} imports=${imports} syntaxErrorFiles=${syntaxErrorFiles.length} wallSeconds=${seconds.toFixed(3)}`,
		);
		expect(files).toBeGreaterThan(0);
		expect(syntaxErrorFiles).toEqual([]);
	},
	120_000,
);
