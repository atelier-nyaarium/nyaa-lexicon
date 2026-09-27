import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { extractTrivia } from "../comments";
import { harness } from "./harness.js";

////////////////////////////////
//  Helpers

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-comments-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function trivia(text: string, module = "src/a.ts") {
	const kind = module.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	return extractTrivia(ts.createSourceFile(module, text, ts.ScriptTarget.ESNext, true, kind));
}

function comments(text: string, module?: string) {
	return trivia(text, module).comments;
}

/** Each comment's text with whether code shares its first and last lines. */
function sharedOf(text: string, module?: string): [string, boolean | undefined, boolean | undefined][] {
	return comments(text, module).map((comment) => [comment.text, comment.codeBefore, comment.codeAfter]);
}

function textsOf(text: string, module?: string): string[] {
	return comments(text, module).map((comment) => comment.text);
}

/** Every span must slice back out of the source it claims to address. */
function slicedOf(text: string, module?: string): string[] {
	const coordinates = coordinatesOf(text);
	return comments(text, module).map((comment) => {
		const value = coordinates.sliceRange(comment.range);
		if (value === undefined) throw new Error(`unaddressable comment range: ${comment.text}`);
		return value;
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("comment spans", () => {
	it("reports every comment form, verbatim and once", () => {
		const text = [
			"// leading",
			"/** doc */",
			"export function work(first: number /* inline */, second: number): number {",
			"\t// inside",
			"\treturn first + second;",
			"}",
			"",
			"export const total = 42; // trailing",
			"",
			"/* standalone",
			"   over two lines */",
			"",
		].join("\n");

		expect(textsOf(text)).toEqual([
			"// leading",
			"/** doc */",
			"/* inline */",
			"// inside",
			"// trailing",
			"/* standalone\n   over two lines */",
		]);
	});

	it("reports an interpreter line, which only the first line can be", () => {
		expect(textsOf("#!/usr/bin/env node\n// real\nconsole.log(1);\n")).toEqual(["#!/usr/bin/env node", "// real"]);
		expect(textsOf("const a = 1;\n#!/usr/bin/env node\n")).toEqual([]);
	});

	it("does not report a marker written inside a string, template or regex", () => {
		const text = [
			'const url = "https://example.com/path";',
			'const block = "/* not a comment */";',
			"const quoted = 'it\\'s // fine';",
			`const template = \`no // comment \${url} /* nor this */\`;`,
			"const pattern = /a\\/\\/b/;",
			"const divided = 4 / 2 / 1;",
			"// real",
			"",
		].join("\n");

		expect(textsOf(text)).toEqual(["// real"]);
	});

	it("keeps a comment written inside a template substitution", () => {
		expect(textsOf(`const a = \`\${/* yes */ 1}\`; // real\n`)).toEqual(["/* yes */", "// real"]);
	});

	it("does not report JSX text or attribute values that read like markers", () => {
		const text = [
			'const el = <div title="// not">text // not either</div>; // real',
			"const opens = <p>// not at the start</p>;",
			"const wrapped = <p>",
			"\t/* not after a break */ text",
			"</p>;",
			"",
		].join("\n");

		expect(textsOf(text, "src/a.tsx")).toEqual(["// real"]);
	});

	it("runs an unterminated block to the end of the file as one span", () => {
		const text = "export const before = 1;\n/* opened and never closed";

		expect(textsOf(text)).toEqual(["/* opened and never closed"]);
		expect(slicedOf(text)).toEqual(["/* opened and never closed"]);
	});

	it("ends a block at the first close, since blocks do not nest here", () => {
		expect(textsOf("/* outer /* inner */\nexport const after = 1;\n")).toEqual(["/* outer /* inner */"]);
	});

	it("finds a comment that no declaration follows", () => {
		expect(textsOf("function f() {\n\treturn 1;\n\t// last words\n}\n// after\n")).toEqual([
			"// last words",
			"// after",
		]);
		expect(textsOf("function f(/* no parameters */) {}\n")).toEqual(["/* no parameters */"]);
	});

	it("still reports comments around text that cannot parse", () => {
		expect(textsOf("// leading\nexport function add( {\n// trailing\n")).toEqual(["// leading", "// trailing"]);
	});

	it("addresses spans in UTF-16 units, across wide characters and line breaks", () => {
		const text = 'const emoji = "\u{1F600}\u{1F600}"; // after wide characters\n/* block\n   over lines */\n';

		expect(slicedOf(text)).toEqual(textsOf(text));
		// 22, not 20: the pair of astral characters is four code units, not two.
		expect(comments(text)[0]?.range.start).toEqual({ line: 0, character: 22 });
	});
});

describe("code beside a comment", () => {
	it("says whether code shares a comment's first line before it and its last line after it", () => {
		const text = [
			"// own line",
			"export const a = 1; // trailing",
			"export const b = /* inline */ 2;",
			"/* first */ // second",
			"/* before */ export const c = 3;",
			"export const d = 4; /* spans",
			"   lines */ export const e = 5;",
			"/* alone",
			"   over lines */",
			"export const f = 6; // last, with no line break after",
		].join("\n");

		expect(sharedOf(text)).toEqual([
			["// own line", false, false],
			["// trailing", true, false],
			["/* inline */", true, true],
			["/* first */", false, false],
			["// second", false, false],
			["/* before */", false, true],
			["/* spans\n   lines */", true, true],
			["/* alone\n   over lines */", false, false],
			["// last, with no line break after", true, false],
		]);
	});

	it("reads a JSX brace or a substitution as code, and an interpreter line as alone", () => {
		expect(sharedOf("const el = <p>{/* note */}</p>;\n", "src/a.tsx")).toEqual([["/* note */", true, true]]);
		expect(sharedOf(`const t = \`\${/* hole */ 1}\`;\n`)).toEqual([["/* hole */", true, true]]);
		expect(sharedOf("#!/usr/bin/env node\nrun();\n")).toEqual([["#!/usr/bin/env node", false, false]]);
	});
});

describe("blank lines", () => {
	it("counts a line blank only when no token or comment touches it", () => {
		const text = [
			"export const a = 1;",
			"",
			"export const plain = `one",
			"",
			"two`;",
			`export const held = \`x \${a}`,
			"",
			`\${a} y\`;`,
			"/* block",
			"",
			"   comment */",
			"export const el = <p>one",
			"",
			"two</p>;",
			"export const layout = <div>",
			"",
			"\t<span />",
			"</div>;",
			"\t",
			"export const b = 2;",
			"",
		].join("\n");

		// JSX text is content, but whitespace between elements is layout.
		expect(trivia(text, "src/a.tsx").blankLines).toEqual([1, 15, 18]);
	});

	it("ends the last line at a final line break, and counts none in an empty file", () => {
		expect(trivia("a();\n").blankLines).toEqual([]);
		expect(trivia("a();\n\n").blankLines).toEqual([1]);
		expect(trivia("a();\r\n  ").blankLines).toEqual([1]);
		expect(trivia("").blankLines).toEqual([]);
	});
});

describe("the comments tier on the wire", () => {
	it("carries comments and blank lines with full facts, having declared the tier", () => {
		const text = "// leading\n\nexport const total = 42; // trailing\n";
		const root = workspace({ "src/a.ts": text });
		const provider = harness();
		const declared = provider.initialize(root);

		const facts = provider.parseFile({ module: "src/a.ts", contentHash: "a1", text });

		expect(declared.tiers.comments).toBe(true);
		expect("comments" in facts ? (facts.comments ?? []).map((comment) => comment.text) : []).toEqual([
			"// leading",
			"// trailing",
		]);
		expect("blankLines" in facts ? facts.blankLines : undefined).toEqual([1]);
	});

	it("reports no comments at a reduced depth, like the literals beside them", () => {
		const text = "// leading\nexport function work(): number {\n\treturn 1;\n}\n";
		const root = workspace({ "src/a.ts": text });
		const provider = harness();
		provider.initialize(root);

		const outline = provider.parseFile({ module: "src/a.ts", contentHash: "a1", text, depth: "outline" });
		const surface = provider.parseFile({ module: "src/a.ts", contentHash: "a1", text, depth: "surface" });

		// Absent would read as the tier being false, which this provider declares true.
		expect(outline.comments).toEqual([]);
		expect(surface.comments).toEqual([]);
		expect(outline.depth).toBe("outline");
	});
});
