import { describe, expect, test } from "bun:test";
import { FOLD_MARK } from "@nyaa-lexicon/protocol";
import { headerOf } from "../header.js";
import { parseCppFile } from "../parser.js";
import { tokenize } from "../tokens.js";

function signatures(lines: string[]): Map<string, string | undefined> {
	const facts = parseCppFile("header.cpp", lines.join("\n"));
	return new Map(facts.declarations.map((declaration) => [declaration.name, declaration.signature]));
}

function folded(open: string, close: string): string {
	return `${open}${FOLD_MARK}${close}`;
}

describe("C++ declaration headers", () => {
	test("a multi-line parameter list joins on one line without its comments", () => {
		const found = signatures([
			"[[nodiscard]] static int area(",
			"\tint scale, // wide",
			"\tint bias /* narrow */",
			") noexcept;",
		]);
		expect(found.get("area")).toBe("[[nodiscard]] static int area(int scale, int bias) noexcept");
		expect(found.get("scale")).toBe("int scale");
		expect(found.get("bias")).toBe("int bias");
	});

	test("return types, qualifiers and defaulted bodies read as written", () => {
		const found = signatures([
			"struct Point {",
			"\tstd::vector<int> const& items() const;",
			"\tauto norm() const -> double;",
			"\tvirtual ~Point() = default;",
			"};",
			"int Point::sum(",
			"\tstd::vector<int> values",
			") noexcept",
			"{",
			"\treturn 0;",
			"}",
		]);
		expect(found.get("items")).toBe("std::vector<int> const& items() const");
		expect(found.get("norm")).toBe("auto norm() const -> double");
		expect(found.get("~Point")).toBe("virtual ~Point() = default");
		expect(found.get("sum")).toBe("int Point::sum(std::vector<int> values) noexcept");
	});

	test("attributes and a template prefix stay in the header", () => {
		const found = signatures([
			"template <typename T,",
			"\tint N = 3>",
			"__attribute__((always_inline)) inline T pick(T left) { return left; }",
		]);
		expect(found.get("pick")).toBe(
			"template <typename T, int N = 3> __attribute__((always_inline)) inline T pick(T left)",
		);
		expect(found.get("T")).toBe("typename T");
		expect(found.get("N")).toBe("int N = 3");
	});

	test("brace lists and lambda bodies written as values fold, an empty list stays", () => {
		const found = signatures([
			"struct Point {",
			"\tint x{0};",
			"\tint y{};",
			"\tstd::vector<int> v{1, 2};",
			"\tstatic constexpr int table[] = {",
			"\t\t1,",
			"\t\t2,",
			"\t};",
			"};",
			"auto square = [](int n) {",
			"\treturn n * n;",
			"};",
			"void fill(std::vector<int> values = {1, 2});",
		]);
		expect(found.get("x")).toBe(`int x${folded("{", "}")}`);
		expect(found.get("y")).toBe("int y{}");
		expect(found.get("v")).toBe(`std::vector<int> v${folded("{", "}")}`);
		expect(found.get("table")).toBe(`static constexpr int table[] = ${folded("{", "}")}`);
		expect(found.get("square")).toBe(`auto square = [](int n) ${folded("{", "}")}`);
		expect(found.get("fill")).toBe(`void fill(std::vector<int> values = ${folded("{", "}")})`);
		expect(found.get("values")).toBe(`std::vector<int> values = ${folded("{", "}")}`);
	});

	test("type heads end at their body and an alias folds only its aggregate body", () => {
		const found = signatures([
			"class Box final : public Base<int>,",
			"\tprivate Other {",
			"};",
			"enum class Color : unsigned char {",
			"\tRed = 1, // first",
			"\t/// Doc.",
			"\tBlue = 4",
			"};",
			"using Table = std::map<std::string, std::vector<int>>;",
			"typedef struct {",
			"\tint a;",
			"} Pair;",
			"typedef enum : int { A, B } Kind;",
			"using Holder = struct {",
			"\tint value;",
			"};",
		]);
		expect(found.get("Box")).toBe("class Box final : public Base<int>, private Other");
		expect(found.get("Color")).toBe("enum class Color : unsigned char");
		expect(found.get("Red")).toBe("Red = 1");
		expect(found.get("Blue")).toBe("Blue = 4");
		expect(found.get("Table")).toBe("using Table = std::map<std::string, std::vector<int>>");
		expect(found.get("Pair")).toBe(`typedef struct ${folded("{", "}")} Pair`);
		expect(found.get("Kind")).toBe(`typedef enum : int ${folded("{", "}")} Kind`);
		expect(found.get("Holder")).toBe(`using Holder = struct ${folded("{", "}")}`);
	});

	test("preprocessor lines and inactive branches are left out", () => {
		const found = signatures(["int open(", "#if 0", "\tlong flags", "#else", "\tint flags", "#endif", ");"]);
		expect(found.get("open")).toBe("int open(int flags)");
	});

	test("a literal keeps its spacing and escapes its line break and tab", () => {
		const found = signatures([
			'const char *SEP = "a  b";',
			'const char *DOC = R"(one',
			'  two)";',
			"char TAB = '\t';",
			'std::vector<std::string> WORDS = {"a  b"};',
		]);
		expect(found.get("SEP")).toBe('const char *SEP = "a  b"');
		expect(found.get("DOC")).toBe('const char *DOC = R"(one\\n  two)"');
		expect(found.get("TAB")).toBe("char TAB = '\\t'");
		expect(found.get("WORDS")).toBe(`std::vector<std::string> WORDS = ${folded("{", "}")}`);
	});

	test("a later declarator shares the specifiers and leaves out its siblings", () => {
		const facts = parseCppFile(
			"header.cpp",
			["struct A {};", 'static const char *A::x = "x", /* z */ A::z[] = {};'].join("\n"),
		);
		const byName = (name: string) => facts.declarations.find((declaration) => declaration.name === name);
		expect(byName("x")?.signature).toBe('static const char *A::x = "x"');
		expect(byName("z")?.signature).toBe("static const char A::z[] = {}");
		expect(byName("z")?.range.start).toEqual(byName("x")?.range.start);
	});

	test("renders a statement of many declarators in time linear in their count", () => {
		const timed = (count: number) => {
			const text = `int ${Array.from({ length: count }, (_, index) => `A::a${index} = ${index}`).join(", ")};\n`;
			const { tokens } = tokenize(text);
			const commas = tokens.flatMap((token, index) => (token.text === "," ? [index] : []));
			const ends = [...commas.slice(1), tokens.length];
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				commas.forEach((comma, at) => {
					headerOf(text, tokens, comma + 1, ends[at] as number, "value", { start: 0, end: 1 });
				});
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		// Linear reads 8x; a walk of every sibling per declarator reads 64x.
		expect(timed(4_000) / timed(500)).toBeLessThan(24);
	});
});
