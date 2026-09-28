// A C file's facts: the declaration parse, then literals and references.

import {
	comparePositions,
	defined,
	type Literal,
	type Range,
	type Reference,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import { CDeclarationParser } from "./declarations.js";
import type { CDeclaration, CReference, NumericValue, ParsedCFile, QualifiedName } from "./model.js";
import {
	declaredIn,
	innermost,
	lexicalScope,
	macrosFirst,
	namesObject,
	namesTypedef,
	oneType,
	scopeKey,
	typeCandidates,
	typeMacros,
	visibleAt,
} from "./scopes.js";
import { type CToken, type LexedC, lexC } from "./tokens.js";
import {
	containsPosition,
	dottedEnd,
	previousSignificant,
	qualifiedNameForIdentifier,
	significant,
	spelledName,
	tokenRange,
	tokenValue,
} from "./tokenWalk.js";
import { ASSIGNMENT_OPERATORS, C_KEYWORDS, MEMBER_OPERATORS, TAG_WORDS, TYPE_QUALIFIERS } from "./words.js";

////////////////////////////////
//  Constants

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

////////////////////////////////
//  Functions & Helpers

function exactInteger(value: string): NumericValue {
	try {
		const exact = BigInt(value);
		return exact > MAX_SAFE_INTEGER_BIGINT ? { valid: true } : { valid: true, number: Number(exact) };
	} catch {
		return { valid: false };
	}
}

function numberValue(raw: string): NumericValue {
	const clean = raw.replaceAll("_", "");
	const integerSuffix = /[uUlL]+$/u;
	const prefixed = /^0[xXbB]/u.test(clean);
	if (prefixed) {
		const integer = clean.replace(integerSuffix, "");
		if (/^0[xX][0-9A-Fa-f]+$/u.test(integer)) return exactInteger(integer);
		if (/^0[bB][01]+$/u.test(integer)) return exactInteger(integer);
	}

	const integer = clean.replace(integerSuffix, "");
	if (/^\d+$/u.test(integer)) {
		const octal = /^0[0-7]+$/u.test(integer) && integer.length > 1 ? `0o${integer.slice(1)}` : integer;
		return exactInteger(octal);
	}

	const floating = clean.replace(/[fFlL]+$/u, "");
	if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(floating)) return { valid: false };
	const parsed = Number(floating);
	return Number.isFinite(parsed) ? { valid: true, number: parsed } : { valid: false };
}

function parserFor(module: string, text: string, lexed: LexedC): CParser {
	return new CParser(module, text, lexed.tokens, lexed.comments, lexed.blankLines, lexed.diagnostics);
}

export function parseC(module: string, text: string): ParsedCFile {
	const lexed = lexC(module, text);
	const c = parserFor(module, text, lexed);
	if (!lexed.ghidraDiffers || c.paired()) return c.parse();
	// Use Ghidra only if the C parser cannot pair delimiters.
	const ghidra = parserFor(module, text, lexC(module, text, "ghidra"));
	return (ghidra.paired() ? ghidra : c).parse();
}

/** What the reference's name can mean where it is read, in this file. */
export function bindingCandidates(facts: ParsedCFile, reference: CReference): CDeclaration[] {
	const at = reference.tokenIndex;
	const from = reference.fromId === undefined ? undefined : facts.declarationsById.get(reference.fromId);
	const local =
		from === undefined
			? []
			: innermost(
					declaredIn(facts, reference.name, from.symbolId).filter((declaration) =>
						visibleAt(declaration, at),
					),
				);
	const file = declaredIn(facts, reference.name, undefined);
	if (reference.role === "typeUse") {
		const types = typeCandidates(facts, reference.name, reference.tag === true, { scopeId: reference.fromId, at });
		return types.length > 0 || reference.tag === true ? types : typeMacros(file);
	}
	if (reference.role === "call")
		return macrosFirst(
			[...local, ...file].filter((declaration) => ["function", "constant"].includes(declaration.kind)),
		);
	if (local.length > 0) return local;
	return macrosFirst(
		file.filter((declaration) =>
			["variable", "constant", "function", "class", "struct", "enum"].includes(declaration.kind),
		),
	);
}

export function rangeContains(range: Range, position: Range["start"]): boolean {
	return containsPosition(range, position);
}

export function typeInfoFor(facts: ParsedCFile, symbolId: string): TypeInfo {
	const answer = facts.typeAnswers.get(symbolId);
	if (answer === undefined)
		return {
			status: "unknown",
			reason: "NotImplemented",
			detail: "the declaration has no supported declared type",
		};
	// Read where the declaration is, so `typedef T T;` names the T around it.
	const declared = facts.declarationsById.get(symbolId);
	const place = { scopeId: declared?.containerId, ...defined({ at: declared?.selectionIndex }) };
	// Alternatives across conditional branches leave the spelling without one identity.
	const typeDeclaration =
		answer.typeName === undefined
			? undefined
			: oneType(typeCandidates(facts, answer.typeName.name, answer.typeName.tag, place));
	return {
		status: "known",
		display: answer.display,
		...(typeDeclaration === undefined ? {} : { symbolId: typeDeclaration.symbolId }),
		provenance: "declared",
	};
}

////////////////////////////////
//  Classes

class CParser extends CDeclarationParser {
	private readonly references: CReference[] = [];

	private readonly literals: Literal[] = [];

	private containerByToken: Array<CDeclaration | undefined> = [];

	private readonly index = {
		declarationsByName: new Map<string, CDeclaration[]>(),
		declarationsById: new Map<string, CDeclaration>(),
		declarationsByScope: new Map<string, CDeclaration[]>(),
	};

	parse(): ParsedCFile {
		this.buildStructure();
		this.buildConditionals();
		this.extractIncludesAndMacros();
		this.parseFile();
		this.buildContainerIndex();
		const { declarationsByName, declarationsById, declarationsByScope } = this.index;
		const childrenById = new Map<string, CDeclaration[]>();
		for (const declaration of this.declarations) declarationsById.set(declaration.symbolId, declaration);
		const scope = (scopeId: string | undefined, declaration: CDeclaration) => {
			const key = scopeKey(scopeId, declaration.name);
			const scoped = declarationsByScope.get(key);
			if (scoped === undefined) declarationsByScope.set(key, [declaration]);
			else scoped.push(declaration);
		};
		for (const declaration of this.declarations) {
			const named = declarationsByName.get(declaration.name);
			if (named === undefined) declarationsByName.set(declaration.name, [declaration]);
			else named.push(declaration);
			scope(declaration.containerId, declaration);
			const lexical = lexicalScope(this.index, declaration);
			if (lexical !== undefined) scope(lexical.scope, declaration);
			if (declaration.containerId === undefined) continue;
			const siblings = childrenById.get(declaration.containerId);
			if (siblings === undefined) childrenById.set(declaration.containerId, [declaration]);
			else siblings.push(declaration);
		}
		this.extractLiterals();
		this.extractReferences();
		const referencesByToken = new Map<number, CReference>();
		for (const reference of this.references) {
			if (!referencesByToken.has(reference.tokenIndex)) referencesByToken.set(reference.tokenIndex, reference);
		}
		this.diagnostics.sort((left, right) => {
			const a = left.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
			const b = right.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
			return comparePositions(a, b);
		});
		return {
			module: this.module,
			declarations: this.declarations,
			declarationsByName,
			declarationsById,
			declarationsByScope,
			childrenById,
			references: this.references,
			referencesByToken,
			imports: this.imports,
			literals: this.literals,
			comments: this.comments,
			blankLines: this.blankLines,
			diagnostics: this.diagnostics,
			typeAnswers: this.typeAnswers,
		};
	}

	private extractLiterals(): void {
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as CToken;
			if (this.directiveTokens.has(index) || this.includePathTokens.has(index)) continue;
			let literal: Literal | undefined;
			if (token.kind === "string") literal = { kind: "string", value: token.value, range: tokenRange(token) };
			else if (token.kind === "number") {
				const numeric = numberValue(token.value);
				if (numeric.valid) {
					literal = {
						kind: "number",
						value: token.value,
						range: tokenRange(token),
						...defined({ number: numeric.number }),
					};
				}
			} else if (token.kind === "char") {
				const codePoint = token.value.codePointAt(0);
				if (codePoint !== undefined)
					literal = { kind: "number", value: token.raw, number: codePoint, range: tokenRange(token) };
			} else if (token.kind === "identifier" && (token.value === "true" || token.value === "false")) {
				literal = { kind: "boolean", value: token.value, range: tokenRange(token) };
			}
			if (literal === undefined) continue;
			const container = this.containerByToken[index];
			this.literals.push(container === undefined ? literal : { ...literal, containerId: container.symbolId });
		}
	}

	private buildContainerIndex(): void {
		// A tag holds only its body: the declarators and initializers after it are its neighbors'.
		const containers = this.declarations
			.flatMap((declaration) => {
				if (declaration.kind === "function" || declaration.kind === "class")
					return [{ declaration, start: declaration.startOffset, end: declaration.endOffset }];
				const body = declaration.body;
				return body === undefined ? [] : [{ declaration, start: body.start, end: body.end }];
			})
			.sort((left, right) => left.start - right.start || right.end - left.end);
		// In start order, so the top, once ended ones are popped, is the latest-started one still open.
		const active: typeof containers = [];
		let next = 0;
		this.containerByToken = new Array(this.tokens.length);
		for (let index = 0; index < this.tokens.length; index++) {
			const offset = (this.tokens[index] as CToken).startOffset;
			while (next < containers.length && (containers[next] as (typeof containers)[number]).start <= offset) {
				active.push(containers[next] as (typeof containers)[number]);
				next++;
			}
			while (active.length > 0 && (active.at(-1) as (typeof containers)[number]).end < offset) active.pop();
			this.containerByToken[index] = active.at(-1)?.declaration;
		}
	}

	private extractReferences(): void {
		let dottedThrough = -1;
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as CToken;
			if (
				token.kind !== "identifier" ||
				index <= dottedThrough ||
				this.directiveTokens.has(index) ||
				this.attributeTokens.has(index) ||
				this.declarationNameIndices.has(index)
			)
				continue;
			if (this.qualifiedNameIndices.has(index)) continue;
			const qualified = qualifiedNameForIdentifier(this.tokens, index, this.tokens.length);
			if (
				qualified !== undefined &&
				(qualified.startIndex !== qualified.endIndex || tokenValue(this.tokens, qualified.startIndex) === "::")
			) {
				this.markQualifiedReference(qualified);
				this.addQualifiedReference(qualified);
				continue;
			}
			if (token.value === "true" || token.value === "false" || C_KEYWORDS.has(token.value)) continue;
			const previous = previousSignificant(this.tokens, index);
			const next = significant(this.tokens, index + 1);
			const previousValue = previous < 0 ? "" : tokenValue(this.tokens, previous);
			const nextValue = next < 0 ? "" : tokenValue(this.tokens, next);
			// A directive's trailing operator is not this name's.
			const member = MEMBER_OPERATORS.has(previousValue) && !this.directiveTokens.has(previous);
			const tag = TAG_WORDS.has(previousValue);
			if (tag || this.typeUseIndices.has(index) || this.parenthesizedType(index)) {
				dottedThrough = dottedEnd(this.tokens, index);
				const name = spelledName(this.tokens, index, dottedThrough);
				this.addReference(index, "typeUse", member, name, dottedThrough, tag);
				continue;
			}
			if (previousValue === "goto" || (nextValue === ":" && this.labels(index))) continue;
			if (nextValue === "++" || nextValue === "--" || previousValue === "++" || previousValue === "--") {
				this.addReference(index, "read", member);
				this.addReference(index, "write", member);
				continue;
			}
			if (ASSIGNMENT_OPERATORS.has(nextValue)) {
				if (nextValue !== "=") this.addReference(index, "read", member);
				this.addReference(index, "write", member);
				continue;
			}
			if (nextValue === "(") {
				this.addReference(index, "call", member);
				continue;
			}
			if (previousValue === "#") continue;
			this.addReference(index, "read", member);
		}
		for (const imported of this.imports) {
			if (imported.range === undefined) continue;
			const reference: CReference = {
				name: imported.specifier,
				range: imported.range,
				role: "import",
				binding: {
					status: "unbound",
					reason: "NotImplemented",
					detail: "include binding is resolved by the provider",
				},
				qualified: false,
				tokenIndex: -1,
			};
			this.references.push(reference);
		}
	}

	/** Whether `name` at `index` names a type: a typedef in scope, or a bare tag no object hides. */
	private isTypeName(name: string, index: number): boolean {
		const place = { scopeId: this.containerByToken[index]?.symbolId, at: index };
		if (namesTypedef(this.index, name, place)) return true;
		return !namesObject(this.index, name, place) && typeCandidates(this.index, name, true, place).length > 0;
	}

	/** Whether the name at `index` is a cast's or `sizeof`'s type: `(T)` for a known type, `(const T *)` for any. */
	private parenthesizedType(index: number): boolean {
		let before = previousSignificant(this.tokens, index);
		let qualified = false;
		for (; TYPE_QUALIFIERS.has(tokenValue(this.tokens, before)); before = previousSignificant(this.tokens, before))
			qualified = true;
		if (tokenValue(this.tokens, before) !== "(") return false;
		let after = significant(this.tokens, dottedEnd(this.tokens, index) + 1);
		for (; after >= 0; after = significant(this.tokens, after + 1)) {
			const value = tokenValue(this.tokens, after);
			if (value !== "*" && !TYPE_QUALIFIERS.has(value)) break;
			qualified = true;
		}
		if (after < 0 || tokenValue(this.tokens, after) !== ")") return false;
		return qualified || this.isTypeName((this.tokens[index] as CToken).value, index);
	}

	/** Whether the name at `index`, before a `:`, labels a statement. */
	private labels(index: number): boolean {
		const previous = this.codeBefore(index);
		return previous < 0 || [";", "{", "}", ":"].includes(tokenValue(this.tokens, previous));
	}

	private addQualifiedReference(name: QualifiedName): void {
		const previous = previousSignificant(this.tokens, name.startIndex);
		const next = significant(this.tokens, name.endIndex + 1);
		const previousValue = previous < 0 ? "" : tokenValue(this.tokens, previous);
		const nextValue = next < 0 ? "" : tokenValue(this.tokens, next);
		if (name.identifierIndices.some((index) => this.typeUseIndices.has(index))) {
			this.addReference(name.startIndex, "typeUse", true, name.name, name.endIndex);
			return;
		}
		if (previousValue === "goto" || (nextValue === ":" && this.labels(name.startIndex))) return;
		if (nextValue === "++" || nextValue === "--" || previousValue === "++" || previousValue === "--") {
			this.addReference(name.startIndex, "read", true, name.name, name.endIndex);
			this.addReference(name.startIndex, "write", true, name.name, name.endIndex);
			return;
		}
		if (ASSIGNMENT_OPERATORS.has(nextValue)) {
			if (nextValue !== "=") this.addReference(name.startIndex, "read", true, name.name, name.endIndex);
			this.addReference(name.startIndex, "write", true, name.name, name.endIndex);
			return;
		}
		if (nextValue === "(") {
			this.addReference(name.startIndex, "call", true, name.name, name.endIndex);
			return;
		}
		if (previousValue === "#") return;
		this.addReference(name.startIndex, "read", true, name.name, name.endIndex);
	}

	private addReference(
		index: number,
		role: Reference["role"],
		qualified: boolean,
		name = tokenValue(this.tokens, index),
		end = index,
		tag = false,
	): void {
		const token = this.tokens[index] as CToken;
		const last = this.tokens[end] as CToken;
		const container = this.containerByToken[index];
		this.references.push({
			name,
			range: { start: token.start, end: last.end },
			role,
			binding: { status: "unbound", reason: "NotImplemented", detail: "C binding is resolved by the provider" },
			...(container === undefined ? {} : { fromId: container.symbolId }),
			qualified,
			tokenIndex: index,
			...(tag ? { tag } : {}),
			...this.memberOf(index),
		});
	}

	/** A name after `.` or `->`, and the name its receiver's type comes from when there is one. */
	private memberOf(index: number): Pick<CReference, "member" | "receiver"> {
		const operator = previousSignificant(this.tokens, index);
		if (!MEMBER_OPERATORS.has(tokenValue(this.tokens, operator)) || this.directiveTokens.has(operator)) return {};
		const receiver = this.receiverName(previousSignificant(this.tokens, operator));
		return receiver === undefined ? { member: true } : { member: true, receiver };
	}

	/** The name ending a receiver: `a`, `a[i]`, `(*a)` or `(a->b)`; none for a call, cast or operation. */
	private receiverName(end: number): number | undefined {
		let previous = Number.POSITIVE_INFINITY;
		for (let at = end; at >= 0; ) {
			if (at >= previous) throw new Error("C receiver scan failed to advance");
			previous = at;
			const token = this.tokens[at] as CToken;
			if (token.kind === "identifier") return C_KEYWORDS.has(token.value) ? undefined : at;
			const open = this.pairs.get(at);
			if (open === undefined || open >= at) return undefined;
			const before = previousSignificant(this.tokens, open);
			if (token.value === "]") {
				at = before;
				continue;
			}
			if (token.value !== ")" || this.callsOrCasts(before)) return undefined;
			const last = previousSignificant(this.tokens, at);
			if (!this.isPostfixChain(open + 1, last)) return undefined;
			at = last;
		}
		return undefined;
	}

	/** Whether `(` after `index` is a call's or follows a cast, not a grouping. */
	private callsOrCasts(index: number): boolean {
		const token = this.tokens[index];
		if (token === undefined) return false;
		if (token.kind === "identifier") return !C_KEYWORDS.has(token.value);
		return token.value === ")" || token.value === "]";
	}

	/** Whether `start..last` is `*`s, then a name its `.x`, `->x` and `[i]` follow. */
	private isPostfixChain(start: number, last: number): boolean {
		let at = significant(this.tokens, start);
		while (at >= 0 && at < last && tokenValue(this.tokens, at) === "*") at = significant(this.tokens, at + 1);
		const first = this.tokens[at];
		if (first?.kind !== "identifier" || C_KEYWORDS.has(first.value)) return false;
		let guard = -1;
		while (at >= 0 && at < last) {
			if (at <= guard) throw new Error("C receiver chain scan failed to advance");
			guard = at;
			const next = significant(this.tokens, at + 1);
			const value = tokenValue(this.tokens, next);
			if (value === "[") at = this.pairs.get(next) ?? -1;
			else if (
				MEMBER_OPERATORS.has(value) &&
				this.tokens[significant(this.tokens, next + 1)]?.kind === "identifier"
			)
				at = significant(this.tokens, next + 1);
			else return false;
		}
		return at === last;
	}
}
