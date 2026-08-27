// Regex compiler and term check, owned once.

import { RE2JS } from "re2js";

/** Linear time; never stalls. */
export interface SearchPattern {
	test(text: string): boolean;
	find(text: string): string | null;
}

// g, u and y change nothing here.
const FLAGS: Record<string, number> = {
	i: RE2JS.CASE_INSENSITIVE,
	m: RE2JS.MULTILINE,
	s: RE2JS.DOTALL,
	g: 0,
	u: 0,
	y: 0,
};

export function compileSearchRegex(source: string): SearchPattern {
	const match = /^\/((?:\\.|[^/])*)\/([a-z]*)$/.exec(source);
	if (match === null || match[1] === undefined || match[2] === undefined) {
		throw new Error("Regex failed to compile: expected /pattern/flags.");
	}

	let flags = 0;
	for (const flag of match[2]) {
		const bit = FLAGS[flag];
		if (bit === undefined)
			throw new Error(`Regex failed to compile: unsupported flag \`${flag}\`; i, m and s apply.`);
		flags |= bit;
	}

	try {
		const compiled = RE2JS.compile(match[1], flags);
		return {
			test: (text) => compiled.matcher(text).find(),
			find: (text) => {
				const matcher = compiled.matcher(text);
				return matcher.find() ? matcher.group() : null;
			},
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Regex failed to compile: ${detail}. RE2 syntax: no lookaround or backreferences.`);
	}
}

/** Under SQLite's LIKE limit, escaped. */
export const SEARCH_TERM_LIMIT = 2000;

/** A term SQLite matches as written. */
export function searchTerm(text: string): string {
	if (text.includes("\0")) {
		throw new Error("Search term refused: a NUL ends the term early, and the rest would match everything.");
	}
	if (text.length > SEARCH_TERM_LIMIT) {
		throw new Error(`Search term refused: longer than ${SEARCH_TERM_LIMIT} characters.`);
	}
	return text;
}
