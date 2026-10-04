import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
import { parseBash } from "../extract.js";
import type { Script, Word, WordPart } from "../syntax/ast.js";
import { parseBashScript } from "../syntax/parser.js";

const COMPLETIONS = "/usr/share/bash-completion";

/** Scripts whose hashes sit in every position a word may hold one. */
const SCRIPTS = [
	"a=\"# no\" b='# no' c=$'# no' d=plain#no e=\"${x#no}\" f=$((2#101)) # yes",
	'echo a#b "$(echo \'# no\')" `echo "# no"` @(x|#no) {a,#no} # yes',
	"cat <<EOF # yes\n# no\nEOF\ncat <<'#'\nbody\n#\n",
	"x=(\n\ta # yes\n)\n(( y = 2#101 ))\nfor ((i=16#a; i<20; i++)); do :; done\na#b() { :; }",
	"[[ $z =~ ^#[0-9] ]] # yes\ncase $x in \\#*) ;; #*) ;; esac\necho > file#1\ncat <<< '#x'",
	"let 'x = 16#f'\nprintf -v v '#%s' x\ndeclare -A m=([#]=1)\necho ${!#} ${@#x} $#\nx=\"$(\n# yes\ntrue)\"",
	'x=`echo \\`echo "\\$a"\\` # yes`\ny=$(cat <<E\n$b\nE)\n',
];

const BLANK = new Set([" ", "\t", "\n"]);

/** Every span the tree holds as a word's data; a nested script may hold comments and is walked instead. */
function dataSpans(script: Script): [number, number][] {
	const spans: [number, number][] = [];
	const parts = (list: readonly WordPart[]): void => {
		for (const part of list) {
			if (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") visit(part.script);
			else if (part.type === "DoubleQuoted" || part.type === "LocaleString") parts(part.parts);
			else spans.push([part.pos, part.end]);
		}
	};
	const visit = (value: unknown): void => {
		if (value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const node = value as Record<string, unknown>;
		if (node["type"] === undefined && typeof node["text"] === "string" && typeof node["pos"] === "number") {
			const word = node as unknown as Word;
			if (word.parts === undefined) spans.push([word.pos, word.end]);
			else parts(word.parts);
			return;
		}
		if (node["type"] === "ArithmeticWord") {
			const parted = node["parts"] as WordPart[] | undefined;
			if (parted === undefined) spans.push([node["pos"] as number, node["end"] as number]);
			else parts(parted);
			return;
		}
		for (const child of Object.values(node)) visit(child);
	};
	visit(script);
	return spans;
}

/** Nodes whose text is not the source at their span; a backquote's inner text lost its escapes. */
function misplaced(text: string, script: Script): string[] {
	const wrong: string[] = [];
	const visit = (value: unknown): void => {
		if (value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const node = value as Record<string, unknown>;
		const { pos, end } = node;
		const spelled = node["type"] === "ArithmeticWord" ? node["value"] : node["text"];
		if (typeof pos === "number" && typeof end === "number" && typeof spelled === "string") {
			if (text.slice(pos, end) !== spelled) wrong.push(`${pos}-${end} ${JSON.stringify(spelled).slice(0, 60)}`);
		}
		if (node["backquoted"] === true) return;
		for (const child of Object.values(node)) visit(child);
	};
	visit(script);
	return wrong;
}

function corpus(): [string, string][] {
	const files: [string, string][] = SCRIPTS.map((text, index) => [`script-${index}.sh`, text]);
	if (!existsSync(COMPLETIONS)) return files;
	const paths = [path.join(COMPLETIONS, "bash_completion")];
	const directory = path.join(COMPLETIONS, "completions");
	if (existsSync(directory)) for (const name of readdirSync(directory)) paths.push(path.join(directory, name));
	for (const file of paths) {
		try {
			files.push([path.relative("/", file), readFileSync(file, "utf8")]);
		} catch {}
	}
	return files;
}

describe("the parser's tokens", () => {
	test("tokens run in order and leave only blanks and line breaks", async () => {
		const files = corpus();
		expect(files.length).toBeGreaterThan(SCRIPTS.length - 1);
		for (const [name, text] of files) {
			// Yields, so the timeout can fire.
			await new Promise((resolve) => setImmediate(resolve));
			let at = 0;
			for (const token of parseBashScript(text).tokens) {
				expect(token.pos < at ? { name, token, at } : null).toBeNull();
				const gap = [...text.slice(at, token.pos)].find((character) => !BLANK.has(character));
				expect(gap === undefined ? null : { name, at, gap }).toBeNull();
				at = token.end;
			}
			const tail = [...text.slice(at)].find((character) => !BLANK.has(character));
			expect(tail === undefined ? null : { name, at, tail }).toBeNull();
		}
	});

	test("every node spans its own text", async () => {
		for (const [name, text] of corpus()) {
			await new Promise((resolve) => setImmediate(resolve));
			const wrong = misplaced(text, parseBashScript(text).script);
			expect(wrong.length === 0 ? null : { name, wrong: wrong.slice(0, 3) }).toBeNull();
		}
	});

	test("no comment starts inside a word", async () => {
		let comments = 0;
		for (const [name, text] of corpus()) {
			await new Promise((resolve) => setImmediate(resolve));
			const parsed = parseBashScript(text);
			const spans = dataSpans(parsed.script);
			for (const comment of parsed.tokens.filter((token) => token.kind === "comment")) {
				comments++;
				const inside = spans.find(([start, end]) => start <= comment.pos && comment.pos < end);
				expect(
					inside === undefined ? null : { name, comment: text.slice(comment.pos, comment.end), inside },
				).toBeNull();
			}
		}
		expect(comments).toBeGreaterThan(0);
	});

	// No bash comment shares a line with another, so a line's other text is code.
	test("trivia and blank lines agree with each line's text", async () => {
		for (const [name, text] of corpus()) {
			await new Promise((resolve) => setImmediate(resolve));
			const coordinates = coordinatesOf(text);
			const parsed = parseBash(name, text);
			for (const comment of parsed.comments) {
				const line = coordinates.lineText(comment.range.start.line) ?? "";
				const before = line.slice(0, comment.range.start.character).trim() !== "";
				const after = line.slice(comment.range.end.character).trim() !== "";
				const wrong = comment.codeBefore !== before || comment.codeAfter !== after;
				expect(wrong ? { name, comment } : null).toBeNull();
			}
			for (const line of parsed.blankLines) {
				const held = coordinates.lineText(line)?.trim();
				expect(held === "" ? null : { name, line, held }).toBeNull();
			}
		}
	});
});
