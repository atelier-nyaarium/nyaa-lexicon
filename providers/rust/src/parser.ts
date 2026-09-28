import { defined } from "@nyaa-lexicon/protocol";
import { type ParseContext, sanitizeDisambiguator } from "./declarations.js";
import { BODY, LeafItems } from "./leafItems.js";
import type { ParsedFile, RawDeclaration, RawReference, RustDescriptor } from "./model.js";
import type { Prefix } from "./prefixes.js";
import { scanReferences } from "./references.js";
import { isKeyword, isNameToken, isValueToken, type RustToken } from "./tokens.js";

////////////////////////////////
//  Constants

const FUNCTION_PARAMETERS = new Set(["(", "{", ";"]);

////////////////////////////////
//  Functions & Helpers

/** Tokens as written, comments dropped. */
function spellingOfTokens(tokens: RustToken[], start: number, end: number): string {
	return tokens
		.slice(start, end)
		.map((token) => token.raw)
		.join("");
}

export function indexDeclarations(
	declarations: readonly RawDeclaration[],
): Pick<ParsedFile, "byName" | "byId" | "locals" | "impls"> {
	const byName = new Map<string, RawDeclaration[]>();
	const locals = new Map<string, RawDeclaration[]>();
	const byId = new Map<string, RawDeclaration>();
	const impls: RawDeclaration[] = [];
	for (const raw of declarations) {
		const index = raw.scope === undefined ? byName : locals;
		const named = index.get(raw.declaration.name);
		if (named === undefined) index.set(raw.declaration.name, [raw]);
		else named.push(raw);
		byId.set(raw.declaration.symbolId, raw);
		if (raw.declaration.languageKind === "impl") impls.push(raw);
	}
	for (const named of locals.values())
		named.sort((left, right) => (left.scope?.start ?? 0) - (right.scope?.start ?? 0));
	return { byName, byId, locals, impls };
}

/** The first reference at each offset. */
function indexReferences(references: readonly RawReference[]): Map<number, RawReference> {
	const byOffset = new Map<number, RawReference>();
	for (const raw of references) if (!byOffset.has(raw.token.startOffset)) byOffset.set(raw.token.startOffset, raw);
	return byOffset;
}

////////////////////////////////
//  Classes

/** Items that hold items or bodies, and the walks over a file's items and a body's statements. */
export class RustParser extends LeafItems {
	private readonly rawReferences: RawReference[] = [];
	private readonly implTraitTokens = new Set<number>();
	private readonly implTypeTokens = new Set<number>();
	/** Contextual keywords read as keywords. */
	private readonly keywordTokens = new Set<number>();

	parse(): ParsedFile {
		this.parseItems(0, this.tokens.length, { descriptors: [], kind: "root" });
		for (const raw of this.rawDeclarations) {
			const name =
				raw.declaration.languageKind === "impl" && raw.valueType !== undefined
					? this.importedName(raw.valueType, raw.declaration.containerId)
					: undefined;
			if (name !== undefined) raw.targetName = name;
		}
		const declarations = this.rawDeclarations.map((raw) => raw.declaration);
		const { references, literals } =
			this.depth === "outline"
				? { references: [], literals: [] }
				: scanReferences({
						tokens: this.tokens,
						rawDeclarations: this.rawDeclarations,
						rawReferences: this.rawReferences,
						importBindings: this.importBindings,
						ignoredRanges: this.ignoredRanges,
						attributeTokens: this.attributeTokens,
						useRanges: this.useRanges,
						declarationNameTokens: this.declarationNameTokens,
						implTraitTokens: this.implTraitTokens,
						implTypeTokens: this.implTypeTokens,
						keywordTokens: this.keywordTokens,
						bindingSites: this.bindingSites,
						labels: this.brackets.labels,
						angleDeltas: this.brackets.deltas,
					});
		return {
			module: this.module,
			text: this.text,
			declarations,
			references,
			imports: this.imports,
			literals,
			comments: this.depth === "outline" ? [] : this.scan.comments,
			...(this.depth === "outline" ? {} : { blankLines: this.scan.blankLines }),
			diagnostics: this.diagnostics(),
			rawDeclarations: this.rawDeclarations,
			...indexDeclarations(this.rawDeclarations),
			rawReferences: this.depth === "outline" ? [] : this.rawReferences,
			referenceAt: this.depth === "outline" ? new Map() : indexReferences(this.rawReferences),
			importBindings: this.importBindings,
			typeAnswers: this.depth === "outline" ? new Map() : this.typeAnswers,
		};
	}

	////////////////////////////////
	//  Items

	private parseItems(start: number, end: number, context: ParseContext): void {
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("item parser failed to advance");
			guard = index;
			const attributed = this.skipAttributes(index, end);
			if (attributed !== index) {
				index = attributed;
				continue;
			}
			index = this.parseItem(index, end, context) ?? this.past(index);
		}
	}

	/** Past the item at `start`, or undefined when none starts there. */
	private parseItem(start: number, end: number, context: ParseContext): number | undefined {
		const prefix = this.prefix(start, end);
		if (prefix.index >= end) return undefined;
		const next = this.dispatchItem(prefix.index, end, prefix, context);
		if (next !== undefined) for (const word of prefix.words) this.keywordTokens.add(word);
		return next;
	}

	private dispatchItem(index: number, end: number, prefix: Prefix, context: ParseContext): number | undefined {
		const token = this.tokens[index] as RustToken;
		const following = this.tokens[index + 1];
		const named = isNameToken(following) && !isKeyword(following);
		if (prefix.modifiers.has("extern")) {
			if (isValueToken(token, "crate")) return this.parseExternCrate(index, end, prefix, context);
			if (isValueToken(token, "{")) return this.parseForeignItems(index, end, context);
		}
		if (token.kind !== "identifier" || token.raw !== token.value) return undefined;
		switch (token.value) {
			case "use":
				return this.parseUse(index, end, prefix, context);
			case "impl":
				return this.parseImpl(index, end, prefix, context);
			case "fn":
				return named ? this.parseFunction(index, end, prefix, context) : undefined;
			case "struct":
				return named ? this.parseStruct(index, end, prefix, context) : undefined;
			case "union":
				if (!named) return undefined;
				this.keywordTokens.add(index);
				return this.parseStruct(index, end, prefix, context, "union");
			case "enum":
				return named ? this.parseEnum(index, end, prefix, context) : undefined;
			case "trait":
				return named ? this.parseTrait(index, end, prefix, context) : undefined;
			case "mod":
				return named ? this.parseModule(index, end, prefix, context) : undefined;
			case "type":
				return named ? this.parseTypeAlias(index, end, prefix, context) : undefined;
			case "const":
				return named ? this.parseConstant(index, end, prefix, context) : undefined;
			case "static": {
				const name = isValueToken(following, "mut") ? this.tokens[index + 2] : following;
				return isNameToken(name) && !isKeyword(name)
					? this.parseConstant(index, end, prefix, context)
					: undefined;
			}
			case "macro_rules":
				return isValueToken(following, "!") && isNameToken(this.tokens[index + 2])
					? this.parseMacroRules(index, end, prefix, context)
					: undefined;
			default:
				return undefined;
		}
	}

	private parseFunction(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const nameIndex = start + 1;
		const nameToken = this.tokens[nameIndex] as RustToken;
		const open = this.topLevelStop(nameIndex + 1, end, FUNCTION_PARAMETERS);
		if (!isValueToken(this.tokens[open], "(")) {
			this.addDiagnostic("function has no parameter list", nameToken);
			return this.statementEnd(start, end) + 1;
		}
		const close = this.matchingIndex(open);
		if (close < 0) {
			this.addDiagnostic("function parameter list is not closed", this.tokens[open]);
			return end;
		}
		const stop = this.topLevelStop(close + 1, end, BODY);
		const bodyEnd = isValueToken(this.tokens[stop], "{") ? this.matchingIndex(stop) : -1;
		const semicolon = isValueToken(this.tokens[stop], ";") ? stop : -1;
		const endIndex = bodyEnd >= 0 ? bodyEnd : semicolon >= 0 ? semicolon : close;
		const endToken = this.tokens[endIndex] as RustToken;
		if (bodyEnd < 0 && semicolon < 0) this.addDiagnostic("function has no body or semicolon", endToken);
		const outline = this.depth === "outline";
		const returnInfo = outline ? undefined : this.returnType(close + 1, stop);
		const parameters = outline ? "" : this.parameterTypes(open + 1, close).join(", ");
		const raw = this.addRawDeclaration({
			nameIndex,
			start: prefix.start,
			end: endToken,
			context,
			descriptor: this.methodDescriptor(context, nameToken.value),
			generics: this.genericsOf(nameIndex + 1, stop),
			kind: context.kind === "impl" || context.kind === "trait" ? "method" : "function",
			languageKind:
				context.kind === "trait"
					? "traitMethod"
					: context.kind === "impl" && context.implTrait !== undefined
						? "traitImplMethod"
						: "fn",
			visibility: prefix.visibility,
			exported: prefix.exported,
			signature: this.headers.render(prefix.headerStart, stop < end ? stop : close + 1),
			...(outline
				? {}
				: {
						typeDisplay:
							returnInfo === undefined
								? `fn(${parameters})`
								: `fn(${parameters}) -> ${returnInfo.display}`,
						typeName: returnInfo?.typeName,
						valueType: returnInfo?.path,
						metrics: {
							lines: endToken.end.line - prefix.start.start.line + 1,
							parameters: this.parameterCount(open + 1, close),
							...(bodyEnd < 0 ? {} : this.bodyMetrics(stop + 1, bodyEnd)),
						},
					}),
		});
		if (!outline) this.parseParameters(open + 1, close, raw);
		if (bodyEnd >= 0) this.parseBody(stop + 1, bodyEnd, raw);
		return endIndex + 1;
	}

	private parseTrait(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const name = this.tokens[start + 1] as RustToken;
		const bodyOpen = this.topLevelStop(start + 2, end, BODY);
		const braced = isValueToken(this.tokens[bodyOpen], "{");
		const bodyEnd = braced ? this.matchingIndex(bodyOpen) : -1;
		const endIndex = bodyEnd >= 0 ? bodyEnd : this.statementEnd(start, end);
		const raw = this.addRawDeclaration({
			nameIndex: start + 1,
			start: prefix.start,
			end: this.tokens[endIndex] ?? name,
			context,
			descriptor: { kind: "type", name: name.value },
			generics: this.genericsOf(start + 2, bodyOpen),
			kind: "interface",
			languageKind: "trait",
			visibility: prefix.visibility,
			exported: prefix.exported,
			signature: this.itemHeader(prefix, braced ? bodyOpen : -1, end),
			memberInsertLine: bodyEnd >= 0 ? this.memberInsertLine(bodyOpen, bodyEnd, false) : undefined,
		});
		if (bodyEnd >= 0) this.parseItems(bodyOpen + 1, bodyEnd, this.within(raw, "trait"));
		return endIndex + 1;
	}

	/** An impl block: a container for its items, which keep ids under the type it implements. */
	private parseImpl(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const bodyOpen = this.topLevelStop(start + 1, end, BODY);
		const bodyEnd = isValueToken(this.tokens[bodyOpen], "{") ? this.matchingIndex(bodyOpen) : -1;
		if (bodyEnd < 0) {
			this.addDiagnostic("impl block has no body", this.tokens[start]);
			return this.statementEnd(start, end) + 1;
		}
		const traitStart = this.pastGenerics(start + 1, bodyOpen);
		const whereIndex = this.topLevelToken(traitStart, bodyOpen, "where");
		const headerEnd = whereIndex >= 0 ? whereIndex : bodyOpen;
		const forIndex = this.implFor(traitStart, headerEnd);
		const typeStart = forIndex >= 0 ? forIndex + 1 : traitStart;
		const written = this.typePath(typeStart, headerEnd);
		if (written === undefined) {
			this.addDiagnostic("impl block has no target type", this.tokens[start]);
			return bodyEnd + 1;
		}
		const targetIndex = written.last;
		const target = this.tokens[targetIndex] as RustToken;
		const traitName = forIndex >= 0 ? spellingOfTokens(this.tokens, traitStart, forIndex) : undefined;
		for (let index = traitStart; index < forIndex; index++) this.implTraitTokens.add(index);
		this.implTypeTokens.add(targetIndex);
		const typeText = this.headers.render(typeStart, headerEnd) ?? target.value;
		const traitText = forIndex >= 0 ? this.headers.render(traitStart, forIndex) : undefined;
		const descriptor: RustDescriptor = {
			kind: "meta",
			name: target.value,
			disambiguator: traitName === undefined ? "impl" : `impl-${sanitizeDisambiguator(traitName)}`,
		};
		const names = this.pathNames(written.first, written.last);
		const generics = this.genericsOf(start + 1, bodyOpen);
		// A generic target is no type: its items hang from the impl.
		const generic = names.length === 1 && generics?.has(names[0] as string) === true;
		// A type declared later, or elsewhere, hangs from the scope by its name.
		const targetPath = generic
			? undefined
			: (this.resolveTypePath(names, context.descriptors, context) ?? [
					...context.descriptors,
					{ kind: "type", name: target.value },
				]);
		const raw = this.addRawDeclaration({
			nameIndex: targetIndex,
			label: traitText === undefined ? `impl ${typeText}` : `impl ${traitText} for ${typeText}`,
			start: prefix.start,
			end: this.tokens[bodyEnd] as RustToken,
			context,
			descriptor,
			memberPath: targetPath,
			valueType: names,
			generics,
			typeSpan: { start: typeStart, end: headerEnd },
			kind: "namespace",
			languageKind: "impl",
			visibility: "public",
			exported: false,
			signature: this.itemHeader(prefix, bodyOpen, end),
			memberInsertLine: this.memberInsertLine(bodyOpen, bodyEnd, false),
		});
		raw.memberPath ??= raw.descriptorPath;
		this.parseItems(bodyOpen + 1, bodyEnd, {
			...this.within(raw, "impl", raw.memberPath),
			...defined({ implTrait: traitName }),
		});
		return bodyEnd + 1;
	}

	private parseModule(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const name = this.tokens[start + 1] as RustToken;
		const next = this.topLevelStop(start + 2, end, BODY);
		const bodyEnd = isValueToken(this.tokens[next], "{") ? this.matchingIndex(next) : -1;
		const endIndex = bodyEnd >= 0 ? bodyEnd : Math.min(next, end - 1);
		const raw = this.addRawDeclaration({
			nameIndex: start + 1,
			start: prefix.start,
			end: this.tokens[endIndex] ?? name,
			context,
			descriptor: { kind: "namespace", name: name.value },
			kind: "module",
			languageKind: "module",
			visibility: prefix.visibility,
			exported: prefix.exported,
			signature: this.itemHeader(prefix, bodyEnd >= 0 ? next : -1, end),
			memberInsertLine: bodyEnd >= 0 ? this.memberInsertLine(next, bodyEnd, false) : undefined,
			fileModule: bodyEnd >= 0 ? undefined : defined({ path: this.pathAttribute(prefix.headerStart, start) }),
		});
		if (bodyEnd >= 0) this.parseItems(next + 1, bodyEnd, this.within(raw, "module"));
		return endIndex + 1;
	}

	private parseConstant(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const keyword = this.tokens[start] as RustToken;
		const nameIndex = isValueToken(this.tokens[start + 1], "mut") ? start + 2 : start + 1;
		const name = this.tokens[nameIndex] as RustToken;
		const endIndex = this.statementEnd(start, end);
		const colon = this.topLevelToken(nameIndex + 1, endIndex, ":");
		const equal = this.topLevelToken(nameIndex + 1, endIndex, "=");
		const typeEnd = equal >= 0 ? equal : endIndex;
		const typed = this.depth !== "outline" && colon >= 0;
		const raw = this.addRawDeclaration({
			nameIndex,
			start: prefix.start,
			end: this.tokens[endIndex] ?? name,
			context,
			descriptor: { kind: "term", name: name.value },
			kind: "constant",
			languageKind: keyword.value === "static" ? "static" : "const",
			visibility: prefix.visibility,
			exported: prefix.exported,
			signature: this.headers.render(prefix.headerStart, endIndex, equal >= 0 ? equal + 1 : undefined),
			...(typed
				? {
						typeDisplay: this.textOfTokens(colon + 1, typeEnd),
						typeName: this.simpleTypeName(colon + 1, typeEnd),
						typeSpan: { start: colon + 1, end: typeEnd },
					}
				: {}),
		});
		if (this.depth !== "outline" && equal >= 0 && colon < 0) {
			const inferred = this.literalInitializer(equal + 1, endIndex);
			if (inferred !== undefined)
				this.typeAnswers.set(raw.declaration.symbolId, {
					status: "inferred",
					display: inferred.display,
					basis: inferred.basis,
				});
		}
		if (equal >= 0) this.parseBody(equal + 1, endIndex, raw);
		return endIndex + 1;
	}

	private parseForeignItems(start: number, end: number, context: ParseContext): number {
		const close = this.matchingIndex(start);
		if (close < 0 || close >= end) return start + 1;
		this.parseItems(start + 1, close, context);
		return close + 1;
	}

	////////////////////////////////
	//  Bodies

	/** Items in a body, and in a full parse its pattern bindings and closure parameters, each local to `owner`. */
	private parseBody(start: number, end: number, owner: RawDeclaration): void {
		const context = this.within(owner, "function");
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("body parser failed to advance");
			guard = index;
			const attributed = this.skipAttributes(index, end);
			if (attributed !== index) {
				index = attributed;
				continue;
			}
			if (this.startsStatement(index, start)) {
				const declared = this.rawDeclarations.length;
				const imported = this.importBindings.length;
				const next = this.parseItem(index, end, context);
				if (next !== undefined) {
					this.confineToBlock(index, owner, declared, imported);
					index = next;
					continue;
				}
			}
			index = this.depth === "outline" ? index + 1 : this.bodyToken(index, end, owner);
		}
	}
}

////////////////////////////////
//  Functions & Helpers

export function parseRustFile(module: string, text: string, depth: "full" | "outline" = "full"): ParsedFile {
	return new RustParser(module, text, depth).parse();
}
