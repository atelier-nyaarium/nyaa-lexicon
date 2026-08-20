import {
	type CommentSpan,
	comparePositions,
	composeSymbolId,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type ImportedName,
	type Literal,
	type Metrics,
	type Range,
	type Reference,
	type SymbolKind,
} from "@nyaa-lexicon/protocol";
import { Cursor } from "./cursor.js";
import { type LexedSource, positionRange, type Token, tokenize } from "./tokens.js";

export const LANGUAGE = "csharp";

export interface CsharpImport {
	specifier: string;
	imported: ImportedName[];
	reExport: false;
	alias?: string;
	static: boolean;
	range: Range;
	specifierRange: Range;
}

export interface DeclarationMeta {
	declaration: Declaration;
	startOffset: number;
	endOffset: number;
	namespaceName: string;
	typePath: string;
	parentId?: string;
	typeText?: string;
	typeName?: string;
	inferredType?: string;
	isPartial?: boolean;
	bodyStartOffset?: number;
	bodyEndOffset?: number;
	parameterCount?: number;
}

export interface CsharpFacts {
	module: string;
	text: string;
	declarations: Declaration[];
	references: Reference[];
	imports: CsharpImport[];
	literals: Literal[];
	comments: CommentSpan[];
	diagnostics: Diagnostic[];
	metadata: Map<string, DeclarationMeta>;
	namespaceNames: string[];
}

interface Documentation {
	text: string;
	start: Token;
}

interface RawDeclaration {
	kind: SymbolKind;
	languageKind?: string | undefined;
	name: string;
	parent?: RawDeclaration | undefined;
	descriptor?: Descriptor;
	localOrdinal?: number;
	startToken: Token;
	endToken: Token;
	selectionStart: Token;
	selectionEnd: Token;
	codeStart: Token;
	visibility: Visibility;
	exported: boolean;
	signature?: string | undefined;
	docComment?: string | undefined;
	typeText?: string | undefined;
	typeName?: string | undefined;
	inferredType?: string | undefined;
	isPartial?: boolean | undefined;
	bodyStartToken?: Token | undefined;
	bodyEndToken?: Token | undefined;
	parameterCount?: number | undefined;
	nameTokenOffsets: number[];
}

type Visibility = Declaration["visibility"];

type RawDeclarationInput = Omit<
	RawDeclaration,
	| "descriptor"
	| "localOrdinal"
	| "languageKind"
	| "parent"
	| "signature"
	| "docComment"
	| "typeText"
	| "typeName"
	| "inferredType"
	| "bodyStartToken"
	| "bodyEndToken"
	| "parameterCount"
> & {
	languageKind?: string | undefined;
	parent?: RawDeclaration | undefined;
	signature?: string | undefined;
	docComment?: string | undefined;
	typeText?: string | undefined;
	typeName?: string | undefined;
	inferredType?: string | undefined;
	bodyStartToken?: Token | undefined;
	bodyEndToken?: Token | undefined;
	parameterCount?: number | undefined;
};

interface ModifierInfo {
	index: number;
	start: number;
	modifiers: Set<string>;
}

interface Boundary {
	kind: "body" | "semicolon";
	index: number;
}

interface TypeSpan {
	start: number;
	end: number;
}

const MODIFIERS = new Set([
	"public",
	"private",
	"protected",
	"internal",
	"static",
	"abstract",
	"sealed",
	"partial",
	"readonly",
	"ref",
	"out",
	"in",
	"async",
	"implicit",
	"explicit",
	"extern",
	"unsafe",
	"new",
	"required",
	"virtual",
	"override",
	"volatile",
	"file",
	"scoped",
	"const",
	"fixed",
]);

const SKIPPED_WORDS = new Set([
	"abstract",
	"add",
	"alias",
	"and",
	"as",
	"await",
	"base",
	"break",
	"case",
	"catch",
	"checked",
	"class",
	"const",
	"continue",
	"default",
	"delegate",
	"do",
	"else",
	"enum",
	"event",
	"explicit",
	"extern",
	"false",
	"finally",
	"fixed",
	"for",
	"foreach",
	"from",
	"get",
	"global",
	"goto",
	"if",
	"init",
	"implicit",
	"in",
	"interface",
	"internal",
	"is",
	"lock",
	"namespace",
	"nameof",
	"new",
	"null",
	"object",
	"operator",
	"out",
	"override",
	"params",
	"partial",
	"private",
	"protected",
	"public",
	"readonly",
	"record",
	"ref",
	"remove",
	"return",
	"sealed",
	"select",
	"set",
	"scoped",
	"sizeof",
	"stackalloc",
	"static",
	"struct",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"unchecked",
	"unsafe",
	"using",
	"var",
	"virtual",
	"required",
	"file",
	"async",
	"not",
	"or",
	"void",
	"volatile",
	"when",
	"where",
	"while",
	"with",
	"yield",
]);

const BUILTIN_TYPES = new Set([
	"bool",
	"byte",
	"sbyte",
	"char",
	"decimal",
	"double",
	"float",
	"int",
	"long",
	"nint",
	"nuint",
	"object",
	"short",
	"string",
	"uint",
	"ulong",
	"ushort",
	"void",
	"dynamic",
	"var",
]);

const ASSIGNMENT_WORDS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "??="]);

function isTrivia(token: Token | undefined): boolean {
	return (
		token === undefined ||
		token.kind === "comment" ||
		token.kind === "doc" ||
		token.kind === "directive" ||
		token.kind === "newline"
	);
}

function isIdentifier(token: Token | undefined): token is Token {
	return token?.kind === "identifier";
}

function syntaxValue(token: Token | undefined): string | undefined {
	return token?.kind === "identifier" || token?.kind === "punctuation" ? token.value : undefined;
}

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

function typeNameFromText(text: string): string | undefined {
	let value = text.trim().replace(/^global::/u, "");
	const generic = value.indexOf("<");
	if (generic >= 0) value = value.slice(0, generic);
	const array = value.indexOf("[");
	if (array >= 0) value = value.slice(0, array);
	value = value.replace(/\?$/u, "");
	value = value.split(/\.|::/u).at(-1)?.trim().split(/\s+/u).at(-1) ?? "";
	return value === "" || BUILTIN_TYPES.has(value) ? undefined : value;
}

function displayForLiteral(token: Token): string | undefined {
	if (token.kind === "string") return "string";
	if (token.kind === "boolean") return "bool";
	if (token.kind !== "number") return undefined;
	const raw = token.value.toLowerCase();
	if (raw.endsWith("m")) return "decimal";
	if (raw.endsWith("f")) return "float";
	if (raw.includes(".") || raw.includes("e")) return "double";
	return "int";
}

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

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

export class CsharpParser {
	private readonly cursor: Cursor;
	private readonly lexed: LexedSource;
	private readonly tokens: Token[];
	private readonly rawDeclarations: RawDeclaration[] = [];
	private readonly rawImports: CsharpImport[] = [];
	private readonly typeTokenIndices = new Set<number>();
	private readonly roleByOffset = new Map<number, Reference["role"]>();
	private readonly ignoredOffsets = new Set<number>();
	private readonly namespaceNames = new Set<string>();
	private readonly diagnostics: Diagnostic[];
	private readonly reportedDiagnostics = new Set<string>();
	private readonly scopeCounts = new Map<RawDeclaration | undefined, Map<string, number>>();
	private localOrdinal = 0;

	constructor(
		private readonly module: string,
		private readonly text: string,
		private readonly outline = false,
	) {
		this.cursor = new Cursor(text);
		this.lexed = tokenize(text, { collectLiterals: !outline, collectComments: !outline });
		this.tokens = this.lexed.tokens;
		this.diagnostics = [...this.lexed.diagnostics];
	}

	parse(): CsharpFacts {
		if (this.module.endsWith(".cs")) {
			this.checkDelimiters();
			this.parseScope(0, this.tokens.length - 1, undefined);
		}
		const finalized = this.finalizeDeclarations();
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
			declarations: finalized.declarations,
			references,
			imports: this.rawImports,
			literals,
			comments,
			diagnostics,
			metadata: finalized.metadata,
			namespaceNames: [...this.namespaceNames].sort(),
		};
	}

	private token(index: number): Token | undefined {
		return this.tokens[index];
	}

	private value(index: number): string | undefined {
		return syntaxValue(this.token(index));
	}

	private nextSignificant(index: number, end = this.tokens.length): number {
		let current = index;
		while (current < end && isTrivia(this.token(current))) current++;
		return current < end ? current : -1;
	}

	private previousSignificant(index: number, start = 0): number {
		let current = index - 1;
		while (current >= start && isTrivia(this.token(current))) current--;
		return current;
	}

	private matching(index: number, open: string, close: string, end = this.tokens.length): number {
		let depth = 0;
		for (let current = index; current < end; current++) {
			const item = this.token(current);
			const value = item?.kind === "punctuation" ? item.value : undefined;
			if (value === open) depth++;
			else if (value === close) {
				depth--;
				if (depth === 0) return current;
			}
		}
		return -1;
	}

	private matchingAngle(index: number, end = this.tokens.length): number {
		let depth = 0;
		for (let current = index; current < end; current++) {
			const item = this.token(current);
			const value = item?.kind === "punctuation" ? item.value : undefined;
			if (value === "<") depth++;
			else if (value === ">") depth--;
			else if (value === ">>") depth -= 2;
			if (depth === 0 && current > index) return current;
		}
		return -1;
	}

	private report(message: string, token: Token | undefined): void {
		if (token === undefined) return;
		const key = `${message}:${token.startOffset}`;
		if (this.reportedDiagnostics.has(key)) return;
		this.reportedDiagnostics.add(key);
		this.diagnostics.push({ severity: "error", message, range: positionRange(token) });
	}

	private checkDelimiters(): void {
		const opens = new Map<string, string>([
			["(", ")"],
			["[", "]"],
			["{", "}"],
		]);
		const closes = new Map<string, string>([
			[")", "("],
			["]", "["],
			["}", "{"],
		]);
		const stack: Token[] = [];
		for (const item of this.tokens) {
			if (item.kind !== "punctuation") continue;
			if (opens.has(item.value)) {
				stack.push(item);
				continue;
			}
			const opening = closes.get(item.value);
			if (opening === undefined) continue;
			if (stack[stack.length - 1]?.value === opening) {
				stack.pop();
			} else {
				this.report(`Unexpected closing delimiter ${item.value}.`, item);
			}
		}
		for (const item of stack) this.report(`Opening delimiter ${item.value} is not closed.`, item);
	}

	private documentationFor(lines: string[], start: Token): Documentation | undefined {
		return lines.length === 0 ? undefined : { text: lines.join("\n"), start };
	}

	private parseScope(start: number, end: number, parent: RawDeclaration | undefined): void {
		let index = start;
		let documentation: string[] = [];
		let documentationStart: Token | undefined;
		let lastDocumentationLine = -2;
		while (index < end) {
			const current = this.token(index);
			if (current === undefined) return;
			if (current.kind === "doc") {
				if (current.start.line !== lastDocumentationLine + 1) {
					documentation = [];
					documentationStart = undefined;
				}
				documentationStart ??= current;
				documentation.push(current.value);
				lastDocumentationLine = current.start.line;
				index++;
				continue;
			}
			if (current.kind === "newline") {
				index++;
				continue;
			}
			if (current.kind === "comment" || current.kind === "directive") {
				documentation = [];
				documentationStart = undefined;
				index++;
				continue;
			}
			if (syntaxValue(current) === "}") return;
			if (syntaxValue(current) === ";") {
				documentation = [];
				documentationStart = undefined;
				index++;
				continue;
			}
			const afterAttributes = this.skipAttributes(index, end);
			if (afterAttributes !== index) {
				index = afterAttributes;
				continue;
			}
			const doc =
				documentationStart === undefined ? undefined : this.documentationFor(documentation, documentationStart);
			const parsed = this.parseAt(index, end, parent, doc);
			if (parsed <= index) {
				index = this.skipUnknown(index, end);
			} else {
				index = parsed;
			}
			documentation = [];
			documentationStart = undefined;
			lastDocumentationLine = -2;
		}
	}

	private skipAttributes(index: number, end: number): number {
		const start = this.nextSignificant(index, end);
		if (start < 0 || this.value(start) !== "[") return index;
		const close = this.matching(start, "[", "]", end);
		if (close < 0) {
			this.report("Attribute list is not closed.", this.token(start));
			return end;
		}
		for (let current = start; current <= close; current++) {
			const item = this.token(current);
			if (item?.kind === "identifier") this.ignoredOffsets.add(item.startOffset);
		}
		return close + 1;
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
		doc: Documentation | undefined,
	): number {
		const first = this.nextSignificant(index, end);
		if (first < 0) return end;
		const item = this.token(first);
		if (item === undefined) return end;
		if (syntaxValue(item) === "global" && this.value(this.nextSignificant(first + 1, end)) === "using") {
			return this.parseUsing(first + 1, end, true);
		}
		if (syntaxValue(item) === "using") return this.parseUsing(first, end, false);
		if (syntaxValue(item) === "namespace") return this.parseNamespace(first, first, end, parent, doc);
		const modifiers = this.modifiersAt(first, end);
		const keyword = this.value(modifiers.index);
		if (keyword === "namespace") return this.parseNamespace(modifiers.index, modifiers.start, end, parent, doc);
		if (keyword !== undefined && isTypeDeclarationWord(keyword)) {
			return this.parseType(modifiers.index, modifiers.start, end, parent, doc, modifiers.modifiers);
		}
		if (keyword === "delegate")
			return this.parseDelegate(modifiers.index, modifiers.start, end, parent, doc, modifiers.modifiers);
		if (parent?.kind === "class" || parent?.kind === "struct" || parent?.kind === "interface") {
			return this.parseMember(first, modifiers, end, parent, doc);
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
			...(alias === undefined ? {} : { alias }),
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
		doc: Documentation | undefined,
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
				startToken: doc?.start ?? this.token(codeStartIndex) ?? keyword,
				endToken: this.tokens[this.tokens.length - 1] as Token,
				selectionStart: nameStart,
				selectionEnd: nameEnd,
				codeStart: this.token(codeStartIndex) ?? keyword,
				visibility: "public",
				exported: true,
				signature: this.signature(codeStartIndex, next),
				docComment: doc?.text,
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
			startToken: doc?.start ?? this.token(codeStartIndex) ?? keyword,
			endToken: this.token(close >= 0 ? close : bodyEnd - 1) ?? keyword,
			selectionStart: nameStart,
			selectionEnd: nameEnd,
			codeStart: this.token(codeStartIndex) ?? keyword,
			visibility: "public",
			exported: true,
			signature: this.signature(codeStartIndex, next),
			docComment: doc?.text,
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
		doc: Documentation | undefined,
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
			typeParameterClose = this.matchingAngle(afterName, end);
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
			startToken: doc?.start ?? this.token(codeStartIndex) ?? firstKeyword,
			endToken,
			selectionStart: nameToken,
			selectionEnd: nameToken,
			codeStart: this.token(codeStartIndex) ?? firstKeyword,
			visibility: visibilityFor(modifiers, parent, kind),
			exported: exportedFor(visibilityFor(modifiers, parent, kind), parent),
			isPartial: modifiers.has("partial"),
			signature: this.signature(codeStartIndex, codeEnd),
			docComment: doc?.text,
			bodyStartToken: bodyOpen < 0 ? undefined : this.token(bodyOpen),
			bodyEndToken: bodyClose < 0 ? undefined : this.token(bodyClose),
			nameTokenOffsets: [nameToken.startOffset],
		});
		this.markTypeParameters(typeParameterOpen, typeParameterClose, type);
		const primaryOpen = this.value(afterName) === "(" ? afterName : -1;
		const primaryClose = primaryOpen < 0 ? -1 : this.matching(primaryOpen, "(", ")", end);
		if (primaryClose >= 0) type.parameterCount = this.parseParameters(primaryOpen, primaryClose, type);
		if (!this.outline) this.markBaseTypes(nameIndex, bodyOpen >= 0 ? bodyOpen : codeEnd, type);
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

	private markBaseTypes(start: number, end: number, parent: RawDeclaration): void {
		let colon = -1;
		let current = this.nextSignificant(start + 1, end);
		while (current >= 0 && current < end) {
			const value = this.value(current);
			if (value === ":") {
				colon = current;
				break;
			}
			current = this.nextSignificant(current + 1, end);
		}
		if (colon < 0) return;
		let segmentStart = this.nextSignificant(colon + 1, end);
		const role: Reference["role"] = "extends";
		let segmentRole: Reference["role"] = parent.kind === "struct" ? "implements" : role;
		let depth = 0;
		for (let cursor = segmentStart; cursor <= end; cursor++) {
			const value = this.value(cursor);
			if (value === "<" || value === "[" || value === "(") depth++;
			else if (value === ">" || value === "]" || value === ")") depth--;
			if ((value === "," && depth === 0) || cursor === end) {
				const segmentEnd = value === "," ? cursor : end;
				this.addTypeReference(segmentStart, segmentEnd - 1, "typeUse");
				const first = this.nextSignificant(segmentStart, segmentEnd);
				const firstToken = this.token(first);
				if (firstToken?.kind === "identifier") this.roleByOffset.set(firstToken.startOffset, segmentRole);
				segmentRole = parent.kind === "interface" ? "extends" : "implements";
				segmentStart = this.nextSignificant(cursor + 1, end);
			}
		}
	}

	private addTypeReference(start: number, end: number, role: Reference["role"]): void {
		if (end < start) return;
		for (let current = start; current <= end; current++) {
			const item = this.token(current);
			if (item?.kind === "identifier" && !SKIPPED_WORDS.has(item.value)) {
				this.typeTokenIndices.add(current);
				this.roleByOffset.set(item.startOffset, role);
			}
		}
	}

	private parseEnumMembers(start: number, end: number, parent: RawDeclaration): void {
		let current = start;
		let pendingDoc: Documentation | undefined;
		while (current < end) {
			const item = this.token(current);
			if (item?.kind === "doc") {
				pendingDoc = { text: item.value, start: item };
				current++;
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
				startToken: pendingDoc?.start ?? name,
				endToken,
				selectionStart: name,
				selectionEnd: name,
				codeStart: name,
				visibility: "public",
				exported: parent.exported,
				docComment: pendingDoc?.text,
				nameTokenOffsets: [name.startOffset],
			});
			pendingDoc = undefined;
			current = this.value(finish) === "," ? finish + 1 : finish;
		}
	}

	private parseDelegate(
		keywordIndex: number,
		codeStartIndex: number,
		end: number,
		parent: RawDeclaration | undefined,
		doc: Documentation | undefined,
		modifiers: Set<string>,
	): number {
		const keyword = this.token(keywordIndex);
		if (keyword === undefined) return -1;
		const boundary = this.findSemicolon(keywordIndex + 1, end);
		if (boundary < 0) this.report("Delegate declaration has no terminating semicolon.", keyword);
		const finish = boundary < 0 ? end : boundary;
		const open = this.findTopLevelValue(keywordIndex + 1, finish, "(");
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
			startToken: doc?.start ?? this.token(codeStartIndex) ?? keyword,
			endToken: this.token(boundary >= 0 ? boundary : finish - 1) ?? name,
			selectionStart: name,
			selectionEnd: name,
			codeStart: this.token(codeStartIndex) ?? keyword,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.signature(codeStartIndex, boundary >= 0 ? boundary : finish),
			docComment: doc?.text,
			nameTokenOffsets: [name.startOffset],
		});
		const close = open < 0 ? -1 : this.matching(open, "(", ")", finish);
		delegate.parameterCount = close < 0 ? 0 : this.parseParameters(open, close, delegate);
		const typeSpan = this.spanBeforeName(keywordIndex + 1, nameIndex);
		this.recordTypeSpan(typeSpan, delegate);
		return boundary < 0 ? end : boundary + 1;
	}

	private parseMember(
		index: number,
		modifiers: ModifierInfo,
		end: number,
		parent: RawDeclaration,
		doc: Documentation | undefined,
	): number {
		const start = modifiers.index < end ? modifiers.index : index;
		if (this.value(start) === "event")
			return this.parseEvent(start, modifiers.start, end, parent, doc, modifiers.modifiers);
		const boundary = this.findMemberBoundary(start, end);
		if (boundary === undefined) {
			this.report("Member declaration needs a terminating delimiter.", this.token(start));
			return -1;
		}
		const open = this.findCallParen(start, boundary.index);
		if (open >= 0)
			return this.parseMethod(start, modifiers.start, boundary, open, end, parent, doc, modifiers.modifiers);
		if (boundary.kind === "body" || this.hasTopLevelArrow(start, boundary.index)) {
			const nameIndex = this.propertyName(start, boundary.index);
			if (nameIndex >= 0)
				return this.parseProperty(
					start,
					modifiers.start,
					boundary,
					nameIndex,
					end,
					parent,
					doc,
					modifiers.modifiers,
				);
		}
		return this.parseField(start, modifiers.start, boundary, end, parent, doc, modifiers.modifiers);
	}

	private parseMethod(
		start: number,
		codeStartIndex: number,
		boundary: Boundary,
		open: number,
		end: number,
		parent: RawDeclaration,
		doc: Documentation | undefined,
		modifiers: Set<string>,
	): number {
		const operator = this.operatorName(start, open);
		const nameIndex = operator?.end ?? this.methodNameIndex(open, start);
		const name = this.token(nameIndex);
		const declarationName = operator?.name ?? (isIdentifier(name) ? name.value : undefined);
		if (declarationName === undefined) {
			this.report("Method declaration needs a name.", this.token(open));
			return this.advanceBoundary(boundary, end);
		}
		const isConstructor = operator === undefined && declarationName === parent.name;
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
		const endIndex = bodyClose >= 0 ? bodyClose : boundary.kind === "semicolon" ? boundary.index : end - 1;
		const method = this.addDeclaration({
			kind,
			languageKind: operator === undefined ? (isConstructor ? "constructor" : "method") : "conversionOperator",
			name: declarationName,
			parent,
			startToken: doc?.start ?? this.token(codeStartIndex) ?? selectionStart,
			endToken: this.token(endIndex) ?? selectionEnd,
			selectionStart,
			selectionEnd,
			codeStart: this.token(codeStartIndex) ?? selectionStart,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.signature(codeStartIndex, boundary.index),
			docComment: doc?.text,
			bodyStartToken: boundary.kind === "body" ? this.token(boundary.index) : undefined,
			bodyEndToken: bodyClose >= 0 ? this.token(bodyClose) : undefined,
			nameTokenOffsets,
		});
		const typeSpan =
			operator === undefined
				? isConstructor
					? undefined
					: this.spanBeforeName(start, nameIndex)
				: { start: operator.start + 1, end: operator.end + 1 };
		this.recordTypeSpan(typeSpan, method);
		const genericOpen = this.nextSignificant(nameIndex + 1, open);
		if (this.value(genericOpen) === "<") {
			const genericClose = this.matchingAngle(genericOpen, open);
			if (genericClose >= 0) this.markTypeParameters(genericOpen, genericClose, method);
		}
		method.parameterCount = close < 0 ? 0 : this.parseParameters(open, close, method);
		if (boundary.kind === "body")
			this.parseLocalDeclarations(boundary.index + 1, bodyClose < 0 ? end : bodyClose, method);
		return this.advanceBoundary(boundary, end, bodyClose);
	}

	private parseParameters(open: number, close: number, parent: RawDeclaration | undefined): number {
		if (open < 0 || close < 0 || close <= open) return 0;
		const segments: Array<{ start: number; end: number }> = [];
		let segmentStart = open + 1;
		let parentheses = 0;
		let brackets = 0;
		let angles = 0;
		for (let current = open + 1; current < close; current++) {
			const value = this.value(current);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (value === "<") angles++;
			else if (value === ">") angles--;
			else if (value === ">>") angles -= 2;
			else if (value === "," && parentheses === 0 && brackets === 0 && angles === 0) {
				segments.push({ start: segmentStart, end: current });
				segmentStart = current + 1;
			}
		}
		segments.push({ start: segmentStart, end: close });
		if (parent === undefined) return segments.length;
		for (const segment of segments) this.addParameter(segment.start, segment.end, parent);
		parent.parameterCount = segments.filter(
			(segment) => this.findParameterName(segment.start, segment.end) >= 0,
		).length;
		return parent.parameterCount;
	}

	private findParameterName(start: number, end: number): number {
		let current = this.nextSignificant(start, end);
		let equals = end;
		let angle = 0;
		while (current >= 0 && current < end) {
			const value = this.value(current);
			if (value === "<") angle++;
			else if (value === ">") angle--;
			else if (value === ">>") angle -= 2;
			if (value === "=" && angle === 0) {
				equals = current;
				break;
			}
			current = this.nextSignificant(current + 1, end);
		}
		let last = this.previousSignificant(equals, start);
		while (last >= start && this.value(last) === "]") last = this.previousSignificant(last, start);
		return last;
	}

	private addParameter(start: number, end: number, parent: RawDeclaration): void {
		const nameIndex = this.findParameterName(start, end);
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
		const typeSpan = this.spanBeforeName(start, nameIndex);
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
			if (!explicit && !inferred) {
				statementStart = false;
				current = this.nextSignificant(current + 1, end);
				continue;
			}
			const nameToken = nextToken as Token;
			const finish = this.findSemicolon(next + 1, end);
			const endToken = this.token(finish >= 0 ? finish : next) ?? nameToken;
			const typeEnd = this.previousSignificant(next, current);
			const typeText =
				!this.outline && !inferred && typeEnd >= current
					? this.sourceSpan(item as Token, this.token(typeEnd) as Token)
					: undefined;
			const initializer = this.outline
				? undefined
				: this.initializerToken(current, finish >= 0 ? finish : end, next);
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
				...(typeText === undefined ? {} : { typeText, typeName: typeNameFromText(typeText) }),
				...(inferredType === undefined ? {} : { inferredType }),
				nameTokenOffsets: [nameToken.startOffset],
			});
			this.recordTypeSpan(explicit ? { start: current, end: next } : undefined, local);
			if (finish >= 0) current = finish + 1;
			else current = next + 1;
			statementStart = true;
		}
	}

	private parseProperty(
		start: number,
		codeStartIndex: number,
		boundary: Boundary,
		nameIndex: number,
		end: number,
		parent: RawDeclaration,
		doc: Documentation | undefined,
		modifiers: Set<string>,
	): number {
		const name = this.token(nameIndex);
		if (!isIdentifier(name)) return this.advanceBoundary(boundary, end);
		const close = boundary.kind === "body" ? this.matching(boundary.index, "{", "}", end) : -1;
		if (boundary.kind === "body" && close < 0)
			this.report("Property body is not closed.", this.token(boundary.index));
		const visibility = visibilityFor(modifiers, parent, "property");
		const property = this.addDeclaration({
			kind: "property",
			languageKind: "property",
			name: name.value,
			parent,
			startToken: doc?.start ?? this.token(codeStartIndex) ?? name,
			endToken: this.token(close >= 0 ? close : boundary.index) ?? name,
			selectionStart: name,
			selectionEnd: name,
			codeStart: this.token(codeStartIndex) ?? name,
			visibility,
			exported: exportedFor(visibility, parent),
			signature: this.signature(codeStartIndex, boundary.index),
			docComment: doc?.text,
			...(this.outline ? {} : { typeText: this.typeTextBeforeName(start, nameIndex) }),
			nameTokenOffsets: [name.startOffset],
		});
		this.recordTypeSpan(this.spanBeforeName(start, nameIndex), property);
		if (close >= 0) {
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
		doc: Documentation | undefined,
		modifiers: Set<string>,
	): number {
		const boundary = this.findMemberBoundary(start, end);
		if (boundary === undefined) {
			this.report("Event declaration needs a terminating delimiter.", this.token(start));
			return -1;
		}
		const finish = boundary.kind === "semicolon" ? boundary.index : boundary.index;
		const segments = this.declaratorSegments(start + 1, finish);
		const firstSegment = segments[0];
		const firstNameIndex =
			firstSegment === undefined ? -1 : this.findDeclaratorName(firstSegment.start, firstSegment.end);
		const firstName = this.token(firstNameIndex);
		if (!isIdentifier(firstName)) {
			this.report("Event declaration needs a name.", this.token(start));
			return this.advanceBoundary(boundary, end);
		}
		const close = boundary.kind === "body" ? this.matching(boundary.index, "{", "}", end) : -1;
		const visibility = visibilityFor(modifiers, parent, "event");
		const typeText = this.outline ? undefined : this.typeTextBeforeName(start + 1, firstNameIndex);
		for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
			const segment = segments[segmentIndex] as { start: number; end: number };
			const nameIndex = this.findDeclaratorName(segment.start, segment.end);
			const name = this.token(nameIndex);
			if (!isIdentifier(name)) continue;
			this.ignoredOffsets.add(name.startOffset);
			const event = this.addDeclaration({
				kind: "event",
				languageKind: "event",
				name: name.value,
				parent,
				startToken: doc?.start ?? this.token(codeStartIndex) ?? name,
				endToken: this.token(close >= 0 ? close : boundary.index) ?? name,
				selectionStart: name,
				selectionEnd: name,
				codeStart: this.token(codeStartIndex) ?? name,
				visibility,
				exported: exportedFor(visibility, parent),
				signature: this.signature(codeStartIndex, boundary.index),
				docComment: segmentIndex === 0 ? doc?.text : undefined,
				...(typeText === undefined ? {} : { typeText, typeName: typeNameFromText(typeText) }),
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
		doc: Documentation | undefined,
		modifiers: Set<string>,
	): number {
		const finish = boundary.kind === "semicolon" ? boundary.index : this.advanceBoundary(boundary, end);
		const segments = this.declaratorSegments(start, finish);
		if (segments.length === 0) {
			this.report("Field declaration needs a name.", this.token(start));
			return this.advanceBoundary(boundary, end);
		}
		const firstName = this.findDeclaratorName(segments[0]?.start ?? start, segments[0]?.end ?? finish);
		const firstNameToken = this.token(firstName);
		if (!isIdentifier(firstNameToken)) {
			this.report("Field declaration needs a name.", this.token(start));
			return this.advanceBoundary(boundary, end);
		}
		const typeText = this.outline ? undefined : this.typeTextBeforeName(start, firstName);
		const kind: SymbolKind = modifiers.has("const") ? "constant" : "field";
		const visibility = visibilityFor(modifiers, parent, kind);
		for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
			const segment = segments[segmentIndex] as { start: number; end: number };
			const nameIndex = this.findDeclaratorName(segment.start, segment.end);
			const name = this.token(nameIndex);
			if (!isIdentifier(name)) continue;
			this.ignoredOffsets.add(name.startOffset);
			const initializer = this.initializerToken(segment.start, segment.end, nameIndex);
			const inferredType =
				!this.outline && typeText === undefined && initializer !== undefined
					? displayForLiteral(initializer)
					: undefined;
			const field = this.addDeclaration({
				kind,
				languageKind: kind === "constant" ? "const" : "field",
				name: name.value,
				parent,
				startToken: doc?.start ?? this.token(codeStartIndex) ?? name,
				endToken: this.token(boundary.index) ?? name,
				selectionStart: name,
				selectionEnd: name,
				codeStart: this.token(codeStartIndex) ?? name,
				visibility,
				exported: exportedFor(visibility, parent),
				signature: this.signature(codeStartIndex, boundary.index),
				docComment: segmentIndex === 0 ? doc?.text : undefined,
				...(typeText === undefined ? {} : { typeText, typeName: typeNameFromText(typeText) }),
				...(inferredType === undefined ? {} : { inferredType }),
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

	private findCallParen(start: number, end: number): number {
		let brackets = 0;
		let angles = 0;
		for (let current = start; current < end; current++) {
			const value = this.value(current);
			if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (value === "<") angles++;
			else if (value === ">") angles--;
			else if (value === ">>") angles -= 2;
			else if (value === "=" || value === "=>") return -1;
			else if (value === "(" && brackets === 0 && angles === 0) return current;
		}
		return -1;
	}

	private methodNameIndex(open: number, start: number): number {
		const nameIndex = this.previousSignificant(open, start);
		if (nameIndex < 0 || (this.value(nameIndex) !== ">" && this.value(nameIndex) !== ">>")) return nameIndex;
		let depth = 0;
		for (let current = nameIndex; current >= start; current--) {
			const value = this.value(current);
			if (value === ">") depth++;
			else if (value === ">>") depth += 2;
			else if (value === "<") {
				depth--;
				if (depth <= 0) return this.previousSignificant(current, start);
			}
		}
		return nameIndex;
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

	private hasTopLevelArrow(start: number, end: number): boolean {
		return this.findTopLevelValue(start, end, "=>") >= 0;
	}

	private findTopLevelValue(start: number, end: number, value: string): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let current = start; current < end; current++) {
			const item = this.token(current);
			if (isTrivia(item)) continue;
			const itemValue = syntaxValue(item);
			if (itemValue === value && parentheses === 0 && brackets === 0 && braces === 0) return current;
			if (itemValue === "(") parentheses++;
			else if (itemValue === ")") parentheses--;
			else if (itemValue === "[") brackets++;
			else if (itemValue === "]") brackets--;
			else if (itemValue === "{") braces++;
			else if (itemValue === "}") braces--;
		}
		return -1;
	}

	private findSemicolon(start: number, end: number): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let current = start; current < end; current++) {
			const value = this.value(current);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (value === "{") braces++;
			else if (value === "}") braces--;
			else if (value === ";" && parentheses === 0 && brackets === 0 && braces === 0) return current;
		}
		return -1;
	}

	private lastIdentifier(start: number, end: number): number {
		let found = -1;
		for (let current = start; current < end; current++) {
			if (this.token(current)?.kind === "identifier") found = current;
		}
		return found;
	}

	private declaratorSegments(start: number, end: number): Array<{ start: number; end: number }> {
		const segments: Array<{ start: number; end: number }> = [];
		let segmentStart = start;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		let angles = 0;
		for (let current = start; current < end; current++) {
			const value = this.value(current);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (value === "{") braces++;
			else if (value === "}") braces--;
			else if (value === "<") angles++;
			else if (value === ">") angles--;
			else if (value === ">>") angles -= 2;
			else if (value === "," && parentheses === 0 && brackets === 0 && braces === 0 && angles === 0) {
				segments.push({ start: segmentStart, end: current });
				segmentStart = current + 1;
			}
		}
		segments.push({ start: segmentStart, end });
		return segments;
	}

	private findDeclaratorName(start: number, end: number): number {
		let current = this.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const item = this.token(current);
			if (item?.kind === "identifier") {
				const next = this.nextSignificant(current + 1, end);
				const nextValue = this.value(next);
				if (next < 0 || next >= end || nextValue === "=" || nextValue === "[" || nextValue === ",")
					return current;
			}
			current = this.nextSignificant(current + 1, end);
		}
		return -1;
	}

	private initializerToken(start: number, end: number, nameIndex: number): Token | undefined {
		let current = this.nextSignificant(nameIndex + 1, end);
		if (this.value(current) !== "=") return undefined;
		current = this.nextSignificant(current + 1, end);
		const item = this.token(current);
		return item?.kind === "string" || item?.kind === "number" || item?.kind === "boolean" ? item : undefined;
	}

	private isLocalNameFollower(index: number): boolean {
		const value = this.value(index);
		return value === "=" || value === ";" || value === "," || value === "[";
	}

	private spanBeforeName(start: number, nameIndex: number): TypeSpan | undefined {
		let first = this.nextSignificant(start, nameIndex);
		while (first >= 0 && first < nameIndex && MODIFIERS.has(this.value(first) ?? "")) {
			first = this.nextSignificant(first + 1, nameIndex);
		}
		const last = this.previousSignificant(nameIndex, first < 0 ? start : first);
		if (first < 0 || last < first || last >= nameIndex) return undefined;
		return { start: first, end: last + 1 };
	}

	private typeTextBeforeName(start: number, nameIndex: number): string | undefined {
		const span = this.spanBeforeName(start, nameIndex);
		if (span === undefined) return undefined;
		const text = this.sourceSpan(this.token(span.start) as Token, this.token(span.end - 1) as Token);
		return text === "var" ? undefined : text;
	}

	private sourceSpan(start: Token, end: Token): string {
		return this.cursor.textBetween(start.startOffset, end.endOffset).trim();
	}

	private signature(start: number, end: number): string | undefined {
		const first = this.token(this.nextSignificant(start, end));
		const last = this.token(this.previousSignificant(end, start));
		if (first === undefined || last === undefined) return undefined;
		return this.sourceSpan(first, last);
	}

	private recordTypeSpan(span: TypeSpan | undefined, declaration: RawDeclaration): void {
		if (this.outline || span === undefined) return;
		for (let current = span.start; current < span.end; current++) {
			const item = this.token(current);
			if (item?.kind === "identifier" && !MODIFIERS.has(item.value)) this.typeTokenIndices.add(current);
		}
		if (declaration.typeText === undefined) {
			const first = this.token(span.start);
			const last = this.token(span.end - 1);
			if (first !== undefined && last !== undefined) {
				const text = this.sourceSpan(first, last);
				if (text !== "var") {
					declaration.typeText = text;
					declaration.typeName = typeNameFromText(text);
				}
			}
		}
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
		if (input.kind === "method" || input.kind === "constructor" || input.kind === "function") {
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

	private pathFor(raw: RawDeclaration, cache: Map<RawDeclaration, string>): string {
		const cached = cache.get(raw);
		if (cached !== undefined) return cached;
		const parentPath = raw.parent === undefined ? [] : this.descriptorPath(raw.parent, cache);
		const id =
			raw.localOrdinal === undefined
				? composeSymbolId({
						language: LANGUAGE,
						module: this.module,
						descriptors: [...parentPath, raw.descriptor as Descriptor],
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
		if (raw.descriptor !== undefined) path.push(raw.descriptor);
		return path;
	}

	private namespaceName(raw: RawDeclaration | undefined): string {
		const names: string[] = [];
		let current = raw;
		while (current !== undefined) {
			if (current.kind === "namespace") names.unshift(current.name);
			current = current.parent;
		}
		return names.join(".");
	}

	private typePath(raw: RawDeclaration | undefined): string {
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
				...(raw.languageKind === undefined ? {} : { languageKind: raw.languageKind }),
				name: raw.name,
				range: { start: raw.startToken.start, end: raw.endToken.end },
				selectionRange: { start: raw.selectionStart.start, end: raw.selectionEnd.end },
				visibility: raw.visibility,
				exported: raw.exported,
				...(raw.signature === undefined ? {} : { signature: raw.signature }),
				...(raw.docComment === undefined ? {} : { docComment: raw.docComment }),
				...(containerId === undefined ? {} : { containerId }),
				metrics,
			};
			declarations.push(declaration);
			metadata.set(symbolId, {
				declaration,
				startOffset: raw.startToken.startOffset,
				endOffset: raw.endToken.endOffset,
				namespaceName: this.namespaceName(raw.parent),
				typePath: this.typePath(raw.parent),
				...(containerId === undefined ? {} : { parentId: containerId }),
				...(raw.typeText === undefined ? {} : { typeText: raw.typeText }),
				...(raw.typeName === undefined ? {} : { typeName: raw.typeName }),
				...(raw.inferredType === undefined ? {} : { inferredType: raw.inferredType }),
				...(raw.isPartial === undefined ? {} : { isPartial: raw.isPartial }),
				...(raw.bodyStartToken === undefined ? {} : { bodyStartOffset: raw.bodyStartToken.endOffset }),
				...(raw.bodyEndToken === undefined ? {} : { bodyEndOffset: raw.bodyEndToken.startOffset }),
				...(raw.parameterCount === undefined ? {} : { parameterCount: raw.parameterCount }),
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
		const add = (token: Token, role: Reference["role"], name = token.value): void => {
			const key = `${token.startOffset}:${role}`;
			if (added.has(key)) return;
			added.add(key);
			const container = this.containerAt(token.startOffset, metadata);
			references.push({
				name,
				range: positionRange(token),
				role,
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
			if (previousValue === "new") {
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

	private tokenForRange(range: Range): Token | undefined {
		return this.tokens.find((item) => comparePositions(item.start, range.start) === 0);
	}

	private containerAt(offset: number, metadata: Map<string, DeclarationMeta>): DeclarationMeta | undefined {
		let selected: DeclarationMeta | undefined;
		for (const item of metadata.values()) {
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
		return this.lexed.comments.map((item) => ({ range: positionRange(item), text: item.raw }));
	}
}
