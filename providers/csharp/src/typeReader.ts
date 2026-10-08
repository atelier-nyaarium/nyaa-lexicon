// Type syntax: shapes, tuples, and which angle brackets open type argument lists.

import { defined, type HeaderFold, type OffsetRange } from "@nyaa-lexicon/protocol";
import type { AnglePairs, BracketWalk, HeaderSkip, LeadingType, TypeFacts, TypeShape, TypeSpan } from "./model.js";
import { CsharpTokenStream } from "./tokenStream.js";
import type { Token } from "./tokens.js";
import {
	BUILTIN_TYPES,
	EMPTY_MAP,
	GROUP_CLOSERS,
	isIdentifier,
	MAX_TYPE_DEPTH,
	MODIFIERS,
	NOT_TUPLE_FOLLOWERS,
	syntaxValue,
	TYPE_ARGUMENT_FOLLOWERS,
	TYPE_LIST_PUNCTUATION,
	TYPE_OPERATORS,
	TYPE_PREFIXES,
	VALUE_FOLLOWERS,
	VALUE_OPENERS,
} from "./words.js";

////////////////////////////////
//  Classes

export class CsharpTypeReader extends CsharpTokenStream {
	/** Type argument list openers known to stay open up to this index. */
	private readonly openLists = new Map<number, number>();

	/** Closer of the group or type argument list at `index`; `index` when none opens, `end` when unclosed. */
	private closeOf(index: number, angles: AnglePairs, end: number): number {
		const value = this.value(index);
		if (value === "<") return angles.get(index) ?? index;
		const closer = value === undefined ? undefined : GROUP_CLOSERS.get(value);
		if (value === undefined || closer === undefined) return index;
		const close = this.matching(index, value, closer, end);
		return close < 0 ? end : close;
	}

	/** Split at the commas outside groups and type argument lists. */
	protected commaSegments(start: number, end: number, angles: AnglePairs = this.typeAngles(start, end)): TypeSpan[] {
		const segments: TypeSpan[] = [];
		let segmentStart = start;
		for (let current = start; current < end; current = this.closeOf(current, angles, end) + 1) {
			if (this.value(current) !== ",") continue;
			segments.push({ start: segmentStart, end: current });
			segmentStart = current + 1;
		}
		segments.push({ start: segmentStart, end });
		return segments;
	}

	/** First `value` outside groups and type argument lists. */
	protected topLevelValue(start: number, end: number, value: string, angles: AnglePairs): number {
		for (let current = start; current < end; current = this.closeOf(current, angles, end) + 1) {
			if (this.value(current) === value) return current;
		}
		return -1;
	}

	/** The outermost type argument list `close` ends; -1 when none. */
	protected listEndingAt(close: number, angles: AnglePairs): number {
		let found = -1;
		for (const [open, end] of angles) if (end === close && (found < 0 || open < found)) found = open;
		return found;
	}

	protected findDeclaratorName(start: number, end: number, angles: AnglePairs): number {
		for (let current = start; current < end; current = this.closeOf(current, angles, end) + 1) {
			if (!isIdentifier(this.token(current))) continue;
			const next = this.nextSignificant(current + 1, end);
			const nextValue = this.value(next);
			if (next < 0 || nextValue === "=" || nextValue === "[" || nextValue === ",") return current;
		}
		return -1;
	}

	protected spanBeforeName(start: number, nameIndex: number): TypeSpan | undefined {
		let first = this.nextSignificant(start, nameIndex);
		while (first >= 0 && first < nameIndex && MODIFIERS.has(this.value(first) ?? "")) {
			first = this.nextSignificant(first + 1, nameIndex);
		}
		const last = this.previousSignificant(nameIndex, first < 0 ? start : first);
		if (first < 0 || last < first || last >= nameIndex) return undefined;
		return { start: first, end: last + 1 };
	}

	/** Undefined when no type starts here. */
	protected typeShape(start: number, end: number, depth = 0): TypeShape | undefined {
		if (depth > MAX_TYPE_DEPTH) return undefined;
		const shape: TypeShape = {
			end: -1,
			composed: false,
			name: undefined,
			segments: [],
			qualifier: undefined,
			arity: 0,
			elementNames: [],
		};
		let current = this.nextSignificant(start, end);
		let expectName = true;
		let qualifiable = false;
		while (current >= 0 && current < end) {
			const item = this.token(current);
			const value = syntaxValue(item);
			let next = current + 1;
			if (expectName) {
				if (isIdentifier(item)) {
					shape.name = item;
					shape.arity = 0;
					// An alias left of `::` opens a name; it names nothing itself.
					const opens =
						shape.segments.length === 0 &&
						shape.qualifier === undefined &&
						this.value(this.nextSignificant(next, end)) === "::";
					if (opens) shape.qualifier = item.value;
					else shape.segments.push({ name: item.value, arity: 0 });
					qualifiable = true;
				} else if (value === "(" && shape.end < 0) {
					next = this.tupleClose(current, end, shape.elementNames, depth + 1) + 1;
					if (next <= 0) return undefined;
					shape.composed = true;
				} else break;
				expectName = false;
			} else if (value === "*" && syntaxValue(shape.name) === "delegate") {
				shape.composed = true;
				// Function pointer signature.
				const open = this.findTopLevelValue(next, end, "<");
				const pairs = open < 0 ? EMPTY_MAP : this.listWalk(open, end, depth + 1);
				const close = pairs.get(open) ?? -1;
				if (close < 0) break;
				this.typeArguments(open, close, shape.elementNames, depth + 1, pairs);
				next = close + 1;
				qualifiable = false;
			} else if (value === "<" && qualifiable) {
				shape.composed = true;
				const pairs = this.listWalk(current, end, depth + 1);
				const close = pairs.get(current) ?? -1;
				this.typeArguments(current, close < 0 ? end : close, shape.elementNames, depth + 1, pairs);
				// Closed by an outer `>>`.
				if (close < 0) {
					shape.end = end;
					break;
				}
				shape.arity = this.commaSegments(current + 1, close, pairs).length;
				const named = shape.segments.at(-1);
				if (named !== undefined) named.arity = shape.arity;
				next = close + 1;
			} else if ((value === "." || value === "::") && qualifiable) {
				expectName = true;
			} else if (value === "?" || value === "*") {
				shape.composed = true;
				qualifiable = false;
			} else if (value === "[") {
				const close = this.matching(current, "[", "]", end);
				if (close < 0) break;
				shape.composed = true;
				next = close + 1;
				qualifiable = false;
			} else break;
			if (!expectName) shape.end = next;
			current = this.nextSignificant(next, end);
		}
		return shape.end < 0 ? undefined : shape;
	}

	/** -1 when not a tuple type. */
	private tupleClose(open: number, end: number, names: number[], depth: number): number {
		const close = this.matching(open, "(", ")", end);
		if (close < 0) return -1;
		const segments = this.commaSegments(open + 1, close, this.typeAngles(open + 1, close, false, depth));
		if (segments.length < 2) return -1;
		const found: number[] = [];
		for (const segment of segments) {
			const element = this.typeShape(segment.start, segment.end, depth);
			if (element === undefined) return -1;
			found.push(...element.elementNames);
			const name = this.nextSignificant(element.end, segment.end);
			if (name < 0) continue;
			if (!isIdentifier(this.token(name)) || this.nextSignificant(name + 1, segment.end) >= 0) return -1;
			found.push(name);
		}
		names.push(...found);
		return close;
	}

	/** Tuple names in type arguments. */
	private typeArguments(open: number, close: number, names: number[], depth: number, angles: AnglePairs): void {
		for (const segment of this.commaSegments(open + 1, close, angles)) {
			names.push(...(this.typeShape(segment.start, segment.end, depth)?.elementNames ?? []));
		}
	}

	/** Past modifier words. */
	protected leadingType(span: TypeSpan): LeadingType | undefined {
		let first = this.nextSignificant(span.start, span.end);
		while (first >= 0 && TYPE_PREFIXES.has(this.value(first) ?? ""))
			first = this.nextSignificant(first + 1, span.end);
		const shape = first < 0 ? undefined : this.typeShape(first, span.end);
		return shape === undefined ? undefined : { first, shape };
	}

	protected declaredType(span: TypeSpan | undefined): TypeFacts {
		if (span === undefined) return {};
		return this.typeFacts(this.leadingType(span));
	}

	/** `var` declares neither. */
	protected typeFacts(leading: LeadingType | undefined): TypeFacts {
		if (leading === undefined) return {};
		const first = this.token(leading.first) as Token;
		const last = this.token(this.previousSignificant(leading.shape.end, leading.first)) as Token;
		if (first === last && syntaxValue(first) === "var") return {};
		const { name, segments, qualifier, composed } = leading.shape;
		return {
			typeText: this.sourceSpan(first, last),
			...(name === undefined || BUILTIN_TYPES.has(syntaxValue(name) ?? "") || segments.length === 0
				? {}
				: { typeSegments: segments, ...defined({ typeQualifier: qualifier }) }),
			...(composed ? { typeComposed: true as const } : {}),
		};
	}

	/** Searched past the type. */
	protected firstDeclaratorName(start: number, end: number, angles: AnglePairs): number {
		const type = this.typeShape(start, end);
		const name = type === undefined ? -1 : this.findDeclaratorName(type.end, end, angles);
		return name >= 0 ? name : this.findDeclaratorName(start, end, angles);
	}

	/** Token `first` through the last significant token before `end`, on one line. */
	protected header(first: number, end: number, skip?: HeaderSkip): string | undefined {
		const last = this.previousSignificant(end, first);
		const head = this.token(first);
		const tail = this.token(last);
		if (last < first || head === undefined || tail === undefined) return undefined;
		const folds: HeaderFold[] = [];
		/** Opener index to closer index. */
		const folded = new Map<number, number>();
		const omit: OffsetRange[] = [];
		const verbatim: OffsetRange[] = [];
		let lead: OffsetRange | undefined;
		let start = head.startOffset;
		let previous: Token | undefined;
		let before = -1;
		for (let index = first; index <= last; index++) {
			if (this.meter !== undefined) this.meter.steps++;
			const item = this.tokens[index] as Token;
			if (index === skip?.from) {
				const shared = this.token(before);
				if (shared !== undefined) lead = { start, end: shared.endOffset };
				start = (this.tokens[skip.to] as Token).startOffset;
				index = skip.to - 1;
				previous = undefined;
				continue;
			}
			if (previous !== undefined && this.lexed.droppedBefore.has(item))
				omit.push({ start: previous.endOffset, end: item.startOffset });
			previous = item;
			if (item.kind === "comment" || item.kind === "doc" || item.kind === "directive") {
				omit.push({ start: item.startOffset, end: item.endOffset });
				continue;
			}
			if (item.kind === "newline") continue;
			const whole = item.kind === "string" ? this.lexed.interpolated.get(item.startOffset) : undefined;
			if (whole !== undefined) {
				// An interpolated string reads as written, its holes' groups never walked.
				verbatim.push({ start: whole.startOffset, end: whole.endOffset });
				while (index < last && (this.tokens[index + 1] as Token).startOffset < whole.endOffset) {
					index++;
					if (this.value(index) === "{") folded.set(index, this.matching(index, "{", "}", last + 1));
				}
				previous = this.tokens[index] as Token;
				before = index;
				continue;
			}
			if (item.kind === "string" || item.kind === "character")
				verbatim.push({ start: item.startOffset, end: item.endOffset });
			const close = this.valueContainerEnd(index, before, last);
			if (close > index) {
				const closeToken = this.tokens[close] as Token;
				folds.push({ start: item.startOffset, end: closeToken.endOffset });
				folded.set(index, close);
				index = close;
				previous = closeToken;
			}
			before = index;
		}
		return this.render({
			...(lead === undefined ? {} : { lead }),
			start,
			end: tail.endOffset,
			folds,
			omit,
			verbatim,
			angles:
				skip === undefined
					? this.typeBrackets(first, last + 1, folded)
					: [...this.typeBrackets(first, skip.from, folded), ...this.typeBrackets(skip.to, last + 1, folded)],
		});
	}

	/** Offsets of the `<` and `>` read as type brackets; folded groups are never walked. */
	private typeBrackets(start: number, end: number, folded: ReadonlyMap<number, number>): number[] {
		const walk: BracketWalk = { pairs: new Map(), folded };
		this.bracketsIn(start, end, false, walk, 0);
		const offsets: number[] = [];
		// A `>>` closing two lists closes the inner with its first half.
		const halves = new Map<number, number>();
		for (const [open, close] of [...walk.pairs].sort((left, right) => right[0] - left[0])) {
			const half = halves.get(close) ?? 0;
			halves.set(close, half + 1);
			offsets.push((this.tokens[open] as Token).startOffset, (this.tokens[close] as Token).startOffset + half);
		}
		return offsets;
	}

	/** The type bracket pairs of a span that starts as a type, or as a value. */
	protected typeAngles(start: number, end: number, value = false, depth = 0): AnglePairs {
		const walk: BracketWalk = { pairs: new Map(), folded: EMPTY_MAP };
		this.bracketsIn(start, end, value, walk, depth);
		return walk.pairs;
	}

	/** The `>` or `>>` closing the type argument list opening at `open`; -1 when none does before `end`. */
	protected listClose(open: number, end: number): number {
		return this.listWalk(open, end, 0).get(open) ?? -1;
	}

	/** The pairs of the type argument list opening at `open`, its own included once it closes. */
	private listWalk(open: number, end: number, depth: number): AnglePairs {
		const walk: BracketWalk = { pairs: new Map(), folded: EMPTY_MAP };
		this.bracketsIn(open + 1, end, false, walk, depth, open);
		return walk.pairs;
	}

	/**
	 * A value group keeps a type argument list only where the grammar's disambiguation does.
	 *
	 * With `opened`, the walk is inside the list opening there and stops once it closes, or at a
	 * token no type argument list holds. A list it leaves open stays open in a walk of its own, so
	 * each is remembered.
	 */
	private bracketsIn(
		start: number,
		end: number,
		value: boolean,
		walk: BracketWalk,
		depth: number,
		opened?: number,
	): void {
		if (depth > MAX_TYPE_DEPTH) return;
		const lists: number[] = opened === undefined ? [] : [opened];
		let inValue = value;
		let afterColon = false;
		let previous = -1;
		for (
			let current = this.nextSignificant(start, end);
			current >= 0 && current < end;
			current = this.nextSignificant(current + 1, end)
		) {
			if (this.meter !== undefined) this.meter.steps++;
			const item = this.token(current) as Token;
			const text = syntaxValue(item);
			const typed = lists.length > 0 || !inValue;
			if (opened !== undefined && !isIdentifier(item) && !TYPE_LIST_PUNCTUATION.has(text ?? "")) break;
			if (text === "<" && this.opensTypeList(previous, current, end, typed, depth)) {
				lists.push(current);
			} else if ((text === ">" || text === ">>") && lists.length > 0) {
				// A `>>` with a half to spare leaves the opened list unclosed.
				if (text === ">>" && lists.length === 1 && opened !== undefined) break;
				walk.pairs.set(lists.pop() as number, current);
				// One `>>` closes two lists.
				if (text === ">>" && lists.length > 0) walk.pairs.set(lists.pop() as number, current);
				if (lists.length === 0 && opened !== undefined) return;
			} else if (text === "operator" && typed) {
				// Its symbol, `>>>` being two tokens.
				let symbol = this.nextSignificant(current + 1, end);
				while (this.token(symbol)?.kind === "punctuation" && this.value(symbol) !== "(") {
					current = symbol;
					symbol = this.nextSignificant(symbol + 1, end);
				}
			} else if (text === "(" || text === "[" || text === "{") {
				const fold = walk.folded.get(current);
				const close = fold ?? this.matching(current, text, GROUP_CLOSERS.get(text) as string, end);
				if (close < 0) break;
				const holdsValue = this.groupHoldsValue(text, previous, typed, afterColon, lists.length > 0);
				if (fold === undefined) this.bracketsIn(current + 1, close, holdsValue, walk, depth + 1);
				current = close;
			} else if (lists.length === 0) {
				if (text === "=") inValue = true;
				else if (text === ",") inValue = value;
				else if (text === ":" && !inValue) afterColon = true;
			}
			previous = current;
		}
		if (opened === undefined) return;
		for (const open of lists) this.openLists.set(open, Math.max(this.openLists.get(open) ?? -1, end));
	}

	protected opensTypeList(previous: number, open: number, end: number, typed: boolean, depth: number): boolean {
		const before = this.token(previous);
		if (!typed) return isIdentifier(before) && this.expressionTypeArguments(open, end, depth);
		if (isIdentifier(before)) return true;
		// A function pointer, `delegate*` or `delegate* unmanaged[...]`.
		let star = previous;
		if (syntaxValue(before) === "]") {
			const bracket = this.opener(previous, "[", "]");
			const convention = bracket < 0 ? -1 : this.previousSignificant(bracket);
			if (this.value(convention) !== "unmanaged") return false;
			star = this.previousSignificant(convention);
		}
		return this.value(star) === "*" && this.value(this.previousSignificant(star)) === "delegate";
	}

	/** Types only, then a follower that keeps the list. */
	private expressionTypeArguments(open: number, end: number, depth: number): boolean {
		if ((this.openLists.get(open) ?? -1) >= end) return false;
		const pairs = this.listWalk(open, end, depth + 1);
		const close = pairs.get(open);
		if (close === undefined) return false;
		for (const segment of this.commaSegments(open + 1, close, pairs)) {
			const shape = this.typeShape(segment.start, segment.end, depth + 1);
			if (shape === undefined || this.nextSignificant(shape.end, segment.end) >= 0) return false;
		}
		const follower = this.token(this.nextSignificant(close + 1));
		return follower?.kind === "eof" || TYPE_ARGUMENT_FOLLOWERS.has(syntaxValue(follower) ?? "");
	}

	/** Parameter lists, tuples, typeof operands and indexer parameters hold types. */
	private groupHoldsValue(
		open: string,
		previous: number,
		typed: boolean,
		afterColon: boolean,
		inList: boolean,
	): boolean {
		if (open === "{") return true;
		const before = this.value(previous) ?? "";
		if (open === "[") return !(typed && before === "this");
		if (!typed) return !TYPE_OPERATORS.has(before);
		// Base and constructor initializer arguments.
		return !inList && afterColon;
	}

	/** Where a literal container opening at `index` closes; -1 when none does. */
	private valueContainerEnd(index: number, before: number, last: number): number {
		const value = this.value(index);
		if (value === "{") return this.matching(index, "{", "}", last + 1);
		const opener = this.value(before);
		if (opener === undefined || !VALUE_OPENERS.has(opener)) return -1;
		if (value === "[") {
			const close = this.matching(index, "[", "]", last + 1);
			if (close < 0 || this.declaresAfter(close, last)) return -1;
			// `a?[0]` indexes; `c ? [0] : d` is a branch.
			return opener === "?" && this.value(this.nextSignificant(close + 1, last + 1)) !== ":" ? -1 : close;
		}
		if (value !== "(") return -1;
		if (opener === "(" && TYPE_OPERATORS.has(this.value(this.previousSignificant(before)) ?? "")) return -1;
		const close = this.matching(index, "(", ")", last + 1);
		if (close < 0 || this.firstComma(index) < 0) return -1;
		// The comma may sit inside type arguments.
		if (this.commaSegments(index + 1, close, this.typeAngles(index + 1, close, true)).length < 2) return -1;
		const after = this.value(this.nextSignificant(close + 1, last + 1)) ?? "";
		return NOT_TUPLE_FOLLOWERS.has(after) || this.declaresAfter(close, last) ? -1 : close;
	}

	/** A name or type after `close` makes the brackets an attribute or a tuple type. */
	private declaresAfter(close: number, last: number): boolean {
		const next = this.token(this.nextSignificant(close + 1, last + 1));
		if (isIdentifier(next)) return !VALUE_FOLLOWERS.has(syntaxValue(next) as string);
		const value = syntaxValue(next);
		return value === "(" || value === "[" || value === "?";
	}
}
