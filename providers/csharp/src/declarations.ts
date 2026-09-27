// Declarations by recursive descent: namespaces, types, members, attributes and locals.

import {
	composeSymbolId,
	type Descriptor,
	defined,
	type ImportedName,
	qualifierDescriptors,
	type Reference,
	type SymbolKind,
} from "@nyaa-lexicon/protocol";
import {
	type AnglePairs,
	type AttributeSection,
	type Boundary,
	type CsharpImport,
	LANGUAGE,
	type Leading,
	type ModifierInfo,
	positionKey,
	type RawDeclaration,
	type RawDeclarationInput,
	type TypeSpan,
	type Visibility,
} from "./model.js";
import { positionRange, type Token } from "./tokens.js";
import { CsharpTypeReader } from "./typeReader.js";
import {
	ACCESSOR_KEYWORDS,
	CONSTRAINT_KEYWORDS,
	isIdentifier,
	isTrivia,
	MODIFIERS,
	SKIPPED_WORDS,
	syntaxValue,
} from "./words.js";

////////////////////////////////
//  Functions & Helpers

function isTypeDeclarationWord(value: string): boolean {
	return value === "class" || value === "interface" || value === "struct" || value === "enum" || value === "record";
}

function visibilityFor(modifiers: Set<string>, parent: RawDeclaration | undefined, kind: SymbolKind): Visibility {
	if (modifiers.has("public")) return "public";
	if (modifiers.has("protected")) return "protected";
	if (modifiers.has("private")) return "private";
	if (modifiers.has("internal")) return "internal";
	if (modifiers.has("file")) return "fileLocal";
	if (kind === "namespace") return "public";
	if (parent === undefined) return "internal";
	if (parent.kind === "namespace") return "internal";
	if (parent.languageKind === "interface" || parent.kind === "interface") return "public";
	if (parent.kind === "enum") return "public";
	if (kind === "constructor" && parent.kind === "struct") return "public";
	if (kind === "typeParameter" || kind === "variable") return "local";
	return "private";
}

function exportedFor(visibility: Visibility, parent: RawDeclaration | undefined): boolean {
	if (visibility !== "public" && visibility !== "internal") return false;
	if (parent === undefined) return true;
	return parent.exported;
}

function joinTokenValues(tokens: Token[]): string {
	return tokens.map((token) => token.value).join(".");
}

function displayForLiteral(token: Token): string | undefined {
	if (token.kind === "string") return "string";
	if (token.kind === "boolean") return "bool";
	if (token.kind !== "number") return undefined;
	const raw = token.value.toLowerCase();
	// Hex digits read as suffixes and exponents.
	if (raw.startsWith("0x") || raw.startsWith("0b")) return "int";
	if (raw.endsWith("m")) return "decimal";
	if (raw.endsWith("f")) return "float";
	if (raw.includes(".") || raw.includes("e")) return "double";
	return "int";
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

function earliest(left: Token | undefined, right: Token | undefined): Token | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return left.startOffset <= right.startOffset ? left : right;
}

////////////////////////////////
//  Classes

export class CsharpDeclarationParser extends CsharpTypeReader {
	protected readonly rawDeclarations: RawDeclaration[] = [];

	protected readonly rawImports: CsharpImport[] = [];

	protected readonly typeTokenIndices = new Set<number>();

	protected readonly roleByOffset = new Map<number, Reference["role"]>();

	protected readonly ignoredOffsets = new Set<number>();

	protected readonly namespaceNames = new Set<string>();

	protected readonly attributeNames = new Set<string>();

	protected readonly accessorBodyRanges: Array<{ start: number; end: number }> = [];

	private readonly scopeCounts = new Map<RawDeclaration | undefined, Map<string, number>>();

	protected skippedFileScope = false;

	private localOrdinal = 0;

	protected parseScope(start: number, end: number, parent: RawDeclaration | undefined): void {
		let index = start;
		let documentationStart: Token | undefined;
		let attributes: number | undefined;
		let lastDocumentationLine = -2;
		while (index < end) {
			const current = this.token(index);
			if (current === undefined) return;
			if (current.kind === "doc") {
				if (current.start.line !== lastDocumentationLine + 1) documentationStart = undefined;
				documentationStart ??= current;
				lastDocumentationLine = current.start.line;
				index++;
				continue;
			}
			if (current.kind === "newline") {
				index++;
				continue;
			}
			if (current.kind === "comment" || current.kind === "directive") {
				documentationStart = undefined;
				index++;
				continue;
			}
			if (syntaxValue(current) === "}") return;
			if (syntaxValue(current) === ";") {
				documentationStart = undefined;
				index++;
				continue;
			}
			const section = this.attributeSectionAt(index, end);
			if (section !== undefined) {
				if (section.close < 0) return;
				if (section.attached) attributes ??= section.open;
				index = section.close + 1;
				continue;
			}
			const leadingStart = earliest(
				documentationStart,
				attributes === undefined ? undefined : this.token(attributes),
			);
			const parsed = this.parseAt(
				index,
				end,
				parent,
				leadingStart === undefined ? undefined : { start: leadingStart, attributes },
			);
			if (parsed <= index) {
				if (parent === undefined) this.skippedFileScope = true;
				index = this.skipUnknown(index, end);
			} else {
				index = parsed;
			}
			documentationStart = undefined;
			attributes = undefined;
			lastDocumentationLine = -2;
		}
	}

	/** One `[...]` section at `index`; `close` is -1 when it never closes. */
	protected attributeSectionAt(index: number, end: number): AttributeSection | undefined {
		const open = this.nextSignificant(index, end);
		if (open < 0 || this.value(open) !== "[") return undefined;
		const close = this.matching(open, "[", "]", end);
		if (close < 0) {
			this.report("Attribute list is not closed.", this.token(open));
			return { open, close, attached: false };
		}
		let cursor = this.nextSignificant(open + 1, close);
		let attached = true;
		const target = this.token(cursor);
		if (isIdentifier(target)) {
			const colon = this.nextSignificant(cursor + 1, close);
			if (this.value(colon) === ":") {
				this.ignoredOffsets.add(target.startOffset);
				attached = target.value !== "assembly" && target.value !== "module";
				cursor = this.nextSignificant(colon + 1, close);
			}
		}
		while (cursor >= 0 && cursor < close) {
			const name = this.attributeName(cursor, close);
			this.addTypeReference(cursor, name.end - 1, "typeUse");
			if (name.token !== undefined) this.attributeNames.add(positionKey(name.token.start));
			let next = name.end;
			if (this.value(next) === "(") {
				const argumentsClose = this.matching(next, "(", ")", close);
				next = argumentsClose < 0 ? close : argumentsClose + 1;
			}
			if (this.value(next) === ",") next++;
			cursor = this.nextSignificant(Math.max(next, cursor + 1), close);
		}
		return { open, close, attached };
	}

	/** Where the name span ends, and its type identifier. */
	private attributeName(start: number, close: number): { end: number; token: Token | undefined } {
		let cursor = start;
		let token: Token | undefined;
		while (cursor >= 0 && cursor < close) {
			const item = this.token(cursor);
			const value = syntaxValue(item);
			if (value === "<") {
				const angleClose = this.listClose(cursor, close);
				cursor = angleClose < 0 ? close : angleClose + 1;
				break;
			}
			if (isIdentifier(item)) token = item;
			else if (value !== "." && value !== "::") break;
			cursor = this.nextSignificant(cursor + 1, close);
		}
		return { end: cursor < 0 ? close : cursor, token };
	}

	/** Marks every section at `index`; answers where the last ends. */
	private afterAttributeSections(index: number, end: number): number {
		let current = index;
		for (;;) {
			const section = this.attributeSectionAt(current, end);
			if (section === undefined || section.close < 0) return current;
			current = section.close + 1;
		}
	}

	/** Marks every `[...]` section without declaring anything. */
	private walkAttributeSections(start: number, end: number): void {
		let current = this.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const section = this.attributeSectionAt(current, end);
			if (section !== undefined) {
				current = section.close < 0 ? end : this.nextSignificant(section.close + 1, end);
				continue;
			}
			current = this.nextSignificant(current + 1, end);
		}
	}

	/** An accessor's attribute belongs to its property, indexer or event; its own body is skipped. */
	private parseAccessorAttributes(start: number, end: number): void {
		let current = this.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const section = this.attributeSectionAt(current, end);
			if (section !== undefined) {
				current = section.close < 0 ? end : this.nextSignificant(section.close + 1, end);
				continue;
			}
			const item = this.token(current);
			if (isIdentifier(item) && MODIFIERS.has(item.value)) {
				current = this.nextSignificant(current + 1, end);
				continue;
			}
			if (isIdentifier(item) && ACCESSOR_KEYWORDS.has(item.value)) {
				const next = this.nextSignificant(current + 1, end);
				const nextValue = this.value(next);
				if (nextValue === "{") {
					const close = this.matching(next, "{", "}", end);
					const openToken = this.token(next);
					const closeToken = close < 0 ? undefined : this.token(close);
					if (openToken !== undefined && closeToken !== undefined)
						this.accessorBodyRanges.push({ start: openToken.endOffset, end: closeToken.startOffset });
					current = this.nextSignificant(close < 0 ? end : close + 1, end);
				} else if (nextValue === "=>") {
					const semicolon = this.findSemicolon(next + 1, end);
					current = this.nextSignificant(semicolon < 0 ? end : semicolon + 1, end);
				} else {
					current = this.nextSignificant(next, end);
				}
				continue;
			}
			current = this.nextSignificant(current + 1, end);
		}
	}

	private modifiersAt(index: number, end: number): ModifierInfo {
		const start = index;
		const modifiers = new Set<string>();
		let current = this.nextSignificant(index, end);
		while (current >= 0 && current < end) {
			const item = this.token(current);
			if (item === undefined || item.kind !== "identifier" || !MODIFIERS.has(item.value)) break;
			modifiers.add(item.value);
			current = this.nextSignificant(current + 1, end);
		}
		return { index: current < 0 ? end : current, start, modifiers };
	}

	private parseAt(
		index: number,
		end: number,
		parent: RawDeclaration | undefined,
		leading: Leading | undefined,
	): number {
		const first = this.nextSignificant(index, end);
		if (first < 0) return end;
		const item = this.token(first);
		if (item === undefined) return end;
		if (syntaxValue(item) === "global" && this.value(this.nextSignificant(first + 1, end)) === "using") {
			return this.parseUsing(first + 1, end, true);
		}
		if (syntaxValue(item) === "using") return this.parseUsing(first, end, false);
		if (syntaxValue(item) === "namespace") return this.parseNamespace(first, first, end, parent, leading);
		const modifiers = this.modifiersAt(first, end);
		const keyword = this.value(modifiers.index);
		if (keyword === "namespace") return this.parseNamespace(modifiers.index, modifiers.start, end, parent, leading);
		if (keyword !== undefined && isTypeDeclarationWord(keyword)) {
			return this.parseType(modifiers.index, modifiers.start, end, parent, leading, modifiers.modifiers);
		}
		if (keyword === "delegate")
			return this.parseDelegate(modifiers.index, modifiers.start, end, parent, leading, modifiers.modifiers);
		if (parent?.kind === "class" || parent?.kind === "struct" || parent?.kind === "interface") {
			return this.parseMember(first, modifiers, end, parent, leading);
		}
		return -1;
	}

	private parseUsing(index: number, end: number, global: boolean): number {
		const usingToken = this.token(index);
		if (usingToken === undefined) return -1;
		let current = this.nextSignificant(index + 1, end);
		let isStatic = false;
		if (this.value(current) === "static") {
			isStatic = true;
			current = this.nextSignificant(current + 1, end);
		}
		const statementEnd = this.findSemicolon(current, end);
		if (statementEnd < 0) {
			this.report("Using directive has no terminating semicolon.", usingToken);
			return end;
		}
		const significant: number[] = [];
		for (let cursor = current; cursor < statementEnd; cursor++) {
			if (!isTrivia(this.token(cursor))) significant.push(cursor);
		}
		if (significant.length === 0) return statementEnd + 1;
		let aliasIndex = -1;
		for (const candidate of significant) {
			if (this.value(candidate) === "=") {
				aliasIndex = candidate;
				break;
			}
		}
		const pathIndices = aliasIndex < 0 ? significant : significant.filter((candidate) => candidate > aliasIndex);
		const names = pathIndices
			.map((candidate) => this.token(candidate))
			.filter((candidate): candidate is Token => candidate?.kind === "identifier");
		if (names.length === 0) {
			this.report("Using directive has no namespace.", usingToken);
			return statementEnd + 1;
		}
		const specifier = joinTokenValues(names);
		const firstName = names[0] as Token;
		const lastName = names[names.length - 1] as Token;
		const statementRange = { start: usingToken.start, end: this.token(statementEnd)?.end ?? lastName.end };
		const specifierRange = { start: firstName.start, end: lastName.end };
		let alias: string | undefined;
		let imported: ImportedName[] = [];
		if (aliasIndex >= 0) {
			const aliasToken = this.token(significant[0] as number);
			if (aliasToken?.kind === "identifier") {
				alias = aliasToken.value;
				imported = [{ local: alias, localRange: positionRange(aliasToken) }];
			}
		}
		this.rawImports.push({
			specifier,
			imported,
			reExport: false,
			...defined({ alias }),
			static: isStatic,
			range: statementRange,
			specifierRange,
		});
		for (const candidate of pathIndices) {
			const pathToken = this.token(candidate);
			if (pathToken?.kind === "identifier") this.ignoredOffsets.add(pathToken.startOffset);
		}
		if (!global) {
			for (const candidate of significant) {
				const pathToken = this.token(candidate);
				if (pathToken?.kind === "identifier") this.ignoredOffsets.add(pathToken.startOffset);
			}
		}
		return statementEnd + 1;
	}

	private parseNamespace(
		keywordIndex: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration | undefined,
		leading: Leading | undefined,
	): number {
		const keyword = this.token(keywordIndex);
		if (keyword === undefined) return -1;
		const names: Token[] = [];
		let current = this.nextSignificant(keywordIndex + 1, end);
		while (current >= 0 && current < end) {
			const item = this.token(current);
			if (item?.kind === "identifier") {
				names.push(item);
				current = this.nextSignificant(current + 1, end);
				if (this.value(current) === ".") {
					current = this.nextSignificant(current + 1, end);
					continue;
				}
				break;
			}
			break;
		}
		if (names.length === 0) {
			this.report("Namespace declaration needs a name.", keyword);
			return -1;
		}
		const namespaceName = joinTokenValues(names);
		const parentNamespace = this.namespaceName(parent);
		const fullName = parentNamespace === "" ? namespaceName : `${parentNamespace}.${namespaceName}`;
		const next = this.nextSignificant(current, end);
		const nameStart = names[0] as Token;
		const nameEnd = names[names.length - 1] as Token;
		for (const item of names) this.ignoredOffsets.add(item.startOffset);
		if (this.value(next) === ";") {
			const namespace = this.addDeclaration({
				kind: "namespace",
				languageKind: "fileScopedNamespace",
				name: namespaceName,
				parent,
				startToken: leading?.start ?? this.token(codeStartIndex) ?? keyword,
				endToken: this.tokens[this.tokens.length - 1] as Token,
				selectionStart: nameStart,
				selectionEnd: nameEnd,
				codeStart: this.token(codeStartIndex) ?? keyword,
				visibility: "public",
				exported: true,
				signature: this.header(codeStartIndex, next),
				memberInsertLine: this.lineAfterLast(next, end),
				nameTokenOffsets: names.map((item) => item.startOffset),
			});
			this.namespaceNames.add(fullName);
			this.parseScope(next + 1, end, namespace);
			return end;
		}
		if (this.value(next) !== "{") {
			this.report("Namespace declaration needs a body or semicolon.", this.token(next) ?? keyword);
			return -1;
		}
		const close = this.matching(next, "{", "}", end);
		if (close < 0) this.report("Namespace body is not closed.", this.token(next));
		const bodyEnd = close < 0 ? end : close;
		const namespace = this.addDeclaration({
			kind: "namespace",
			languageKind: "blockNamespace",
			name: namespaceName,
			parent,
			startToken: leading?.start ?? this.token(codeStartIndex) ?? keyword,
			endToken: this.token(close >= 0 ? close : bodyEnd - 1) ?? keyword,
			selectionStart: nameStart,
			selectionEnd: nameEnd,
			codeStart: this.token(codeStartIndex) ?? keyword,
			visibility: "public",
			exported: true,
			signature: this.header(codeStartIndex, next),
			memberInsertLine: this.closerLine(close),
			nameTokenOffsets: names.map((item) => item.startOffset),
		});
		this.namespaceNames.add(fullName);
		this.parseScope(next + 1, bodyEnd, namespace);
		return close < 0 ? end : close + 1;
	}

	private parseType(
		keywordIndex: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration | undefined,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const firstKeyword = this.token(keywordIndex);
		if (firstKeyword === undefined) return -1;
		let kindWord = firstKeyword.value;
		let recordFlavor = "";
		let current = keywordIndex + 1;
		if (kindWord === "record") {
			const possibleFlavor = this.nextSignificant(current, end);
			if (this.value(possibleFlavor) === "class" || this.value(possibleFlavor) === "struct") {
				recordFlavor = this.value(possibleFlavor) ?? "";
				kindWord = recordFlavor;
				current = possibleFlavor + 1;
			}
		}
		const nameIndex = this.nextSignificant(current, end);
		const nameToken = this.token(nameIndex);
		if (!isIdentifier(nameToken)) {
			this.report("Type declaration needs a name.", firstKeyword);
			return -1;
		}
		const kind: SymbolKind =
			kindWord === "interface"
				? "interface"
				: kindWord === "struct"
					? "struct"
					: kindWord === "enum"
						? "enum"
						: "class";
		const typeLanguageKind =
			firstKeyword.value === "record" ? (recordFlavor === "struct" ? "recordStruct" : "record") : kindWord;
		let afterName = this.nextSignificant(nameIndex + 1, end);
		let typeParameterOpen = -1;
		let typeParameterClose = -1;
		if (this.value(afterName) === "<") {
			typeParameterOpen = afterName;
			typeParameterClose = this.listClose(afterName, end);
			if (typeParameterClose < 0)
				this.report("Generic type parameter list is not closed.", this.token(afterName));
			afterName = typeParameterClose < 0 ? end : this.nextSignificant(typeParameterClose + 1, end);
		}
		const boundary = this.findTypeBoundary(afterName, end);
		if (boundary === undefined)
			this.report("Type declaration needs a body or semicolon.", this.token(end - 1) ?? nameToken);
		const bodyOpen = boundary?.kind === "body" ? boundary.index : -1;
		const bodyClose = bodyOpen < 0 ? -1 : this.matching(bodyOpen, "{", "}", end);
		if (bodyOpen >= 0 && bodyClose < 0) this.report("Type body is not closed.", this.token(bodyOpen));
		const endToken = this.token(bodyClose >= 0 ? bodyClose : (boundary?.index ?? end - 1)) ?? nameToken;
		const codeEnd = boundary?.index ?? end - 1;
		const type = this.addDeclaration({
			kind,
			languageKind: typeLanguageKind,
			name: nameToken.value,
			parent,
			startToken: leading?.start ?? this.token(codeStartIndex) ?? firstKeyword,
			endToken,
			selectionStart: nameToken,
			selectionEnd: nameToken,
			codeStart: this.token(codeStartIndex) ?? firstKeyword,
			visibility: visibilityFor(modifiers, parent, kind),
			exported: exportedFor(visibilityFor(modifiers, parent, kind), parent),
			isPartial: modifiers.has("partial"),
			signature: this.header(leading?.attributes ?? codeStartIndex, codeEnd),
			bodyStartToken: bodyOpen < 0 ? undefined : this.token(bodyOpen),
			bodyEndToken: bodyClose < 0 ? undefined : this.token(bodyClose),
			memberInsertLine: this.closerLine(bodyClose),
			nameTokenOffsets: [nameToken.startOffset],
		});
		this.markTypeParameters(typeParameterOpen, typeParameterClose, type);
		const primaryOpen = this.value(afterName) === "(" ? afterName : -1;
		const primaryClose = primaryOpen < 0 ? -1 : this.matching(primaryOpen, "(", ")", end);
		if (primaryClose >= 0) type.parameterCount = this.parseParameters(primaryOpen, primaryClose, type);
		if (!this.outline) {
			const headerEnd = bodyOpen >= 0 ? bodyOpen : codeEnd;
			const angles = this.typeAngles(nameIndex, headerEnd);
			this.markBaseTypes(nameIndex, headerEnd, type, angles);
			this.parseTypeConstraints(nameIndex, headerEnd, angles);
		}
		if (bodyOpen >= 0) {
			if (kind === "enum") this.parseEnumMembers(bodyOpen + 1, bodyClose < 0 ? end : bodyClose, type);
			else this.parseScope(bodyOpen + 1, bodyClose < 0 ? end : bodyClose, type);
		}
		if (bodyClose >= 0) return bodyClose + 1;
		return boundary?.kind === "semicolon" ? boundary.index + 1 : end;
	}

	private markTypeParameters(start: number, close: number, parent: RawDeclaration): void {
		if (start < 0 || close < 0) return;
		let current = this.nextSignificant(start + 1, close);
		while (current >= 0 && current < close) {
			const section = this.attributeSectionAt(current, close);
			if (section !== undefined) {
				current = section.close < 0 ? -1 : this.nextSignificant(section.close + 1, close);
				continue;
			}
			const item = this.token(current);
			if (isIdentifier(item) && item.value !== "in" && item.value !== "out") {
				this.ignoredOffsets.add(item.startOffset);
				this.addDeclaration({
					kind: "typeParameter",
					languageKind: "typeParameter",
					name: item.value,
					parent,
					startToken: item,
					endToken: item,
					selectionStart: item,
					selectionEnd: item,
					codeStart: item,
					visibility: "local",
					exported: false,
					nameTokenOffsets: [item.startOffset],
				});
			}
			current = this.nextSignificant(current + 1, close);
			if (this.value(current) === ",") current = this.nextSignificant(current + 1, close);
		}
	}

	/** `angles` from a walk starting at the name. */
	private markBaseTypes(start: number, end: number, parent: RawDeclaration, angles: AnglePairs): void {
		const whereIndex = this.topLevelValue(start + 1, end, "where", angles);
		const bound = whereIndex < 0 ? end : whereIndex;
		const colon = this.topLevelValue(start + 1, bound, ":", angles);
		if (colon < 0) return;
		let segmentRole: Reference["role"] = parent.kind === "struct" ? "implements" : "extends";
		for (const segment of this.commaSegments(colon + 1, bound, angles)) {
			this.addTypeReference(segment.start, segment.end - 1, "typeUse");
			const firstToken = this.token(this.nextSignificant(segment.start, segment.end));
			if (firstToken?.kind === "identifier") this.roleByOffset.set(firstToken.startOffset, segmentRole);
			segmentRole = parent.kind === "interface" ? "extends" : "implements";
		}
	}

	/** A `where` clause's constrained parameter and its bounds are a type use. */
	private parseTypeConstraints(start: number, end: number, angles: AnglePairs = this.typeAngles(start, end)): void {
		let clauseStart = this.topLevelValue(start, end, "where", angles);
		while (clauseStart >= 0 && clauseStart < end) {
			const nameIndex = this.nextSignificant(clauseStart + 1, end);
			const colon = nameIndex < 0 ? -1 : this.nextSignificant(nameIndex + 1, end);
			if (colon < 0) return;
			const nextWhere = this.topLevelValue(colon + 1, end, "where", angles);
			const clauseEnd = nextWhere < 0 ? end : nextWhere;
			if (this.value(colon) === ":" && isIdentifier(this.token(nameIndex))) {
				this.addTypeReference(nameIndex, nameIndex, "typeUse");
				this.markConstraintSegments(colon + 1, clauseEnd, angles);
			}
			clauseStart = nextWhere;
		}
	}

	private markConstraintSegments(start: number, end: number, angles: AnglePairs): void {
		for (const segment of this.commaSegments(start, end, angles)) {
			if (
				this.nextSignificant(segment.start, segment.end) >= 0 &&
				!this.isConstraintKeyword(segment.start, segment.end)
			)
				this.addTypeReference(segment.start, segment.end - 1, "typeUse");
		}
	}

	/** A bare constraint keyword names no type. */
	private isConstraintKeyword(start: number, end: number): boolean {
		const first = this.nextSignificant(start, end);
		const token = this.token(first);
		if (token === undefined || !CONSTRAINT_KEYWORDS.has(token.value)) return false;
		const next = this.nextSignificant(first + 1, end);
		const bareWord = next < 0;
		const newCall = token.value === "new" && this.value(next) === "(";
		if (!bareWord && !newCall) return false;
		this.ignoredOffsets.add(token.startOffset);
		return true;
	}

	protected addTypeReference(start: number, end: number, role: Reference["role"]): void {
		if (end < start) return;
		for (let current = start; current <= end; current++) {
			const item = this.token(current);
			if (item?.kind === "identifier" && !SKIPPED_WORDS.has(item.value)) {
				this.typeTokenIndices.add(current);
				this.roleByOffset.set(item.startOffset, role);
			}
		}
	}

	/** Where a `nameof` operand's type portion ends, through its first generic instantiation. */
	protected genericOperandEnd(start: number, end: number): number | undefined {
		let current = this.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const value = this.value(current);
			if (value === "<") {
				const close = this.listClose(current, end);
				return close < 0 ? undefined : close;
			}
			if (value === "." || value === "::" || this.token(current)?.kind === "identifier") {
				current = this.nextSignificant(current + 1, end);
				continue;
			}
			return undefined;
		}
		return undefined;
	}

	/** `new [global::] A.B<T>` before `(`, `{` or `[` marks B as instantiate; A, T and global stay as they already read. */
	protected markNewInstantiation(newIndex: number): void {
		let cursor = this.nextSignificant(newIndex + 1);
		if (this.value(cursor) === "global") {
			const afterGlobal = this.nextSignificant(cursor + 1);
			if (this.value(afterGlobal) !== "::") return;
			cursor = this.nextSignificant(afterGlobal + 1);
		}
		let lastIdent = -1;
		for (;;) {
			if (!isIdentifier(this.token(cursor))) return;
			lastIdent = cursor;
			const after = this.nextSignificant(cursor + 1);
			if (this.value(after) !== ".") break;
			cursor = this.nextSignificant(after + 1);
		}
		let afterLast = this.nextSignificant(lastIdent + 1);
		if (this.value(afterLast) === "<") {
			const angleClose = this.listClose(afterLast, this.tokens.length);
			if (angleClose < 0) return;
			afterLast = this.nextSignificant(angleClose + 1);
		}
		// A constructor call, an object or collection initializer, or an array creation.
		const afterLastValue = this.value(afterLast);
		if (afterLastValue !== "(" && afterLastValue !== "{" && afterLastValue !== "[") return;
		const target = this.token(lastIdent);
		if (target !== undefined) this.roleByOffset.set(target.startOffset, "instantiate");
	}

	/** Where a run of `[...]` sections ends, without marking them. */
	protected bracketedSectionsEnd(index: number, end: number): number {
		let current = index;
		for (;;) {
			const open = this.nextSignificant(current, end);
			if (open < 0 || this.value(open) !== "[") return current;
			const close = this.matching(open, "[", "]", end);
			if (close < 0) return current;
			current = close + 1;
		}
	}

	protected looksLikeLambdaSignature(index: number, end: number): boolean {
		let current = this.nextSignificant(index, end);
		while (this.value(current) === "static" || this.value(current) === "async") {
			current = this.nextSignificant(current + 1, end);
		}
		if (this.value(current) === "delegate") {
			const afterKeyword = this.nextSignificant(current + 1, end);
			if (this.value(afterKeyword) !== "(") return this.value(afterKeyword) === "{";
			const close = this.matching(afterKeyword, "(", ")", end);
			return close >= 0 && this.value(this.nextSignificant(close + 1, end)) === "{";
		}
		if (this.value(current) === "(") {
			const close = this.matching(current, "(", ")", end);
			return close >= 0 && this.value(this.nextSignificant(close + 1, end)) === "=>";
		}
		return isIdentifier(this.token(current)) && this.value(this.nextSignificant(current + 1, end)) === "=>";
	}

	/** Whether `(` opens an anonymous method's own parameter list. */
	protected precededByDelegateKeyword(parenIndex: number): boolean {
		let current = this.previousSignificant(parenIndex);
		while (this.value(current) === "static" || this.value(current) === "async") {
			current = this.previousSignificant(current);
		}
		return this.value(current) === "delegate";
	}

	/** Whether a local function signature follows, never a bare call. */
	protected looksLikeLocalFunctionSignature(index: number, end: number): boolean {
		let current = this.nextSignificant(index, end);
		while (isIdentifier(this.token(current)) && MODIFIERS.has(this.value(current) ?? "")) {
			current = this.nextSignificant(current + 1, end);
		}
		let sawType = false;
		for (;;) {
			if (!isIdentifier(this.token(current))) return false;
			current = this.nextSignificant(current + 1, end);
			while (current >= 0 && current < end) {
				const value = this.value(current);
				if (value === "<") {
					const close = this.listClose(current, end);
					if (close < 0) return false;
					current = this.nextSignificant(close + 1, end);
					continue;
				}
				if (value === "[") {
					const close = this.matching(current, "[", "]", end);
					if (close < 0) return false;
					current = this.nextSignificant(close + 1, end);
					continue;
				}
				if (value === "?" || value === "." || value === "::") {
					current = this.nextSignificant(current + 1, end);
					continue;
				}
				break;
			}
			if (this.value(current) === "(") {
				if (!sawType) return false;
				const close = this.matching(current, "(", ")", end);
				if (close < 0) return false;
				const after = this.value(this.nextSignificant(close + 1, end));
				return after === "{" || after === "=>";
			}
			sawType = true;
		}
	}

	private parseEnumMembers(start: number, end: number, parent: RawDeclaration): void {
		let current = start;
		let pendingLeading: Token | undefined;
		let pendingAttributes: number | undefined;
		while (current < end) {
			const item = this.token(current);
			if (item?.kind === "doc") {
				pendingLeading = earliest(pendingLeading, item);
				current++;
				continue;
			}
			if (isTrivia(item)) {
				current++;
				continue;
			}
			const section = this.attributeSectionAt(current, end);
			if (section !== undefined) {
				if (section.close < 0) return;
				pendingLeading = earliest(pendingLeading, this.token(section.open));
				pendingAttributes ??= section.open;
				current = section.close + 1;
				continue;
			}
			const nameIndex = this.nextSignificant(current, end);
			if (nameIndex < 0) return;
			const name = this.token(nameIndex);
			if (!isIdentifier(name)) return;
			let finish = nameIndex + 1;
			let depth = 0;
			while (finish < end) {
				const value = this.value(finish);
				if (value === "(" || value === "[" || value === "{") depth++;
				if (value === ")" || value === "]" || value === "}") depth--;
				if ((value === "," || value === "}") && depth === 0) break;
				finish++;
			}
			const previous = this.previousSignificant(finish, nameIndex);
			const endToken = this.token(previous >= nameIndex ? previous : nameIndex) ?? name;
			this.ignoredOffsets.add(name.startOffset);
			this.addDeclaration({
				kind: "constant",
				languageKind: "enumMember",
				name: name.value,
				parent,
				startToken: pendingLeading ?? name,
				endToken,
				selectionStart: name,
				selectionEnd: name,
				codeStart: name,
				visibility: "public",
				exported: parent.exported,
				signature: this.header(pendingAttributes ?? nameIndex, finish),
				nameTokenOffsets: [name.startOffset],
			});
			pendingLeading = undefined;
			pendingAttributes = undefined;
			current = this.value(finish) === "," ? finish + 1 : finish;
		}
	}

	private parseDelegate(
		keywordIndex: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration | undefined,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const keyword = this.token(keywordIndex);
		if (keyword === undefined) return -1;
		const boundary = this.findSemicolon(keywordIndex + 1, end);
		if (boundary < 0) this.report("Delegate declaration has no terminating semicolon.", keyword);
		const finish = boundary < 0 ? end : boundary;
		const open = this.findCallParen(keywordIndex + 1, finish);
		const nameIndex =
			open < 0 ? this.lastIdentifier(keywordIndex + 1, finish) : this.methodNameIndex(open, keywordIndex + 1);
		const name = this.token(nameIndex);
		if (!isIdentifier(name)) {
			this.report("Delegate declaration needs a name.", keyword);
			return boundary < 0 ? end : boundary + 1;
		}
		const visibility = visibilityFor(modifiers, parent, "function");
		const delegate = this.addDeclaration({
			kind: "function",
			languageKind: "delegate",
			name: name.value,
			parent,
			startToken: leading?.start ?? this.token(codeStartIndex) ?? keyword,
			endToken: this.token(boundary >= 0 ? boundary : finish - 1) ?? name,
			selectionStart: name,
			selectionEnd: name,
			codeStart: this.token(codeStartIndex) ?? keyword,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.header(leading?.attributes ?? codeStartIndex, boundary >= 0 ? boundary : finish),
			nameTokenOffsets: [name.startOffset],
		});
		const close = open < 0 ? -1 : this.matching(open, "(", ")", finish);
		delegate.parameterCount = close < 0 ? 0 : this.parseParameters(open, close, delegate);
		if (!this.outline && close >= 0) this.parseTypeConstraints(close + 1, finish);
		const typeSpan = this.spanBeforeName(keywordIndex + 1, nameIndex);
		this.recordTypeSpan(typeSpan, delegate);
		return boundary < 0 ? end : boundary + 1;
	}

	private parseMember(
		index: number,
		modifiers: ModifierInfo,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
	): number {
		const start = modifiers.index < end ? modifiers.index : index;
		if (this.value(start) === "event")
			return this.parseEvent(start, modifiers.start, end, parent, leading, modifiers.modifiers);
		const boundary = this.findMemberBoundary(start, end);
		if (boundary === undefined) {
			this.report("Member declaration needs a terminating delimiter.", this.token(start));
			return -1;
		}
		const open = this.findCallParen(start, boundary.index);
		if (open >= 0)
			return this.parseMethod(start, modifiers.start, boundary, open, end, parent, leading, modifiers.modifiers);
		const arrow = this.expressionBodyArrow(start, boundary.index);
		if (boundary.kind === "body" || arrow >= 0) {
			const nameIndex = this.propertyName(start, arrow >= 0 ? arrow : boundary.index);
			if (nameIndex >= 0)
				return this.parseProperty(
					start,
					modifiers.start,
					boundary,
					arrow >= 0 ? arrow : boundary.index,
					nameIndex,
					end,
					parent,
					leading,
					modifiers.modifiers,
				);
		}
		return this.parseField(start, modifiers.start, boundary, end, parent, leading, modifiers.modifiers);
	}

	private parseMethod(
		start: number,
		codeStartIndex: number,
		boundary: Boundary,
		open: number,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const operator = this.operatorName(start, open);
		const angles = this.typeAngles(start, open);
		const nameIndex = operator?.end ?? this.methodNameIndex(open, start, angles);
		const name = this.token(nameIndex);
		const declarationName = operator?.name ?? (isIdentifier(name) ? name.value : undefined);
		if (declarationName === undefined) {
			this.report("Method declaration needs a name.", this.token(open));
			return this.advanceBoundary(boundary, end);
		}
		const isConstructor = operator === undefined && declarationName === parent.name;
		const qualifier = operator === undefined ? this.explicitInterfaceQualifier(start, nameIndex, angles) : [];
		const kind: SymbolKind = operator === undefined ? (isConstructor ? "constructor" : "method") : "operator";
		const selectionStart = operator === undefined ? name : this.token(operator.start);
		const selectionEnd = operator === undefined ? name : this.token(operator.end);
		if (selectionStart === undefined || selectionEnd === undefined) return this.advanceBoundary(boundary, end);
		const nameTokenOffsets =
			operator === undefined
				? [selectionStart.startOffset]
				: this.tokens
						.slice(operator.start, operator.end + 1)
						.filter((item) => item.kind === "identifier")
						.map((item) => item.startOffset);
		const visibility = visibilityFor(modifiers, parent, kind);
		const bodyClose = boundary.kind === "body" ? this.matching(boundary.index, "{", "}", end) : -1;
		if (boundary.kind === "body" && bodyClose < 0)
			this.report("Method body is not closed.", this.token(boundary.index));
		const close = this.matching(open, "(", ")", end);
		if (close < 0) this.report("Parameter list is not closed.", this.token(open));
		const arrow = close < 0 ? -1 : this.findTopLevelValue(close + 1, boundary.index, "=>");
		const endIndex = bodyClose >= 0 ? bodyClose : boundary.kind === "semicolon" ? boundary.index : end - 1;
		const method = this.addDeclaration({
			kind,
			...(qualifier.length === 0 ? {} : { qualifier }),
			languageKind: operator === undefined ? (isConstructor ? "constructor" : "method") : "conversionOperator",
			name: declarationName,
			parent,
			startToken: leading?.start ?? this.token(codeStartIndex) ?? selectionStart,
			endToken: this.token(endIndex) ?? selectionEnd,
			selectionStart,
			selectionEnd,
			codeStart: this.token(codeStartIndex) ?? selectionStart,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.header(leading?.attributes ?? codeStartIndex, arrow >= 0 ? arrow : boundary.index),
			bodyStartToken: boundary.kind === "body" ? this.token(boundary.index) : undefined,
			bodyEndToken: bodyClose >= 0 ? this.token(bodyClose) : undefined,
			nameTokenOffsets,
			isStatic: modifiers.has("static"),
		});
		const conversion = modifiers.has("implicit") || modifiers.has("explicit");
		const typeSpan =
			operator === undefined
				? isConstructor
					? undefined
					: this.spanBeforeName(start, nameIndex)
				: conversion
					? { start: operator.start + 1, end: operator.end + 1 }
					: this.spanBeforeName(start, operator.start);
		this.recordTypeSpan(typeSpan, method);
		const genericOpen = this.nextSignificant(nameIndex + 1, open);
		const genericClose = angles.get(genericOpen);
		if (genericClose !== undefined) this.markTypeParameters(genericOpen, genericClose, method);
		method.parameterCount = close < 0 ? 0 : this.parseParameters(open, close, method);
		if (!this.outline && close >= 0) this.parseTypeConstraints(close + 1, boundary.index);
		if (boundary.kind === "body")
			this.parseLocalDeclarations(boundary.index + 1, bodyClose < 0 ? end : bodyClose, method);
		return this.advanceBoundary(boundary, end, bodyClose);
	}

	private parseParameters(open: number, close: number, parent: RawDeclaration): number {
		if (open < 0 || close < 0 || close <= open) return 0;
		const angles = this.typeAngles(open + 1, close);
		const segments = this.commaSegments(open + 1, close, angles);
		for (const segment of segments) this.addParameter(segment.start, segment.end, parent, angles);
		parent.parameterCount = segments.filter(
			(segment) => this.findParameterName(segment.start, segment.end, angles) >= 0,
		).length;
		return parent.parameterCount;
	}

	private findParameterName(start: number, end: number, angles: AnglePairs): number {
		const equals = this.topLevelValue(start, end, "=", angles);
		let last = this.previousSignificant(equals < 0 ? end : equals, start);
		while (last >= start && this.value(last) === "]") last = this.previousSignificant(last, start);
		return last;
	}

	private addParameter(start: number, end: number, parent: RawDeclaration, angles: AnglePairs): void {
		const nameIndex = this.findParameterName(start, end, angles);
		const name = this.token(nameIndex);
		if (!isIdentifier(name)) return;
		const first = this.token(this.nextSignificant(start, end));
		const last = this.token(this.previousSignificant(end, start));
		if (first === undefined || last === undefined) return;
		this.ignoredOffsets.add(name.startOffset);
		const parameter = this.addDeclaration({
			kind: "variable",
			languageKind: "parameter",
			name: name.value,
			parent,
			startToken: first,
			endToken: last,
			selectionStart: name,
			selectionEnd: name,
			codeStart: first,
			visibility: "local",
			exported: false,
			nameTokenOffsets: [name.startOffset],
		});
		const typeSpan = this.spanBeforeName(this.afterAttributeSections(start, nameIndex), nameIndex);
		this.recordTypeSpan(typeSpan, parameter);
	}

	private parseLocalDeclarations(start: number, end: number, parent: RawDeclaration): void {
		let current = this.nextSignificant(start, end);
		let statementStart = true;
		while (current >= 0 && current < end) {
			const item = this.token(current);
			if (syntaxValue(item) === ";" || syntaxValue(item) === "{") {
				statementStart = true;
				current = this.nextSignificant(current + 1, end);
				continue;
			}
			if (!statementStart) {
				current = this.nextSignificant(current + 1, end);
				continue;
			}
			const next = this.nextSignificant(current + 1, end);
			const nextToken = this.token(next);
			const explicit =
				isIdentifier(item) &&
				!SKIPPED_WORDS.has(item.value) &&
				isIdentifier(nextToken) &&
				this.isLocalNameFollower(this.nextSignificant(next + 1, end));
			const inferred = syntaxValue(item) === "var" && isIdentifier(nextToken);
			const nameIndex = explicit || inferred ? next : this.tupleLocalName(current, end);
			if (nameIndex < 0) {
				statementStart = false;
				current = this.nextSignificant(current + 1, end);
				continue;
			}
			const nameToken = this.token(nameIndex) as Token;
			const finish = this.findSemicolon(nameIndex + 1, end);
			const endToken = this.token(finish >= 0 ? finish : nameIndex) ?? nameToken;
			const declarator = this.commaSegments(current, finish >= 0 ? finish : nameIndex + 1)[0];
			const initializer = this.outline
				? undefined
				: this.initializerToken(current, finish >= 0 ? finish : end, nameIndex);
			const inferredType =
				!this.outline && inferred && initializer !== undefined ? displayForLiteral(initializer) : undefined;
			const local = this.addDeclaration({
				kind: "variable",
				languageKind: "local",
				name: nameToken.value,
				parent,
				startToken: item as Token,
				endToken,
				selectionStart: nameToken,
				selectionEnd: nameToken,
				codeStart: item as Token,
				visibility: "local",
				exported: false,
				signature: declarator === undefined ? undefined : this.header(current, declarator.end),
				...defined({ inferredType }),
				nameTokenOffsets: [nameToken.startOffset],
			});
			this.recordTypeSpan(inferred ? undefined : { start: current, end: nameIndex }, local);
			if (finish >= 0) current = finish + 1;
			else current = nameIndex + 1;
			statementStart = true;
		}
	}

	private parseProperty(
		start: number,
		codeStartIndex: number,
		boundary: Boundary,
		headerEnd: number,
		nameIndex: number,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const name = this.token(nameIndex);
		if (!isIdentifier(name)) return this.advanceBoundary(boundary, end);
		if (name.value === "this") {
			const bracketOpen = this.nextSignificant(nameIndex + 1, end);
			if (this.value(bracketOpen) === "[") {
				const bracketClose = this.matching(bracketOpen, "[", "]", end);
				if (bracketClose >= 0) this.walkAttributeSections(bracketOpen + 1, bracketClose);
			}
		}
		const close = boundary.kind === "body" ? this.matching(boundary.index, "{", "}", end) : -1;
		if (boundary.kind === "body" && close < 0)
			this.report("Property body is not closed.", this.token(boundary.index));
		const visibility = visibilityFor(modifiers, parent, "property");
		const qualifier = this.explicitInterfaceQualifier(start, nameIndex);
		const property = this.addDeclaration({
			kind: "property",
			...(qualifier.length === 0 ? {} : { qualifier }),
			languageKind: "property",
			name: name.value,
			parent,
			startToken: leading?.start ?? this.token(codeStartIndex) ?? name,
			endToken: this.token(close >= 0 ? close : boundary.index) ?? name,
			selectionStart: name,
			selectionEnd: name,
			codeStart: this.token(codeStartIndex) ?? name,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.header(leading?.attributes ?? codeStartIndex, headerEnd),
			nameTokenOffsets: [name.startOffset],
		});
		this.recordTypeSpan(this.spanBeforeName(start, nameIndex), property);
		if (close >= 0) {
			this.parseAccessorAttributes(boundary.index + 1, close);
			const afterBody = this.nextSignificant(close + 1, end);
			if (this.value(afterBody) === "=") {
				const semicolon = this.findSemicolon(afterBody + 1, end);
				return semicolon < 0 ? end : semicolon + 1;
			}
		}
		return this.advanceBoundary(boundary, end, close);
	}

	private parseEvent(
		start: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const boundary = this.findMemberBoundary(start, end);
		if (boundary === undefined) {
			this.report("Event declaration needs a terminating delimiter.", this.token(start));
			return -1;
		}
		const finish = boundary.index;
		const angles = this.typeAngles(start + 1, finish);
		const segments = this.commaSegments(start + 1, finish, angles);
		const firstSegment = segments[0];
		const firstNameIndex =
			firstSegment === undefined ? -1 : this.firstDeclaratorName(firstSegment.start, firstSegment.end, angles);
		const firstName = this.token(firstNameIndex);
		if (!isIdentifier(firstName)) {
			this.report("Event declaration needs a name.", this.token(start));
			return this.advanceBoundary(boundary, end);
		}
		const close = boundary.kind === "body" ? this.matching(boundary.index, "{", "}", end) : -1;
		if (close >= 0) this.parseAccessorAttributes(boundary.index + 1, close);
		const visibility = visibilityFor(modifiers, parent, "event");
		const type = this.declaredType(this.spanBeforeName(start + 1, firstNameIndex));
		const qualifier = this.explicitInterfaceQualifier(start + 1, firstNameIndex, angles);
		for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
			const segment = segments[segmentIndex] as TypeSpan;
			const nameIndex =
				segmentIndex === 0 ? firstNameIndex : this.findDeclaratorName(segment.start, segment.end, angles);
			const name = this.token(nameIndex);
			if (!isIdentifier(name)) continue;
			this.ignoredOffsets.add(name.startOffset);
			const event = this.addDeclaration({
				kind: "event",
				...(qualifier.length === 0 ? {} : { qualifier }),
				languageKind: "event",
				name: name.value,
				parent,
				startToken: leading?.start ?? this.token(codeStartIndex) ?? name,
				endToken: this.token(close >= 0 ? close : boundary.index) ?? name,
				selectionStart: name,
				selectionEnd: name,
				codeStart: this.token(codeStartIndex) ?? name,
				visibility,
				exported: exportedFor(visibility, parent),
				signature: this.header(
					leading?.attributes ?? codeStartIndex,
					segment.end,
					segmentIndex === 0 ? undefined : { from: firstNameIndex, to: nameIndex },
				),
				...type,
				nameTokenOffsets: [name.startOffset],
			});
			this.recordTypeSpan(segmentIndex === 0 ? this.spanBeforeName(start + 1, nameIndex) : undefined, event);
		}
		return this.advanceBoundary(boundary, end, close);
	}

	private parseField(
		start: number,
		codeStartIndex: number,
		boundary: Boundary,
		end: number,
		parent: RawDeclaration,
		leading: Leading | undefined,
		modifiers: Set<string>,
	): number {
		const finish = boundary.kind === "semicolon" ? boundary.index : this.advanceBoundary(boundary, end);
		const angles = this.typeAngles(start, finish);
		const segments = this.commaSegments(start, finish, angles);
		const firstName = this.firstDeclaratorName(segments[0]?.start ?? start, segments[0]?.end ?? finish, angles);
		const firstNameToken = this.token(firstName);
		if (!isIdentifier(firstNameToken)) {
			this.report("Field declaration needs a name.", this.token(start));
			return this.advanceBoundary(boundary, end);
		}
		const type = this.declaredType(this.spanBeforeName(start, firstName));
		const kind: SymbolKind = modifiers.has("const") ? "constant" : "field";
		const visibility = visibilityFor(modifiers, parent, kind);
		for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
			const segment = segments[segmentIndex] as TypeSpan;
			const nameIndex =
				segmentIndex === 0 ? firstName : this.findDeclaratorName(segment.start, segment.end, angles);
			const name = this.token(nameIndex);
			if (!isIdentifier(name)) continue;
			this.ignoredOffsets.add(name.startOffset);
			const initializer = this.initializerToken(segment.start, segment.end, nameIndex);
			const inferredType =
				!this.outline && type.typeText === undefined && initializer !== undefined
					? displayForLiteral(initializer)
					: undefined;
			const field = this.addDeclaration({
				kind,
				languageKind: kind === "constant" ? "const" : "field",
				name: name.value,
				parent,
				startToken: leading?.start ?? this.token(codeStartIndex) ?? name,
				endToken: this.token(boundary.index) ?? name,
				selectionStart: name,
				selectionEnd: name,
				codeStart: this.token(codeStartIndex) ?? name,
				visibility,
				exported: exportedFor(visibility, parent),
				signature: this.header(
					leading?.attributes ?? codeStartIndex,
					segment.end,
					segmentIndex === 0 ? undefined : { from: firstName, to: nameIndex },
				),
				...type,
				...defined({ inferredType }),
				nameTokenOffsets: [name.startOffset],
			});
			this.recordTypeSpan(segmentIndex === 0 ? this.spanBeforeName(start, nameIndex) : undefined, field);
		}
		return this.advanceBoundary(boundary, end);
	}

	private findTypeBoundary(start: number, end: number): Boundary | undefined {
		let parentheses = 0;
		let brackets = 0;
		for (let current = start; current < end; current++) {
			const value = this.value(current);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (parentheses === 0 && brackets === 0 && value === "{") return { kind: "body", index: current };
			else if (parentheses === 0 && brackets === 0 && value === ";") return { kind: "semicolon", index: current };
		}
		return undefined;
	}

	private findMemberBoundary(start: number, end: number): Boundary | undefined {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		let initializer = false;
		for (let current = start; current < end; current++) {
			const value = this.value(current);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (value === "=>" && parentheses === 0 && brackets === 0 && braces === 0) initializer = true;
			else if (value === "=" && parentheses === 0 && brackets === 0 && braces === 0) initializer = true;
			else if (value === "{" && parentheses === 0 && brackets === 0 && braces === 0) {
				if (!initializer) return { kind: "body", index: current };
				braces++;
			} else if (value === "{" && braces > 0) braces++;
			else if (value === "}" && braces > 0) braces--;
			else if (value === ";" && parentheses === 0 && brackets === 0 && braces === 0)
				return { kind: "semicolon", index: current };
		}
		return undefined;
	}

	/** Skips a leading or conversion tuple type, and an operator's symbol. */
	private findCallParen(start: number, end: number): number {
		let typePosition = true;
		let afterOperator = false;
		let previous = -1;
		for (let current = start; current < end; current++) {
			const item = this.token(current);
			if (isTrivia(item)) continue;
			const value = syntaxValue(item);
			if (value === "(" && typePosition) {
				const tuple = this.typeShape(current, end);
				if (tuple !== undefined) {
					current = tuple.end - 1;
					previous = current;
					typePosition = false;
					afterOperator = false;
					continue;
				}
			}
			// `>>>` is two tokens.
			const symbol: boolean = afterOperator && item?.kind === "punctuation" && value !== "(";
			afterOperator = value === "operator" || symbol;
			typePosition = value === "operator";
			if (symbol) continue;
			if (value === "=" || value === "=>") return -1;
			if (value === "(") return current;
			// Before its parameters a member holds types and names only.
			if (value === "[" || (value === "<" && this.opensTypeList(previous, current, end, true, 0))) {
				const close = value === "[" ? this.matching(current, "[", "]", end) : this.listClose(current, end);
				if (close < 0) return -1;
				current = close;
			}
			previous = current;
		}
		return -1;
	}

	private methodNameIndex(open: number, start: number, angles: AnglePairs = this.typeAngles(start, open)): number {
		const nameIndex = this.previousSignificant(open, start);
		const list = this.listEndingAt(nameIndex, angles);
		return list < 0 ? nameIndex : this.previousSignificant(list, start);
	}

	/** The written interface of an explicit implementation, as names; kinds are settled once the parse is whole. */
	private explicitInterfaceQualifier(
		start: number,
		nameIndex: number,
		angles: AnglePairs = this.typeAngles(start, nameIndex),
	): string[] {
		const names: string[] = [];
		let current = this.previousSignificant(nameIndex, start);
		while (current >= start && this.value(current) === ".") {
			const qualifier = this.previousSignificant(current, start);
			const segment = this.genericInterfaceBefore(qualifier, start, angles);
			if (segment === null) break;
			names.unshift(segment.name);
			current = this.previousSignificant(segment.start, start);
		}
		return names;
	}

	private genericInterfaceBefore(
		index: number,
		start: number,
		angles: AnglePairs,
	): { name: string; start: number } | null {
		const token = this.token(index);
		if (isIdentifier(token)) return { name: token.value, start: index };
		const list = this.listEndingAt(index, angles);
		const nameIndex = list < 0 ? -1 : this.previousSignificant(list, start);
		const name = this.token(nameIndex);
		return isIdentifier(name) ? { name: name.value, start: nameIndex } : null;
	}

	private operatorName(start: number, open: number): { name: string; start: number; end: number } | undefined {
		const operatorIndex = this.findTopLevelValue(start, open, "operator");
		if (operatorIndex < 0) return undefined;
		const targetStart = this.nextSignificant(operatorIndex + 1, open);
		const targetEnd = this.previousSignificant(open, targetStart);
		const first = this.token(targetStart);
		if (first === undefined || targetEnd < targetStart) return undefined;
		const target = this.tokens
			.slice(targetStart, targetEnd + 1)
			.filter((item) => !isTrivia(item))
			.map((item) => item.value)
			.join("");
		if (target === "") return undefined;
		return {
			name: first.kind === "identifier" ? `operator ${target}` : `operator${target}`,
			start: operatorIndex,
			end: targetEnd,
		};
	}

	private propertyName(start: number, end: number): number {
		const thisIndex = this.findTopLevelValue(start, end, "this");
		if (thisIndex >= 0) return thisIndex;
		return this.lastIdentifier(start, end);
	}

	/** Arrow after `=` is a lambda, not a body. */
	private expressionBodyArrow(start: number, end: number): number {
		const arrow = this.findTopLevelValue(start, end, "=>");
		return arrow >= 0 && this.findTopLevelValue(start, arrow, "=") < 0 ? arrow : -1;
	}

	private initializerToken(start: number, end: number, nameIndex: number): Token | undefined {
		let current = this.nextSignificant(nameIndex + 1, end);
		if (this.value(current) !== "=") return undefined;
		current = this.nextSignificant(current + 1, end);
		const item = this.token(current);
		return item?.kind === "string" || item?.kind === "number" || item?.kind === "boolean" ? item : undefined;
	}

	/** Element names are not references. */
	private recordTypeSpan(span: TypeSpan | undefined, declaration: RawDeclaration): void {
		if (this.outline || span === undefined) return;
		const leading = this.leadingType(span);
		// Explicit interface qualifier.
		const qualifier = leading === undefined ? undefined : this.typeShape(leading.shape.end, span.end);
		const elementNames = new Set([...(leading?.shape.elementNames ?? []), ...(qualifier?.elementNames ?? [])]);
		for (let current = span.start; current < span.end; current++) {
			const item = this.token(current);
			if (item?.kind !== "identifier" || MODIFIERS.has(item.value)) continue;
			if (elementNames.has(current)) this.ignoredOffsets.add(item.startOffset);
			else this.typeTokenIndices.add(current);
		}
		if (declaration.typeText === undefined) Object.assign(declaration, this.typeFacts(leading));
	}

	private advanceBoundary(boundary: Boundary, end: number, bodyClose = -1): number {
		if (boundary.kind === "semicolon") return boundary.index + 1;
		if (bodyClose >= 0) return bodyClose + 1;
		const close = this.matching(boundary.index, "{", "}", end);
		return close >= 0 ? close + 1 : end;
	}

	private skipUnknown(start: number, end: number): number {
		const first = this.nextSignificant(start, end);
		if (first < 0) return end;
		const boundary = this.findMemberBoundary(first, end);
		if (boundary === undefined) return Math.min(end, first + 1);
		return this.advanceBoundary(boundary, end);
	}

	private addDeclaration(input: RawDeclarationInput): RawDeclaration {
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
		if (input.languageKind === "parameter") {
			raw.descriptor = { kind: "parameter", name: input.name };
		} else if (input.kind === "method" || input.kind === "constructor" || input.kind === "function") {
			raw.descriptor =
				ordinal === 0
					? { kind: "method", name: input.name }
					: { kind: "method", name: input.name, disambiguator: String(ordinal) };
		} else if (input.kind === "typeParameter") {
			raw.descriptor = { kind: "typeParameter", name: input.name };
		} else if (input.kind !== "variable" || input.languageKind !== "local") {
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
			};
		} else {
			raw.localOrdinal = this.localOrdinal++;
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

	protected typePath(raw: RawDeclaration | undefined): string {
		const names: string[] = [];
		let current = raw;
		while (current !== undefined) {
			if (
				current.kind === "class" ||
				current.kind === "struct" ||
				current.kind === "interface" ||
				current.kind === "enum"
			)
				names.unshift(current.name);
			current = current.parent;
		}
		return names.join(".");
	}
}
