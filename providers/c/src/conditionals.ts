// Which tokens a parse reads through `#if` groups: one branch of each closed group, or every branch when
// each leaves its delimiters balanced.

import { type Diagnostic, defined, type OffsetRange, resolveConditionalGroups } from "@nyaa-lexicon/protocol";
import type { CToken } from "./tokens.js";
import { syntaxValue, tokenRange, widened } from "./tokenWalk.js";

////////////////////////////////
//  Interfaces & Types

interface ConditionalDirective {
	start: number;
	end: number;
	keyword: string;
	keywordIndex: number;
}

////////////////////////////////
//  Constants

////////////////////////////////
//  Functions & Helpers

function conditionalEnd(tokens: CToken[], start: number): number {
	let index = start + 1;
	while (index < tokens.length) {
		if (tokens[index]?.kind !== "newline") {
			index++;
			continue;
		}
		let previous = index - 1;
		while (previous >= start && tokens[previous]?.kind === "comment") previous--;
		if (previous >= start && tokens[previous]?.value === "\\") {
			index++;
			continue;
		}
		return index;
	}
	return tokens.length;
}

function directiveTokens(tokens: CToken[]): ConditionalDirective[] {
	const directives: ConditionalDirective[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as CToken;
		if (token.kind !== "symbol" || token.value !== "#" || !token.lineStart) continue;
		const end = conditionalEnd(tokens, index);
		let keywordIndex = index + 1;
		while (
			keywordIndex < end &&
			(tokens[keywordIndex]?.kind === "comment" || tokens[keywordIndex]?.kind === "newline")
		)
			keywordIndex++;
		const keyword = tokens[keywordIndex]?.value;
		if (keyword !== undefined) directives.push({ start: index, end, keyword, keywordIndex });
		index = Math.max(index, end - 1);
	}
	return directives;
}

function firstConditionIsZero(tokens: CToken[], directive: ConditionalDirective): boolean {
	let next = directive.keywordIndex + 1;
	while (next < directive.end && (tokens[next]?.kind === "comment" || tokens[next]?.kind === "newline")) next++;
	if (next >= directive.end || tokens[next]?.kind !== "number" || tokens[next]?.value !== "0") return false;
	next++;
	while (next < directive.end && (tokens[next]?.kind === "comment" || tokens[next]?.kind === "newline")) next++;
	return next >= directive.end;
}

export function resolveConditionals(module: string, tokens: CToken[], diagnostics: Diagnostic[]): CToken[] {
	const directives = directiveTokens(tokens);
	const allDirectiveTokens = new Set<number>();
	const protectedTokens = new Set<number>();
	for (const directive of directives) {
		for (let index = directive.start; index < directive.end; index++) allDirectiveTokens.add(index);
		if (!["if", "ifdef", "ifndef", "elif", "else", "endif"].includes(directive.keyword)) continue;
		for (let index = directive.start; index < directive.end; index++) protectedTokens.add(index);
	}
	const directiveByIndex = new Map(directives.map((directive) => [directive.start, directive]));
	const resolution = resolveConditionalGroups({
		directives,
		tokenCount: tokens.length,
		directiveTokens: allDirectiveTokens,
		firstConditionIsZero: (index) =>
			firstConditionIsZero(tokens, directiveByIndex.get(index) as ConditionalDirective),
		delimiterAt: (index) => syntaxValue(tokens[index]),
	});
	for (const issue of resolution.issues) {
		const token = tokens[issue.index] as CToken;
		const message =
			issue.kind === "unexpected-branch"
				? `Unexpected #${issue.keyword} outside a conditional.`
				: issue.kind === "unexpected-end"
					? "Unexpected #endif outside a conditional."
					: "Conditional directive is not closed.";
		diagnostics.push({ severity: "error", message, path: module, range: tokenRange(token) });
	}
	const cover = new Int32Array(tokens.length + 1);
	for (const segment of resolution.removedBranches) {
		cover[segment.start] = (cover[segment.start] as number) + 1;
		cover[segment.end] = (cover[segment.end] as number) - 1;
	}
	const removed: boolean[] = new Array(tokens.length);
	let depth = 0;
	for (let index = 0; index < tokens.length; index++) {
		depth += cover[index] as number;
		removed[index] = depth > 0 && !protectedTokens.has(index);
	}
	return keptTokens(tokens, removed);
}

/** Tokens not `removed`, each carrying the removed run just before it. */
function keptTokens(tokens: CToken[], removed: readonly boolean[]): CToken[] {
	const kept: CToken[] = [];
	let run: OffsetRange | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as CToken;
		if (token.hiddenBefore !== undefined) run = widened(run, token.hiddenBefore);
		if (removed[index] !== true) {
			kept.push(run === token.hiddenBefore ? token : { ...token, ...defined({ hiddenBefore: run }) });
			run = undefined;
			continue;
		}
		if (token.kind !== "newline") run = widened(run, { start: token.startOffset, end: token.endOffset });
	}
	return kept;
}
