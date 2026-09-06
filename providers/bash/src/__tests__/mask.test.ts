import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
import { type ParsedScript, parse, type Word, type WordPart } from "unbash";
import { parseBash } from "../extract.js";

const COMPLETIONS = "/usr/share/bash-completion";

/** Scripts whose hashes sit in every position the walk marks by hand. */
const SCRIPTS = [
	"a=\"# no\" b='# no' c=$'# no' d=plain#no e=\"${x#no}\" f=$((2#101)) # yes",
	'echo a#b "$(echo \'# no\')" `echo "# no"` @(x|#no) {a,#no} # yes',
	"cat <<EOF # yes\n# no\nEOF\ncat <<'#'\nbody\n#\n",
	"x=(\n\ta # yes\n)\n(( y = 2#101 ))\nfor ((i=16#a; i<20; i++)); do :; done\na#b() { :; }",
	"[[ $z =~ ^#[0-9] ]] # yes\ncase $x in \\#*) ;; #*) ;; esac\necho > file#1\ncat <<< '#x'",
	"let 'x = 16#f'\nprintf -v v '#%s' x\ndeclare -A m=([#]=1)\necho ${!#} ${@#x} $#\nx=\"$(\n# yes\ntrue)\"",
];

/** Every span unbash tokenized as data, from a walk that knows only the tree's shape. */
function dataSpans(script: ParsedScript): [number, number][] {
	const spans: [number, number][] = [];
	const seen = new Set<object>();
	const parts = (list: WordPart[], start: number): void => {
		let at = start;
		for (const part of list) {
			const end = at + part.text.length;
			if (
				(part.type === "CommandExpansion" || part.type === "ProcessSubstitution") &&
				part.script !== undefined
			) {
				visit(part.script);
			} else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
				parts(part.parts, at + (part.type === "DoubleQuoted" ? 1 : 2));
			} else spans.push([at, end]);
			at = end;
		}
	};
	const word = (w: Word): void => {
		if (w.parts === undefined) spans.push([w.pos, w.end]);
		else parts(w.parts, w.pos);
	};
	const visit = (value: unknown): void => {
		if (value === null || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const node = value as Record<string, unknown>;
		if (node["type"] === undefined && typeof node["text"] === "string" && typeof node["pos"] === "number") {
			word(node as unknown as Word);
			return;
		}
		if (node["type"] === "ArithmeticWord") {
			const parted = node["parts"] as WordPart[] | undefined;
			if (parted === undefined) spans.push([node["pos"] as number, node["end"] as number]);
			else parts(parted, node["pos"] as number);
			return;
		}
		for (const [key, child] of Object.entries(node)) if (key !== "source") visit(child);
	};
	visit(script);
	return spans;
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

describe("the comment mask", () => {
	// Here-document bodies and delimiter lines are raw text with no span in the tree, so the mask's
	// own scan is the only authority for them; everything else the tree tokenized is checked here.
	test("no comment starts inside a span unbash tokenized as data", () => {
		const files = corpus();
		expect(files.length).toBeGreaterThan(SCRIPTS.length - 1);
		let comments = 0;
		for (const [name, text] of files) {
			const spans = dataSpans(parse(text));
			const coordinates = coordinatesOf(text);
			for (const comment of parseBash(name, text).comments) {
				comments++;
				const at = coordinates.offsetsForRange(comment.range)?.start;
				expect(at).toBeDefined();
				const inside = spans.find(([start, end]) => start <= (at as number) && (at as number) < end);
				expect(inside === undefined ? null : { name, comment: comment.text, inside }).toBeNull();
			}
		}
		expect(comments).toBeGreaterThan(0);
	});
});
