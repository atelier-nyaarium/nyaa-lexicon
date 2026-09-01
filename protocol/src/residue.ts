// Sweeping source for a residue test: traversal and comment stripping only. Every rule stays in
// the test that enforces it, with the roots and skips it chose.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

////////////////////////////////
//  Functions & Helpers

/** Every `.ts` under `dir`, never entering a directory named in `skip`. A missing root sweeps nothing. */
export function sourceFiles(dir: string, skip: Iterable<string>): string[] {
	const skipped = new Set(skip);
	const found: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		// Listing and stat are two moments, as with the read below: a path gone between them holds no violation.
		const stat = statSync(full, { throwIfNoEntry: false });
		if (stat === undefined) continue;
		if (stat.isDirectory()) {
			if (skipped.has(entry)) continue;
			found.push(...sourceFiles(full, skipped));
			continue;
		}
		if (entry.endsWith(".ts")) found.push(full);
	}
	return found;
}

/**
 * A swept file's text, or null when it is gone.
 *
 * Listing and reading are two moments. A file written and removed by a test running in parallel
 * exists for the first and not the second, and a sweep that reads it directly dies on ENOENT with a
 * message about the wrong thing. A path that no longer exists holds no violation.
 *
 * Only disappearance is tolerated. A file that cannot be read for any other reason is a file the
 * sweep did not check, and swallowing that would report clean on a rule it never applied.
 */
export function readSwept(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

////////////////////////////////
//  One lexer, deciding strings, templates, regex literals and comments together
//
//  `docs/parsing.md` rule 12: a comment is what is NOT a string, so a pass that scans for markers
//  reads a string's contents as prose. Rule 1 sends this to a library and TypeScript's own scanner
//  is the right one, but `residue.ts` is bundled, so that scanner is the ORACLE this is tested
//  against instead of the implementation. There is no token or structure stage (rule 3): the output
//  is a mask over the input, not a tree.

/** The one holder of character access, per rule 2. Offsets are the position a mask needs (rule 6). */
class Cursor {
	private offset = 0;

	public constructor(private readonly text: string) {}

	public get good(): boolean {
		return this.offset < this.text.length;
	}

	public get at(): number {
		return this.offset;
	}

	public peek(ahead = 0): string {
		return this.text.charAt(this.offset + ahead);
	}

	public next(): string {
		const character = this.text.charAt(this.offset);
		this.offset += 1;
		return character;
	}
}

/** Words after which a `/` opens a regular expression rather than dividing. */
const REGEX_AFTER_WORD = new Set([
	"await",
	"case",
	"delete",
	"do",
	"else",
	"in",
	"instanceof",
	"new",
	"of",
	"return",
	"throw",
	"typeof",
	"void",
	"yield",
]);

function isWordCharacter(character: string): boolean {
	return /[A-Za-z0-9_$]/.test(character);
}

/** Tokens that END an expression, so a `/` after one divides. `}` stays out: it closes a block as
 * often as an object, and the block case takes a regex. */
const EXPRESSION_END = new Set([")", "]", '"', "'", "`", "++", "--"]);

/**
 * Whether a `/` here opens a regular expression, from the token before it.
 *
 * Ambiguity resolves toward REGEX because the two mistakes are not equal: reading a division as a
 * regex copies code through unchanged, leaving at worst a comment unblanked, while reading a regex
 * as division lets a `//` inside its body blank the rest of the line.
 */
function opensRegex(previous: string): boolean {
	if (previous === "") return true;
	if (isWordCharacter(previous.charAt(0))) return REGEX_AFTER_WORD.has(previous);
	return !EXPRESSION_END.has(previous);
}

/** A comment becomes spaces of its own length, keeping line endings so offsets and lines still hold. */
function blank(text: string): string {
	return text.replace(/[^\n]/g, " ");
}

function readLineComment(cursor: Cursor): string {
	let text = "";
	while (cursor.good && cursor.peek() !== "\n") text += cursor.next();
	return text;
}

function readBlockComment(cursor: Cursor): string {
	// The opener, so an unterminated comment still consumes and cannot stall the loop.
	let text = cursor.next() + cursor.next();
	while (cursor.good) {
		if (cursor.peek() === "*" && cursor.peek(1) === "/") return text + cursor.next() + cursor.next();
		text += cursor.next();
	}
	return text;
}

/** Reads through the closing quote. A backslash escapes whatever follows it, including the quote. */
function readQuoted(cursor: Cursor, quote: string): string {
	let text = cursor.next();
	while (cursor.good) {
		const character = cursor.next();
		text += character;
		if (character === "\\" && cursor.good) text += cursor.next();
		else if (character === quote) return text;
	}
	return text;
}

/**
 * Reads through the closing `/` and its flags.
 *
 * A `/` inside a character class does not close it, which is the case a pattern for this gets wrong.
 */
function readRegex(cursor: Cursor): string {
	let text = cursor.next();
	let inClass = false;
	while (cursor.good) {
		const character = cursor.next();
		text += character;
		if (character === "\\" && cursor.good) text += cursor.next();
		else if (character === "[") inClass = true;
		else if (character === "]") inClass = false;
		else if (character === "/" && !inClass) break;
		else if (character === "\n") return text;
	}
	while (cursor.good && isWordCharacter(cursor.peek())) text += cursor.next();
	return text;
}

/**
 * Copies source through, blanking comments, until the end or an unmatched `}`.
 *
 * A template's `${ }` holds arbitrary code, including further templates and comments, so the hole is
 * swept by the same function rather than skipped.
 */
function sweep(cursor: Cursor, out: string[], stopAtBrace: boolean): void {
	let previous = "";
	let depth = 0;
	while (cursor.good) {
		const before = cursor.at;
		const character = cursor.peek();
		if (stopAtBrace && character === "}" && depth === 0) return;
		if (character === "/" && cursor.peek(1) === "/") out.push(blank(readLineComment(cursor)));
		else if (character === "/" && cursor.peek(1) === "*") out.push(blank(readBlockComment(cursor)));
		else if (character === "/" && opensRegex(previous)) {
			out.push(readRegex(cursor));
			previous = "/";
		} else if (character === '"' || character === "'") {
			out.push(readQuoted(cursor, character));
			previous = character;
		} else if (character === "`") {
			sweepTemplate(cursor, out);
			previous = "`";
		} else if (isWordCharacter(character)) {
			let word = "";
			while (cursor.good && isWordCharacter(cursor.peek())) word += cursor.next();
			out.push(word);
			previous = word;
		} else {
			out.push(cursor.next());
			if (character === "{") depth += 1;
			else if (character === "}") depth -= 1;
			// A doubled `+` or `-` is one token, so a postfix `a-- / b` reads as division.
			if (!/\s/.test(character)) {
				previous =
					(character === "+" || character === "-") && previous === character
						? character + character
						: character;
			}
		}
		// Rule 7: every scan loop provably advances.
		if (cursor.at === before) throw new Error(`the sweep stalled at offset ${before}`);
	}
}

/** Reads a template through its closing backtick, sweeping each `${ }` hole as code. */
function sweepTemplate(cursor: Cursor, out: string[]): void {
	out.push(cursor.next());
	while (cursor.good) {
		const character = cursor.peek();
		if (character === "\\") {
			out.push(cursor.next());
			if (cursor.good) out.push(cursor.next());
			continue;
		}
		if (character === "`") {
			out.push(cursor.next());
			return;
		}
		if (character === "$" && cursor.peek(1) === "{") {
			out.push(cursor.next(), cursor.next());
			sweep(cursor, out, true);
			if (cursor.good) out.push(cursor.next());
			continue;
		}
		out.push(cursor.next());
	}
}

/** Comments only. Strings survive: a rule's token inside one is exactly what a sweep looks for. */
export function codeOnly(source: string): string {
	const out: string[] = [];
	sweep(new Cursor(source), out, false);
	return out.join("");
}
