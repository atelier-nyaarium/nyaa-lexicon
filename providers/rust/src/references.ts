// References and literals, read from the tokens the item parse marked.

import { comparePositions, defined, type Literal, type Reference } from "@nyaa-lexicon/protocol";
import type { ImportBinding, RawDeclaration, RawReference } from "./model.js";
import { numericValue } from "./numbers.js";
import { isNameToken, isValueToken, KEYWORDS, type RustToken, TYPE_WORDS, tokenAt } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

export interface SpanRange {
	startOffset: number;
	endOffset: number;
}

/** Marks the item parse leaves for the reference scan. */
export interface ItemMarks {
	tokens: readonly RustToken[];
	rawDeclarations: readonly RawDeclaration[];
	rawReferences: RawReference[];
	importBindings: readonly ImportBinding[];
	ignoredRanges: readonly SpanRange[];
	attributeTokens: ReadonlySet<number>;
	useRanges: readonly SpanRange[];
	declarationNameTokens: ReadonlySet<number>;
	implTraitTokens: ReadonlySet<number>;
	implTypeTokens: ReadonlySet<number>;
	keywordTokens: ReadonlySet<number>;
}

////////////////////////////////
//  Constants

const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

////////////////////////////////
//  Functions & Helpers

/** One scan per parse; each appends raw references. */
export function scanReferences(marks: ItemMarks): { references: Reference[]; literals: Literal[] } {
	const scan = new ReferenceScan(marks);
	const references = scan.extractReferences();
	return { references, literals: scan.extractLiterals() };
}

////////////////////////////////
//  Classes

class ReferenceScan {
	private readonly tokens: readonly RustToken[];
	private readonly rawDeclarations: readonly RawDeclaration[];
	private readonly rawReferences: RawReference[];
	private readonly importBindings: readonly ImportBinding[];
	private readonly ignoredRanges: readonly SpanRange[];
	private readonly attributeTokens: ReadonlySet<number>;
	private readonly useRanges: readonly SpanRange[];
	private readonly declarationNameTokens: ReadonlySet<number>;
	private readonly implTraitTokens: ReadonlySet<number>;
	private readonly implTypeTokens: ReadonlySet<number>;
	private readonly keywordTokens: ReadonlySet<number>;

	constructor(marks: ItemMarks) {
		this.tokens = marks.tokens;
		this.rawDeclarations = marks.rawDeclarations;
		this.rawReferences = marks.rawReferences;
		this.importBindings = marks.importBindings;
		this.ignoredRanges = marks.ignoredRanges;
		this.attributeTokens = marks.attributeTokens;
		this.useRanges = marks.useRanges;
		this.declarationNameTokens = marks.declarationNameTokens;
		this.implTraitTokens = marks.implTraitTokens;
		this.implTypeTokens = marks.implTypeTokens;
		this.keywordTokens = marks.keywordTokens;
	}

	private isInRange(offset: number, range: SpanRange): boolean {
		return offset >= range.startOffset && offset <= range.endOffset;
	}

	private isIgnored(offset: number): boolean {
		return this.ignoredRanges.some((range) => this.isInRange(offset, range));
	}

	private isUse(offset: number): boolean {
		return this.useRanges.some((range) => this.isInRange(offset, range));
	}

	private containerAt(offset: number): string | undefined {
		const candidates = this.rawDeclarations.filter(
			(raw) =>
				raw.startOffset <= offset &&
				offset <= raw.endOffset &&
				raw.declaration.kind !== "variable" &&
				raw.declaration.kind !== "field" &&
				raw.declaration.kind !== "constant",
		);
		candidates.sort((left, right) => left.endOffset - left.startOffset - (right.endOffset - right.startOffset));
		return candidates[0]?.declaration.symbolId;
	}

	private literalContainerAt(offset: number): string | undefined {
		const candidates = this.rawDeclarations.filter((raw) => raw.startOffset <= offset && offset <= raw.endOffset);
		candidates.sort((left, right) => left.endOffset - left.startOffset - (right.endOffset - right.startOffset));
		return candidates[0]?.declaration.symbolId;
	}

	private typeContext(index: number, token: RustToken): boolean {
		if (this.implTraitTokens.has(index) || this.implTypeTokens.has(index) || token.value === "Self") return true;
		for (const raw of this.rawDeclarations) {
			const range = raw.typeRange;
			if (range === undefined) continue;
			if (comparePositions(range.start, token.start) <= 0 && comparePositions(range.end, token.end) >= 0)
				return true;
		}
		const previous = tokenAt(this.tokens, index - 1)?.value;
		return (
			previous === ":" ||
			previous === "->" ||
			previous === "as" ||
			previous === "impl" ||
			previous === "dyn" ||
			previous === "where"
		);
	}

	private typeDeclaration(name: string): RawDeclaration | undefined {
		return this.rawDeclarations.find(
			(raw) =>
				raw.declaration.name === name &&
				["struct", "enum", "interface", "class"].includes(raw.declaration.kind),
		);
	}

	extractReferences(): Reference[] {
		const references: Reference[] = [];
		for (const binding of this.importBindings) {
			if (binding.sourceName === null || binding.sourceRange === undefined) continue;
			const sourceStart = binding.sourceRange.start;
			const token = this.tokens.find((candidate) => comparePositions(candidate.start, sourceStart) === 0);
			if (token === undefined) continue;
			const reference: Reference = {
				name: binding.sourceName,
				range: binding.sourceRange,
				role: "import",
				binding: {
					status: "unbound",
					reason: "NotIndexed",
					detail: "import binding awaits workspace resolution",
				},
				// Binds a local name.
				qualified: false,
				...(binding.containerId === undefined ? {} : { fromId: binding.containerId }),
			};
			references.push(reference);
			this.rawReferences.push({
				reference,
				token,
				...(binding.containerId === undefined ? {} : { containerId: binding.containerId }),
				importBinding: binding,
				path: binding.path,
			});
		}
		let index = 0;
		let guard = -1;
		while (index < this.tokens.length) {
			if (index <= guard) throw new Error("reference parser failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			if (this.attributeTokens.has(index) || this.isIgnored(token.startOffset) || this.isUse(token.startOffset)) {
				index++;
				continue;
			}
			if (
				!isNameToken(token) ||
				KEYWORDS.has(token.value) ||
				this.keywordTokens.has(index) ||
				(this.declarationNameTokens.has(index) &&
					!this.implTraitTokens.has(index) &&
					!this.implTypeTokens.has(index))
			) {
				index++;
				continue;
			}
			if (isValueToken(this.tokens[index - 1], "'")) {
				index++;
				continue;
			}
			const next = tokenAt(this.tokens, index + 1);
			if (TYPE_WORDS.has(token.value) && token.value !== "Self") {
				index++;
				continue;
			}
			if (isValueToken(next, "!")) {
				this.addReference(references, index, "call", {
					status: "unbound",
					reason: "RuntimeConstructed",
					detail: "macro expansion can construct runtime items",
				});
				index++;
				continue;
			}
			const role = this.referenceRole(index, token);
			const receiver = isValueToken(this.tokens[index - 1], "::") ? tokenAt(this.tokens, index - 2) : undefined;
			const path = receiver !== undefined && isNameToken(receiver) ? [receiver.value] : [];
			if (role === "write" && ASSIGNMENT_OPERATORS.has(next?.value ?? "")) {
				if (next?.value !== "=") this.addReference(references, index, "read", undefined, path);
				this.addReference(references, index, "write", undefined, path);
			} else {
				this.addReference(references, index, role, undefined, path);
			}
			index++;
		}
		return references;
	}

	private referenceRole(index: number, token: RustToken): Reference["role"] {
		if (this.implTraitTokens.has(index)) return "implements";
		if (this.typeContext(index, token)) return "typeUse";
		const next = tokenAt(this.tokens, index + 1)?.value;
		if (next === "{" && this.typeDeclaration(token.value) !== undefined) return "instantiate";
		if (next === "(") {
			if (this.typeDeclaration(token.value) !== undefined) return "instantiate";
			if (!["if", "while", "for", "match", "loop"].includes(token.value)) return "call";
		}
		if (ASSIGNMENT_OPERATORS.has(next ?? "")) return "write";
		return "read";
	}

	/** A field, method, or later path segment. */
	private qualifiedAt(index: number): boolean {
		const joiner = tokenAt(this.tokens, index - 1);
		return joiner?.kind === "symbol" && (joiner.value === "." || joiner.value === "::");
	}

	private addReference(
		references: Reference[],
		index: number,
		role: Reference["role"],
		binding: Reference["binding"] = {
			status: "unbound",
			reason: "NotIndexed",
			detail: "name awaits scope resolution",
		},
		path: string[] = [],
	): void {
		const token = this.tokens[index] as RustToken;
		const reference: Reference = {
			name: token.value,
			range: { start: token.start, end: token.end },
			role,
			binding,
			qualified: this.qualifiedAt(index),
			...(this.containerAt(token.startOffset) === undefined
				? {}
				: { fromId: this.containerAt(token.startOffset) }),
		};
		references.push(reference);
		const containerId = this.containerAt(token.startOffset);
		this.rawReferences.push({ reference, token, ...defined({ containerId }), path });
	}

	extractLiterals(): Literal[] {
		const literals: Literal[] = [];
		for (const [index, token] of this.tokens.entries()) {
			if (this.isIgnored(token.startOffset) || this.attributeTokens.has(index)) continue;
			if (token.kind === "string") {
				const containerId = this.literalContainerAt(token.startOffset);
				literals.push({
					kind: "string",
					value: token.value,
					range: { start: token.start, end: token.end },
					...defined({ containerId }),
				});
				continue;
			}
			if (token.value === "true" || token.value === "false") {
				const containerId = this.literalContainerAt(token.startOffset);
				literals.push({
					kind: "boolean",
					value: token.value,
					range: { start: token.start, end: token.end },
					...defined({ containerId }),
				});
				continue;
			}
			if (token.number !== undefined) {
				const number = numericValue(token.number);
				const containerId = this.literalContainerAt(token.startOffset);
				literals.push({
					kind: "number",
					value: token.value,
					...defined({ number }),
					range: { start: token.start, end: token.end },
					...defined({ containerId }),
				});
			}
		}
		return literals;
	}
}
