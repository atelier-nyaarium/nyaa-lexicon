// A C# file's facts: the declaration parse, then references, literals and comments.

import {
	type CommentSpan,
	comparePositions,
	type Declaration,
	defined,
	type FileRole,
	type Literal,
	type Metrics,
	type Range,
	type Reference,
} from "@nyaa-lexicon/protocol";
import { CsharpDeclarationParser } from "./declarations.js";
import type { CsharpFacts, DeclarationMeta, RawDeclaration } from "./model.js";
import { positionRange, type Token } from "./tokens.js";
import {
	ASSIGNMENT_WORDS,
	BUILTIN_TYPES,
	isIdentifier,
	isTrivia,
	LAMBDA_ATTRIBUTE_CONTEXT,
	MEMBER_OPERATORS,
	SKIPPED_WORDS,
	STATEMENT_BOUNDARY,
	syntaxValue,
} from "./words.js";

////////////////////////////////
//  Functions & Helpers

function numericValue(raw: string): number | undefined {
	const clean = raw.replaceAll("_", "");
	const prefixed =
		clean.startsWith("0x") || clean.startsWith("0X") || clean.startsWith("0b") || clean.startsWith("0B");
	const suffix = prefixed ? clean.replace(/[uUlL]+$/u, "") : clean.replace(/[fFdDmMuUlL]+$/u, "");
	try {
		if (prefixed || /^\d+$/u.test(suffix)) {
			const exact = BigInt(suffix);
			if (exact > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
			return Number(exact);
		}
		const value = Number(suffix);
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

////////////////////////////////
//  Classes

export class CsharpParser extends CsharpDeclarationParser {
	parse(): CsharpFacts {
		if (this.module.endsWith(".cs")) {
			this.checkDelimiters();
			this.parseScope(0, this.tokens.length - 1, undefined);
		}
		const finalized = this.finalizeDeclarations();
		if (!this.outline) this.scanNestedAttributes(finalized.metadata);
		const references = this.outline ? [] : this.extractReferences(finalized.metadata);
		const literals = this.outline ? [] : this.extractLiterals(finalized.metadata);
		const comments = this.outline ? [] : this.extractComments();
		const diagnostics = this.diagnostics
			.map((item) => ({ ...item, path: this.module }))
			.sort((left, right) => {
				const a = left.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
				const b = right.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
				return comparePositions(a, b);
			});
		return {
			module: this.module,
			text: this.text,
			role: this.fileRole(finalized.declarations, finalized.metadata),
			declarations: finalized.declarations,
			references,
			imports: this.rawImports,
			literals,
			comments,
			blankLines: this.lexed.blankLines,
			diagnostics,
			metadata: finalized.metadata,
			namespaceNames: [...this.namespaceNames].sort(),
			attributeNames: this.attributeNames,
		};
	}

	private fileRole(declarations: Declaration[], metadata: Map<string, DeclarationMeta>): FileRole {
		const main = declarations.find((declaration) => {
			if (declaration.kind !== "method" || declaration.name !== "Main") return false;
			return metadata.get(declaration.symbolId)?.isStatic === true;
		});
		if (main !== undefined) return { kind: "entry", how: "main", symbolId: main.symbolId };
		if (this.skippedFileScope) return { kind: "unknown", reason: "NotImplemented" };
		return { kind: "library" };
	}

	/** Statement-boundary runs are attributes only inside method-shaped bodies. At expression starts,
	 * only runs before lambdas, anonymous methods, or their parameter lists are attributes.
	 */
	private scanNestedAttributes(metadata: Map<string, DeclarationMeta>): void {
		const end = this.tokens.length;
		const bodies = this.runningBodyRanges(metadata);
		for (let current = 0; current < end; current++) {
			if (this.value(current) !== "[") continue;
			const previous = this.previousSignificant(current);
			const previousValue = this.value(previous);
			if (previousValue === undefined) continue;
			const token = this.token(current) as Token;
			const boundary = STATEMENT_BOUNDARY.has(previousValue) && this.insideAny(bodies, token.startOffset);
			const anonymousMethodParameter = previousValue === "(" && this.precededByDelegateKeyword(previous);
			if (!boundary && !anonymousMethodParameter && !LAMBDA_ATTRIBUTE_CONTEXT.has(previousValue)) continue;
			const after = this.bracketedSectionsEnd(current, end);
			if (after === current) continue;
			const verified = anonymousMethodParameter
				? true
				: boundary
					? this.looksLikeLocalFunctionSignature(after, end)
					: this.looksLikeLambdaSignature(after, end);
			if (!verified) continue;
			let mark = current;
			while (mark < after) {
				const section = this.attributeSectionAt(mark, end);
				if (section === undefined || section.close < 0) break;
				mark = section.close + 1;
			}
		}
	}

	/** Body spans a local function could sit among. */
	private runningBodyRanges(metadata: Map<string, DeclarationMeta>): Array<{ start: number; end: number }> {
		const ranges: Array<{ start: number; end: number }> = [...this.accessorBodyRanges];
		for (const item of metadata.values()) {
			if (item.bodyStartOffset === undefined || item.bodyEndOffset === undefined) continue;
			const kind = item.declaration.kind;
			if (kind !== "method" && kind !== "constructor" && kind !== "operator" && kind !== "function") continue;
			ranges.push({ start: item.bodyStartOffset, end: item.bodyEndOffset });
		}
		return ranges;
	}

	private insideAny(ranges: Array<{ start: number; end: number }>, offset: number): boolean {
		return ranges.some((range) => range.start <= offset && offset < range.end);
	}

	private finalizeDeclarations(): { declarations: Declaration[]; metadata: Map<string, DeclarationMeta> } {
		const cache = new Map<RawDeclaration, string>();
		const declarations: Declaration[] = [];
		const metadata = new Map<string, DeclarationMeta>();
		for (const raw of this.rawDeclarations) {
			const symbolId = this.pathFor(raw, cache);
			const containerId = raw.parent === undefined ? undefined : this.pathFor(raw.parent, cache);
			const lines = raw.endToken.end.line - raw.startToken.start.line + 1;
			const metrics: Metrics = { lines: Math.max(1, lines) };
			if (raw.parameterCount !== undefined) metrics.parameters = raw.parameterCount;
			if (raw.bodyStartToken !== undefined && raw.bodyEndToken !== undefined) {
				const body = this.metricsForBody(raw.bodyStartToken, raw.bodyEndToken);
				metrics.nesting = body.nesting;
				metrics.branches = body.branches;
			}
			const declaration: Declaration = {
				symbolId,
				kind: raw.kind,
				...defined({ languageKind: raw.languageKind }),
				name: raw.name,
				range: { start: raw.startToken.start, end: raw.endToken.end },
				selectionRange: { start: raw.selectionStart.start, end: raw.selectionEnd.end },
				visibility: raw.visibility,
				exported: raw.exported,
				...defined({ signature: raw.signature, containerId, memberInsertLine: raw.memberInsertLine }),
				metrics,
			};
			declarations.push(declaration);
			metadata.set(symbolId, {
				declaration,
				startOffset: raw.startToken.startOffset,
				endOffset: raw.endToken.endOffset,
				namespaceName: this.namespaceName(raw.parent),
				typePath: this.typePath(raw.parent),
				...defined({ parentId: containerId }),
				...defined({
					typeText: raw.typeText,
					typeName: raw.typeName,
					inferredType: raw.inferredType,
					isPartial: raw.isPartial,
					isStatic: raw.isStatic,
				}),
				...(raw.bodyStartToken === undefined ? {} : { bodyStartOffset: raw.bodyStartToken.endOffset }),
				...(raw.bodyEndToken === undefined ? {} : { bodyEndOffset: raw.bodyEndToken.startOffset }),
				...defined({ parameterCount: raw.parameterCount }),
			});
		}
		return { declarations, metadata };
	}

	private metricsForBody(start: Token, end: Token): { nesting: number; branches: number } {
		let depth = 0;
		let nesting = 0;
		let branches = 0;
		for (const item of this.tokens) {
			if (item.startOffset <= start.endOffset) continue;
			if (item.startOffset >= end.startOffset) break;
			const value = syntaxValue(item);
			if (value === "{") {
				depth++;
				nesting = Math.max(nesting, depth);
			}
			if (value === "}") depth = Math.max(0, depth - 1);
			if (
				(item.kind === "identifier" &&
					["if", "for", "foreach", "while", "catch", "case"].includes(item.value)) ||
				(item.kind === "punctuation" && ["&&", "||", "??"].includes(item.value))
			)
				branches++;
		}
		return { nesting, branches: branches + 1 };
	}

	private extractReferences(metadata: Map<string, DeclarationMeta>): Reference[] {
		const declarationOffsets = new Set<number>();
		for (const raw of this.rawDeclarations)
			for (const offset of raw.nameTokenOffsets) declarationOffsets.add(offset);
		const references: Reference[] = [];
		const added = new Set<string>();
		const qualified = this.qualifiedNameOffsets();
		const add = (token: Token, role: Reference["role"], name = token.value): void => {
			const key = `${token.startOffset}:${role}`;
			if (added.has(key)) return;
			added.add(key);
			const container = this.containerAt(token.startOffset, metadata);
			references.push({
				name,
				range: positionRange(token),
				role,
				qualified: qualified.has(token.startOffset),
				binding: {
					status: "unbound",
					reason: "NotImplemented",
					detail: "C# binding is resolved by the provider index",
				},
				...(container === undefined ? {} : { fromId: container.declaration.symbolId }),
			});
		};
		for (const item of this.rawImports) {
			const token = this.tokenForRange(item.specifierRange);
			if (token !== undefined) add(token, "import", item.specifier);
		}
		for (let index = 0; index < this.tokens.length; index++) {
			const item = this.token(index);
			if (
				!isIdentifier(item) ||
				declarationOffsets.has(item.startOffset) ||
				this.ignoredOffsets.has(item.startOffset)
			)
				continue;
			const next = this.nextSignificant(index + 1);
			const nextValue = this.value(next);
			if (item.value === "typeof" && nextValue === "(") {
				const close = this.matching(next, "(", ")");
				if (close > next) this.addTypeReference(next + 1, close - 1, "typeUse");
				continue;
			}
			if (item.value === "nameof" && nextValue === "(") {
				const close = this.matching(next, "(", ")");
				// A generic operand names a type; the rest is a read.
				if (close > next) {
					const typeEnd = this.genericOperandEnd(next + 1, close);
					if (typeEnd !== undefined) this.addTypeReference(next + 1, typeEnd, "typeUse");
				}
				continue;
			}
			if (item.value === "new") {
				this.markNewInstantiation(index);
				continue;
			}
			if (SKIPPED_WORDS.has(item.value) && !(nextValue === "(" && ["add", "remove"].includes(item.value)))
				continue;
			if (BUILTIN_TYPES.has(item.value)) continue;
			const role = this.roleByOffset.get(item.startOffset);
			if (role !== undefined) {
				add(item, role);
				continue;
			}
			const previous = this.previousSignificant(index);
			const previousValue = this.value(previous);
			if (item.value === "this" || item.value === "base") continue;
			// A qualifier head (`new A.B()`) is not the instantiated type; markNewInstantiation names B.
			if (previousValue === "new" && nextValue !== ".") {
				add(item, "instantiate");
				continue;
			}
			if (this.typeTokenIndices.has(index)) {
				if (!BUILTIN_TYPES.has(item.value)) add(item, "typeUse");
				continue;
			}
			if (
				nextValue === "(" &&
				!["if", "for", "foreach", "while", "switch", "catch", "lock", "using"].includes(item.value)
			) {
				add(item, "call");
				continue;
			}
			if (
				ASSIGNMENT_WORDS.has(nextValue ?? "") ||
				nextValue === "++" ||
				nextValue === "--" ||
				previousValue === "++" ||
				previousValue === "--"
			) {
				add(item, "write");
				continue;
			}
			add(item, "read");
		}
		return references;
	}

	/** Names right of a member operator. */
	private qualifiedNameOffsets(): Set<number> {
		const offsets = new Set<number>();
		let afterOperator = false;
		for (const item of this.tokens) {
			if (isTrivia(item)) continue;
			if (afterOperator && isIdentifier(item)) offsets.add(item.startOffset);
			afterOperator = item.kind === "punctuation" && MEMBER_OPERATORS.has(item.value);
		}
		return offsets;
	}

	private tokenForRange(range: Range): Token | undefined {
		return this.tokens.find((item) => comparePositions(item.start, range.start) === 0);
	}

	private containerAt(offset: number, metadata: Map<string, DeclarationMeta>): DeclarationMeta | undefined {
		let selected: DeclarationMeta | undefined;
		for (const item of metadata.values()) {
			// A parameter's header is its declaration's.
			if (item.declaration.languageKind === "parameter") continue;
			if (item.startOffset <= offset && offset <= item.endOffset) {
				if (
					selected === undefined ||
					item.endOffset - item.startOffset < selected.endOffset - selected.startOffset
				)
					selected = item;
			}
		}
		return selected;
	}

	private extractLiterals(metadata: Map<string, DeclarationMeta>): Literal[] {
		const literals: Literal[] = [];
		for (const item of this.lexed.literals) {
			const container = this.containerAt(item.startOffset, metadata);
			const literal: Literal = {
				kind: item.kind === "boolean" ? "boolean" : item.kind === "number" ? "number" : "string",
				value: item.value,
				range: positionRange(item),
				...(item.kind === "number" && numericValue(item.value) !== undefined
					? { number: numericValue(item.value) }
					: {}),
				...(container === undefined ? {} : { containerId: container.declaration.symbolId }),
			};
			literals.push(literal);
		}
		return literals;
	}

	/** Raw spans off the lexed stream, so a marker inside a string is never one. */
	private extractComments(): CommentSpan[] {
		return this.lexed.comments.map((item) => ({
			range: positionRange(item),
			text: item.raw,
			codeBefore: this.lexed.trivia.get(item)?.codeBefore ?? false,
			codeAfter: this.lexed.trivia.get(item)?.codeAfter ?? false,
		}));
	}
}
