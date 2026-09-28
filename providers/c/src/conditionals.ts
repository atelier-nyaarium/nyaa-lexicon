// Which tokens a parse reads through `#if` groups: one branch of each closed group, or every branch when
// each leaves its delimiters balanced.

import { type Diagnostic, defined, type OffsetRange } from "@nyaa-lexicon/protocol";
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

interface ConditionalBranch {
	start: number;
	end: number;
}

interface ConditionalGroup {
	ifIndex: number;
	branches: ConditionalBranch[];
	parent: ConditionalGroup | undefined;
	closed: boolean;
	/** Exclusive: past its `#endif` line. */
	end: number;
	children: ConditionalGroup[];
	/** Delimiters its kept tokens leave unmatched. */
	residue: string[];
}

////////////////////////////////
//  Constants

/** Each closing delimiter's opener. */
const DELIMITER_OPENERS: ReadonlyMap<string, string> = new Map([
	[")", "("],
	["]", "["],
	["}", "{"],
]);

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

/** An unclosed group anywhere above leaves a group's branches as they are. */
/** Adds `value` to the unmatched delimiters in `residue`, cancelling the opener it closes. */
function pushDelimiter(residue: string[], value: string): void {
	const opener = DELIMITER_OPENERS.get(value);
	if (opener === undefined) {
		if (value === "(" || value === "[" || value === "{") residue.push(value);
		return;
	}
	if (residue.at(-1) === opener) residue.pop();
	else residue.push(value);
}

/** Delimiters each branch leaves unmatched, each nested group by the tokens it keeps. */
function branchResidues(tokens: CToken[], group: ConditionalGroup, directiveTokens: ReadonlySet<number>): string[][] {
	// Children in source order, so one cursor serves every branch.
	let child = 0;
	return group.branches.map((branch) => {
		const residue: string[] = [];
		for (let index = branch.start; index < branch.end; index++) {
			while (child < group.children.length && (group.children[child] as ConditionalGroup).ifIndex < index)
				child++;
			const nested = group.children[child];
			if (nested !== undefined && nested.ifIndex === index) {
				for (const value of nested.residue) pushDelimiter(residue, value);
				index = nested.end - 1;
				child++;
				continue;
			}
			if (directiveTokens.has(index)) continue;
			// A string or comment spelling a bracket is content, not a delimiter.
			pushDelimiter(residue, syntaxValue(tokens[index]));
		}
		return residue;
	});
}

export function resolveConditionals(module: string, tokens: CToken[], diagnostics: Diagnostic[]): CToken[] {
	const directives = directiveTokens(tokens);
	const groups: ConditionalGroup[] = [];
	const stack: ConditionalGroup[] = [];
	const allDirectiveTokens = new Set<number>();
	const protectedTokens = new Set<number>();
	for (const directive of directives) {
		for (let index = directive.start; index < directive.end; index++) allDirectiveTokens.add(index);
		if (!["if", "ifdef", "ifndef", "elif", "else", "endif"].includes(directive.keyword)) continue;
		for (let index = directive.start; index < directive.end; index++) protectedTokens.add(index);
	}
	for (const directive of directives) {
		if (["if", "ifdef", "ifndef"].includes(directive.keyword)) {
			const group: ConditionalGroup = {
				ifIndex: directive.start,
				branches: [{ start: directive.end, end: tokens.length }],
				parent: stack.at(-1),
				closed: false,
				end: tokens.length,
				children: [],
				residue: [],
			};
			group.parent?.children.push(group);
			groups.push(group);
			stack.push(group);
			continue;
		}
		if (["elif", "else"].includes(directive.keyword)) {
			const group = stack.at(-1);
			if (group === undefined) {
				diagnostics.push({
					severity: "error",
					message: `Unexpected #${directive.keyword} outside a conditional.`,
					path: module,
					range: tokenRange(tokens[directive.start] as CToken),
				});
				continue;
			}
			(group.branches.at(-1) as ConditionalBranch).end = directive.start;
			group.branches.push({ start: directive.end, end: tokens.length });
			continue;
		}
		if (directive.keyword === "endif") {
			const group = stack.pop();
			if (group === undefined) {
				diagnostics.push({
					severity: "error",
					message: "Unexpected #endif outside a conditional.",
					path: module,
					range: tokenRange(tokens[directive.start] as CToken),
				});
				continue;
			}
			(group.branches.at(-1) as ConditionalBranch).end = directive.start;
			group.closed = true;
			group.end = directive.end;
		}
	}
	for (const group of stack) {
		const token = tokens[group.ifIndex] as CToken;
		diagnostics.push({
			severity: "error",
			message: "Conditional directive is not closed.",
			path: module,
			range: tokenRange(token),
		});
	}
	const directiveByIndex = new Map(directives.map((directive) => [directive.start, directive]));
	// An unclosed group anywhere above leaves a group's branches as they are.
	const closedThroughout = new Set<ConditionalGroup>();
	for (const group of groups) {
		if (group.closed && (group.parent === undefined || closedThroughout.has(group.parent)))
			closedThroughout.add(group);
	}
	// Inner groups first, so each residue counts only what its nested groups keep.
	const cover = new Int32Array(tokens.length + 1);
	for (const group of groups.toReversed()) {
		if (!closedThroughout.has(group)) continue;
		const directive = directiveByIndex.get(group.ifIndex) as ConditionalDirective;
		const activeBranch = firstConditionIsZero(tokens, directive) ? 1 : 0;
		const residues = branchResidues(tokens, group, allDirectiveTokens);
		const allWhole = residues.every((residue) => residue.length === 0);
		for (let branch = 0; branch < group.branches.length; branch++) {
			const kept = allWhole ? !(activeBranch === 1 && branch === 0) : branch === activeBranch;
			if (kept) {
				for (const value of residues[branch] as string[]) pushDelimiter(group.residue, value);
				continue;
			}
			const segment = group.branches[branch] as ConditionalBranch;
			cover[segment.start] = (cover[segment.start] as number) + 1;
			cover[segment.end] = (cover[segment.end] as number) - 1;
		}
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
