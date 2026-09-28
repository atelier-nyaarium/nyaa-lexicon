// A C++ file's facts: the declaration parse, then identities, lookup indexes, references, literals
// and comments.

import {
	type CommentSpan,
	composeSymbolId,
	type Declaration,
	defined,
	type FileRole,
	type Literal,
	type Reference,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import { bracketDelta } from "./angles.js";
import { CppBodyParser } from "./bodies.js";
import { listAt } from "./collections.js";
import { assignDisambiguators, assignOccurrences, isHidden, mergeRedeclarations } from "./identity.js";
import {
	type CppDeclarationRecord,
	type CppFacts,
	type CppReferenceRecord,
	type CppUsing,
	type DraftRecord,
	LANGUAGE,
	type Receiver,
} from "./model.js";
import { indexScopes, scopeIdOf } from "./scopes.js";
import type { Token } from "./tokens.js";
import { directiveTokenIndexes, isSignificant, rangeOfToken, tokenize } from "./tokens.js";
import { codeText, joinTokens, rangeFrom, significantAfter, significantBefore, tokenAt } from "./tokenWalk.js";
import { decodeNumberLiteral, namePath } from "./typeText.js";
import { ASSIGNMENT_OPERATORS, KEYWORDS, TYPE_WORDS } from "./words.js";

////////////////////////////////
//  Interfaces & Types

/** How a name is reached: after `::` in a scope, at file scope, or through a `.` or `->` receiver. */
interface Access {
	qualifierToken?: number;
	global: boolean;
	receiver?: Receiver;
}

/** A template list's closing token, and whether that `>>` closes an outer list too. */
interface ListClose {
	close: number;
	split: boolean;
}

////////////////////////////////
//  Constants

/** The most tokens a template-id is spelled out for, to tell an explicit specialization apart. */
const MAX_WRITTEN = 128;

////////////////////////////////
//  Functions & Helpers

function fileRoleFor(module: string, records: CppDeclarationRecord[]): FileRole {
	const main = records.find(
		(record) =>
			record.parent === null &&
			record.declaration.kind === "function" &&
			record.own.kind === "method" &&
			record.own.name === "main" &&
			record.hasBody &&
			record.declaration.symbolId === composeSymbolId({ language: LANGUAGE, module, descriptors: [record.own] }),
	);
	return main === undefined
		? { kind: "library" }
		: { kind: "entry", how: "main", symbolId: main.declaration.symbolId };
}

/**
 * Each token's innermost record: the longest id among the records spanning it, the earliest on a
 * tie. One range update per record on a segment tree, then one pass down it.
 */
function ownersByToken(records: CppDeclarationRecord[], tokenCount: number): Array<CppDeclarationRecord | null> {
	let size = 1;
	while (size < tokenCount) size *= 2;
	const best = new Float64Array(2 * size).fill(-1);
	const count = records.length;
	// Longer ids rank higher; among equals, the earlier record.
	records.forEach((record, order) => {
		const rank = record.declaration.symbolId.length * count + (count - 1 - order);
		let low = Math.max(0, record.tokenStart) + size;
		let high = Math.min(tokenCount, record.tokenEnd) + size;
		while (low < high) {
			if (low % 2 === 1) {
				best[low] = Math.max(best[low] as number, rank);
				low++;
			}
			if (high % 2 === 1) {
				high--;
				best[high] = Math.max(best[high] as number, rank);
			}
			low = Math.floor(low / 2);
			high = Math.floor(high / 2);
		}
	});
	for (let node = 2; node < 2 * size; node++)
		best[node] = Math.max(best[node] as number, best[Math.floor(node / 2)] as number);
	const owners: Array<CppDeclarationRecord | null> = [];
	for (let index = 0; index < tokenCount; index++) {
		const rank = best[size + index] as number;
		owners.push(rank < 0 ? null : (records[count - 1 - (rank % count)] ?? null));
	}
	return owners;
}

/**
 * A file's facts. What the first read declares settles a `<` its tokens leave open, as after a
 * variable or a template; when that moves any template bracket, the file is read again with them.
 */
export function parseCppFile(module: string, text: string): CppFacts {
	const source = tokenize(text, module);
	const first = new CppParser(module, text, source.tokens, source.blankLines, source.diagnostics);
	first.parse();
	const names = first.declaredNames();
	if (!first.anglesDifferWith(names)) return first.finish();
	const second = new CppParser(module, text, source.tokens, source.blankLines, source.diagnostics, names);
	second.parse();
	return second.finish();
}

////////////////////////////////
//  Classes

class CppParser extends CppBodyParser {
	finish(): CppFacts {
		assignDisambiguators(this.drafts);
		// A forward declaration's name, like a prototype's, uses what it declares; a namespace's later
		// opening only continues it.
		const alternativeOf = (draft: DraftRecord) => tokenAt(this.tokens, draft.nameStartIndex)?.alternative;
		for (const [merged, into] of mergeRedeclarations(this.drafts, alternativeOf)) {
			if (merged.kind === "namespace") continue;
			this.roleByToken.set(merged.nameStartIndex, "read");
			this.prototypes.set(merged.nameStartIndex, into);
		}
		assignOccurrences(this.drafts);
		const recordMap = new Map<DraftRecord, CppDeclarationRecord>();
		// A parent first, even one declared later: a definition taking a forward declaration's head.
		const materialize = (draft: DraftRecord): CppDeclarationRecord => {
			const known = recordMap.get(draft);
			if (known !== undefined) return known;
			const record = this.materializeRecord(draft, draft.parent === null ? null : materialize(draft.parent));
			recordMap.set(draft, record);
			return record;
		};
		const records = this.drafts.map(materialize);
		const reported = records.filter((record) => !record.merged);
		const usingsByScope = new Map<string, CppUsing[]>();
		for (const { scope, ...using } of this.usings) {
			const scopeId = scope === null ? "" : scopeIdOf(recordMap.get(scope) ?? null);
			listAt(usingsByScope, scopeId).push({ scopeId, ...using });
		}
		// A merged namespace opening still holds its members; any other merged record holds nothing.
		const holders = records.filter((record) => !record.merged || record.declaration.kind === "namespace");
		const owners = ownersByToken(holders, this.tokens.length);
		const references = this.extractReferences(owners, recordMap);
		const literals = this.extractLiterals(owners);
		const comments = this.extractComments();
		const typeAnswers = new Map<string, TypeInfo>();
		for (const [draft, record] of recordMap) {
			if (draft.type === undefined || record.merged) continue;
			const answer = draft.type;
			typeAnswers.set(
				record.declaration.symbolId,
				answer.status === "known" ? { ...answer, provenance: "declared" } : answer,
			);
		}
		return {
			declarations: reported.map((record) => record.declaration),
			references,
			imports: this.imports.map((item) => item.imported),
			literals,
			comments,
			blankLines: this.blankLines,
			diagnostics: this.sortedDiagnostics(),
			role: fileRoleFor(this.module, reported),
			...indexScopes(records),
			usingsByScope,
			referencesByToken: new Map(references.map((reference) => [reference.tokenIndex, reference])),
			declarationsByToken: new Map(reported.map((record) => [record.nameTokenStart, record])),
			importFacts: this.imports,
			typeAnswers,
		};
	}

	private materializeRecord(draft: DraftRecord, parentRecord: CppDeclarationRecord | null): CppDeclarationRecord {
		const path = [...namePath(draft)];
		const symbolId = composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: path });
		const whole =
			rangeFrom(this.tokens, draft.startIndex, draft.endIndex) ??
			rangeOfToken(this.tokens[draft.startIndex] as Token);
		const last = this.tokens[draft.endIndex - 1];
		const range =
			draft.splitEnd === true && last !== undefined
				? { start: whole.start, end: { line: last.start.line, character: last.start.character + 1 } }
				: whole;
		const selection = rangeFrom(this.tokens, draft.nameStartIndex, draft.nameEndIndex) ?? range;
		const declaration: Declaration = {
			symbolId,
			kind: draft.kind,
			name: draft.name,
			range,
			selectionRange: selection,
			visibility: draft.visibility,
			...defined({ languageKind: draft.languageKind }),
			...(draft.exported ? { exported: true } : {}),
			...defined({ signature: draft.signature }),
			// A written qualifier the file does not declare is identity only; the container is what the file declares.
			...(draft.parent === null
				? {}
				: {
						containerId: composeSymbolId({
							language: LANGUAGE,
							module: this.module,
							descriptors: namePath(draft.parent),
						}),
					}),
			...defined({ memberInsertLine: draft.memberInsertLine, metrics: draft.metrics }),
		};
		return {
			declaration,
			module: this.module,
			parent: parentRecord,
			own: draft.own,
			names: path.map((descriptor) => descriptor.name),
			tokenStart: draft.startIndex,
			tokenEnd: draft.endIndex,
			nameTokenStart: draft.nameStartIndex,
			templateDependent: draft.templateDependent,
			hasBody: draft.hasBody,
			declaredAt: draft.declaredAt ?? draft.nameStartIndex,
			merged: isHidden(draft),
			...defined({
				visibleEnd: draft.visibleEnd,
				visibleFrom: draft.visibleFrom,
				alternative: tokenAt(this.tokens, draft.nameStartIndex)?.alternative,
				bodyStart: draft.bodyStart,
				baseTokens: draft.baseTokens,
				typeRef: draft.typeRef,
				typeShape: draft.typeShape,
				aliasOf: draft.aliasOf,
			}),
		};
	}

	private extractReferences(
		owners: Array<CppDeclarationRecord | null>,
		recordMap: ReadonlyMap<DraftRecord, CppDeclarationRecord>,
	): CppReferenceRecord[] {
		const references: CppReferenceRecord[] = [];
		const accessed = this.accessedNames();
		const closes = this.listCloses();
		for (let index = 0; index < this.tokens.length; index++) {
			const token = tokenAt(this.tokens, index);
			if (
				token?.kind !== "identifier" ||
				(this.excludedTokenIndexes.has(index) && !this.roleByToken.has(index)) ||
				this.templateTokenIndexes.has(index)
			)
				continue;
			if (KEYWORDS.has(token.value) || TYPE_WORDS.has(token.value)) continue;
			// A directive's own word, `define` in `#define`, names nothing.
			if (tokenAt(this.tokens, significantBefore(this.tokens, index))?.text === "#") continue;
			const range = rangeOfToken(token);
			const from = owners[index] ?? null;
			const follower = this.followerOf(index, closes);
			const role = this.roleByToken.get(index) ?? this.referenceRole(index, follower);
			const prototype = this.prototypes.get(index);
			const reached = accessed.has(index);
			const list = closes.get(significantAfter(this.tokens, index));
			references.push({
				name: token.value,
				range,
				role,
				tokenIndex: index,
				from,
				scope: follower === "::",
				...(reached ? this.accessOf(index) : { global: false }),
				...defined({
					prototypeOf: prototype === undefined ? undefined : recordMap.get(prototype),
					alternative: token.alternative,
					// A `>>` closing an outer list too gives this one its first half. A list longer than
					// any specialization's name is left out, so nested lists are not spelled again each.
					written:
						list === undefined || list.close - index > MAX_WRITTEN
							? undefined
							: list.split
								? `${joinTokens(this.tokens, index, list.close)}>`
								: joinTokens(this.tokens, index, list.close + 1),
				}),
				// Using-declarations bind names.
				qualified: reached && role !== "import",
				templated: bracketDelta(tokenAt(this.tokens, significantAfter(this.tokens, index)), this.angles) > 0,
				inTemplate: from?.templateDependent ?? false,
				macro: this.directiveTokens.has(index),
			});
		}
		return references;
	}

	/** What the name at `index`, after `::`, `.` or `->`, is reached through. */
	private accessOf(index: number): Access {
		let accessor = significantBefore(this.tokens, index);
		if (tokenAt(this.tokens, accessor)?.text === "template") accessor = significantBefore(this.tokens, accessor);
		const value = tokenAt(this.tokens, accessor)?.text;
		const before = significantBefore(this.tokens, accessor);
		const token = tokenAt(this.tokens, before);
		if (value === "::") {
			const qualifier = this.nameEndingAt(before);
			if (qualifier >= 0) return { qualifierToken: qualifier, global: false };
			// `decltype(x)::y` and `f()::y` name a scope no token does.
			const closing = token?.text === ")" || token?.text === "]";
			return { global: !closing && (token?.kind !== "identifier" || KEYWORDS.has(token.value)) };
		}
		if (token?.text === "this")
			return { global: false, receiver: { kind: "this", token: -1, arrow: value === "->" } };
		const arrow = value === "->";
		const name = this.nameEndingAt(before);
		if (name >= 0) return { global: false, receiver: { kind: "name", token: name, arrow } };
		if (token?.text === ")" || token?.text === "]") {
			const [open, close] = token.text === ")" ? ["(", ")"] : ["[", "]"];
			const callee = this.nameEndingAt(significantBefore(this.tokens, this.openingBefore(before, open, close)));
			if (callee >= 0)
				return { global: false, receiver: { kind: open === "(" ? "call" : "subscript", token: callee, arrow } };
		}
		return { global: false };
	}

	/** The name a qualifier, callee or receiver ends on at `index`, its template arguments passed back over; -1 otherwise. */
	private nameEndingAt(index: number): number {
		const token = tokenAt(this.tokens, index);
		if (token?.kind === "identifier") return KEYWORDS.has(token.value) ? -1 : index;
		if (bracketDelta(token, this.angles) >= 0) return -1;
		const name = significantBefore(this.tokens, this.angleOpenBefore(index, 0));
		const named = tokenAt(this.tokens, name);
		return named?.kind === "identifier" && !KEYWORDS.has(named.value) ? name : -1;
	}

	/** The `open` matching the `close` at `index`, scanning back; -1 when unmatched. */
	private openingBefore(index: number, open: string, close: string): number {
		let depth = 0;
		for (let current = index; current >= 0; current--) {
			const value = codeText(this.tokens, current);
			if (value === close) depth++;
			else if (value === open && --depth === 0) return current;
		}
		return -1;
	}

	/** Operands of `.`, `->` and `::`, outside directives. */
	private accessedNames(): Set<number> {
		const directives = directiveTokenIndexes(this.tokens);
		const names = new Set<number>();
		let previous: Token | undefined;
		let pending = false;
		for (let index = 0; index < this.tokens.length; index++) {
			const token = tokenAt(this.tokens, index);
			if (token === undefined || !isSignificant(token) || directives.has(index)) continue;
			if (pending && token.kind === "identifier") {
				pending = token.value === "template";
				if (!pending) names.add(index);
			} else {
				pending = token.kind === "punctuation" && this.isAccessor(index, previous);
			}
			previous = token;
		}
		return names;
	}

	private isAccessor(index: number, before: Token | undefined): boolean {
		const value = tokenAt(this.tokens, index)?.text;
		if (value === "." || value === "::") return true;
		if (value !== "->" || this.trailingReturnArrows.has(index)) return false;
		// `f()->x` and `items[0]->x` reach through what a call or a subscript returns.
		if (before?.text === ")" || before?.text === "]") return true;
		if (before?.kind !== "identifier") return false;
		if (before.value === "this") return true;
		// Could precede trailing returns.
		return !KEYWORDS.has(before.value) && !TYPE_WORDS.has(before.value);
	}

	/** Read from tokens, so a marker inside a string is never one. */
	private extractComments(): CommentSpan[] {
		const comments: CommentSpan[] = [];
		for (const token of this.tokens) {
			if (token.kind !== "comment") continue;
			comments.push({
				range: rangeOfToken(token),
				text: token.text,
				codeBefore: token.codeBefore ?? false,
				codeAfter: token.codeAfter ?? false,
			});
		}
		return comments;
	}

	private extractLiterals(owners: Array<CppDeclarationRecord | null>): Literal[] {
		const literals: Literal[] = [];
		for (let index = 0; index < this.tokens.length; index++) {
			const token = tokenAt(this.tokens, index);
			if (token === undefined || this.templateTokenIndexes.has(index)) continue;
			const containerId = owners[index]?.declaration.symbolId;
			if (token.kind === "string") {
				literals.push({
					kind: "string",
					value: token.value,
					range: rangeOfToken(token),
					...defined({ containerId }),
				});
				continue;
			}
			if (token.kind === "number") {
				const number = decodeNumberLiteral(token.text);
				literals.push({
					kind: "number",
					value: token.text,
					...(Number.isFinite(number) ? { number } : {}),
					range: rangeOfToken(token),
					...defined({ containerId }),
				});
				continue;
			}
			if (token.kind === "identifier" && (token.value === "true" || token.value === "false")) {
				literals.push({
					kind: "boolean",
					value: token.value,
					range: rangeOfToken(token),
					...defined({ containerId }),
				});
			}
		}
		return literals;
	}

	/** `follower` is what stands after the name and any template arguments it takes. */
	private referenceRole(index: number, follower: string | undefined): Reference["role"] {
		const previous = significantBefore(this.tokens, index);
		const next = significantAfter(this.tokens, index);
		const previousValue = tokenAt(this.tokens, previous)?.text;
		const nextValue = tokenAt(this.tokens, next)?.text;
		if (this.typeTokenIndexes.has(index)) return "typeUse";
		if (previousValue === "new") return "instantiate";
		if (follower === "(") return "call";
		// A template-id that neither calls nor qualifies names a type.
		if (bracketDelta(tokenAt(this.tokens, next), this.angles) > 0 && follower !== "::") return "typeUse";
		if (ASSIGNMENT_OPERATORS.has(nextValue ?? "") || nextValue === "++" || nextValue === "--") return "write";
		if (previousValue === "++" || previousValue === "--") return "write";
		return "read";
	}

	/** The token text after the name at `index` and its template arguments. */
	private followerOf(index: number, closes: ReadonlyMap<number, ListClose>): string | undefined {
		const next = significantAfter(this.tokens, index);
		if (bracketDelta(tokenAt(this.tokens, next), this.angles) <= 0) return tokenAt(this.tokens, next)?.text;
		const list = closes.get(next);
		if (list === undefined) return undefined;
		// A `>>` that also closes an outer list leaves this one followed by that list's `>`.
		return list.split ? ">" : tokenAt(this.tokens, significantAfter(this.tokens, list.close))?.text;
	}

	/** Each template list's opening `<` to its close, in one pass. */
	private listCloses(): Map<number, ListClose> {
		const closes = new Map<number, ListClose>();
		const open: number[] = [];
		for (let index = 0; index < this.tokens.length; index++) {
			const delta = bracketDelta(tokenAt(this.tokens, index), this.angles);
			if (delta > 0) open.push(index);
			for (let closed = 0; closed < -delta; closed++) {
				const opening = open.pop();
				if (opening !== undefined) closes.set(opening, { close: index, split: closed + 1 < -delta });
			}
		}
		return closes;
	}
}
