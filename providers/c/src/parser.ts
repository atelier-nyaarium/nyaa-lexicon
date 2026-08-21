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
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import { type CToken, lexC, previousSignificant, significant, syntaxValue, tokenRange } from "./tokens.js";

const LANGUAGE = "c";

type DescriptorPath = Descriptor[];

export interface CImportFact {
	specifier: string;
	imported: ImportedName[];
	reExport: boolean;
	kind: "quoted" | "angle";
	range?: Range;
}

export interface CTypeAnswer {
	display: string;
	typeName?: string;
}

export interface CDeclaration extends Declaration {
	descriptorPath: DescriptorPath;
	startOffset: number;
	endOffset: number;
	selectionIndex: number;
	conditionalKey: string;
	conditionalGroup: string;
	isDefinition?: boolean;
	typeText?: string;
	typeRange?: Range;
}

export interface CReference extends Reference {
	tokenIndex: number;
}

export interface ParsedCFile {
	module: string;
	declarations: CDeclaration[];
	declarationsByName: Map<string, CDeclaration[]>;
	declarationsById: Map<string, CDeclaration>;
	references: CReference[];
	imports: CImportFact[];
	literals: Literal[];
	comments: CommentSpan[];
	diagnostics: Diagnostic[];
	typeAnswers: Map<string, CTypeAnswer>;
}

interface Directive {
	start: number;
	end: number;
	keyword: string;
	keywordIndex: number;
}

interface ConditionalFrame {
	id: number;
	branch: number;
}

interface DelimiterEntry {
	value: string;
	index: number;
	aliases: number[];
}

interface ConditionalDelimiterFrame {
	baseDepth: number;
	branches: DelimiterEntry[][];
}

interface AggregateInfo {
	keyword: "struct" | "union" | "enum";
	keywordIndex: number;
	tagIndex: number;
	bodyOpen: number;
	bodyClose: number;
}

interface DeclaratorName {
	nameIndex: number;
	nameEndIndex: number;
	name: string;
	typeStart: number;
	typeEnd: number;
	typeText: string;
	typeName?: string;
}

interface FunctionCandidate {
	nameIndex: number;
	nameEndIndex: number;
	name: string;
	open: number;
	close: number;
}

interface Statement {
	start: number;
	last: number;
	next: number;
	terminator: "semicolon" | "body" | "eof";
	bodyOpen?: number;
	bodyClose?: number;
}

interface ScopeContext {
	kind: "file" | "function";
	parentPath: DescriptorPath;
	containerId?: string;
}

interface Candidate {
	name: string;
	declarationKind: Declaration["kind"];
	descriptorKind: Descriptor["kind"];
	languageKind?: string;
	rangeStartIndex: number;
	rangeEndIndex: number;
	selectionIndex: number;
	selectionEndIndex?: number;
	parentPath: DescriptorPath;
	visibility: Declaration["visibility"];
	exported?: boolean;
	signature?: string;
	metrics?: Metrics;
	typeText?: string;
	typeStartIndex?: number;
	typeEndIndex?: number;
	typeName?: string;
	conditionalKey: string;
	conditionalGroup: string;
	isDefinition?: boolean;
}

const C_KEYWORDS = new Set([
	"alignas",
	"alignof",
	"asm",
	"auto",
	"break",
	"case",
	"char",
	"const",
	"continue",
	"default",
	"do",
	"double",
	"else",
	"enum",
	"extern",
	"float",
	"for",
	"goto",
	"if",
	"inline",
	"int",
	"long",
	"register",
	"restrict",
	"return",
	"short",
	"signed",
	"sizeof",
	"static",
	"struct",
	"switch",
	"typedef",
	"union",
	"unsigned",
	"void",
	"volatile",
	"while",
	"_Alignas",
	"_Alignof",
	"_Atomic",
	"_Bool",
	"_Complex",
	"_Generic",
	"_Imaginary",
	"_Noreturn",
	"_Static_assert",
	"_Thread_local",
	"bool",
	"false",
	"true",
	"typeof",
	"__asm",
	"__asm__",
	"__attribute__",
	"__declspec",
	"__extension__",
	"__inline",
	"__inline__",
	"__restrict",
	"__restrict__",
	"__volatile__",
]);

const STORAGE_WORDS = new Set([
	"auto",
	"extern",
	"inline",
	"register",
	"static",
	"typedef",
	"_Thread_local",
	"__extension__",
	"__inline",
	"__inline__",
]);

const TYPE_QUALIFIERS = new Set([
	"const",
	"restrict",
	"volatile",
	"_Atomic",
	"__const",
	"__const__",
	"__restrict",
	"__restrict__",
	"__volatile",
	"__volatile__",
]);

const CALLING_CONVENTIONS = new Set([
	"__cdecl",
	"__fastcall",
	"__stdcall",
	"__thiscall",
	"__vectorcall",
	"__usercall",
	"__userpurge",
	"__noreturn",
	"__forceinline",
	"__packed",
	"__interrupt",
	"__far",
	"__near",
	"__ptr32",
	"__ptr64",
]);

const BUILTIN_TYPES = new Set([
	"char",
	"double",
	"float",
	"int",
	"long",
	"short",
	"signed",
	"unsigned",
	"void",
	"_Bool",
	"bool",
	"size_t",
	"ssize_t",
	"ptrdiff_t",
	"wchar_t",
	"int8_t",
	"int16_t",
	"int32_t",
	"int64_t",
	"uint8_t",
	"uint16_t",
	"uint32_t",
	"uint64_t",
	"intptr_t",
	"uintptr_t",
	"byte",
	"word",
	"dword",
	"qword",
	"code",
	"undefined",
	"undefined1",
	"undefined2",
	"undefined3",
	"undefined4",
	"undefined5",
	"undefined6",
	"undefined7",
	"undefined8",
	"undefined9",
	"undefined10",
	"uint",
	"uint8",
	"uint16",
	"uint32",
	"uint64",
	"int8",
	"int16",
	"int32",
	"int64",
	"uchar",
	"ushort",
	"ulong",
	"ulonglong",
	"__int8",
	"__int16",
	"__int32",
	"__int64",
	"BOOL",
	"BYTE",
	"WORD",
	"DWORD",
	"QWORD",
	"HANDLE",
	"LPCSTR",
	"LPCWSTR",
]);

const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Map([
	[")", "("],
	["]", "["],
	["}", "{"],
]);

function isIdentifierToken(token: CToken | undefined): token is CToken & { kind: "identifier" } {
	return token?.kind === "identifier";
}

function tokenValue(tokens: CToken[], index: number): string {
	return syntaxValue(tokens[index]);
}

function nextCode(tokens: CToken[], index: number, end = tokens.length): number {
	let current = index;
	while (current < end) {
		const token = tokens[current] as CToken;
		if (token.kind !== "comment" && token.kind !== "newline") return current;
		current++;
	}
	return end;
}

function previousCode(tokens: CToken[], index: number): number {
	let current = index - 1;
	while (current >= 0) {
		const token = tokens[current] as CToken;
		if (token.kind !== "comment" && token.kind !== "newline") return current;
		current--;
	}
	return -1;
}

interface QualifiedName {
	name: string;
	startIndex: number;
	endIndex: number;
	identifierIndices: number[];
}

function qualifiedNameAt(tokens: CToken[], start: number, end: number): QualifiedName | undefined {
	const startIndex = nextCode(tokens, start, end);
	let index = startIndex;
	const leading = tokenValue(tokens, index) === "::";
	if (leading) index = nextCode(tokens, index + 1, end);
	if (!isIdentifierToken(tokens[index])) return undefined;
	const first = index;
	const parts: string[] = [];
	const identifierIndices: number[] = [];
	let last = index;
	while (index < end) {
		const token = tokens[index];
		if (!isIdentifierToken(token)) break;
		parts.push(token.value);
		identifierIndices.push(index);
		last = index;
		const separator = nextCode(tokens, index + 1, end);
		if (tokenValue(tokens, separator) !== "::") break;
		const next = nextCode(tokens, separator + 1, end);
		if (!isIdentifierToken(tokens[next])) break;
		index = next;
	}
	return {
		name: `${leading ? "::" : ""}${parts.join("::")}`,
		startIndex: leading ? startIndex : first,
		endIndex: last,
		identifierIndices,
	};
}

function qualifiedNameForIdentifier(tokens: CToken[], index: number, end: number): QualifiedName | undefined {
	if (!isIdentifierToken(tokens[index])) return undefined;
	let component = index;
	let separator = previousSignificant(tokens, component);
	while (tokenValue(tokens, separator) === "::") {
		const left = previousSignificant(tokens, separator);
		if (isIdentifierToken(tokens[left])) {
			component = left;
			separator = previousSignificant(tokens, component);
			continue;
		}
		return qualifiedNameAt(tokens, separator, end);
	}
	return qualifiedNameAt(tokens, component, end);
}

function descriptorKey(path: DescriptorPath): string {
	return path
		.map((descriptor) => `${descriptor.kind}:${descriptor.name}:${descriptor.disambiguator ?? ""}`)
		.join("/");
}

function containsPosition(range: Range, position: Range["start"]): boolean {
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

function renderTokens(tokens: CToken[], start: number, end: number): string {
	const parts: string[] = [];
	let previous: CToken | undefined;
	for (let index = start; index < end; index++) {
		const token = tokens[index] as CToken | undefined;
		if (token === undefined || token.kind === "comment" || token.kind === "newline") continue;
		const needsSpace =
			previous !== undefined &&
			(previous.kind === "identifier" ||
				previous.kind === "number" ||
				previous.kind === "string" ||
				previous.kind === "char") &&
			(token.kind === "identifier" ||
				token.kind === "number" ||
				token.kind === "string" ||
				token.kind === "char");
		parts.push(`${needsSpace ? " " : ""}${token.raw}`);
		previous = token;
	}
	return parts.join("").trim();
}

function typeWords(value: string): boolean {
	return (
		BUILTIN_TYPES.has(value) ||
		C_KEYWORDS.has(value) ||
		STORAGE_WORDS.has(value) ||
		TYPE_QUALIFIERS.has(value) ||
		CALLING_CONVENTIONS.has(value)
	);
}

function isSpecifierWord(value: string): boolean {
	return (
		BUILTIN_TYPES.has(value) ||
		STORAGE_WORDS.has(value) ||
		TYPE_QUALIFIERS.has(value) ||
		CALLING_CONVENTIONS.has(value) ||
		value === "_Alignas" ||
		value === "_Atomic" ||
		value === "__attribute__" ||
		value === "__declspec"
	);
}

function isTypeToken(token: CToken | undefined): boolean {
	return (
		token?.kind === "identifier" &&
		!C_KEYWORDS.has(token.value) &&
		!STORAGE_WORDS.has(token.value) &&
		!CALLING_CONVENTIONS.has(token.value) &&
		!TYPE_QUALIFIERS.has(token.value)
	);
}

interface NumericValue {
	valid: boolean;
	number?: number;
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function exactInteger(value: string): NumericValue {
	try {
		const exact = BigInt(value);
		return exact > MAX_SAFE_INTEGER_BIGINT ? { valid: true } : { valid: true, number: Number(exact) };
	} catch {
		return { valid: false };
	}
}

function numberValue(raw: string): NumericValue {
	const clean = raw.replaceAll("_", "");
	const integerSuffix = /[uUlL]+$/u;
	const prefixed = /^0[xXbB]/u.test(clean);
	if (prefixed) {
		const integer = clean.replace(integerSuffix, "");
		if (/^0[xX][0-9A-Fa-f]+$/u.test(integer)) return exactInteger(integer);
		if (/^0[bB][01]+$/u.test(integer)) return exactInteger(integer);
	}

	const integer = clean.replace(integerSuffix, "");
	if (/^\d+$/u.test(integer)) {
		const octal = /^0[0-7]+$/u.test(integer) && integer.length > 1 ? `0o${integer.slice(1)}` : integer;
		return exactInteger(octal);
	}

	const floating = clean.replace(/[fFlL]+$/u, "");
	if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(floating)) return { valid: false };
	const parsed = Number(floating);
	return Number.isFinite(parsed) ? { valid: true, number: parsed } : { valid: false };
}

function rangeForTokens(tokens: CToken[], start: number, end: number): Range | undefined {
	const first = tokens[start];
	const last = tokens[end];
	if (first === undefined || last === undefined) return undefined;
	return { start: first.start, end: last.end };
}

function lineCount(start: CToken, end: CToken): number {
	return end.end.line - start.start.line + 1;
}

function docBefore(tokens: CToken[], start: number): number | undefined {
	let comments = 0;
	let first = start;
	let lineBreaks = 0;
	for (let index = start - 1; index >= 0; index--) {
		const token = tokens[index] as CToken;
		if (token.kind === "newline") {
			lineBreaks++;
			if (lineBreaks > comments + 1) break;
			continue;
		}
		if (token.kind !== "comment") break;
		if (token.doc === undefined) return undefined;
		comments++;
		first = index;
	}
	return comments === 0 ? undefined : first;
}

function declarationRangeStart(tokens: CToken[], start: number): number {
	return docBefore(tokens, start) ?? start;
}

function hasTopLevelValue(tokens: CToken[], start: number, end: number, wanted: string): boolean {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = start; index < end; index++) {
		const value = syntaxValue(tokens[index]);
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else if (value === "{") braces++;
		else if (value === "}") braces--;
		else if (value === wanted && parentheses === 0 && brackets === 0 && braces === 0) return true;
	}
	return false;
}

function stripTypeText(value: string): string {
	return value
		.replace(/\b(?:static|extern|typedef|inline|register|auto|_Thread_local|__extension__)\b/gu, "")
		.replace(
			/\b(?:const|restrict|volatile|__const|__const__|__restrict|__restrict__|__volatile|__volatile__)\b/gu,
			"",
		)
		.replace(/\s+/gu, " ")
		.trim();
}

export function parseC(module: string, text: string): ParsedCFile {
	const lexed = lexC(module, text);
	const parser = new CParser(module, lexed.tokens, lexed.comments, lexed.diagnostics);
	return parser.parse();
}

class CParser {
	private readonly pairs = new Map<number, number>();
	private readonly directives = new Map<number, Directive>();
	private readonly directiveEndByToken = new Map<number, number>();
	private readonly conditionalByIndex = new Map<number, string>();
	private readonly conditionalGroupByIndex = new Map<number, string>();
	private readonly directiveTokens = new Set<number>();
	private readonly includePathTokens = new Set<number>();
	private readonly declarationNameIndices = new Set<number>();
	private readonly qualifiedNameIndices = new Set<number>();
	private readonly typeUseIndices = new Set<number>();
	private readonly declarations: CDeclaration[] = [];
	private readonly references: CReference[] = [];
	private readonly imports: CImportFact[] = [];
	private readonly literals: Literal[] = [];
	private readonly typeAnswers = new Map<string, CTypeAnswer>();
	private readonly canonicalDeclarations = new Map<string, CDeclaration>();
	private readonly typeNames = new Set<string>();
	private containerByToken: Array<CDeclaration | undefined> = [];
	private readonly diagnostics: Diagnostic[];
	private readonly descriptorCounts = new Map<string, number>();
	private conditionalSerial = 0;

	constructor(
		private readonly module: string,
		private readonly tokens: CToken[],
		private readonly comments: CommentSpan[],
		initialDiagnostics: Diagnostic[],
	) {
		this.diagnostics = [...initialDiagnostics];
	}

	parse(): ParsedCFile {
		this.buildDirectives();
		this.buildPairs();
		this.buildConditionals();
		this.extractIncludesAndMacros();
		this.parseScope(0, this.tokens.length, { kind: "file", parentPath: [] });
		this.buildContainerIndex();
		this.extractLiterals();
		this.extractReferences();
		const declarationsByName = new Map<string, CDeclaration[]>();
		const declarationsById = new Map<string, CDeclaration>();
		for (const declaration of this.declarations) {
			declarationsById.set(declaration.symbolId, declaration);
			const named = declarationsByName.get(declaration.name);
			if (named === undefined) declarationsByName.set(declaration.name, [declaration]);
			else named.push(declaration);
		}
		this.diagnostics.sort((left, right) => {
			const a = left.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
			const b = right.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
			return comparePositions(a, b);
		});
		return {
			module: this.module,
			declarations: this.declarations,
			declarationsByName,
			declarationsById,
			references: this.references,
			imports: this.imports,
			literals: this.literals,
			comments: this.comments,
			diagnostics: this.diagnostics,
			typeAnswers: this.typeAnswers,
		};
	}

	private addDiagnostic(message: string, start: number, end = start): void {
		const first = this.tokens[start];
		const last = this.tokens[end] ?? first;
		if (first === undefined) return;
		this.diagnostics.push({
			severity: "error",
			message,
			path: this.module,
			range: { start: first.start, end: last?.end ?? first.end },
		});
	}

	private buildPairs(): void {
		const stack: DelimiterEntry[] = [];
		const conditionals: ConditionalDelimiterFrame[] = [];
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as CToken;
			const directive = this.directives.get(index);
			if (directive !== undefined) {
				if (["if", "ifdef", "ifndef"].includes(directive.keyword)) {
					conditionals.push({ baseDepth: stack.length, branches: [] });
				} else if (["elif", "else"].includes(directive.keyword)) {
					const frame = conditionals.at(-1);
					if (frame !== undefined) {
						frame.branches.push(stack.splice(frame.baseDepth));
					}
				} else if (directive.keyword === "endif") {
					const frame = conditionals.pop();
					if (frame !== undefined) {
						frame.branches.push(stack.splice(frame.baseDepth));
						const representative = frame.branches.find((branch) => branch.length > 0) ?? [];
						const aliases = frame.branches.filter((branch) => branch !== representative);
						for (let branchIndex = 0; branchIndex < representative.length; branchIndex++) {
							const entry = representative[branchIndex] as DelimiterEntry;
							for (const branch of aliases) {
								const alias = branch[branchIndex];
								if (alias?.value === entry.value) entry.aliases.push(alias.index);
							}
						}
						stack.push(...representative);
					}
				}
				index = Math.max(index, directive.end - 1);
				continue;
			}
			if (this.directiveTokens.has(index)) continue;
			if (token.kind !== "symbol") continue;
			if (OPENERS.has(token.value)) {
				stack.push({ value: token.value, index, aliases: [] });
				continue;
			}
			const opening = CLOSERS.get(token.value);
			if (opening === undefined) continue;
			const top = stack.at(-1);
			if (top?.value !== opening) {
				this.addDiagnostic(`Unexpected closing delimiter ${token.raw}.`, index);
				continue;
			}
			stack.pop();
			this.pairs.set(top.index, index);
			this.pairs.set(index, top.index);
			for (const alias of top.aliases) this.pairs.set(alias, index);
		}
		for (const open of stack)
			this.addDiagnostic(`Opening ${open.value} is not closed before end of file.`, open.index);
	}

	private directiveEnd(start: number): number {
		let index = start + 1;
		while (index < this.tokens.length) {
			const token = this.tokens[index] as CToken;
			if (token.kind === "newline") {
				let previous = index - 1;
				while (previous >= start && this.tokens[previous]?.kind === "comment") previous--;
				if (previous >= start && tokenValue(this.tokens, previous) === "\\") {
					index++;
					continue;
				}
				return index;
			}
			index++;
		}
		return this.tokens.length;
	}

	private buildDirectives(): void {
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as CToken;
			if (token.kind !== "symbol" || token.value !== "#" || !token.lineStart) continue;
			const end = this.directiveEnd(index);
			const keywordIndex = nextCode(this.tokens, index + 1, end);
			const keywordToken = this.tokens[keywordIndex];
			if (keywordToken?.kind !== "identifier") continue;
			this.directives.set(index, { start: index, end, keyword: keywordToken.value, keywordIndex });
			for (let member = index; member < end; member++) {
				this.directiveTokens.add(member);
				this.directiveEndByToken.set(member, end);
			}
			index = Math.max(index, end - 1);
		}
	}

	private buildConditionals(): void {
		const stack: ConditionalFrame[] = [];
		for (let index = 0; index < this.tokens.length; index++) {
			const key = stack.map((frame) => `${frame.id}:${frame.branch}`).join("|");
			const group = stack.map((frame) => String(frame.id)).join("|");
			this.conditionalByIndex.set(index, key);
			this.conditionalGroupByIndex.set(index, group);
			const directive = this.directives.get(index);
			if (directive === undefined) continue;
			switch (directive.keyword) {
				case "if":
				case "ifdef":
				case "ifndef":
					this.conditionalSerial++;
					stack.push({ id: this.conditionalSerial, branch: 0 });
					break;
				case "elif":
				case "else": {
					const frame = stack.at(-1);
					if (frame !== undefined) frame.branch++;
					break;
				}
				case "endif":
					stack.pop();
					break;
				default:
					break;
			}
		}
	}

	private extractIncludesAndMacros(): void {
		for (const [index, directive] of this.directives) {
			if (directive.keyword === "include" || directive.keyword === "include_next")
				this.extractInclude(index, directive);
			if (directive.keyword === "define") this.extractMacro(index, directive);
		}
	}

	private extractInclude(index: number, directive: Directive): void {
		let cursor = nextCode(this.tokens, directive.keywordIndex + 1, directive.end);
		if (cursor >= directive.end) return;
		const first = this.tokens[cursor] as CToken;
		let specifier = "";
		let kind: "quoted" | "angle";
		let pathStart = cursor;
		let pathEnd = cursor;
		if (first.kind === "string") {
			specifier = first.value;
			kind = "quoted";
			this.includePathTokens.add(cursor);
			pathEnd = cursor;
		} else if (syntaxValue(first) === "<") {
			kind = "angle";
			cursor++;
			pathStart = cursor;
			const pieces: string[] = [];
			while (cursor < directive.end && tokenValue(this.tokens, cursor) !== ">") {
				const token = this.tokens[cursor] as CToken;
				if (token.kind !== "comment" && token.kind !== "newline") {
					pieces.push(token.raw);
					this.includePathTokens.add(cursor);
					pathEnd = cursor;
				}
				cursor++;
			}
			specifier = pieces.join("");
		} else {
			return;
		}
		if (specifier === "") return;
		const firstPath = this.tokens[pathStart];
		const lastPath = this.tokens[pathEnd];
		const pathRange =
			firstPath === undefined || lastPath === undefined
				? undefined
				: { start: firstPath.start, end: lastPath.end };
		this.imports.push({
			specifier,
			imported: [],
			reExport: false,
			kind,
			...(pathRange === undefined ? {} : { range: pathRange }),
		});
	}

	private extractMacro(index: number, directive: Directive): void {
		const nameIndex = nextCode(this.tokens, directive.keywordIndex + 1, directive.end);
		const nameToken = this.tokens[nameIndex];
		if (!isIdentifierToken(nameToken)) return;
		const next = nextCode(this.tokens, nameIndex + 1, directive.end);
		const functionLike =
			tokenValue(this.tokens, next) === "(" && this.tokens[next]?.startOffset === nameToken.endOffset;
		const last = previousCode(this.tokens, directive.end);
		const rangeStartIndex = declarationRangeStart(this.tokens, index);
		const declaration = this.addCandidate({
			name: nameToken.value,
			declarationKind: functionLike ? "function" : "constant",
			descriptorKind: functionLike ? "method" : "term",
			languageKind: "macro",
			rangeStartIndex,
			rangeEndIndex: last < index ? index : last,
			selectionIndex: nameIndex,
			parentPath: [],
			visibility: "public",
			exported: true,
			signature: renderTokens(this.tokens, index, Math.max(index, last + 1)),
			conditionalKey: this.conditionalByIndex.get(index) ?? "",
			conditionalGroup: this.conditionalGroupByIndex.get(index) ?? "",
		});
		if (declaration === undefined) return;
		this.declarationNameIndices.add(nameIndex);
		for (let member = index; member < directive.end; member++) this.directiveTokens.add(member);
	}

	private extractAggregateInfo(start: number, end: number): AggregateInfo | undefined {
		let keywordIndex = nextCode(this.tokens, start, end);
		if (tokenValue(this.tokens, keywordIndex) === "typedef")
			keywordIndex = nextCode(this.tokens, keywordIndex + 1, end);
		const keyword = tokenValue(this.tokens, keywordIndex);
		if (keyword !== "struct" && keyword !== "union" && keyword !== "enum") return undefined;
		const possibleTag = nextCode(this.tokens, keywordIndex + 1, end);
		const tagIndex =
			isIdentifierToken(this.tokens[possibleTag]) && tokenValue(this.tokens, possibleTag) !== "{"
				? possibleTag
				: -1;
		let bodyOpen =
			tagIndex < 0 ? nextCode(this.tokens, keywordIndex + 1, end) : nextCode(this.tokens, tagIndex + 1, end);
		if (tokenValue(this.tokens, bodyOpen) !== "{") bodyOpen = -1;
		const bodyClose = bodyOpen < 0 ? -1 : (this.pairs.get(bodyOpen) ?? -1);
		return { keyword, keywordIndex, tagIndex, bodyOpen, bodyClose };
	}

	private parseScope(start: number, end: number, context: ScopeContext): void {
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("C parser failed to advance");
			guard = index;
			index = nextCode(this.tokens, index, end);
			if (index >= end) return;
			if (this.directiveTokens.has(index)) {
				index = this.directiveEndByToken.get(index) ?? index + 1;
				continue;
			}
			if (tokenValue(this.tokens, index) === "}") return;
			const statement = this.findStatement(index, end);
			if (statement === undefined || statement.next <= index) {
				index++;
				continue;
			}
			this.parseStatement(statement, context);
			index = statement.next;
		}
	}

	private findStatement(start: number, end: number): Statement | undefined {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		const conditionals: Array<{ parentheses: number; brackets: number; braces: number }> = [];
		let index = start;
		while (index < end) {
			const directive = this.directives.get(index);
			if (directive !== undefined) {
				if (["if", "ifdef", "ifndef"].includes(directive.keyword)) {
					conditionals.push({ parentheses, brackets, braces });
				} else if (["elif", "else"].includes(directive.keyword)) {
					const frame = conditionals.at(-1);
					parentheses = frame?.parentheses ?? 0;
					brackets = frame?.brackets ?? 0;
					braces = frame?.braces ?? 0;
				} else if (directive.keyword === "endif") {
					conditionals.pop();
				}
				index = directive.end;
				continue;
			}
			if (this.directiveTokens.has(index)) {
				index = this.directiveEndByToken.get(index) ?? index + 1;
				continue;
			}
			const token = this.tokens[index] as CToken;
			if (token.kind === "comment" || token.kind === "newline") {
				index++;
				continue;
			}
			const value = syntaxValue(token);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") {
				if (parentheses === 0 && brackets === 0 && braces === 0) {
					const functionCandidate = this.findFunctionCandidate(start, index);
					if (functionCandidate !== undefined) {
						const close = this.pairs.get(index) ?? end - 1;
						return {
							start,
							last: close,
							next: Math.min(end, close + 1),
							terminator: "body",
							bodyOpen: index,
							bodyClose: close,
						};
					}
				}
				braces++;
			} else if (value === "}") {
				if (braces === 0 && parentheses === 0 && brackets === 0)
					return { start, last: index - 1, next: index, terminator: "eof" };
				braces--;
			} else if (value === ";" && parentheses === 0 && brackets === 0 && braces === 0) {
				return { start, last: index, next: index + 1, terminator: "semicolon" };
			}
			index++;
		}
		return start < end ? { start, last: Math.max(start, end - 1), next: end, terminator: "eof" } : undefined;
	}

	private findFunctionCandidate(start: number, beforeBody: number): FunctionCandidate | undefined {
		let parentheses = 0;
		let brackets = 0;
		for (let index = start; index < beforeBody; index++) {
			const token = this.tokens[index] as CToken;
			if (token.kind === "comment" || token.kind === "newline" || this.directiveTokens.has(index)) continue;
			const value = syntaxValue(token);
			if (value === "[") {
				brackets++;
				continue;
			}
			if (value === "]") {
				brackets = Math.max(0, brackets - 1);
				continue;
			}
			if (value === "(") {
				if (parentheses !== 0 || brackets !== 0) {
					parentheses++;
					continue;
				}
				const close = this.pairs.get(index);
				const previous = previousCode(this.tokens, index);
				const name = this.tokens[previous];
				const qualified =
					previous < 0 ? undefined : qualifiedNameForIdentifier(this.tokens, previous, beforeBody);
				if (
					close === undefined ||
					close >= beforeBody ||
					!isIdentifierToken(name) ||
					C_KEYWORDS.has(name.value) ||
					qualified === undefined
				)
					continue;
				if (hasTopLevelValue(this.tokens, start, index, "=")) continue;
				return {
					nameIndex: qualified.startIndex,
					nameEndIndex: qualified.endIndex,
					name: qualified.name,
					open: index,
					close,
				};
			}
			if (value === ")") parentheses = Math.max(0, parentheses - 1);
		}
		return undefined;
	}

	private parseStatement(statement: Statement, context: ScopeContext): void {
		const contentEnd = statement.terminator === "semicolon" ? statement.last : statement.last + 1;
		const first = this.skipLabels(nextCode(this.tokens, statement.start, contentEnd), contentEnd);
		if (first >= contentEnd || this.directiveTokens.has(first)) return;
		const aggregate = this.extractAggregateInfo(first, contentEnd);
		if (aggregate !== undefined) {
			this.parseAggregate(statement, aggregate, context);
			return;
		}
		const functionCandidate = this.findFunctionCandidate(first, contentEnd);
		if (
			functionCandidate !== undefined &&
			(context.kind === "file" || this.looksLikeDeclaration(first, contentEnd))
		) {
			this.parseFunction(statement, functionCandidate, context);
			return;
		}
		if (context.kind === "function" && !this.looksLikeDeclaration(first, contentEnd)) {
			this.parseControlHeaderDeclarations(context, first, contentEnd);
			return;
		}
		this.parseVariables(statement, context, first, contentEnd);
		if (statement.terminator === "eof" && context.kind === "file" && this.looksLikeDeclaration(first, contentEnd)) {
			this.addDiagnostic("Declaration has no terminating semicolon.", first);
		}
	}

	private skipLabels(start: number, end: number): number {
		let index = start;
		while (index < end && isIdentifierToken(this.tokens[index])) {
			const colon = nextCode(this.tokens, index + 1, end);
			if (tokenValue(this.tokens, colon) !== ":") return index;
			index = nextCode(this.tokens, colon + 1, end);
		}
		return index;
	}

	private parseControlHeaderDeclarations(context: ScopeContext, start: number, end: number): void {
		if (tokenValue(this.tokens, start) !== "for") return;
		const open = nextCode(this.tokens, start + 1, end);
		if (tokenValue(this.tokens, open) !== "(") return;
		const close = this.pairs.get(open);
		if (close === undefined || close <= open) return;
		const first = nextCode(this.tokens, open + 1, close);
		const separator = this.topLevelIndex(first, close, new Set([";"]));
		if (separator < 0 || !this.looksLikeDeclaration(first, separator)) return;
		this.parseVariables(
			{ start: first, last: separator, next: separator + 1, terminator: "semicolon" },
			context,
			first,
			separator,
		);
	}

	private looksLikeDeclaration(start: number, end: number): boolean {
		const token = this.tokens[start];
		if (token === undefined) return false;
		if (token.kind !== "identifier") return false;
		if (token.value === "struct" || token.value === "union" || token.value === "enum" || token.value === "typedef")
			return true;
		if (isSpecifierWord(token.value)) return true;
		if (C_KEYWORDS.has(token.value)) return false;
		const next = nextCode(this.tokens, start + 1, end);
		return isIdentifierToken(this.tokens[next]) || tokenValue(this.tokens, next) === "*";
	}

	private parseFunction(statement: Statement, candidate: FunctionCandidate, context: ScopeContext): void {
		const rangeStartIndex = declarationRangeStart(this.tokens, statement.start);
		const endIndex = statement.terminator === "body" ? (statement.bodyClose ?? statement.last) : statement.last;
		const returnType = this.typeTextBefore(statement.start, candidate.nameIndex);
		const visibility =
			context.kind === "file"
				? hasTopLevelValue(this.tokens, statement.start, candidate.nameIndex, "static")
					? "fileLocal"
					: "public"
				: "local";
		const exported = context.kind === "file" ? visibility === "public" : false;
		const body = statement.terminator === "body" && statement.bodyOpen !== undefined;
		const metrics = body
			? this.functionMetrics(
					statement.bodyOpen as number,
					statement.bodyClose ?? statement.last,
					candidate.open,
					candidate.close,
				)
			: {
					lines: lineCount(this.tokens[rangeStartIndex] as CToken, this.tokens[endIndex] as CToken),
					parameters: this.parameterCount(candidate.open, candidate.close),
				};
		const declaration = this.addCandidate({
			name: candidate.name,
			declarationKind: "function",
			descriptorKind: "method",
			...(body ? {} : { languageKind: "prototype" }),
			rangeStartIndex,
			rangeEndIndex: endIndex,
			selectionIndex: candidate.nameIndex,
			selectionEndIndex: candidate.nameEndIndex,
			parentPath: context.parentPath,
			visibility,
			exported,
			signature: renderTokens(
				this.tokens,
				statement.start,
				statement.terminator === "body" ? (statement.bodyOpen ?? endIndex) : endIndex + 1,
			),
			metrics,
			typeText: returnType.text,
			typeStartIndex: returnType.start,
			typeEndIndex: returnType.end,
			...(returnType.typeName === undefined ? {} : { typeName: returnType.typeName }),
			conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
			conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
			isDefinition: body,
		});
		if (declaration === undefined) return;
		this.markQualifiedName(candidate.nameIndex, candidate.nameEndIndex);
		this.markTypeRange(returnType.start, returnType.end);
		this.parseParameters(candidate.open, candidate.close, declaration);
		if (body && statement.bodyOpen !== undefined && statement.bodyClose !== undefined) {
			this.parseScope(statement.bodyOpen + 1, statement.bodyClose, {
				kind: "function",
				parentPath: declaration.descriptorPath,
				containerId: declaration.symbolId,
			});
			this.parseNestedBlocks(statement.bodyOpen + 1, statement.bodyClose, declaration);
		}
	}

	private parseNestedBlocks(start: number, end: number, declaration: CDeclaration): void {
		let index = start;
		while (index < end) {
			if (syntaxValue(this.tokens[index]) !== "{") {
				index++;
				continue;
			}
			const close = this.pairs.get(index);
			if (close === undefined || close > end) {
				index++;
				continue;
			}
			if (!this.aggregateBrace(index, start)) {
				const control = this.controlHeaderBeforeBrace(index, start);
				if (control >= 0)
					this.parseControlHeaderDeclarations(
						{ kind: "function", parentPath: declaration.descriptorPath, containerId: declaration.symbolId },
						control,
						index,
					);
				this.parseScope(index + 1, close, {
					kind: "function",
					parentPath: declaration.descriptorPath,
					containerId: declaration.symbolId,
				});
				this.parseNestedBlocks(index + 1, close, declaration);
			}
			index = close + 1;
		}
	}

	private controlHeaderBeforeBrace(brace: number, scopeStart: number): number {
		let previous = previousCode(this.tokens, brace);
		let steps = 0;
		while (previous >= scopeStart && steps < 32) {
			if (tokenValue(this.tokens, previous) === "for") return previous;
			if (["{", "}"].includes(tokenValue(this.tokens, previous))) return -1;
			previous = previousCode(this.tokens, previous);
			steps++;
		}
		return -1;
	}

	private aggregateBrace(index: number, scopeStart: number): boolean {
		let previous = previousCode(this.tokens, index);
		let steps = 0;
		while (previous >= scopeStart && steps < 8) {
			const value = tokenValue(this.tokens, previous);
			if (value === "struct" || value === "union" || value === "enum") return true;
			if (value === ";" || value === "{" || value === "}") return false;
			previous = previousCode(this.tokens, previous);
			steps++;
		}
		return false;
	}

	private parseParameters(open: number, close: number, functionDeclaration: CDeclaration): void {
		for (const segment of this.splitSegments(open + 1, close)) {
			const first = nextCode(this.tokens, segment.start, segment.end);
			if (first >= segment.end || tokenValue(this.tokens, first) === "void") continue;
			const declarator = this.declaratorNames(segment.start, segment.end)[0];
			if (declarator === undefined) {
				this.markTypeRange(segment.start, segment.end);
				continue;
			}
			const nameIndex = declarator.nameIndex;
			const last = previousCode(this.tokens, segment.end);
			if (last < segment.start) continue;
			const rangeStart = nameIndex;
			const candidate = this.addCandidate({
				name: declarator.name,
				declarationKind: "variable",
				descriptorKind: "parameter",
				languageKind: "parameter",
				rangeStartIndex: rangeStart,
				rangeEndIndex: last,
				selectionIndex: nameIndex,
				selectionEndIndex: declarator.nameEndIndex,
				parentPath: functionDeclaration.descriptorPath,
				visibility: "local",
				exported: false,
				typeText: declarator.typeText,
				typeStartIndex: declarator.typeStart,
				typeEndIndex: declarator.typeEnd,
				...(declarator.typeName === undefined ? {} : { typeName: declarator.typeName }),
				conditionalKey: this.conditionalByIndex.get(nameIndex) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(nameIndex) ?? "",
			});
			if (candidate !== undefined) this.markQualifiedName(nameIndex, declarator.nameEndIndex);
			this.markTypeRange(declarator.typeStart, declarator.typeEnd);
		}
	}

	private parameterCount(open: number, close: number): number {
		return this.splitSegments(open + 1, close).filter((segment) => {
			const first = nextCode(this.tokens, segment.start, segment.end);
			const afterFirst = nextCode(this.tokens, first + 1, segment.end);
			return first < segment.end && !(tokenValue(this.tokens, first) === "void" && afterFirst >= segment.end);
		}).length;
	}

	private functionMetrics(
		bodyOpen: number,
		bodyClose: number,
		parameterOpen: number,
		parameterClose: number,
	): Metrics {
		const first = this.tokens[bodyOpen];
		const last = this.tokens[bodyClose];
		if (first === undefined || last === undefined)
			return { parameters: this.parameterCount(parameterOpen, parameterClose) };
		const metrics: Metrics = {
			lines: lineCount(first, last),
			parameters: this.parameterCount(parameterOpen, parameterClose),
			branches: 1,
			nesting: 0,
		};
		let depth = 0;
		for (let index = bodyOpen + 1; index < bodyClose; index++) {
			const token = this.tokens[index] as CToken;
			const value = syntaxValue(token);
			if (value === "{") {
				depth++;
				metrics.nesting = Math.max(metrics.nesting ?? 0, depth);
			}
			if (value === "}") depth = Math.max(0, depth - 1);
			if (token.kind === "identifier" && ["if", "for", "while", "case", "default"].includes(value))
				metrics.branches = (metrics.branches ?? 0) + 1;
			if (value === "?") metrics.branches = (metrics.branches ?? 0) + 1;
		}
		return metrics;
	}

	private parseVariables(statement: Statement, context: ScopeContext, start: number, end: number): void {
		const names = this.declaratorNames(start, end);
		if (names.length === 0) {
			if (context.kind === "file" && this.looksLikeDeclaration(start, end))
				this.addDiagnostic("Declaration has no declarator name.", start);
			return;
		}
		const rangeStartIndex = declarationRangeStart(this.tokens, statement.start);
		for (const declarator of names) {
			const isTypedef = hasTopLevelValue(this.tokens, start, end, "typedef");
			const isConstant = hasTopLevelValue(this.tokens, start, end, "const");
			const declaration = this.addCandidate({
				name: declarator.name,
				declarationKind: isTypedef
					? "class"
					: isConstant
						? "constant"
						: context.kind === "file"
							? "variable"
							: "variable",
				descriptorKind: isTypedef ? "type" : "term",
				...(isTypedef ? { languageKind: "typedef" } : {}),
				rangeStartIndex,
				rangeEndIndex: statement.last,
				selectionIndex: declarator.nameIndex,
				selectionEndIndex: declarator.nameEndIndex,
				parentPath: context.parentPath,
				visibility:
					context.kind === "file"
						? hasTopLevelValue(this.tokens, start, end, "static")
							? "fileLocal"
							: "public"
						: "local",
				exported: context.kind === "file" ? !hasTopLevelValue(this.tokens, start, end, "static") : false,
				signature: renderTokens(this.tokens, statement.start, statement.last + 1),
				typeText: declarator.typeText,
				typeStartIndex: declarator.typeStart,
				typeEndIndex: declarator.typeEnd,
				...(declarator.typeName === undefined ? {} : { typeName: declarator.typeName }),
				conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
			});
			if (declaration !== undefined) this.markQualifiedName(declarator.nameIndex, declarator.nameEndIndex);
			this.markTypeRange(declarator.typeStart, declarator.typeEnd);
			this.checkInitializer(declarator.nameIndex, end);
		}
	}

	private checkInitializer(nameIndex: number, end: number): void {
		let index = nextCode(this.tokens, nameIndex + 1, end);
		if (!ASSIGNMENT_OPERATORS.has(tokenValue(this.tokens, index))) return;
		index = nextCode(this.tokens, index + 1, end);
		if (index >= end || tokenValue(this.tokens, index) === "," || tokenValue(this.tokens, index) === ";")
			this.addDiagnostic("Initializer has no expression.", nameIndex);
	}

	private parseAggregate(statement: Statement, aggregate: AggregateInfo, context: ScopeContext): void {
		const isTypedef =
			tokenValue(this.tokens, nextCode(this.tokens, statement.start, statement.last + 1)) === "typedef";
		const contentEnd = statement.terminator === "semicolon" ? statement.last : statement.last + 1;
		const tagName = aggregate.tagIndex < 0 ? undefined : tokenValue(this.tokens, aggregate.tagIndex);
		const rangeStartIndex = declarationRangeStart(this.tokens, statement.start);
		const names =
			aggregate.bodyClose >= 0
				? this.aggregateDeclaratorNames(aggregate, aggregate.bodyClose + 1, contentEnd, isTypedef)
				: this.declaratorNames(statement.start, contentEnd);
		let typeDeclaration: CDeclaration | undefined;
		if (tagName !== undefined && (aggregate.bodyOpen >= 0 || names.length === 0)) {
			typeDeclaration = this.addCandidate({
				name: tagName,
				declarationKind: aggregate.keyword === "enum" ? "enum" : "struct",
				descriptorKind: "type",
				...(aggregate.keyword === "union" ? { languageKind: "union" } : {}),
				rangeStartIndex,
				rangeEndIndex: statement.last,
				selectionIndex: aggregate.tagIndex,
				parentPath: context.parentPath,
				visibility: context.kind === "file" ? "public" : "local",
				exported: context.kind === "file",
				signature: renderTokens(this.tokens, statement.start, statement.last + 1),
				typeText: `${aggregate.keyword} ${tagName}`,
				typeStartIndex: aggregate.keywordIndex,
				typeEndIndex: aggregate.tagIndex,
				typeName: tagName,
				conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
				isDefinition: aggregate.bodyOpen >= 0,
			});
		}
		if (typeDeclaration !== undefined) {
			if (aggregate.bodyOpen >= 0 || names.length === 0) this.declarationNameIndices.add(aggregate.tagIndex);
			else this.typeUseIndices.add(aggregate.tagIndex);
		} else if (aggregate.tagIndex >= 0) {
			this.typeUseIndices.add(aggregate.tagIndex);
		}
		if (isTypedef) {
			for (const declarator of names) {
				const alias = this.addCandidate({
					name: declarator.name,
					declarationKind: "class",
					descriptorKind: "type",
					languageKind: "typedef",
					rangeStartIndex,
					rangeEndIndex: statement.last,
					selectionIndex: declarator.nameIndex,
					selectionEndIndex: declarator.nameEndIndex,
					parentPath: context.parentPath,
					visibility: context.kind === "file" ? "public" : "local",
					exported: context.kind === "file",
					signature: renderTokens(this.tokens, statement.start, statement.last + 1),
					typeText:
						declarator.typeText ||
						(tagName === undefined ? aggregate.keyword : `${aggregate.keyword} ${tagName}`),
					typeStartIndex: declarator.typeStart,
					typeEndIndex: declarator.typeEnd,
					...(tagName === undefined ? {} : { typeName: tagName }),
					conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
					conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
				});
				if (alias !== undefined) this.markQualifiedName(declarator.nameIndex, declarator.nameEndIndex);
				this.markTypeRange(declarator.typeStart, declarator.typeEnd);
			}
		} else {
			for (const declarator of this.declaratorNames(statement.start, contentEnd)) {
				if (aggregate.tagIndex >= 0 && declarator.nameIndex === aggregate.tagIndex) continue;
				const variable = this.addCandidate({
					name: declarator.name,
					declarationKind: "variable",
					descriptorKind: "term",
					rangeStartIndex,
					rangeEndIndex: statement.last,
					selectionIndex: declarator.nameIndex,
					selectionEndIndex: declarator.nameEndIndex,
					parentPath: context.parentPath,
					visibility: context.kind === "file" ? "public" : "local",
					exported: context.kind === "file",
					signature: renderTokens(this.tokens, statement.start, statement.last + 1),
					typeText: declarator.typeText,
					typeStartIndex: declarator.typeStart,
					typeEndIndex: declarator.typeEnd,
					...(declarator.typeName === undefined ? {} : { typeName: declarator.typeName }),
					conditionalKey: this.conditionalByIndex.get(statement.start) ?? "",
					conditionalGroup: this.conditionalGroupByIndex.get(statement.start) ?? "",
				});
				if (variable !== undefined) this.markQualifiedName(declarator.nameIndex, declarator.nameEndIndex);
				this.markTypeRange(declarator.typeStart, declarator.typeEnd);
			}
		}
		if (typeDeclaration === undefined && isTypedef && names.length > 0) typeDeclaration = this.declarations.at(-1);
		if (aggregate.bodyOpen >= 0 && aggregate.bodyClose > aggregate.bodyOpen && typeDeclaration !== undefined) {
			if (aggregate.keyword === "enum")
				this.parseEnumMembers(aggregate.bodyOpen + 1, aggregate.bodyClose, typeDeclaration);
			else this.parseStructMembers(aggregate.bodyOpen + 1, aggregate.bodyClose, typeDeclaration);
		}
		if (statement.terminator === "eof" && aggregate.bodyClose >= 0)
			this.addDiagnostic("Aggregate declaration has no terminating semicolon.", aggregate.bodyClose);
	}

	private parseStructMembers(start: number, end: number, container: CDeclaration): void {
		let memberStart = start;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = start; index <= end; index++) {
			const value = tokenValue(this.tokens, index);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			if ((value === ";" && parentheses === 0 && brackets === 0 && braces === 0) || index === end) {
				const memberEnd = value === ";" ? index : index - 1;
				this.parseMemberStatement(memberStart, memberEnd, container);
				memberStart = index + 1;
			}
		}
	}

	private parseMemberStatement(start: number, end: number, container: CDeclaration): void {
		const first = nextCode(this.tokens, start, end);
		if (first >= end) return;
		const aggregate = this.extractAggregateInfo(first, end);
		if (aggregate !== undefined) {
			const statement: Statement = { start: first, last: end, next: end + 1, terminator: "semicolon" };
			this.parseAggregate(statement, aggregate, {
				kind: "function",
				parentPath: container.descriptorPath,
				containerId: container.symbolId,
			});
			if (aggregate.bodyOpen >= 0 && aggregate.bodyClose > aggregate.bodyOpen && aggregate.tagIndex < 0) {
				if (aggregate.keyword === "enum")
					this.parseEnumMembers(aggregate.bodyOpen + 1, aggregate.bodyClose, container);
				else this.parseStructMembers(aggregate.bodyOpen + 1, aggregate.bodyClose, container);
			}
			return;
		}
		for (const declarator of this.declaratorNames(first, end)) {
			const rangeStartIndex = declarationRangeStart(this.tokens, first);
			const field = this.addCandidate({
				name: declarator.name,
				declarationKind: "field",
				descriptorKind: "term",
				rangeStartIndex,
				rangeEndIndex: end,
				selectionIndex: declarator.nameIndex,
				selectionEndIndex: declarator.nameEndIndex,
				parentPath: container.descriptorPath,
				visibility: "public",
				signature: renderTokens(this.tokens, first, end + 1),
				typeText: declarator.typeText,
				typeStartIndex: declarator.typeStart,
				typeEndIndex: declarator.typeEnd,
				...(declarator.typeName === undefined ? {} : { typeName: declarator.typeName }),
				conditionalKey: this.conditionalByIndex.get(first) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(first) ?? "",
			});
			if (field !== undefined) this.markQualifiedName(declarator.nameIndex, declarator.nameEndIndex);
			this.markTypeRange(declarator.typeStart, declarator.typeEnd);
		}
	}

	private parseEnumMembers(start: number, end: number, container: CDeclaration): void {
		for (const segment of this.splitSegments(start, end)) {
			const nameIndex = this.findDeclaratorName(segment.start, segment.end);
			if (nameIndex < 0) continue;
			const token = this.tokens[nameIndex] as CToken;
			const last = previousCode(this.tokens, segment.end);
			if (last < nameIndex) continue;
			const member = this.addCandidate({
				name: token.value,
				declarationKind: "constant",
				descriptorKind: "term",
				rangeStartIndex: declarationRangeStart(this.tokens, segment.start),
				rangeEndIndex: last,
				selectionIndex: nameIndex,
				parentPath: container.descriptorPath,
				visibility: "public",
				signature: renderTokens(this.tokens, segment.start, last + 1),
				typeText: container.name,
				conditionalKey: this.conditionalByIndex.get(nameIndex) ?? "",
				conditionalGroup: this.conditionalGroupByIndex.get(nameIndex) ?? "",
			});
			if (member !== undefined) this.declarationNameIndices.add(nameIndex);
		}
	}

	private splitSegments(start: number, end: number): Array<{ start: number; end: number }> {
		const segments: Array<{ start: number; end: number }> = [];
		let segmentStart = start;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = start; index < end; index++) {
			const value = tokenValue(this.tokens, index);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			else if (value === "," && parentheses === 0 && brackets === 0 && braces === 0) {
				segments.push({ start: segmentStart, end: index });
				segmentStart = index + 1;
			}
		}
		segments.push({ start: segmentStart, end });
		return segments;
	}

	private findDeclaratorName(start: number, end: number, allowKeywordName = false): number {
		const equals = this.topLevelIndex(start, end, ASSIGNMENT_OPERATORS);
		const limit = equals < 0 ? end : equals;
		for (let index = start; index < limit; index++) {
			const token = this.tokens[index] as CToken;
			if (
				!isIdentifierToken(token) ||
				(C_KEYWORDS.has(token.value) && !(allowKeywordName && ["bool", "_Bool"].includes(token.value))) ||
				CALLING_CONVENTIONS.has(token.value) ||
				TYPE_QUALIFIERS.has(token.value)
			)
				continue;
			const previous = previousCode(this.tokens, index);
			if (previous >= start && [".", "->", "#"].includes(tokenValue(this.tokens, previous))) continue;
			if (token.value === "__attribute__" || token.value === "__declspec") continue;
			return index;
		}
		return -1;
	}

	private topLevelIndex(start: number, end: number, wanted: Set<string>): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = start; index < end; index++) {
			const value = tokenValue(this.tokens, index);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			else if (parentheses === 0 && brackets === 0 && braces === 0 && wanted.has(value)) return index;
		}
		return -1;
	}

	private declaratorNames(start: number, end: number): DeclaratorName[] {
		let cursor = nextCode(this.tokens, start, end);
		let sawType = false;
		while (cursor < end) {
			const token = this.tokens[cursor] as CToken;
			if (token.kind !== "identifier") break;
			if (token.value === "struct" || token.value === "union" || token.value === "enum") {
				sawType = true;
				cursor = nextCode(this.tokens, cursor + 1, end);
				if (isIdentifierToken(this.tokens[cursor])) cursor = nextCode(this.tokens, cursor + 1, end);
				if (tokenValue(this.tokens, cursor) === "{") {
					const close = this.pairs.get(cursor);
					cursor = close === undefined ? end : nextCode(this.tokens, close + 1, end);
				}
				continue;
			}
			if (isSpecifierWord(token.value)) {
				const next = nextCode(this.tokens, cursor + 1, end);
				if (sawType && (next >= end || [",", ";", "="].includes(tokenValue(this.tokens, next)))) break;
				sawType =
					sawType ||
					BUILTIN_TYPES.has(token.value) ||
					token.value === "const" ||
					token.value === "signed" ||
					token.value === "unsigned";
				if (token.value === "__attribute__" || token.value === "__declspec")
					cursor = this.skipAttribute(cursor, end);
				else cursor = nextCode(this.tokens, cursor + 1, end);
				continue;
			}
			if (!sawType) {
				sawType = true;
				cursor = nextCode(this.tokens, cursor + 1, end);
				continue;
			}
			break;
		}
		if (cursor >= end) return [];
		const names: DeclaratorName[] = [];
		const allowKeywordName = hasTopLevelValue(this.tokens, start, end, "typedef");
		for (const segment of this.splitSegments(cursor, end)) {
			const nameIndex = this.findDeclaratorName(segment.start, segment.end, allowKeywordName);
			if (nameIndex < 0) continue;
			const qualified = qualifiedNameForIdentifier(this.tokens, nameIndex, segment.end);
			if (qualified === undefined) continue;
			const typeText = this.typeTextForDeclarator(start, cursor, segment.start, nameIndex);
			const typeName = this.typeNameForRange(start, cursor);
			names.push({
				nameIndex,
				nameEndIndex: qualified.endIndex,
				name: qualified.name,
				typeStart: start,
				typeEnd: cursor,
				typeText,
				...(typeName === undefined ? {} : { typeName }),
			});
		}
		return names;
	}

	private skipAttribute(start: number, end: number): number {
		const open = nextCode(this.tokens, start + 1, end);
		if (tokenValue(this.tokens, open) !== "(") return nextCode(this.tokens, start + 1, end);
		const close = this.pairs.get(open);
		return close === undefined ? end : nextCode(this.tokens, close + 1, end);
	}

	private aggregateDeclaratorNames(
		aggregate: AggregateInfo,
		start: number,
		end: number,
		allowKeywordName = false,
	): DeclaratorName[] {
		const tag = aggregate.tagIndex < 0 ? "" : ` ${tokenValue(this.tokens, aggregate.tagIndex)}`;
		const typeStart = aggregate.keywordIndex;
		const typeEnd = aggregate.bodyClose;
		const names: DeclaratorName[] = [];
		for (const segment of this.splitSegments(start, end)) {
			const nameIndex = this.findDeclaratorName(segment.start, segment.end, allowKeywordName);
			if (nameIndex < 0) continue;
			const qualified = qualifiedNameForIdentifier(this.tokens, nameIndex, segment.end);
			if (qualified === undefined) continue;
			const pointer = renderTokens(this.tokens, segment.start, nameIndex).replace(/^[()]|[()]$/gu, "");
			const typeText = stripTypeText(`${aggregate.keyword}${tag}${pointer === "" ? "" : ` ${pointer}`}`);
			names.push({
				nameIndex,
				nameEndIndex: qualified.endIndex,
				name: qualified.name,
				typeStart,
				typeEnd,
				typeText,
				...(aggregate.tagIndex < 0 ? {} : { typeName: tokenValue(this.tokens, aggregate.tagIndex) }),
			});
		}
		return names;
	}

	private typeTextForDeclarator(start: number, specEnd: number, segmentStart: number, nameIndex: number): string {
		const base = renderTokens(this.tokens, start, specEnd);
		const pointer = renderTokens(this.tokens, segmentStart, nameIndex).replace(/^[()]|[()]$/gu, "");
		return stripTypeText(`${base}${pointer === "" ? "" : ` ${pointer}`}`);
	}

	private typeTextBefore(
		start: number,
		nameIndex: number,
	): { text: string; start: number; end: number; typeName?: string } {
		const end = nameIndex;
		const text = stripTypeText(renderTokens(this.tokens, start, end));
		const typeName = this.typeNameForRange(start, end);
		return { text, start, end: Math.max(start, end - 1), ...(typeName === undefined ? {} : { typeName }) };
	}

	private typeNameForRange(start: number, end: number): string | undefined {
		let previous = "";
		for (let index = start; index < end; index++) {
			const token = this.tokens[index] as CToken;
			if (!isIdentifierToken(token)) continue;
			if (token.value === "struct" || token.value === "union" || token.value === "enum") {
				previous = token.value;
				continue;
			}
			if (previous === "struct" || previous === "union" || previous === "enum") return token.value;
			if (!typeWords(token.value)) return token.value;
		}
		return undefined;
	}

	private markTypeRange(start: number, end: number): void {
		if (end < start) return;
		for (let index = start; index <= end; index++) {
			const token = this.tokens[index];
			if (isTypeToken(token)) this.typeUseIndices.add(index);
		}
	}

	private addCandidate(candidate: Candidate): CDeclaration | undefined {
		const canonicalKey = `${candidate.declarationKind}|${descriptorKey(candidate.parentPath)}|${candidate.name}`;
		const existing = candidate.conditionalKey === "" ? this.canonicalDeclarations.get(canonicalKey) : undefined;
		if (
			existing !== undefined &&
			(candidate.declarationKind === "function" ||
				candidate.declarationKind === "struct" ||
				candidate.declarationKind === "enum")
		) {
			if (candidate.isDefinition === true && existing.isDefinition !== true) {
				const position = this.declarations.indexOf(existing);
				for (let index = this.declarations.length - 1; index >= 0; index--) {
					const child = this.declarations[index];
					if (child?.containerId !== existing.symbolId) continue;
					const descriptor = child.descriptorPath.at(-1);
					if (descriptor !== undefined)
						this.descriptorCounts.set(
							`${descriptorKey(existing.descriptorPath)}|${descriptor.kind}|${child.name}`,
							0,
						);
					this.declarations.splice(index, 1);
				}
				const replacement = this.makeDeclaration(candidate, existing.descriptorPath, false);
				if (position >= 0) this.declarations[position] = replacement;
				this.canonicalDeclarations.set(canonicalKey, replacement);
				this.typeAnswers.delete(existing.symbolId);
				this.addTypeAnswer(replacement);
				return replacement;
			}
			if (candidate.isDefinition !== true && existing.isDefinition !== true) return existing;
			if (candidate.isDefinition !== true && existing.isDefinition === true) return existing;
		}
		const countKey = `${descriptorKey(candidate.parentPath)}|${candidate.descriptorKind}|${candidate.name}`;
		const ordinal = this.descriptorCounts.get(countKey) ?? 0;
		this.descriptorCounts.set(countKey, ordinal + 1);
		const descriptorName =
			ordinal === 0 || candidate.descriptorKind === "method" ? candidate.name : `${candidate.name}#${ordinal}`;
		const descriptor: Descriptor =
			candidate.descriptorKind === "method" && ordinal > 0
				? { kind: "method", name: candidate.name, disambiguator: String(ordinal) }
				: { kind: candidate.descriptorKind, name: descriptorName };
		const declaration = this.makeDeclaration(candidate, [...candidate.parentPath, descriptor]);
		if (candidate.conditionalKey === "") this.canonicalDeclarations.set(canonicalKey, declaration);
		return declaration;
	}

	private markQualifiedName(start: number, end: number): void {
		for (let index = start; index <= end; index++) {
			if (isIdentifierToken(this.tokens[index])) this.declarationNameIndices.add(index);
		}
	}

	private markQualifiedReference(name: QualifiedName): void {
		for (const index of name.identifierIndices) this.qualifiedNameIndices.add(index);
	}

	private makeDeclaration(candidate: Candidate, descriptorPath: DescriptorPath, append = true): CDeclaration {
		const first = this.tokens[candidate.rangeStartIndex] as CToken;
		const last = this.tokens[candidate.rangeEndIndex] as CToken;
		const selectionRange =
			rangeForTokens(
				this.tokens,
				candidate.selectionIndex,
				candidate.selectionEndIndex ?? candidate.selectionIndex,
			) ?? tokenRange(this.tokens[candidate.selectionIndex] as CToken);
		const symbolId = composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: descriptorPath });
		const containerId =
			descriptorPath.length <= 1
				? undefined
				: composeSymbolId({
						language: LANGUAGE,
						module: this.module,
						descriptors: descriptorPath.slice(0, -1),
					});
		const typeRange =
			candidate.typeStartIndex === undefined || candidate.typeEndIndex === undefined
				? undefined
				: rangeForTokens(this.tokens, candidate.typeStartIndex, candidate.typeEndIndex);
		const declaration: CDeclaration = {
			symbolId,
			kind: candidate.declarationKind,
			name: candidate.name,
			range: { start: first.start, end: last.end },
			selectionRange,
			visibility: candidate.visibility,
			...(candidate.languageKind === undefined ? {} : { languageKind: candidate.languageKind }),
			...(candidate.exported === undefined ? {} : { exported: candidate.exported }),
			...(candidate.signature === undefined ? {} : { signature: candidate.signature }),
			...(containerId === undefined ? {} : { containerId }),
			...(candidate.metrics === undefined ? {} : { metrics: candidate.metrics }),
			descriptorPath,
			startOffset: first.startOffset,
			endOffset: last.endOffset,
			selectionIndex: candidate.selectionIndex,
			conditionalKey: candidate.conditionalKey,
			conditionalGroup: candidate.conditionalGroup,
			...(candidate.isDefinition === undefined ? {} : { isDefinition: candidate.isDefinition }),
			...(candidate.typeText === undefined || candidate.typeText === "" ? {} : { typeText: candidate.typeText }),
			...(typeRange === undefined ? {} : { typeRange }),
		};
		if (append) this.declarations.push(declaration);
		this.addTypeAnswer(declaration, candidate.typeName);
		return declaration;
	}

	private addTypeAnswer(declaration: CDeclaration, typeName?: string): void {
		if (declaration.typeText === undefined || declaration.typeText === "") return;
		this.typeAnswers.set(declaration.symbolId, {
			display: declaration.typeText,
			...(typeName === undefined ? {} : { typeName }),
		});
	}

	private extractLiterals(): void {
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as CToken;
			if (this.directiveTokens.has(index) || this.includePathTokens.has(index)) continue;
			let literal: Literal | undefined;
			if (token.kind === "string") literal = { kind: "string", value: token.value, range: tokenRange(token) };
			else if (token.kind === "number") {
				const numeric = numberValue(token.value);
				if (numeric.valid) {
					literal = {
						kind: "number",
						value: token.value,
						range: tokenRange(token),
						...(numeric.number === undefined ? {} : { number: numeric.number }),
					};
				}
			} else if (token.kind === "char") {
				const codePoint = token.value.codePointAt(0);
				if (codePoint !== undefined)
					literal = { kind: "number", value: token.raw, number: codePoint, range: tokenRange(token) };
			} else if (token.kind === "identifier" && (token.value === "true" || token.value === "false")) {
				literal = { kind: "boolean", value: token.value, range: tokenRange(token) };
			}
			if (literal === undefined) continue;
			const container = this.containerByToken[index];
			this.literals.push(container === undefined ? literal : { ...literal, containerId: container.symbolId });
		}
	}

	private buildContainerIndex(): void {
		const containers = this.declarations
			.filter((declaration) => ["function", "struct", "enum", "class"].includes(declaration.kind))
			.sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset);
		const active: CDeclaration[] = [];
		let next = 0;
		this.containerByToken = new Array(this.tokens.length);
		for (let index = 0; index < this.tokens.length; index++) {
			const offset = (this.tokens[index] as CToken).startOffset;
			while (next < containers.length && (containers[next] as CDeclaration).startOffset <= offset) {
				active.push(containers[next] as CDeclaration);
				next++;
			}
			for (let activeIndex = active.length - 1; activeIndex >= 0; activeIndex--) {
				if ((active[activeIndex] as CDeclaration).endOffset < offset) active.splice(activeIndex, 1);
			}
			this.containerByToken[index] = active.at(-1);
		}
	}

	private extractReferences(): void {
		for (const declaration of this.declarations) {
			if (declaration.containerId === undefined && ["class", "struct", "enum"].includes(declaration.kind))
				this.typeNames.add(declaration.name);
		}
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index] as CToken;
			if (
				token.kind !== "identifier" ||
				this.directiveTokens.has(index) ||
				this.declarationNameIndices.has(index)
			)
				continue;
			if (this.qualifiedNameIndices.has(index)) continue;
			const qualified = qualifiedNameForIdentifier(this.tokens, index, this.tokens.length);
			if (
				qualified !== undefined &&
				(qualified.startIndex !== qualified.endIndex || tokenValue(this.tokens, qualified.startIndex) === "::")
			) {
				this.markQualifiedReference(qualified);
				this.addQualifiedReference(qualified);
				continue;
			}
			if (token.value === "true" || token.value === "false" || C_KEYWORDS.has(token.value)) continue;
			const previous = previousSignificant(this.tokens, index);
			const next = significant(this.tokens, index + 1);
			const previousValue = previous < 0 ? "" : tokenValue(this.tokens, previous);
			const nextValue = next < 0 ? "" : tokenValue(this.tokens, next);
			if (
				this.typeUseIndices.has(index) ||
				(previousValue === "(" && this.isTypeName(token.value) && nextValue === ")")
			) {
				this.addReference(index, "typeUse");
				continue;
			}
			if (nextValue === ":" && previousValue !== "?") continue;
			if (nextValue === "++" || nextValue === "--" || previousValue === "++" || previousValue === "--") {
				this.addReference(index, "read");
				this.addReference(index, "write");
				continue;
			}
			if (ASSIGNMENT_OPERATORS.has(nextValue)) {
				if (nextValue !== "=") this.addReference(index, "read");
				this.addReference(index, "write");
				continue;
			}
			if (nextValue === "(") {
				this.addReference(index, "call");
				continue;
			}
			if (previousValue === "#") continue;
			this.addReference(index, "read");
		}
		for (const imported of this.imports) {
			if (imported.range === undefined) continue;
			const reference: CReference = {
				name: imported.specifier,
				range: imported.range,
				role: "import",
				binding: {
					status: "unbound",
					reason: "NotImplemented",
					detail: "include binding is resolved by the provider",
				},
				tokenIndex: -1,
			};
			this.references.push(reference);
		}
	}

	private isTypeName(name: string): boolean {
		return this.typeNames.has(name);
	}

	private addQualifiedReference(name: QualifiedName): void {
		const previous = previousSignificant(this.tokens, name.startIndex);
		const next = significant(this.tokens, name.endIndex + 1);
		const previousValue = previous < 0 ? "" : tokenValue(this.tokens, previous);
		const nextValue = next < 0 ? "" : tokenValue(this.tokens, next);
		if (name.identifierIndices.some((index) => this.typeUseIndices.has(index))) {
			this.addReference(name.startIndex, "typeUse", name.name, name.endIndex);
			return;
		}
		if (nextValue === ":" && previousValue !== "?") return;
		if (nextValue === "++" || nextValue === "--" || previousValue === "++" || previousValue === "--") {
			this.addReference(name.startIndex, "read", name.name, name.endIndex);
			this.addReference(name.startIndex, "write", name.name, name.endIndex);
			return;
		}
		if (ASSIGNMENT_OPERATORS.has(nextValue)) {
			if (nextValue !== "=") this.addReference(name.startIndex, "read", name.name, name.endIndex);
			this.addReference(name.startIndex, "write", name.name, name.endIndex);
			return;
		}
		if (nextValue === "(") {
			this.addReference(name.startIndex, "call", name.name, name.endIndex);
			return;
		}
		if (previousValue === "#") return;
		this.addReference(name.startIndex, "read", name.name, name.endIndex);
	}

	private addReference(
		index: number,
		role: Reference["role"],
		name = tokenValue(this.tokens, index),
		end = index,
	): void {
		const token = this.tokens[index] as CToken;
		const last = this.tokens[end] as CToken;
		const container = this.containerByToken[index];
		this.references.push({
			name,
			range: { start: token.start, end: last.end },
			role,
			binding: { status: "unbound", reason: "NotImplemented", detail: "C binding is resolved by the provider" },
			...(container === undefined ? {} : { fromId: container.symbolId }),
			tokenIndex: index,
		});
	}
}

export function bindingCandidates(facts: ParsedCFile, reference: CReference): CDeclaration[] {
	const sameName = facts.declarationsByName.get(reference.name) ?? [];
	const from = reference.fromId === undefined ? undefined : facts.declarationsById.get(reference.fromId);
	const local = from === undefined ? [] : sameName.filter((declaration) => declaration.containerId === from.symbolId);
	const file = sameName.filter((declaration) => declaration.containerId === undefined);
	const member =
		from?.kind === "struct" || from?.kind === "enum"
			? sameName.filter((declaration) => declaration.containerId === from.symbolId)
			: [];
	if (reference.role === "typeUse")
		return sameName.filter(
			(declaration) =>
				["class", "struct", "enum"].includes(declaration.kind) && declaration.containerId === undefined,
		);
	if (reference.role === "call")
		return [...local, ...file].filter((declaration) => ["function", "constant"].includes(declaration.kind));
	if (member.length > 0) return member;
	if (local.length > 0) return local;
	return file.filter((declaration) =>
		["variable", "constant", "function", "class", "struct", "enum"].includes(declaration.kind),
	);
}

export function rangeContains(range: Range, position: Range["start"]): boolean {
	return containsPosition(range, position);
}

export function typeInfoFor(facts: ParsedCFile, symbolId: string): TypeInfo {
	const answer = facts.typeAnswers.get(symbolId);
	if (answer === undefined)
		return {
			status: "unknown",
			reason: "NotImplemented",
			detail: "the declaration has no supported declared type",
		};
	const typeDeclaration =
		answer.typeName === undefined
			? undefined
			: (facts.declarationsByName.get(answer.typeName) ?? []).find(
					(declaration) =>
						declaration.containerId === undefined && ["class", "struct", "enum"].includes(declaration.kind),
				);
	return {
		status: "known",
		display: answer.display,
		...(typeDeclaration === undefined ? {} : { symbolId: typeDeclaration.symbolId }),
		provenance: "declared",
	};
}
