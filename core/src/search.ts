// Regex compiler and term check, owned once.

import type { OffsetRange } from "@nyaa-lexicon/protocol";
import { RE2JS } from "re2js";

/** Linear time; never stalls. */
export interface SearchPattern {
	test(text: string): boolean;
	find(text: string): string | null;
	ranges(text: string, limit: number, skip?: (span: OffsetRange) => number | undefined): OffsetRange[];
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

/** Flags hold no slash, so the last slash closes the pattern. */
export function compileSearchRegex(source: string): SearchPattern {
	const close = source.lastIndexOf("/");
	if (!source.startsWith("/") || close === 0) {
		throw new Error("Regex failed to compile: expected /pattern/flags.");
	}
	const pattern = source.slice(1, close);

	let flags = 0;
	for (const flag of source.slice(close + 1)) {
		const bit = FLAGS[flag];
		if (bit === undefined)
			throw new Error(`Regex failed to compile: unsupported flag \`${flag}\`; i, m and s apply.`);
		flags |= bit;
	}

	try {
		const compiled = RE2JS.compile(pattern, flags);
		return {
			test: (text) => compiled.matcher(text).find(),
			find: (text) => {
				const matcher = compiled.matcher(text);
				return matcher.find() ? matcher.group() : null;
			},
			ranges: (text, limit, skip) => {
				const matcher = compiled.matcher(text);
				const ranges: OffsetRange[] = [];
				let from = 0;
				while (ranges.length < limit && matcher.find(from)) {
					const start = matcher.start();
					const end = matcher.end();
					const onward = skip?.({ start, end });
					if (onward !== undefined) {
						from = Math.max(onward, start + 1);
						if (from > text.length) break;
						continue;
					}
					ranges.push({ start, end });
					const next = text.indexOf("\n", Math.max(start, end - 1));
					if (next === -1) break;
					from = next + 1;
				}
				return ranges;
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
