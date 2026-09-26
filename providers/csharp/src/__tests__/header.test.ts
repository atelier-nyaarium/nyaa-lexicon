import { describe, expect, test } from "bun:test";
import { FOLD_MARK } from "@nyaa-lexicon/protocol";
import { CsharpParser } from "../parser.js";

function fold(open: string, close: string): string {
	return `${open}${FOLD_MARK}${close}`;
}

/** Signatures by `kind name`, a repeat numbered from 2. */
function signatures(text: string, outline = false): Record<string, string | undefined> {
	const found: Record<string, string | undefined> = {};
	for (const item of new CsharpParser("Header.cs", text, outline).parse().declarations) {
		const key = `${item.kind} ${item.name}`;
		let repeat = 1;
		const numbered = () => (repeat === 1 ? key : `${key} ${repeat}`);
		while (numbered() in found) repeat++;
		found[numbered()] = item.signature;
	}
	return found;
}

const CALLABLES = [
	"namespace Geo",
	"{",
	"    /// <summary>Doc.</summary>",
	"    [Serializable] // why",
	"    /// late doc",
	"    [Obsolete]",
	"    public sealed class Box<T> : Base<T>,",
	"        IShape where T : new()",
	"    {",
	"        [Pure]",
	"        public async Task<int> Area(",
	"            int scale, // wide",
	"            /* note */ int bias)",
	"        {",
	"            return scale + bias;",
	"        }",
	"",
	"        public int Twice(int x) => x * 2;",
	"        public Box(int x) : base(new[] { x }, (x, x)) { }",
	"        public static Box<T> operator +(Box<T> left, Box<T> right) => left;",
	"        public void Split(",
	"#if false",
	"            int hidden,",
	"#else",
	"            long shown,",
	"#endif",
	"            int tail) { }",
	"    }",
	"",
	"    public delegate int Op(",
	"        int left,",
	"        int right);",
	"}",
	"",
].join("\n");

describe("C# signatures are whole headers on one line", () => {
	test("callables keep attributes, multi-line parameters and return types, without comments or directives", () => {
		expect(signatures(CALLABLES)).toMatchObject({
			"namespace Geo": "namespace Geo",
			"class Box": "[Serializable] [Obsolete] public sealed class Box<T> : Base<T>, IShape where T : new()",
			"method Area": "[Pure] public async Task<int> Area(int scale, int bias)",
			"method Twice": "public int Twice(int x)",
			"constructor Box": `public Box(int x) : base(new[] ${fold("{", "}")}, ${fold("(", ")")})`,
			"operator operator+": "public static Box<T> operator +(Box<T> left, Box<T> right)",
			"method Split": "public void Split(long shown, int tail)",
			"function Op": "public delegate int Op(int left, int right)",
		});
	});

	test("an outline reads the same headers", () => {
		expect(signatures(CALLABLES, true)).toEqual(signatures(CALLABLES));
	});

	test("members stop at their body and enum members keep their value", () => {
		const found = signatures(
			[
				"class Holder",
				"{",
				'    [Obsolete("old")]',
				"    public int Size { get; set; } = 3;",
				"    public int Count => items.Length;",
				"    public int this[int index] => items[index];",
				"    public event EventHandler Changed { add { } remove { } }",
				"    public event EventHandler Opened, Closed;",
				"    [NonSerialized] /* shared */ private int a = 1, b = 2;",
				"}",
				"",
				"[Flags]",
				"enum Color : byte",
				"{",
				'    [Description("r")] Red = 1 << 0,',
				"    Green,",
				"}",
				"",
			].join("\n"),
		);
		expect(found).toMatchObject({
			"property Size": '[Obsolete("old")] public int Size',
			"property Count": "public int Count",
			"property this": "public int this[int index]",
			"event Changed": "public event EventHandler Changed",
			"event Opened": "public event EventHandler Opened",
			"event Closed": "public event EventHandler Closed",
			"field a": "[NonSerialized] private int a = 1",
			"field b": "[NonSerialized] private int b = 2",
			"enum Color": "[Flags] enum Color : byte",
			"constant Red": '[Description("r")] Red = 1 << 0',
			"constant Green": "Green",
		});
	});

	test("values fold their literal containers and never a type, an attribute or an index", () => {
		const found = signatures(
			[
				"class Values",
				"{",
				"    private static readonly List<int> table = new() {",
				"        1,",
				"        2,",
				"    };",
				"    private List<int> list = [1, 2, 3];",
				"    private List<int> none = [];",
				"    private object anon = new { A = 1 };",
				"    private Func<int, int> twice = x => { return x * 2; };",
				"    private Func<int> tagged = [Marker] () => 1;",
				"    private object named = Make(items: [1], kind: typeof((int, int)), pair: (1, 2));",
				"    private Dictionary<int, (int, int)> map = new();",
				"    private int? first = values?[0];",
				"    private string mode = pick ? [1] : [2];",
				"    public void Take([Marker] int x, (int, int) pair) { }",
				"    public void Local()",
				"    {",
				"        var inner = new Dictionary<int, int> { [1] = 2 };",
				"    }",
				"}",
				"",
			].join("\n"),
		);
		const brace = fold("{", "}");
		const bracket = fold("[", "]");
		expect(found).toMatchObject({
			"field table": `private static readonly List<int> table = new() ${brace}`,
			"field list": `private List<int> list = ${bracket}`,
			"field none": "private List<int> none = []",
			"field anon": `private object anon = new ${brace}`,
			"field twice": `private Func<int, int> twice = x => ${brace}`,
			"field tagged": "private Func<int> tagged = [Marker] () => 1",
			"field named": `private object named = Make(items: ${bracket}, kind: typeof((int, int)), pair: ${fold("(", ")")})`,
			"field map": "private Dictionary<int, (int, int)> map = new()",
			"field first": "private int? first = values?[0]",
			"field mode": `private string mode = pick ? ${bracket} : ${bracket}`,
			"method Take": "public void Take([Marker] int x, (int, int) pair)",
			"variable inner": `var inner = new Dictionary<int, int> ${brace}`,
		});
	});

	test("literals keep their spacing and escape a line break", () => {
		const found = signatures(
			[
				"class Text",
				"{",
				'    public const string Doc = @"one',
				'  two";',
				"    public const char Tab = '\t';",
				'    [Note("wide  apart")] public static string Hole = $"{a}  {b ?? "c  d"}";',
				'    private string first = "p  q", second = @"r',
				's";',
				'    public void Take(string s = "w  x") { }',
				"}",
				"",
			].join("\n"),
		);
		expect(found).toMatchObject({
			"constant Doc": 'public const string Doc = @"one\\n  two"',
			"constant Tab": "public const char Tab = '\\t'",
			"field Hole": '[Note("wide  apart")] public static string Hole = $"{a}  {b ?? "c  d"}"',
			"field first": 'private string first = "p  q"',
			"field second": 'private string second = @"r\\ns"',
			"method Take": 'public void Take(string s = "w  x")',
		});
	});

	test("renders a statement of many declarators in time linear in their count", () => {
		const timed = (count: number) => {
			const names = Array.from({ length: count }, (_, index) => `a${index} = ${index}`);
			const text = `class C\n{\n    private int ${names.join(", ")};\n}\n`;
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				// Outline: headers without literal facts.
				new CsharpParser("Many.cs", text, true).parse();
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		// Linear reads 8x; a walk of every sibling per declarator read 64x.
		expect(timed(4_000) / timed(500)).toBeLessThan(24);
	});
});
