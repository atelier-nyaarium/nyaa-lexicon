// The one owner of "which symbol does this comment belong to".
//
// Providers report spans and nothing else, so every rule here is position math over ranges core
// already stores plus the module's own text. Eight providers implementing this would be eight
// chances to disagree about one idea.
//
// Nothing guesses. A comment that could belong to either of two declarations belongs to neither:
// it becomes standalone against whatever encloses it, because a wrong anchor baked into a stored
// fact is worse than an honest "somewhere in here".

import { type CommentSpan, coordinatesOf, type Declaration, type Range } from "@nyaa-lexicon/protocol";
import { normalizeCommentText } from "./commentText.js";

////////////////////////////////
//  Interfaces & Types

/** Where a comment sits relative to the symbol it documents. */
export type CommentForm = "leading" | "trailing" | "inline" | "standalone";

/** The comment's side of its anchor. `inside` is the standalone case, enclosed but not attached. */
export type CommentPlacement = "above" | "after" | "before" | "inside";

export interface AttachedComment {
	range: Range;
	/** Verbatim, exactly as the file spells it, markers and all. */
	raw: string;
	/** What search runs over. See `normalizeCommentText`. */
	normalized: string;
	form: CommentForm;
	placement: CommentPlacement;
	/** Null when the module itself is the container: a header, a licence, a banner. */
	anchorId: string | null;
}

interface Group {
	range: Range;
	raw: string;
	/** Nothing but whitespace precedes it on its first line. */
	ownLine: boolean;
	/** Code follows it on its last line. */
	codeAfter: boolean;
}

////////////////////////////////
//  Functions & Helpers

function beforeStart(lineText: string, character: number): string {
	return lineText.slice(0, character);
}

function comparePoints(a: Range["start"], b: Range["start"]): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function sameStart(a: Range, b: Range): boolean {
	return a.start.line === b.start.line && a.start.character === b.start.character;
}

/** Innermost wins: a comment in a method body belongs to the method, not to its class. */
function enclosing(declarations: Declaration[], range: Range): Declaration | undefined {
	let best: Declaration | undefined;
	for (const declaration of declarations) {
		if (comparePoints(declaration.range.start, range.start) > 0) continue;
		if (comparePoints(declaration.range.end, range.end) < 0) continue;
		if (best === undefined || comparePoints(declaration.range.start, best.range.start) > 0) best = declaration;
	}
	return best;
}

////////////////////////////////
//  Grouping

/**
 * A run of line comments at one indent, uninterrupted, is ONE fact.
 *
 * A sentence wrapped across three lines is one sentence, and three facts would make a search for
 * its middle words find a fragment with no beginning. A block comment is always its own group.
 */
function groupComments(comments: CommentSpan[], text: string): Group[] {
	const coordinates = coordinatesOf(text);
	const sorted = [...comments].sort((left, right) => comparePoints(left.range.start, right.range.start));
	const groups: Group[] = [];

	for (const comment of sorted) {
		const lineText = coordinates.lineText(comment.range.start.line) ?? "";
		const ownLine = beforeStart(lineText, comment.range.start.character).trim() === "";
		const endLine = coordinates.lineText(comment.range.end.line) ?? "";
		const codeAfter = endLine.slice(comment.range.end.character).trim() !== "";
		const single = comment.range.start.line === comment.range.end.line;

		const previous = groups.at(-1);
		const continues =
			previous !== undefined &&
			single &&
			ownLine &&
			previous.ownLine &&
			!previous.codeAfter &&
			previous.range.start.line === previous.range.end.line &&
			previous.range.start.character === comment.range.start.character &&
			previous.range.end.line + 1 === comment.range.start.line;

		// Merged only when the source can produce the merged text. A group whose raw came from one
		// member while its range covers several would be a fact quoting something it does not span.
		const merged = continues ? { start: (previous as Group).range.start, end: comment.range.end } : undefined;
		const mergedRaw = merged === undefined ? undefined : coordinates.sliceRange(merged);
		if (merged !== undefined && mergedRaw !== undefined && previous !== undefined) {
			previous.range = merged;
			previous.raw = mergedRaw;
			previous.codeAfter = codeAfter;
			continue;
		}
		groups.push({ range: comment.range, raw: comment.text, ownLine, codeAfter });
	}
	return groups;
}

////////////////////////////////
//  Leading

/** True when only comment lines separate the two, so a blank line breaks the bond. */
function onlyCommentLinesBetween(from: number, to: number, commentLines: Set<number>): boolean {
	for (let line = from + 1; line < to; line++) {
		if (!commentLines.has(line)) return false;
	}
	return true;
}

/**
 * The two conventions, as one rule.
 *
 * Providers disagree about whether a declaration's range already covers its own doc comment, and
 * both answers are defensible, so neither is corrected. The first disjunct catches the providers
 * whose range INCLUDES the doc; the second catches the ones whose range starts at the code, read
 * from the text rather than inferred from stored endpoints.
 */
function leadingTarget(group: Group, declarations: Declaration[], commentLines: Set<number>): Declaration | undefined {
	const included = declarations.find((declaration) => sameStart(declaration.range, group.range));
	if (included !== undefined) return included;

	let nearest: Declaration | undefined;
	for (const declaration of declarations) {
		if (declaration.range.start.line <= group.range.end.line) continue;
		if (nearest !== undefined && declaration.range.start.line >= nearest.range.start.line) continue;
		nearest = declaration;
	}
	if (nearest === undefined) return undefined;
	if (!onlyCommentLinesBetween(group.range.end.line, nearest.range.start.line, commentLines)) return undefined;
	// A comment cannot document something outside the scope holding it. Inside a body, the next
	// declaration below is a SIBLING of the enclosing one, and the comment belongs to the body it
	// sits in. A member nested in that same scope is still reachable, which is the common case.
	const scope = enclosing(declarations, group.range);
	if (scope !== undefined && comparePoints(scope.range.end, nearest.range.start) < 0) return undefined;
	return nearest;
}

////////////////////////////////
//  Same line

/** Left wins: a comment documents what it follows far more often than what it precedes. */
function sameLineAnchor(
	group: Group,
	declarations: Declaration[],
): { anchor: Declaration; side: "after" | "before" } | undefined {
	const line = group.range.start.line;
	const onLine = declarations.filter((declaration) => declaration.selectionRange.start.line === line);
	if (onLine.length === 0) return undefined;

	let left: Declaration | undefined;
	for (const declaration of onLine) {
		if (declaration.selectionRange.start.character >= group.range.start.character) continue;
		if (left === undefined || declaration.selectionRange.start.character > left.selectionRange.start.character) {
			left = declaration;
		}
	}
	if (left !== undefined) return { anchor: left, side: "after" };

	let right: Declaration | undefined;
	for (const declaration of onLine) {
		if (right === undefined || declaration.selectionRange.start.character < right.selectionRange.start.character) {
			right = declaration;
		}
	}
	return right === undefined ? undefined : { anchor: right, side: "before" };
}

////////////////////////////////
//  Attaching

/**
 * Every comment in one module, grouped and anchored.
 *
 * The text is required rather than optional because "nothing between these two" is a question only
 * the source can answer. Inferring it from stored endpoints is how a blank line becomes invisible.
 */
export function attachComments(declarations: Declaration[], comments: CommentSpan[], text: string): AttachedComment[] {
	const groups = groupComments(comments, text);
	if (groups.length === 0) return [];

	const commentLines = new Set<number>();
	for (const group of groups) {
		for (let line = group.range.start.line; line <= group.range.end.line; line++) {
			if (group.ownLine) commentLines.add(line);
		}
	}

	// A declaration takes the NEAREST qualifying group; the rest of its candidates fall through to
	// standalone rather than every one of them claiming the same symbol.
	const leadFor = new Map<string, Group>();
	for (const group of groups) {
		if (!group.ownLine || group.codeAfter) continue;
		const target = leadingTarget(group, declarations, commentLines);
		if (target === undefined) continue;
		const held = leadFor.get(target.symbolId);
		if (held === undefined || group.range.end.line > held.range.end.line) leadFor.set(target.symbolId, group);
	}
	const leading = new Map<Group, string>();
	for (const [symbolId, group] of leadFor) leading.set(group, symbolId);

	return groups.map((group) => {
		const fact = { range: group.range, raw: group.raw, normalized: normalizeCommentText(group.raw) };

		const leads = leading.get(group);
		if (leads !== undefined)
			return { ...fact, form: "leading" as const, placement: "above" as const, anchorId: leads };

		if (!group.ownLine) {
			const found = sameLineAnchor(group, declarations);
			if (found !== undefined) {
				// Trailing means it follows its anchor with nothing after. Anything else on the line,
				// including an anchor the comment sits BEFORE, is embedded rather than trailing.
				const embedded = group.codeAfter || found.side === "before";
				return {
					...fact,
					form: embedded ? ("inline" as const) : ("trailing" as const),
					placement: found.side,
					anchorId: found.anchor.symbolId,
				};
			}
		}

		const container = enclosing(declarations, group.range);
		return {
			...fact,
			form: "standalone" as const,
			placement: "inside" as const,
			anchorId: container?.symbolId ?? null,
		};
	});
}
