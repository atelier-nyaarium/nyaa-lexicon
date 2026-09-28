// What a C# parse records as it reads: raw declarations and their ids, and the marks references read.

import { composeSymbolId, type Descriptor, qualifierDescriptors, type Reference } from "@nyaa-lexicon/protocol";
import {
	type CsharpImport,
	type Declarator,
	LANGUAGE,
	type RawDeclaration,
	type RawDeclarationInput,
	type Segment,
	segmentKey,
	type TypeSpan,
} from "./model.js";
import type { Token } from "./tokens.js";
import { CsharpTypeReader } from "./typeReader.js";
import { isIdentifier, MODIFIERS, SKIPPED_WORDS, syntaxValue } from "./words.js";

////////////////////////////////
//  Constants

/** Language kinds a body declares; each is named by ordinal. */
const LOCAL_KINDS: ReadonlySet<string> = new Set(["local", "localFunction", "lambdaParameter", "rangeVariable"]);

////////////////////////////////
//  Functions & Helpers

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

////////////////////////////////
//  Classes

export abstract class CsharpRecorder extends CsharpTypeReader {
	protected readonly rawDeclarations: RawDeclaration[] = [];

	protected readonly rawImports: CsharpImport[] = [];

	/** The declaration whose body holds each using directive not at the compilation unit. */
	protected readonly importScopes = new Map<CsharpImport, RawDeclaration>();

	protected readonly typeTokenIndices = new Set<number>();

	protected readonly roleByOffset = new Map<number, Reference["role"]>();

	protected readonly ignoredOffsets = new Set<number>();

	protected readonly namespaceNames = new Set<string>();

	protected readonly attributeNames = new Set<string>();

	protected readonly baseListNames = new Set<string>();

	protected readonly accessorBodyRanges: Array<{ start: number; end: number }> = [];

	private readonly scopeCounts = new Map<RawDeclaration | undefined, Map<string, number>>();

	protected skippedFileScope = false;

	private localOrdinal = 0;

	protected addTypeReference(start: number, end: number, role: Reference["role"]): void {
		if (end < start) return;
		for (let current = start; current <= end; current++) {
			const item = this.token(current);
			if (isIdentifier(item) && !SKIPPED_WORDS.has(syntaxValue(item) as string)) {
				this.typeTokenIndices.add(current);
				this.roleByOffset.set(item.startOffset, role);
			}
		}
	}

	/** Gives each of a statement's declarators its own span, when there are several. */
	protected ownDeclarators(declared: readonly Declarator[]): void {
		if (declared.length < 2) return;
		for (const item of declared)
			item.declaration.declarator = {
				start: this.token(item.start) as Token,
				end: this.token(item.end) as Token,
			};
	}

	/** The type of a literal initializing the name at `nameIndex`. */
	protected initializerType(end: number, nameIndex: number): string | undefined {
		const equals = this.nextSignificant(nameIndex + 1, end);
		if (this.value(equals) !== "=") return undefined;
		return this.token(this.nextSignificant(equals + 1, end))?.literalType;
	}

	/** Element names are not references; an outline keeps only the declared type. */
	protected recordTypeSpan(span: TypeSpan | undefined, declaration: RawDeclaration): void {
		if (span === undefined) return;
		const leading = this.leadingType(span);
		if (declaration.typeText === undefined) Object.assign(declaration, this.typeFacts(leading));
		if (this.outline) return;
		// Explicit interface qualifier.
		const qualifier = leading === undefined ? undefined : this.typeShape(leading.shape.end, span.end);
		const elementNames = new Set([...(leading?.shape.elementNames ?? []), ...(qualifier?.elementNames ?? [])]);
		for (let current = span.start; current < span.end; current++) {
			const item = this.token(current);
			if (!isIdentifier(item) || MODIFIERS.has(syntaxValue(item) as string)) continue;
			if (elementNames.has(current)) this.ignoredOffsets.add(item.startOffset);
			else this.typeTokenIndices.add(current);
		}
	}

	protected addDeclaration(input: RawDeclarationInput): RawDeclaration {
		const key = `${input.kind}:${input.name}`;
		const counts = this.scopeCounts.get(input.parent);
		const scope = counts ?? new Map<string, number>();
		if (counts === undefined) this.scopeCounts.set(input.parent, scope);
		const ordinal = scope.get(key) ?? 0;
		scope.set(key, ordinal + 1);
		const raw: RawDeclaration = {
			...input,
			nameTokenOffsets: uniqueStrings(input.nameTokenOffsets.map(String)).map(Number),
		};
		// Locals, and all a local function holds, are named by ordinal.
		if (LOCAL_KINDS.has(input.languageKind ?? "") || input.parent?.localOrdinal !== undefined) {
			raw.localOrdinal = this.localOrdinal++;
		} else if (input.languageKind === "parameter") {
			raw.descriptor = { kind: "parameter", name: input.name };
		} else if (input.languageKind === "delegate") {
			raw.descriptor = { kind: "type", name: input.name };
		} else if (
			input.kind === "method" ||
			input.kind === "constructor" ||
			input.kind === "function" ||
			input.kind === "operator" ||
			// An indexer overloads like a method.
			(input.kind === "property" && input.name === "this")
		) {
			raw.descriptor =
				ordinal === 0
					? { kind: "method", name: input.name }
					: { kind: "method", name: input.name, disambiguator: String(ordinal) };
		} else if (input.kind === "typeParameter") {
			raw.descriptor = { kind: "typeParameter", name: input.name };
		} else {
			raw.descriptor = {
				kind:
					input.kind === "namespace"
						? "namespace"
						: input.kind === "class" ||
								input.kind === "interface" ||
								input.kind === "struct" ||
								input.kind === "enum"
							? "type"
							: "term",
				name: input.name,
				// Extension blocks share one name, so the second on is told apart by order.
				...(input.languageKind === "extension" && ordinal > 0 ? { disambiguator: String(ordinal) } : {}),
			};
		}
		this.rawDeclarations.push(raw);
		return raw;
	}

	protected pathFor(raw: RawDeclaration, cache: Map<RawDeclaration, string>): string {
		const cached = cache.get(raw);
		if (cached !== undefined) return cached;
		const id =
			raw.localOrdinal === undefined
				? composeSymbolId({
						language: LANGUAGE,
						module: this.module,
						descriptors: this.descriptorPath(raw, cache),
					})
				: composeSymbolId({
						language: LANGUAGE,
						module: this.module,
						descriptors: [],
						local: raw.localOrdinal,
					});
		cache.set(raw, id);
		return id;
	}

	private descriptorPath(raw: RawDeclaration, cache: Map<RawDeclaration, string>): Descriptor[] {
		const path: Descriptor[] = raw.parent === undefined ? [] : this.descriptorPath(raw.parent, cache);
		if (raw.qualifier !== undefined)
			path.push(
				...qualifierDescriptors(
					raw.qualifier,
					(name) =>
						this.rawDeclarations.find(
							(item) =>
								item.name === name &&
								(item.kind === "class" ||
									item.kind === "interface" ||
									item.kind === "struct" ||
									item.kind === "enum"),
						)?.descriptor,
				),
			);
		if (raw.descriptor !== undefined) path.push(raw.descriptor);
		return path;
	}

	protected namespaceName(raw: RawDeclaration | undefined): string {
		const names: string[] = [];
		let current = raw;
		while (current !== undefined) {
			if (current.kind === "namespace") names.unshift(current.name);
			current = current.parent;
		}
		return names.join(".");
	}

	/** The types around a declaration, each with its type parameters, by `segmentKey`. */
	protected typePath(raw: RawDeclaration | undefined, arity: ReadonlyMap<RawDeclaration, number>): string {
		const segments: Segment[] = [];
		let current = raw;
		while (current !== undefined) {
			if (
				current.kind === "class" ||
				current.kind === "struct" ||
				current.kind === "interface" ||
				current.kind === "enum"
			)
				segments.unshift({ name: current.name, arity: arity.get(current) ?? 0 });
			current = current.parent;
		}
		return segmentKey(segments);
	}
}
