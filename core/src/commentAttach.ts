// The one owner of "which symbol does this comment belong to".
//
// Providers report spans and nothing else, so every rule here is position math over ranges core
// already stores plus the module's own text. Each provider implementing this would be another
// chance to disagree about one idea.
//
// Nothing guesses. A comment that could belong to either of two declarations belongs to neither:
// it becomes standalone against whatever encloses it, because a wrong anchor baked into a stored
// fact is worse than an honest "somewhere in here".

import { type CommentSpan, coordinatesOf, type Declaration, type Range } from "@nyaa-lexicon/protocol";
import { isBlockComment, normalizeCommentText } from "./proseText.js";

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

/** One comment's relationship to the line holding it, read from the span alone. */
interface Placed {
	comment: CommentSpan;
	ownLine: boolean;
	codeAfter: boolean;
	/** Alone on its line, undelimited, one line tall: the only shape that joins a run. */
	joinable: boolean;
}

function place(comment: CommentSpan, coordinates: ReturnType<typeof coordinatesOf>): Placed {
	const lineText = coordinates.lineText(comment.range.start.line) ?? "";
	const ownLine = beforeStart(lineText, comment.range.start.character).trim() === "";
	const endLine = coordinates.lineText(comment.range.end.line) ?? "";
	const codeAfter = endLine.slice(comment.range.end.character).trim() !== "";
	return {
		comment,
		ownLine,
		codeAfter,
		joinable:
			ownLine &&
			!codeAfter &&
			comment.range.start.line === comment.range.end.line &&
			!isBlockComment(comment.text),
	};
}

/**
 * Split into runs, reading only each comment's OWN span.
 *
 * Separated from merging on purpose. The previous shape grew a group and then asked that same
 * growing group whether it was still one line, so the answer changed underneath the question and a
 * run of three broke into a pair and a straggler. Deciding membership before anything is merged
 * makes the length of the run unable to affect the decision at all.
 */
function partitionRuns(placed: Placed[]): Placed[][] {
	const runs: Placed[][] = [];
	for (const item of placed) {
		const current = runs.at(-1);
		const last = current?.at(-1);
		const continues =
			last !== undefined &&
			last.joinable &&
			item.joinable &&
			last.comment.range.start.character === item.comment.range.start.character &&
			last.comment.range.end.line + 1 === item.comment.range.start.line;

		if (continues && current !== undefined) current.push(item);
		else runs.push([item]);
	}
	return runs;
}

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

	for (const run of partitionRuns(sorted.map((comment) => place(comment, coordinates)))) {
		const first = run[0] as Placed;
		const last = run.at(-1) as Placed;
		if (run.length === 1) {
			groups.push({ range: first.comment.range, raw: first.comment.text, ...shapeOf(first, last) });
			continue;
		}

		const range = { start: first.comment.range.start, end: last.comment.range.end };
		const raw = coordinates.sliceRange(range);
		// A run the source cannot re-cut is a run whose spans disagree with the file, so each member
		// stays its own fact rather than one fact quoting text it does not cover.
		if (raw === undefined) {
			for (const item of run) {
				groups.push({ range: item.comment.range, raw: item.comment.text, ...shapeOf(item, item) });
			}
			continue;
		}
		groups.push({ range, raw, ...shapeOf(first, last) });
	}
	return groups;
}

/** A group starts where its first member does and ends where its last one does. */
function shapeOf(first: Placed, last: Placed): { ownLine: boolean; codeAfter: boolean } {
	return { ownLine: first.ownLine, codeAfter: last.codeAfter };
}

////////////////////////////////
//  Leading

/**
 * True when nothing between the comment and the declaration breaks their bond.
 *
 * A BLANK line breaks it: that is the reader's own paragraph break, and a comment fenced by blank
 * lines names neither neighbour. Anything written on a line does NOT break it, as long as no other
 * declaration starts there. An annotation, attribute, macro or modifier belongs to the declaration
 * it precedes, and languages disagree about whether the declaration's range covers it, so treating
 * that line as a wall loses the documentation of every decorated symbol in half the languages here.
 */
function nothingBetween(from: number, to: number, blankLines: Set<number>, declarationLines: Set<number>): boolean {
	for (let line = from + 1; line < to; line++) {
		if (blankLines.has(line) || declarationLines.has(line)) return false;
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
function leadingTarget(
	group: Group,
	declarations: Declaration[],
	blankLines: Set<number>,
	declarationLines: Set<number>,
): Declaration | undefined {
	const included = declarations.find((declaration) => sameStart(declaration.range, group.range));
	if (included !== undefined) return included;

	let nearest: Declaration | undefined;
	for (const declaration of declarations) {
		if (declaration.range.start.line <= group.range.end.line) continue;
		if (nearest !== undefined && declaration.range.start.line >= nearest.range.start.line) continue;
		nearest = declaration;
	}
	if (nearest === undefined) return undefined;
	if (!nothingBetween(group.range.end.line, nearest.range.start.line, blankLines, declarationLines)) return undefined;
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
	// A declaration with no name in the source is on no line.
	const onLine = declarations.flatMap((declaration) =>
		declaration.selectionRange?.start.line === line ? [{ declaration, at: declaration.selectionRange.start }] : [],
	);
	if (onLine.length === 0) return undefined;

	let left: (typeof onLine)[number] | undefined;
	for (const named of onLine) {
		if (named.at.character >= group.range.start.character) continue;
		if (left === undefined || named.at.character > left.at.character) left = named;
	}
	if (left !== undefined) return { anchor: left.declaration, side: "after" };

	let right: (typeof onLine)[number] | undefined;
	for (const named of onLine) {
		if (right === undefined || named.at.character < right.at.character) right = named;
	}
	return right === undefined ? undefined : { anchor: right.declaration, side: "before" };
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

	const coordinates = coordinatesOf(text);
	const blankLines = new Set<number>();
	for (let line = 0; line < coordinates.lineCount(); line++) {
		if ((coordinates.lineText(line) ?? "").trim() === "") blankLines.add(line);
	}
	const declarationLines = new Set(declarations.map((declaration) => declaration.range.start.line));

	// A declaration takes the NEAREST qualifying group; the rest of its candidates fall through to
	// standalone rather than every one of them claiming the same symbol.
	const leadFor = new Map<string, Group>();
	for (const group of groups) {
		if (!group.ownLine || group.codeAfter) continue;
		const target = leadingTarget(group, declarations, blankLines, declarationLines);
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
