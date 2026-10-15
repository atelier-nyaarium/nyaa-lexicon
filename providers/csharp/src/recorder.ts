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
import type { CsharpParseContext } from "./parseContext.js";
import type { Token } from "./tokens.js";
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

export class CsharpRecorder {
	constructor(private readonly context: CsharpParseContext) {}

	private readonly rawDeclarationsValue: RawDeclaration[] = [];

	private readonly rawImportsValue: CsharpImport[] = [];

	/** The declaration whose body holds each using directive not at the compilation unit. */
	private readonly importScopes = new Map<CsharpImport, RawDeclaration>();

	private readonly typeTokenIndices = new Set<number>();

	private readonly roleByOffset = new Map<number, Reference["role"]>();

	private readonly ignoredOffsets = new Set<number>();

	private readonly namespaceNames = new Set<string>();

	private readonly attributeNames = new Set<string>();

	private readonly baseListNames = new Set<string>();

	private readonly accessorBodyRanges: Array<{ start: number; end: number }> = [];

	private readonly scopeCounts = new Map<RawDeclaration | undefined, Map<string, number>>();

	private skippedFileScope = false;

	private localOrdinal = 0;

	public addTypeReference(start: number, end: number, role: Reference["role"]): void {
		if (end < start) return;
		for (let current = start; current <= end; current++) {
			const item = this.context.tokenStream.token(current);
			if (isIdentifier(item) && !SKIPPED_WORDS.has(syntaxValue(item) as string)) {
				this.markTypeToken(current);
				this.markRole(item.startOffset, role);
			}
		}
	}

	/** Gives each of a statement's declarators its own span, when there are several. */
	public ownDeclarators(declared: readonly Declarator[]): void {
		if (declared.length < 2) return;
		for (const item of declared)
			item.declaration.declarator = {
				start: this.context.tokenStream.token(item.start) as Token,
				end: this.context.tokenStream.token(item.end) as Token,
			};
	}

	/** The type of a literal initializing the name at `nameIndex`. */
	public initializerType(end: number, nameIndex: number): string | undefined {
		const equals = this.context.tokenStream.nextSignificant(nameIndex + 1, end);
		if (this.context.tokenStream.value(equals) !== "=") return undefined;
		return this.context.tokenStream.token(this.context.tokenStream.nextSignificant(equals + 1, end))?.literalType;
	}

	/** Element names are not references; an outline keeps only the declared type. */
	public recordTypeSpan(span: TypeSpan | undefined, declaration: RawDeclaration): void {
		if (span === undefined) return;
		const leading = this.context.typeReader.leadingType(span);
		if (declaration.typeText === undefined) Object.assign(declaration, this.context.typeReader.typeFacts(leading));
		if (this.context.outline) return;
		// Explicit interface qualifier.
		const qualifier =
			leading === undefined ? undefined : this.context.typeReader.typeShape(leading.shape.end, span.end);
		const elementNames = new Set([...(leading?.shape.elementNames ?? []), ...(qualifier?.elementNames ?? [])]);
		for (let current = span.start; current < span.end; current++) {
			const item = this.context.tokenStream.token(current);
			if (!isIdentifier(item) || MODIFIERS.has(syntaxValue(item) as string)) continue;
			if (elementNames.has(current)) this.ignore(item.startOffset);
			else this.markTypeToken(current);
		}
	}

	public declarations(): readonly RawDeclaration[] {
		return this.rawDeclarationsValue;
	}

	public imports(): readonly CsharpImport[] {
		return this.rawImportsValue;
	}

	public importScope(directive: CsharpImport): RawDeclaration | undefined {
		return this.importScopes.get(directive);
	}

	public addImport(directive: CsharpImport, scope: RawDeclaration | undefined): void {
		this.rawImportsValue.push(directive);
		if (scope !== undefined) this.importScopes.set(directive, scope);
	}

	public markTypeToken(index: number): void {
		this.typeTokenIndices.add(index);
	}

	public hasTypeToken(index: number): boolean {
		return this.typeTokenIndices.has(index);
	}

	public markRole(offset: number, role: Reference["role"]): void {
		this.roleByOffset.set(offset, role);
	}

	public roleAt(offset: number): Reference["role"] | undefined {
		return this.roleByOffset.get(offset);
	}

	public ignore(offset: number): void {
		this.ignoredOffsets.add(offset);
	}

	public isIgnored(offset: number): boolean {
		return this.ignoredOffsets.has(offset);
	}

	public markNamespaceName(name: string): void {
		this.namespaceNames.add(name);
	}

	public namespaceNamesSnapshot(): string[] {
		return [...this.namespaceNames];
	}

	public markAttributeName(name: string): void {
		this.attributeNames.add(name);
	}

	public attributeNamesSnapshot(): Set<string> {
		return new Set(this.attributeNames);
	}

	public markBaseListName(name: string): void {
		this.baseListNames.add(name);
	}

	public baseListNamesSnapshot(): Set<string> {
		return new Set(this.baseListNames);
	}

	public addAccessorBodyRange(range: { start: number; end: number }): void {
		this.accessorBodyRanges.push(range);
	}

	public accessorBodyRangesSnapshot(): readonly { start: number; end: number }[] {
		return this.accessorBodyRanges;
	}

	public markSkippedFileScope(): void {
		this.skippedFileScope = true;
	}

	public hasSkippedFileScope(): boolean {
		return this.skippedFileScope;
	}

	public addDeclaration(input: RawDeclarationInput): RawDeclaration {
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
		this.rawDeclarationsValue.push(raw);
		return raw;
	}

	public pathFor(raw: RawDeclaration, cache: Map<RawDeclaration, string>): string {
		const cached = cache.get(raw);
		if (cached !== undefined) return cached;
		const id =
			raw.localOrdinal === undefined
				? composeSymbolId({
						language: LANGUAGE,
						module: this.context.module,
						descriptors: this.descriptorPath(raw, cache),
					})
				: composeSymbolId({
						language: LANGUAGE,
						module: this.context.module,
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
						this.rawDeclarationsValue.find(
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

	public namespaceName(raw: RawDeclaration | undefined): string {
		const names: string[] = [];
		let current = raw;
		while (current !== undefined) {
			if (current.kind === "namespace") names.unshift(current.name);
			current = current.parent;
		}
		return names.join(".");
	}

	/** The types around a declaration, each with its type parameters, by `segmentKey`. */
	public typePath(raw: RawDeclaration | undefined, arity: ReadonlyMap<RawDeclaration, number>): string {
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
