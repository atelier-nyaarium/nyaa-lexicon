// Section banners when declarations move to another file. A banner is a module-level standalone
// comment drawn as one (a separator line, or `--- Title ---`), after the file's header; its section
// runs to the next banner. A move takes a banner out with the last declaration of its section, and
// a file the move creates gets the banners its declarations sat under.
//
// Attachment decides which comments belong to the module; this only reads that answer. A comment at
// the very top of a file could be a header or a banner, so it is never treated as a banner.

import { comparePositions, coordinatesOf, type Range, type StoredComment, type TextEdit } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export interface BannerPlacement {
	comment: StoredComment;
	/** Top-level declarations in its section, by symbol id. */
	declarations: string[];
}

////////////////////////////////
//  Constants

/** A level for a context double that reads no declarations. */
export const NO_LEVEL = { scopes: new Set<string>(), declarations: [] };

////////////////////////////////
//  Functions & Helpers

function isBanner(raw: string): boolean {
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*(?:\/\/|#|\/\*|\*\/|\*)\s?/, "").trim())
		.filter(Boolean);
	return lines.some((line) => /^(?:[-=_*#/.]){3,}$/.test(line) || /^---\s+.+\s+---$/.test(line));
}

/** No code shares its first or last line, so its whole lines are the comment's alone. */
function standsAlone(text: string, comment: StoredComment): boolean {
	const coordinates = coordinatesOf(text);
	const { start, end } = comment.range;
	const before = coordinates.lineText(start.line)?.slice(0, start.character) ?? "";
	const after = coordinates.lineText(end.line)?.slice(end.character) ?? "";
	return before.trim() === "" && after.trim() === "";
}

/** Nothing but blank lines and a shebang before it. */
function isFileHeader(text: string, comment: StoredComment): boolean {
	const offset = coordinatesOf(text).offsetAt(comment.range.start);
	if (offset === undefined) return false;
	return (
		text
			.slice(0, offset)
			.replace(/^#![^\r\n]*(?:\r?\n|$)/, "")
			.trim() === ""
	);
}

/**
 * Each banner in the module with the declarations of its section. `level` is the module's own level
 * as `ReadContext.moduleLevel` answers it; a comment anchored to one of its `scopes` is the module's.
 */
export function sectionBanners(
	text: string,
	comments: readonly StoredComment[],
	level: { scopes: ReadonlySet<string>; declarations: ReadonlyArray<{ symbolId: string; range: Range }> },
): BannerPlacement[] {
	const banners = comments
		.filter((comment) => comment.form === "standalone")
		.filter((comment) => comment.anchorId === null || level.scopes.has(comment.anchorId))
		.filter((comment) => standsAlone(text, comment) && !isFileHeader(text, comment) && isBanner(comment.raw))
		.sort((left, right) => comparePositions(left.range.start, right.range.start));
	return banners.map((comment, at) => {
		const next = banners[at + 1];
		const inSection = (range: Range) =>
			comparePositions(range.start, comment.range.start) > 0 &&
			(next === undefined || comparePositions(range.start, next.range.start) < 0);
		return {
			comment,
			declarations: level.declarations.filter(({ range }) => inSection(range)).map(({ symbolId }) => symbolId),
		};
	});
}

export function bannerOf(banners: readonly BannerPlacement[], symbolId: string): BannerPlacement | undefined {
	return banners.find((banner) => banner.declarations.includes(symbolId));
}

/** The banner's whole lines and one blank line beside them, after it or else before it. */
function wholeCommentRange(text: string, range: Range): Range | undefined {
	const coordinates = coordinatesOf(text);
	const lineOffset = (line: number) => coordinates.offsetAt({ line, character: 0 });
	const start = lineOffset(range.start.line);
	const end = lineOffset(range.end.line + 1) ?? text.length;
	if (start === undefined) return undefined;
	let from = start;
	let to = end;
	const before = coordinates.lineText(range.start.line - 1);
	const after = coordinates.lineText(range.end.line + 1);
	if (after !== undefined && after.trim() === "") to = lineOffset(range.end.line + 2) ?? text.length;
	else if (before !== undefined && before.trim() === "") from = lineOffset(range.start.line - 1) ?? from;
	return { start: coordinates.positionAt(from) as Range["start"], end: coordinates.positionAt(to) as Range["end"] };
}

/** Removals for every banner whose section the move empties. */
export function bannerRemovals(
	text: string,
	banners: readonly BannerPlacement[],
	removed: ReadonlySet<string>,
): TextEdit[] {
	return banners.flatMap(({ comment, declarations }) => {
		if (declarations.length === 0 || declarations.some((symbolId) => !removed.has(symbolId))) return [];
		const range = wholeCommentRange(text, comment.range);
		return range === undefined ? [] : [{ range, newText: "" }];
	});
}

/** Overlapping deletions joined into one, since a banner's blank line can meet a provider's. */
export function mergeBannerRemovals(edits: readonly TextEdit[]): TextEdit[] {
	const ordered = [...edits].sort((left, right) => comparePositions(left.range.start, right.range.start));
	const result: TextEdit[] = [];
	for (const edit of ordered) {
		const last = result.at(-1);
		if (
			last !== undefined &&
			last.newText === "" &&
			edit.newText === "" &&
			comparePositions(edit.range.start, last.range.end) < 0
		) {
			last.range = {
				start: comparePositions(last.range.start, edit.range.start) < 0 ? last.range.start : edit.range.start,
				end: comparePositions(last.range.end, edit.range.end) > 0 ? last.range.end : edit.range.end,
			};
		} else result.push({ ...edit });
	}
	return result;
}

/** The line ending text already uses, LF when it has none. */
export function eolOf(text: string): "\r\n" | "\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The banner's lines from the source in `eol`, with a blank line after. */
function bannerText(text: string, eol: string, banner: BannerPlacement): string {
	const coordinates = coordinatesOf(text);
	const start = coordinates.offsetAt({ line: banner.comment.range.start.line, character: 0 });
	const end = coordinates.offsetAt({ line: banner.comment.range.end.line + 1, character: 0 }) ?? text.length;
	if (start === undefined) return "";
	const raw = text.slice(start, end).replace(/\r?\n/g, eol);
	return `${raw.endsWith(eol) ? raw : `${raw}${eol}`}${eol}`;
}

/**
 * Banner text to put above each member, in their order: wherever a member's banner differs from the
 * one before. `eol` is the ending the members' own text lands in, so a created file keeps one.
 */
export function bannerPrefixes(
	text: string,
	eol: string,
	banners: readonly BannerPlacement[],
	symbolIds: readonly string[],
): Map<string, string> {
	const prefixes = new Map<string, string>();
	let previous: BannerPlacement | undefined;
	for (const symbolId of symbolIds) {
		const banner = bannerOf(banners, symbolId);
		if (banner !== undefined && banner !== previous) prefixes.set(symbolId, bannerText(text, eol, banner));
		previous = banner;
	}
	return prefixes;
}
