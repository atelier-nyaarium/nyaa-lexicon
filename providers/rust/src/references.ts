// References and literals, read from the tokens the item parse marked.

import { defined, type Literal, type Reference } from "@nyaa-lexicon/protocol";
import type { ImportBinding, RawDeclaration, RawReference } from "./model.js";
import { numericValue } from "./numbers.js";
import { isKeyword, isNameToken, isValueToken, type RustToken, TYPE_WORDS, tokenAt } from "./tokens.js";

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
	/** Struct literal and pattern field labels, each to its brace. */
	labels: ReadonlyMap<number, number>;
	/** Type brackets each token opens, less those it closes. */
	angleDeltas: ReadonlyMap<number, number>;
	/** An or-pattern's later sites of a binding, each to that binding. */
	bindingSites: ReadonlyMap<number, string>;
}

////////////////////////////////
//  Constants

const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

/** Kinds whose references belong to their container. */
const HELD_KINDS = new Set(["variable", "field", "constant"]);

const TYPE_KINDS = new Set(["struct", "enum", "interface", "class"]);

/** Previous tokens after which a name is a type. */
const TYPE_LEADS = new Set([":", "->", "as", "impl", "dyn", "where"]);

////////////////////////////////
//  Functions & Helpers

/** One scan per parse; each appends raw references. */
export function scanReferences(marks: ItemMarks): { references: Reference[]; literals: Literal[] } {
	const scan = new ReferenceScan(marks);
	const references = scan.extractReferences();
	return { references, literals: scan.extractLiterals() };
}

/** The first token starting at or past `offset`. */
function firstTokenFrom(tokens: readonly RustToken[], offset: number): number {
	let low = 0;
	let high = tokens.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((tokens[middle] as RustToken).startOffset < offset) low = middle + 1;
		else high = middle;
	}
	return low;
}

////////////////////////////////
//  Classes

class ReferenceScan {
	private readonly tokens: readonly RustToken[];
	private readonly rawDeclarations: readonly RawDeclaration[];
	private readonly rawReferences: RawReference[];
	private readonly importBindings: readonly ImportBinding[];
	private readonly attributeTokens: ReadonlySet<number>;
	private readonly declarationNameTokens: ReadonlySet<number>;
	private readonly implTraitTokens: ReadonlySet<number>;
	private readonly implTypeTokens: ReadonlySet<number>;
	private readonly keywordTokens: ReadonlySet<number>;
	private readonly labels: ReadonlyMap<number, number>;
	private readonly angleDeltas: ReadonlyMap<number, number>;
	private readonly bindingSites: ReadonlyMap<number, string>;
	/** Each token's innermost owning declaration. */
	private readonly owners: Array<string | undefined>;
	/** Each token's innermost declaration of any kind. */
	private readonly holders: Array<string | undefined>;
	private readonly typed: Uint8Array;
	private readonly ignored: Uint8Array;
	private readonly used: Uint8Array;
	private readonly typeNames: ReadonlySet<string>;

	constructor(marks: ItemMarks) {
		this.tokens = marks.tokens;
		this.rawDeclarations = marks.rawDeclarations;
		this.rawReferences = marks.rawReferences;
		this.importBindings = marks.importBindings;
		this.attributeTokens = marks.attributeTokens;
		this.declarationNameTokens = marks.declarationNameTokens;
		this.implTraitTokens = marks.implTraitTokens;
		this.implTypeTokens = marks.implTypeTokens;
		this.keywordTokens = marks.keywordTokens;
		this.labels = marks.labels;
		this.angleDeltas = marks.angleDeltas;
		this.bindingSites = marks.bindingSites;
		this.owners = new Array<string | undefined>(this.tokens.length);
		this.holders = new Array<string | undefined>(this.tokens.length);
		this.paintDeclarations();
		this.typed = new Uint8Array(this.tokens.length);
		for (const raw of this.rawDeclarations) {
			if (raw.typeSpan === undefined) continue;
			for (let index = raw.typeSpan.start; index < raw.typeSpan.end; index++) this.typed[index] = 1;
		}
		// Inside type brackets.
		let depth = 0;
		for (let index = 0; index < this.tokens.length; index++) {
			if (depth > 0) this.typed[index] = 1;
			depth = Math.max(0, depth + (marks.angleDeltas.get(index) ?? 0));
		}
		this.ignored = this.paintRanges(marks.ignoredRanges);
		this.used = this.paintRanges(marks.useRanges);
		this.typeNames = new Set(
			this.rawDeclarations
				.filter((raw) => TYPE_KINDS.has(raw.declaration.kind))
				.map((raw) => raw.declaration.name),
		);
	}

	/**
	 * Each token's innermost holder and owner, in one sweep: a declaration opens at its start and stays
	 * on its stack until a token starts at or past its end. Of equal ranges, the first declared is
	 * innermost.
	 */
	private paintDeclarations(): void {
		const ordered = this.rawDeclarations
			.map((raw, order) => ({ raw, order }))
			.sort(
				(left, right) =>
					left.raw.startOffset - right.raw.startOffset ||
					right.raw.endOffset - left.raw.endOffset ||
					right.order - left.order,
			);
		const holding: RawDeclaration[] = [];
		const owning: RawDeclaration[] = [];
		let next = 0;
		for (let index = 0; index < this.tokens.length; index++) {
			const offset = (this.tokens[index] as RustToken).startOffset;
			while (next < ordered.length) {
				const raw = (ordered[next] as { raw: RawDeclaration }).raw;
				if (raw.startOffset > offset) break;
				holding.push(raw);
				if (!HELD_KINDS.has(raw.declaration.kind)) owning.push(raw);
				next++;
			}
			while ((holding.at(-1)?.endOffset ?? offset + 1) <= offset) holding.pop();
			while ((owning.at(-1)?.endOffset ?? offset + 1) <= offset) owning.pop();
			this.holders[index] = holding.at(-1)?.declaration.symbolId;
			this.owners[index] = owning.at(-1)?.declaration.symbolId;
		}
	}

	/** Tokens starting inside a half-open range. */
	private paintRanges(ranges: readonly SpanRange[]): Uint8Array {
		const painted = new Uint8Array(this.tokens.length);
		for (const range of ranges) {
			for (
				let index = firstTokenFrom(this.tokens, range.startOffset);
				index < this.tokens.length && (this.tokens[index] as RustToken).startOffset < range.endOffset;
				index++
			)
				painted[index] = 1;
		}
		return painted;
	}

	private typeContext(index: number, token: RustToken): boolean {
		if (this.implTraitTokens.has(index) || this.implTypeTokens.has(index) || token.value === "Self") return true;
		if (this.typed[index] === 1) return true;
		// A field label's `:` leads a value.
		if (this.labels.has(index - 2)) return false;
		return TYPE_LEADS.has(tokenAt(this.tokens, index - 1)?.raw ?? "");
	}

	extractReferences(): Reference[] {
		const references: Reference[] = [];
		for (const binding of this.importBindings) {
			if (binding.sourceName === null || binding.sourceRange === undefined || binding.sourceIndex === undefined)
				continue;
			const token = this.tokens[binding.sourceIndex] as RustToken;
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
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as RustToken;
			if (this.attributeTokens.has(index) || this.ignored[index] === 1 || this.used[index] === 1) continue;
			if (
				!isNameToken(token) ||
				isKeyword(token) ||
				// The wildcard names nothing.
				token.raw === "_" ||
				this.keywordTokens.has(index) ||
				(this.declarationNameTokens.has(index) &&
					!this.implTraitTokens.has(index) &&
					!this.implTypeTokens.has(index))
			)
				continue;
			if (TYPE_WORDS.has(token.value) && token.value !== "Self") continue;
			const binds = this.bindingSites.get(index);
			if (binds !== undefined) {
				this.addReference(references, index, "write", {
					status: "bound",
					symbolId: binds,
					provenance: "bound",
				});
				continue;
			}
			const next = tokenAt(this.tokens, index + 1);
			if (isValueToken(next, "!")) {
				this.addReference(references, index, "call", {
					status: "unbound",
					reason: "RuntimeConstructed",
					detail: "macro expansion can construct runtime items",
				});
				continue;
			}
			const role = this.referenceRole(index, token);
			const path = this.receiverPath(index);
			if (role === "write" && ASSIGNMENT_OPERATORS.has(next?.value ?? "")) {
				if (next?.value !== "=") this.addReference(references, index, "read", undefined, path);
				this.addReference(references, index, "write", undefined, path);
			} else {
				this.addReference(references, index, role, undefined, path);
			}
		}
		return references;
	}

	private referenceRole(index: number, token: RustToken): Reference["role"] {
		if (this.implTraitTokens.has(index)) return "implements";
		if (this.typeContext(index, token)) return "typeUse";
		const next = tokenAt(this.tokens, index + 1)?.value;
		if (next === "{" && this.typeNames.has(token.value)) return "instantiate";
		if (this.tokens[this.pastTurbofish(index + 1)]?.value === "(") {
			if (this.typeNames.has(token.value)) return "instantiate";
			if (!["if", "while", "for", "match", "loop"].includes(token.value)) return "call";
		}
		if (ASSIGNMENT_OPERATORS.has(next ?? "")) return "write";
		return "read";
	}

	/** Past `::<..>` at `index`, so `f::<T>(` reads as a call; else `index`. */
	private pastTurbofish(index: number): number {
		if (!isValueToken(this.tokens[index], "::") || (this.angleDeltas.get(index + 1) ?? 0) <= 0) return index;
		let depth = 0;
		for (let at = index + 1; at < this.tokens.length; at++) {
			depth += this.angleDeltas.get(at) ?? 0;
			if (depth <= 0) return at + 1;
		}
		return index;
	}

	/** A field, method, later path segment, or a struct literal's or pattern's field label. */
	private qualifiedAt(index: number): boolean {
		const joiner = tokenAt(this.tokens, index - 1);
		return this.labels.has(index) || (joiner?.kind === "symbol" && (joiner.value === "." || joiner.value === "::"));
	}

	/** The type a path segment or a field label hangs from, when the source names it. */
	/** The written path before a name, and whether a leading `::` starts it at the crates. */
	private receiverPath(index: number): { path: string[]; absolute: boolean } {
		const brace = this.labels.get(index);
		let joined = brace === undefined && isValueToken(this.tokens[index - 1], "::");
		let at = brace !== undefined ? brace - 1 : joined ? index - 2 : -1;
		const path: string[] = [];
		for (;;) {
			if (at >= 0 && (this.angleDeltas.get(at) ?? 0) < 0) {
				const open = this.angleOpener(at);
				// A turbofish's type arguments sit inside the path; a qualified path's type starts it.
				if (open >= 0 && isValueToken(this.tokens[open - 1], "::")) {
					at = open - 2;
					continue;
				}
				if (open >= 0) path.unshift(...this.qualifiedSelf(open, at));
				return { path, absolute: false };
			}
			const token = this.tokens[at];
			if (at < 0 || !isNameToken(token)) return { path, absolute: joined };
			path.unshift(token.value);
			joined = isValueToken(this.tokens[at - 1], "::");
			if (!joined) return { path, absolute: false };
			at -= 2;
		}
	}

	/** The type bracket a closer at `close` ends, or -1. */
	private angleOpener(close: number): number {
		let depth = 0;
		for (let at = close; at >= 0; at--) {
			depth += this.angleDeltas.get(at) ?? 0;
			if (depth === 0) return at;
		}
		return -1;
	}

	/** In `<Type as Trait>` the trait's path, in `<Type>` the type's, from `open` to `close`. */
	private qualifiedSelf(open: number, close: number): string[] {
		let start = open + 1;
		let depth = 0;
		for (let at = open + 1; at < close; at++) {
			if (depth === 0 && isValueToken(this.tokens[at], "as")) start = at + 1;
			depth += this.angleDeltas.get(at) ?? 0;
		}
		if (isValueToken(this.tokens[start], "::")) start++;
		const names: string[] = [];
		for (let at = start; at < close && isNameToken(this.tokens[at]); at += 2) {
			names.push((this.tokens[at] as RustToken).value);
			if (!isValueToken(this.tokens[at + 1], "::")) break;
		}
		return names;
	}

	/** A `.name` access's receiver when it is one name, not a chain. */
	private receiverAt(index: number): RustToken | undefined {
		if (!isValueToken(this.tokens[index - 1], ".")) return undefined;
		const receiver = this.tokens[index - 2];
		const before = this.tokens[index - 3];
		if (!isNameToken(receiver) || isValueToken(before, ".") || isValueToken(before, "::")) return undefined;
		return receiver;
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
		{ path, absolute }: { path: string[]; absolute: boolean } = { path: [], absolute: false },
	): void {
		const token = this.tokens[index] as RustToken;
		const containerId = this.owners[index];
		const reference: Reference = {
			name: token.value,
			range: { start: token.start, end: token.end },
			role,
			binding,
			qualified: this.qualifiedAt(index),
			...defined({ fromId: containerId }),
		};
		references.push(reference);
		const member = this.labels.has(index) || isValueToken(this.tokens[index - 1], ".");
		const receiver = this.receiverAt(index);
		const qualifier = isValueToken(this.tokens[index + 1], "::") && isNameToken(this.tokens[index + 2]);
		this.rawReferences.push({
			reference,
			token,
			...defined({ containerId, receiver }),
			path,
			member,
			qualifier,
			...(absolute ? { absolute } : {}),
		});
	}

	extractLiterals(): Literal[] {
		const literals: Literal[] = [];
		for (const [index, token] of this.tokens.entries()) {
			if (this.ignored[index] === 1 || this.attributeTokens.has(index)) continue;
			const containerId = this.holders[index];
			const range = { start: token.start, end: token.end };
			if (token.kind === "string") {
				literals.push({ kind: "string", value: token.value, range, ...defined({ containerId }) });
				continue;
			}
			if (token.kind === "identifier" && (isValueToken(token, "true") || isValueToken(token, "false"))) {
				literals.push({ kind: "boolean", value: token.value, range, ...defined({ containerId }) });
				continue;
			}
			if (token.number !== undefined) {
				const number = numericValue(token.number);
				literals.push({
					kind: "number",
					value: token.value,
					...defined({ number }),
					range,
					...defined({ containerId }),
				});
			}
		}
		return literals;
	}
}
