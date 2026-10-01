// A declaration's header: the span its one-line signature renders, with the literal containers it
// folds, the comments and continuations it omits, and the strings it keeps as written.

import type { RawHeader } from "../header.js";
import type * as A from "../syntax/ast.js";
import { childNodes } from "../syntax/ast.js";
import type { Token, TokenType } from "../syntax/tokenizer.js";
import { type Binder, isAssignment, isFunction } from "./nodes.js";
import { CLOSE_BRACKETS, OPEN_BRACKETS, type Source } from "./source.js";
import type { Range } from "./types.js";

////////////////////////////////
//  Interfaces & Types

type Span = readonly [number, number];

/** The lead, the header span, and the values whose containers fold. */
type Shape = readonly [Span | undefined, number, number, A.Node[]];

////////////////////////////////
//  Constants

/** Headers ending at their own colon. */
const COMPOUND: ReadonlySet<A.Node["type"]> = new Set([
	"FunctionDef",
	"AsyncFunctionDef",
	"ClassDef",
	"For",
	"AsyncFor",
	"With",
	"AsyncWith",
]);

/** Literal containers a header folds; a tuple only when parenthesized. */
const FOLDED: ReadonlySet<A.Node["type"]> = new Set([
	"List",
	"Dict",
	"Set",
	"ListComp",
	"SetComp",
	"DictComp",
	"GeneratorExp",
]);

const STRINGS: ReadonlySet<A.Node["type"]> = new Set(["JoinedStr", "TemplateStr"]);
const STRING_OPENERS: ReadonlySet<TokenType> = new Set(["FSTRING_START", "TSTRING_START"]);
const STRING_CLOSERS: ReadonlySet<TokenType> = new Set(["FSTRING_END", "TSTRING_END"]);

////////////////////////////////
//  Functions & Helpers

/** The span widened over parentheses it closes or opens without holding both. */
function balanced(source: Source, start: number, end: number): Span | undefined {
	let first = source.tokenAt(start);
	let stop = source.tokenAt(end);
	if (first >= stop) return undefined;
	let depth = 0;
	let lowest = 0;
	for (let index = first; index < stop; index++) {
		const token = source.tokens[index] as Token;
		if (token.type === "OP" && OPEN_BRACKETS.has(token.string)) depth++;
		else if (token.type === "OP" && CLOSE_BRACKETS.has(token.string)) lowest = Math.min(lowest, --depth);
	}
	let opened = -lowest;
	let closed = depth - lowest;
	while (opened > 0 && first > 0) {
		first--;
		if ((source.tokens[first] as Token).string === "(") opened--;
	}
	while (closed > 0 && stop < source.tokens.length) {
		if ((source.tokens[stop] as Token).string === ")") closed--;
		stop++;
	}
	return [(source.tokens[first] as Token).pos, (source.tokens[stop - 1] as Token).end];
}

/** Expressions whose literal containers fold; targets, annotations and types stay whole. */
function headerValues(node: A.Node): A.Node[] {
	if (isFunction(node)) {
		return [
			...node.decoratorList,
			...node.args.defaults,
			...node.args.kwDefaults.filter((value) => value !== undefined),
		];
	}
	if (node.type === "ClassDef")
		return [...node.decoratorList, ...node.bases, ...node.keywords.map((item) => item.value)];
	if (node.type === "For" || node.type === "AsyncFor") return [node.iter];
	if (node.type === "With" || node.type === "AsyncWith") return node.items.map((item) => item.contextExpr);
	if (isAssignment(node) && node.value !== undefined) return [node.value];
	return [];
}

function parenthesized(source: Source, node: A.Node): boolean {
	const first = source.tokenAt(node.pos);
	const opening = source.tokens[first];
	if (opening === undefined || opening.pos !== node.pos || opening.string !== "(") return false;
	let depth = 0;
	for (let index = first; index < source.tokens.length; index++) {
		const token = source.tokens[index] as Token;
		if (token.type !== "OP") continue;
		if (OPEN_BRACKETS.has(token.string)) depth++;
		else if (CLOSE_BRACKETS.has(token.string) && --depth === 0) return token.end === node.end;
	}
	return false;
}

function headerFolds(source: Source, values: A.Node[]): Span[] {
	const folds: Span[] = [];
	const pending = [...values];
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (FOLDED.has(node.type) || (node.type === "Tuple" && parenthesized(source, node))) {
			folds.push([node.pos, node.end]);
		} else if (!STRINGS.has(node.type)) {
			// A subscript reads as a type.
			const slice = node.type === "Subscript" ? node.slice : undefined;
			pending.push(...childNodes(node).filter((child) => child !== slice));
		}
	}
	return folds.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

function headerShape(
	source: Source,
	node: Binder | A.Node,
	target: A.Node,
	whole: boolean,
	item?: A.WithItem,
): Shape | undefined {
	// Unpacked: no value of its own.
	if (!whole) return [undefined, target.pos, target.end, []];
	if (node.type === "Assign" && node.targets.length > 1) {
		const equals = source.operatorBefore(node.value.pos, "=");
		if (equals === undefined) return undefined;
		// Its own name leads the shared value.
		return [[target.pos, target.end], equals.pos, node.end, [node.value]];
	}
	if (
		item?.optionalVars !== undefined &&
		(node.type === "With" || node.type === "AsyncWith") &&
		node.items.length > 1
	) {
		let keyword = source.tokenAt(node.pos);
		if (source.tokens[keyword]?.string === "async") keyword++;
		const own = balanced(source, item.contextExpr.pos, item.optionalVars.end);
		const word = source.tokens[keyword];
		if (own === undefined || word === undefined) return undefined;
		return [[node.pos, word.end], own[0], own[1], [item.contextExpr]];
	}
	const start = source.declarationStart(node);
	if (COMPOUND.has(node.type)) {
		const colon = source.headerColon(node);
		return colon === undefined ? undefined : [undefined, start, colon.end, headerValues(node)];
	}
	return [undefined, start, node.end, headerValues(node)];
}

/** Line crossed without a line-end token. */
function continues(source: Source, previous: Token, token: Token): boolean {
	return source.line(token.pos) > source.line(previous.end) && previous.type !== "NL" && previous.type !== "NEWLINE";
}

/** Comments and backslash continuations to omit, strings kept as written; folds skipped. */
function headerCuts(source: Source, piece: Span, folds: Span[], omit: Range[], verbatim: Range[]): void {
	const [start, end] = piece;
	let index = source.tokenAt(start);
	let upcoming = folds.findIndex((fold) => fold[0] >= start);
	if (upcoming < 0) upcoming = folds.length;
	let depth = 0;
	let opened = 0;
	let previous: Token | undefined;
	while (index < source.tokens.length && (source.tokens[index] as Token).pos < end) {
		const token = source.tokens[index] as Token;
		const fold = folds[upcoming];
		if (fold !== undefined && token.pos >= fold[0]) {
			index = source.tokenAt(fold[1]);
			previous = source.tokens[index - 1];
			upcoming++;
			continue;
		}
		index++;
		if (depth === 0 && previous !== undefined && continues(source, previous, token)) {
			omit.push(source.range(previous.end, token.pos));
		}
		if (STRING_OPENERS.has(token.type)) {
			if (depth === 0) opened = token.pos;
			depth++;
		} else if (STRING_CLOSERS.has(token.type) && depth > 0) {
			if (--depth === 0) verbatim.push(source.range(opened, token.end));
		} else if (depth === 0 && token.type === "STRING") verbatim.push(source.range(token.pos, token.end));
		else if (depth === 0 && token.type === "COMMENT") omit.push(source.range(token.pos, token.end));
		previous = token;
	}
}

////////////////////////////////
//  Main

/** Spans for the header's one line; the provider renders them. */
export function headerOf(
	source: Source,
	node: A.Node,
	target: A.Node,
	whole = true,
	item?: A.WithItem,
): RawHeader | undefined {
	const shape = headerShape(source, node, target, whole, item);
	if (shape === undefined) return undefined;
	const [lead, start, end, values] = shape;
	const folds = headerFolds(source, values);
	const omit: Range[] = [];
	const verbatim: Range[] = [];
	for (const piece of [lead, [start, end] as const]) {
		if (piece !== undefined) headerCuts(source, piece, folds, omit, verbatim);
	}
	return {
		start: source.position(start),
		end: source.position(end),
		folds: folds.map(([from, to]) => source.range(from, to)),
		omit,
		verbatim,
		...(lead === undefined ? {} : { lead: source.range(lead[0], lead[1]) }),
	};
}
