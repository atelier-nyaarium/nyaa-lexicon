// The declarations a parse records: each id minted, a definition in its prototype's place, and the names
// declared so far.

import { composeSymbolId, type Descriptor, defined } from "@nyaa-lexicon/protocol";
import {
	type Candidate,
	type CDeclaration,
	type CTypeAnswer,
	type DescriptorPath,
	LANGUAGE,
	type QualifiedName,
	type TypeName,
} from "./model.js";
import { scopeKey } from "./scopes.js";
import { CStructure } from "./structure.js";
import type { CToken } from "./tokens.js";
import { descriptorKey, rangeForTokens, tokenRange } from "./tokenWalk.js";
import { isIdentifierToken } from "./words.js";

////////////////////////////////
//  Classes

export class CDeclarationRecords extends CStructure {
	protected readonly declarationNameIndices = new Set<number>();

	protected readonly qualifiedNameIndices = new Set<number>();

	protected readonly declarations: CDeclaration[] = [];

	protected readonly typeAnswers = new Map<string, CTypeAnswer>();

	private readonly canonicalDeclarations = new Map<string, CDeclaration>();

	private readonly descriptorCounts = new Map<string, number>();

	private readonly positions = new Map<CDeclaration, number>();

	private readonly children = new Map<string, CDeclaration[]>();

	/** Declarations so far by `scopeKey`, for what a statement's first name means. */
	protected readonly scoped = new Map<string, CDeclaration[]>();

	/** A prototype's parameters, once its definition replaced it. */
	protected readonly replaced = new Set<CDeclaration>();

	////////////////////////////////
	//  Declaration records

	protected addCandidate(candidate: Candidate): CDeclaration | undefined {
		// A block's tag is its own: a forward declaration merges with a definition only in the same block.
		const canonicalKey = `${candidate.declarationKind}|${descriptorKey(candidate.parentPath)}|${candidate.name}|${candidate.scope?.open ?? ""}`;
		const existing = candidate.conditionalKey === "" ? this.canonicalDeclarations.get(canonicalKey) : undefined;
		if (
			existing !== undefined &&
			(candidate.declarationKind === "function" ||
				candidate.declarationKind === "struct" ||
				candidate.declarationKind === "enum")
		) {
			if (candidate.isDefinition === true && existing.isDefinition !== true)
				return this.replace(existing, candidate, canonicalKey);
			if (candidate.isDefinition !== true) return existing;
		}
		const countKey = `${descriptorKey(candidate.parentPath)}|${candidate.descriptorKind}|${candidate.name}`;
		const ordinal = this.descriptorCounts.get(countKey) ?? 0;
		this.descriptorCounts.set(countKey, ordinal + 1);
		const descriptorName =
			ordinal === 0 || candidate.descriptorKind === "method" ? candidate.name : `${candidate.name}#${ordinal}`;
		const descriptor: Descriptor =
			candidate.descriptorKind === "method" && ordinal > 0
				? { kind: "method", name: candidate.name, disambiguator: String(ordinal) }
				: { kind: candidate.descriptorKind, name: descriptorName };
		const declaration = this.makeDeclaration(candidate, [...candidate.parentPath, descriptor]);
		if (candidate.conditionalKey === "") this.canonicalDeclarations.set(canonicalKey, declaration);
		return declaration;
	}

	/** A definition in its prototype's place, the prototype's parameters dropped. */
	private replace(existing: CDeclaration, candidate: Candidate, canonicalKey: string): CDeclaration {
		for (const child of this.children.get(existing.symbolId) ?? []) {
			const descriptor = child.descriptorPath.at(-1);
			if (descriptor !== undefined)
				this.descriptorCounts.set(
					`${descriptorKey(existing.descriptorPath)}|${descriptor.kind}|${child.name}`,
					0,
				);
			this.replaced.add(child);
		}
		this.children.delete(existing.symbolId);
		const replacement = this.makeDeclaration(candidate, existing.descriptorPath, false);
		// One entity: in scope from its first declaration.
		if (existing.scope !== undefined && replacement.scope !== undefined)
			replacement.scope = { ...replacement.scope, from: Math.min(existing.scope.from, replacement.scope.from) };
		const position = this.positions.get(existing);
		if (position !== undefined) {
			this.declarations[position] = replacement;
			this.positions.set(replacement, position);
		}
		const siblings = existing.containerId === undefined ? undefined : this.children.get(existing.containerId);
		const sibling = siblings?.indexOf(existing) ?? -1;
		if (siblings !== undefined && sibling >= 0) siblings[sibling] = replacement;
		const scoped = this.scoped.get(scopeKey(existing.containerId, existing.name));
		const held = scoped?.indexOf(existing) ?? -1;
		if (scoped !== undefined && held >= 0) scoped[held] = replacement;
		this.canonicalDeclarations.set(canonicalKey, replacement);
		this.typeAnswers.delete(existing.symbolId);
		this.addTypeAnswer(replacement);
		return replacement;
	}

	protected markQualifiedName(start: number, end: number): void {
		for (let index = start; index <= end; index++) {
			if (isIdentifierToken(this.tokens[index])) this.declarationNameIndices.add(index);
		}
	}

	protected markQualifiedReference(name: QualifiedName): void {
		for (const index of name.identifierIndices) this.qualifiedNameIndices.add(index);
	}

	private makeDeclaration(candidate: Candidate, descriptorPath: DescriptorPath, append = true): CDeclaration {
		const first = this.tokens[candidate.rangeStartIndex] as CToken;
		const last = this.tokens[candidate.rangeEndIndex] as CToken;
		const selectionRange =
			rangeForTokens(
				this.tokens,
				candidate.selectionIndex,
				candidate.selectionEndIndex ?? candidate.selectionIndex,
			) ?? tokenRange(this.tokens[candidate.selectionIndex] as CToken);
		const symbolId = composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: descriptorPath });
		const containerId =
			descriptorPath.length <= 1
				? undefined
				: composeSymbolId({
						language: LANGUAGE,
						module: this.module,
						descriptors: descriptorPath.slice(0, -1),
					});
		const typeRange =
			candidate.typeStartIndex === undefined || candidate.typeEndIndex === undefined
				? undefined
				: rangeForTokens(this.tokens, candidate.typeStartIndex, candidate.typeEndIndex);
		const declaration: CDeclaration = {
			symbolId,
			kind: candidate.declarationKind,
			name: candidate.name,
			range: { start: first.start, end: last.end },
			selectionRange,
			visibility: candidate.visibility,
			...defined({
				languageKind: candidate.languageKind,
				exported: candidate.exported,
				signature: candidate.signature,
				containerId,
				metrics: candidate.metrics,
			}),
			descriptorPath,
			startOffset: first.startOffset,
			endOffset: last.endOffset,
			selectionIndex: candidate.selectionIndex,
			conditionalKey: candidate.conditionalKey,
			conditionalGroup: candidate.conditionalGroup,
			...defined({ isDefinition: candidate.isDefinition }),
			...(candidate.typeText === undefined || candidate.typeText === "" ? {} : { typeText: candidate.typeText }),
			...defined({ typeRange, scope: candidate.scope }),
		};
		if (append) {
			this.positions.set(declaration, this.declarations.length);
			this.declarations.push(declaration);
			const key = scopeKey(containerId, declaration.name);
			const scoped = this.scoped.get(key);
			if (scoped === undefined) this.scoped.set(key, [declaration]);
			else scoped.push(declaration);
			if (containerId !== undefined) {
				const siblings = this.children.get(containerId);
				if (siblings === undefined) this.children.set(containerId, [declaration]);
				else siblings.push(declaration);
			}
		}
		this.addTypeAnswer(declaration, candidate.typeName);
		return declaration;
	}

	private addTypeAnswer(declaration: CDeclaration, typeName?: TypeName): void {
		if (declaration.typeText === undefined || declaration.typeText === "") return;
		this.typeAnswers.set(declaration.symbolId, {
			display: declaration.typeText,
			...defined({ typeName }),
		});
	}
}
