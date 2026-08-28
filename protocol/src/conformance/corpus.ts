// The shared corpus. Data, so a provider team reads it without reading the runner.
//
// A case states ONE expectation in language-neutral terms, then carries a fixture per language
// saying it. The expectations are shared; the syntax never is. A language with no fixture for a
// case skips it, which is the corpus admitting a gap rather than the provider failing one.
//
// Adding a language means adding fixtures here, and the provider team is the right author: they
// know their language's edge cases better than this file does.

import { repeatedNamePathCase } from "./identityCases.js";
import { markupCases } from "./markupCases.js";
import { stringFormCase } from "./stringForms.js";
import { type ConformanceCase, ConformanceCaseSchema } from "./types.js";

////////////////////////////////
//  Constants

/**
 * One character above U+FFFF, built from its code point rather than written literally.
 *
 * It is 2 UTF-16 code units, 1 codepoint and 4 UTF-8 bytes, so a column measured after it says
 * which unit the provider counts. Constructed here because a literal astral character in source is
 * exactly the kind of byte that survives review by being invisible.
 */
const ASTRAL = String.fromCodePoint(0x1f600);

/**
 * A leading byte order mark, built from its code point for the same reason.
 *
 * Parsers routinely STRIP it before parsing, so every offset they report comes back one code unit
 * short of the file. A range built from one then addresses the character before the one it means,
 * which reads as content rather than as an error and is why a fixture carries it.
 */
const BOM = String.fromCodePoint(0xfeff);

/** The suite's own reference provider, whose toy grammar is a subset of TypeScript's. */
const REFERENCE = "reference";
const TYPESCRIPT = "typescript";
const PYTHON = "python";
const GDSCRIPT = "gdscript";
const C = "c";
const CPP = "cpp";
const CSHARP = "csharp";
const RUST = "rust";
const KOTLIN = "kotlin";
const MARKDOWN = "markdown";
const JSON_LANG = "json";
const XML = "xml";
const HTML = "html";
const YAML = "yaml";

const CASES: ConformanceCase[] = [
	{
		id: "exported-declarations",
		tier: "declarations",
		about: "Every exported declaration is reported, with its kind and exported flag.",
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/cart.ts": "export class Cart {}\nexport function add() {}\nexport const LIMIT = 1;\n" },
				subject: "src/cart.ts",
			},
			[REFERENCE]: {
				files: { "src/cart.ref": "export class Cart {}\nexport function add() {}\nexport const LIMIT = 1;\n" },
				subject: "src/cart.ref",
			},
			// Python has no export keyword. __all__ is the one statement of public API a reader and a
			// tool can both act on, so it is what "exported" means here.
			// LIMIT is annotated Final because that is Python's constant, and a bare `LIMIT = 1` is a
			// variable the language lets anyone reassign. Matching the syntax rather than the spelling
			// is what keeps one expectation meaningful across languages.
			// GDScript has NO fixture on purpose: the language has no export concept, its extractor
			// answers `exported` with absence, and a fixture would have to drop the flag this case is
			// about. The skip is the honest outcome, not a gap.
			[PYTHON]: {
				files: {
					"src/cart.py":
						'from typing import Final\n\n__all__ = ["Cart", "add", "LIMIT"]\n\n\nclass Cart:\n    pass\n\n\ndef add():\n    pass\n\n\nLIMIT: Final = 1\n',
				},
				subject: "src/cart.py",
			},
			// C spells a type as a struct, so the kind expectation is per-fixture rather than shared.
			// External linkage is what "exported" means for C: everything file-scope and non-static.
			[C]: {
				files: {
					"src/cart.c": "struct Cart { int value; };\nint add(void) { return 0; }\nconst int LIMIT = 1;\n",
				},
				subject: "src/cart.c",
				declarations: [
					{ name: "Cart", kind: "struct", exported: true },
					{ name: "add", kind: "function", exported: true },
					{ name: "LIMIT", kind: "constant", exported: true },
				],
			},
			// C++20 module export syntax, which needs the module declaration to be grammatical.
			[CPP]: {
				files: {
					"src/cart.cpp":
						"export module cart;\nexport class Cart {};\nexport int add() { return 0; }\nexport const int LIMIT = 1;\n",
				},
				subject: "src/cart.cpp",
			},
			[CSHARP]: {
				files: {
					"src/cart.cs": "public class Cart { public static void add() {} public const int LIMIT = 1; }\n",
				},
				subject: "src/cart.cs",
				declarations: [
					{ name: "Cart", kind: "class", exported: true },
					{ name: "add", kind: "method", exported: true, container: "Cart" },
					{ name: "LIMIT", kind: "constant", exported: true, container: "Cart" },
				],
			},
			[RUST]: {
				files: { "src/cart.rs": "pub struct Cart {}\npub fn add() {}\npub const LIMIT: i32 = 1;\n" },
				subject: "src/cart.rs",
				declarations: [
					{ name: "Cart", kind: "struct", exported: true },
					{ name: "add", kind: "function", exported: true },
					{ name: "LIMIT", kind: "constant", exported: true },
				],
			},
			// Kotlin's default visibility is public, which is what "exported" means here.
			[KOTLIN]: {
				files: { "src/Cart.kt": "package cart\n\nclass Cart\nfun add() {}\nconst val LIMIT = 1\n" },
				subject: "src/Cart.kt",
			},
		},
		declarations: [
			{ name: "Cart", kind: "class", exported: true },
			{ name: "add", kind: "function", exported: true },
			{ name: "LIMIT", kind: "constant", exported: true },
		],
	},
	{
		id: "declaration-id-descriptors",
		tier: "declarations",
		about: "A symbol id carries the declaration's descriptor chain, asserted by parts not text.",
		fixtures: {
			[TYPESCRIPT]: { files: { "src/cart.ts": "export class Cart {}\n" }, subject: "src/cart.ts" },
			[REFERENCE]: { files: { "src/cart.ref": "export class Cart {}\n" }, subject: "src/cart.ref" },
			[PYTHON]: { files: { "src/cart.py": "class Cart:\n    pass\n" }, subject: "src/cart.py" },
			[GDSCRIPT]: { files: { "src/cart.gd": "class_name Cart\nextends Node\n" }, subject: "src/cart.gd" },
			[C]: { files: { "src/cart.c": "struct Cart { int value; };\n" }, subject: "src/cart.c" },
			[CPP]: { files: { "src/cart.cpp": "class Cart {};\n" }, subject: "src/cart.cpp" },
			[CSHARP]: { files: { "src/cart.cs": "public class Cart {}\n" }, subject: "src/cart.cs" },
			[RUST]: { files: { "src/cart.rs": "pub struct Cart {}\n" }, subject: "src/cart.rs" },
			[KOTLIN]: { files: { "src/Cart.kt": "package cart\nclass Cart\n" }, subject: "src/Cart.kt" },
		},
		// The one expectation that must hold in every language: a class is a `type` descriptor. Three
		// syntaxes with nothing in common still have to mint the same id shape, because the id is the
		// join key across providers.
		declarations: [{ name: "Cart", descriptors: ["type:Cart"] }],
	},
	{
		id: "cpp-qualified-definition-merges-prototype",
		tier: "declarations",
		about: "An out-of-line C++ definition keeps its written qualifier path and replaces its prototype range.",
		fixtures: {
			[CPP]: {
				files: {
					"src/physics.cpp":
						"namespace Physics { class World { public: void step(); }; }\nvoid Physics::World::step() {}\n",
				},
				subject: "src/physics.cpp",
			},
		},
		declarations: [
			{
				name: "step",
				descriptors: ["namespace:Physics", "type:World", "method:step"],
				nameStart: { line: 1, character: 21 },
			},
		],
	},
	{
		id: "cpp-overload-definition-signatures",
		tier: "declarations",
		about: "C++ overload definitions keep ids matched to parameter signatures.",
		fixtures: {
			[CPP]: {
				files: {
					"src/overloads.cpp":
						"class A { public: void f(int); void f(double); };\nvoid A::f(double) {}\nvoid A::f(int) {}\n",
				},
				subject: "src/overloads.cpp",
			},
		},
		declarations: [
			{ name: "f", descriptors: ["type:A", "method:f"], nameStart: { line: 1, character: 8 } },
			{ name: "f", descriptors: ["type:A", "method:f(1)"], nameStart: { line: 2, character: 8 } },
		],
	},
	{
		id: "csharp-file-scoped-namespace-parameters",
		tier: "declarations",
		about: "A C# file-scoped namespace and method parameters use their descriptor kinds.",
		fixtures: {
			[CSHARP]: {
				files: {
					"src/service.cs": "namespace Acme.Services;\nclass Service { void Compute(string name) {} }\n",
				},
				subject: "src/service.cs",
			},
		},
		declarations: [
			{ name: "Compute", descriptors: ["namespace:Acme.Services", "type:Service", "method:Compute"] },
			{
				name: "name",
				descriptors: ["namespace:Acme.Services", "type:Service", "method:Compute", "parameter:name"],
			},
		],
	},
	{
		id: "csharp-explicit-interface-qualifier",
		tier: "declarations",
		about: "A C# explicit interface implementation uses the written interface as its qualifier.",
		fixtures: {
			[CSHARP]: {
				files: { "src/service.cs": "class Service { void IFoo.Compute(string name) {} }\n" },
				subject: "src/service.cs",
			},
		},
		declarations: [{ name: "Compute", descriptors: ["type:Service", "namespace:IFoo", "method:Compute"] }],
	},
	{
		id: "csharp-generic-explicit-interface-qualifier",
		tier: "declarations",
		about: "Generic C# explicit interface implementations keep their interface qualifier.",
		fixtures: {
			[CSHARP]: {
				files: {
					"src/service.cs": "class Service { void IFoo<int>.Compute() {} void IFoo<T>.Compute() {} }\n",
				},
				subject: "src/service.cs",
			},
		},
		declarations: [
			{
				name: "Compute",
				descriptors: ["type:Service", "namespace:IFoo", "method:Compute"],
				nameStart: { line: 0, character: 31 },
			},
			{
				name: "Compute",
				descriptors: ["type:Service", "namespace:IFoo", "method:Compute(1)"],
				nameStart: { line: 0, character: 57 },
			},
		],
	},
	{
		id: "gdscript-class-name-descriptor",
		tier: "declarations",
		about: "A GDScript class_name is a type descriptor.",
		fixtures: {
			[GDSCRIPT]: { files: { "src/player.gd": "class_name Player\nextends Node\n" }, subject: "src/player.gd" },
		},
		declarations: [{ name: "Player", descriptors: ["type:Player"] }],
	},
	{
		id: "tsx-member-descriptor",
		tier: "declarations",
		about: "A TSX class member is nested under its type descriptor.",
		fixtures: {
			[TYPESCRIPT]: {
				files: {
					"tsconfig.json": '{"compilerOptions":{"allowJs":true,"jsx":"preserve"}}',
					"src/view.tsx": "class View { render() { return <div />; } }\n",
				},
				subject: "src/view.tsx",
			},
		},
		declarations: [{ name: "render", descriptors: ["type:View", "method:render"] }],
	},
	{
		id: "javascript-anonymous-nesting",
		tier: "declarations",
		about: "An anonymous JavaScript nesting still gives its member a stable descriptor path.",
		fixtures: {
			[TYPESCRIPT]: {
				files: {
					"tsconfig.json": '{"compilerOptions":{"allowJs":true,"jsx":"preserve"}}',
					"src/util.js": "export default { deepHandler() {} };\n",
				},
				subject: "src/util.js",
			},
		},
		declarations: [{ name: "deepHandler", descriptors: ["term:default", "method:deepHandler"] }],
	},
	{
		id: "markdown-dotted-heading",
		tier: "declarations",
		about: "A markdown heading keeps a dot in its full name.",
		fixtures: {
			[MARKDOWN]: { files: { "README.md": "# Node.js setup\n" }, subject: "README.md" },
		},
		declarations: [{ name: "Node.js setup", descriptors: ["namespace:Node.js setup"] }],
	},
	{
		id: "position-is-utf16-code-units",
		tier: "declarations",
		about: "A column counts UTF-16 code units, so an astral character before a name shifts it by two.",
		fixtures: {
			// A block comment puts the astral character on the same line as the name, which is the only
			// arrangement that tests a COLUMN. `/* ` is 3, the character is 2, ` */ export class ` is 17.
			// Each expected column is the ONLY one UTF-16 gives. Counting bytes puts it two further
			// right and counting codepoints one further left, so no unit but the required one passes.
			[TYPESCRIPT]: {
				files: { "src/cart.ts": `/* ${ASTRAL} */ export class Cart {}\n` },
				subject: "src/cart.ts",
				declarations: [{ name: "Cart", nameStart: { line: 0, character: 22 } }],
			},
			// Neither Python nor GDScript has a block comment, so a separated statement is what puts the
			// character to the left of a name. Python's ast reports UTF-8 byte columns, and converting
			// those to codepoints is the near miss this case exists to catch: it is right for every
			// character below U+FFFF and one short for every character above it.
			[PYTHON]: {
				files: { "src/cart.py": `X = "${ASTRAL}"; Y = 1\n` },
				subject: "src/cart.py",
				declarations: [{ name: "Y", nameStart: { line: 0, character: 10 } }],
			},
			[GDSCRIPT]: {
				files: { "src/cart.gd": `extends Node\n\nvar x = "${ASTRAL}"; var y = 1\n` },
				subject: "src/cart.gd",
				declarations: [{ name: "y", nameStart: { line: 2, character: 18 } }],
			},
			// `/* ` is 3, the astral is 2, ` */ struct ` is 11, so C lands one further right than the
			// five-letter class keyword puts C++.
			[C]: {
				files: { "src/cart.c": `/* ${ASTRAL} */ struct Cart { int value; };\n` },
				subject: "src/cart.c",
				declarations: [{ name: "Cart", nameStart: { line: 0, character: 16 } }],
			},
			[CPP]: {
				files: { "src/cart.cpp": `/* ${ASTRAL} */ class Cart {};\n` },
				subject: "src/cart.cpp",
				declarations: [{ name: "Cart", nameStart: { line: 0, character: 15 } }],
			},
			[CSHARP]: {
				files: { "src/cart.cs": `/* ${ASTRAL} */ public class Cart {}\n` },
				subject: "src/cart.cs",
				declarations: [{ name: "Cart", nameStart: { line: 0, character: 22 } }],
			},
			[RUST]: {
				files: { "src/cart.rs": `/* ${ASTRAL} */ pub struct Cart {}\n` },
				subject: "src/cart.rs",
				declarations: [{ name: "Cart", nameStart: { line: 0, character: 20 } }],
			},
			[KOTLIN]: {
				files: { "src/Cart.kt": `/* ${ASTRAL} */ class Cart\n` },
				subject: "src/Cart.kt",
				declarations: [{ name: "Cart", nameStart: { line: 0, character: 15 } }],
			},
			// JSON has no comment in its strict dialect, so a preceding VALUE is what puts the character
			// to the left of a name. The span starts at the opening quote, which is the key as written.
			[JSON_LANG]: {
				files: { "data.json": `{"a": "${ASTRAL}", "b": 1}\n` },
				subject: "data.json",
				declarations: [{ name: "b", nameStart: { line: 0, character: 12 } }],
			},
			[YAML]: {
				files: { "data.yml": `{a: "${ASTRAL}", b: 1}\n` },
				subject: "data.yml",
				declarations: [{ name: "b", nameStart: { line: 0, character: 10 } }],
			},
			// A heading's name would swallow the character, so frontmatter is where markdown can put one
			// to the LEFT of a name. It also proves the shared reader's offset survives the shift.
			[MARKDOWN]: {
				files: { "doc.md": `---\n{a: "${ASTRAL}", b: 1}\n---\n\n# Body\n` },
				subject: "doc.md",
				declarations: [{ name: "b", nameStart: { line: 1, character: 10 } }],
			},
			// An attribute holding the character puts the next attribute's name to its right.
			[XML]: {
				files: { "data.xml": `<r a="${ASTRAL}" b="1"/>\n` },
				subject: "data.xml",
				declarations: [{ name: "b", nameStart: { line: 0, character: 10 } }],
			},
			[HTML]: {
				files: { "data.html": `<r a="${ASTRAL}" b="1"></r>\n` },
				subject: "data.html",
				declarations: [{ name: "b", nameStart: { line: 0, character: 10 } }],
			},
		},
	},
	{
		id: "declaration-range-with-trailing-newline",
		tier: "declarations",
		about: "A declaration stays addressable when a trailing newline creates a final empty line.",
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/cart.ts": "\nexport const cart = 1;\n" },
				subject: "src/cart.ts",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 13 } }],
			},
			[REFERENCE]: {
				files: { "src/cart.ref": "\nexport const cart = 1;\n" },
				subject: "src/cart.ref",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 13 } }],
			},
			[PYTHON]: {
				files: { "src/cart.py": "\ncart = 1\n" },
				subject: "src/cart.py",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 0 } }],
			},
			[GDSCRIPT]: {
				files: { "src/cart.gd": "\nvar cart = 1\n" },
				subject: "src/cart.gd",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 4 } }],
			},
			[C]: {
				files: { "src/cart.c": "\nint cart = 1;\n" },
				subject: "src/cart.c",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 4 } }],
			},
			[CPP]: {
				files: { "src/cart.cpp": "\nint cart = 1;\n" },
				subject: "src/cart.cpp",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 4 } }],
			},
			[CSHARP]: {
				files: { "src/cart.cs": "\npublic class Cart {}\n" },
				subject: "src/cart.cs",
				declarations: [{ name: "Cart", nameStart: { line: 1, character: 13 } }],
			},
			[RUST]: {
				files: { "src/cart.rs": "\npub const cart: i32 = 1;\n" },
				subject: "src/cart.rs",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 10 } }],
			},
			[KOTLIN]: {
				files: { "src/Cart.kt": "\nclass Cart\n" },
				subject: "src/Cart.kt",
				declarations: [{ name: "Cart", nameStart: { line: 1, character: 6 } }],
			},
			[XML]: {
				files: { "cart.xml": "\n<cart/>\n" },
				subject: "cart.xml",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 1 } }],
			},
			[HTML]: {
				files: { "cart.html": "\n<cart></cart>\n" },
				subject: "cart.html",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 1 } }],
			},
		},
	},
	{
		id: "empty-file",
		tier: "declarations",
		about: "A file with nothing in it reports nothing, and does not error.",
		fixtures: {
			[TYPESCRIPT]: { files: { "src/empty.ts": "\n" }, subject: "src/empty.ts" },
			[REFERENCE]: { files: { "src/empty.ref": "\n" }, subject: "src/empty.ref" },
			[PYTHON]: { files: { "src/empty.py": "\n" }, subject: "src/empty.py" },
			[GDSCRIPT]: { files: { "src/empty.gd": "\n" }, subject: "src/empty.gd" },
			[C]: { files: { "src/empty.c": "\n" }, subject: "src/empty.c" },
			[CPP]: { files: { "src/empty.cpp": "\n" }, subject: "src/empty.cpp" },
			[CSHARP]: { files: { "src/empty.cs": "\n" }, subject: "src/empty.cs" },
			[RUST]: { files: { "src/empty.rs": "\n" }, subject: "src/empty.rs" },
			[KOTLIN]: { files: { "src/Empty.kt": "\n" }, subject: "src/Empty.kt" },
			[JSON_LANG]: { files: { "empty.json": "\n" }, subject: "empty.json" },
			[YAML]: { files: { "empty.yml": "\n" }, subject: "empty.yml" },
			[MARKDOWN]: { files: { "empty.md": "\n" }, subject: "empty.md" },
			[XML]: { files: { "empty.xml": "\n" }, subject: "empty.xml" },
			[HTML]: { files: { "empty.html": "\n" }, subject: "empty.html" },
		},
		declarations: [],
		// The "does not error" half, which the wording claimed and nothing checked. An empty file is
		// what a repository is full of, and a parser calling one broken is the failure worth catching.
		parseErrors: "forbidden",
	},
	{
		id: "every-comment-shape-is-emitted",
		tier: "comments",
		about: "A provider reports every comment as a raw span: leading, trailing, inline, and standalone.",
		// The four shapes core attaches from. No anchor is asserted: that is core's, not a provider's.
		fixtures: {
			[TYPESCRIPT]: {
				files: {
					"src/comments.ts":
						"// leading\nexport function work(first: number /* inline */, second: number): number {\n\treturn first + second;\n}\n\nexport const total = 42; // trailing\n\n/* standalone */\n",
				},
				subject: "src/comments.ts",
			},
			[REFERENCE]: {
				files: {
					"src/comments.ref":
						"// leading\nexport function work() {}\n\nexport const total = 42; // trailing\n\n/* standalone */\n",
				},
				subject: "src/comments.ref",
				comments: ["// leading", "// trailing", "/* standalone */"],
			},
			[PYTHON]: {
				files: {
					"src/comments.py":
						"# leading\ndef work(\n\tfirst,\n\t# inline\n\tsecond,\n):\n\treturn first + second\n\n\ntotal = 42  # trailing\n\n# standalone\n",
				},
				subject: "src/comments.py",
				comments: ["# leading", "# inline", "# trailing", "# standalone"],
			},
			[GDSCRIPT]: {
				files: {
					"src/comments.gd":
						"# leading\nfunc work(first, second):\n\t# inline\n\treturn first + second\n\nvar total = 42 # trailing\n\n# standalone\n",
				},
				subject: "src/comments.gd",
				comments: ["# leading", "# inline", "# trailing", "# standalone"],
			},
			[C]: {
				files: {
					"src/comments.c":
						"// leading\nint work(int first /* inline */, int second) {\n\treturn first + second;\n}\n\nint total = 42; // trailing\n\n/* standalone */\n",
				},
				subject: "src/comments.c",
			},
			[CPP]: {
				files: {
					"src/comments.cpp":
						"// leading\nint work(int first /* inline */, int second) {\n\treturn first + second;\n}\n\nint total = 42; // trailing\n\n/* standalone */\n",
				},
				subject: "src/comments.cpp",
			},
			[CSHARP]: {
				files: {
					"src/Comments.cs":
						"// leading\npublic class Comments {\n\tpublic int Work(int first /* inline */, int second) {\n\t\treturn first + second;\n\t}\n\n\tpublic int Total = 42; // trailing\n}\n\n/* standalone */\n",
				},
				subject: "src/Comments.cs",
			},
			[RUST]: {
				files: {
					"src/comments.rs":
						"// leading\npub fn work(first: i32 /* inline */, second: i32) -> i32 {\n\tfirst + second\n}\n\npub const TOTAL: i32 = 42; // trailing\n\n/* standalone */\n",
				},
				subject: "src/comments.rs",
			},
			[KOTLIN]: {
				files: {
					"src/Comments.kt":
						"// leading\nfun work(first: Int /* inline */, second: Int): Int {\n\treturn first + second\n}\n\nval total = 42 // trailing\n\n/* standalone */\n",
				},
				subject: "src/Comments.kt",
			},
			// Under `.jsonc`, where the shapes carry no note; every dialect reads them.
			[JSON_LANG]: {
				files: {
					"comments.jsonc":
						'// leading\n{\n\t"work": 1, /* inline */\n\t"total": 42, // trailing\n\n\t/* standalone */\n\t"last": 3\n}\n',
				},
				subject: "comments.jsonc",
			},
			// YAML has one comment shape, so the four positions are what it can still say.
			[YAML]: {
				files: {
					"comments.yml": "# leading\nwork:\n  # inline\n  first: 1\ntotal: 42 # trailing\n\n# standalone\n",
				},
				subject: "comments.yml",
				comments: ["# leading", "# inline", "# trailing", "# standalone"],
			},
		},
		comments: ["// leading", "/* inline */", "// trailing", "/* standalone */"],
	},
	{
		id: "a-carriage-return-ends-a-line-comment-and-is-not-its-text",
		tier: "comments",
		about: "Under CRLF a line comment stops before the carriage return, so the same file scores alike either way.",
		// A trailing \r rides into the text and changes the fact id, so the same comment is two facts
		// depending on the checkout's line endings.
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/crlf.ts": "// leading\r\nexport const total = 42; // trailing\r\n" },
				subject: "src/crlf.ts",
			},
			[REFERENCE]: {
				files: { "src/crlf.ref": "// leading\r\nexport const total = 42; // trailing\r\n" },
				subject: "src/crlf.ref",
			},
			[PYTHON]: {
				files: { "src/crlf.py": "# leading\r\ntotal = 42  # trailing\r\n" },
				subject: "src/crlf.py",
				comments: ["# leading", "# trailing"],
			},
			[GDSCRIPT]: {
				files: { "src/crlf.gd": "# leading\r\nvar total = 42 # trailing\r\n" },
				subject: "src/crlf.gd",
				comments: ["# leading", "# trailing"],
			},
			[C]: {
				files: { "src/crlf.c": "// leading\r\nint total = 42; // trailing\r\n" },
				subject: "src/crlf.c",
			},
			[CPP]: {
				files: { "src/crlf.cpp": "// leading\r\nint total = 42; // trailing\r\n" },
				subject: "src/crlf.cpp",
			},
			[CSHARP]: {
				files: {
					"src/Crlf.cs":
						"// leading\r\npublic class Crlf {\r\n\tpublic int Total = 42;\r\n}\r\n// trailing\r\n",
				},
				subject: "src/Crlf.cs",
			},
			[RUST]: {
				files: { "src/crlf.rs": "// leading\r\npub const TOTAL: i32 = 42; // trailing\r\n" },
				subject: "src/crlf.rs",
			},
			[KOTLIN]: {
				files: { "src/Crlf.kt": "// leading\r\nval total = 42 // trailing\r\n" },
				subject: "src/Crlf.kt",
			},
			[JSON_LANG]: {
				files: { "crlf.jsonc": '// leading\r\n{ "total": 42 } // trailing\r\n' },
				subject: "crlf.jsonc",
			},
			[YAML]: {
				files: { "crlf.yml": "# leading\r\ntotal: 42 # trailing\r\n" },
				subject: "crlf.yml",
				comments: ["# leading", "# trailing"],
			},
			[XML]: {
				files: { "crlf.xml": '<!-- leading -->\r\n<root total="42"/>\r\n<!-- trailing -->\r\n' },
				subject: "crlf.xml",
				comments: ["<!-- leading -->", "<!-- trailing -->"],
			},
			[HTML]: {
				files: { "crlf.html": '<!-- leading -->\r\n<p total="42"></p>\r\n<!-- trailing -->\r\n' },
				subject: "crlf.html",
				comments: ["<!-- leading -->", "<!-- trailing -->"],
			},
		},
		comments: ["// leading", "// trailing"],
	},
	{
		id: "a-spliced-line-comment-is-one-comment",
		tier: "comments",
		about: "Where the language splices backslash-newline, a line comment continues and stays one span.",
		// Splitting it reports a second comment the language does not have, and leaves the
		// continuation looking like code.
		fixtures: {
			[C]: {
				files: { "src/spliced.c": "// spliced \\\nstill comment\nint total = 42;\n" },
				subject: "src/spliced.c",
			},
			[CPP]: {
				files: { "src/spliced.cpp": "// spliced \\\nstill comment\nint total = 42;\n" },
				subject: "src/spliced.cpp",
			},
		},
		comments: ["// spliced \\\nstill comment"],
	},
	{
		id: "comment-columns-are-utf16-code-units",
		tier: "comments",
		about: "An astral character before and inside a comment shifts its columns by two, like every other range.",
		// `position-is-utf16-code-units` pins this for declarations. A comment range is measured by
		// separate code in most providers, so it needs its own case: the string puts an astral
		// character left of the marker to test the START column, and one inside tests the END.
		// No expectation states a column, because the suite already checks every span's range by
		// cutting its own text back out, and that is the assertion that can only hold in one unit.
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/astral.ts": `export const s = "${ASTRAL}"; // ${ASTRAL} tail\n` },
				subject: "src/astral.ts",
			},
			[REFERENCE]: {
				files: { "src/astral.ref": `export const s = "${ASTRAL}"; // ${ASTRAL} tail\n` },
				subject: "src/astral.ref",
			},
			[PYTHON]: {
				files: { "src/astral.py": `s = "${ASTRAL}"  # ${ASTRAL} tail\n` },
				subject: "src/astral.py",
				comments: [`# ${ASTRAL} tail`],
			},
			[GDSCRIPT]: {
				files: { "src/astral.gd": `var s = "${ASTRAL}" # ${ASTRAL} tail\n` },
				subject: "src/astral.gd",
				comments: [`# ${ASTRAL} tail`],
			},
			[C]: {
				files: { "src/astral.c": `const char *s = "${ASTRAL}"; // ${ASTRAL} tail\n` },
				subject: "src/astral.c",
			},
			[CPP]: {
				files: { "src/astral.cpp": `const char *s = "${ASTRAL}"; // ${ASTRAL} tail\n` },
				subject: "src/astral.cpp",
			},
			[CSHARP]: {
				files: {
					"src/Astral.cs": `public class Astral { public string S = "${ASTRAL}"; } // ${ASTRAL} tail\n`,
				},
				subject: "src/Astral.cs",
			},
			[RUST]: {
				files: { "src/astral.rs": `pub const S: &str = "${ASTRAL}"; // ${ASTRAL} tail\n` },
				subject: "src/astral.rs",
			},
			[KOTLIN]: {
				files: { "src/Astral.kt": `val s = "${ASTRAL}" // ${ASTRAL} tail\n` },
				subject: "src/Astral.kt",
			},
		},
		comments: [`// ${ASTRAL} tail`],
	},
	{
		id: "a-doc-comment-and-its-declaration-relate-one-of-two-ways",
		tier: "comments",
		about: "A declaration's range either covers its doc comment or begins on the line after it.",
		// Providers disagree here and both answers are kept. The point is that there is no THIRD
		// answer: core attaches documentation by exactly these two shapes, so a range starting
		// anywhere else loses every doc comment in that language while the suite stays green.
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/doc.ts": "/** What work does. */\nexport function work(): number {\n\treturn 1;\n}\n" },
				subject: "src/doc.ts",
				documentation: { declaration: "work", comment: "/** What work does. */" },
			},
			[REFERENCE]: {
				files: { "src/doc.ref": "// What work does.\nexport function work() {}\n" },
				subject: "src/doc.ref",
				documentation: { declaration: "work", comment: "// What work does." },
			},
			[PYTHON]: {
				files: { "src/doc.py": "# What work does.\ndef work():\n\treturn 1\n" },
				subject: "src/doc.py",
				documentation: { declaration: "work", comment: "# What work does." },
			},
			[GDSCRIPT]: {
				files: { "src/doc.gd": "# What work does.\nfunc work():\n\treturn 1\n" },
				subject: "src/doc.gd",
				documentation: { declaration: "work", comment: "# What work does." },
			},
			[C]: {
				files: { "src/doc.c": "/** What work does. */\nint work(void) {\n\treturn 1;\n}\n" },
				subject: "src/doc.c",
				documentation: { declaration: "work", comment: "/** What work does. */" },
			},
			[CPP]: {
				files: { "src/doc.cpp": "/** What work does. */\nint work() {\n\treturn 1;\n}\n" },
				subject: "src/doc.cpp",
				documentation: { declaration: "work", comment: "/** What work does. */" },
			},
			[CSHARP]: {
				files: {
					"src/Doc.cs":
						"public class Doc {\n\t/// What work does.\n\tpublic int Work() {\n\t\treturn 1;\n\t}\n}\n",
				},
				subject: "src/Doc.cs",
				documentation: { declaration: "Work", comment: "/// What work does." },
			},
			[RUST]: {
				files: { "src/doc.rs": "/// What work does.\npub fn work() -> i32 {\n\t1\n}\n" },
				subject: "src/doc.rs",
				documentation: { declaration: "work", comment: "/// What work does." },
			},
			[KOTLIN]: {
				files: { "src/Doc.kt": "/** What work does. */\nfun work(): Int {\n\treturn 1\n}\n" },
				subject: "src/Doc.kt",
				documentation: { declaration: "work", comment: "/** What work does. */" },
			},
		},
	},
	{
		id: "a-marker-inside-a-spliced-string-is-not-a-comment",
		tier: "comments",
		about: "Where the language splices backslash-newline, a string continues across it and its markers stay text.",
		// Splicing happens before tokenizing, so a string can hold a marker on a LATER line. A lexer
		// that splices comments but not strings ends the string at the newline and reads the rest as
		// prose, which is the false-positive class wearing a second hat.
		fixtures: {
			[C]: {
				files: { "src/spliced.c": 'const char *x = "foo\\\n// /* #bar";\nint y = 1; // real\n' },
				subject: "src/spliced.c",
			},
			[CPP]: {
				files: { "src/spliced.cpp": 'const char *x = "foo\\\n// /* #bar";\nint y = 1; // real\n' },
				subject: "src/spliced.cpp",
			},
		},
		comments: ["// real"],
	},
	{
		id: "a-marker-inside-a-nested-interpolation-is-not-a-comment",
		tier: "comments",
		about: "An interpolation hole may hold a string of its own, and markers inside that string stay text.",
		// The hole is code, so it nests: a lexer ending the string at the first inner quote reads the
		// remainder as source and reports prose that is not there.
		fixtures: {
			[CSHARP]: {
				files: {
					"src/Nested.cs":
						'public class Nested {\n\tvoid M() {\n\t\tvar x = $"a // {"b /* c #"} d"; // real\n\t}\n}\n',
				},
				subject: "src/Nested.cs",
			},
			[KOTLIN]: {
				files: { "src/Nested.kt": 'fun m() {\n\tval x = "a // ${"b /* c #"} d" // real\n}\n' },
				subject: "src/Nested.kt",
			},
		},
		comments: ["// real"],
	},
	{
		id: "a-comment-inside-an-interpolation-is-a-comment",
		tier: "comments",
		about: "An interpolation hole is code, so prose inside it is reported like prose anywhere else.",
		// The mirror of the case above. Treating the hole as text loses this comment; treating the
		// whole string as text loses it too. Only lexing the hole as code finds it.
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/hole.ts": "export const x = `a ${1 /* here */} b`; // real\n" },
				subject: "src/hole.ts",
			},
			[CSHARP]: {
				files: {
					"src/Hole.cs":
						'public class Hole {\n\tvoid M() {\n\t\tvar x = $"a {1 /* here */} b"; // real\n\t}\n}\n',
				},
				subject: "src/Hole.cs",
			},
			[KOTLIN]: {
				files: { "src/Hole.kt": 'fun m() {\n\tval x = "a ${1 /* here */} b" // real\n}\n' },
				subject: "src/Hole.kt",
			},
		},
		comments: ["/* here */", "// real"],
	},
	{
		id: "comment-markers-in-text-are-not-comments",
		tier: "comments",
		about: "A marker inside a string literal is not a comment, and the exact set catches it.",
		// A lexer scanning for markers rather than tokenizing reports the string's contents.
		fixtures: {
			[TYPESCRIPT]: {
				files: {
					"src/markers.ts":
						'export const url = "https://example.com/path";\nexport const block = "/* not a comment */";\n// real\n',
				},
				subject: "src/markers.ts",
			},
			[REFERENCE]: {
				files: {
					"src/markers.ref":
						'export const url = "https://example.com/path";\nexport const block = "/* not a comment */";\n// real\n',
				},
				subject: "src/markers.ref",
			},
			[PYTHON]: {
				files: { "src/markers.py": 'url = "https://example.com/path"\nhashed = "# not a comment"\n# real\n' },
				subject: "src/markers.py",
				comments: ["# real"],
			},
			[GDSCRIPT]: {
				files: {
					"src/markers.gd": 'var url = "https://example.com/path"\nvar hashed = "# not a comment"\n# real\n',
				},
				subject: "src/markers.gd",
				comments: ["# real"],
			},
			[C]: {
				files: {
					"src/markers.c":
						'const char *url = "https://example.com/path";\nconst char *block = "/* not a comment */";\n// real\n',
				},
				subject: "src/markers.c",
			},
			[CPP]: {
				files: {
					"src/markers.cpp":
						'const char *url = "https://example.com/path";\nconst char *block = "/* not a comment */";\n// real\n',
				},
				subject: "src/markers.cpp",
			},
			[CSHARP]: {
				files: {
					"src/Markers.cs":
						'public class Markers {\n\tpublic string Url = "https://example.com/path";\n\tpublic string Block = "/* not a comment */";\n}\n// real\n',
				},
				subject: "src/Markers.cs",
			},
			[RUST]: {
				files: {
					"src/markers.rs":
						'pub const URL: &str = "https://example.com/path";\npub const BLOCK: &str = "/* not a comment */";\n// real\n',
				},
				subject: "src/markers.rs",
			},
			[KOTLIN]: {
				files: {
					"src/Markers.kt":
						'val url = "https://example.com/path"\nval block = "/* not a comment */"\n// real\n',
				},
				subject: "src/Markers.kt",
			},
			[JSON_LANG]: {
				files: {
					"markers.jsonc":
						'// real\n{\n\t"url": "https://example.com/path",\n\t"block": "/* not a comment */"\n}\n',
				},
				subject: "markers.jsonc",
			},
			// The hash in a plain scalar and the one inside a block scalar are both content, and a scanner
			// looking for the marker rather than following the grammar reports them.
			[YAML]: {
				files: {
					"markers.yml":
						'url: "https://example.com/path"\nhashed: "# not a comment"\nblock: |\n  # not a comment either\n# real\n',
				},
				subject: "markers.yml",
				comments: ["# real"],
			},
		},
		comments: ["// real"],
	},
	{
		id: "a-shebang-is-emitted-like-any-comment",
		tier: "comments",
		about: "An interpreter line is lexically a comment, so it is reported rather than filtered here.",
		// Providers report what the language says is a comment. Whether an interpreter line is
		// PROSE is core's question, and answering it in the lexer would hide the span from the one
		// layer that can decide.
		fixtures: {
			[PYTHON]: {
				files: { "src/tool.py": "#!/usr/bin/env python3\n# real\n\n\ndef work():\n\treturn 1\n" },
				subject: "src/tool.py",
				comments: ["#!/usr/bin/env python3", "# real"],
			},
			[GDSCRIPT]: {
				files: { "src/tool.gd": "#!/usr/bin/env godot\n# real\n\nfunc work():\n\treturn 1\n" },
				subject: "src/tool.gd",
				comments: ["#!/usr/bin/env godot", "# real"],
			},
		},
	},
	{
		id: "an-unterminated-block-comment-does-not-swallow-the-file",
		tier: "comments",
		about: "A block opened and never closed is reported once, not as many spans or none.",
		// No trailing newline after the opener, so "consumes to EOF" has exactly one spelling. With
		// one, a provider including the final newline and one excluding it would both be arguably
		// right and the case would be asserting the corpus author's guess.
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/open.ts": "export const before = 1;\n/* opened and never closed" },
				subject: "src/open.ts",
			},
			[REFERENCE]: {
				files: { "src/open.ref": "export const before = 1;\n/* opened and never closed" },
				subject: "src/open.ref",
			},
			[C]: {
				files: { "src/open.c": "int before = 1;\n/* opened and never closed" },
				subject: "src/open.c",
			},
			[CPP]: {
				files: { "src/open.cpp": "int before = 1;\n/* opened and never closed" },
				subject: "src/open.cpp",
			},
			[CSHARP]: {
				files: { "src/Open.cs": "public class Open { }\n/* opened and never closed" },
				subject: "src/Open.cs",
			},
			[RUST]: {
				files: { "src/open.rs": "pub const BEFORE: i32 = 1;\n/* opened and never closed" },
				subject: "src/open.rs",
			},
			[KOTLIN]: {
				files: { "src/Open.kt": "val before = 1\n/* opened and never closed" },
				subject: "src/Open.kt",
			},
		},
		comments: ["/* opened and never closed"],
	},
	{
		id: "nested-block-comments-follow-the-language",
		tier: "comments",
		about: "Rust and Kotlin nest block comments; the outer span runs to the LAST close, not the first.",
		// Only the languages whose spec nests. C-family stops at the first `*/`, so the same fixture
		// would assert opposite truths and belongs in its own case rather than this one.
		fixtures: {
			[RUST]: {
				files: { "src/nest.rs": "/* outer /* inner */ still outer */\npub const AFTER: i32 = 1;\n" },
				subject: "src/nest.rs",
			},
			[KOTLIN]: {
				files: { "src/Nest.kt": "/* outer /* inner */ still outer */\nval after = 1\n" },
				subject: "src/Nest.kt",
			},
		},
		comments: ["/* outer /* inner */ still outer */"],
	},
	{
		id: "an-unnested-block-comment-ends-at-the-first-close",
		tier: "comments",
		about: "C-family blocks do not nest, so the span ends at the first close and code resumes after it.",
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/nest.ts": "/* outer /* inner */\nexport const after = 1;\n" },
				subject: "src/nest.ts",
			},
			[REFERENCE]: {
				files: { "src/nest.ref": "/* outer /* inner */\nexport const after = 1;\n" },
				subject: "src/nest.ref",
			},
			[C]: { files: { "src/nest.c": "/* outer /* inner */\nint after = 1;\n" }, subject: "src/nest.c" },
			[CPP]: { files: { "src/nest.cpp": "/* outer /* inner */\nint after = 1;\n" }, subject: "src/nest.cpp" },
			[CSHARP]: {
				files: { "src/Nest.cs": "/* outer /* inner */\npublic class Nest { }\n" },
				subject: "src/Nest.cs",
			},
		},
		comments: ["/* outer /* inner */"],
	},
	{
		id: "a-byte-order-mark-shifts-no-span",
		tier: "comments",
		// The suite checks EVERY reported span's range against the source, so a provider parsing
		// stripped text while the core indexes the file fails here rather than in a search result.
		about: "A leading byte order mark moves no span, so a comment still cuts its own text out of the file.",
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/bom.ts": `${BOM}// a note\nexport const after = 1;\n` },
				subject: "src/bom.ts",
				comments: ["// a note"],
			},
			[REFERENCE]: {
				files: { "src/bom.ref": `${BOM}// a note\nexport const after = 1;\n` },
				subject: "src/bom.ref",
				comments: ["// a note"],
			},
			[PYTHON]: {
				files: { "src/bom.py": `${BOM}# a note\nafter = 1\n` },
				subject: "src/bom.py",
				comments: ["# a note"],
			},
			[GDSCRIPT]: {
				files: { "src/bom.gd": `${BOM}# a note\nvar after = 1\n` },
				subject: "src/bom.gd",
				comments: ["# a note"],
			},
			[C]: {
				files: { "src/bom.c": `${BOM}// a note\nint after = 1;\n` },
				subject: "src/bom.c",
				comments: ["// a note"],
			},
			[CPP]: {
				files: { "src/bom.cpp": `${BOM}// a note\nint after = 1;\n` },
				subject: "src/bom.cpp",
				comments: ["// a note"],
			},
			[CSHARP]: {
				files: { "src/Bom.cs": `${BOM}// a note\npublic class Bom { }\n` },
				subject: "src/Bom.cs",
				comments: ["// a note"],
			},
			[RUST]: {
				files: { "src/bom.rs": `${BOM}// a note\npub const AFTER: i32 = 1;\n` },
				subject: "src/bom.rs",
				comments: ["// a note"],
			},
			[KOTLIN]: {
				files: { "src/Bom.kt": `${BOM}// a note\nval after = 1\n` },
				subject: "src/Bom.kt",
				comments: ["// a note"],
			},
			[JSON_LANG]: {
				files: { "bom.jsonc": `${BOM}// a note\n{ "after": 1 }\n` },
				subject: "bom.jsonc",
				comments: ["// a note"],
			},
			[YAML]: {
				files: { "bom.yml": `${BOM}# a note\nafter: 1\n` },
				subject: "bom.yml",
				comments: ["# a note"],
			},
			[XML]: {
				files: { "bom.xml": `${BOM}<!-- a note -->\n<root after="1"/>\n` },
				subject: "bom.xml",
				comments: ["<!-- a note -->"],
			},
			[HTML]: {
				files: { "bom.html": `${BOM}<!-- a note -->\n<p after="1"></p>\n` },
				subject: "bom.html",
				comments: ["<!-- a note -->"],
			},
		},
	},
	{
		id: "broken-syntax-is-an-error-diagnostic",
		tier: "syntaxDiagnostics",
		about: "A provider claiming syntax diagnostics reports an error for text that cannot parse.",
		// Unambiguously invalid under any reading, so a lenient extractor that recovers and reports
		// nothing fails here rather than passing on silence.
		fixtures: {
			[TYPESCRIPT]: { files: { "src/broken.ts": "export function add( {\n" }, subject: "src/broken.ts" },
			[REFERENCE]: { files: { "src/broken.ref": "export class {\n" }, subject: "src/broken.ref" },
			[PYTHON]: { files: { "src/broken.py": "def add(:\n    pass\n" }, subject: "src/broken.py" },
			[GDSCRIPT]: { files: { "src/broken.gd": "func add(:\n\tpass\n" }, subject: "src/broken.gd" },
			[C]: { files: { "src/broken.c": "int add( {\n" }, subject: "src/broken.c" },
			[CPP]: { files: { "src/broken.cpp": "int add( {\n" }, subject: "src/broken.cpp" },
			[CSHARP]: { files: { "src/broken.cs": "public class {\n" }, subject: "src/broken.cs" },
			[RUST]: { files: { "src/broken.rs": "fn add( {\n" }, subject: "src/broken.rs" },
			[KOTLIN]: { files: { "src/Broken.kt": "fun add( {\n" }, subject: "src/Broken.kt" },
			// Markdown prose cannot fail, so the only syntax a document can get wrong is its
			// frontmatter. A provider claiming the tier has to report there or nowhere.
			[MARKDOWN]: { files: { "broken.md": "---\na: [1,\n---\n\n# Body\n" }, subject: "broken.md" },
			// A key with no value, which no dialect reads. A trailing comma or a comment is read and
			// noted instead, so neither belongs here.
			[JSON_LANG]: { files: { "broken.json": '{\n\t"a": \n}\n' }, subject: "broken.json" },
			[YAML]: { files: { "broken.yml": "a: [1,\n" }, subject: "broken.yml" },
		},
		parseErrors: "required",
	},
	{
		id: "import-resolves-to-module",
		tier: "imports",
		about: "A relative specifier resolves to a workspace-relative module path.",
		fixtures: {
			[TYPESCRIPT]: {
				files: {
					"src/cart.ts": 'import { Item } from "./item";\n',
					"src/item.ts": "export class Item {}\n",
				},
				subject: "src/cart.ts",
			},
			[PYTHON]: {
				files: {
					"src/cart.py": "from .item import Item\n",
					"src/item.py": "class Item:\n    pass\n",
				},
				subject: "src/cart.py",
				imports: [{ specifier: ".item", status: "resolved", module: "src/item.py" }],
			},
			// GDScript writes no specifier at all: the module is named by a literal path inside a
			// preload, and the local `Item` is a binding of the consumer's own choosing. The shared
			// sentence still holds, and only this language's spelling of it is unusual.
			[GDSCRIPT]: {
				files: {
					"project.godot": 'config_version=5\n\n[application]\nconfig/name="cart"\n',
					"src/item.gd": "class_name Item\nextends Node\n",
					"src/cart.gd": 'class_name Cart\nextends Node\n\nconst Item = preload("res://src/item.gd")\n',
				},
				subject: "src/cart.gd",
				imports: [{ specifier: "res://src/item.gd", status: "resolved", module: "src/item.gd" }],
			},
			[C]: {
				files: {
					"src/cart.c": '#include "item.h"\n',
					"src/item.h": "struct Item { int value; };\n",
				},
				subject: "src/cart.c",
				imports: [{ specifier: "item.h", status: "resolved", module: "src/item.h" }],
			},
			[CPP]: {
				files: {
					"src/cart.cpp": '#include "item.hpp"\n',
					"src/item.hpp": "struct Item {};\n",
				},
				subject: "src/cart.cpp",
				imports: [{ specifier: "item.hpp", status: "resolved", module: "src/item.hpp" }],
			},
			// C# and Kotlin import a namespace or package, not a path, so resolution goes through the
			// provider's own parse of which workspace file declares that name.
			[CSHARP]: {
				files: {
					"src/cart.cs": "using Demo.Item;\nnamespace Demo { public class Cart { public Item Value; } }\n",
					"src/item.cs": "namespace Demo.Item { public class Item {} }\n",
				},
				subject: "src/cart.cs",
				imports: [{ specifier: "Demo.Item", status: "resolved", module: "src/item.cs" }],
			},
			[RUST]: {
				files: {
					"src/lib.rs": "pub mod item;\nuse crate::item::Item;\n",
					"src/item.rs": "pub struct Item;\n",
				},
				subject: "src/lib.rs",
				imports: [{ specifier: "crate::item::Item", status: "resolved", module: "src/item.rs" }],
			},
			[KOTLIN]: {
				files: {
					"src/Cart.kt": "package cart\nimport item.Item\nfun use(): Item = Item()\n",
					"src/Item.kt": "package item\nclass Item\n",
				},
				subject: "src/Cart.kt",
				imports: [{ specifier: "item.Item", status: "resolved", module: "src/Item.kt" }],
			},
		},
		imports: [{ specifier: "./item", status: "resolved", module: "src/item.ts" }],
	},
	{
		id: "import-external-is-not-unresolved",
		tier: "imports",
		about: "An installed dependency is external, which is a different answer from unresolved.",
		fixtures: {
			// The dependency is part of the fixture. Without it a provider is right to say unresolved,
			// and the case would be testing whether the runner's temp dir has node_modules.
			[TYPESCRIPT]: {
				files: {
					"src/cart.ts": 'import { z } from "zod";\n',
					"node_modules/zod/package.json": '{ "name": "zod", "version": "4.0.0", "types": "index.d.ts" }\n',
					"node_modules/zod/index.d.ts": "export declare const z: unknown;\n",
				},
				subject: "src/cart.ts",
			},
			// No vendored package needed: the standard library is the dependency every Python has, and
			// telling it apart from a missing one is the distinction this case exists to make.
			[PYTHON]: {
				files: { "src/cart.py": "import ast\n" },
				subject: "src/cart.py",
				imports: [{ specifier: "ast", status: "external" }],
			},
			// A scene is the GDScript case for this: it exists, it is really depended on, and it holds
			// no GDScript declaration, so calling it unresolved would report a present file as missing.
			[GDSCRIPT]: {
				files: {
					"project.godot": 'config_version=5\n\n[application]\nconfig/name="cart"\n',
					"src/enemy.tscn": '[gd_scene format=3]\n\n[node name="Enemy" type="Node2D"]\n',
					"src/cart.gd": 'class_name Cart\nextends Node\n\nconst Enemy = preload("res://src/enemy.tscn")\n',
				},
				subject: "src/cart.gd",
				imports: [{ specifier: "res://src/enemy.tscn", status: "external" }],
			},
			// The C-family standard headers and the Rust/Kotlin standard libraries are the dependency
			// every toolchain has, same reasoning as Python's ast above.
			[C]: {
				files: { "src/cart.c": "#include <stdio.h>\n" },
				subject: "src/cart.c",
				imports: [{ specifier: "stdio.h", status: "external" }],
			},
			[CPP]: {
				files: { "src/cart.cpp": "#include <vector>\n" },
				subject: "src/cart.cpp",
				imports: [{ specifier: "vector", status: "external" }],
			},
			[CSHARP]: {
				files: { "src/cart.cs": "using System;\npublic class Cart {}\n" },
				subject: "src/cart.cs",
				imports: [{ specifier: "System", status: "external" }],
			},
			[RUST]: {
				files: { "src/lib.rs": "use std::collections::HashMap;\n" },
				subject: "src/lib.rs",
				imports: [{ specifier: "std::collections::HashMap", status: "external" }],
			},
			[KOTLIN]: {
				files: {
					"src/Cart.kt":
						"package cart\nimport kotlin.collections.List\nval items: List<String> = emptyList()\n",
				},
				subject: "src/Cart.kt",
				imports: [{ specifier: "kotlin.collections.List", status: "external" }],
			},
		},
		imports: [{ specifier: "zod", status: "external" }],
	},
	{
		id: "import-missing-is-unresolved",
		tier: "imports",
		about: "A specifier nothing satisfies is unresolved, which is a finding rather than an error.",
		fixtures: {
			[TYPESCRIPT]: { files: { "src/cart.ts": 'import { gone } from "./gone";\n' }, subject: "src/cart.ts" },
			[PYTHON]: {
				files: { "src/cart.py": "from .gone import gone\n" },
				subject: "src/cart.py",
				imports: [{ specifier: ".gone", status: "unresolved" }],
			},
			[GDSCRIPT]: {
				files: {
					"project.godot": 'config_version=5\n\n[application]\nconfig/name="cart"\n',
					"src/cart.gd": 'class_name Cart\nextends Node\n\nconst Gone = preload("res://src/gone.gd")\n',
				},
				subject: "src/cart.gd",
				imports: [{ specifier: "res://src/gone.gd", status: "unresolved" }],
			},
			[C]: {
				files: { "src/cart.c": '#include "gone.h"\n' },
				subject: "src/cart.c",
				imports: [{ specifier: "gone.h", status: "unresolved" }],
			},
			[CPP]: {
				files: { "src/cart.cpp": '#include "gone.hpp"\n' },
				subject: "src/cart.cpp",
				imports: [{ specifier: "gone.hpp", status: "unresolved" }],
			},
			[CSHARP]: {
				files: { "src/cart.cs": "using Missing.Namespace;\npublic class Cart {}\n" },
				subject: "src/cart.cs",
				imports: [{ specifier: "Missing.Namespace", status: "unresolved" }],
			},
			[RUST]: {
				files: { "src/lib.rs": "use crate::gone::Gone;\n" },
				subject: "src/lib.rs",
				imports: [{ specifier: "crate::gone::Gone", status: "unresolved" }],
			},
			[KOTLIN]: {
				files: { "src/Cart.kt": "package cart\nimport missing.Gone\nfun use(): Gone = Gone()\n" },
				subject: "src/Cart.kt",
				imports: [{ specifier: "missing.Gone", status: "unresolved" }],
			},
		},
		imports: [{ specifier: "./gone", status: "unresolved" }],
	},
	{
		id: "reference-binds-to-its-declaration",
		tier: "binding",
		about: "A use of a local declaration binds to it rather than merely matching by name.",
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/cart.ts": "export function add() {}\nexport function run() { add(); }\n" },
				subject: "src/cart.ts",
			},
			[PYTHON]: {
				files: { "src/cart.py": "def add():\n    pass\n\n\ndef run():\n    add()\n" },
				subject: "src/cart.py",
			},
			[GDSCRIPT]: {
				files: {
					"project.godot": 'config_version=5\n\n[application]\nconfig/name="cart"\n',
					"src/cart.gd":
						"class_name Cart\nextends Node\n\n\nfunc add() -> void:\n\tpass\n\n\nfunc run() -> void:\n\tadd()\n",
				},
				subject: "src/cart.gd",
			},
			[C]: {
				files: { "src/cart.c": "int add(void) { return 0; }\nint run(void) { return add(); }\n" },
				subject: "src/cart.c",
			},
			[CPP]: {
				files: { "src/cart.cpp": "int add() { return 0; }\nint run() { return add(); }\n" },
				subject: "src/cart.cpp",
			},
			[CSHARP]: {
				files: { "src/cart.cs": "public class Cart { public void add() {} public void run() { add(); } }\n" },
				subject: "src/cart.cs",
			},
			[RUST]: {
				files: { "src/lib.rs": "pub fn add() {}\npub fn run() { add(); }\n" },
				subject: "src/lib.rs",
			},
			[KOTLIN]: {
				files: { "src/Cart.kt": "package cart\nfun add() {}\nfun run() { add() }\n" },
				subject: "src/Cart.kt",
			},
		},
		references: [{ name: "add", status: "bound", bindsTo: "add" }],
	},
	{
		id: "type-of-annotated-constant",
		tier: "types",
		about: "An explicitly annotated declaration reports that type.",
		fixtures: {
			[TYPESCRIPT]: { files: { "src/cart.ts": "export const LIMIT: number = 1;\n" }, subject: "src/cart.ts" },
			// The display is per-fixture because `number` and `int` are one sentence in two spellings.
			[GDSCRIPT]: {
				files: { "src/cart.gd": "class_name Cart\nextends Node\n\nconst LIMIT: int = 1\n" },
				subject: "src/cart.gd",
				typeOf: { name: "LIMIT", display: "int" },
			},
			[C]: {
				files: { "src/cart.c": "const int LIMIT = 1;\n" },
				subject: "src/cart.c",
				typeOf: { name: "LIMIT", display: "int" },
			},
			[CPP]: {
				files: { "src/cart.cpp": "const int LIMIT = 1;\n" },
				subject: "src/cart.cpp",
				typeOf: { name: "LIMIT", display: "int" },
			},
			[CSHARP]: {
				files: { "src/cart.cs": "public class Cart { public const int LIMIT = 1; }\n" },
				subject: "src/cart.cs",
				typeOf: { name: "LIMIT", display: "int" },
			},
			[RUST]: {
				files: { "src/cart.rs": "pub const LIMIT: i32 = 1;\n" },
				subject: "src/cart.rs",
				typeOf: { name: "LIMIT", display: "i32" },
			},
			[KOTLIN]: {
				files: { "src/Cart.kt": "package cart\nconst val LIMIT: Int = 1\n" },
				subject: "src/Cart.kt",
				typeOf: { name: "LIMIT", display: "Int" },
			},
		},
		typeOf: { name: "LIMIT", display: "number" },
	},
	{
		id: "type-of-annotated-declaration",
		tier: "types",
		about: "An annotated declaration reports a KNOWN type, whatever each language spells it.",
		fixtures: {
			// Display text is deliberately not asserted here. `number`, `int` and `float` are the same
			// sentence in three languages, and pinning one spelling would make this a TypeScript case
			// wearing a shared name.
			[TYPESCRIPT]: { files: { "src/cart.ts": "export const LIMIT: number = 1;\n" }, subject: "src/cart.ts" },
			[PYTHON]: { files: { "src/cart.py": "LIMIT: int = 1\n" }, subject: "src/cart.py" },
			[GDSCRIPT]: {
				files: { "src/cart.gd": "class_name Cart\nextends Node\n\nconst LIMIT: int = 1\n" },
				subject: "src/cart.gd",
			},
			[C]: { files: { "src/cart.c": "const int LIMIT = 1;\n" }, subject: "src/cart.c" },
			[CPP]: { files: { "src/cart.cpp": "const int LIMIT = 1;\n" }, subject: "src/cart.cpp" },
			[CSHARP]: {
				files: { "src/cart.cs": "public class Cart { public const int LIMIT = 1; }\n" },
				subject: "src/cart.cs",
			},
			[RUST]: { files: { "src/cart.rs": "pub const LIMIT: i32 = 1;\n" }, subject: "src/cart.rs" },
			[KOTLIN]: { files: { "src/Cart.kt": "package cart\nconst val LIMIT: Int = 1\n" }, subject: "src/Cart.kt" },
		},
		typeOf: { name: "LIMIT", status: "known" },
	},
	{
		id: "type-of-inferred-return-union",
		tier: "types",
		about: "Every return is joined, and the exact values survive when they are determinable.",
		fixtures: {
			// No display assertion anywhere here on purpose. Python spells this Literal['foo', 'bar',
			// 'baz'], TypeScript spells it "foo" | "bar" | "baz", and GDScript has no syntax for it at
			// all. What is actually shared is that no member was dropped.
			[TYPESCRIPT]: {
				files: {
					"src/cart.ts":
						'export function pick(a: boolean, b: boolean) {\n\tif (a) return "foo";\n\telse if (b) return "bar";\n\treturn "baz";\n}\n',
				},
				subject: "src/cart.ts",
			},
			[PYTHON]: {
				files: {
					"src/cart.py":
						'def pick(a, b):\n    if a:\n        return "foo"\n    elif b:\n        return "bar"\n    return "baz"\n',
				},
				subject: "src/cart.py",
			},
			[GDSCRIPT]: {
				files: {
					"src/cart.gd":
						'class_name Cart\nextends Node\n\n\nfunc pick(a, b):\n\tif a:\n\t\treturn "foo"\n\telif b:\n\t\treturn "bar"\n\treturn "baz"\n',
				},
				subject: "src/cart.gd",
			},
		},
		typeOf: { name: "pick", status: "inferred", mentions: ["foo", "bar", "baz"] },
	},
	{
		id: "type-of-implicit-return",
		tier: "types",
		about: "A path that falls off the end returns nothing, and that is a member of the union.",
		fixtures: {
			// The member a naive implementation drops. Measured on the TypeScript checker, which
			// answers `"foo" | undefined` here, so the precise answer is the correct one.
			[TYPESCRIPT]: {
				files: { "src/cart.ts": 'export function maybe(a: boolean) {\n\tif (a) return "foo";\n}\n' },
				subject: "src/cart.ts",
				typeOf: { name: "maybe", status: "inferred", mentions: ["foo", "undefined"] },
			},
			[PYTHON]: {
				files: { "src/cart.py": 'def maybe(a):\n    if a:\n        return "foo"\n' },
				subject: "src/cart.py",
				typeOf: { name: "maybe", status: "inferred", mentions: ["foo", "None"] },
			},
			[GDSCRIPT]: {
				files: {
					"src/cart.gd": 'class_name Cart\nextends Node\n\n\nfunc maybe(a):\n\tif a:\n\t\treturn "foo"\n',
				},
				subject: "src/cart.gd",
				typeOf: { name: "maybe", status: "inferred", mentions: ["foo", "null"] },
			},
		},
		typeOf: { name: "maybe", status: "inferred", mentions: ["foo"] },
	},
	{
		id: "type-of-partial-inference-is-unknown",
		tier: "types",
		about: "One uninferrable branch makes the whole answer unknown, never a union of the rest.",
		fixtures: {
			// The honesty case. A caller cannot tell a complete union from a truncated one, so a
			// truncated one is worse than no answer at all.
			[PYTHON]: {
				files: {
					"src/cart.py": 'def pick(a, mystery):\n    if a:\n        return "foo"\n    return mystery()\n',
				},
				subject: "src/cart.py",
			},
			[GDSCRIPT]: {
				files: {
					"src/cart.gd":
						'class_name Cart\nextends Node\n\n\nfunc pick(a, mystery):\n\tif a:\n\t\treturn "foo"\n\treturn mystery.call()\n',
				},
				subject: "src/cart.gd",
			},
			// C++'s spelling of an uninferrable branch is a template-dependent return. The reason is
			// pinned so the provider must say WHY it does not know, not merely that it does not.
			[CPP]: {
				files: {
					"src/cart.cpp":
						"template <typename T> auto pick(bool choose, T mystery) { if (choose) return 1; return mystery(); }\n",
				},
				subject: "src/cart.cpp",
				typeOf: { name: "pick", status: "unknown", reason: "NotImplemented" },
			},
			[KOTLIN]: {
				files: {
					"src/Cart.kt":
						'package cart\nfun pick(flag: Boolean, mystery: () -> String) {\n\tif (flag) return "foo"\n\treturn mystery()\n}\n',
				},
				subject: "src/Cart.kt",
			},
		},
		typeOf: { name: "pick", status: "unknown" },
	},
	{
		id: "type-of-inferred-initializer",
		tier: "types",
		about: "An unannotated declaration takes its type from what it was assigned.",
		fixtures: {
			// This case used to assert `unknown`, back when Python and GDScript read annotations and
			// nothing else. Both now infer, so the old expectation was a test encoding the absence of
			// a feature, and it went red the moment the feature arrived, which is the test working.
			[TYPESCRIPT]: { files: { "src/cart.ts": "export const LIMIT = 1;\n" }, subject: "src/cart.ts" },
			[PYTHON]: { files: { "src/cart.py": "LIMIT = 1\n" }, subject: "src/cart.py" },
			[GDSCRIPT]: {
				files: { "src/cart.gd": "class_name Cart\nextends Node\n\nvar LIMIT = 1\n" },
				subject: "src/cart.gd",
			},
			// C has no fixture on purpose: an object declaration without a declared type is not C.
			[CPP]: { files: { "src/cart.cpp": "auto LIMIT = 1;\n" }, subject: "src/cart.cpp" },
			[CSHARP]: {
				files: { "src/cart.cs": "public class Cart { public void Initialize() { var LIMIT = 1; } }\n" },
				subject: "src/cart.cs",
			},
			[RUST]: { files: { "src/cart.rs": "pub const LIMIT = 1;\n" }, subject: "src/cart.rs" },
			[KOTLIN]: { files: { "src/Cart.kt": "package cart\nval LIMIT = 1\n" }, subject: "src/Cart.kt" },
		},
		// Status only. `inferred` is the whole claim: the source never said this, we concluded it,
		// and a consumer weighs that differently from an annotation it can go and read.
		typeOf: { name: "LIMIT", status: "inferred" },
	},
	{
		id: "document-headings-nest-by-level",
		tier: "docs",
		about: "Headings are declarations, and a deeper level is contained by the one above it.",
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "# Title\n\n## Development\n\n### Releasing\n\n## Verifying\n" },
				subject: "doc.md",
				declarations: [
					{ name: "Title", kind: "heading" },
					{ name: "Development", kind: "heading", container: "Title" },
					{ name: "Releasing", kind: "heading", container: "Development" },
					{ name: "Verifying", kind: "heading", container: "Title" },
				],
			},
		},
	},
	{
		id: "document-prose-belongs-to-the-heading-above-it",
		tier: "docs",
		about: "Prose anchors to the nearest heading above, and prose before any heading anchors to none.",
		// The whole reason this is a separate tier from comments: position decides, nothing resolves.
		fixtures: {
			[MARKDOWN]: {
				files: {
					"doc.md": "Preamble prose.\n\n# Title\n\nUnder the title.\n\n## Section\n\nUnder the section.\n",
				},
				subject: "doc.md",
				docs: [
					{ text: "Preamble prose." },
					{ text: "Under the title.", under: "Title" },
					{ text: "Under the section.", under: "Section" },
				],
			},
		},
	},
	{
		id: "document-fence-is-content-not-structure",
		tier: "docs",
		about: "A fenced block yields no heading, is marked fenced, and does not swallow the prose around it.",
		// A hash inside a fence is text. A scanner that misses this grows sections that do not exist,
		// and the tool that prompted this design has exactly that bug.
		fixtures: {
			[MARKDOWN]: {
				files: {
					"doc.md":
						"# Title\n\nBefore the fence.\n\n```bash\n## not a heading\nbun run build\n```\n\nAfter the fence.\n",
				},
				subject: "doc.md",
				declarations: [{ name: "Title", kind: "heading" }],
				declarationNames: ["Title"],
				docs: [
					{ text: "Before the fence.", under: "Title" },
					{ text: "## not a heading\nbun run build", under: "Title", fenced: true },
					{ text: "After the fence.", under: "Title" },
				],
			},
		},
	},
	{
		id: "document-without-headings-still-reports-its-prose",
		tier: "docs",
		about: "A file with no headings reports its prose anchored to no heading, rather than reporting nothing.",
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "Just prose, no headings at all.\n" },
				subject: "doc.md",
				declarations: [],
				docs: [{ text: "Just prose, no headings at all." }],
			},
		},
	},
	{
		id: "document-setext-headings-are-headings",
		tier: "docs",
		about: "A heading underlined with equals or dashes is a heading, and its level nests the same way.",
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "Title\n=====\n\nbody\n\nSub\n---\n\nmore\n" },
				subject: "doc.md",
				declarations: [
					{ name: "Title", kind: "heading" },
					{ name: "Sub", kind: "heading", container: "Title" },
				],
				docs: [
					{ text: "body", under: "Title" },
					{ text: "more", under: "Sub" },
				],
			},
		},
	},
	{
		id: "document-tilde-fence-is-fenced-too",
		tier: "docs",
		about: "A tilde fence is a fence, and a hash inside it is text rather than a section.",
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "# T\n\n~~~\n## not a heading\n~~~\n" },
				subject: "doc.md",
				declarations: [{ name: "T", kind: "heading" }],
				declarationNames: ["T"],
				docs: [{ text: "## not a heading", under: "T", fenced: true }],
			},
		},
	},
	{
		id: "document-longer-fence-holds-a-shorter-one",
		tier: "docs",
		about: "A fence closes on its own character at its own length, so an inner fence stays content.",
		// The failure this catches is a scanner ending the block at the first ``` it meets, which
		// then reads the rest of the example as document structure.
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "# T\n\n````md\n```js\nx\n```\n````\n" },
				subject: "doc.md",
				declarations: [{ name: "T", kind: "heading" }],
				declarationNames: ["T"],
				docs: [{ text: "```js\nx\n```", under: "T", fenced: true }],
			},
		},
	},
	{
		id: "document-indented-code-is-not-a-heading",
		tier: "docs",
		about: "Four spaces of indent is a code block whose hash is text, and which is not fenced.",
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "# T\n\n    ## indented code\n\nafter\n" },
				subject: "doc.md",
				declarations: [{ name: "T", kind: "heading" }],
				declarationNames: ["T"],
				docs: [
					{ text: "    ## indented code", under: "T" },
					{ text: "after", under: "T" },
				],
			},
		},
	},
	{
		id: "document-html-comment-holds-no-heading",
		tier: "docs",
		about: "A hash inside an HTML comment is text, and the comment itself stays searchable prose.",
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "# T\n\n<!-- ## not a heading -->\n\nafter\n" },
				subject: "doc.md",
				declarations: [{ name: "T", kind: "heading" }],
				declarationNames: ["T"],
				docs: [
					{ text: "<!-- ## not a heading -->", under: "T" },
					{ text: "after", under: "T" },
				],
			},
		},
	},
	{
		id: "document-quoted-and-listed-headings-stay-prose",
		tier: "docs",
		about: "A heading inside a blockquote or a list item is quoted material, not the document's own structure.",
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "# T\n\n> ## quoted\n> body\n\n- # listed\n- second\n" },
				subject: "doc.md",
				declarations: [{ name: "T", kind: "heading" }],
				declarationNames: ["T"],
				docs: [
					{ text: "> ## quoted\n> body", under: "T" },
					{ text: "- # listed\n- second", under: "T" },
				],
			},
		},
	},
	{
		id: "document-crlf-does-not-leak-into-prose",
		tier: "docs",
		about: "A carriage return terminates its line, so it ends a region rather than trailing inside one.",
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "# Title\r\n\r\nBefore.\r\n\r\n```sh\r\none\r\ntwo\r\n```\r\n\r\nAfter.\r\n" },
				subject: "doc.md",
				declarations: [{ name: "Title", kind: "heading" }],
				docs: [
					{ text: "Before.", under: "Title" },
					{ text: "one\r\ntwo", under: "Title", fenced: true },
					{ text: "After.", under: "Title" },
				],
			},
		},
	},
	{
		id: "document-frontmatter-is-data-not-a-heading",
		tier: "docs",
		about: "Frontmatter yields keys, never a section, and prose after it anchors to the first heading.",
		// Without the frontmatter extension the closing --- reads as a setext underline, so the
		// metadata becomes a heading. Mixed content in the commonest file there is.
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "---\ntitle: Rules\nmeta:\n  owner: nyaa\n---\n\n# Body\n\nText.\n" },
				subject: "doc.md",
				declarations: [
					{ name: "title", kind: "property" },
					{ name: "owner", kind: "property", container: "meta" },
					{ name: "Body", kind: "heading" },
				],
				// Exact, because the failure worth catching is the phantom heading the closing
				// delimiter becomes without the frontmatter extension.
				declarationNames: ["title", "meta", "owner", "Body"],
				docs: [{ text: "Text.", under: "Body" }],
			},
		},
	},
	{
		id: "document-byte-order-mark-shifts-nothing",
		tier: "docs",
		about: "A leading byte order mark moves no range, so a region still cuts its own text out of the file.",
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": `${BOM}# Title\n\nbody\n` },
				subject: "doc.md",
				declarations: [{ name: "Title", kind: "heading" }],
				declarationNames: ["Title"],
				docs: [{ text: "body", under: "Title" }],
			},
		},
	},
	{
		id: "document-repeated-sibling-headings-get-distinct-ids",
		tier: "docs",
		about: "Two same-named headings under one parent are two symbols, told apart by an occurrence.",
		fixtures: {
			[MARKDOWN]: {
				files: { "doc.md": "# Top\n\n## Notes\n\nfirst\n\n## Notes\n\nsecond\n" },
				subject: "doc.md",
				declarations: [
					{ name: "Notes", descriptors: ["namespace:Top", "namespace:Notes"] },
					{ name: "Notes", descriptors: ["namespace:Top", "namespace:Notes(2)"] },
				],
				declarationNames: ["Top", "Notes", "Notes"],
				docs: [
					{ text: "first", under: "Notes" },
					{ text: "second", under: "Notes" },
				],
			},
		},
	},
	{
		id: "data-keys-nest-by-container",
		tier: "declarations",
		about: "A key under a key is a declaration contained by it, at any depth.",
		fixtures: {
			[JSON_LANG]: {
				files: { "data.json": '{\n\t"meta": {\n\t\t"owner": "nyaa"\n\t}\n}\n' },
				subject: "data.json",
			},
			[YAML]: { files: { "data.yml": "meta:\n  owner: nyaa\n" }, subject: "data.yml" },
		},
		declarations: [
			{ name: "meta", kind: "property" },
			{ name: "owner", kind: "property", container: "meta" },
		],
	},
	{
		id: "data-array-elements-are-not-declarations",
		tier: "declarations",
		about: "An element has no name, so a sequence adds no declarations and its keys are the exact set.",
		// A walk treating every node as nameable mints an id from an index, and the id moves the moment
		// anything is inserted above it.
		fixtures: {
			[JSON_LANG]: {
				files: { "data.json": '{\n\t"tags": ["alpha", "beta"],\n\t"count": 2\n}\n' },
				subject: "data.json",
			},
			[YAML]: { files: { "data.yml": "tags:\n  - alpha\n  - beta\ncount: 2\n" }, subject: "data.yml" },
		},
		declarationNames: ["tags", "count"],
	},
	{
		id: "data-repeated-keys-under-a-sequence-get-distinct-ids",
		tier: "declarations",
		about: "A key repeated across sequence elements is one symbol per element, told apart by an ordinal.",
		// A walk that carries the element's ordinal no further than the element mints ONE id for every
		// sibling's `name`, and the store's last write wins, so a list of five services indexes as one.
		// A sequence of scalars cannot catch it: nothing under a scalar needs an id.
		fixtures: {
			[JSON_LANG]: {
				files: { "data.json": '{\n\t"items": [\n\t\t{ "name": "a" },\n\t\t{ "name": "b" }\n\t]\n}\n' },
				subject: "data.json",
			},
			[YAML]: { files: { "data.yml": "items:\n  - name: a\n  - name: b\n" }, subject: "data.yml" },
		},
		declarations: [
			{ name: "name", descriptors: ["term:items", "namespace:[0]", "term:name"] },
			{ name: "name", descriptors: ["term:items", "namespace:[1]", "term:name"] },
		],
	},
	{
		id: "data-a-sequence-of-mappings-still-has-keys",
		tier: "declarations",
		about: "Keys inside a sequence element are declarations, so a list of records is not one opaque key.",
		// The shape of a CI workflow, a compose file and an OpenAPI parameter list. A traversal that
		// stops at a sequence reports the outer key and nothing under it.
		fixtures: {
			[JSON_LANG]: {
				files: { "data.json": '{\n\t"steps": [\n\t\t{ "run": "build", "shell": "sh" }\n\t]\n}\n' },
				subject: "data.json",
			},
			[YAML]: { files: { "data.yml": "steps:\n  - run: build\n    shell: sh\n" }, subject: "data.yml" },
		},
		declarationNames: ["steps", "run", "shell"],
	},
	{
		id: "data-a-root-sequence-is-not-an-empty-file",
		tier: "declarations",
		about: "A file whose root is a sequence reports the keys under it, not nothing.",
		// A walk that needs a container before it will descend treats a root list as empty, so the file
		// is in scope, parses clean and carries no facts, which reads as a language with nothing in it.
		fixtures: {
			[JSON_LANG]: {
				files: { "data.json": '[\n\t{ "name": "a" },\n\t{ "name": "b" }\n]\n' },
				subject: "data.json",
			},
			[YAML]: { files: { "data.yml": "- name: a\n- name: b\n" }, subject: "data.yml" },
		},
		declarationNames: ["name", "name"],
	},
	{
		id: "data-an-alias-adds-no-second-copy-of-what-it-points-at",
		tier: "declarations",
		about: "An anchor is indexed where it is written, and the alias naming it adds a key, not a copy.",
		// Anchored to a MAPPING on purpose: expanding the alias would report `inner` a second time, so
		// the exact name list can see it. A scalar anchor would duplicate a LITERAL, which no case can
		// state, and the fixture would pass whether or not the copy happened.
		fixtures: {
			[YAML]: { files: { "data.yml": "base: &b\n  inner: 1\nuse: *b\n" }, subject: "data.yml" },
		},
		declarationNames: ["base", "inner", "use"],
	},
	{
		id: "data-a-second-document-is-read-and-is-not-an-error",
		tier: "declarations",
		about: "Every document in a multi-document file contributes its keys, and the file still parses.",
		// Reading only the first document loses the rest AND reports the file as broken, so a manifest
		// holding four resources indexes as one resource and a syntax error.
		fixtures: {
			[YAML]: { files: { "data.yml": "first: 1\n---\nsecond: 2\n" }, subject: "data.yml" },
		},
		declarationNames: ["first", "second"],
		parseErrors: "forbidden",
	},
	{
		id: "data-value-with-nowhere-to-go-keeps-its-key",
		tier: "declarations",
		about: "A key whose value this index cannot hold is still a declaration.",
		// Dropping the key with the value is the tempting shortcut, and it makes a configuration file
		// report fewer settings than it has.
		fixtures: {
			[JSON_LANG]: {
				files: { "data.json": '{\n\t"empty": null,\n\t"kept": 1\n}\n' },
				subject: "data.json",
			},
			[YAML]: { files: { "data.yml": "empty:\nblob: !!binary aGk=\nkept: 1\n" }, subject: "data.yml" },
		},
		declarations: [{ name: "empty", kind: "property" }],
	},
	{
		id: "data-json-reads-a-comment-and-notes-it",
		tier: "declarations",
		about: "A comment in a `.json` file is read, its keys are answered, and a note says the dialect lacks it.",
		// Refusing the file loses tsconfig.json and everything else commented under `.json`; reading
		// it silently hides that a strict reader would not. Both halves are required.
		fixtures: {
			[JSON_LANG]: { files: { "strict.json": '{\n\t// nope\n\t"a": 1,\n}\n' }, subject: "strict.json" },
		},
		declarations: [{ name: "a", kind: "property" }],
		parseErrors: "forbidden",
		notes: "required",
	},
	{
		id: "data-jsonc-has-nothing-to-note",
		tier: "declarations",
		about: "The same text under `.jsonc` is its own dialect, so it is read with no note.",
		fixtures: {
			[JSON_LANG]: { files: { "own.jsonc": '{\n\t// fine\n\t"a": 1,\n}\n' }, subject: "own.jsonc" },
		},
		declarations: [{ name: "a", kind: "property" }],
		parseErrors: "forbidden",
		notes: "forbidden",
	},
];

////////////////////////////////
//  Functions & Helpers

/**
 * The corpus, validated on read.
 *
 * Parsed rather than trusted so a malformed case fails here, where the message names the case,
 * instead of somewhere inside a provider run where it looks like the provider's fault.
 */
export function loadCorpus(): ConformanceCase[] {
	return [...CASES, stringFormCase(), repeatedNamePathCase(), ...markupCases()].map((testCase) =>
		ConformanceCaseSchema.parse(testCase),
	);
}

/** Cases for one tier, which is how a provider team runs only what it claims. */
export function casesForTier(tier: string): ConformanceCase[] {
	return loadCorpus().filter((testCase) => testCase.tier === tier);
}

/** Every language the corpus can currently speak, for a report that names what it does not. */
export function corpusLanguages(): string[] {
	const seen = new Set<string>();
	for (const testCase of loadCorpus()) for (const language of Object.keys(testCase.fixtures)) seen.add(language);
	return [...seen].sort();
}
