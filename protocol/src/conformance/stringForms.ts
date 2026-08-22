// String forms per language, each holding comment-shaped text, beside real comments.
// A comment is what is NOT a string, so a hole in a string grammar is a comment that is not there.

import type { ConformanceCase, ConformanceFixture } from "./types.js";

////////////////////////////////
//  Interfaces & Types

interface Forms {
	subject: string;
	/** The real comments, in the language's own syntax, placed first, in the middle and last. */
	real: [string, string, string];
	/** One string form per line, each holding a marker. */
	lines: string[];
	/** Wraps the lines, for a language whose fields live inside a declaration. */
	wrap?: (body: string) => string;
}

////////////////////////////////
//  Constants

const SLASH_REAL: [string, string, string] = ["// real one", "/* real two */", "// real three"];
const HASH_REAL: [string, string, string] = ["# real one", "# real two", "# real three"];

const C_LINES = [
	'const char *a = "// MARK a";',
	'const char *b = "/* MARK b */";',
	'const char *c = "split " "// MARK c";',
	'const char *d = "quote \\" // MARK d";',
	"char e = '\"';",
	"char f = '\\'';",
	'const char *g = "line \\\n// MARK g";',
];

/** Keyed by the language a provider reports at initialize. */
const FORMS: Record<string, Forms> = {
	reference: {
		subject: "src/forms.ref",
		real: SLASH_REAL,
		lines: [
			'export const a = "// MARK a";',
			"export const b = '/* MARK b */';",
			"export const c = `// MARK c`;",
			'export const d = "quote \\" // MARK d";',
		],
	},
	typescript: {
		subject: "src/forms.ts",
		real: SLASH_REAL,
		lines: [
			'export const a = "// MARK a";',
			"export const b = '/* MARK b */';",
			"export const c = `// MARK c ${a} /* MARK d */`;",
			"export const e = `\n// MARK e\n`;",
			'export const f = "quote \\" // MARK f";',
			"export const g = '\\' /* MARK g */';",
			'export const h = `${"// MARK h"}`;',
			"export const i = `\\` // MARK i`;",
			"export const r = /a\\/* MARK r/;",
			"export const j = `${`// MARK j ${a}`}`;",
		],
	},
	python: {
		subject: "src/forms.py",
		real: HASH_REAL,
		lines: [
			'a = "# MARK a"',
			"b = '# MARK b'",
			'c = """\n# MARK c\n"""',
			"d = '''# MARK d'''",
			'e = f"# MARK e {a}"',
			'f = r"# MARK f"',
			'g = b"# MARK g"',
			'h = "quote \\" # MARK h"',
			'i = ("adjacent " "# MARK i")',
			'j = f"{a!r} # MARK j"',
			"k = f\"{'# MARK k'}\"",
			'l = rb"# MARK l"',
			'm = ("first # MARK m"\n\t"second # MARK n")',
		],
	},
	gdscript: {
		subject: "src/forms.gd",
		real: HASH_REAL,
		lines: [
			'var a = "# MARK a"',
			"var b = '# MARK b'",
			'var c = """\n# MARK c\n"""',
			'var d = &"# MARK d"',
			'var e = ^"# MARK e"',
			'var f = r"# MARK f"',
			'var g = "quote \\" # MARK g"',
			"var h = '''# MARK h'''",
			'var i = "%s # MARK i" % a',
			'var j = $"# MARK j"',
		],
	},
	c: { subject: "src/forms.c", real: SLASH_REAL, lines: C_LINES },
	cpp: {
		subject: "src/forms.cpp",
		real: SLASH_REAL,
		lines: [
			...C_LINES,
			'const char *h = R"(// MARK h /* MARK i */)";',
			'const char *j = R"xy(// MARK j)xy";',
			'const char *k = u8"// MARK k";',
			'const wchar_t *l = L"/* MARK l */";',
			'const char *m = R"x(// )" MARK m)x";',
		],
	},
	csharp: {
		subject: "src/Forms.cs",
		real: SLASH_REAL,
		wrap: (body) => `public class Forms {\n${body}\n}\n`,
		lines: [
			'\tpublic string A = "// MARK a";',
			'\tpublic string B = @"/* MARK b */ "" // MARK c";',
			'\tpublic string C = $"// MARK d {1}";',
			'\tpublic string D = $"{1:N2} /* MARK e */";',
			'\tpublic string E = $@"// MARK f {1}";',
			'\tpublic string F = @$"/* MARK g */";',
			'\tpublic string G = "quote \\" // MARK h";',
			'\tpublic string H = $"{(true ? "// MARK i" : "x")}";',
			"\tpublic char I = '\"';",
			'\tpublic string J = """\n\t\t// MARK j\n\t\t""";',
			'\tpublic string K = $$"""{{1}} // MARK k""";',
			'\tpublic string L = """"has """ inside // MARK l"""";',
			"\tpublic char M = '\\'';",
		],
	},
	rust: {
		subject: "src/forms.rs",
		real: SLASH_REAL,
		lines: [
			'pub const A: &str = "// MARK a";',
			'pub const B: &str = r"/* MARK b */";',
			'pub const C: &str = r#"// MARK c "#;',
			'pub const D: &[u8] = b"// MARK d";',
			"pub const E: char = '\"';",
			'pub const F: &str = "quote \\" // MARK f";',
			'pub const G: &str = "line\n// MARK g";',
			'pub const H: &str = r##"// MARK h "# "##;',
			"pub const I: char = '\\'';",
			"pub fn life<'a>(x: &'a str) -> &'a str { x }",
			'pub const J: &std::ffi::CStr = c"// MARK j";',
			"pub const K: u8 = b'\\'';",
			'pub const L: &\'static str = "// MARK l";',
		],
	},
	kotlin: {
		subject: "src/Forms.kt",
		real: SLASH_REAL,
		lines: [
			'val a = "// MARK a"',
			'val b = "/* MARK b */"',
			'val c = """\n// MARK c\n"""',
			'val d = "$a // MARK d"',
			'val e = "${a} /* MARK e */"',
			'val f = "${"// MARK f"}"',
			'val g = "quote \\" // MARK g"',
			"val h = '\"'",
			'val i = """${"// MARK i"}"""',
			'val j = "${"${a}"} // MARK j"',
			'val k = """${\'$\'}// MARK k"""',
		],
	},
	json: {
		subject: "forms.jsonc",
		real: SLASH_REAL,
		wrap: (body) => `{\n${body}\n}\n`,
		lines: [
			'\t"a": "// MARK a",',
			'\t"b": "/* MARK b */",',
			'\t"c": "quote \\" // MARK c",',
			'\t"d": "\\\\// MARK d",',
			'\t"f": "ends \\\\",',
			'\t"e": 1',
		],
	},
	yaml: {
		subject: "forms.yml",
		real: HASH_REAL,
		lines: [
			'a: "# MARK a"',
			"b: '# MARK b'",
			"c: plain#MARK-c",
			"d: |\n  # MARK d",
			"e: >\n  # MARK e",
			'f: "quote \\" # MARK f"',
			"g: 'it''s # MARK g'",
			"h: [\"# MARK h\", '# MARK i']",
			'i: "multi\n  # MARK j"',
			'"# k": 1',
			'l: {m: "# MARK l"}',
		],
	},
};

////////////////////////////////
//  Functions & Helpers

function fixtureOf(forms: Forms): ConformanceFixture {
	const half = Math.ceil(forms.lines.length / 2);
	const body = [forms.real[0], ...forms.lines.slice(0, half), forms.real[1], ...forms.lines.slice(half)].join("\n");
	const wrapped = forms.wrap === undefined ? `${body}\n` : forms.wrap(body);
	return {
		files: { [forms.subject]: `${wrapped}${forms.real[2]}\n` },
		subject: forms.subject,
		comments: [...forms.real],
	};
}

/** Every fixture holds a real comment, so a provider reporting nothing still fails. */
export function stringFormCase(): ConformanceCase {
	return {
		id: "a-comment-marker-inside-any-string-form-is-not-a-comment",
		tier: "comments",
		about: "Text shaped like a comment inside every string form a language has is a string, and the real comments beside it are still reported.",
		fixtures: Object.fromEntries(Object.entries(FORMS).map(([language, forms]) => [language, fixtureOf(forms)])),
	};
}
