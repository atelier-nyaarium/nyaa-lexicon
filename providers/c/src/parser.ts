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
import { type CToken, type LexedC, lexC, previousSignificant, significant, tokenRange } from "./tokens.js";
import { containsPosition, qualifiedNameForIdentifier, tokenValue } from "./tokenWalk.js";
import { ASSIGNMENT_OPERATORS, C_KEYWORDS, MEMBER_OPERATORS } from "./words.js";

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

export function bindingCandidates(facts: ParsedCFile, reference: CReference): CDeclaration[] {
	const sameName = facts.declarationsByName.get(reference.name) ?? [];
	const from = reference.fromId === undefined ? undefined : facts.declarationsById.get(reference.fromId);
	const local = from === undefined ? [] : sameName.filter((declaration) => declaration.containerId === from.symbolId);
	const file = sameName.filter((declaration) => declaration.containerId === undefined);
	const member =
		from?.kind === "struct" || from?.kind === "enum"
			? sameName.filter((declaration) => declaration.containerId === from.symbolId)
			: [];
	if (reference.role === "typeUse")
		return sameName.filter(
			(declaration) =>
				["class", "struct", "enum"].includes(declaration.kind) && declaration.containerId === undefined,
		);
	if (reference.role === "call")
		return [...local, ...file].filter((declaration) => ["function", "constant"].includes(declaration.kind));
	if (member.length > 0) return member;
	if (local.length > 0) return local;
	return file.filter((declaration) =>
		["variable", "constant", "function", "class", "struct", "enum"].includes(declaration.kind),
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
	const typeDeclaration =
		answer.typeName === undefined
			? undefined
			: (facts.declarationsByName.get(answer.typeName) ?? []).find(
					(declaration) =>
						declaration.containerId === undefined && ["class", "struct", "enum"].includes(declaration.kind),
				);
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

	parse(): ParsedCFile {
		this.buildStructure();
		this.buildConditionals();
		this.extractIncludesAndMacros();
		this.parseScope(0, this.tokens.length, { kind: "file", parentPath: [] });
		this.buildContainerIndex();
		this.extractLiterals();
		this.extractReferences();
		const declarationsByName = new Map<string, CDeclaration[]>();
		const declarationsById = new Map<string, CDeclaration>();
		for (const declaration of this.declarations) {
			declarationsById.set(declaration.symbolId, declaration);
			const named = declarationsByName.get(declaration.name);
			if (named === undefined) declarationsByName.set(declaration.name, [declaration]);
			else named.push(declaration);
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
			references: this.references,
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
		const containers = this.declarations
			.filter((declaration) => ["function", "struct", "enum", "class"].includes(declaration.kind))
			.sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset);
		const active: CDeclaration[] = [];
		let next = 0;
		this.containerByToken = new Array(this.tokens.length);
		for (let index = 0; index < this.tokens.length; index++) {
			const offset = (this.tokens[index] as CToken).startOffset;
			while (next < containers.length && (containers[next] as CDeclaration).startOffset <= offset) {
				active.push(containers[next] as CDeclaration);
				next++;
			}
			for (let activeIndex = active.length - 1; activeIndex >= 0; activeIndex--) {
				if ((active[activeIndex] as CDeclaration).endOffset < offset) active.splice(activeIndex, 1);
			}
			this.containerByToken[index] = active.at(-1);
		}
	}

	private extractReferences(): void {
		for (const declaration of this.declarations) {
			if (declaration.containerId === undefined && ["class", "struct", "enum"].includes(declaration.kind))
				this.typeNames.add(declaration.name);
		}
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as CToken;
			if (
				token.kind !== "identifier" ||
				this.directiveTokens.has(index) ||
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
			if (
				this.typeUseIndices.has(index) ||
				(previousValue === "(" && this.isTypeName(token.value) && nextValue === ")")
			) {
				this.addReference(index, "typeUse", member);
				continue;
			}
			if (nextValue === ":" && previousValue !== "?") continue;
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

	private isTypeName(name: string): boolean {
		return this.typeNames.has(name);
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
		if (nextValue === ":" && previousValue !== "?") return;
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
		});
	}
}
