// A C++ file's facts: the declaration parse, then disambiguators, references, literals and comments.

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
import { CppDeclarationParser } from "./declarations.js";
import {
	type CppDeclarationRecord,
	type CppFacts,
	type CppReferenceRecord,
	type DraftRecord,
	LANGUAGE,
} from "./model.js";
import type { Token } from "./tokens.js";
import { directiveTokenIndexes, isSignificant, rangeOfToken, tokenize } from "./tokens.js";
import { rangeFrom, significantAfter, significantBefore, tokenAt } from "./tokenWalk.js";
import { decodeNumberLiteral, namePath } from "./typeText.js";
import { ASSIGNMENT_OPERATORS, isShoutCase, KEYWORDS, TYPE_WORDS } from "./words.js";

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

export function parseCppFile(module: string, text: string): CppFacts {
	const source = tokenize(text, module);
	const parser = new CppParser(module, text, source.tokens, source.blankLines, source.diagnostics);
	parser.parse();
	return parser.finish();
}

////////////////////////////////
//  Classes

class CppParser extends CppDeclarationParser {
	finish(): CppFacts {
		this.assignDisambiguators();
		const recordMap = new Map<DraftRecord, CppDeclarationRecord>();
		for (const draft of this.drafts) {
			const record = this.materializeRecord(draft, recordMap);
			recordMap.set(draft, record);
		}
		const references = this.extractReferences(recordMap);
		const literals = this.extractLiterals(recordMap);
		const comments = this.extractComments();
		const typeAnswers = new Map<string, TypeInfo>();
		for (const [draft, record] of recordMap) {
			if (draft?.type === undefined) continue;
			const answer = draft.type;
			typeAnswers.set(
				record.declaration.symbolId,
				answer.status === "known" ? { ...answer, provenance: "declared" } : answer,
			);
		}
		return {
			declarations: [...recordMap.values()].map((record) => record.declaration),
			references,
			imports: this.imports.map((item) => item.imported),
			literals,
			comments,
			blankLines: this.blankLines,
			diagnostics: this.sortedDiagnostics(),
			role: fileRoleFor(this.module, [...recordMap.values()]),
			records: [...recordMap.values()],
			importFacts: this.imports,
			typeAnswers,
		};
	}

	private assignDisambiguators(): void {
		const groups = new Map<string, DraftRecord[]>();
		for (const draft of this.drafts) {
			if (draft.own.kind !== "method") continue;
			const key = namePath(draft)
				.map((descriptor) => `${descriptor.kind}:${descriptor.name}`)
				.join("/");
			const group = groups.get(key) ?? [];
			group.push(draft);
			groups.set(key, group);
		}
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			// Numbered where each is reported, so a merged definition counts at its body, not its prototype.
			group.sort((left, right) => left.startIndex - right.startIndex);
			for (let index = 1; index < group.length; index++) {
				const draft = group[index];
				if (draft !== undefined) draft.own.disambiguator = String(index);
			}
		}
	}

	private materializeRecord(
		draft: DraftRecord,
		recordMap: Map<DraftRecord, CppDeclarationRecord>,
	): CppDeclarationRecord {
		const parentRecord = draft.parent === null ? null : (recordMap.get(draft.parent) ?? null);
		if (draft.parent !== null && parentRecord === null) throw new Error("declaration parent is missing");
		const path = [...namePath(draft)];
		const symbolId = composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: path });
		const range =
			rangeFrom(this.tokens, draft.startIndex, draft.endIndex) ??
			rangeOfToken(this.tokens[draft.startIndex] as Token);
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
			parent: parentRecord,
			own: draft.own,
			tokenStart: draft.startIndex,
			tokenEnd: draft.endIndex,
			nameTokenStart: draft.nameStartIndex,
			nameTokenEnd: draft.nameEndIndex,
			templateDependent: draft.templateDependent,
			parameterNames: draft.parameterNames,
			hasBody: draft.hasBody,
		};
	}

	private extractReferences(recordMap: Map<DraftRecord, CppDeclarationRecord>): CppReferenceRecord[] {
		const references: CppReferenceRecord[] = [];
		const accessed = this.accessedNames();
		for (let index = 0; index < this.tokens.length; index++) {
			const token = tokenAt(this.tokens, index);
			if (
				token?.kind !== "identifier" ||
				(this.excludedTokenIndexes.has(index) && !this.roleByToken.has(index)) ||
				this.templateTokenIndexes.has(index)
			)
				continue;
			if (KEYWORDS.has(token.value) || TYPE_WORDS.has(token.value)) continue;
			const range = rangeOfToken(token);
			const from = this.containingRecord(index, recordMap);
			const role = this.roleByToken.get(index) ?? this.referenceRole(index);
			references.push({
				name: token.value,
				range,
				role,
				tokenIndex: index,
				from,
				qualifiedPath: this.qualifiedPath(index),
				// Using-declarations bind names.
				qualified: accessed.has(index) && role !== "import",
				templateDependent: from?.templateDependent ?? false,
			});
		}
		return references;
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
		if (value !== "->" || this.trailingReturnArrows.has(index) || before?.kind !== "identifier") return false;
		if (before.value === "this") return true;
		// Could precede trailing returns.
		return !KEYWORDS.has(before.value) && !TYPE_WORDS.has(before.value) && !isShoutCase(before.value);
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

	private extractLiterals(recordMap: Map<DraftRecord, CppDeclarationRecord>): Literal[] {
		const literals: Literal[] = [];
		for (let index = 0; index < this.tokens.length; index++) {
			const token = tokenAt(this.tokens, index);
			if (token === undefined || this.templateTokenIndexes.has(index)) continue;
			const container = this.containingRecord(index, recordMap);
			const containerId = container?.declaration.symbolId;
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

	private containingRecord(
		index: number,
		recordMap: Map<DraftRecord, CppDeclarationRecord>,
	): CppDeclarationRecord | null {
		let best: CppDeclarationRecord | null = null;
		for (const record of recordMap.values()) {
			if (index < record.tokenStart || index >= record.tokenEnd) continue;
			if (best === null || record.declaration.symbolId.length > best.declaration.symbolId.length) best = record;
		}
		return best;
	}

	private referenceRole(index: number): Reference["role"] {
		const previous = significantBefore(this.tokens, index);
		const next = significantAfter(this.tokens, index);
		const previousValue = tokenAt(this.tokens, previous)?.text;
		const nextValue = tokenAt(this.tokens, next)?.text;
		if (this.typeTokenIndexes.has(index)) return "typeUse";
		if (previousValue === "new") return "instantiate";
		if (nextValue === "(" || nextValue === "<") return "call";
		if (ASSIGNMENT_OPERATORS.has(nextValue ?? "") || nextValue === "++" || nextValue === "--") return "write";
		if (previousValue === "++" || previousValue === "--") return "write";
		return "read";
	}

	private qualifiedPath(index: number): string[] {
		const token = tokenAt(this.tokens, index);
		if (token === undefined) return [];
		const path = [token.value];
		let current = significantBefore(this.tokens, index);
		while (current >= 0 && tokenAt(this.tokens, current)?.text === "::") {
			const name = significantBefore(this.tokens, current);
			const previous = tokenAt(this.tokens, name);
			if (previous?.kind !== "identifier") break;
			path.unshift(previous.value);
			current = significantBefore(this.tokens, name);
		}
		return path;
	}
}
