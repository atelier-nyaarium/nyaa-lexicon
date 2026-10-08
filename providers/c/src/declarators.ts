// Reading a declaration's tokens: code past directives, its specifiers, its declarators and how they spell.

import { defined } from "@nyaa-lexicon/protocol";
import { type TokenSpan, tokenHeader } from "./header.js";
import type { AggregateInfo, DeclarationHead, DeclaratorName, FunctionCandidate, TypeName } from "./model.js";
import { CDeclarationRecords } from "./records.js";
import type { CToken } from "./tokens.js";
import { dottedEnd, nextCode, previousCode, qualifiedNameForIdentifier, spelledName, tokenValue } from "./tokenWalk.js";
import {
	ALIGNMENT_SPECIFIERS,
	ARGUMENT_SPECIFIERS,
	ASM_LABELS,
	ASSIGNMENT_OPERATORS,
	ATTRIBUTE_SPECIFIERS,
	BUILTIN_TYPES,
	C_KEYWORDS,
	CALLING_CONVENTIONS,
	isIdentifierToken,
	isSpecifierWord,
	isTypeToken,
	joinSpelling,
	TAG_WORDS,
	TYPE_OPERATORS,
	TYPE_QUALIFIERS,
	typeWords,
	UNSPELLED_WORDS,
	wordLike,
} from "./words.js";

////////////////////////////////
//  Constants

/** Specifiers whose `(...)` holds a type name or an expression. */
const OPERAND_SPECIFIERS: ReadonlySet<string> = new Set([...TYPE_OPERATORS, ...ALIGNMENT_SPECIFIERS]);

////////////////////////////////
//  Classes

export class CDeclaratorReader extends CDeclarationRecords {
	protected readonly typeUseIndices = new Set<number>();

	/** Macro calls read as attributes before a declaration's specifiers. */
	private readonly macroTokens = new Set<number>();

	////////////////////////////////
	//  Token walks

	/** The next code token from `index`, past directive lines. */
	protected code(index: number, end = this.tokens.length): number {
		let current = nextCode(this.tokens, index, end);
		while (current < end && this.directiveTokens.has(current))
			current = nextCode(this.tokens, this.directiveEndByToken.get(current) ?? current + 1, end);
		return current;
	}

	/** The code token before `index`, past directive lines. */
	protected codeBefore(index: number): number {
		let current = previousCode(this.tokens, index);
		while (current >= 0 && this.directiveTokens.has(current)) current = previousCode(this.tokens, current);
		return current;
	}

	protected headHas(head: DeclarationHead, words: ReadonlySet<string>): boolean {
		for (const word of words) if (head.specifiers.has(word)) return true;
		return false;
	}

	/** The first of `wanted` at the top level of `[start, end)`, or -1. */
	protected topLevelIndex(start: number, end: number, wanted: ReadonlySet<string>): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = start; index < end; index++) {
			if (this.directiveTokens.has(index)) continue;
			const value = tokenValue(this.tokens, index);
			if (parentheses === 0 && brackets === 0 && braces === 0 && wanted.has(value)) return index;
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
		}
		return -1;
	}

	protected splitSegments(start: number, end: number): Array<{ start: number; end: number }> {
		const segments: Array<{ start: number; end: number }> = [];
		let segmentStart = start;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = start; index < end; index++) {
			if (this.directiveTokens.has(index)) continue;
			const value = tokenValue(this.tokens, index);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			else if (value === "," && parentheses === 0 && brackets === 0 && braces === 0) {
				segments.push({ start: segmentStart, end: index });
				segmentStart = index + 1;
			}
		}
		segments.push({ start: segmentStart, end });
		return segments;
	}

	/** Close of the `(...)` an argument-taking word opens, or -1. */
	protected argumentsClose(index: number, end: number): number {
		const token = this.tokens[index];
		if (
			!isIdentifierToken(token) ||
			!(ARGUMENT_SPECIFIERS.has(token.value) || TYPE_OPERATORS.has(token.value) || ASM_LABELS.has(token.value))
		)
			return -1;
		const open = nextCode(this.tokens, index + 1, end);
		if (tokenValue(this.tokens, open) !== "(") return -1;
		return this.pairs.get(open) ?? -1;
	}

	/** Past `[[...]]` attribute groups at `index`. */
	protected pastAttributes(index: number, end: number): number {
		let cursor = index;
		while (cursor < end && this.attributeTokens.has(cursor)) {
			const close = this.pairs.get(cursor);
			if (close === undefined || close < cursor) return cursor;
			cursor = this.code(close + 1, end);
		}
		return cursor;
	}

	/** Past `[[...]]` groups and `__attribute__((...))` specifiers at `index`. */
	private pastAttributeSpecifiers(index: number, end: number): number {
		let cursor = index;
		for (let previous = -1; cursor > previous; ) {
			previous = cursor;
			cursor = this.pastAttributes(cursor, end);
			const token = this.tokens[cursor];
			if (!isIdentifierToken(token) || !ATTRIBUTE_SPECIFIERS.has(token.value)) continue;
			const close = this.argumentsClose(cursor, end);
			if (close >= 0) cursor = this.code(close + 1, end);
		}
		return cursor;
	}

	/** Whether a declaration's specifiers start at `index`. */
	private startsSpecifiers(index: number): boolean {
		const token = this.tokens[index];
		if (!isIdentifierToken(token)) return false;
		return TAG_WORDS.has(token.value) || this.plainSpecifierAt(index) || !C_KEYWORDS.has(token.value);
	}

	/**
	 * A pointer declarator in parentheses, `(*name)` or `(WINAPI *name)`, followed by `(` or `[`; with
	 * `bare`, also by nothing.
	 */
	private groupedDeclarator(open: number, end: number, bare = false): boolean {
		if (tokenValue(this.tokens, open) !== "(") return false;
		let inner = this.code(open + 1, end);
		// Calling conventions and their macros sit before the pointer.
		for (let token = this.tokens[inner]; isIdentifierToken(token) && !C_KEYWORDS.has(token.value); ) {
			inner = this.code(inner + 1, end);
			token = this.tokens[inner];
		}
		if (tokenValue(this.tokens, inner) !== "*") return false;
		const close = this.pairs.get(open);
		if (close === undefined || close >= end) return false;
		const next = this.code(close + 1, end);
		const after = tokenValue(this.tokens, next);
		return after === "(" || after === "[" || (bare && (next >= end || [",", "=", ";"].includes(after)));
	}

	protected looksLikeDeclaration(start: number, end: number): boolean {
		const token = this.tokens[start];
		if (token === undefined) return false;
		if (token.kind !== "identifier") return false;
		if (TAG_WORDS.has(token.value) || token.value === "typedef") return true;
		if (isSpecifierWord(token.value)) return true;
		if (C_KEYWORDS.has(token.value)) return false;
		const next = this.code(dottedEnd(this.tokens, start) + 1, end);
		return (
			isIdentifierToken(this.tokens[next]) ||
			tokenValue(this.tokens, next) === "*" ||
			this.groupedDeclarator(next, end)
		);
	}

	////////////////////////////////
	//  Specifiers and declarators

	/** The specifiers from `first`, and the aggregate among them. */
	/** With `bare`, `T (*name);` declares; in a body it is a call. */
	protected readHead(first: number, end: number, bare = true): DeclarationHead {
		const start = this.code(first, end);
		let cursor = start;
		if (tokenValue(this.tokens, cursor) === "extern") {
			const linkage = this.code(cursor + 1, end);
			if (this.tokens[linkage]?.kind === "string") cursor = this.code(linkage + 1, end);
		}
		let sawType = false;
		let builtin = false;
		let aggregate: AggregateInfo | undefined;
		const specifiers = new Set<string>();
		while (cursor < end) {
			if (this.attributeTokens.has(cursor)) {
				cursor = this.pastAttributes(cursor, end);
				continue;
			}
			const token = this.tokens[cursor] as CToken;
			if (token.kind !== "identifier") break;
			if (TAG_WORDS.has(token.value)) {
				sawType = true;
				builtin = true;
				const read = this.readAggregate(cursor, end);
				aggregate ??= read.aggregate;
				cursor = read.next;
				continue;
			}
			const argumentsClose = this.argumentsClose(cursor, end);
			if (argumentsClose >= 0) {
				sawType = sawType || TYPE_OPERATORS.has(token.value);
				builtin = builtin || TYPE_OPERATORS.has(token.value);
				cursor = this.code(argumentsClose + 1, end);
				continue;
			}
			const next = this.code(dottedEnd(this.tokens, cursor) + 1, end);
			if (isSpecifierWord(token.value)) {
				if (sawType && (next >= end || [",", ";", "="].includes(tokenValue(this.tokens, next)))) break;
				sawType = sawType || BUILTIN_TYPES.has(token.value);
				builtin = builtin || BUILTIN_TYPES.has(token.value);
				specifiers.add(token.value);
				cursor = next;
				continue;
			}
			if (!sawType && tokenValue(this.tokens, next) === "(" && !this.groupedDeclarator(next, end, bare)) {
				// A call the specifiers follow on its line is an attribute macro; any other declares, its type implicit.
				const close = this.pairs.get(next);
				const after = close === undefined || close >= end ? end : this.code(close + 1, end);
				if (
					close === undefined ||
					after >= end ||
					!this.startsSpecifiers(this.pastAttributeSpecifiers(after, end))
				)
					break;
				if ((this.tokens[after] as CToken).start.line !== (this.tokens[close] as CToken).end.line) break;
				for (let index = cursor; index <= close; index++) this.macroTokens.add(index);
				cursor = after;
				continue;
			}
			// Past a name taken for the type, a declarator or a keyword type after this one makes the names macros.
			if (sawType && !this.declaratorFollows(next, end) && (builtin || !this.plainSpecifierAt(next))) break;
			sawType = true;
			cursor = next;
		}
		return {
			first: start,
			listStart: cursor,
			...defined({ aggregate }),
			specifiers,
			typedef: specifiers.has("typedef"),
		};
	}

	/** `struct`, `union` or `enum` at `keywordIndex`, its tag and its body. */
	private readAggregate(keywordIndex: number, end: number): { aggregate: AggregateInfo; next: number } {
		const keyword = tokenValue(this.tokens, keywordIndex) as AggregateInfo["keyword"];
		let cursor = this.skipArguments(this.code(keywordIndex + 1, end), end);
		let tagIndex = -1;
		let tagEndIndex = -1;
		if (isIdentifierToken(this.tokens[cursor])) {
			tagIndex = cursor;
			tagEndIndex = dottedEnd(this.tokens, cursor);
			cursor = this.skipArguments(this.code(tagEndIndex + 1, end), end);
		}
		let bodyOpen = -1;
		let bodyClose = -1;
		if (tokenValue(this.tokens, cursor) === "{") {
			bodyOpen = cursor;
			bodyClose = this.pairs.get(cursor) ?? -1;
			cursor = bodyClose < 0 ? end : this.code(bodyClose + 1, end);
		}
		return { aggregate: { keyword, keywordIndex, tagIndex, tagEndIndex, bodyOpen, bodyClose }, next: cursor };
	}

	/** Past any argument-taking specifiers at `index`. */
	private skipArguments(index: number, end: number): number {
		let cursor = index;
		for (let close = this.argumentsClose(cursor, end); close >= 0; close = this.argumentsClose(cursor, end))
			cursor = this.code(close + 1, end);
		return cursor;
	}

	protected declarators(head: DeclarationHead, end: number): DeclaratorName[] {
		if (head.listStart >= end) return [];
		const aggregate = head.aggregate;
		const bodied = aggregate !== undefined && aggregate.bodyClose >= 0;
		const tag =
			aggregate === undefined || aggregate.tagIndex < 0
				? undefined
				: spelledName(this.tokens, aggregate.tagIndex, aggregate.tagEndIndex);
		const typeName =
			aggregate === undefined
				? this.typeNameForRange(head.first, head.listStart)
				: tag === undefined
					? undefined
					: { name: tag, tag: true };
		const names: DeclaratorName[] = [];
		for (const segment of this.splitSegments(head.listStart, end)) {
			const nameIndex = this.findDeclaratorName(segment.start, segment.end, head.typedef);
			if (nameIndex < 0) continue;
			const qualified = qualifiedNameForIdentifier(this.tokens, nameIndex, segment.end);
			if (qualified === undefined) continue;
			const nameEndIndex = dottedEnd(this.tokens, qualified.endIndex);
			const name = `${qualified.name}${spelledName(this.tokens, qualified.endIndex + 1, nameEndIndex)}`;
			const open = this.code(nameEndIndex + 1, segment.end);
			const close = tokenValue(this.tokens, open) === "(" ? this.pairs.get(open) : undefined;
			const own = this.typeSpelling(segment.start, nameIndex, nameIndex);
			names.push({
				nameIndex,
				nameEndIndex,
				name,
				typeStart: head.first,
				// A body's members spell their own types.
				typeEnd: bodied ? Math.max(aggregate.keywordIndex, aggregate.tagEndIndex) : head.listStart,
				typeText: bodied
					? joinSpelling(`${aggregate.keyword}${tag === undefined ? "" : ` ${tag}`}`, own)
					: joinSpelling(this.typeSpelling(head.first, head.listStart, nameIndex), own),
				...defined({ typeName }),
				listStart: head.listStart,
				segmentStart: segment.start,
				segmentEnd: segment.end,
				...(close === undefined || close >= segment.end
					? {}
					: {
							function: {
								nameIndex: qualified.startIndex,
								nameEndIndex,
								name,
								open,
								close,
							},
						}),
			});
		}
		return names;
	}

	/** A function the declarators missed, spelled from `head` to its name. */
	protected candidateDeclarator(head: DeclarationHead, candidate: FunctionCandidate): DeclaratorName {
		return {
			nameIndex: candidate.nameIndex,
			nameEndIndex: candidate.nameEndIndex,
			name: candidate.name,
			typeStart: head.first,
			typeEnd: Math.max(head.first, candidate.nameIndex - 1),
			typeText: this.typeSpelling(head.first, candidate.nameIndex, candidate.nameIndex),
			...defined({ typeName: this.typeNameForRange(head.first, candidate.nameIndex) }),
			listStart: head.first,
			segmentStart: head.first,
			segmentEnd: this.code(candidate.close + 1),
			function: candidate,
		};
	}

	protected findDeclaratorName(start: number, end: number, allowKeywordName = false): number {
		const equals = this.topLevelIndex(start, end, ASSIGNMENT_OPERATORS);
		const limit = equals < 0 ? end : equals;
		for (let index = start; index < limit; index++) {
			if (this.directiveTokens.has(index) || this.attributeTokens.has(index)) continue;
			const argumentsClose = this.argumentsClose(index, limit);
			if (argumentsClose >= 0) {
				index = argumentsClose;
				continue;
			}
			const token = this.tokens[index] as CToken;
			if (
				!isIdentifierToken(token) ||
				(C_KEYWORDS.has(token.value) && !(allowKeywordName && ["bool", "_Bool"].includes(token.value))) ||
				CALLING_CONVENTIONS.has(token.value) ||
				TYPE_QUALIFIERS.has(token.value)
			)
				continue;
			const previous = this.codeBefore(index);
			if (previous >= start && [".", "->", "#"].includes(tokenValue(this.tokens, previous))) continue;
			const next = this.code(index + 1, limit);
			if (next < limit && this.declaratorFollows(next, limit)) continue;
			return index;
		}
		return -1;
	}

	/** A keyword type, storage class, qualifier or calling convention at `index`. */
	private plainSpecifierAt(index: number): boolean {
		const token = this.tokens[index];
		return (
			isIdentifierToken(token) &&
			isSpecifierWord(token.value) &&
			!ARGUMENT_SPECIFIERS.has(token.value) &&
			!TYPE_OPERATORS.has(token.value)
		);
	}

	/** Whether a declarator starts at `index`: its pointer, its grouping or its name. */
	private declaratorFollows(index: number, end: number): boolean {
		const token = this.tokens[index];
		if (tokenValue(this.tokens, index) === "*" || this.groupedDeclarator(index, end)) return true;
		return (
			isIdentifierToken(token) &&
			!typeWords(token.value) &&
			!ARGUMENT_SPECIFIERS.has(token.value) &&
			!ASM_LABELS.has(token.value)
		);
	}

	////////////////////////////////
	//  Spellings

	/** The first code token from `start`, past directives when code follows them. */
	private headerStart(start: number, end: number): number {
		const first = this.code(start, end);
		return first < end ? first : nextCode(this.tokens, start, end);
	}

	protected header(first: number, last: number, lead?: TokenSpan): string | undefined {
		if (first < 0 || last < first) return undefined;
		return tokenHeader(
			this.text,
			this.tokens,
			this.pairs,
			{
				first,
				last,
				...defined({ lead }),
				directives: this.directiveEndByToken,
			},
			this.meter,
		);
	}

	/** Specifiers from `first`, then this declarator alone. */
	protected declaratorHeader(first: number, declarator: DeclaratorName): string | undefined {
		const listFirst = this.headerStart(declarator.listStart, declarator.segmentEnd);
		const own = this.headerStart(declarator.segmentStart, declarator.segmentEnd);
		const last = this.codeBefore(declarator.segmentEnd);
		if (own <= listFirst) return this.header(first, last);
		const specifiers = this.codeBefore(listFirst);
		return this.header(own, last, specifiers < first ? undefined : { first, last: specifiers });
	}

	/** Type spelling of `[start, end)`. */
	private typeSpelling(start: number, end: number, name: number): string {
		const parts: string[] = [];
		let spaced = false;
		let previous: CToken | undefined;
		let kept: CToken | undefined;
		for (let index = start; index < end; index++) {
			const token = this.tokens[index] as CToken;
			if (token.kind === "comment" || token.kind === "newline" || this.directiveTokens.has(index)) continue;
			// Omitted words still separate.
			if (previous !== undefined && wordLike(previous) && wordLike(token)) spaced = true;
			const omitted = this.omittedThrough(index, end, name);
			if (omitted >= 0) {
				previous = this.tokens[omitted];
				index = omitted;
				continue;
			}
			if (kept !== undefined && (spaced || (wordLike(kept) && wordLike(token)))) parts.push(" ");
			parts.push(token.raw);
			spaced = false;
			previous = token;
			kept = token;
		}
		return parts.join("");
	}

	/** Last token of an unspelled run at `index`, or -1. */
	private omittedThrough(index: number, end: number, name: number): number {
		const token = this.tokens[index] as CToken;
		if (token.kind === "symbol") {
			// Declarator grouping.
			const close = token.value === "(" ? this.pairs.get(index) : undefined;
			return close !== undefined && close > name ? index : -1;
		}
		if (token.kind !== "identifier") return -1;
		if (ALIGNMENT_SPECIFIERS.has(token.value)) return this.argumentsClose(index, end);
		if (!UNSPELLED_WORDS.has(token.value)) return -1;
		if (token.value !== "extern") return index;
		const linkage = nextCode(this.tokens, index + 1, end);
		return this.tokens[linkage]?.kind === "string" ? linkage : index;
	}

	/** The type a declaration names: the last name among its specifiers, macros before it aside. */
	private typeNameForRange(start: number, end: number): TypeName | undefined {
		let previous = "";
		let named: TypeName | undefined;
		for (let index = start; index < end; index++) {
			if (this.directiveTokens.has(index) || this.attributeTokens.has(index) || this.macroTokens.has(index))
				continue;
			const token = this.tokens[index] as CToken;
			if (!isIdentifierToken(token) || TYPE_OPERATORS.has(token.value)) continue;
			// Attribute arguments name no type.
			const argumentsClose = this.argumentsClose(index, end);
			if (argumentsClose >= 0) {
				index = argumentsClose;
				continue;
			}
			const last = dottedEnd(this.tokens, index);
			const spelled = spelledName(this.tokens, index, last);
			if (TAG_WORDS.has(previous)) return { name: spelled, tag: true };
			previous = token.value;
			if (!typeWords(token.value) && !TAG_WORDS.has(token.value)) named = { name: spelled, tag: false };
			index = last;
		}
		return named;
	}

	/** Type names in `[start, end]`, past attributes, macro calls, and the operands `typeof` and `alignas` read. */
	protected markTypeRange(start: number, end: number): void {
		if (end < start) return;
		for (let index = start; index <= end; index++) {
			if (this.directiveTokens.has(index) || this.attributeTokens.has(index) || this.macroTokens.has(index))
				continue;
			const token = this.tokens[index];
			if (isIdentifierToken(token) && OPERAND_SPECIFIERS.has(token.value)) {
				const close = this.argumentsClose(index, end + 1);
				if (close >= 0) {
					// `_Atomic` holds a type; a `typeof` or `alignas` operand is read where it stands, in its scope.
					if (token.value === "_Atomic") this.markTypeRange(this.code(index + 1, close) + 1, close - 1);
					index = close;
					continue;
				}
			}
			if (!isTypeToken(token)) continue;
			this.typeUseIndices.add(index);
			index = dottedEnd(this.tokens, index);
		}
	}
}
