// Character names for `\N{...}`, looked up as Python looks them up: case-insensitive, aliases included.

import { inflateRawSync } from "node:zlib";
import { HANGUL, HEX_NAMED, NAMES } from "./unicodeNameData.js";

////////////////////////////////
//  Constants

/** Unicode's jamo short names, in the order the syllable block composes them. */
const LEADING = ["G", "GG", "N", "D", "DD", "R", "M", "B", "BB", "S", "SS", "", "J", "JJ", "C", "K", "T", "P", "H"];
const VOWELS = [
	"A",
	"AE",
	"YA",
	"YAE",
	"EO",
	"E",
	"YEO",
	"YE",
	"O",
	"WA",
	"WAE",
	"OE",
	"YO",
	"U",
	"WEO",
	"WE",
	"WI",
	"YU",
	"EU",
	"YI",
	"I",
];
const TRAILING = [
	"",
	"G",
	"GG",
	"GS",
	"N",
	"NJ",
	"NH",
	"D",
	"L",
	"LG",
	"LM",
	"LB",
	"LS",
	"LT",
	"LP",
	"LH",
	"M",
	"B",
	"BS",
	"S",
	"SS",
	"NG",
	"J",
	"C",
	"K",
	"T",
	"P",
	"H",
];

const HANGUL_PREFIX = "HANGUL SYLLABLE ";

const NAMED = readNames();

////////////////////////////////
//  Functions & Helpers

/** Every name and alias, then the Hangul syllables named from their jamo. */
function readNames(): ReadonlyMap<string, number> {
	const named = new Map<string, number>();
	for (const line of inflateRawSync(Buffer.from(NAMES, "base64")).toString("utf8").split("\n")) {
		const space = line.indexOf(" ");
		const name = line.slice(space + 1);
		if (!named.has(name)) named.set(name, Number.parseInt(line.slice(0, space), 16));
	}
	const [first] = HANGUL;
	for (let point = first; point <= HANGUL[1]; point++) {
		const index = point - first;
		const leading = LEADING[Math.floor(index / (VOWELS.length * TRAILING.length))];
		const vowel = VOWELS[Math.floor((index % (VOWELS.length * TRAILING.length)) / TRAILING.length)];
		const trailing = TRAILING[index % TRAILING.length];
		named.set(`${HANGUL_PREFIX}${leading}${vowel}${trailing}`, point);
	}
	return named;
}

/** The code point `name` names, or undefined when it names none. */
export function unicodeNamed(name: string): number | undefined {
	// CPython folds ASCII case only.
	const upper = [...name]
		.map((character) => (character >= "a" && character <= "z" ? character.toUpperCase() : character))
		.join("");
	for (const [prefix, first, last] of HEX_NAMED) {
		if (!upper.startsWith(prefix)) continue;
		const hex = upper.slice(prefix.length);
		if (hex.length < 4 || hex.length > 5 || [...hex].some((digit) => !"0123456789ABCDEF".includes(digit))) continue;
		const point = Number.parseInt(hex, 16);
		if (point >= first && point <= last) return point;
	}
	return NAMED.get(upper);
}
