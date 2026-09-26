import { describe, expect, test } from "bun:test";
import { FOLD_MARK } from "@nyaa-lexicon/protocol";
import { parseBash } from "../extract.js";

function signatures(lines: string[], ending = "\n"): Record<string, string | undefined> {
	const parsed = parseBash("header.sh", lines.join(ending));
	return Object.fromEntries(parsed.declarations.map((declaration) => [declaration.name, declaration.signature]));
}

function folded(open: string, close: string): string {
	return `${open}${FOLD_MARK}${close}`;
}

describe("signatures", () => {
	test("a function's header runs to its body, and a comment before the body is dropped", () => {
		expect(
			signatures([
				"add() {",
				"  :",
				"}",
				"function greet {",
				"  :",
				"}",
				"function wave() # waves",
				"{",
				"  :",
				"}",
				"sub() (",
				"  :",
				")",
			]),
		).toEqual({ add: "add()", greet: "function greet", wave: "function wave()", sub: "sub()" });
	});

	test("an assignment keeps its value, an array or compound value folds, and an empty one stays", () => {
		expect(
			signatures([
				'NAME="x"',
				"COUNT+=3",
				"TABLE=(",
				"  a # first",
				"  b",
				")",
				"EMPTY=()",
				"declare -A MAP=([k]=v)",
				"OUT=$(",
				"  git rev-parse HEAD # sha",
				")",
			]),
		).toEqual({
			NAME: 'NAME="x"',
			COUNT: "COUNT+=3",
			TABLE: `TABLE=${folded("(", ")")}`,
			EMPTY: "EMPTY=()",
			MAP: `declare -A MAP=${folded("(", ")")}`,
			OUT: "OUT=$(git rev-parse HEAD)",
		});
		expect(signatures(["LIST=(a", "  b)", "declare -a MORE=(c)", ""], "\r\n")).toEqual({
			LIST: `LIST=${folded("(", ")")}`,
			MORE: `declare -a MORE=${folded("(", ")")}`,
		});
	});

	test("a declaring builtin keeps its word and flags, and a later name leaves out the ones before it", () => {
		expect(
			signatures([
				"export -x TOKEN=abc OTHER=def",
				"readonly -a LIST=(1 2)",
				"count() {",
				"  local sum=1 \\",
				"    total",
				"}",
				'alias ll="ls -l" la="ls -a"',
			]),
		).toEqual({
			TOKEN: "export -x TOKEN=abc",
			OTHER: "export -x OTHER=def",
			LIST: `readonly -a LIST=${folded("(", ")")}`,
			count: "count()",
			sum: "local sum=1",
			total: "local total",
			ll: 'alias ll="ls -l"',
			la: 'alias la="ls -a"',
		});
	});

	test("a quoted part keeps its spacing as written and escapes its line break", () => {
		expect(
			signatures([
				'SEP="a  b"',
				"DOC='one",
				"  two'",
				"TAB=$'a  b'",
				'OUT=$(printf "%s  %s" a b)',
				'read -r -p "Name:  " first last',
				'let "j  =  2"',
			]),
		).toEqual({
			SEP: 'SEP="a  b"',
			DOC: "DOC='one\\n  two'",
			TAB: "TAB=$'a  b'",
			OUT: 'OUT=$(printf "%s  %s" a b)',
			first: 'read -r -p "Name:  " first',
			last: 'read -r -p "Name:  " last',
			j: 'let "j  =  2"',
		});
	});

	test("a command declaring many names signs them in time linear in their count", () => {
		const timed = (count: number) => {
			const text = `declare ${Array.from({ length: count }, (_, index) => `a${index}=${index}`).join(" ")}\n`;
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				parseBash("many.sh", text);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		// Linear reads 8x; rendering every earlier name per name reads 64x.
		expect(timed(4_000) / timed(500)).toBeLessThan(24);
	});

	test("a header continued over several lines is one line", () => {
		expect(
			signatures(["for host in \\", "  alpha \\", "  beta; do :; done", "declare -r \\", "  -i LIMIT=4"]),
		).toEqual({ host: "for host in alpha beta", LIMIT: "declare -r -i LIMIT=4" });
	});

	test("a command or expression that writes a name first is that name's header", () => {
		expect(
			signatures([
				"read -r line rest",
				"mapfile -t lines < /dev/null",
				"printf -v out '%s' x",
				'getopts "ab:" opt',
				"let j=2",
				"(( i = n = 1 ))",
				': "${D:=def}"',
				"coproc worker { cat; }",
				"select pick in a b; do break; done",
			]),
		).toEqual({
			line: "read -r line",
			rest: "read -r rest",
			lines: "mapfile -t lines",
			out: "printf -v out",
			opt: 'getopts "ab:" opt',
			j: "let j=2",
			i: "i = n = 1",
			n: "n = 1",
			D: "${D:=def}",
			worker: "coproc worker",
			pick: "select pick in a b",
		});
	});
});
