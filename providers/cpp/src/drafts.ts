// Every draft the reader declares, with the tables and lookups that find one again.

import type { Declaration, Reference } from "@nyaa-lexicon/protocol";
import { bracketDelta, type DeclaredName } from "./angles.js";
import { listAt, mapAt } from "./collections.js";
import { CppDeclaratorReader } from "./declarators.js";
import { type HeaderKind, headerOf, type TokenSpan } from "./header.js";
import type { DraftInput, DraftRecord, Prefix, Scope, TemplateInfo, Visibility } from "./model.js";
import { exclusive } from "./tokens.js";
import { matching, significantAfter, tokenAt } from "./tokenWalk.js";
import { KEYWORDS } from "./words.js";

////////////////////////////////
//  Interfaces & Types

/** Where a declared type's name is, a reference, and the pointers and arrays around it. */
type TypeReference = Pick<DraftRecord, "typeRef" | "typeShape">;

////////////////////////////////
//  Constants

export const TYPE_KINDS: ReadonlySet<Declaration["kind"]> = new Set(["class", "struct", "enum", "typeParameter"]);

/** Kinds a written qualifier can name. */
export const SCOPE_KINDS: ReadonlySet<Declaration["kind"]> = new Set(["class", "struct", "namespace"]);

/** Kinds whose names a `<` compares after, unless declared a template. */
const VALUE_KINDS: ReadonlySet<Declaration["kind"]> = new Set([
	"variable",
	"constant",
	"field",
	"function",
	"method",
	"operator",
]);

////////////////////////////////
//  Functions & Helpers

/** A declaration's qualified name as written: its enclosing names, a written qualifier, its own name. */
export function writtenPath(draft: DraftRecord): string[] {
	const names: string[] = [];
	for (let current: DraftRecord | null = draft; current !== null; current = current.parent) {
		names.unshift(current.name);
		if (current.qualifierNames !== undefined) names.unshift(...current.qualifierNames);
	}
	return names;
}

////////////////////////////////
//  Classes

/** Holds every draft the reader declares, by scope, name and written path. */
export class CppDraftTable extends CppDeclaratorReader {
	protected readonly drafts: DraftRecord[] = [];

	protected readonly roleByToken = new Map<number, Reference["role"]>();

	/** A prototype's name token, a use of the function its definition declares. */
	protected readonly prototypes = new Map<number, DraftRecord>();

	/** Each templated declaration's own template parameter names. */
	private readonly templateNames = new Map<DraftRecord, Set<string>>();

	protected readonly typeTokenIndexes = new Set<number>();

	/** Names of the types declared so far. */
	protected readonly typeNames = new Set<string>();

	/** Classes, structs and namespaces by their qualified name as written, `a::B`. */
	private readonly scopesByPath = new Map<string, DraftRecord[]>();

	/** Declarations by the scope holding them, then by name, as the reader meets them. */
	protected readonly declaredIn = new Map<DraftRecord | null, Map<string, DraftRecord[]>>();

	/**
	 * The type `indexes` spell as a reference to its last name, or to `declared`'s when its
	 * specifiers define it, with the pointers around it and `arrays` dimensions after the
	 * declarator. Nothing for a function type or `decltype`.
	 */
	protected typeReference(indexes: readonly number[], arrays = 0, declared?: DraftRecord): TypeReference {
		let name = declared?.nameStartIndex ?? -1;
		let pointers = 0;
		let templates = 0;
		for (const index of indexes) {
			const token = tokenAt(this.tokens, index);
			const delta = bracketDelta(token, this.angles);
			templates = Math.max(0, templates + delta);
			if (templates > 0 || delta !== 0) continue;
			if (token?.text === "decltype" || token?.text === "(") return {};
			if (token?.text === "*") pointers++;
			else if (declared === undefined && token?.kind === "identifier" && !KEYWORDS.has(token.value)) name = index;
		}
		return name < 0 ? {} : { typeRef: name, typeShape: { pointers, arrays } };
	}

	/** The array dimensions from `from`, `[3][4]`, up to `limit`. */
	protected arrayRanks(from: number, limit: number): number {
		let ranks = 0;
		for (let index = from; tokenAt(this.tokens, index)?.text === "["; ranks++) {
			const close = matching(this.tokens, index, "[", "]", limit);
			const inner = significantAfter(this.tokens, index, limit);
			if (close < 0 || tokenAt(this.tokens, inner)?.text === "[") break;
			index = this.codeAfter(close, limit);
		}
		return ranks;
	}

	protected templateDependent(scope: Scope, prefix: Prefix): boolean {
		return scope.templateDependent || (prefix.template?.parameters.length ?? 0) > 0;
	}

	/** The template parameter names of each templated declaration around `owner`, innermost first. */
	protected enclosingTemplateNames(owner: DraftRecord | null): string[][] {
		const heads: string[][] = [];
		for (let current = owner; current !== null; current = current.parent) {
			const names = this.templateNames.get(current);
			if (names !== undefined) heads.push([...names]);
		}
		return heads;
	}

	/** What each name this read declared is, for reading a `<` after it; one declared both ways is left out. */
	declaredNames(): Map<string, DeclaredName> {
		const kinds = new Map<string, DeclaredName | null>();
		for (const draft of this.drafts) {
			const kind = this.templateNames.has(draft) ? "template" : VALUE_KINDS.has(draft.kind) ? "value" : undefined;
			if (kind === undefined) continue;
			const seen = kinds.get(draft.name);
			kinds.set(draft.name, seen === undefined || seen === kind ? kind : null);
		}
		const names = new Map<string, DeclaredName>();
		for (const [name, kind] of kinds) if (kind !== null) names.set(name, kind);
		return names;
	}

	/** Template parameter names in view in `owner`: its own, its enclosing declarations', and `template`'s. */
	protected templateNamesIn(owner: DraftRecord | null, template?: TemplateInfo | null): Set<string> {
		const names = new Set(template?.parameters.map((parameter) => parameter.name) ?? []);
		for (let current = owner; current !== null; current = current.parent)
			for (const name of this.templateNames.get(current) ?? []) names.add(name);
		return names;
	}

	/**
	 * Whether the type spelled at `indexes` waits on a template argument: it names a template
	 * parameter in `names` or takes a `decltype`. With no names known, any type in a template does.
	 */
	protected dependentType(indexes: readonly number[], names: ReadonlySet<string>): boolean {
		if (names.size === 0) return true;
		return indexes.some((index) => {
			const token = tokenAt(this.tokens, index);
			return token?.kind === "identifier" && (names.has(token.value) || token.value === "decltype");
		});
	}

	/** A body's local is visible from its name to the end of its block. */
	protected visibleScope(scope: Scope): { visibleEnd?: number } {
		return scope.kind === "function" && scope.blockEnd !== undefined ? { visibleEnd: scope.blockEnd } : {};
	}

	protected addTemplateParameters(template: TemplateInfo | null, parent: DraftRecord, scope: Scope): void {
		if (template === null) return;
		const names = this.templateNames.get(parent) ?? new Set<string>();
		this.templateNames.set(parent, names);
		for (const parameter of template.parameters) {
			names.add(parameter.name);
			const end = Math.max(parameter.nameEndIndex, parameter.endIndex);
			const splitEnd = parameter.splitEnd === true;
			const draft = this.addDraft({
				parent,
				own: { kind: "typeParameter", name: parameter.name },
				kind: "typeParameter",
				name: parameter.name,
				visibility: "local",
				languageKind: parameter.typeText || "template parameter",
				exported: false,
				startIndex: parameter.startIndex,
				endIndex: end,
				nameStartIndex: parameter.nameStartIndex,
				nameEndIndex: parameter.nameEndIndex,
				signature: this.header(parameter.startIndex, end, "value", undefined, splitEnd),
				metrics: this.metrics.of(parameter.startIndex, end),
				templateDependent: true,
				parameterNames: new Set(),
				...(splitEnd ? { splitEnd } : {}),
			});
			this.excludedTokenIndexes.add(parameter.nameStartIndex);
			parent.parameterNames.add(parameter.name);
			draft.parameterNames.add(parameter.name);
		}
		void scope;
	}

	protected addDraft(input: DraftInput): DraftRecord {
		const draft: DraftRecord = {
			...input,
			languageKind: input.languageKind,
			signature: input.signature,
			metrics: input.metrics,
			type: input.type,
			parameterNames: input.parameterNames ?? new Set(),
			parameterSignature: input.parameterSignature,
			hasBody: input.hasBody ?? false,
		};
		this.drafts.push(draft);
		if (TYPE_KINDS.has(draft.kind)) this.typeNames.add(draft.name);
		listAt(mapAt(this.declaredIn, draft.parent), draft.name).push(draft);
		if (SCOPE_KINDS.has(draft.kind)) listAt(this.scopesByPath, writtenPath(draft).join("::")).push(draft);
		for (let index = draft.nameStartIndex; index < draft.nameEndIndex; index++)
			this.excludedTokenIndexes.add(index);
		return draft;
	}

	protected header(
		startIndex: number,
		endIndex: number,
		kind: HeaderKind,
		lead?: TokenSpan,
		splitEnd = false,
	): string | undefined {
		return headerOf(this.text, this.tokens, startIndex, endIndex, kind, this.angles, lead, splitEnd, this.meter);
	}

	protected visibilityFor(scope: Scope, modifiers: Set<string>, fallback?: Visibility): Visibility {
		if (scope.kind === "function") return "local";
		if (scope.kind === "class") return fallback ?? scope.defaultVisibility;
		return modifiers.has("static") ? "fileLocal" : (fallback ?? scope.defaultVisibility);
	}

	/**
	 * The class or namespace a written qualifier names, looked up from `scope` outward: `detail::x`
	 * inside `namespace nlohmann` is `nlohmann::detail`. Of a class declared and defined, the
	 * definition, which holds the members; none in another `#if` branch than the name at `at`.
	 */
	protected findQualifiedParent(qualifier: string[], scope: Scope, at: number): DraftRecord | null {
		if (qualifier.length === 0) return null;
		const alternative = tokenAt(this.tokens, at)?.alternative;
		const fits = (draft: DraftRecord) =>
			!exclusive(tokenAt(this.tokens, draft.nameStartIndex)?.alternative, alternative);
		const around = scope.parent === null ? [] : writtenPath(scope.parent);
		for (let depth = around.length; depth >= 0; depth--) {
			const candidates = this.scopesByPath.get([...around.slice(0, depth), ...qualifier].join("::"));
			let first: DraftRecord | undefined;
			for (const candidate of candidates ?? []) {
				if (this.meter !== undefined) this.meter.steps++;
				if (fits(candidate)) {
					first = candidate;
					break;
				}
			}
			if (candidates === undefined || first === undefined) continue;
			if (first.kind === "namespace" || first.hasBody) return first;
			for (const candidate of candidates) {
				if (this.meter !== undefined) this.meter.steps++;
				if (candidate.hasBody && fits(candidate)) return candidate;
			}
			return first;
		}
		return null;
	}
}
