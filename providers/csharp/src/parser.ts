import {
	type CommentSpan,
	comparePositions,
	composeSymbolId,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	defined,
	type FileRole,
	type HeaderFold,
	type ImportedName,
	type Literal,
	type Metrics,
	type OffsetRange,
	qualifierDescriptors,
	type Range,
	type Reference,
	renderHeader,
	type SymbolKind,
} from "@nyaa-lexicon/protocol";
import { Cursor } from "./cursor.js";
import { type LexedSource, lastLine, positionRange, type Token, tokenize } from "./tokens.js";

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
	isStatic?: boolean;
}

export interface CsharpFacts {
	module: string;
	text: string;
	role: FileRole;
	declarations: Declaration[];
	references: Reference[];
	imports: CsharpImport[];
	literals: Literal[];
	comments: CommentSpan[];
	blankLines: number[];
	diagnostics: Diagnostic[];
	metadata: Map<string, DeclarationMeta>;
	namespaceNames: string[];
	/** Attribute name positions, as `positionKey`. */
	attributeNames: Set<string>;
}

export function positionKey(position: Range["start"]): string {
	return `${position.line}:${position.character}`;
}

/** Doc comment or attribute start. */
interface Leading {
	start: Token;
	/** First attached attribute section's index, where the header starts. */
	attributes: number | undefined;
}

/** A later declarator: the shared lead ends before `from`, its own span starts at `to`. */
interface HeaderSkip {
	from: number;
	to: number;
}

/** Each type bracket `<` by token index, to the index of the `>` or `>>` closing it. */
type AnglePairs = ReadonlyMap<number, number>;

/** Type bracket pairs found so far, and the header's folded groups by opener index. */
interface BracketWalk {
	pairs: Map<number, number>;
	folded: ReadonlyMap<number, number>;
}

interface AttributeSection {
	open: number;
	close: number;
	/** Assembly and module targets attach to nothing. */
	attached: boolean;
}

interface RawDeclaration {
	kind: SymbolKind;
	qualifier?: string[];
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
	typeText?: string | undefined;
	typeName?: string | undefined;
	inferredType?: string | undefined;
	isPartial?: boolean | undefined;
	bodyStartToken?: Token | undefined;
	bodyEndToken?: Token | undefined;
	parameterCount?: number | undefined;
	isStatic?: boolean | undefined;
	memberInsertLine?: number | undefined;
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

/** Type read from tokens. */
interface TypeShape {
	/** Past its last token. */
	end: number;
	/** Rightmost simple name; none for tuples. */
	name: Token | undefined;
	/** Tuple element names. */
	elementNames: number[];
}

interface LeadingType {
	first: number;
	shape: TypeShape;
}

/** Deeper is no type. */
const MAX_TYPE_DEPTH = 32;

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

/** May precede a type. */
const TYPE_PREFIXES = new Set([...MODIFIERS, "this", "params", "checked"]);

const ASSIGNMENT_WORDS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "??="]);

const ACCESSOR_KEYWORDS = new Set(["get", "set", "init", "add", "remove"]);

const STATEMENT_BOUNDARY = new Set([";", "{", "}"]);

const LAMBDA_ATTRIBUTE_CONTEXT = new Set(["(", ",", "=>", "return", ...ASSIGNMENT_WORDS]);

const CONSTRAINT_KEYWORDS = new Set(["class", "struct", "notnull", "unmanaged", "default", "new"]);

/** A `[` or `(` after these opens a value. */
const VALUE_OPENERS = new Set(["=", "(", ",", "=>", ":", "??", "?"]);

/** Their parenthesized operand is a type. */
const TYPE_OPERATORS = new Set(["typeof", "default", "sizeof", "nameof"]);

/** Keywords that may follow a value. */
const VALUE_FOLLOWERS = new Set(["is", "as", "switch", "with"]);

/** After `()`: lambda params, a type argument, or another argument before `,`. */
const NOT_TUPLE_FOLLOWERS = new Set(["=>", ",", ">", ">>"]);

/** Member access and qualifier operators. */
const MEMBER_OPERATORS = new Set([".", "?.", "->", "::"]);

/** After a type argument list in an expression, these keep it one. */
const TYPE_ARGUMENT_FOLLOWERS = new Set([
	"(",
	")",
	"]",
	"}",
	":",
	";",
	",",
	".",
	"?",
	"?.",
	"==",
	"!=",
	"|",
	"^",
	"&&",
	"||",
	"&",
	"[",
	"{",
	"=>",
	"<",
	"<=",
	">=",
	"is",
	"as",
]);

const GROUP_CLOSERS = new Map([
	["(", ")"],
	["[", "]"],
	["{", "}"],
]);

/** Punctuation a type argument list holds outside its groups. */
const TYPE_LIST_PUNCTUATION = new Set([",", ".", "::", "?", "*", "<", ">", ">>", "(", "["]);

const EMPTY_MAP: ReadonlyMap<number, number> = new Map();

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

function earliest(left: Token | undefined, right: Token | undefined): Token | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return left.startOffset <= right.startOffset ? left : right;
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
	private readonly attributeNames = new Set<string>();
	private readonly accessorBodyRanges: Array<{ start: number; end: number }> = [];
	/** Type argument list openers known to stay open up to this index. */
	private readonly openLists = new Map<number, number>();
	private readonly diagnostics: Diagnostic[];
	private readonly reportedDiagnostics = new Set<string>();
	private readonly scopeCounts = new Map<RawDeclaration | undefined, Map<string, number>>();
	private skippedFileScope = false;
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

	/** Closer of the group or type argument list at `index`; `index` when none opens, `end` when unclosed. */
	private closeOf(index: number, angles: AnglePairs, end: number): number {
		const value = this.value(index);
		if (value === "<") return angles.get(index) ?? index;
		const closer = value === undefined ? undefined : GROUP_CLOSERS.get(value);
		if (value === undefined || closer === undefined) return index;
		const close = this.matching(index, value, closer, end);
		return close < 0 ? end : close;
	}

	/** Split at the commas outside groups and type argument lists. */
	private commaSegments(start: number, end: number, angles: AnglePairs = this.typeAngles(start, end)): TypeSpan[] {
		const segments: TypeSpan[] = [];
		let segmentStart = start;
		for (let current = start; current < end; current = this.closeOf(current, angles, end) + 1) {
			if (this.value(current) !== ",") continue;
			segments.push({ start: segmentStart, end: current });
			segmentStart = current + 1;
		}
		segments.push({ start: segmentStart, end });
		return segments;
	}

	/** First `value` outside groups and type argument lists. */
	private topLevelValue(start: number, end: number, value: string, angles: AnglePairs): number {
		for (let current = start; current < end; current = this.closeOf(current, angles, end) + 1) {
			if (this.value(current) === value) return current;
		}
		return -1;
	}

	/** The outermost type argument list `close` ends; -1 when none. */
	private listEndingAt(close: number, angles: AnglePairs): number {
		let found = -1;
		for (const [open, end] of angles) if (end === close && (found < 0 || open < found)) found = open;
		return found;
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

	private parseScope(start: number, end: number, parent: RawDeclaration | undefined): void {
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
	private attributeSectionAt(index: number, end: number): AttributeSection | undefined {
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

	/** Where a `nameof` operand's type portion ends, through its first generic instantiation. */
	private genericOperandEnd(start: number, end: number): number | undefined {
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
	private markNewInstantiation(newIndex: number): void {
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

	/** Where a run of `[...]` sections ends, without marking them. */
	private bracketedSectionsEnd(index: number, end: number): number {
		let current = index;
		for (;;) {
			const open = this.nextSignificant(current, end);
			if (open < 0 || this.value(open) !== "[") return current;
			const close = this.matching(open, "[", "]", end);
			if (close < 0) return current;
			current = close + 1;
		}
	}

	private looksLikeLambdaSignature(index: number, end: number): boolean {
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
	private precededByDelegateKeyword(parenIndex: number): boolean {
		let current = this.previousSignificant(parenIndex);
		while (this.value(current) === "static" || this.value(current) === "async") {
			current = this.previousSignificant(current);
		}
		return this.value(current) === "delegate";
	}

	/** Whether a local function signature follows, never a bare call. */
	private looksLikeLocalFunctionSignature(index: number, end: number): boolean {
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

	private findDeclaratorName(start: number, end: number, angles: AnglePairs): number {
		for (let current = start; current < end; current = this.closeOf(current, angles, end) + 1) {
			if (!isIdentifier(this.token(current))) continue;
			const next = this.nextSignificant(current + 1, end);
			const nextValue = this.value(next);
			if (next < 0 || nextValue === "=" || nextValue === "[" || nextValue === ",") return current;
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

	/** Undefined when no type starts here. */
	private typeShape(start: number, end: number, depth = 0): TypeShape | undefined {
		if (depth > MAX_TYPE_DEPTH) return undefined;
		const shape: TypeShape = { end: -1, name: undefined, elementNames: [] };
		let current = this.nextSignificant(start, end);
		let expectName = true;
		let qualifiable = false;
		while (current >= 0 && current < end) {
			const item = this.token(current);
			const value = syntaxValue(item);
			let next = current + 1;
			if (expectName) {
				if (isIdentifier(item)) {
					shape.name = item;
					qualifiable = true;
				} else if (value === "(" && shape.end < 0) {
					next = this.tupleClose(current, end, shape.elementNames, depth + 1) + 1;
					if (next <= 0) return undefined;
				} else break;
				expectName = false;
			} else if (value === "*" && shape.name?.value === "delegate") {
				// Function pointer signature.
				const open = this.findTopLevelValue(next, end, "<");
				const pairs = open < 0 ? EMPTY_MAP : this.listWalk(open, end, depth + 1);
				const close = pairs.get(open) ?? -1;
				if (close < 0) break;
				this.typeArguments(open, close, shape.elementNames, depth + 1, pairs);
				next = close + 1;
				qualifiable = false;
			} else if (value === "<" && qualifiable) {
				const pairs = this.listWalk(current, end, depth + 1);
				const close = pairs.get(current) ?? -1;
				this.typeArguments(current, close < 0 ? end : close, shape.elementNames, depth + 1, pairs);
				// Closed by an outer `>>`.
				if (close < 0) {
					shape.end = end;
					break;
				}
				next = close + 1;
			} else if ((value === "." || value === "::") && qualifiable) {
				expectName = true;
			} else if (value === "?" || value === "*") {
				qualifiable = false;
			} else if (value === "[") {
				const close = this.matching(current, "[", "]", end);
				if (close < 0) break;
				next = close + 1;
				qualifiable = false;
			} else break;
			if (!expectName) shape.end = next;
			current = this.nextSignificant(next, end);
		}
		return shape.end < 0 ? undefined : shape;
	}

	/** -1 when not a tuple type. */
	private tupleClose(open: number, end: number, names: number[], depth: number): number {
		const close = this.matching(open, "(", ")", end);
		if (close < 0) return -1;
		const segments = this.commaSegments(open + 1, close, this.typeAngles(open + 1, close, false, depth));
		if (segments.length < 2) return -1;
		const found: number[] = [];
		for (const segment of segments) {
			const element = this.typeShape(segment.start, segment.end, depth);
			if (element === undefined) return -1;
			found.push(...element.elementNames);
			const name = this.nextSignificant(element.end, segment.end);
			if (name < 0) continue;
			if (!isIdentifier(this.token(name)) || this.nextSignificant(name + 1, segment.end) >= 0) return -1;
			found.push(name);
		}
		names.push(...found);
		return close;
	}

	/** Tuple names in type arguments. */
	private typeArguments(open: number, close: number, names: number[], depth: number, angles: AnglePairs): void {
		for (const segment of this.commaSegments(open + 1, close, angles)) {
			names.push(...(this.typeShape(segment.start, segment.end, depth)?.elementNames ?? []));
		}
	}

	/** Past modifier words. */
	private leadingType(span: TypeSpan): LeadingType | undefined {
		let first = this.nextSignificant(span.start, span.end);
		while (first >= 0 && TYPE_PREFIXES.has(this.value(first) ?? ""))
			first = this.nextSignificant(first + 1, span.end);
		const shape = first < 0 ? undefined : this.typeShape(first, span.end);
		return shape === undefined ? undefined : { first, shape };
	}

	private declaredType(span: TypeSpan | undefined): { typeText?: string; typeName?: string } {
		if (this.outline || span === undefined) return {};
		return this.typeFacts(this.leadingType(span));
	}

	/** `var` declares neither. */
	private typeFacts(leading: LeadingType | undefined): { typeText?: string; typeName?: string } {
		if (leading === undefined) return {};
		const first = this.token(leading.first) as Token;
		const last = this.token(this.previousSignificant(leading.shape.end, leading.first)) as Token;
		if (first === last && first.value === "var") return {};
		const name = leading.shape.name?.value;
		return {
			typeText: this.sourceSpan(first, last),
			...(name === undefined || BUILTIN_TYPES.has(name) ? {} : { typeName: name }),
		};
	}

	/** Searched past the type. */
	private firstDeclaratorName(start: number, end: number, angles: AnglePairs): number {
		const type = this.typeShape(start, end);
		const name = type === undefined ? -1 : this.findDeclaratorName(type.end, end, angles);
		return name >= 0 ? name : this.findDeclaratorName(start, end, angles);
	}

	/** A tuple-typed local's name, or -1. */
	private tupleLocalName(start: number, end: number): number {
		if (this.value(start) !== "(") return -1;
		const type = this.typeShape(start, end);
		const name = type === undefined ? -1 : this.nextSignificant(type.end, end);
		if (!isIdentifier(this.token(name))) return -1;
		return this.isLocalNameFollower(this.nextSignificant(name + 1, end)) ? name : -1;
	}

	private sourceSpan(start: Token, end: Token): string {
		return this.cursor.textBetween(start.startOffset, end.endOffset).trim();
	}

	/** Token `first` through the last significant token before `end`, on one line. */
	private header(first: number, end: number, skip?: HeaderSkip): string | undefined {
		const last = this.previousSignificant(end, first);
		const head = this.token(first);
		const tail = this.token(last);
		if (last < first || head === undefined || tail === undefined) return undefined;
		const folds: HeaderFold[] = [];
		/** Opener index to closer index. */
		const folded = new Map<number, number>();
		const omit: OffsetRange[] = [];
		const verbatim: OffsetRange[] = [];
		let lead: OffsetRange | undefined;
		let start = head.startOffset;
		let previous: Token | undefined;
		let before = -1;
		for (let index = first; index <= last; index++) {
			const item = this.tokens[index] as Token;
			if (index === skip?.from) {
				const shared = this.token(before);
				if (shared !== undefined) lead = { start, end: shared.endOffset };
				start = (this.tokens[skip.to] as Token).startOffset;
				index = skip.to - 1;
				previous = undefined;
				continue;
			}
			if (previous !== undefined && this.lexed.droppedBefore.has(item))
				omit.push({ start: previous.endOffset, end: item.startOffset });
			previous = item;
			if (item.kind === "comment" || item.kind === "doc" || item.kind === "directive") {
				omit.push({ start: item.startOffset, end: item.endOffset });
				continue;
			}
			if (item.kind === "newline") continue;
			if (item.kind === "string" || item.kind === "character")
				verbatim.push({ start: item.startOffset, end: item.endOffset });
			const close = this.valueContainerEnd(index, before, last);
			if (close > index) {
				const closeToken = this.tokens[close] as Token;
				folds.push({ start: item.startOffset, end: closeToken.endOffset });
				folded.set(index, close);
				index = close;
				previous = closeToken;
			}
			before = index;
		}
		return renderHeader(this.text, {
			...(lead === undefined ? {} : { lead }),
			start,
			end: tail.endOffset,
			folds,
			omit,
			verbatim,
			angles:
				skip === undefined
					? this.typeBrackets(first, last + 1, folded)
					: [...this.typeBrackets(first, skip.from, folded), ...this.typeBrackets(skip.to, last + 1, folded)],
		});
	}

	/** Offsets of the `<` and `>` read as type brackets; folded groups are never walked. */
	private typeBrackets(start: number, end: number, folded: ReadonlyMap<number, number>): number[] {
		const walk: BracketWalk = { pairs: new Map(), folded };
		this.bracketsIn(start, end, false, walk, 0);
		const offsets: number[] = [];
		// A `>>` closing two lists closes the inner with its first half.
		const halves = new Map<number, number>();
		for (const [open, close] of [...walk.pairs].sort((left, right) => right[0] - left[0])) {
			const half = halves.get(close) ?? 0;
			halves.set(close, half + 1);
			offsets.push((this.tokens[open] as Token).startOffset, (this.tokens[close] as Token).startOffset + half);
		}
		return offsets;
	}

	/** The type bracket pairs of a span that starts as a type, or as a value. */
	private typeAngles(start: number, end: number, value = false, depth = 0): AnglePairs {
		const walk: BracketWalk = { pairs: new Map(), folded: EMPTY_MAP };
		this.bracketsIn(start, end, value, walk, depth);
		return walk.pairs;
	}

	/** The `>` or `>>` closing the type argument list opening at `open`; -1 when none does before `end`. */
	private listClose(open: number, end: number): number {
		return this.listWalk(open, end, 0).get(open) ?? -1;
	}

	/** The pairs of the type argument list opening at `open`, its own included once it closes. */
	private listWalk(open: number, end: number, depth: number): AnglePairs {
		const walk: BracketWalk = { pairs: new Map(), folded: EMPTY_MAP };
		this.bracketsIn(open + 1, end, false, walk, depth, open);
		return walk.pairs;
	}

	/**
	 * A value group keeps a type argument list only where the grammar's disambiguation does.
	 *
	 * With `opened`, the walk is inside the list opening there and stops once it closes, or at a
	 * token no type argument list holds. A list it leaves open stays open in a walk of its own, so
	 * each is remembered.
	 */
	private bracketsIn(
		start: number,
		end: number,
		value: boolean,
		walk: BracketWalk,
		depth: number,
		opened?: number,
	): void {
		if (depth > MAX_TYPE_DEPTH) return;
		const lists: number[] = opened === undefined ? [] : [opened];
		let inValue = value;
		let afterColon = false;
		let previous = -1;
		for (
			let current = this.nextSignificant(start, end);
			current >= 0 && current < end;
			current = this.nextSignificant(current + 1, end)
		) {
			const item = this.token(current) as Token;
			const text = syntaxValue(item);
			const typed = lists.length > 0 || !inValue;
			if (opened !== undefined && !isIdentifier(item) && !TYPE_LIST_PUNCTUATION.has(text ?? "")) break;
			if (text === "<" && this.opensTypeList(previous, current, end, typed, depth)) {
				lists.push(current);
			} else if ((text === ">" || text === ">>") && lists.length > 0) {
				// A `>>` with a half to spare leaves the opened list unclosed.
				if (text === ">>" && lists.length === 1 && opened !== undefined) break;
				walk.pairs.set(lists.pop() as number, current);
				// One `>>` closes two lists.
				if (text === ">>" && lists.length > 0) walk.pairs.set(lists.pop() as number, current);
				if (lists.length === 0 && opened !== undefined) return;
			} else if (text === "operator" && typed) {
				// Its symbol, `>>>` being two tokens.
				let symbol = this.nextSignificant(current + 1, end);
				while (this.token(symbol)?.kind === "punctuation" && this.value(symbol) !== "(") {
					current = symbol;
					symbol = this.nextSignificant(symbol + 1, end);
				}
			} else if (text === "(" || text === "[" || text === "{") {
				const fold = walk.folded.get(current);
				const close = fold ?? this.matching(current, text, GROUP_CLOSERS.get(text) as string, end);
				if (close < 0) break;
				const holdsValue = this.groupHoldsValue(text, previous, typed, afterColon, lists.length > 0);
				if (fold === undefined) this.bracketsIn(current + 1, close, holdsValue, walk, depth + 1);
				current = close;
			} else if (lists.length === 0) {
				if (text === "=") inValue = true;
				else if (text === ",") inValue = value;
				else if (text === ":" && !inValue) afterColon = true;
			}
			previous = current;
		}
		if (opened === undefined) return;
		for (const open of lists) this.openLists.set(open, Math.max(this.openLists.get(open) ?? -1, end));
	}

	private opensTypeList(previous: number, open: number, end: number, typed: boolean, depth: number): boolean {
		const before = this.token(previous);
		if (!typed) return isIdentifier(before) && this.expressionTypeArguments(open, end, depth);
		if (isIdentifier(before)) return true;
		// Function pointer.
		return syntaxValue(before) === "*" && this.value(this.previousSignificant(previous)) === "delegate";
	}

	/** Types only, then a follower that keeps the list. */
	private expressionTypeArguments(open: number, end: number, depth: number): boolean {
		if ((this.openLists.get(open) ?? -1) >= end) return false;
		const pairs = this.listWalk(open, end, depth + 1);
		const close = pairs.get(open);
		if (close === undefined) return false;
		for (const segment of this.commaSegments(open + 1, close, pairs)) {
			const shape = this.typeShape(segment.start, segment.end, depth + 1);
			if (shape === undefined || this.nextSignificant(shape.end, segment.end) >= 0) return false;
		}
		const follower = this.token(this.nextSignificant(close + 1));
		return follower?.kind === "eof" || TYPE_ARGUMENT_FOLLOWERS.has(syntaxValue(follower) ?? "");
	}

	/** Parameter lists, tuples, typeof operands and indexer parameters hold types. */
	private groupHoldsValue(
		open: string,
		previous: number,
		typed: boolean,
		afterColon: boolean,
		inList: boolean,
	): boolean {
		if (open === "{") return true;
		const before = this.value(previous) ?? "";
		if (open === "[") return !(typed && before === "this");
		if (!typed) return !TYPE_OPERATORS.has(before);
		// Base and constructor initializer arguments.
		return !inList && afterColon;
	}

	/** Where a literal container opening at `index` closes; -1 when none does. */
	private valueContainerEnd(index: number, before: number, last: number): number {
		const value = this.value(index);
		if (value === "{") return this.matching(index, "{", "}", last + 1);
		const opener = this.value(before);
		if (opener === undefined || !VALUE_OPENERS.has(opener)) return -1;
		if (value === "[") {
			const close = this.matching(index, "[", "]", last + 1);
			if (close < 0 || this.declaresAfter(close, last)) return -1;
			// `a?[0]` indexes; `c ? [0] : d` is a branch.
			return opener === "?" && this.value(this.nextSignificant(close + 1, last + 1)) !== ":" ? -1 : close;
		}
		if (value !== "(") return -1;
		if (opener === "(" && TYPE_OPERATORS.has(this.value(this.previousSignificant(before)) ?? "")) return -1;
		const close = this.matching(index, "(", ")", last + 1);
		if (close < 0 || this.findTopLevelValue(index + 1, close, ",") < 0) return -1;
		// The comma may sit inside type arguments.
		if (this.commaSegments(index + 1, close, this.typeAngles(index + 1, close, true)).length < 2) return -1;
		const after = this.value(this.nextSignificant(close + 1, last + 1)) ?? "";
		return NOT_TUPLE_FOLLOWERS.has(after) || this.declaresAfter(close, last) ? -1 : close;
	}

	/** A name or type after `close` makes the brackets an attribute or a tuple type. */
	private declaresAfter(close: number, last: number): boolean {
		const next = this.token(this.nextSignificant(close + 1, last + 1));
		if (isIdentifier(next)) return !VALUE_FOLLOWERS.has(next.value);
		const value = syntaxValue(next);
		return value === "(" || value === "[" || value === "?";
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

	/** Its line when nothing precedes it there. */
	private closerLine(close: number): number | undefined {
		const closer = close < 0 ? undefined : this.token(close);
		if (closer === undefined) return undefined;
		let previous = close - 1;
		while (this.token(previous)?.kind === "newline") previous--;
		const before = this.token(previous);
		return before === undefined || lastLine(before) < closer.start.line ? closer.start.line : undefined;
	}

	/** Past the line break after the last code in the span. */
	private lineAfterLast(from: number, end: number): number | undefined {
		let last = from;
		for (let index = from + 1; index < end; index++) {
			const kind = this.token(index)?.kind;
			if (kind !== "newline" && kind !== "comment" && kind !== "doc" && kind !== "eof") last = index;
		}
		for (let index = last + 1; index < this.tokens.length; index++) {
			const item = this.token(index) as Token;
			if (item.kind === "newline") return item.start.line + 1;
		}
		return undefined;
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

	private pathFor(raw: RawDeclaration, cache: Map<RawDeclaration, string>): string {
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
