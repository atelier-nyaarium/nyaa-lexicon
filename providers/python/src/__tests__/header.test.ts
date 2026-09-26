import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FOLD_MARK, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { PythonProvider, wireHandlers } from "../main";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Each declaration's signature by name, as the provider answers a parse. */
async function signatures(lines: string[]): Promise<Map<string, string | undefined>> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-python-header-"));
	roots.push(root);
	const handlers = wireHandlers(new PythonProvider());
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	const facts = await handlers.parseFile({ module: "src/header.py", contentHash: "hash", text: lines.join("\n") });
	return new Map(facts.declarations.map((declaration) => [declaration.name, declaration.signature]));
}

function fold(open: string, close: string): string {
	return `${open}${FOLD_MARK}${close}`;
}

describe("Python declaration headers", () => {
	it("renders a decorated, multi-line definition from its first decorator to its colon", async () => {
		const found = await signatures([
			"@dataclass(frozen=True)",
			"class Shape(",
			"    Base,",
			"    Mixin,",
			"):",
			'    """Doc."""',
			"",
			"    @staticmethod",
			"    async def scale(",
			"        width: int,",
			"        height: int = 2,",
			"    ) -> tuple[int, int]:",
			"        return width, height",
			"",
			"def inline(value): return value",
			"",
		]);

		expect(found.get("Shape")).toBe("@dataclass(frozen=True) class Shape(Base, Mixin):");
		expect(found.get("scale")).toBe(
			"@staticmethod async def scale(width: int, height: int = 2) -> tuple[int, int]:",
		);
		expect(found.get("inline")).toBe("def inline(value):");
		expect(found.has("width")).toBe(true);
		expect(found.get("width")).toBeUndefined();
	});

	it("folds literal containers written as values and leaves types, targets and calls whole", async () => {
		const found = await signatures([
			'@register(options=["a", "b"])',
			"def build(items=[1, 2], table={'k': 1}, *, pair=(1, 2), single=(1), empty=[],",
			"          hook: Callable[[int], str] = None) -> list[int]:",
			"    pass",
			"",
			"class Config(Base, fields={'a': 1}):",
			"    pass",
			"",
			"GRID: list[list[int]] = [",
			"    [1, 2],",
			"    [3, 4],",
			"]",
			"BARE = 1, 2",
			"PAIRED = (1), (2)",
			"WRAPPED = ((1), (2))",
			"SQUARES = {n: n * n for n in range(3)}",
			"TOTAL = sum(n for n in range(3))",
			"HANDLER = lambda value: {value: 1}",
			"ALIAS = Callable[[int], str]",
			'WIDE = pick("\u{1F600}", [1, 2])  # \u{1F600}',
			"LOGGER = logging.getLogger(",
			"    __name__,",
			")",
			"for index in enumerate([",
			'    "a",',
			"]):",
			"    pass",
			"",
		]);

		expect(found.get("build")).toBe(
			`@register(options=${fold("[", "]")}) def build(items=${fold("[", "]")}, table=${fold("{", "}")}, *, pair=${fold("(", ")")}, single=(1), empty=[], hook: Callable[[int], str] = None) -> list[int]:`,
		);
		expect(found.get("Config")).toBe(`class Config(Base, fields=${fold("{", "}")}):`);
		expect(found.get("GRID")).toBe(`GRID: list[list[int]] = ${fold("[", "]")}`);
		expect(found.get("BARE")).toBe("BARE = 1, 2");
		expect(found.get("PAIRED")).toBe("PAIRED = (1), (2)");
		expect(found.get("WRAPPED")).toBe(`WRAPPED = ${fold("(", ")")}`);
		expect(found.get("SQUARES")).toBe(`SQUARES = ${fold("{", "}")}`);
		expect(found.get("TOTAL")).toBe(`TOTAL = sum${fold("(", ")")}`);
		expect(found.get("HANDLER")).toBe(`HANDLER = lambda value: ${fold("{", "}")}`);
		expect(found.get("ALIAS")).toBe("ALIAS = Callable[[int], str]");
		expect(found.get("WIDE")).toBe(`WIDE = pick("\u{1F600}", ${fold("[", "]")})`);
		expect(found.get("LOGGER")).toBe("LOGGER = logging.getLogger(__name__)");
		expect(found.get("index")).toBe(`for index in enumerate(${fold("[", "]")}):`);
	});

	it("keeps a literal as written, its line breaks and tabs escaped", async () => {
		const found = await signatures([
			'SEP = "a  b"',
			'DOC = """one',
			'  two"""',
			"SHOWN = f\"x  {value:>3}\t{f'{inner}  y'}\"",
			'JOINED = ("a  "',
			'          "b")',
			"",
		]);

		expect(found.get("SEP")).toBe('SEP = "a  b"');
		expect(found.get("DOC")).toBe('DOC = """one\\n  two"""');
		expect(found.get("SHOWN")).toBe("SHOWN = f\"x  {value:>3}\\t{f'{inner}  y'}\"");
		expect(found.get("JOINED")).toBe('JOINED = ("a  " "b")');
	});

	it("gives each name a statement binds its own header, never its siblings'", async () => {
		const found = await signatures([
			"first = second = [1, 2]  # shared",
			"RED, GREEN = range(2)",
			"(LEFT, RIGHT) = ((1), (2))",
			"for key, value in table.items():",
			"    pass",
			"with open(a) as reader, (open(b)) as writer:",
			"    pass",
			"with open(c) as only:",
			"    pass",
			"",
		]);

		expect(found.get("first")).toBe(`first = ${fold("[", "]")}`);
		expect(found.get("second")).toBe(`second = ${fold("[", "]")}`);
		expect(found.get("GREEN")).toBe("GREEN");
		expect(found.get("RIGHT")).toBe("RIGHT");
		expect(found.get("value")).toBe("value");
		expect(found.get("reader")).toBe("with open(a) as reader");
		expect(found.get("writer")).toBe("with (open(b)) as writer");
		expect(found.get("only")).toBe("with open(c) as only:");
	});

	it("renders a statement of many bound names in time linear in their count", async () => {
		const timed = async (count: number) => {
			const names = Array.from({ length: count }, (_, index) => `n${index}`);
			const lines = [
				`${names.join(" = \\\n")} = 0`,
				`(\n${names.map((name) => `    u${name},`).join("\n")}\n) = pair()`,
			];
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				const found = await signatures(lines);
				best = Math.min(best, performance.now() - started);
				// A parse that failed fast is not linear.
				expect([found.get(`n${count - 1}`), found.get(`un${count - 1}`)]).toEqual([
					`n${count - 1} = 0`,
					`un${count - 1}`,
				]);
			}
			return best;
		};
		// Linear reads 8x; a header spanning every sibling read 64x.
		expect((await timed(4_000)) / (await timed(500))).toBeLessThan(24);
	}, 120_000);

	it("drops comments and line continuations inside a header", async () => {
		const found = await signatures([
			"@first  # one",
			"# between",
			"@second",
			"def run(",
			"    value,  # the value",
			") -> int:  # after the colon",
			"    return value",
			"",
			"TOTAL = 1 + \\",
			"    2  # trailing",
			"NAMED = make(  # why",
			'    "name",',
			")",
			"with open(path) as handle:  # opened",
			"    pass",
			"",
		]);

		expect(found.get("run")).toBe("@first @second def run(value) -> int:");
		expect(found.get("TOTAL")).toBe("TOTAL = 1 + 2");
		expect(found.get("NAMED")).toBe('NAMED = make("name")');
		expect(found.get("handle")).toBe("with open(path) as handle:");
	});
});
