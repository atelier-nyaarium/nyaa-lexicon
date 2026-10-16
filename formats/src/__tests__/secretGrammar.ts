// Spelling cases grade reader prefilters.

import { type CorpusName, random } from "./secretConformance.js";

////////////////////////////////
//  Interfaces & Types

type Pick = <T>(list: readonly T[]) => T;
type Chance = (probability: number) => boolean;

////////////////////////////////
//  Constants

const unit = (code: number) => String.fromCharCode(code);

/** Embedded, escaped, quoted, and folded names. */
const WORDS = [
	"data",
	"stringData",
	"token",
	"it's",
	"a",
	"kind",
	"x",
	"metadata",
	"to ken",
	"d a",
	unit(0xe9),
	unit(0x65e5) + unit(0x672c),
	'a"b',
	"back\\slash",
	"\u{1f600}data",
	"a:b",
	"a#b",
	"-x",
	".y",
	"[z]",
	"{w}",
	"a,b",
	" lead",
	"trail ",
	"x\ty",
	"Yes",
	"1e3",
	`data${unit(0x85)}x`,
	`d${unit(0x2028)}a`,
];

const YAML_VALUES = ["1", "x", "Secret", "", "[a, b]", "{data: 1}", "|\n  text", '"quoted"', "&b v", "*b", "~", "yes"];
const ANCHORS = ["b", "value", "k"];
const ANCHORED_NODES = ["SECRET", "x", "[SECRET, y]", "{token: SECRET}", '"SECRET"', "|\n    SECRET"];
const JSON_VALUES = ["1", '"x"', "[1,2]", "null", "true", '"a\\nb"', '"some data"'];
const DOTENV_KEYS = ["DATA", "A", "A.B", "X-Y", unit(0xc9), "TOKEN", "export DATA", "METADATA", "a b"];
const DOTENV_VALUES = ["1", '"two words"', "'x'", "`cmd`", "$(DATA=2)", "x;DATA=3", "", "a b", "${DATA:-x}", "#c"];
const DOTENV_LINES = ["source x", "A=1 DATA=2", 'eval "$x"', "# DATA"];
/** Blanks dotenv readers split, shells retain. */
const ODD_BLANKS = [unit(0xa0), unit(0x0b), unit(0x0c), unit(0x3000), unit(0xfeff), unit(0x85), unit(0x1680)];
/** Shell hash-comment positions. */
const DOTENV_HASHES = [
	"x#;A=1",
	"x #;A=1",
	"x;#;A=1",
	"x&#;A=1",
	"(x)#;A=1",
	"x|#;A=1",
	'"x"#;A=1',
	"'x'#;A=1",
	"#;A=1",
	"a'x #y';A=1",
	'a"x #y";A=1',
	"x\\ #;A=1",
	"x\\\t#;A=1",
	"$(x #y);A=1",
	"`x #y`;A=1",
	'"x #";A=1',
	"x\\\n#;A=1",
	"x \\\n #;A=1",
];

////////////////////////////////
//  Functions & Helpers

function hex(code: number, width: number): string {
	return code.toString(16).padStart(width, "0");
}

/** Quoted word with parser escapes. */
function quoted(word: string): string {
	return `"${word.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Quoted word with per-unit escapes. */
function escaped(word: string, write: (code: number) => string, chance: Chance): string {
	const written = [...word].map((char) => (chance(0.4) ? write(char.charCodeAt(0)) : quoted(char).slice(1, -1)));
	return `"${written.join("")}"`;
}

function yamlKey(word: string, pick: Pick, chance: Chance): string {
	const double = quoted(word);
	switch (pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])) {
		case 0:
			return word;
		case 1:
			return double;
		case 2:
			return `'${word.replaceAll("'", "''")}'`;
		case 3:
			return escaped(word, (code) => `\\x${hex(code, 2)}`, chance);
		case 4:
			return escaped(word, (code) => `\\u${hex(code, 4)}`, chance);
		case 5:
			return `&${pick(["a", "def", "x1"])} ${word}`;
		case 6:
			return `${pick(["!!str", "!t", "!<tag:yaml.org,2002:str>"])} ${word}`;
		case 7:
			return word.replace(" ", pick(["\n  ", "\n    ", "  ", "\t"]));
		case 8:
			return quoted(word.replace(" ", pick(["\n  ", "\\\n  ", "\\n"])));
		case 9:
			return `&${pick(["a", "def"])}${pick([",", "[", "{"])}${word}`;
		case 10:
			return `${pick(["", "!", "? "])}${word}`;
		case 11:
			return double.slice(0, -1);
		case 12:
			return `'${word.replaceAll("'", "''")}`;
		default:
			return double.replace(pick(["a", "t", "d", "k"]), (char) => `\\x${hex(char.charCodeAt(0), 2)}`);
	}
}

/** Anchors in key, flow, item, or value positions. */
function yamlAnchored(anchor: string, pick: Pick, chance: Chance): string {
	const indent = " ".repeat(2 * pick([0, 1, 2]));
	const key = yamlKey(pick(WORDS), pick, chance);
	const node = pick(ANCHORED_NODES);
	const rest = pick(YAML_VALUES);
	const close = (mark: string) => (chance(0.5) ? mark : "");
	switch (pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])) {
		case 12:
			return `${indent}&${anchor} ${pick(["token", "data", "stringData"])}: ${rest}`;
		case 13:
			return `${indent}[&${anchor} ${pick(["token", "data"])}${close("]")}`;
		case 0:
			return `${indent}${key}: &${anchor} ${node}`;
		case 1:
			return `${indent}&${anchor} ${key}: ${rest}`;
		case 2:
			return `${indent}? ${key}: &${anchor} ${node}\n${indent}: ${rest}`;
		case 3:
			return `${indent}? [&${anchor} ${node}]\n${indent}: ${rest}`;
		case 4:
			return `${indent}? &${anchor} ${node}\n${indent}: ${rest}`;
		case 5:
			return `${indent}{? ${key}: &${anchor} ${node} : ${rest}${close("}")}`;
		case 6:
			return `${indent}[${key}: &${anchor} ${node}${close("]")}`;
		case 7:
			return `${indent}[&${anchor} ${key}: ${rest}${close("]")}`;
		case 8:
			return `${indent}- &${anchor} ${node}`;
		case 9:
			return `${indent}${key}: &${anchor}\n${indent}  ${yamlKey(pick(WORDS), pick, chance)}: ${node}`;
		case 10:
			return `${indent}? &${anchor} {${key}: ${node}}\n${indent}: ${rest}`;
		default:
			return `${indent}? ${key}: [${node}, &${anchor} ${node}]\n${indent}: ${rest}`;
	}
}

/** Paths that select aliases. */
function yamlAliased(anchor: string, pick: Pick, chance: Chance): string {
	const indent = " ".repeat(2 * pick([0, 1]));
	const name = pick(["token", "data", "stringData", "password", "kind"]);
	const close = (mark: string) => (chance(0.5) ? mark : "");
	switch (pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) {
		case 10:
			return `${indent}items:\n${indent}  - data: *${anchor}\n${indent}  - stringData: {token: *${anchor}${close("}")}`;
		case 8:
			return `${indent}*${anchor} : SECRET`;
		case 9:
			return `${indent}{*${anchor} : SECRET${close("}")}`;
		case 0:
			return `${indent}${name}: *${anchor}`;
		case 1:
			return `${indent}stringData:\n${indent}  token: *${anchor}`;
		case 2:
			return `${indent}data: {token: *${anchor}${close("}")}`;
		case 3:
			return `${indent}x:\n${indent}  <<: *${anchor}`;
		case 4:
			return `${indent}<<: [*${anchor}]`;
		case 5:
			return `${indent}data:\n${indent}  - *${anchor}\n${indent}  - token: *${anchor}`;
		case 6:
			return `${indent}${name}: [*${anchor}, x]`;
		default:
			return `${indent}? *${anchor}\n${indent}: token`;
	}
}

/** Anchors in unusual selected paths. */
function yamlAnchoredDocument(pick: Pick, chance: Chance): string {
	const anchor = pick(ANCHORS);
	const lines = chance(0.5) ? [pick(["kind: Secret", "kind: Secret", "kind: List"])] : [];
	for (let at = 0, count = 1 + pick([0, 1, 2]); at < count; at++) lines.push(yamlAnchored(anchor, pick, chance));
	for (let at = 0, count = 1 + pick([0, 1, 2]); at < count; at++) lines.push(yamlAliased(anchor, pick, chance));
	if (chance(0.1)) lines.reverse();
	return `${lines.join(chance(0.9) ? "\n" : "\r\n")}\n`;
}

function yamlDocument(pick: Pick, chance: Chance): string {
	const lines: string[] = [];
	for (let at = 0, count = 1 + pick([0, 1, 2, 3, 4, 5]); at < count; at++) {
		const indent = " ".repeat(2 * pick([0, 1, 2]));
		const key = yamlKey(pick(WORDS), pick, chance);
		const value = pick([...YAML_VALUES, `{${yamlKey(pick(WORDS), pick, chance)}: 2}`]);
		const close = (mark: string) => (chance(0.5) ? mark : "");
		switch (pick([0, 1, 2, 3, 4, 5])) {
			case 0:
				lines.push(`${indent}${key}: ${value}`);
				break;
			case 1:
				lines.push(`${indent}- ${key}: ${value}`);
				break;
			case 2:
				lines.push(`${indent}? ${key}\n${indent}: ${value}`);
				break;
			case 3:
				lines.push(`${indent}{${key}: ${value}${close("}")}`);
				break;
			case 4:
				lines.push(`${indent}[${key}: ${value}, ${yamlKey(pick(WORDS), pick, chance)}${close("]")}`);
				break;
			default:
				lines.push(`${indent}${key} :${close(" ")}${value} # ${pick(WORDS)}`);
		}
		if (chance(0.1)) lines.push("---");
		if (chance(0.1)) lines.push(`# ${pick(WORDS)}: c`);
	}
	return (chance(0.05) ? "\u{feff}" : "") + lines.join(chance(0.9) ? "\n" : "\r\n") + (chance(0.5) ? "\n" : "");
}

function jsonKey(word: string, pick: Pick, chance: Chance): string {
	const encoded = JSON.stringify(word);
	switch (pick([0, 1, 2, 3, 4, 5, 6, 7, 8])) {
		case 0:
			return encoded;
		case 1:
			return `'${word.replaceAll("'", "\\'")}'`;
		case 2:
			return word.replace(/[^\w$]/g, "");
		case 3:
			return escaped(word, (code) => `\\u${hex(code, 4)}`, chance);
		case 4:
			return escaped(word, (code) => `\\${pick(["q", "x41", "'", "0"])}${unit(code)}`, chance);
		case 5:
			return encoded.slice(0, -1);
		case 6:
			return `${encoded.slice(0, -1)}\\`;
		case 7:
			return escaped(word, (code) => `\\u${hex(code, 4)}`, chance).slice(0, -1);
		default:
			return `${pick(["", "/*c*/ ", "// c\n"])}${encoded}`;
	}
}

function jsonDocument(pick: Pick, chance: Chance): string {
	const members: string[] = [];
	for (let at = 0, count = 1 + pick([0, 1, 2, 3, 4]); at < count; at++) {
		const key = jsonKey(pick(WORDS), pick, chance);
		const value = pick([...JSON_VALUES, `{${jsonKey(pick(WORDS), pick, chance)}: 2}`]);
		members.push(`${chance(0.1) ? "// c\n" : ""}${key}${chance(0.9) ? ":" : ""}${chance(0.9) ? "" : " "}${value}`);
	}
	const body = members.join(chance(0.9) ? "," : "");
	if (chance(0.1)) return `{${body}`;
	return chance(0.1) ? body : `{${body}}`;
}

function dotenvDocument(pick: Pick, chance: Chance): string {
	const lines: string[] = [];
	for (let at = 0, count = 1 + pick([0, 1, 2, 3, 4, 5]); at < count; at++) {
		lines.push(
			`${pick(["", " ", "\t"])}${pick(DOTENV_KEYS)}${pick(["=", " = ", ":", ": ", "\n="])}${pick(DOTENV_VALUES)}`,
		);
		if (chance(0.15)) lines.push(pick(DOTENV_LINES));
	}
	return lines.join(pick(["\n", "\r\n", "\r"]));
}

/** Hash comments with reader-specific blank rules. */
function dotenvHashDocument(pick: Pick, chance: Chance): string {
	const lines: string[] = [];
	const odd = () => (chance(0.4) ? pick(ODD_BLANKS) : pick([" ", "\t", ""]));
	for (let at = 0, count = 1 + pick([0, 1, 2, 3]); at < count; at++) {
		const hash = pick(DOTENV_HASHES).replace(" ", odd() || " ");
		switch (pick([0, 1, 2, 3, 4, 5, 6])) {
			case 0:
				lines.push(`${odd()}${pick(DOTENV_KEYS)}=${pick(["x", "'x'", '"x"', "", "1"])}${odd()}${hash}`);
				break;
			case 1:
				lines.push(`${odd()}${hash}`);
				break;
			case 2:
				lines.push(`${odd()}${pick(["echo", "source", "export"])} ${hash}`);
				break;
			case 3:
				lines.push(`${odd()}${pick(DOTENV_KEYS)}${pick([":", ": ", " :"])}${odd()}${hash}`);
				break;
			case 4:
				lines.push(`${odd()}# ${pick(["c", "A=1", "DATA"])}${pick([";A=1", ";DATA=3", ""])}`);
				break;
			case 5:
				lines.push(
					`${pick(["A", "DATA", "TOKEN"])}=${pick(["x", "'x'"])}${odd()}${pick(["#c", "#", "# c;A=1"])}`,
				);
				break;
			default:
				lines.push(pick(DOTENV_LINES));
		}
	}
	return lines.join(pick(["\n", "\n", "\r\n", "\r"]));
}

////////////////////////////////
//  Documents

/** `count` deterministic format documents per seed. */
export function grammarTexts(id: CorpusName, count: number, seed: number): string[] {
	const next = random(seed);
	const pick: Pick = (list) => list[Math.floor(next() * list.length)] as never;
	const chance: Chance = (probability) => next() < probability;
	const make = id === "yaml" ? yamlDocument : id === "json" ? jsonDocument : dotenvDocument;
	return Array.from({ length: count }, () => make(pick, chance));
}

/** `count` deterministic YAML documents with anchors. */
export function anchoredTexts(count: number, seed: number): string[] {
	const next = random(seed);
	const pick: Pick = (list) => list[Math.floor(next() * list.length)] as never;
	const chance: Chance = (probability) => next() < probability;
	return Array.from({ length: count }, () => yamlAnchoredDocument(pick, chance));
}

/** `count` deterministic dotenv documents per seed. */
export function hashTexts(count: number, seed: number): string[] {
	const next = random(seed);
	const pick: Pick = (list) => list[Math.floor(next() * list.length)] as never;
	const chance: Chance = (probability) => next() < probability;
	return Array.from({ length: count }, () => dotenvHashDocument(pick, chance));
}
