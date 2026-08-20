import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { extractComments } from "../comments";
import { TypeScriptProvider } from "../main";

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

function comments(text: string, module = "src/a.ts") {
	const kind = module.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	return extractComments(ts.createSourceFile(module, text, ts.ScriptTarget.ESNext, true, kind));
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
		const text = 'const el = <div title="// not">text // not either</div>; // real\n';

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

describe("the comments tier on the wire", () => {
	it("carries comments with full facts, having declared the tier", () => {
		const text = "// leading\nexport const total = 42; // trailing\n";
		const root = workspace({ "src/a.ts": text });
		const provider = new TypeScriptProvider();
		const declared = provider.initialize(root);

		const facts = provider.parseFile({ module: "src/a.ts", contentHash: "a1", text });

		expect(declared.tiers.comments).toBe(true);
		expect("comments" in facts ? facts.comments.map((comment) => comment.text) : []).toEqual([
			"// leading",
			"// trailing",
		]);
	});

	it("claims nothing about comments at a depth that does not extract them", () => {
		const text = "// leading\nexport function work(): number {\n\treturn 1;\n}\n";
		const root = workspace({ "src/a.ts": text });
		const provider = new TypeScriptProvider();
		provider.initialize(root);

		const outline = provider.parseFile({ module: "src/a.ts", contentHash: "a1", text, depth: "outline" });
		const surface = provider.parseFile({ module: "src/a.ts", contentHash: "a1", text, depth: "surface" });

		expect("comments" in outline).toBe(false);
		expect("comments" in surface).toBe(false);
	});
});
