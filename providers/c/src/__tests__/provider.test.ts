import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type ArrangeEditsRequest,
	BindingSchema,
	composeSymbolId,
	coordinatesOf,
	FileFactsSchema,
	handlersFor,
	InitializeResponseSchema,
	type MoveEditsRequest,
	PROTOCOL_VERSION,
	ProjectModelSchema,
	parseSymbolId,
	type Range,
	type RenameEditsRequest,
	TypeInfoSchema,
} from "@nyaa-lexicon/protocol";
import { CProvider, REFERENCE_ROLES, TIERS } from "../main.js";
import { bindingCandidates, parseC } from "../parser.js";
import { lexC } from "../tokens.js";

const temporaryRoots: string[] = [];

const ASTRAL = String.fromCodePoint(0x1f600);
const NAIVE = `na${String.fromCodePoint(0xef)}ve`;

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

function started(root = workspace({})) {
	const handlers = handlersFor(new CProvider());
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return handlers;
}

function facts(handlers: ReturnType<typeof started>, module: string, text: string) {
	const contentHash = `${module}:${text.length}`;
	const parsed = handlers.parseFile({ module, contentHash, text });
	verdict(handlers, module, contentHash);
	return parsed;
}

/** The index's verdict on a parse, through the kit as the wire delivers it. */
function verdict(handlers: ReturnType<typeof started>, module: string, contentHash: string, refusal?: string): void {
	handlers.moduleAdmission?.({
		module,
		contentHash,
		outcome: refusal === undefined ? { status: "admitted" } : { status: "refused", reason: refusal },
	});
}

/** An include resolved to workspace `module`. */
function landed(module: string) {
	return { status: "resolved", landing: { kind: "module", module } } as const;
}

/** A `build/compile_commands.json` entry for workspace `file`, built with `args`. */
function unitEntry(file: string, ...args: string[]) {
	return { directory: ".", file: `../${file}`, arguments: ["cc", ...args, "-c", `../${file}`] };
}

/** The module the first non-include reference to `name` binds into, or its binding's status. */
function homeOf(parsed: Pick<ReturnType<CProvider["parseFile"]>, "references">, name: string) {
	const binding = parsed.references.find(
		(reference) => reference.name === name && reference.role !== "import",
	)?.binding;
	return binding?.status === "bound" ? parseSymbolId(binding.symbolId)?.module : binding?.status;
}

function declarationOf(parsed: Pick<ReturnType<CProvider["parseFile"]>, "declarations">, name: string, kind?: string) {
	return parsed.declarations.find(
		(declaration) => declaration.name === name && (kind === undefined || declaration.kind === kind),
	);
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("C provider protocol", () => {
	test("declares C files, supported reference roles, and implemented tiers", () => {
		const handlers = handlersFor(new CProvider());
		const response = handlers.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });

		expect(InitializeResponseSchema.parse(response).language).toBe("c");
		expect(response.providerId).toBe("c-provider");
		expect(response.extensions).toEqual([".c", ".h"]);
		expect(response.referenceRoles).toEqual([...REFERENCE_ROLES]);
		expect(response.tiers).toEqual(TIERS);
	});

	test("exposes every provider method through the handler table", () => {
		const handlers = started();

		expect(Object.keys(handlers).sort()).toEqual([
			"arrangeEdits",
			"bind",
			"discoverProject",
			"forgetModule",
			"importEdits",
			"indexRoots",
			"initialize",
			"judgeLoadCycle",
			"moduleAdmission",
			"moveEdits",
			"parseFile",
			"probeBatch",
			"probeFile",
			"releaseLoadCycle",
			"releaseModule",
			"renameEdits",
			"resolveImport",
			"shutdown",
			"typeOf",
		]);
		expect(
			handlers.probeBatch({ files: [{ module: "src/a.c", contentHash: "a", text: "" }], answer: ["src/a.c"] }),
		).toEqual({ status: "unsupported" });
		expect(handlers.shutdown({})).toEqual({});
	});

	test("reports a defined main on parses and probes", () => {
		const handlers = started();
		const text = "int main(void) {\n\treturn 0;\n}\n";
		const parsed = facts(handlers, "src/main.c", text);
		const main = declarationOf(parsed, "main", "function");

		expect(main).toBeDefined();
		expect(parsed.role).toEqual(main && { kind: "entry", how: "main", symbolId: main.symbolId });

		const probed = handlers.probeFile({ module: "src/probe.c", contentHash: "probe", text });
		const probedMain = declarationOf(probed, "main", "function");

		expect(probedMain).toBeDefined();
		expect(probed.role).toEqual(probedMain && { kind: "entry", how: "main", symbolId: probedMain.symbolId });
	});

	test("a main prototype does not make a file an entry", () => {
		const handlers = started();
		const parsed = facts(
			handlers,
			"src/cart.c",
			"int main(void);\nint add(int left, int right) { return left + right; }\n",
		);

		expect(parsed.role).toEqual({ kind: "library" });
	});

	test("a refusal leaves only the include kinds the admitted parse stated", () => {
		const root = workspace({
			"src/local.h": "int shared;\n",
			"src/extra.h": "int spare;\n",
			"src/use.c": '#include "local.h"\n',
		});
		const handlers = started(root);
		const resolve = (specifier: string) => handlers.resolveImport({ fromModule: "src/use.c", specifier });

		handlers.parseFile({ module: "src/use.c", contentHash: "quoted", text: '#include "local.h"\n' });
		verdict(handlers, "src/use.c", "quoted");
		handlers.parseFile({
			module: "src/use.c",
			contentHash: "angle",
			text: "#include <local.h>\n#include <extra.h>\n",
		});

		expect(resolve("local.h")).toEqual({ status: "external", packageName: "local.h" });

		verdict(handlers, "src/use.c", "angle", "the index refused these facts");

		expect(resolve("local.h")).toEqual(landed("src/local.h"));
		expect(resolve("extra.h")).toEqual(landed("src/extra.h"));
	});

	test("an admitted reparse drops an include kind the file no longer states", () => {
		const root = workspace({ "src/extra.h": "int spare;\n", "src/use.c": "#include <extra.h>\n" });
		const handlers = started(root);
		const resolve = () => handlers.resolveImport({ fromModule: "src/use.c", specifier: "extra.h" });

		handlers.parseFile({ module: "src/use.c", contentHash: "angle", text: "#include <extra.h>\n" });
		verdict(handlers, "src/use.c", "angle");
		expect(resolve()).toEqual({ status: "external", packageName: "extra.h" });

		handlers.parseFile({ module: "src/use.c", contentHash: "none", text: "int run(void) { return 0; }\n" });
		verdict(handlers, "src/use.c", "none");

		expect(resolve()).toEqual(landed("src/extra.h"));
	});

	test("answers a probe from the candidate, then serves what the index holds, never the candidate or the disk", () => {
		const old = "#include <item.h>\nint add(int left, int right);\n";
		const disk = '#include "item.h"\nint renamed(void);\n';
		const user = '#include "cart.h"\n\nint run(void) { return add(1, 2) + renamed() + candidate(); }\n';
		const root = workspace({ "src/item.h": "int item;\n", "src/cart.h": old, "src/use.c": user });
		const handlers = started(root);
		const served = () => ({
			bound: facts(handlers, "src/use.c", user)
				.references.filter((reference) => reference.binding.status === "bound")
				.map((reference) => reference.name),
			item: handlers.resolveImport({ fromModule: "src/cart.h", specifier: "item.h" }).status,
		});

		handlers.parseFile({ module: "src/cart.h", contentHash: "old", text: old });
		verdict(handlers, "src/cart.h", "old");
		// Disk parse outstanding across the probe.
		writeFileSync(path.join(root, "src/cart.h"), disk);
		handlers.parseFile({ module: "src/cart.h", contentHash: "disk", text: disk });
		const probed = handlers.probeFile({
			module: "src/cart.h",
			contentHash: "probe",
			text: '#include "item.h"\nint candidate(void);\n',
		});
		const outstanding = served();
		verdict(handlers, "src/cart.h", "disk", "the index refused these facts");

		expect({
			candidate: probed.declarations.map((declaration) => declaration.name),
			outstanding,
			held: served(),
		}).toEqual({
			candidate: ["candidate"],
			outstanding: { bound: ["renamed"], item: "resolved" },
			held: { bound: ["add"], item: "external" },
		});
	});

	test("a forgotten module does not come back through a read of its own bytes", () => {
		const root = workspace({ "src/cart.h": "int add(int left, int right);\n" });
		const handlers = started(root);
		const user = '#include "cart.h"\n\nint run(void) { return add(1, 2); }\n';
		const bound = () => facts(handlers, "src/use.c", user).references.find((reference) => reference.name === "add");

		expect(bound()?.binding.status).toBe("bound");

		handlers.forgetModule?.({ module: "src/cart.h" });

		expect(bound()?.binding.status).toBe("unbound");
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
		const project = new CProvider().discoverProject(root).model;

		expect(ProjectModelSchema.parse(project).files).toEqual(["include/sample.h", "src/main.c"]);
		expect(project.configFiles).toEqual(["CMakeLists.txt", "Makefile"]);
		expect(project.externalRoots).toEqual([]);
		expect(project.diagnostics).toEqual([]);
	});

	test("reports a project diagnostic for a missing workspace", () => {
		const project = new CProvider().discoverProject(path.join(tmpdir(), "c-provider-no-such-workspace")).model;

		expect(project.files).toEqual([]);
		expect(project.diagnostics[0]?.severity).toBe("error");
		expect(project.diagnostics[0]?.message).toContain("does not exist");
	});

	test("returns a complete schema-shaped empty file", () => {
		const handlers = started();

		const parsed = facts(handlers, "empty.c", "\n");

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
		const lexed = lexC("utf16.c", `/* ${ASTRAL} */ int value;\n`);
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

	test("reads escapes to the standard's limits and keeps one no character can name", () => {
		const escapes = [
			'"\\033[0m"',
			'"\\1234"',
			'"\\0x"',
			'"\\u00e9\\U0001F600"',
			'"\\u12"',
			'"\\xFFFFFFFFF"',
			'"split \\\nline"',
			'"crlf \\\r\nline"',
		];
		const lexed = lexC("escapes.c", escapes.join(" "));

		expect(lexed.diagnostics).toEqual([]);
		expect(lexed.tokens.filter((token) => token.kind === "string").map((token) => token.value)).toEqual([
			"\x1b[0m",
			"S4",
			"\0x",
			`${String.fromCodePoint(0xe9)}${ASTRAL}`,
			"\\u12",
			"\\xFFFFFFFFF",
			"split line",
			"crlf line",
		]);
	});

	test("reads three quotes as an empty string and the start of another, never a triple-quoted string", () => {
		const strings = lexC("quotes.c", 'const char *t = """x""";').tokens.filter((token) => token.kind === "string");

		expect(strings.map((token) => [token.raw, token.value])).toEqual([
			['""', ""],
			['"x"', "x"],
			['""', ""],
		]);
	});

	test("reads an encoding prefix as part of its literal, and a lone prefix letter as a name", () => {
		const text = 'L"wide" u8"narrow" U\'x\' u\'y\' L u8 x"after"';
		const tokens = lexC("prefixes.c", text).tokens.filter((token) => token.kind !== "newline");

		expect(tokens.map((token) => [token.kind, token.raw, token.value])).toEqual([
			["string", 'L"wide"', "wide"],
			["string", 'u8"narrow"', "narrow"],
			["char", "U'x'", "x"],
			["char", "u'y'", "y"],
			["identifier", "L", "L"],
			["identifier", "u8", "u8"],
			["identifier", "x", "x"],
			["string", '"after"', "after"],
		]);
	});

	test("keeps doc comments and diagnoses unterminated quoted text", () => {
		const lexed = lexC("comments.c", '/** API docs */\n/// next docs\nint value;\n"unterminated\n');
		const comments = lexed.tokens.filter((token) => token.kind === "comment");

		expect(comments.map((token) => token.doc)).toEqual(["API docs", "next docs"]);
		expect(lexed.diagnostics).toHaveLength(1);
		expect(lexed.diagnostics[0]?.range?.start).toEqual({ line: 3, character: 0 });
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
		return (facts(started(), "spans.c", text).comments ?? []).map((comment) => comment.text);
	}

	test("declares the comments tier and carries spans through parseFile", () => {
		const handlers = started();
		const text = "// note\nint value = 1;\n";

		const parsed = facts(handlers, "spans.c", text);

		expect(TIERS.comments).toBe(true);
		expect(FileFactsSchema.safeParse(parsed).success).toBe(true);
		expect(parsed.comments).toEqual([
			{ range: rangeAt(text, "// note"), text: "// note", codeBefore: false, codeAfter: false },
		]);
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
		const handlers = started();
		const text = "int before = 1;\n/* opened and never closed";

		const parsed = facts(handlers, "open.c", text);

		expect(parsed.comments).toEqual([
			{
				range: rangeAt(text, "/* opened and never closed"),
				text: "/* opened and never closed",
				codeBefore: false,
				codeAfter: false,
			},
		]);
		expect(declarationOf(parsed, "before")).toBeDefined();
	});

	test("ends a block comment at the first close, since C blocks do not nest", () => {
		const handlers = started();
		const text = "/* outer /* inner */\nint after = 1;\n";

		const parsed = facts(handlers, "nest.c", text);

		expect((parsed.comments ?? []).map((comment) => comment.text)).toEqual(["/* outer /* inner */"]);
		expect(declarationOf(parsed, "after")).toBeDefined();
	});

	test("continues a line comment across a backslash newline", () => {
		const handlers = started();
		const text = "// wraps \\\nstill comment\nint after = 1;\n";

		const parsed = facts(handlers, "continued.c", text);

		expect(parsed.comments).toEqual([
			{
				range: rangeAt(text, "// wraps \\\nstill comment"),
				text: "// wraps \\\nstill comment",
				codeBefore: false,
				codeAfter: false,
			},
		]);
		expect(declarationOf(parsed, "after")).toBeDefined();
	});

	test("spans a comment holding astral text in UTF-16 code units", () => {
		const handlers = started();
		const text = `int value = 1; /* ${ASTRAL} */\n`;

		const parsed = facts(handlers, "utf16.c", text);

		expect(parsed.comments).toEqual([
			{ range: rangeAt(text, `/* ${ASTRAL} */`), text: `/* ${ASTRAL} */`, codeBefore: true, codeAfter: false },
		]);
	});

	test("reports a retokenized Ghidra warning line as a single comment", () => {
		const text = "void run(void) {\n  if ((value\n// WARNING: Load size is inaccurate));\n}\n";

		expect(commentTexts(text)).toEqual(["// WARNING: Load size is inaccurate));"]);
	});
});

describe("C token boundaries", () => {
	test("reads Unicode identifiers and astral symbols without consuming what follows", () => {
		const tokens = lexC("unicode.c", `${NAIVE}_2+next ${ASTRAL}x`).tokens;

		expect(tokens.map((token) => [token.kind, token.raw, token.start.character, token.end.character])).toEqual([
			["identifier", `${NAIVE}_2`, 0, 7],
			["symbol", "+", 7, 8],
			["identifier", "next", 8, 12],
			["symbol", ASTRAL, 13, 15],
			["identifier", "x", 15, 16],
		]);
	});

	test("deletes line splices before tokenizing, so a directive runs on and a split word is one token", () => {
		const lexed = lexC("splices.c", "#define VALUE(x) \\\n+(x)\nint ab\\\r\ncd = 1\\\n2;\n");
		const code = lexed.tokens.filter((token) => token.kind !== "newline");

		expect(lexed.tokens.filter((token) => token.kind === "newline")).toHaveLength(2);
		expect(code.map((token) => [token.value, token.start.line, token.end.line])).toEqual([
			["#", 0, 0],
			["define", 0, 0],
			["VALUE", 0, 0],
			["(", 0, 0],
			["x", 0, 0],
			[")", 0, 0],
			["+", 1, 1],
			["(", 1, 1],
			["x", 1, 1],
			[")", 1, 1],
			["int", 2, 2],
			["abcd", 2, 3],
			["=", 3, 3],
			["12", 3, 4],
			[";", 4, 4],
		]);
		expect(
			parseC("splices.c", "#define VALUE(x) \\\n+(x)\nint ab\\\ncd;\n").declarations.map((d) => d.name),
		).toEqual(["VALUE", "abcd"]);

		// An encoding prefix joins its literal across a splice.
		const wide = parseC("wide.c", 'void f(void) { (void)L\\\n"wide"; }\n');
		expect(wide.references.map((reference) => reference.name)).toEqual([]);
		expect(
			lexC("wide.c", 'x = L\\\n"wide";\n').tokens.map((token) => [
				token.kind,
				token.value,
				token.start.character,
			]),
		).toEqual([
			["identifier", "x", 0],
			["symbol", "=", 2],
			["string", "wide", 4],
			["symbol", ";", 6],
			["newline", "\n", 7],
		]);
		const joined = lexC("joined.c", "p-\\\n>f && a &\\\n& b; /* x *\\\n/ c; /\\\n* d */ e;\n").tokens;
		expect(joined.filter((token) => token.kind === "comment")).toHaveLength(2);
		expect(joined.filter((token) => token.kind !== "comment").map((token) => token.value)).toEqual([
			"p",
			"->",
			"f",
			"&&",
			"a",
			"&&",
			"b",
			";",
			"c",
			";",
			"e",
			";",
			"\n",
		]);
		// A comment is a space, so only a splice leaves the `(` touching the name.
		const directives = parseC(
			"directives.c",
			"#define F\\\n(x) x\n#include <fo\\\no.h>\n#define G /*gap*/ (x)\n#define H/*gap*/(x)\n#define I \\\n(x)\n",
		);
		expect(directives.declarations.map((declaration) => [declaration.name, declaration.kind])).toEqual([
			["F", "function"],
			["G", "constant"],
			["H", "constant"],
			["I", "constant"],
		]);
		expect(directives.imports.map((imported) => imported.specifier)).toEqual(["foo.h"]);
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

describe("C reads comments and strings as content, never as syntax", () => {
	// Each pair differs ONLY inside a comment or a string literal, so extraction must not move.
	const pairs: Array<[string, string, string]> = [
		["a storage word in a comment", "int /*x*/ y;", "int /*const*/ y;"],
		["a linkage word in a comment", "int /*x*/ g(void) { }", "int /*static*/ g(void) { }"],
		["an operator in a comment", "int /*x*/ h(void) { }", "int /*=*/ h(void) { }"],
		["a separator in a comment", "struct S { int /*x*/ y; };", "struct S { int /*;*/ y; };"],
		["a comma in a comment", "int f(int /*x*/ y);", "int f(int /*,*/ y);"],
		[
			"a brace in a string",
			'void f(void) { const char *s = "x"; int y; }',
			'void f(void) { const char *s = "{"; int y; }',
		],
		["a closing brace in a string", 'void f(void) { "x"; int y; }', 'void f(void) { "}"; int y; }'],
		["a conditional in a comment", "int f(void) { /*x*/ return 0; }", "int f(void) { /*?*/ return 0; }"],
		[
			"a brace in a string, counted as nesting",
			'void f(void) { const char *s = "x"; }',
			'void f(void) { const char *s = "{"; }',
		],
	];

	function shape(text: string): string {
		return parseC("probe.c", `${text}\n`)
			.declarations.map((declaration) =>
				[
					declaration.kind,
					declaration.name,
					declaration.exported,
					declaration.visibility,
					declaration.metrics?.parameters,
					declaration.metrics?.branches,
					declaration.metrics?.nesting,
				].join("|"),
			)
			.join("\n");
	}

	test.each(pairs)("%s changes nothing", (_label, control, mutated) => {
		expect(shape(mutated)).toBe(shape(control));
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

	test("reports visibility, export state, and function metrics", () => {
		const parsed = parseC("model.c", modelText);
		const packet = parsed.declarations.find((declaration) => declaration.name === "Packet");
		const hidden = parsed.declarations.find((declaration) => declaration.name === "hidden");
		const global = parsed.declarations.find((declaration) => declaration.name === "global");
		const add = parsed.declarations.find((declaration) => declaration.name === "add");
		const value = parsed.declarations.find((declaration) => declaration.name === "value");
		const local = parsed.declarations.find((declaration) => declaration.name === "local");

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

	test("reads attribute and type operator arguments as arguments, never declarators", () => {
		const parsed = parseC(
			"arguments.c",
			[
				'int __attribute__((section("x"))) t;',
				'int __declspec(allocate("x")) u;',
				"int * __attribute__((aligned(8))) p;",
				"int __attribute__((cleanup(release))) *z, w;",
				"int n;",
				"typeof(n) m;",
				"__typeof__(n) k;",
				'int __attribute__((section("y"))) g(void) { typeof(n) local = n; return local; }',
			].join("\n"),
		);

		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.declarations.map((declaration) => `${declaration.kind} ${declaration.name}`)).toEqual([
			"variable t",
			"variable u",
			"variable p",
			"variable z",
			"variable w",
			"variable n",
			"variable m",
			"variable k",
			"function g",
			"variable local",
		]);
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
			started(),
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

	test("keeps unnamed parameters out of the declaration list", () => {
		const parsed = parseC("parameters.c", "int callback(int, const char *name, void *);\n");
		const parameters = parsed.declarations.filter((declaration) => declaration.languageKind === "parameter");

		expect(parameters.map((parameter) => parameter.name)).toEqual(["name"]);
		expect(parsed.declarations.find((declaration) => declaration.name === "callback")?.metrics?.parameters).toBe(3);
	});

	/** Each declaration as `kind name`, parameters marked. */
	function kinds(text: string): string[] {
		return parseC("kinds.c", text).declarations.map(
			(declaration) =>
				`${declaration.languageKind === "parameter" ? "parameter" : declaration.kind} ${declaration.name}`,
		);
	}

	test("declares every declarator on its own, each function with its own signature", () => {
		const text = "int *p, *q;\nint f(), g(void);\nint x, h(int), *k(void);\n";
		const parsed = parseC("declarators.c", text);

		expect(
			parsed.declarations.map((declaration) => [declaration.kind, declaration.name, declaration.signature]),
		).toEqual([
			["variable", "p", "int *p"],
			["variable", "q", "int *q"],
			["function", "f", "int f()"],
			["function", "g", "int g(void)"],
			["variable", "x", "int x"],
			["function", "h", "int h(int)"],
			["function", "k", "int *k(void)"],
		]);
		expect(parsed.declarations.find((declaration) => declaration.name === "k")?.selectionRange).toEqual(
			rangeAt(text, "k", text.indexOf("*k")),
		);
	});

	test("reads a function returning a struct, union or enum as a function", () => {
		const text = [
			"struct point make_point(int x);",
			"struct point *find(void) { return 0; }",
			"union value pick(void);",
			"enum color paint(int shade) { return shade; }",
			"struct point { int x; } origin(void);",
			"static struct tag { int a; } v;",
		].join("\n");
		const parsed = parseC("returns.c", text);

		expect(kinds(text)).toEqual([
			"function make_point",
			"parameter x",
			"function find",
			"function pick",
			"function paint",
			"parameter shade",
			"struct point",
			"function origin",
			"field x",
			"struct tag",
			"variable v",
			"field a",
		]);
		expect(parsed.declarations.find((declaration) => declaration.name === "find")?.signature).toBe(
			"struct point *find(void)",
		);
		expect(parsed.declarations.find((declaration) => declaration.name === "v")?.visibility).toBe("fileLocal");
	});

	test("names the declarator past const and macro types, calling conventions, attributes and pointer groupings", () => {
		expect(
			kinds(
				[
					"const my_t cx;",
					"UV_EXTERN uv_thread_t uv_thread_self(void);",
					"PRIVATE_FIELDS UV_EXTERN int uv_shutdown(int req);",
					"typedef BOOL (PASCAL *LPFN_ACCEPT)(SOCKET s);",
					"typedef NTSTATUS (NTAPI *sRtlGetVersion)(void *info);",
					"my_t (*fp)(void);",
					"my_t (*bare);",
					"typedef int fn_t(int);",
					"int take(const buf_t *buf, void *ptr, void (*cb)(int code));",
					"DECLSPEC(dllexport) int exported;",
					"API() __attribute__((used)) int kept;",
					"[[deprecated]] int old;",
					"void run(void) { [[maybe_unused]] int unused; free(*slot); }",
				].join("\n"),
			),
		).toEqual([
			"constant cx",
			"function uv_thread_self",
			"function uv_shutdown",
			"parameter req",
			"class LPFN_ACCEPT",
			"class sRtlGetVersion",
			"variable fp",
			"variable bare",
			"class fn_t",
			"function take",
			"parameter buf",
			"parameter ptr",
			"parameter cb",
			"variable exported",
			"variable kept",
			"variable old",
			"function run",
			"variable unused",
		]);
	});

	test("gives an anonymous body's owner only its braces, and a block's enumerators local visibility", () => {
		const parsed = parseC(
			"owners.c",
			"struct { int values[3]; } item = { .values = { 4 } };\nvoid f(void) { enum E { X }; }\n",
		);
		const item = parsed.declarations.find((declaration) => declaration.name === "item")?.symbolId;

		expect(parsed.literals.map((literal) => [literal.value, literal.containerId])).toEqual([
			["3", item],
			["4", undefined],
		]);
		expect(parsed.declarations.find((declaration) => declaration.name === "X")?.visibility).toBe("local");
	});

	test("keeps aggregate-typed members as fields, and nests an anonymous body under what declares it", () => {
		const text = [
			"struct outer {",
			"\tstruct node *left;",
			"\tunion { int a; long b; } u;",
			"\tunion { int c; };",
			"\tenum { E1 };",
			"};",
			"enum { TOP = 1 };",
			"struct { int y; } g;",
			"void run(void) { enum { LOCAL }; }",
			"typedef struct { int value; } Item, *PItem;",
		].join("\n");
		const parsed = parseC("members.c", text);
		const path = (name: string) => {
			const declaration = parsed.declarations.find((candidate) => candidate.name === name);
			return `${declaration?.kind} ${declaration?.symbolId.split(" ").at(-1)}`;
		};

		expect(["left", "u", "a", "b", "c", "E1", "TOP", "g", "y", "LOCAL", "value"].map(path)).toEqual([
			"field outer#left.",
			"field outer#u.",
			"field outer#u.a.",
			"field outer#u.b.",
			"field outer#c.",
			"constant outer#E1.",
			"constant TOP.",
			"variable g.",
			"field g.y.",
			"constant run().LOCAL.",
			"field Item#value.",
		]);
		expect(parsed.declarations.find((declaration) => declaration.name === "left")?.visibility).toBe("public");
	});

	test("reads an object as constant when it is const itself, not what it points to", () => {
		const parsed = parseC(
			"constness.c",
			[
				"const int a = 1;",
				"const char *s;",
				"char *const t = 0;",
				"const char *const u = 0;",
				"struct point const cp;",
				"const int list[2], *each;",
				"int (*const fp)(void) = 0;",
			].join("\n"),
		);

		expect(parsed.declarations.map((declaration) => `${declaration.kind} ${declaration.name}`)).toEqual([
			"constant a",
			"variable s",
			"constant t",
			"constant u",
			"constant cp",
			"constant list",
			"variable each",
			"constant fp",
		]);
	});

	test("reads old-style definitions, and macros that wrap or stand beside declarations", () => {
		const text = [
			"int old(a, b)",
			"int a;",
			"char *b;",
			"{ return a; }",
			"WRAP(void wrapped(struct heap *heap));",
			"WRAP(void wrapped(struct heap *heap)) { heap = 0; }",
			"STATIC_ASSERT(sizeof(int) == 4);",
			"RB_GENERATE(tree, node, entry, compare)",
			"static void after(int v);",
			"TEST_IMPL(ping) { return 0; }",
		].join("\n");
		const parsed = facts(started(), "macros.c", text);
		const old = parsed.declarations.find((declaration) => declaration.name === "old");
		const parameterA = parsed.declarations.find((declaration) => declaration.name === "a");

		expect(kinds(text)).toEqual([
			"function old",
			"parameter a",
			"parameter b",
			"function wrapped",
			"parameter heap",
			"function after",
			"parameter v",
			"function TEST_IMPL",
		]);
		expect(old?.signature).toBe("int old(a, b)");
		expect(old?.metrics?.branches).toBe(1);
		expect(parsed.references.find((reference) => reference.name === "a")?.binding).toMatchObject({
			status: "bound",
			symbolId: parameterA?.symbolId,
		});
		expect(
			parsed.references
				.filter((reference) => reference.name === "STATIC_ASSERT")
				.map((reference) => reference.role),
		).toEqual(["call"]);
	});

	test("ends a compound statement at its brace, so what follows it is read, and a for header once", () => {
		const text = [
			"void run(int a) {",
			"\tif (a) { int inside; }",
			"\tint after = 1;",
			"\tfor (int i = 0; i < 2; i++) { int loop = i; }",
			"\t{ int block; }",
			"\tswitch (a) { case 1: { int chosen; } }",
			"\tdo { int body; } while (a);",
			"\tint last;",
			"}",
		].join("\n");

		expect(kinds(text).filter((kind) => kind.startsWith("variable"))).toEqual([
			"variable inside",
			"variable after",
			"variable i",
			"variable loop",
			"variable block",
			"variable chosen",
			"variable body",
			"variable last",
		]);
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
			qualified: true,
		});
		expect(parsed.references.find((reference) => reference.name === "::global")).toMatchObject({
			name: "::global",
			role: "write",
			qualified: true,
		});
		expect(parsed.references.find((reference) => reference.name === "owner::nested::leaf")).toMatchObject({
			name: "owner::nested::leaf",
			role: "read",
			qualified: true,
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

	test("reads a dotted type name as one name, its body and its uses whole", () => {
		const text = [
			"typedef union anon_union.conflict14 anon_union.conflict14, *Panon_union.conflict14;",
			"union anon_union.conflict14 {",
			"    enum anon_enum_8.conflict2 band;",
			"    int raw;",
			"};",
			"enum anon_enum_8.conflict2 { BAND_2G=0, BAND_5G=1 };",
			"void run(void) { anon_union.conflict14 local; local.raw = BAND_5G; }",
		].join("\n");
		const parsed = facts(started(), "dotted.c", text);
		const union = parsed.declarations.find(
			(declaration) => declaration.name === "anon_union.conflict14" && declaration.kind === "struct",
		);

		expect(parsed.declarations.map((declaration) => `${declaration.kind} ${declaration.name}`)).toEqual([
			"class anon_union.conflict14",
			"class Panon_union.conflict14",
			"struct anon_union.conflict14",
			"field band",
			"field raw",
			"enum anon_enum_8.conflict2",
			"constant BAND_2G",
			"constant BAND_5G",
			"function run",
			"variable local",
		]);
		expect(union?.selectionRange).toEqual(rangeAt(text, "anon_union.conflict14", text.indexOf("\nunion")));
		expect(
			parsed.references
				.filter((reference) => reference.role === "typeUse")
				.map((reference) => [reference.name, reference.binding.status]),
		).toEqual([
			["anon_union.conflict14", "bound"],
			["anon_enum_8.conflict2", "bound"],
			["anon_union.conflict14", "bound"],
		]);
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
		const lexed = lexC("warning-suffix.c", text, "ghidra");
		const parsed = parseC("warning-suffix.c", text);

		expect(parsed.diagnostics).toEqual([]);
		expect(
			lexed.tokens
				.filter((token) => token.start.line === 2 && token.kind === "symbol")
				.map((token) => token.value),
		).toEqual([")", ")", ";"]);
	});

	test("reads the warning as a comment wherever the file is valid C", () => {
		const text = [
			"int f(int a, // WARNING: Load size is inaccurate) see",
			"\tint b) {",
			"\ttotal = a; // WARNING: Load size is inaccurate, see total",
			"\treturn b;",
			"}",
		].join("\n");
		const parsed = parseC("valid-warning.c", text);
		const codeOnCommentLines = lexC("valid-warning.c", text).tokens.filter(
			(token) =>
				[0, 2].includes(token.start.line) &&
				token.start.character > 20 &&
				token.kind !== "comment" &&
				token.kind !== "newline",
		);

		expect(parsed.diagnostics).toEqual([]);
		expect(codeOnCommentLines).toEqual([]);
		expect(
			parsed.declarations
				.filter((declaration) => declaration.languageKind === "parameter")
				.map((parameter) => parameter.name),
		).toEqual(["a", "b"]);
		expect(parsed.declarations.some((declaration) => declaration.name === "see")).toBe(false);
		expect(parsed.references.map((reference) => `${reference.name}:${reference.role}`)).toEqual([
			"total:write",
			"a:read",
			"b:read",
		]);
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
		const handlers = started();
		const text = "#if FEATURE\nint value;\n#else\nint value;\n#endif\nint run(void) { return value; }\n";
		const parsed = facts(handlers, "conditional.c", text);
		const values = parsed.declarations.filter((declaration) => declaration.name === "value");
		const reference = parsed.references.find((candidate) => candidate.name === "value");

		expect(values).toHaveLength(2);
		expect(new Set(values.map((declaration) => declaration.symbolId)).size).toBe(2);
		expect(reference?.binding).toMatchObject({
			status: "ambiguous",
			detail: "conditional compilation supplies both declarations",
		});
	});

	test("never takes a directive line's words for a declarator's name", () => {
		const text = [
			"unsigned",
			"#ifdef WIDE",
			"long",
			"#else",
			"int",
			"#endif",
			"width;",
			"struct shape {",
			"#if defined(HAVE_X)",
			"\tint x;",
			"#endif",
			"\tint y;",
			"};",
			"enum mode {",
			"#define MODE(name) MODE_##name",
			"#ifdef FAST",
			"\tMODE_FAST,",
			"#endif",
			"\tMODE_SLOW",
			"};",
			"int take(",
			"#ifdef WIDE",
			"\tlong value",
			"#else",
			"\tint value",
			"#endif",
			");",
		].join("\n");
		const parsed = parseC("directives.c", text);
		const declared = (name: string) => parsed.declarations.find((declaration) => declaration.name === name);

		expect(
			parsed.declarations.filter((declaration) => declaration.languageKind !== "macro").map((d) => d.name),
		).toEqual(["width", "shape", "x", "y", "mode", "MODE_FAST", "MODE_SLOW", "take", "value"]);
		expect(declared("width")?.signature).toBe("unsigned long int width");
		expect(declared("x")?.range).toEqual(rangeAt(text, "int x;"));
		expect(declared("MODE_SLOW")?.range).toEqual(rangeAt(text, "MODE_SLOW"));
	});

	test("does not expand macro bodies into references", () => {
		const parsed = parseC("macros.c", "#define CALL(name) name()\nint run(void) { return 1; }\n");

		expect(parsed.declarations.find((declaration) => declaration.name === "CALL")?.kind).toBe("function");
		expect(parsed.references.some((reference) => reference.name === "name")).toBe(false);
		expect(parsed.literals.some((literal) => literal.value === "1")).toBe(true);
	});

	test("turns an unfinished initializer into an error without throwing", () => {
		const parsed = facts(started(), "broken.c", "#if ENABLED\nint value = ;\n#endif\n");

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
		const handlers = started();
		const text = [
			"const int limit = 3;",
			"bool enabled = true;",
			'const char *label = "hi\\nthere";',
			"int letter = 'A';",
			"int run(void) { double ratio = 2.5; return enabled; }",
		].join("\n");
		const parsed = facts(handlers, "literals.c", text);

		expect(parsed.literals.map((literal) => [literal.kind, literal.value, literal.number])).toEqual([
			["number", "3", 3],
			["boolean", "true", undefined],
			["string", "hi\nthere", undefined],
			["number", "'A'", 65],
			["number", "2.5", 2.5],
		]);
	});

	test("preserves all-f hex integers and omits unsafe numeric values", () => {
		const handlers = started();
		const text = [
			"unsigned first = 0xff;",
			"unsigned second = 0xffff;",
			"unsigned third = 0xffffffff;",
			"unsigned fourth = 0xFFFFFFFFu;",
			"unsigned wide = 0xffffffffffffffff;",
			"unsigned decimal = 4294967295;",
		].join("\n");
		const parsed = facts(handlers, "integer-masks.c", text);
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
		const handlers = started();
		const text =
			"int add(int value) { return value; }\nint run(void) { int local = 1; local += add(local); return local; }\n";
		const parsed = facts(handlers, "references.c", text);
		const localReferences = parsed.references.filter((reference) => reference.name === "local");

		expect(parsed.references.find((reference) => reference.name === "add")?.role).toBe("call");
		expect(localReferences.some((reference) => reference.role === "read")).toBe(true);
		expect(localReferences.some((reference) => reference.role === "write")).toBe(true);
		expect(localReferences.filter((reference) => reference.role === "read")).toHaveLength(3);
	});

	test("qualifies member names and designators, never their receivers", () => {
		const handlers = started();
		const text = [
			'#include "item.h"',
			"struct Item { int count; void (*run)(void); };",
			"int total(struct Item item, struct Item *ptr) {",
			"  struct Item made = { .count = 1 };",
			"  item.count = ptr->count;",
			"  ptr->run();",
			"  return item. /* gap */ count + made.count;",
			"}",
		].join("\n");
		const parsed = facts(handlers, "members.c", text);
		const marked = (name: string) =>
			parsed.references
				.filter((reference) => reference.name === name)
				.map((reference) => [reference.role, reference.qualified]);

		expect(marked("count")).toEqual([
			["write", true],
			["write", true],
			["read", true],
			["read", true],
			["read", true],
		]);
		expect(marked("run")).toEqual([["call", true]]);
		expect(marked("item")).toEqual([
			["read", false],
			["read", false],
		]);
		expect(marked("ptr")).toEqual([
			["read", false],
			["read", false],
		]);
		expect(marked("Item").every(([, qualified]) => qualified === false)).toBe(true);
		expect(marked("item.h")).toEqual([["import", false]]);
		expect(parsed.references.every((reference) => typeof reference.qualified === "boolean")).toBe(true);
	});

	test("does not qualify a name after a directive's trailing member operator", () => {
		const parsed = parseC("directive-member.c", "void run(void) {\n#define TAIL ptr->\nfield = 1;\n}\n");

		expect(parsed.references.filter((reference) => reference.name === "field")).toMatchObject([
			{ role: "write", qualified: false },
		]);
	});

	test("marks struct and typedef names as type uses", () => {
		const parsed = parseC(
			"type-uses.c",
			"struct Item { int field; };\ntypedef int Count;\nstruct Item *item;\nCount count;\n",
		);
		const uses = parsed.references.filter((reference) => reference.role === "typeUse");

		expect(uses.map((reference) => reference.name)).toEqual(["Item", "Count"]);
	});

	/** Each reference as `role name`. */
	function roles(text: string): string[] {
		return parseC("roles.c", text).references.map((reference) => `${reference.role} ${reference.name}`);
	}

	test("reads nothing in an attribute, and a typeof operand as the expression or type it is", () => {
		expect(
			roles(
				[
					"int unused;",
					"typedef int T;",
					"static int v __attribute__((unused, aligned(8)));",
					'__attribute__((section("x"), unused)) int w;',
					"[[deprecated]] int old;",
					"typeof(unused) a;",
					"__typeof__(unused + 1) b;",
					"typeof(T) c;",
					"typeof(T *) d;",
					"_Alignas(T) char e;",
				].join("\n"),
			),
		).toEqual(["read unused", "read unused", "typeUse T", "typeUse T", "typeUse T"]);
	});

	test("reads casts and tags as type uses, case labels as reads, and jumps as nothing", () => {
		expect(
			roles(
				[
					"typedef int T;",
					"void run(void *p, int s) {",
					"\tT *a = (T *)p;",
					"\tint n = (int)sizeof(struct point) + (s);",
					"\tswitch (s) { case LIMIT: goto done; default: break; }",
					"\tn = s ? a->x : n;",
					"done:",
					"\treturn;",
					"}",
				].join("\n"),
			),
		).toEqual([
			"typeUse T",
			"typeUse T",
			"read p",
			"typeUse point",
			"read s",
			"read s",
			"read LIMIT",
			"write n",
			"read s",
			"read a",
			"read x",
			"read n",
		]);
	});
});

describe("C binding and imports", () => {
	test("binds a local reference to its declaration rather than its name", () => {
		const handlers = started();
		const text =
			"int add(int value) { return value; }\nint run(void) { int value = 1; return value + add(value); }\n";
		const parsed = facts(handlers, "bind.c", text);
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
		const handlers = started();
		const text =
			"struct Item { int value; };\nint add(void) { return 1; }\nint run(void) { struct Item item; return add(); }\n";
		const parsed = facts(handlers, "same-file.c", text);
		const typeReference = parsed.references.find((reference) => reference.name === "Item");
		const callReference = parsed.references.find((reference) => reference.name === "add");

		expect(typeReference?.binding.status).toBe("bound");
		expect(callReference?.binding.status).toBe("bound");
		expect(callReference?.binding.status === "bound" ? callReference.binding.symbolId : "").toContain("add()");
	});

	test("binds a tag after struct to the struct and a bare name to its typedef", () => {
		const parsed = facts(
			started(),
			"namespaces.c",
			"typedef struct node node;\nstruct node { node *next; };\nstruct node *head;\n",
		);
		const declared = (kind: string) =>
			parsed.declarations.find((declaration) => declaration.name === "node" && declaration.kind === kind)
				?.symbolId ?? "missing";
		const targets = parsed.references
			.filter((reference) => reference.name === "node")
			.map((reference) =>
				reference.binding.status === "bound" ? reference.binding.symbolId : reference.binding.status,
			);

		expect(targets).toEqual([declared("struct"), declared("class"), declared("struct")]);
	});

	test("looks a type up through the scopes around its use, a nearer object hiding a typedef", () => {
		const text = [
			"typedef int T;",
			"struct Node { int file; };",
			"void run(void) {",
			"\tstruct Node { int value; };",
			"\tstruct Node *p;",
			"\tint T;",
			"\ttypeof(T) shadowed;",
			"}",
			"typeof(T) outer;",
			"int count;",
			"int use(void) { int T; int x; T * x; return count; int count; }",
			"typedef struct S { int field; } Pair;",
			"void inner(void) { typedef Pair Pair; Pair made; made.field; }",
		].join("\n");
		const handlers = started();
		const parsed = facts(handlers, "scopes.c", text);
		const id = (name: string, container?: string) =>
			parsed.declarations.find(
				(declaration) =>
					declaration.name === name &&
					(container === undefined || declaration.containerId?.endsWith(container)),
			)?.symbolId;
		const at = (line: number, name: string) => {
			const reference = parsed.references.find(
				(candidate) => candidate.name === name && candidate.range.start.line === line,
			);
			return [reference?.role, reference?.binding.status === "bound" ? reference.binding.symbolId : undefined];
		};

		expect(at(4, "Node")).toEqual(["typeUse", id("Node", "run().")]);
		expect(at(6, "T")).toEqual(["read", id("T", "run().")]);
		expect(at(8, "T")).toEqual(["typeUse", id("T")]);
		// An object in scope makes `T * x;` a product; a later local does not hide the global yet.
		expect([at(10, "T"), at(10, "count")]).toEqual([
			["read", id("T", "use().")],
			["read", id("count")],
		]);
		expect(parsed.declarations.filter((declaration) => declaration.name === "x")).toHaveLength(1);
		// `typedef Pair Pair;` reads its specifier outside itself.
		const inner = handlers.typeOf({ symbolId: id("Pair", "inner().") ?? "missing" });
		expect([at(12, "Pair"), at(12, "field"), inner.status === "known" ? inner.symbolId : undefined]).toEqual([
			["typeUse", id("Pair")],
			["read", id("field", "S#")],
			id("Pair"),
		]);
	});

	test("puts a block's name in scope from its declarator to the block's end, the innermost block first", () => {
		const text = [
			"int x;",
			"struct S { int x; } y = { x };",
			"enum E { A } e = A;",
			"int p;",
			"void f(void) { int p[sizeof p]; struct T; struct T *t; struct T { int a; }; t->a; }",
			"int g(void) { int x = 0; { int x = 1; x++; } for (int x = 2; x; x--) { x; } return x; }",
			"void h(void) { struct U { int outer; }; { struct U; struct U *p; } struct V *v; struct V { int b; }; v->b; }",
			"struct S2 { struct N { int n; } n; enum { M } m; }; struct N *nested; int use(void) { return M; }",
		].join("\n");
		const parsed = facts(started(), "blocks.c", text);
		const bound = (line: number, name: string) =>
			parsed.references
				.filter(
					(reference) =>
						reference.range.start.line === line && reference.name === name && reference.role !== "write",
				)
				.map(({ binding }) =>
					binding.status === "bound" ? binding.symbolId.replace("lexicon c blocks.c ", "") : "none",
				);

		// An initializer is outside the struct's body; an enumerator is a name of the enum's own scope.
		expect([...bound(1, "x"), ...bound(2, "A")]).toEqual(["x.", "E#A."]);
		// A declarator's bound reads the outer name; a forward tag is in scope before its definition.
		expect([...bound(4, "p"), ...bound(4, "T"), ...bound(4, "a")]).toEqual(["p.", "f().T#", "f().T#a."]);
		expect(bound(5, "x")).toEqual(["g().`x#1`.", "g().`x#2`.", "g().`x#2`.", "g().`x#2`.", "g().x."]);
		// An inner block's forward tag is a new tag; an undeclared `struct V *` is completed by the later V.
		expect([...bound(6, "U"), ...bound(6, "V"), ...bound(6, "b")]).toEqual(["h().`U#1`#", "h().V#", "h().V#b."]);
		// A tag or an enumerator in a struct's body belongs to the file around it.
		expect([...bound(7, "N"), ...bound(7, "M")]).toEqual(["S2#N#", "S2#M."]);
	});

	test("binds a member only to a field of its receiver's type, through typedefs and chains", () => {
		const text = [
			"#include <sys/stat.h>",
			"int x;",
			"struct heap { int x; struct heap *next; };",
			"typedef struct heap heap_t;",
			"typedef struct { int y; } anon_t;",
			"struct heap make(void);",
			"void run(struct heap *heap, heap_t *h, anon_t a, struct stat *st) {",
			"\theap->x = x;",
			"\th->next->x = a.y;",
			"\t(*heap).x = st->st_size;",
			"\t(h->next)->x = heap[1].x + make().x;",
			"\tstruct heap made = { .x = 1 };",
			"\tstruct { int y; } first, second;",
			"\tsecond.y = 0;",
			"}",
		].join("\n");
		const parsed = facts(started(), "members.c", text);
		const declared = (name: string, kind: string) =>
			parsed.declarations.find((declaration) => declaration.name === name && declaration.kind === kind)
				?.symbolId ?? "missing";
		const field = (name: string) => declared(name, "field");
		const bindings = parsed.references
			.filter(
				(reference) =>
					["x", "next", "y", "st_size"].includes(reference.name) && reference.range.start.line >= 7,
			)
			.map(({ binding }) =>
				binding.status === "bound"
					? binding.symbolId
					: binding.status === "unbound"
						? binding.reason
						: "ambiguous",
			);

		expect(bindings).toEqual([
			field("x"),
			declared("x", "variable"),
			field("next"),
			field("x"),
			field("y"),
			field("x"),
			"ExternalDependency",
			field("next"),
			field("x"),
			field("x"),
			"NotImplemented",
			"NotImplemented",
			parsed.declarations.find(
				(declaration) => declaration.name === "y" && declaration.containerId === declared("first", "variable"),
			)?.symbolId ?? "missing",
		]);
	});

	test("resolves quoted includes beside a file and at workspace root", () => {
		const root = workspace({
			"src/cart.c": '#include "item.h"\n#include "root.h"\n',
			"src/item.h": "int item;\n",
			"root.h": "int root;\n",
		});
		const handlers = started(root);
		const text = readFileSync(path.join(root, "src/cart.c"), "utf8");

		facts(handlers, "src/cart.c", text);

		expect(handlers.resolveImport({ fromModule: "src/cart.c", specifier: "item.h" })).toEqual(landed("src/item.h"));
		expect(handlers.resolveImport({ fromModule: "src/cart.c", specifier: "root.h" })).toEqual(landed("root.h"));
	});

	test("reports each include as one injection of all its header declares, spanning its directive", () => {
		const handlers = started();
		const text = '#include "a.h"\n#  include <sys/b.h> // why\n#include "a.h"\n#include <open.h\n';
		const parsed = handlers.parseFile({ module: "src/use.c", contentHash: "edges", text });
		const edge = {
			kind: "injection",
			selector: { kind: "visible" },
			bindsLocally: true,
			conflict: { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" },
			certainty: { status: "known" },
		} as const;

		expect(FileFactsSchema.safeParse(parsed).success).toBe(true);
		expect(parsed.imports).toEqual([
			{ specifier: "a.h", edges: [{ ...edge, span: rangeAt(text, '#include "a.h"'), order: 0 }] },
			{ specifier: "sys/b.h", edges: [{ ...edge, span: rangeAt(text, "#  include <sys/b.h>"), order: 1 }] },
			{ specifier: "a.h", edges: [{ ...edge, span: rangeAt(text, '#include "a.h"', 20), order: 2 }] },
			{ specifier: "open.h", edges: [{ ...edge, span: rangeAt(text, "#include <open.h"), order: 3 }] },
		]);
	});

	test("marks angle includes external and missing quoted includes unresolved", () => {
		const handlers = started();
		const text = '#include <stdio.h>\n#include "missing.h"\n';
		const parsed = facts(handlers, "imports.c", text);

		expect(handlers.resolveImport({ fromModule: "imports.c", specifier: "<stdio.h>" })).toEqual({
			status: "external",
			packageName: "stdio.h",
		});
		expect(handlers.resolveImport({ fromModule: "imports.c", specifier: "missing.h" })).toMatchObject({
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

	test("binds a name a macro of its file also spells to the macro, unless the macro is in another branch", () => {
		const header = [
			"#define MAP(XX) XX(one) XX(two)",
			"typedef enum {",
			"  OPT_A,",
			"  OPT_B",
			"#define OPT_B OPT_B",
			"#define XX(name) KIND_##name,",
			"  MAP(XX)",
			"#undef XX",
			"} opt_t;",
			"#ifdef WIDE",
			"#define OPT_C 3",
			"#else",
			"enum { OPT_C };",
			"#endif",
			"int in_header(void) { return OPT_B + MAP(XX) + OPT_C; }",
		].join("\n");
		const root = workspace({
			"opt.h": header,
			"use.c": '#include "opt.h"\nint use(void) { return OPT_B + MAP(XX) + OPT_C; }\n',
		});
		const handlers = started(root);
		const bindings = (module: string, text: string) =>
			facts(handlers, module, text)
				.references.filter(
					(reference) =>
						["OPT_B", "MAP", "OPT_C"].includes(reference.name) &&
						/ (in_header|use)\(\)\.$/.test(reference.fromId ?? ""),
				)
				.map(({ binding }) =>
					binding.status === "bound" ? binding.symbolId.split(" ").at(-1) : `${binding.status}`,
				);
		const expected = ["OPT_B.", "MAP().", "ambiguous"];

		expect(bindings("opt.h", header)).toEqual(expected);
		expect(bindings("use.c", readFileSync(path.join(root, "use.c"), "utf8"))).toEqual(expected);
	});

	test("sees an enumerator of an enum nested in a struct from the file around it, here and through an include", () => {
		const header = [
			"struct S { enum E {",
			"#if FEATURE",
			"  READY,",
			"#else",
			"  READY,",
			"#endif",
			"} state; };",
			"int in_header(void) { return READY; }",
		].join("\n");
		const root = workspace({ "scope.h": header, "use.c": '#include "scope.h"\nint use(void) { return READY; }\n' });
		const handlers = started(root);
		const candidates = (module: string, text: string) => {
			const binding = facts(handlers, module, text).references.find(
				(reference) => reference.name === "READY",
			)?.binding;
			return binding?.status === "ambiguous" ? binding.candidates.length : binding?.status;
		};

		// The two exclusive alternatives, in the header and in its includer alike.
		expect([
			candidates("scope.h", header),
			candidates("use.c", readFileSync(path.join(root, "use.c"), "utf8")),
		]).toEqual([2, 2]);
	});

	test("searches the includer's directory, then include directories and the root, and sees every header reached", () => {
		const root = workspace({
			"include/lib.h": '#include "lib/detail.h"\ntypedef struct box { int size; } box_t;\n',
			"include/lib/detail.h": '#include "../lib.h"\nint detail_count;\n',
			"include/config.h": "#define SHARED_ONLY 2\n",
			"src/config.h": "#define LOCAL_ONLY 1\n",
			"hidden.h": "int hidden;\n",
			"src/main.c": [
				'#include "lib.h"',
				'#include "config.h"',
				"#include <config.h>",
				"int run(box_t *b) { return b->size + detail_count + LOCAL_ONLY + SHARED_ONLY + hidden; }",
			].join("\n"),
		});
		const handlers = started(root);
		const parsed = facts(handlers, "src/main.c", readFileSync(path.join(root, "src/main.c"), "utf8"));
		const home = (name: string) => {
			const binding = parsed.references.find(
				(reference) => reference.name === name && reference.role !== "import",
			)?.binding;
			return binding?.status === "bound" ? parseSymbolId(binding.symbolId)?.module : binding?.status;
		};
		const resolve = (specifier: string) => handlers.resolveImport({ fromModule: "src/main.c", specifier });

		expect(["lib.h", '"config.h"', "<config.h>"].map(resolve)).toEqual([
			landed("include/lib.h"),
			landed("src/config.h"),
			landed("include/config.h"),
		]);
		// Through lib.h to detail.h, whose include of lib.h again ends the walk; hidden.h is never reached.
		expect(["box_t", "size", "detail_count", "LOCAL_ONLY", "SHARED_ONLY", "hidden"].map(home)).toEqual([
			"include/lib.h",
			"include/lib.h",
			"include/lib/detail.h",
			"src/config.h",
			"include/config.h",
			"unbound",
		]);
	});

	test("searches a unit's database lists, reads its forced includes first, and moves the fingerprint with them", () => {
		const database = (mode: string, forced: string) =>
			JSON.stringify([
				unitEntry("src/app.c", "-I../vendor/api", "-iquote", "../quoted", `-DMODE=${mode}`, "-include", forced),
			]);
		const text = '#include "api.h"\n#include "q.h"\n#include <q.h>\nint run(void) { return early + late; }\n';
		const root = workspace({
			"build/compile_commands.json": database("1", "early.h"),
			"build/early.h": "int early;\n",
			"quoted/late.h": "int late;\n",
			"vendor/api/api.h": "int api_value;\n",
			"include/api.h": "int api_value;\n",
			"quoted/q.h": "int q_value;\n",
			"src/app.c": text,
		});
		const handlers = started(root);
		const before = facts(handlers, "src/app.c", text);
		const resolve = (specifier: string) => handlers.resolveImport({ fromModule: "src/app.c", specifier });
		const rediscover = (mode: string, forced: string) => {
			writeFileSync(path.join(root, "build/compile_commands.json"), database(mode, forced));
			return handlers.discoverProject({ workspaceRoot: root });
		};
		const first = handlers.discoverProject({ workspaceRoot: root });
		const defined = rediscover("2", "early.h");
		// Not in the working directory, so found along the quoted search.
		const forced = rediscover("2", "late.h");
		const after = facts(handlers, "src/app.c", `${text}\n`);

		// The database's lists replace the conventional ones; an angle include skips `-iquote`.
		expect(["api.h", '"q.h"', "<q.h>"].map(resolve)).toEqual([
			landed("vendor/api/api.h"),
			landed("quoted/q.h"),
			{ status: "external", packageName: "q.h" },
		]);
		expect([
			homeOf(before, "early"),
			homeOf(before, "late"),
			homeOf(after, "early"),
			homeOf(after, "late"),
		]).toEqual(["build/early.h", "unbound", "unbound", "quoted/late.h"]);
		expect(first.configFiles).toContain("build/compile_commands.json");
		// Nothing includes a forced header, so discovery names it for core even inside the excluded build/.
		expect(first.files).toContain("build/early.h");
		expect(new Set([first.fingerprint, defined.fingerprint, forced.fingerprint]).size).toBe(3);
	});

	test("reads a POSIX command's quoted path, and binds only where every configuration of a unit agrees", () => {
		const configured = (...entries: Array<Record<string, unknown>>) =>
			workspace({
				"compile_commands.json": JSON.stringify(entries),
				"vendor api/same.h": "int selected;\n",
				"wrong/same.h": "int selected;\n",
				"cfgA/config.h": "int picked;\n",
				"cfgB/config.h": "int picked;\n",
				"src/use.c": "#include <same.h>\n#include <config.h>\nint run(void) { return selected + picked; }\n",
			});
		const quoted = { directory: ".", file: "src/use.c", command: "cc -I 'vendor api' -I wrong -c src/use.c" };
		const configA = { ...quoted, command: `${quoted.command} -IcfgA` };
		const configB = { ...quoted, command: `${quoted.command} -IcfgB` };
		const read = (root: string) => {
			const parsed = facts(started(root), "src/use.c", readFileSync(path.join(root, "src/use.c"), "utf8"));
			return [homeOf(parsed, "selected"), homeOf(parsed, "picked")];
		};

		expect(read(configured(configA))).toEqual(["vendor api/same.h", "cfgA/config.h"]);
		expect(read(configured(configA, configB))).toEqual(["vendor api/same.h", "unbound"]);
		expect(read(configured(configB, configA))).toEqual(["vendor api/same.h", "unbound"]);
	});

	test("answers a bare include written both ways by what each finds, Ambiguous when they differ", () => {
		const root = workspace({
			"src/x.h": "int near;\n",
			"include/x.h": "int far;\n",
			"src/main.c": '#include "x.h"\n#include <x.h>\n',
		});
		const handlers = started(root);
		facts(handlers, "src/main.c", readFileSync(path.join(root, "src/main.c"), "utf8"));
		const resolve = (specifier: string) => handlers.resolveImport({ fromModule: "src/main.c", specifier });

		expect(["x.h", '"x.h"', "<x.h>"].map(resolve)).toEqual([
			{ status: "unresolved", reason: "Ambiguous", detail: expect.any(String) },
			landed("src/x.h"),
			landed("include/x.h"),
		]);
	});

	test("never probes an include the scope denies, nor walks a denied directory for include directories", () => {
		const root = workspace({
			"secret/include/hidden.h": "int hidden;\n",
			"src/secret.h": "int secret;\n",
			"src/main.c": '#include "secret.h"\n#include <hidden.h>\n',
		});
		const resolveWith = (deny: string[]) => {
			const handlers = handlersFor(new CProvider());
			handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION, deny });
			handlers.discoverProject({ workspaceRoot: root });
			return ['"secret.h"', "<hidden.h>"].map((specifier) =>
				handlers.resolveImport({ fromModule: "src/main.c", specifier }),
			);
		};

		expect(resolveWith([]).map((resolution) => resolution.status)).toEqual(["resolved", "resolved"]);
		expect(resolveWith(["src/secret.h", "secret/**"]).map((resolution) => resolution.status)).toEqual([
			"unresolved",
			"external",
		]);
	});

	test("retries a header that could not be read, and skips a directory that cannot be listed", () => {
		const root = workspace({
			"src/api.h": "int answer;\n",
			"src/use.c": '#include "api.h"\nint run(void) { return answer; }\n',
			"locked/inner/include/nothing.h": "int nothing;\n",
		});
		const header = path.join(root, "src/api.h");
		const locked = path.join(root, "locked");
		chmodSync(header, 0o000);
		chmodSync(locked, 0o000);
		try {
			const handlers = started(root);
			const text = readFileSync(path.join(root, "src/use.c"), "utf8");
			const parsed = facts(handlers, "src/use.c", text);
			const reference = parsed.references.find((candidate) => candidate.name === "answer");
			if (reference === undefined) throw new Error("reference is missing");
			const bind = () => handlers.bind({ module: "src/use.c", name: "answer", range: reference.range }).status;
			const before = bind();
			chmodSync(header, 0o644);

			expect(handlers.discoverProject({ workspaceRoot: root }).files).toContain("src/use.c");
			expect([before, bind()]).toEqual(["unbound", "bound"]);
		} finally {
			chmodSync(header, 0o644);
			chmodSync(locked, 0o755);
		}
	});

	test("reads a header with the lists of the unit that reaches it, and one no unit builds only where every unit agrees", () => {
		const root = workspace({
			"build/compile_commands.json": JSON.stringify([
				unitEntry("src/a.c", "-I../shared", "-I../cfgA"),
				unitEntry("src/b.c", "-I../shared", "-I../cfgB"),
			]),
			"shared/common.h": "#include <config.h>\n",
			"cfgA/config.h": "int selected;\n",
			"cfgB/config.h": "int selected;\n",
			"src/a.c": '#include "common.h"\nint run(void) { return selected; }\n',
			"src/b.c": '#include "common.h"\nint run(void) { return selected; }\n',
		});
		const handlers = started(root);
		const read = (module: string) => facts(handlers, module, readFileSync(path.join(root, module), "utf8"));

		expect([homeOf(read("src/a.c"), "selected"), homeOf(read("src/b.c"), "selected")]).toEqual([
			"cfgA/config.h",
			"cfgB/config.h",
		]);
		expect(handlers.resolveImport({ fromModule: "shared/common.h", specifier: "<config.h>" })).toMatchObject({
			status: "unresolved",
			reason: "Ambiguous",
		});
	});

	test("serves `-I` before `-I-` to quoted includes only, and skips the includer's directory after it", () => {
		const root = workspace({
			"build/compile_commands.json": JSON.stringify([unitEntry("src/c.c", "-I../pre", "-I-", "-I../post")]),
			"pre/a.h": "int a;\n",
			"src/c.h": "int c;\n",
			"post/c.h": "int c;\n",
			"src/c.c": '#include <a.h>\n#include "a.h"\n#include "c.h"\n',
		});
		const handlers = started(root);
		facts(handlers, "src/c.c", readFileSync(path.join(root, "src/c.c"), "utf8"));
		const resolve = (specifier: string) => handlers.resolveImport({ fromModule: "src/c.c", specifier });

		expect(["<a.h>", '"a.h"', '"c.h"'].map(resolve)).toEqual([
			{ status: "external", packageName: "a.h" },
			landed("pre/a.h"),
			landed("post/c.h"),
		]);
	});

	test("looks names up in the headers a file reaches with work linear in their count", () => {
		const work = (count: number) => {
			const headers = Object.fromEntries(
				Array.from({ length: count }, (_, index) => [`h${index}.h`, `int v${index};\n`]),
			);
			const includes = Array.from({ length: count }, (_, index) => `#include "h${index}.h"`).join("\n");
			const uses = Array.from({ length: count }, (_, index) => `v${index} + u${index}`).join(" + ");
			const text = `${includes}\nint run(void) { return ${uses}; }\n`;
			const meter = { steps: 0 };
			const handlers = handlersFor(new CProvider(meter));
			const root = workspace({ ...headers, "main.c": text });
			handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
			handlers.discoverProject({ workspaceRoot: root });
			facts(handlers, "main.c", text);
			meter.steps = 0;
			handlers.parseFile({ module: "main.c", contentHash: "measured", text });
			return meter.steps;
		};
		// Linear reads 8x; a scan of every header per name reads 64x.
		expect(work(1_600) / work(200)).toBeLessThan(12);
	});

	test("finds same-file candidates through the parsed declaration index", () => {
		const parsed = parseC("candidates.c", "int add(void) { return 1; }\nint run(void) { return add(); }\n");
		const reference = parsed.references.find((candidate) => candidate.name === "add");

		if (reference === undefined) throw new Error("call reference is missing");
		expect(bindingCandidates(parsed, reference).map((declaration) => declaration.name)).toEqual(["add"]);
	});

	test("binds by a requested reference range and by a declaration range", () => {
		const handlers = started();
		const text = "int add(void) { return 1; }\nint run(void) { return add(); }\n";
		const parsed = facts(handlers, "bind-range.c", text);
		const reference = parsed.references.find((candidate) => candidate.name === "add");
		const declaration = declarationOf(parsed, "add", "function");

		if (reference === undefined || declaration === undefined) throw new Error("bind range fixture is missing");
		expect(handlers.bind({ module: "bind-range.c", name: "add", range: reference.range })).toMatchObject({
			status: "bound",
			symbolId: declaration.symbolId,
		});
		expect(
			handlers.bind({
				module: "bind-range.c",
				name: "add",
				range: declaration.selectionRange as NonNullable<typeof declaration.selectionRange>,
			}),
		).toMatchObject({
			status: "bound",
			symbolId: declaration.symbolId,
		});
	});
});

describe("C type answers", () => {
	test("returns declared primitive, pointer, alias, and function types", () => {
		const handlers = started();
		const text =
			"typedef unsigned int Count;\nconst int limit = 1;\nCount *counter;\nint run(void) { return limit; }\n";
		const parsed = facts(handlers, "types.c", text);
		const count = declarationOf(parsed, "Count");
		const limit = declarationOf(parsed, "limit");
		const counter = declarationOf(parsed, "counter");
		const run = declarationOf(parsed, "run", "function");

		if (count === undefined || limit === undefined || counter === undefined || run === undefined) {
			throw new Error("type declarations are missing");
		}
		expect(handlers.typeOf({ symbolId: count.symbolId })).toMatchObject({
			status: "known",
			display: "unsigned int",
			provenance: "declared",
		});
		expect(handlers.typeOf({ symbolId: limit.symbolId })).toMatchObject({
			status: "known",
			display: "int",
			provenance: "declared",
		});
		expect(handlers.typeOf({ symbolId: counter.symbolId })).toMatchObject({
			status: "known",
			display: "Count *",
			provenance: "declared",
		});
		expect(handlers.typeOf({ symbolId: run.symbolId })).toMatchObject({
			status: "known",
			display: "int",
			provenance: "declared",
		});
	});

	test("returns the declaration type for a position inside its type range", () => {
		const handlers = started();
		const text = "const unsigned int limit = 1;\n";
		const parsed = facts(handlers, "type-range.c", text);
		const limit = declarationOf(parsed, "limit");

		if (limit === undefined) throw new Error("limit declaration is missing");
		const answer = handlers.typeOf({ module: "type-range.c", range: rangeAt(text, "unsigned int") });

		expect(answer).toMatchObject({ status: "known", display: "unsigned int", provenance: "declared" });
	});

	test("links named aggregate types from type answers", () => {
		const handlers = started();
		const text = "struct Item { int value; };\nstruct Item item;\n";
		const parsed = facts(handlers, "aggregate-type.c", text);
		const item = declarationOf(parsed, "item");

		if (item === undefined) throw new Error("aggregate variable is missing");
		const answer = handlers.typeOf({ symbolId: item.symbolId });

		expect(answer).toMatchObject({ status: "known", display: "struct Item", provenance: "declared" });
		expect(answer.status === "known" ? answer.symbolId : "").toContain("Item#");
	});

	test("links a type answer to the tag or the typedef its type names, not whichever shares the name", () => {
		const handlers = started();
		const parsed = facts(
			handlers,
			"namespaces.c",
			"typedef struct N N;\nstruct N { int value; };\nstruct N *p;\nN *q;\n#ifdef A\ntypedef int C;\n#else\ntypedef long C;\n#endif\nC r;\n",
		);
		const linked = (name: string) => {
			const declaration = declarationOf(parsed, name, name === "N" ? "class" : undefined);
			const answer = declaration === undefined ? undefined : handlers.typeOf({ symbolId: declaration.symbolId });
			return answer?.status === "known" ? (answer.symbolId ?? answer.display) : undefined;
		};

		// Alternatives across branches keep the spelling and name no one of them.
		expect([linked("N"), linked("p"), linked("q"), linked("r")]).toEqual([
			declarationOf(parsed, "N", "struct")?.symbolId,
			declarationOf(parsed, "N", "struct")?.symbolId,
			declarationOf(parsed, "N", "class")?.symbolId,
			"C",
		]);
	});

	test("binds a type spelled through a macro to the macro, here and across an include", () => {
		const root = workspace({ "types.h": "#define code void\n" });
		const handlers = started(root);
		const header = facts(handlers, "types.h", "#define code void\n");
		const parsed = facts(handlers, "use.c", '#include "types.h"\n#define byte unsigned char\nbyte b;\ncode *fn;\n');
		const bound = (name: string) => {
			const binding = parsed.references.find(
				(reference) => reference.name === name && reference.role === "typeUse",
			)?.binding;
			return binding?.status === "bound" ? binding.symbolId : binding?.status;
		};

		expect([bound("byte"), bound("code")]).toEqual([
			declarationOf(parsed, "byte")?.symbolId,
			declarationOf(header, "code")?.symbolId,
		]);
	});

	test("spells a declared type from its tokens, never from its rendered text", () => {
		const handlers = started();
		const text = [
			"_Alignas(16) const char v;",
			"alignas(8) int a;",
			"int *(*g);",
			"static _Atomic(int) *q;",
			'int __attribute__((section("const"))) s;',
			'extern "C" volatile unsigned x;',
		].join("\n");
		const parsed = facts(handlers, "spelled.c", text);
		const display = (name: string) => {
			const declaration = declarationOf(parsed, name);
			if (declaration === undefined) return "missing";
			const answer = handlers.typeOf({ symbolId: declaration.symbolId });
			return answer.status === "known" ? answer.display : answer.status;
		};

		expect(["v", "a", "g", "q", "s", "x"].map(display)).toEqual([
			"char",
			"int",
			"int **",
			"_Atomic(int) *",
			'int __attribute__((section("const")))',
			"unsigned",
		]);
	});

	test("links a declared type past an attribute's arguments", () => {
		const handlers = started();
		const text = "typedef int length;\n__attribute__((aligned(8))) length size;\n";
		const parsed = facts(handlers, "attributed.c", text);
		const length = declarationOf(parsed, "length");
		const size = declarationOf(parsed, "size");

		if (length === undefined || size === undefined) throw new Error("attributed declarations are missing");
		expect(handlers.typeOf({ symbolId: size.symbolId })).toMatchObject({
			status: "known",
			symbolId: length.symbolId,
		});
	});

	test("uses closed unknown reasons for invalid and missing type requests", () => {
		const handlers = started();

		const invalid = handlers.typeOf({ symbolId: "not-a-c-symbol" });
		const missing = handlers.typeOf({ symbolId: "lexicon c missing.c value." });

		expect(invalid).toMatchObject({ status: "unknown", reason: "ParseError" });
		expect(missing).toMatchObject({ status: "unknown", reason: "NotIndexed" });
		expect(TypeInfoSchema.safeParse(invalid).success).toBe(true);
	});
});

describe("C edge coverage", () => {
	test("parses nested block locals without promoting expressions to declarations", () => {
		const parsed = facts(
			started(),
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
			started(),
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

	test("keeps declarations inside whole unknown preprocessor branches", () => {
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

	test("looks an include up by exactly its written name, never a guessed extension", () => {
		const root = workspace({
			"src/user.c": '#include "item"\nint run(void) { return item; }\n',
			"src/item.h": "int item;\n",
			"include/item": "int item;\n",
		});
		const handlers = started(root);
		const parsed = facts(handlers, "src/user.c", readFileSync(path.join(root, "src/user.c"), "utf8"));
		const binding = parsed.references.find((reference) => reference.role === "read")?.binding;

		expect(handlers.resolveImport({ fromModule: "src/user.c", specifier: "item" })).toEqual(landed("include/item"));
		expect(binding?.status === "bound" ? parseSymbolId(binding.symbolId)?.module : binding?.status).toBe(
			"include/item",
		);
	});

	test("treats standard system families as external dependencies", () => {
		const handlers = started();

		expect(handlers.resolveImport({ fromModule: "main.c", specifier: "sys/socket.h" })).toEqual({
			status: "external",
			packageName: "sys/socket.h",
		});
		expect(handlers.resolveImport({ fromModule: "main.c", specifier: "linux/input.h" })).toEqual({
			status: "external",
			packageName: "linux/input.h",
		});
	});

	test("returns a reasoned unknown binding for a missing source name", () => {
		const parsed = facts(started(), "unknown.c", "int run(void) { return missing; }\n");
		const reference = parsed.references.find((candidate) => candidate.name === "missing");

		expect(reference?.binding).toMatchObject({ status: "unbound", reason: "NotIndexed" });
		expect(reference?.binding.status === "unbound" ? reference.binding.detail : "").toContain("missing");
	});

	test("reports ordinary duplicate candidates as ambiguous when conditional provenance is absent", () => {
		const handlers = started();
		const text = "int value;\nstatic int value;\nint run(void) { return value; }\n";
		const parsed = facts(handlers, "duplicate.c", text);
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
		const handlers = started(root);
		const source = readFileSync(path.join(root, "src/main.c"), "utf8");
		const parsed = facts(handlers, "src/main.c", source);
		const reference = parsed.references.find((candidate) => candidate.name === "add");

		expect(reference?.role).toBe("call");
		expect(reference?.binding.status).toBe("bound");
		expect(reference?.binding.status === "bound" ? reference.binding.symbolId : "").toContain("src/api.h");
	});

	test("finds type information by a declaration selection range", () => {
		const handlers = started();
		const text = "int value = 1;\n";
		const parsed = facts(handlers, "selection-type.c", text);
		const value = declarationOf(parsed, "value");

		if (value === undefined) throw new Error("selection declaration is missing");
		expect(
			handlers.typeOf({
				module: "selection-type.c",
				range: value.selectionRange as NonNullable<typeof value.selectionRange>,
			}),
		).toMatchObject({
			status: "known",
			display: "int",
			provenance: "declared",
		});
	});

	test("loads a header from disk when a type request arrives before parsing it", () => {
		const root = workspace({ "include/value.h": "typedef unsigned long Word;\n" });
		const handlers = started(root);
		const symbolId = composeSymbolId({
			language: "c",
			module: "include/value.h",
			descriptors: [{ kind: "type", name: "Word" }],
		});

		expect(handlers.typeOf({ symbolId })).toMatchObject({ status: "known", display: "unsigned long" });
	});

	test("keeps the requested content hash on the wire", () => {
		const handlers = started();

		expect(facts(handlers, "hash.c", "int value;\n").contentHash).toBe("hash.c:11");
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
		expect(value?.selectionRange?.start).toEqual({ line: 1, character: 4 });
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

	test("parses repeated and nested shapes with work near linear in their size", () => {
		const shapes: Record<string, (count: number) => string> = {
			prototypes: (count) =>
				Array.from({ length: count }, (_, index) => `static int f${index}(int a);`)
					.concat(Array.from({ length: count }, (_, index) => `static int f${index}(int a) { return a; }`))
					.join("\n"),
			blocks: (count) => `void run(void) {\n${"if (x) {\n".repeat(count)}${"}\n".repeat(count)}}\n`,
			conditionals: (count) => `${"#if X\n".repeat(count)}int a;\n${"#endif\n".repeat(count)}`,
			arms: (count) =>
				`#if A0\n${Array.from({ length: count * 4 }, (_, index) => `#elif A${index}\n#if B\nint v${index};\n#endif\n`).join("")}#endif\n`,
			initializers: (count) =>
				`int ${Array.from({ length: count * 4 }, (_, index) => `a${index}[1] = {${index}}`).join(", ")};\n`,
		};
		const work = (text: string) => {
			const meter = { steps: 0 };
			parseC("scale.c", text, meter);
			return meter.steps;
		};
		// A delimiter candidate scan must not revisit every token for each token.
		for (const make of Object.values(shapes)) {
			const small = work(make(100));
			const large = work(make(800));
			expect(large / small).toBeLessThan(12);
		}
		// The typedef input grows 16x, so linear work needs a bound above 16.
		const declarators = (count: number) =>
			`typedef int ${Array.from({ length: count }, (_, index) => `T${index}`).join(", ")};`;
		const small = work(declarators(1_600));
		const large = work(declarators(25_600));
		expect(large / small).toBeLessThan(20);
	});

	test("reports one problem past the nesting limit instead of exhausting the stack", () => {
		const depth = 20_000;
		const parsed = parseC("deep.c", `void run(void) {\n${"if (x) {\n".repeat(depth)}${"}\n".repeat(depth)}}\n`);

		expect(parsed.diagnostics).toHaveLength(1);
		expect(parsed.declarations.map((declaration) => declaration.name)).toEqual(["run"]);
	});
});

describe("C edit refusals and protocol values", () => {
	test("refuses rename, move and arrange with a closed reason", () => {
		const handlers = started();
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
		const arrange: ArrangeEditsRequest = {
			module: "a.c",
			text: "int value;\n",
			exists: true,
			fromModule: "a.c",
			toModule: "b.c",
			members: [],
			importSites: [],
			dependencies: [],
		};

		expect(handlers.renameEdits(rename)).toMatchObject({ status: "refused", reason: "NotImplemented" });
		expect(handlers.moveEdits(move)).toMatchObject({ status: "refused", reason: "NotImplemented" });
		expect(handlers.arrangeEdits(arrange)).toMatchObject({ status: "refused", reason: "NotImplemented" });
	});

	test("validates binding and type values against their schemas", () => {
		const handlers = started();
		const parsed = facts(handlers, "schema.c", "int value = 1;\n");
		const value = declarationOf(parsed, "value");

		if (value === undefined) throw new Error("schema declaration is missing");
		const binding = handlers.bind({
			module: "schema.c",
			name: "value",
			range: value.selectionRange as NonNullable<typeof value.selectionRange>,
		});
		const type = handlers.typeOf({ symbolId: value.symbolId });

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

// A missing corpus is a local mistake and a CI fact, `temp/` being ignored and never cloned there.
// Skipping in CI keeps the throw below meaningful where the corpus is supposed to exist.
const { CI } = process.env;
const corpusTest = corpusPresent || !CI ? test : test.skip;

corpusTest(
	"parses every claimed C file from both requested corpora",
	async () => {
		if (!corpusPresent) throw new Error("C corpora are absent; run bun run corpora");
		const startedAt = performance.now();
		let files = 0;
		let bytes = 0;
		let declarations = 0;
		let references = 0;
		let imports = 0;
		const rootCounts: Array<{ root: string; files: number }> = [];
		const syntaxErrorFiles: string[] = [];
		// A span whose range does not cut its own text back out attaches to the wrong symbol, and
		// only real source has the string forms that break that.
		const strayed: string[] = [];
		let spans = 0;

		for (const root of [libuvCorpusRoot, ghidraCorpusRoot]) {
			const handlers = started(root);
			const project = new CProvider().discoverProject(root).model;
			expect(project.diagnostics).toEqual([]);
			const modules = project.files.filter((module) => module.endsWith(".c") || module.endsWith(".h"));
			rootCounts.push({ root: path.relative(process.cwd(), root), files: modules.length });

			for (const module of modules) {
				// Yields, so the timeout can fire.
				await new Promise((resolve) => setImmediate(resolve));
				const source = readFileSync(path.join(root, module), "utf8");
				const parsed = facts(handlers, module, source);
				files++;
				bytes += source.length;
				declarations += parsed.declarations.length;
				references += parsed.references.length;
				imports += parsed.imports.length;
				if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
					syntaxErrorFiles.push(path.relative(process.cwd(), path.join(root, module)).replace(/\\/gu, "/"));

				const coordinates = coordinatesOf(source);
				for (const comment of parsed.comments ?? []) {
					spans++;
					if (coordinates.sliceRange(comment.range) !== comment.text) {
						strayed.push(`${module}: ${JSON.stringify(comment.text)}`);
					}
				}

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

		const seconds = (performance.now() - startedAt) / 1000;
		console.log(
			`[c corpus] roots=${JSON.stringify(rootCounts)} files=${files} bytes=${bytes} declarations=${declarations} references=${references} imports=${imports} comments=${spans} syntaxErrorFiles=${syntaxErrorFiles.length} wallSeconds=${seconds.toFixed(3)}`,
		);
		expect(files).toBeGreaterThan(0);
		expect(syntaxErrorFiles).toEqual([]);
		expect(strayed).toEqual([]);
		expect(spans).toBeGreaterThan(0);
	},
	120_000,
);
