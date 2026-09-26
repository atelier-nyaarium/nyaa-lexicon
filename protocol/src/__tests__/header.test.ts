import { describe, expect, test } from "bun:test";
import type { OffsetRange } from "../coordinates.js";
import { FOLD_MARK, type HeaderSpan, renderHeader } from "../header.js";

/** Every occurrence of `part` in `text`, as a span. */
function spansOf(text: string, part: string): OffsetRange[] {
	const spans: OffsetRange[] = [];
	for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + 1)) {
		spans.push({ start: at, end: at + part.length });
	}
	return spans;
}

function whole(text: string, extra: Omit<HeaderSpan, "start" | "end"> = {}) {
	return renderHeader(text, { start: 0, end: text.length, ...extra });
}

describe("a header as one line", () => {
	test("a broken parameter list joins tight and loses its trailing comma", () => {
		const text = "export async function add(\n\tleft: number,\n\tright: number,\n): Promise<number> ";
		expect(whole(text)).toBe("export async function add(left: number, right: number): Promise<number>");
	});

	test("spacing written on one line is kept, collapsed", () => {
		expect(whole("int  add( int a )  const")).toBe("int add( int a ) const");
		expect(whole("type T = {\n\ta: string;\n\tb: number;\n}")).toBe("type T = { a: string; b: number; }");
	});

	test("a folded container keeps its delimiters, and an empty one stays as written", () => {
		const text = "TABLE = [\n\t{ a: 1 }, // one\n\t2,\n] + {} + ( )";
		const folds = ["[\n\t{ a: 1 }, // one\n\t2,\n]", "{ a: 1 }", "{}", "( )"].flatMap((part) =>
			spansOf(text, part),
		);
		const omit = spansOf(text, "// one");
		expect(whole(text, { folds, omit })).toBe(`TABLE = [${FOLD_MARK}] + {} + ()`);
	});

	test("a comment before punctuation leaves no space, and a broken line joins tight before one", () => {
		const text = "f(a /* x */, b /* y */) // z\n\t.then(c\n\t, d)";
		const omit = ["/* x */", "/* y */", "// z"].flatMap((part) => spansOf(text, part));
		expect(whole(text, { omit })).toBe("f(a, b).then(c, d)");
	});

	test("a bare fold reads as the mark alone, and an empty one as a space", () => {
		const text = "var handler = func(value):\n\treturn value\nvar call = run(func(): return 1)";
		const folds = [...spansOf(text, "return value"), ...spansOf(text, "return 1")].map((range) => ({
			...range,
			bare: true,
		}));
		const first = text.indexOf("\nvar call");
		expect(renderHeader(text, { start: 0, end: first, folds })).toBe(`var handler = func(value): ${FOLD_MARK}`);
		expect(renderHeader(text, { start: first + 1, end: text.length, folds })).toBe(
			`var call = run(func(): ${FOLD_MARK})`,
		);
		const empty = "run(func():  )";
		const gap = empty.indexOf("  ");
		expect(whole(empty, { folds: [{ start: gap, end: gap + 2, bare: true }] })).toBe("run(func(): )");
	});

	test("a broken line before a bare fold's closer joins tight", () => {
		const text = "var call = run(func():\n\treturn 1\n)";
		const folds = spansOf(text, "return 1").map((range) => ({ ...range, bare: true }));
		expect(whole(text, { folds })).toBe(`var call = run(func(): ${FOLD_MARK})`);
	});

	test("omitted text reads as a space, and cuts outside the span are ignored", () => {
		const text = "/** doc */\n@sealed // why\nclass Box /* inline */ extends Base";
		const start = text.indexOf("@");
		const omit = [...spansOf(text, "/** doc */"), ...spansOf(text, "// why"), ...spansOf(text, "/* inline */")];
		expect(renderHeader(text, { start, end: text.length, omit })).toBe("@sealed class Box extends Base");
	});

	test("a terminator is never part of the header", () => {
		expect(whole("private readonly size: number = 3;")).toBe("private readonly size: number = 3");
		expect(whole("int x ;\n")).toBe("int x");
	});

	test("nothing left is no header", () => {
		expect(whole("  \n\t")).toBeUndefined();
		expect(whole("// only\n", { omit: [{ start: 0, end: 7 }] })).toBeUndefined();
	});

	test("a literal keeps its spacing, with line breaks and tabs escaped, and still folds inside a container", () => {
		const mark = String.fromCodePoint(0xe000);
		const text = `const SEP = "a  b;" + \`one\r\n  two\t${mark}\` + /x  y/ + [\n\t"in  side",\n];`;
		const verbatim = ['"a  b;"', `\`one\r\n  two\t${mark}\``, "/x  y/", '"in  side"'].flatMap((part) =>
			spansOf(text, part),
		);
		const folds = spansOf(text, '[\n\t"in  side",\n]');
		expect(whole(text, { verbatim, folds })).toBe(
			`const SEP = "a  b;" + \`one\\n  two\\t${mark}\` + /x  y/ + [${FOLD_MARK}]`,
		);
	});

	test("a lead renders before the span, and what lies between them is not read", () => {
		const text = `let a = 1, /* skipped */ b = [\n\t2,\n];`;
		const lead = { start: 0, end: 3 };
		const start = text.indexOf("b");
		const folds = spansOf(text, "[\n\t2,\n]");
		expect(renderHeader(text, { lead, start, end: text.length - 1, folds })).toBe(`let b = [${FOLD_MARK}]`);
	});
});
