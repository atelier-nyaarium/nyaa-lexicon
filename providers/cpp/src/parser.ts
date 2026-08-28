import {
	ANONYMOUS_NAMESPACE,
	angleDelta,
	type CommentSpan,
	comparePositions,
	composeSymbolId,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type Import,
	type Literal,
	type Metrics,
	qualifierDescriptors,
	type Range,
	type Reference,
	type TypeInfo,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { Token } from "./tokens.js";
import { isSignificant, rangeOfToken, tokenize } from "./tokens.js";

type Visibility = Declaration["visibility"];

export const LANGUAGE = "cpp";

export interface ImportFact {
	imported: Import;
	quoted: boolean;
	tokenStart: number;
	tokenEnd: number;
}

export interface CppDeclarationRecord {
	declaration: Declaration;
	parent: CppDeclarationRecord | null;
	own: Descriptor;
	tokenStart: number;
	tokenEnd: number;
	nameTokenStart: number;
	nameTokenEnd: number;
	templateDependent: boolean;
	parameterNames: Set<string>;
}

type DraftInput = Omit<
	DraftRecord,
	"languageKind" | "signature" | "metrics" | "type" | "parameterNames" | "parameterSignature" | "hasBody"
> & {
	languageKind?: string | undefined;
	signature?: string | undefined;
	metrics?: Metrics | undefined;
	type?: DraftType | undefined;
	parameterNames?: Set<string>;
	parameterSignature?: string;
	hasBody?: boolean;
};

export interface CppReferenceRecord {
	name: string;
	range: Range;
	role: Reference["role"];
	tokenIndex: number;
	from: CppDeclarationRecord | null;
	qualifiedPath: string[];
	templateDependent: boolean;
}

export interface CppFacts {
	declarations: Declaration[];
	references: CppReferenceRecord[];
	imports: Import[];
	literals: Literal[];
	comments: CommentSpan[];
	diagnostics: Diagnostic[];
	records: CppDeclarationRecord[];
	importFacts: ImportFact[];
	typeAnswers: Map<string, TypeInfo>;
}

type DraftType =
	| { status: "known"; display: string }
	| { status: "inferred"; display: string; basis: string }
	| { status: "unknown"; reason: UnknownReason; detail: string };

interface DraftRecord {
	parent: DraftRecord | null;
	qualifier?: Descriptor[];
	qualifierNames?: string[];
	own: Descriptor;
	kind: Declaration["kind"];
	name: string;
	visibility: Visibility;
	languageKind: string | undefined;
	exported: boolean;
	startIndex: number;
	endIndex: number;
	nameStartIndex: number;
	nameEndIndex: number;
	signature: string | undefined;
	metrics: Metrics | undefined;
	type: DraftType | undefined;
	templateDependent: boolean;
	parameterNames: Set<string>;
	parameterSignature: string | undefined;
	hasBody: boolean;
}

interface TemplateParameter {
	name: string;
	nameStartIndex: number;
	nameEndIndex: number;
	startIndex: number;
	endIndex: number;
	typeText: string;
}

interface TemplateInfo {
	startIndex: number;
	endIndex: number;
	parameters: TemplateParameter[];
}

interface Prefix {
	startIndex: number;
	keywordIndex: number;
	template: TemplateInfo | null;
	explicitInstantiation: boolean;
	modifiers: Set<string>;
	exported: boolean;
}

interface Scope {
	parent: DraftRecord | null;
	kind: "module" | "namespace" | "class" | "function" | "enum";
	defaultVisibility: Visibility;
	templateDependent: boolean;
}

const KEYWORDS = new Set([
	"alignas",
	"alignof",
	"and",
	"and_eq",
	"asm",
	"atomic_cancel",
	"atomic_commit",
	"atomic_noexcept",
	"auto",
	"bitand",
	"bitor",
	"break",
	"case",
	"catch",
	"class",
	"compl",
	"concept",
	"const",
	"consteval",
	"constexpr",
	"constinit",
	"const_cast",
	"continue",
	"co_await",
	"co_return",
	"co_yield",
	"decltype",
	"default",
	"delete",
	"do",
	"dynamic_cast",
	"else",
	"enum",
	"explicit",
	"export",
	"extern",
	"false",
	"for",
	"friend",
	"goto",
	"if",
	"inline",
	"mutable",
	"namespace",
	"new",
	"noexcept",
	"not",
	"not_eq",
	"nullptr",
	"operator",
	"or",
	"or_eq",
	"private",
	"protected",
	"public",
	"register",
	"reinterpret_cast",
	"requires",
	"return",
	"signed",
	"sizeof",
	"static",
	"static_assert",
	"static_cast",
	"struct",
	"switch",
	"template",
	"this",
	"thread_local",
	"throw",
	"true",
	"try",
	"typedef",
	"typeid",
	"typename",
	"union",
	"unsigned",
	"using",
	"virtual",
	"void",
	"volatile",
	"wchar_t",
	"while",
	"xor",
	"xor_eq",
]);

const TYPE_WORDS = new Set([
	"bool",
	"char",
	"char8_t",
	"char16_t",
	"char32_t",
	"double",
	"float",
	"int",
	"long",
	"short",
	"signed",
	"unsigned",
	"void",
	"wchar_t",
	"auto",
	"decltype",
	"const",
	"volatile",
	"static",
	"constexpr",
	"mutable",
	"thread_local",
	"inline",
]);

const MODIFIERS = new Set([
	"const",
	"consteval",
	"constexpr",
	"constinit",
	"explicit",
	"extern",
	"friend",
	"inline",
	"mutable",
	"register",
	"static",
	"thread_local",
	"typename",
	"virtual",
	"volatile",
	"export",
]);
const DECLARATION_SPECIFIERS = new Set(["__declspec", "__attribute__", "alignas"]);

const CONTROL_NAMES = new Set(["if", "for", "while", "switch", "catch", "sizeof", "decltype"]);
const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

function isShoutCase(value: string): boolean {
	return /^[A-Z0-9_]*[A-Z][A-Z0-9_]*$/u.test(value);
}

function significantBefore(tokens: Token[], index: number): number {
	let current = index - 1;
	while (current >= 0 && !isSignificant(tokens[current] as Token)) current--;
	return current;
}

function significantAfter(tokens: Token[], index: number, limit = tokens.length): number {
	let current = index + 1;
	while (current < limit && !isSignificant(tokens[current] as Token)) current++;
	return current < limit ? current : -1;
}

function tokenAt(tokens: Token[], index: number): Token | undefined {
	return tokens[index];
}

function rangeFrom(tokens: Token[], startIndex: number, endIndex: number): Range | null {
	const start = tokenAt(tokens, startIndex);
	const end = tokenAt(tokens, endIndex - 1);
	if (start === undefined || end === undefined) return null;
	return { start: start.start, end: end.end };
}

function joinTokens(tokens: Token[], startIndex: number, endIndex: number): string {
	let output = "";
	let previous = "";
	const noSpaceBefore = new Set([",", ";", ")", "]", "}", ">", "::", ".", "->", "->*"]);
	const noSpaceAfter = new Set(["(", "[", "{", "<", "::", ".", "->", "->*"]);
	for (let index = startIndex; index < endIndex; index++) {
		const token = tokenAt(tokens, index);
		if (token === undefined || !isSignificant(token)) continue;
		if (output !== "" && !noSpaceBefore.has(token.text) && !noSpaceAfter.has(previous)) output += " ";
		output += token.text;
		previous = token.text;
	}
	return output.trim();
}

const INTEGRAL_WORDS = new Set(["signed", "unsigned", "short", "long", "int", "char"]);

/** Function qualifiers that take part in overload identity; `noexcept`, `override` and a trailing return do not. */
const FUNCTION_QUALIFIERS = new Set(["const", "volatile", "&", "&&"]);

/** One spelling per integral type, so `unsigned` and `unsigned int` name one overload. */
function foldIntegral(words: string[]): string[] {
	if (words.includes("double") || !words.some((word) => INTEGRAL_WORDS.has(word))) return words;
	const has = (word: string) => words.includes(word);
	const longs = words.filter((word) => word === "long").length;
	let type: string;
	if (has("char")) type = has("unsigned") ? "unsigned char" : has("signed") ? "signed char" : "char";
	else {
		const size = has("short") ? "short" : longs >= 2 ? "long long" : longs === 1 ? "long" : "int";
		type = has("unsigned") ? `unsigned ${size}` : size;
	}
	return [type, ...words.filter((word) => !INTEGRAL_WORDS.has(word))];
}

/**
 * Overload identity, never shown: each parameter's type with its name and default argument
 * dropped, then the function's cv and ref qualifiers.
 */
function canonicalParameterSignature(tokens: Token[], startIndex: number, endIndex: number): string {
	const parts: string[] = [];
	let part: number[] = [];
	let parentheses = 0;
	let brackets = 0;
	let angles = 0;
	const flush = () => {
		const assign = part.findIndex((index) => tokenAt(tokens, index)?.text === "=");
		const indexes = assign < 0 ? part : part.slice(0, assign);
		if (indexes.length > 1) {
			const last = indexes.at(-1) as number;
			const before = indexes.at(-2) as number;
			if (tokenAt(tokens, last)?.kind === "identifier" && tokenAt(tokens, before)?.text !== "::") indexes.pop();
		}
		if (indexes.length > 0)
			parts.push(foldIntegral(indexes.map((index) => tokenAt(tokens, index)?.text ?? "")).join(" "));
		part = [];
	};
	for (let index = startIndex; index < endIndex; index++) {
		const token = tokenAt(tokens, index);
		if (token === undefined || !isSignificant(token)) continue;
		const value = token.text;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else angles += angleDelta(value);
		if (value === "," && parentheses === 0 && brackets === 0 && angles === 0) flush();
		else part.push(index);
	}
	flush();
	return parts.join(",");
}

function functionQualifiers(tokens: Token[], startIndex: number, endIndex: number): string {
	const found: string[] = [];
	for (let index = startIndex; index < endIndex; index++) {
		const value = tokenAt(tokens, index)?.text;
		if (value === "{" || value === ";" || value === "=" || value === "->") break;
		if (value !== undefined && FUNCTION_QUALIFIERS.has(value)) found.push(value);
	}
	return found.join(" ");
}

function matching(tokens: Token[], openIndex: number, open: string, close: string, limit = tokens.length): number {
	let depth = 0;
	let guard = -1;
	for (let index = openIndex; index < limit; index++) {
		if (index <= guard) throw new Error("delimiter scan failed to advance");
		guard = index;
		const token = tokenAt(tokens, index);
		if (token === undefined) return -1;
		if (token.text === open) depth++;
		if (token.text === close) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function matchingAngle(tokens: Token[], openIndex: number, limit = tokens.length): number {
	let depth = 0;
	let guard = -1;
	for (let index = openIndex; index < limit; index++) {
		if (index <= guard) throw new Error("angle scan failed to advance");
		guard = index;
		const value = tokenAt(tokens, index)?.text;
		depth += angleDelta(value ?? "");
		if (depth === 0) return index;
		if (value === ";" || value === "{") return -1;
	}
	return -1;
}

function statementEnd(tokens: Token[], startIndex: number, limit: number): number {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	let guard = -1;
	for (let index = startIndex; index < limit; index++) {
		if (index <= guard) throw new Error("statement scan failed to advance");
		guard = index;
		const value = tokenAt(tokens, index)?.text;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses = Math.max(0, parentheses - 1);
		else if (value === "[") brackets++;
		else if (value === "]") brackets = Math.max(0, brackets - 1);
		else if (value === "{") braces++;
		else if (value === "}") {
			if (braces === 0 && parentheses === 0 && brackets === 0) return index;
			braces = Math.max(0, braces - 1);
		}
		if (value === ";" && parentheses === 0 && brackets === 0 && braces === 0) return index;
	}
	return Math.max(startIndex, limit - 1);
}

function bodyMetrics(tokens: Token[], startIndex: number, endIndex: number, parameterCount?: number): Metrics {
	let nesting = 0;
	let deepest = 0;
	let branches = 1;
	for (let index = startIndex; index < endIndex; index++) {
		const value = tokenAt(tokens, index)?.text;
		if (value === "{") {
			nesting++;
			deepest = Math.max(deepest, nesting);
		}
		if (value === "}") nesting = Math.max(0, nesting - 1);
		if (
			value === "if" ||
			value === "for" ||
			value === "while" ||
			value === "case" ||
			value === "catch" ||
			value === "?" ||
			value === "&&" ||
			value === "||"
		)
			branches++;
	}
	const start = tokenAt(tokens, startIndex);
	const end = tokenAt(tokens, endIndex - 1);
	const lines = start === undefined || end === undefined ? 1 : end.end.line - start.start.line + 1;
	return {
		lines: Math.max(1, lines),
		...(parameterCount === undefined ? {} : { parameters: parameterCount }),
		nesting: deepest,
		branches,
	};
}

function isNameToken(token: Token | undefined): boolean {
	return token?.kind === "identifier" && !KEYWORDS.has(token.value);
}

function namePath(record: DraftRecord | null): Descriptor[] {
	if (record === null) return [];
	return [...namePath(record.parent), ...(record.qualifier ?? []), record.own];
}

function formatType(tokens: Token[], indexes: number[]): string {
	const filtered = indexes.filter((index) => {
		const value = tokenAt(tokens, index)?.text;
		return (
			value !== "const" &&
			value !== "volatile" &&
			value !== "static" &&
			value !== "constexpr" &&
			value !== "inline"
		);
	});
	if (filtered.length === 0) return "";
	const first = filtered[0] as number;
	const last = (filtered.at(-1) as number) + 1;
	return joinTokens(tokens, first, last);
}

function isAutoType(typeText: string): boolean {
	return typeText === "auto" || typeText.startsWith("decltype(auto)");
}

function inferExpressionType(tokens: Token[], startIndex: number, endIndex: number): string | null {
	let current = startIndex;
	while (current < endIndex && !isSignificant(tokenAt(tokens, current) as Token)) current++;
	const token = tokenAt(tokens, current);
	if (token === undefined) return null;
	if (token.kind === "string") return "const char*";
	if (token.kind === "number") return /[.eE]/.test(token.text) ? "double" : "int";
	if (token.value === "true" || token.value === "false") return "bool";
	if (token.value === "new") {
		const next = significantAfter(tokens, current, endIndex);
		const name = tokenAt(tokens, next);
		return name === undefined ? null : `${name.value}*`;
	}
	return null;
}

function draftTypeFor(
	typeText: string,
	tokens: Token[],
	initializerStart: number,
	initializerEnd: number,
): DraftType | undefined {
	if (typeText === "") return undefined;
	if (isAutoType(typeText)) {
		const inferred = inferExpressionType(tokens, initializerStart, initializerEnd);
		return inferred === null
			? { status: "unknown", reason: "NotImplemented", detail: "the initializer type is not inferred" }
			: { status: "inferred", display: inferred, basis: "initializer expression" };
	}
	return { status: "known", display: typeText };
}

const INTEGER_LITERAL = /^(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[oO][0-7]+|0[0-7]*|[1-9][0-9]*)$/;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function decodeNumberLiteral(text: string): number | undefined {
	const normalized = text.replaceAll("'", "");
	const integerText = normalized.replace(/[uUlL]+$/, "");
	if (INTEGER_LITERAL.test(integerText)) {
		try {
			const integer = /^0[0-7]+$/.test(integerText) ? BigInt(`0o${integerText.slice(1)}`) : BigInt(integerText);
			return integer <= MAX_SAFE_INTEGER_BIGINT ? Number(integer) : undefined;
		} catch {
			return undefined;
		}
	}
	const number = Number(normalized);
	return Number.isFinite(number) ? number : undefined;
}

function unknownTemplateType(detail: string): DraftType {
	return { status: "unknown", reason: "NotImplemented", detail };
}

class StructuralParser {
	private readonly drafts: DraftRecord[] = [];
	private readonly roleByToken = new Map<number, Reference["role"]>();
	private readonly excludedTokenIndexes = new Set<number>();
	private readonly declarationSpecifierTokenIndexes = new Set<number>();
	private readonly typeTokenIndexes = new Set<number>();
	private readonly templateTokenIndexes = new Set<number>();
	private readonly diagnostics: Diagnostic[];
	private readonly imports: ImportFact[] = [];

	constructor(
		private readonly module: string,
		private readonly tokens: Token[],
		diagnostics: Diagnostic[],
	) {
		this.diagnostics = diagnostics.map((item) => ({ ...item, path: module }));
	}

	parse(): void {
		this.collectIncludes();
		this.parseScope(0, this.tokens.length, {
			parent: null,
			kind: "module",
			defaultVisibility: "public",
			templateDependent: false,
		});
		this.checkDelimiters();
		this.settleQualifiers();
	}

	finish(): CppFacts {
		this.assignDisambiguators();
		const recordMap = new Map<DraftRecord, CppDeclarationRecord>();
		for (const draft of this.drafts) {
			const record = this.materializeRecord(draft, recordMap);
			recordMap.set(draft, record);
		}
		const references = this.extractReferences(recordMap);
		const literals = this.extractLiterals(recordMap);
		const comments = this.extractComments();
		const typeAnswers = new Map<string, TypeInfo>();
		for (const [draft, record] of recordMap) {
			if (draft?.type === undefined) continue;
			const answer = draft.type;
			typeAnswers.set(
				record.declaration.symbolId,
				answer.status === "known" ? { ...answer, provenance: "declared" } : answer,
			);
		}
		return {
			declarations: [...recordMap.values()].map((record) => record.declaration),
			references,
			imports: this.imports.map((item) => item.imported),
			literals,
			comments,
			diagnostics: this.sortedDiagnostics(),
			records: [...recordMap.values()],
			importFacts: this.imports,
			typeAnswers,
		};
	}

	private addDiagnostic(message: string, startIndex: number, endIndex = startIndex + 1): void {
		const range = rangeFrom(this.tokens, startIndex, endIndex);
		if (range === null) return;
		if (
			this.diagnostics.some(
				(item) =>
					item.message === message &&
					item.range !== undefined &&
					comparePositions(item.range.start, range.start) === 0,
			)
		)
			return;
		this.diagnostics.push({ severity: "error", message, range, path: this.module });
	}

	private sortedDiagnostics(): Diagnostic[] {
		return [...this.diagnostics].sort((left, right) => {
			const leftStart = left.range?.start ?? {
				line: Number.MAX_SAFE_INTEGER,
				character: Number.MAX_SAFE_INTEGER,
			};
			const rightStart = right.range?.start ?? {
				line: Number.MAX_SAFE_INTEGER,
				character: Number.MAX_SAFE_INTEGER,
			};
			return comparePositions(leftStart, rightStart) || left.message.localeCompare(right.message);
		});
	}

	private collectIncludes(): void {
		for (let index = 0; index < this.tokens.length; index++) {
			const token = tokenAt(this.tokens, index);
			if (token?.text !== "#") continue;
			const directive = this.nextOnLine(index);
			if (directive < 0 || tokenAt(this.tokens, directive)?.value !== "include") continue;
			const target = this.nextOnLine(directive);
			if (target < 0) {
				this.addDiagnostic("#include needs a header name.", index);
				continue;
			}
			const targetToken = tokenAt(this.tokens, target);
			if (targetToken?.kind === "string") {
				this.imports.push({
					imported: { specifier: targetToken.value, imported: [], reExport: false },
					quoted: true,
					tokenStart: index,
					tokenEnd: target + 1,
				});
				this.markLine(index);
				continue;
			}
			if (targetToken?.text !== "<") {
				this.addDiagnostic("#include needs a quoted or bracketed header name.", target);
				this.markLine(index);
				continue;
			}
			const close = this.findLineText(target, ">", this.nextLine(index));
			let end = close;
			if (close < 0 || tokenAt(this.tokens, close)?.text !== ">") {
				this.addDiagnostic("#include header is not closed.", target);
				end = this.nextLine(index);
			} else {
				const parts: string[] = [];
				for (let part = target + 1; part < close; part++) {
					const item = tokenAt(this.tokens, part);
					if (item !== undefined && item.kind !== "newline" && item.kind !== "comment") parts.push(item.text);
				}
				this.imports.push({
					imported: { specifier: parts.join(""), imported: [], reExport: false },
					quoted: false,
					tokenStart: index,
					tokenEnd: close + 1,
				});
				end = close;
			}
			this.markRange(index, Math.max(index, end) + 1);
		}
	}

	private nextLine(index: number): number {
		for (let current = index; current < this.tokens.length; current++) {
			if (tokenAt(this.tokens, current)?.kind === "newline") return current;
		}
		return this.tokens.length;
	}

	private findLineText(startIndex: number, value: string, limit: number): number {
		for (let index = startIndex; index < limit; index++) {
			const token = tokenAt(this.tokens, index);
			if (token?.kind === "newline") return -1;
			if (token?.text === value) return index;
		}
		return -1;
	}

	private nextOnLine(index: number): number {
		let current = index + 1;
		while (current < this.tokens.length) {
			const token = tokenAt(this.tokens, current);
			if (token?.kind === "newline") return -1;
			if (token !== undefined && isSignificant(token)) return current;
			current++;
		}
		return -1;
	}

	private markLine(index: number): void {
		this.markRange(index, this.nextLine(index));
	}

	private markRange(startIndex: number, endIndex: number): void {
		for (let index = startIndex; index < endIndex; index++) this.templateTokenIndexes.add(index);
	}

	private checkDelimiters(): void {
		const stack: Array<{ value: string; index: number }> = [];
		const closes = new Map([
			[")", "("],
			["]", "["],
			["}", "{"],
		]);
		for (let index = 0; index < this.tokens.length; index++) {
			const value = tokenAt(this.tokens, index)?.text;
			if (value === "(" || value === "[" || value === "{") {
				stack.push({ value, index });
				continue;
			}
			const expected = closes.get(value ?? "");
			if (expected === undefined) continue;
			const opening = stack.at(-1);
			if (opening?.value === expected) {
				stack.pop();
			} else {
				this.addDiagnostic(`Unexpected closing delimiter ${value}.`, index);
			}
		}
		for (const opening of stack)
			this.addDiagnostic(`Opening delimiter ${opening.value} is not closed.`, opening.index);
	}

	private assignDisambiguators(): void {
		const groups = new Map<string, DraftRecord[]>();
		for (const draft of this.drafts) {
			if (draft.own.kind !== "method") continue;
			const key = namePath(draft)
				.map((descriptor) => `${descriptor.kind}:${descriptor.name}`)
				.join("/");
			const group = groups.get(key) ?? [];
			group.push(draft);
			groups.set(key, group);
		}
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			// Numbered where each is reported, so a merged definition counts at its body, not its prototype.
			group.sort((left, right) => left.startIndex - right.startIndex);
			for (let index = 1; index < group.length; index++) {
				const draft = group[index];
				if (draft !== undefined) draft.own.disambiguator = String(index);
			}
		}
	}

	private settleQualifiers(): void {
		const declared = (name: string): Descriptor | undefined =>
			this.drafts.find(
				(draft) =>
					draft.name === name &&
					(draft.kind === "class" || draft.kind === "struct" || draft.kind === "namespace"),
			)?.own;
		for (const draft of this.drafts) {
			if (draft.qualifierNames === undefined) continue;
			draft.qualifier = qualifierDescriptors(draft.qualifierNames, declared);
		}
	}

	private materializeRecord(
		draft: DraftRecord,
		recordMap: Map<DraftRecord, CppDeclarationRecord>,
	): CppDeclarationRecord {
		const parentRecord = draft.parent === null ? null : (recordMap.get(draft.parent) ?? null);
		if (draft.parent !== null && parentRecord === null) throw new Error("declaration parent is missing");
		const path = [...namePath(draft)];
		const symbolId = composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: path });
		const range =
			rangeFrom(this.tokens, draft.startIndex, draft.endIndex) ??
			rangeOfToken(this.tokens[draft.startIndex] as Token);
		const selection = rangeFrom(this.tokens, draft.nameStartIndex, draft.nameEndIndex) ?? range;
		const declaration: Declaration = {
			symbolId,
			kind: draft.kind,
			name: draft.name,
			range,
			selectionRange: selection,
			visibility: draft.visibility,
			...(draft.languageKind === undefined ? {} : { languageKind: draft.languageKind }),
			...(draft.exported ? { exported: true } : {}),
			...(draft.signature === undefined ? {} : { signature: draft.signature }),
			// A written qualifier the file does not declare is identity only; the container is what the file declares.
			...(draft.parent === null
				? {}
				: {
						containerId: composeSymbolId({
							language: LANGUAGE,
							module: this.module,
							descriptors: namePath(draft.parent),
						}),
					}),
			...(draft.metrics === undefined ? {} : { metrics: draft.metrics }),
		};
		return {
			declaration,
			parent: parentRecord,
			own: draft.own,
			tokenStart: draft.startIndex,
			tokenEnd: draft.endIndex,
			nameTokenStart: draft.nameStartIndex,
			nameTokenEnd: draft.nameEndIndex,
			templateDependent: draft.templateDependent,
			parameterNames: draft.parameterNames,
		};
	}

	private extractReferences(recordMap: Map<DraftRecord, CppDeclarationRecord>): CppReferenceRecord[] {
		const references: CppReferenceRecord[] = [];
		for (let index = 0; index < this.tokens.length; index++) {
			const token = tokenAt(this.tokens, index);
			if (
				token?.kind !== "identifier" ||
				(this.excludedTokenIndexes.has(index) && !this.roleByToken.has(index)) ||
				this.templateTokenIndexes.has(index)
			)
				continue;
			if (KEYWORDS.has(token.value) || TYPE_WORDS.has(token.value)) continue;
			const range = rangeOfToken(token);
			const from = this.containingRecord(index, recordMap);
			const role = this.roleByToken.get(index) ?? this.referenceRole(index);
			references.push({
				name: token.value,
				range,
				role,
				tokenIndex: index,
				from,
				qualifiedPath: this.qualifiedPath(index),
				templateDependent: from?.templateDependent ?? false,
			});
		}
		return references;
	}

	/** Read from tokens, so a marker inside a string is never one. */
	private extractComments(): CommentSpan[] {
		const comments: CommentSpan[] = [];
		for (const token of this.tokens) {
			if (token.kind !== "comment") continue;
			comments.push({ range: rangeOfToken(token), text: token.text });
		}
		return comments;
	}

	private extractLiterals(recordMap: Map<DraftRecord, CppDeclarationRecord>): Literal[] {
		const literals: Literal[] = [];
		for (let index = 0; index < this.tokens.length; index++) {
			const token = tokenAt(this.tokens, index);
			if (token === undefined || this.templateTokenIndexes.has(index)) continue;
			const container = this.containingRecord(index, recordMap);
			const containerId = container?.declaration.symbolId;
			if (token.kind === "string") {
				literals.push({
					kind: "string",
					value: token.value,
					range: rangeOfToken(token),
					...(containerId === undefined ? {} : { containerId }),
				});
				continue;
			}
			if (token.kind === "number") {
				const number = decodeNumberLiteral(token.text);
				literals.push({
					kind: "number",
					value: token.text,
					...(Number.isFinite(number) ? { number } : {}),
					range: rangeOfToken(token),
					...(containerId === undefined ? {} : { containerId }),
				});
				continue;
			}
			if (token.kind === "identifier" && (token.value === "true" || token.value === "false")) {
				literals.push({
					kind: "boolean",
					value: token.value,
					range: rangeOfToken(token),
					...(containerId === undefined ? {} : { containerId }),
				});
			}
		}
		return literals;
	}

	private containingRecord(
		index: number,
		recordMap: Map<DraftRecord, CppDeclarationRecord>,
	): CppDeclarationRecord | null {
		let best: CppDeclarationRecord | null = null;
		for (const record of recordMap.values()) {
			if (index < record.tokenStart || index >= record.tokenEnd) continue;
			if (best === null || record.declaration.symbolId.length > best.declaration.symbolId.length) best = record;
		}
		return best;
	}

	private referenceRole(index: number): Reference["role"] {
		const previous = significantBefore(this.tokens, index);
		const next = significantAfter(this.tokens, index);
		const previousValue = tokenAt(this.tokens, previous)?.text;
		const nextValue = tokenAt(this.tokens, next)?.text;
		if (this.typeTokenIndexes.has(index)) return "typeUse";
		if (previousValue === "new") return "instantiate";
		if (nextValue === "(" || nextValue === "<") return "call";
		if (ASSIGNMENT_OPERATORS.has(nextValue ?? "") || nextValue === "++" || nextValue === "--") return "write";
		if (previousValue === "++" || previousValue === "--") return "write";
		return "read";
	}

	private qualifiedPath(index: number): string[] {
		const token = tokenAt(this.tokens, index);
		if (token === undefined) return [];
		const path = [token.value];
		let current = significantBefore(this.tokens, index);
		while (current >= 0 && tokenAt(this.tokens, current)?.text === "::") {
			const name = significantBefore(this.tokens, current);
			const previous = tokenAt(this.tokens, name);
			if (previous?.kind !== "identifier") break;
			path.unshift(previous.value);
			current = significantBefore(this.tokens, name);
		}
		return path;
	}

	private parseScope(startIndex: number, limit: number, scope: Scope): number {
		let index = startIndex;
		let access = scope.defaultVisibility;
		let guard = -1;
		while (index < limit) {
			if (index <= guard) throw new Error("scope parser failed to advance");
			guard = index;
			const token = tokenAt(this.tokens, index);
			if (token === undefined) return index;
			if (!isSignificant(token)) {
				index++;
				continue;
			}
			if (token.text === "}") return index;
			if (token.text === "#") {
				index = this.nextLine(index);
				continue;
			}
			const accessValue = token.text;
			const accessColon = significantAfter(this.tokens, index, limit);
			if (
				(accessValue === "public" || accessValue === "protected" || accessValue === "private") &&
				tokenAt(this.tokens, accessColon)?.text === ":"
			) {
				access = accessValue;
				index = accessColon + 1;
				continue;
			}
			if (scope.kind !== "function") {
				const macroEnd = this.macroInvocationEnd(index, limit);
				if (macroEnd >= 0) {
					for (let excluded = index; excluded < macroEnd; excluded++) {
						if (tokenAt(this.tokens, excluded)?.kind === "identifier")
							this.excludedTokenIndexes.add(excluded);
					}
					index = macroEnd;
					continue;
				}
				const next = significantAfter(this.tokens, index, limit);
				const nextToken = tokenAt(this.tokens, next);
				if (isShoutCase(token.value) && this.isStandaloneMacroPrefix(index, next, nextToken, limit)) {
					this.excludedTokenIndexes.add(index);
					index++;
					continue;
				}
			}
			const prefix = this.readPrefix(index, limit);
			if (prefix === null) {
				index++;
				continue;
			}
			if (prefix.explicitInstantiation) {
				index = this.parseExplicitInstantiation(prefix, limit);
				continue;
			}
			const keyword = tokenAt(this.tokens, prefix.keywordIndex)?.text;
			// A linkage block, `extern "C" { ... }`, is transparent: its body belongs to this scope.
			if (keyword === "{" && prefix.modifiers.has("extern")) {
				const close = matching(this.tokens, prefix.keywordIndex, "{", "}", limit);
				if (close < 0) this.addDiagnostic("Linkage block is not closed.", prefix.keywordIndex);
				this.parseScope(prefix.keywordIndex + 1, close < 0 ? limit : close, scope);
				index = close < 0 ? limit : close + 1;
				continue;
			}
			if (keyword === "namespace") {
				index = this.parseNamespace(prefix, limit, scope);
				continue;
			}
			if (keyword === "class" || keyword === "struct" || keyword === "union") {
				index = this.parseClass(prefix, limit, scope, access);
				continue;
			}
			if (keyword === "enum") {
				index = this.parseEnum(prefix, limit, scope, access);
				continue;
			}
			if (keyword === "using") {
				index = this.parseUsing(prefix, limit, scope, access);
				continue;
			}
			if (keyword === "typedef") {
				index = this.parseTypedef(prefix, limit, scope, access);
				continue;
			}
			const functionOpen = this.functionOpen(prefix, limit);
			if (functionOpen >= 0) {
				const next = this.parseFunction(prefix, functionOpen, limit, scope, access);
				if (next > index) {
					index = next;
					continue;
				}
			}
			const end = statementEnd(this.tokens, index, limit);
			this.parseVariableStatement(prefix, end + 1, scope, access);
			index = end >= index ? end + 1 : index + 1;
		}
		return index;
	}

	// Prefixes must occupy their own source line.
	private isStandaloneMacroPrefix(index: number, next: number, nextToken: Token | undefined, limit: number): boolean {
		const token = tokenAt(this.tokens, index);
		const previous = significantBefore(this.tokens, index);
		if (token === undefined || (previous >= 0 && tokenAt(this.tokens, previous)?.end.line === token.start.line))
			return false;
		if (next < 0 || nextToken === undefined || nextToken.start.line <= token.start.line) return false;
		let candidate = next;
		while (candidate >= 0) {
			const candidateToken = tokenAt(this.tokens, candidate);
			if (candidateToken?.text === "#") return true;
			if (candidateToken?.kind !== "identifier" || !isShoutCase(candidateToken.value)) return false;
			if (this.macroInvocationEnd(candidate, limit) >= 0) return true;
			// Every bare prefix in the chain is alone on its line too.
			const following = significantAfter(this.tokens, candidate, limit);
			if (following < 0 || (tokenAt(this.tokens, following)?.start.line ?? -1) <= candidateToken.start.line)
				return false;
			candidate = following;
		}
		return false;
	}

	private macroInvocationEnd(startIndex: number, limit: number): number {
		const name = tokenAt(this.tokens, startIndex);
		if (name?.kind !== "identifier" || !isShoutCase(name.value)) return -1;
		const open = significantAfter(this.tokens, startIndex, limit);
		if (tokenAt(this.tokens, open)?.text !== "(") return -1;
		const close = matching(this.tokens, open, "(", ")", limit);
		if (close < 0) return -1;
		const next = significantAfter(this.tokens, close, limit);
		const nextValue = tokenAt(this.tokens, next)?.text;
		if (
			nextValue === "{" ||
			nextValue === ":" ||
			nextValue === "=" ||
			nextValue === "->" ||
			nextValue === "const" ||
			nextValue === "noexcept" ||
			nextValue === "override" ||
			nextValue === "final" ||
			nextValue === "try" ||
			nextValue === "&" ||
			nextValue === "&&" ||
			nextValue === "("
		)
			return -1;
		if (nextValue === ".") return statementEnd(this.tokens, close + 1, limit) + 1;
		return nextValue === ";" ? next + 1 : close + 1;
	}

	private readPrefix(startIndex: number, limit: number): Prefix | null {
		let index = startIndex;
		let template: TemplateInfo | null = null;
		let explicitInstantiation = false;
		if (tokenAt(this.tokens, index)?.text === "template") {
			const open = significantAfter(this.tokens, index, limit);
			if (tokenAt(this.tokens, open)?.text === "<") {
				const close = matchingAngle(this.tokens, open, limit);
				if (close < 0) {
					this.addDiagnostic("Template parameter list is not closed.", open);
					return null;
				}
				template = this.templateInfo(open, close, index);
				index = significantAfter(this.tokens, close, limit);
				if (index < 0) return null;
			} else if (open >= 0) {
				explicitInstantiation = true;
				index = open;
			} else {
				this.addDiagnostic("Template declaration needs a declaration.", index);
				return null;
			}
		}
		const modifiers = new Set<string>();
		let exported = false;
		let guard = -1;
		while (index >= 0 && index < limit) {
			if (index <= guard) throw new Error("declaration prefix failed to advance");
			guard = index;
			const token = tokenAt(this.tokens, index);
			const specifierEnd = this.declarationSpecifierEnd(index, limit);
			if (specifierEnd !== undefined) {
				if (specifierEnd < 0) return null;
				for (let consumed = index; consumed < specifierEnd; consumed++) {
					this.declarationSpecifierTokenIndexes.add(consumed);
					if (tokenAt(this.tokens, consumed)?.kind === "identifier") this.excludedTokenIndexes.add(consumed);
				}
				index = significantAfter(this.tokens, specifierEnd - 1, limit);
				continue;
			}
			if (token?.kind === "string" && modifiers.has("extern")) {
				index = significantAfter(this.tokens, index, limit);
				continue;
			}
			if (token?.text === "export") exported = true;
			if (token === undefined || !MODIFIERS.has(token.text)) break;
			modifiers.add(token.text);
			index = significantAfter(this.tokens, index, limit);
		}
		if (index < 0 || tokenAt(this.tokens, index) === undefined) return null;
		return { startIndex, keywordIndex: index, template, explicitInstantiation, modifiers, exported };
	}

	private parseExplicitInstantiation(prefix: Prefix, limit: number): number {
		const end = statementEnd(this.tokens, prefix.startIndex, limit);
		this.templateTokenIndexes.add(prefix.startIndex);
		this.markRoleAfter(prefix.keywordIndex, end + 1, "instantiate");
		return Math.max(prefix.startIndex + 1, end + 1);
	}

	private declarationSpecifierEnd(index: number, limit: number): number | undefined {
		const token = tokenAt(this.tokens, index);
		const next = significantAfter(this.tokens, index, limit);
		const isBracketSpecifier = token?.text === "[" && tokenAt(this.tokens, next)?.text === "[";
		if (isBracketSpecifier) {
			const close = matching(this.tokens, index, "[", "]", limit);
			if (close < 0) {
				this.addDiagnostic("Attribute specifier is not closed.", index);
				return -1;
			}
			return close + 1;
		}
		if (token?.kind !== "identifier" || !DECLARATION_SPECIFIERS.has(token.value)) return undefined;
		if (tokenAt(this.tokens, next)?.text !== "(") return undefined;
		const close = matching(this.tokens, next, "(", ")", limit);
		if (close < 0) {
			this.addDiagnostic("Attribute specifier is not closed.", index);
			return -1;
		}
		return close + 1;
	}

	private templateInfo(openIndex: number, closeIndex: number, startIndex: number): TemplateInfo {
		const parameters: TemplateParameter[] = [];
		let segmentStart = openIndex + 1;
		let depth = 0;
		for (let index = openIndex + 1; index <= closeIndex; index++) {
			const value = tokenAt(this.tokens, index)?.text;
			depth += angleDelta(value ?? "");
			if ((value === "," && depth === 0) || index === closeIndex) {
				const end = index === closeIndex ? index : index;
				const nameIndex = this.lastName(segmentStart, end);
				if (nameIndex >= 0) {
					const typeText = joinTokens(this.tokens, segmentStart, nameIndex);
					const name = tokenAt(this.tokens, nameIndex)?.value ?? "";
					parameters.push({
						name,
						nameStartIndex: nameIndex,
						nameEndIndex: nameIndex + 1,
						startIndex: segmentStart,
						endIndex: end,
						typeText,
					});
				}
				segmentStart = index + 1;
			}
		}
		this.markRange(startIndex, closeIndex + 1);
		return { startIndex, endIndex: closeIndex + 1, parameters };
	}

	private parseNamespace(prefix: Prefix, limit: number, scope: Scope): number {
		let index = significantAfter(this.tokens, prefix.keywordIndex, limit);
		const names: Array<{ name: string; start: number; end: number }> = [];
		while (index >= 0 && index < limit) {
			const token = tokenAt(this.tokens, index);
			if (isNameToken(token)) {
				names.push({ name: token?.value ?? "namespace", start: index, end: index + 1 });
				const separator = significantAfter(this.tokens, index, limit);
				if (tokenAt(this.tokens, separator)?.text !== "::") {
					index = separator;
					break;
				}
				index = significantAfter(this.tokens, separator, limit);
				continue;
			}
			break;
		}
		if (names.length === 0 && tokenAt(this.tokens, index)?.text !== "{") {
			this.addDiagnostic("Namespace declaration needs a name or body.", prefix.keywordIndex);
			return statementEnd(this.tokens, prefix.startIndex, limit) + 1;
		}
		const open = this.findNextText(index, "{", limit);
		const aliasEnd = this.findNextText(index, ";", limit);
		if (open < 0 || (aliasEnd >= 0 && aliasEnd < open)) {
			if (names.length > 0) {
				const end = aliasEnd >= 0 ? aliasEnd + 1 : Math.max(prefix.startIndex + 1, index);
				let parent = scope.parent;
				for (const item of names) {
					parent = this.addDraft({
						parent,
						own: { kind: "namespace", name: item.name },
						kind: "namespace",
						name: item.name,
						visibility: this.visibilityFor(scope, prefix.modifiers),
						exported: prefix.exported,
						startIndex: prefix.startIndex,
						endIndex: end,
						nameStartIndex: item.start,
						nameEndIndex: item.end,
						signature: joinTokens(this.tokens, prefix.startIndex, end),
						metrics: bodyMetrics(this.tokens, prefix.startIndex, end),
						templateDependent: scope.templateDependent,
						parameterNames: new Set(),
					});
				}
			}
			return aliasEnd >= 0 ? aliasEnd + 1 : Math.max(prefix.startIndex + 1, index);
		}
		const close = matching(this.tokens, open, "{", "}", limit);
		const end = close < 0 ? limit : close + 1;
		let parent = scope.parent;
		for (const item of names.length === 0 ? [{ name: ANONYMOUS_NAMESPACE, start: open, end: open + 1 }] : names) {
			parent = this.addDraft({
				parent,
				own: { kind: "namespace", name: item.name },
				kind: "namespace",
				name: item.name,
				visibility: this.visibilityFor(scope, prefix.modifiers),
				languageKind: prefix.modifiers.has("inline") ? "inline" : undefined,
				exported: prefix.exported,
				startIndex: prefix.startIndex,
				endIndex: end,
				nameStartIndex: item.start,
				nameEndIndex: item.end,
				signature: joinTokens(this.tokens, prefix.startIndex, open),
				metrics: bodyMetrics(this.tokens, prefix.startIndex, end),
				templateDependent: this.templateDependent(scope, prefix),
				parameterNames: new Set(),
			});
		}
		if (close < 0) this.addDiagnostic("Namespace body is not closed.", open);
		else {
			this.parseScope(open + 1, close, {
				parent,
				kind: "namespace",
				defaultVisibility: "public",
				templateDependent: scope.templateDependent,
			});
		}
		return end;
	}

	private parseClass(prefix: Prefix, limit: number, scope: Scope, access: Visibility): number {
		const keyword = tokenAt(this.tokens, prefix.keywordIndex)?.text ?? "class";
		const nameIndex = significantAfter(this.tokens, prefix.keywordIndex, limit);
		const named = isNameToken(tokenAt(this.tokens, nameIndex));
		const actualNameIndex = named ? nameIndex : prefix.keywordIndex;
		const name = named ? (tokenAt(this.tokens, nameIndex)?.value ?? "") : ANONYMOUS_NAMESPACE;
		const body = this.findNextText(nameIndex >= 0 ? nameIndex : prefix.keywordIndex, "{", limit);
		const semicolon = this.findNextText(nameIndex >= 0 ? nameIndex : prefix.keywordIndex, ";", limit);
		const descriptorName = this.typeDescriptorName(prefix, nameIndex, body >= 0 ? body : limit, name);
		if (body < 0 || (semicolon >= 0 && semicolon < body)) {
			const end = semicolon >= 0 ? semicolon + 1 : Math.max(prefix.startIndex + 1, nameIndex + 1);
			if (!named) this.addDiagnostic("Class declaration needs a name.", prefix.keywordIndex);
			const record = this.addDraft({
				parent: scope.parent,
				own: { kind: "type", name: descriptorName },
				kind: keyword === "struct" ? "struct" : "class",
				name,
				visibility: this.visibilityFor(scope, prefix.modifiers, access),
				languageKind: keyword,
				exported: prefix.exported,
				startIndex: prefix.startIndex,
				endIndex: end,
				nameStartIndex: actualNameIndex,
				nameEndIndex: actualNameIndex + 1,
				signature: joinTokens(this.tokens, prefix.startIndex, end),
				metrics: bodyMetrics(this.tokens, prefix.startIndex, end),
				templateDependent: this.templateDependent(scope, prefix),
				parameterNames: new Set(),
			});
			this.addTemplateParameters(prefix.template, record, scope);
			return end;
		}
		const close = matching(this.tokens, body, "{", "}", limit);
		const end = close < 0 ? limit : this.optionalSemicolon(close, limit);
		const templateDependent = this.templateDependent(scope, prefix);
		const record = this.addDraft({
			parent: scope.parent,
			own: { kind: "type", name: descriptorName },
			kind: keyword === "struct" ? "struct" : "class",
			name,
			visibility: this.visibilityFor(scope, prefix.modifiers, access),
			languageKind: keyword,
			exported: prefix.exported,
			startIndex: prefix.startIndex,
			endIndex: end,
			nameStartIndex: actualNameIndex,
			nameEndIndex: actualNameIndex + 1,
			signature: joinTokens(this.tokens, prefix.startIndex, body),
			metrics: bodyMetrics(this.tokens, prefix.startIndex, end),
			templateDependent,
			parameterNames: new Set(),
		});
		this.addTemplateParameters(prefix.template, record, scope);
		this.markClassBases(nameIndex + 1, body);
		if (close < 0) this.addDiagnostic("Class body is not closed.", body);
		else {
			this.parseScope(body + 1, close, {
				parent: record,
				kind: "class",
				defaultVisibility: keyword === "struct" || keyword === "union" ? "public" : "private",
				templateDependent,
			});
		}
		return end;
	}

	private parseEnum(prefix: Prefix, limit: number, scope: Scope, access: Visibility): number {
		let index = significantAfter(this.tokens, prefix.keywordIndex, limit);
		let scoped = false;
		if (tokenAt(this.tokens, index)?.text === "class" || tokenAt(this.tokens, index)?.text === "struct") {
			scoped = true;
			index = significantAfter(this.tokens, index, limit);
		}
		const nameIndex = isNameToken(tokenAt(this.tokens, index)) ? index : prefix.keywordIndex;
		const name =
			nameIndex === prefix.keywordIndex
				? ANONYMOUS_NAMESPACE
				: (tokenAt(this.tokens, nameIndex)?.value ?? ANONYMOUS_NAMESPACE);
		const body = this.findNextText(nameIndex, "{", limit);
		const semicolon = this.findNextText(nameIndex, ";", limit);
		if (body < 0 || (semicolon >= 0 && semicolon < body)) {
			const end = semicolon >= 0 ? semicolon + 1 : Math.max(prefix.startIndex + 1, nameIndex + 1);
			const record = this.addDraft({
				parent: scope.parent,
				own: { kind: "type", name },
				kind: "enum",
				name,
				visibility: this.visibilityFor(scope, prefix.modifiers, access),
				languageKind: scoped ? "scoped enum" : "enum",
				exported: prefix.exported,
				startIndex: prefix.startIndex,
				endIndex: end,
				nameStartIndex: nameIndex,
				nameEndIndex: nameIndex + 1,
				signature: joinTokens(this.tokens, prefix.startIndex, end),
				metrics: bodyMetrics(this.tokens, prefix.startIndex, end),
				templateDependent: scope.templateDependent,
				parameterNames: new Set(),
			});
			this.addTemplateParameters(prefix.template, record, scope);
			return end;
		}
		const close = matching(this.tokens, body, "{", "}", limit);
		const end = close < 0 ? limit : this.optionalSemicolon(close, limit);
		const record = this.addDraft({
			parent: scope.parent,
			own: { kind: "type", name },
			kind: "enum",
			name,
			visibility: this.visibilityFor(scope, prefix.modifiers, access),
			languageKind: scoped ? "scoped enum" : "enum",
			exported: prefix.exported,
			startIndex: prefix.startIndex,
			endIndex: end,
			nameStartIndex: nameIndex,
			nameEndIndex: nameIndex + 1,
			signature: joinTokens(this.tokens, prefix.startIndex, body),
			metrics: bodyMetrics(this.tokens, prefix.startIndex, end),
			templateDependent: this.templateDependent(scope, prefix),
			parameterNames: new Set(),
		});
		this.parseEnumerators(body + 1, close < 0 ? limit : close, record, scope);
		if (close < 0) this.addDiagnostic("Enum body is not closed.", body);
		return end;
	}

	private parseEnumerators(startIndex: number, limit: number, parent: DraftRecord, scope: Scope): void {
		let segmentStart = startIndex;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = startIndex; index <= limit; index++) {
			const value = tokenAt(this.tokens, index)?.text;
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			const boundary = index === limit || (value === "," && parentheses === 0 && brackets === 0 && braces === 0);
			if (!boundary) continue;
			const nameIndex = this.firstName(segmentStart, index);
			if (nameIndex >= 0) {
				const end = Math.max(nameIndex + 1, index);
				this.addDraft({
					parent,
					own: { kind: "term", name: tokenAt(this.tokens, nameIndex)?.value ?? "enumerator" },
					kind: "constant",
					name: tokenAt(this.tokens, nameIndex)?.value ?? "enumerator",
					visibility: this.visibilityFor(scope, new Set(), scope.defaultVisibility),
					languageKind: "enumerator",
					exported: false,
					startIndex: segmentStart,
					endIndex: end,
					nameStartIndex: nameIndex,
					nameEndIndex: nameIndex + 1,
					signature: joinTokens(this.tokens, segmentStart, end),
					metrics: bodyMetrics(this.tokens, segmentStart, end),
					templateDependent: parent.templateDependent,
					parameterNames: new Set(),
				});
				this.excludedTokenIndexes.add(nameIndex);
			}
			segmentStart = index + 1;
		}
	}

	private parseUsing(prefix: Prefix, limit: number, scope: Scope, access: Visibility): number {
		const end = statementEnd(this.tokens, prefix.startIndex, limit);
		const next = significantAfter(this.tokens, prefix.keywordIndex, end);
		if (tokenAt(this.tokens, next)?.text === "namespace") {
			this.markRoleAfter(prefix.keywordIndex, end, "import");
			return end + 1;
		}
		const equals = this.findNextText(prefix.keywordIndex, "=", end);
		const nameIndex = significantAfter(this.tokens, prefix.keywordIndex, end);
		if (equals >= 0 && nameIndex >= 0 && tokenAt(this.tokens, nameIndex)?.kind === "identifier") {
			const name = tokenAt(this.tokens, nameIndex)?.value ?? "Alias";
			const typeIndexes = this.significantIndexes(equals + 1, end);
			for (const typeIndex of typeIndexes)
				if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
			this.addDraft({
				parent: scope.parent,
				own: { kind: "type", name },
				kind: "class",
				name,
				visibility: this.visibilityFor(scope, prefix.modifiers, access),
				languageKind: "using alias",
				exported: prefix.exported,
				startIndex: prefix.startIndex,
				endIndex: end + 1,
				nameStartIndex: nameIndex,
				nameEndIndex: nameIndex + 1,
				signature: joinTokens(this.tokens, prefix.startIndex, end + 1),
				metrics: bodyMetrics(this.tokens, prefix.startIndex, end + 1),
				type: { status: "known", display: joinTokens(this.tokens, equals + 1, end) || "type" },
				templateDependent: scope.templateDependent,
				parameterNames: new Set(),
			});
			return end + 1;
		}
		this.markRoleAfter(prefix.keywordIndex, end, "import");
		return end + 1;
	}

	private parseTypedef(prefix: Prefix, limit: number, scope: Scope, access: Visibility): number {
		const end = statementEnd(this.tokens, prefix.startIndex, limit);
		const nameIndex = this.lastName(prefix.keywordIndex + 1, end);
		if (nameIndex < 0) {
			this.addDiagnostic("Typedef declaration needs a name.", prefix.keywordIndex);
			return end + 1;
		}
		const typeIndexes = this.significantIndexes(prefix.keywordIndex + 1, nameIndex);
		for (const typeIndex of typeIndexes)
			if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
		this.addDraft({
			parent: scope.parent,
			own: { kind: "type", name: tokenAt(this.tokens, nameIndex)?.value ?? "Alias" },
			kind: "class",
			name: tokenAt(this.tokens, nameIndex)?.value ?? "Alias",
			visibility: this.visibilityFor(scope, prefix.modifiers, access),
			languageKind: "typedef",
			exported: prefix.exported,
			startIndex: prefix.startIndex,
			endIndex: end + 1,
			nameStartIndex: nameIndex,
			nameEndIndex: nameIndex + 1,
			signature: joinTokens(this.tokens, prefix.startIndex, end + 1),
			metrics: bodyMetrics(this.tokens, prefix.startIndex, end + 1),
			type: {
				status: "known",
				display: joinTokens(this.tokens, prefix.keywordIndex + 1, nameIndex) || "type",
			},
			templateDependent: scope.templateDependent,
			parameterNames: new Set(),
		});
		return end + 1;
	}

	private functionOpen(prefix: Prefix, limit: number): number {
		let parentheses = 0;
		let brackets = 0;
		for (let index = prefix.keywordIndex; index < limit; index++) {
			const value = tokenAt(this.tokens, index)?.text;
			if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			if (brackets > 0) continue;
			if (value === "(") {
				const previous = significantBefore(this.tokens, index);
				if (parentheses === 0 && tokenAt(this.tokens, previous)?.text === "operator") {
					const operatorClose = matching(this.tokens, index, "(", ")", limit);
					const next = operatorClose < 0 ? -1 : significantAfter(this.tokens, operatorClose, limit);
					if (operatorClose >= 0 && tokenAt(this.tokens, next)?.text === "(") {
						index = operatorClose;
						continue;
					}
				}
				if (parentheses === 0 && this.functionName(index, prefix) !== null) return index;
				parentheses++;
			}
			if (value === ")") parentheses = Math.max(0, parentheses - 1);
			if (parentheses === 0 && (value === ";" || value === "{" || value === "=")) return -1;
		}
		return -1;
	}

	private functionName(
		openIndex: number,
		prefix: Prefix,
	): {
		name: string;
		nameStartIndex: number;
		nameEndIndex: number;
		qualifier: string[];
		qualifierStart: number;
	} | null {
		const previous = significantBefore(this.tokens, openIndex);
		const previousToken = tokenAt(this.tokens, previous);
		if (previousToken === undefined) return null;
		let name = "";
		let nameStartIndex = previous;
		let nameEndIndex = previous + 1;
		if (previousToken.text === "operator") {
			name = "operator";
		} else if (previousToken.text === ">" || previousToken.text === ">>") {
			const templateName = this.templateNameBefore(openIndex, prefix);
			if (templateName === null) return null;
			name = templateName.name;
			nameStartIndex = templateName.nameStartIndex;
			nameEndIndex = openIndex;
		} else if (previousToken.kind === "punctuation") {
			const operator = this.findPreviousText(previous, "operator", prefix.keywordIndex);
			if (operator < 0) return null;
			const suffix = joinTokens(this.tokens, operator + 1, openIndex);
			name = `operator${suffix}`;
			nameStartIndex = operator;
			nameEndIndex = openIndex;
		} else if (previousToken.kind === "identifier") {
			name = previousToken.value;
			const beforeName = significantBefore(this.tokens, previous);
			if (tokenAt(this.tokens, beforeName)?.text === "operator") {
				name = `operator ${name}`;
				nameStartIndex = beforeName;
			} else if (tokenAt(this.tokens, beforeName)?.text === "~") {
				name = `~${name}`;
				nameStartIndex = beforeName;
			}
		} else {
			return null;
		}
		if (CONTROL_NAMES.has(name) || CONTROL_NAMES.has(previousToken.value)) return null;
		const beforeName = significantBefore(this.tokens, nameStartIndex);
		const beforeValue = tokenAt(this.tokens, beforeName)?.text;
		if (beforeValue === "=" || beforeValue === "," || beforeValue === "return") return null;
		const qualifier: string[] = [];
		let qualifierStart = nameStartIndex;
		let current = significantBefore(this.tokens, nameStartIndex);
		while (current >= prefix.keywordIndex && tokenAt(this.tokens, current)?.text === "::") {
			const qualifierName = significantBefore(this.tokens, current);
			const segment = this.templateQualifierBefore(qualifierName, prefix);
			if (segment === null) break;
			qualifier.unshift(segment.name);
			qualifierStart = segment.startIndex;
			current = significantBefore(this.tokens, segment.startIndex);
		}
		return { name, nameStartIndex, nameEndIndex, qualifier, qualifierStart };
	}

	private templateQualifierBefore(index: number, prefix: Prefix): { name: string; startIndex: number } | null {
		const token = tokenAt(this.tokens, index);
		if (token?.kind === "identifier") return { name: token.value, startIndex: index };
		if (token?.text !== ">" && token?.text !== ">>") return null;
		let depth = 0;
		for (let current = index; current >= prefix.keywordIndex; current--) {
			const value = tokenAt(this.tokens, current)?.text;
			depth -= angleDelta(value ?? "");
			if (value === "<") {
				if (depth === 0) {
					const nameIndex = significantBefore(this.tokens, current);
					const name = tokenAt(this.tokens, nameIndex);
					return name?.kind === "identifier" ? { name: name.value, startIndex: nameIndex } : null;
				}
			}
		}
		return null;
	}

	private templateNameBefore(openIndex: number, prefix: Prefix): { name: string; nameStartIndex: number } | null {
		const closeIndex = significantBefore(this.tokens, openIndex);
		const close = tokenAt(this.tokens, closeIndex)?.text;
		if (close !== ">" && close !== ">>") return null;
		let depth = close === ">>" ? 2 : 1;
		for (let index = closeIndex - 1; index >= prefix.keywordIndex; index--) {
			const value = tokenAt(this.tokens, index)?.text;
			depth -= angleDelta(value ?? "");
			if (value === "<") {
				if (depth !== 0) continue;
				const nameIndex = significantBefore(this.tokens, index);
				const nameToken = tokenAt(this.tokens, nameIndex);
				if (nameToken === undefined || nameToken.kind !== "identifier" || KEYWORDS.has(nameToken.value))
					return null;
				return { name: nameToken.value, nameStartIndex: nameIndex };
			}
		}
		return null;
	}

	private templateDependent(scope: Scope, prefix: Prefix): boolean {
		return scope.templateDependent || (prefix.template?.parameters.length ?? 0) > 0;
	}

	private typeDescriptorName(prefix: Prefix, nameIndex: number, limit: number, name: string): string {
		if (name === "" || prefix.template?.parameters.length !== 0) return name;
		const open = significantAfter(this.tokens, nameIndex, limit);
		if (tokenAt(this.tokens, open)?.text !== "<") return name;
		const close = matchingAngle(this.tokens, open, limit);
		return close < 0 ? name : joinTokens(this.tokens, nameIndex, close + 1);
	}

	private parseFunction(prefix: Prefix, openIndex: number, limit: number, scope: Scope, access: Visibility): number {
		const nameInfo = this.functionName(openIndex, prefix);
		if (nameInfo === null) return prefix.startIndex;
		const close = matching(this.tokens, openIndex, "(", ")", limit);
		if (close < 0) {
			this.addDiagnostic("Function parameter list is not closed.", openIndex);
			return limit;
		}
		const bodyOrEnd = this.functionBodyOrEnd(close, limit);
		const body = bodyOrEnd.body;
		const declarationEnd =
			body >= 0 ? this.optionalSemicolon(matching(this.tokens, body, "{", "}", limit), limit) : bodyOrEnd.end + 1;
		const qualifiedParent = this.findQualifiedParent(nameInfo.qualifier);
		const parent = qualifiedParent ?? scope.parent;
		const member = parent?.kind === "class" || parent?.kind === "struct";
		const isConstructor = member && (nameInfo.name === parent?.name || nameInfo.name.startsWith("~"));
		const operator = nameInfo.name.startsWith("operator");
		const templateDependent = this.templateDependent(scope, prefix);
		const returnInfo = this.functionReturnType(prefix, nameInfo, close, bodyOrEnd.end);
		const qualifierNames = qualifiedParent === null ? nameInfo.qualifier : [];
		const parameterSignature = `${canonicalParameterSignature(this.tokens, openIndex + 1, close)})${functionQualifiers(this.tokens, close + 1, bodyOrEnd.end)}`;
		const existing = this.drafts.find(
			(draft) =>
				draft.parent === parent &&
				draft.own.name === nameInfo.name &&
				draft.parameterSignature === parameterSignature &&
				JSON.stringify(draft.qualifierNames ?? []) === JSON.stringify(qualifierNames),
		);
		const record =
			existing ??
			this.addDraft({
				parent,
				...(qualifierNames.length === 0 ? {} : { qualifierNames }),
				own: { kind: "method", name: nameInfo.name },
				kind: operator ? "operator" : isConstructor ? "constructor" : member ? "method" : "function",
				name: nameInfo.name,
				visibility: this.visibilityFor(scope, prefix.modifiers, access),
				languageKind: nameInfo.name.startsWith("operator")
					? "operator"
					: nameInfo.name.startsWith("~")
						? "destructor"
						: undefined,
				exported: prefix.exported,
				startIndex: prefix.startIndex,
				endIndex: Math.max(prefix.startIndex + 1, declarationEnd),
				nameStartIndex: nameInfo.nameStartIndex,
				nameEndIndex: nameInfo.nameEndIndex,
				signature: joinTokens(this.tokens, prefix.startIndex, body >= 0 ? body : bodyOrEnd.end + 1),
				metrics: bodyMetrics(this.tokens, prefix.startIndex, Math.max(prefix.startIndex + 1, declarationEnd)),
				type: templateDependent
					? unknownTemplateType("template-dependent return type is not resolved")
					: returnInfo,
				templateDependent,
				parameterNames: new Set(),
				parameterSignature,
				hasBody: body >= 0,
			});
		if (existing !== undefined && body >= 0) {
			if (!existing.hasBody) this.roleByToken.set(existing.nameStartIndex, "read");
			// The definition's own name is the declaration, not a use of it.
			for (let index = nameInfo.nameStartIndex; index < nameInfo.nameEndIndex; index++)
				this.excludedTokenIndexes.add(index);
			existing.startIndex = prefix.startIndex;
			existing.endIndex = Math.max(prefix.startIndex + 1, declarationEnd);
			existing.nameStartIndex = nameInfo.nameStartIndex;
			existing.nameEndIndex = nameInfo.nameEndIndex;
			existing.signature = joinTokens(this.tokens, prefix.startIndex, body);
			existing.metrics = bodyMetrics(
				this.tokens,
				prefix.startIndex,
				Math.max(prefix.startIndex + 1, declarationEnd),
			);
			existing.hasBody = true;
			existing.type = templateDependent
				? unknownTemplateType("template-dependent return type is not resolved")
				: returnInfo;
		} else if (existing !== undefined) {
			this.roleByToken.set(nameInfo.nameStartIndex, "read");
		}
		if (existing === undefined) this.addTemplateParameters(prefix.template, record, scope);
		const parameterCount =
			existing === undefined
				? this.parseParameters(openIndex + 1, close, record, templateDependent)
				: record.parameterNames.size;
		if (record.metrics !== undefined) record.metrics = { ...record.metrics, parameters: parameterCount };
		if (body >= 0) {
			const bodyClose = matching(this.tokens, body, "{", "}", limit);
			if (bodyClose < 0) this.addDiagnostic("Function body is not closed.", body);
			else {
				this.parseLocalStatements(body + 1, bodyClose, record, templateDependent);
				if (!templateDependent && returnInfo === undefined && this.hasAutoReturn(prefix, nameInfo))
					this.addTemplateReturnInference(record, body + 1, bodyClose);
			}
		}
		return Math.max(prefix.startIndex + 1, declarationEnd);
	}

	private functionBodyOrEnd(closeIndex: number, limit: number): { body: number; end: number } {
		let parentheses = 0;
		for (let index = closeIndex + 1; index < limit; index++) {
			const value = tokenAt(this.tokens, index)?.text;
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			if (parentheses !== 0) continue;
			if (value === "{") return { body: index, end: index };
			if (value === ";") return { body: -1, end: index };
		}
		return { body: -1, end: Math.max(closeIndex, limit - 1) };
	}

	private functionReturnType(
		prefix: Prefix,
		nameInfo: { nameStartIndex: number; qualifierStart: number },
		closeIndex: number,
		headerEnd: number,
	): DraftType | undefined {
		const arrow = this.findNextText(closeIndex, "->", headerEnd + 1);
		if (arrow >= 0) {
			const typeIndexes = this.significantIndexes(arrow + 1, headerEnd + 1);
			for (const typeIndex of typeIndexes)
				if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
			const display = formatType(this.tokens, typeIndexes);
			return display === "" ? undefined : { status: "known", display };
		}
		const returnIndexes = this.significantIndexes(prefix.keywordIndex, nameInfo.qualifierStart);
		const filtered = returnIndexes.filter((index) => !MODIFIERS.has(tokenAt(this.tokens, index)?.text ?? ""));
		for (const typeIndex of filtered)
			if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
		const display = formatType(this.tokens, filtered);
		if (display === "" || isAutoType(display)) return undefined;
		return { status: "known", display };
	}

	private parseParameters(
		startIndex: number,
		limit: number,
		parent: DraftRecord,
		templateDependent: boolean,
	): number {
		let parameterCount = 0;
		let segmentStart = startIndex;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = startIndex; index <= limit; index++) {
			const value = tokenAt(this.tokens, index)?.text;
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			const boundary = index === limit || (value === "," && parentheses === 0 && brackets === 0 && braces === 0);
			if (!boundary) continue;
			const equals = this.findNextText(segmentStart, "=", index);
			const nameIndex = this.lastName(segmentStart, equals >= 0 ? equals : index);
			if (nameIndex >= 0) {
				parameterCount++;
				const name = tokenAt(this.tokens, nameIndex)?.value ?? "parameter";
				const typeIndexes = this.significantIndexes(segmentStart, nameIndex).filter(
					(candidate) => candidate !== nameIndex,
				);
				for (const typeIndex of typeIndexes)
					if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
				const typeText = formatType(this.tokens, typeIndexes);
				const parameter = this.addDraft({
					parent,
					own: { kind: "parameter", name },
					kind: "variable",
					name,
					visibility: "local" as Visibility,
					languageKind: "parameter",
					exported: false,
					startIndex: segmentStart,
					endIndex: Math.max(nameIndex + 1, index),
					nameStartIndex: nameIndex,
					nameEndIndex: nameIndex + 1,
					signature: joinTokens(this.tokens, segmentStart, Math.max(nameIndex + 1, index)),
					metrics: bodyMetrics(this.tokens, segmentStart, Math.max(nameIndex + 1, index)),
					type: templateDependent
						? unknownTemplateType("template-dependent parameter type is not resolved")
						: typeText === ""
							? undefined
							: { status: "known", display: typeText },
					templateDependent,
					parameterNames: new Set(),
				});
				parent.parameterNames.add(name);
				this.excludedTokenIndexes.add(nameIndex);
				parameter.parameterNames.add(name);
			}
			segmentStart = index + 1;
		}
		return parameterCount;
	}

	private parseLocalStatements(
		startIndex: number,
		limit: number,
		parent: DraftRecord,
		templateDependent: boolean,
	): void {
		let statementStart = startIndex;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = startIndex; index <= limit; index++) {
			const value = tokenAt(this.tokens, index)?.text;
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			if (value === "{" || value === "}") statementStart = index + 1;
			const boundary = index === limit || (value === ";" && parentheses === 0 && brackets === 0 && braces === 0);
			if (!boundary) continue;
			this.parseVariableRange(statementStart, index + 1, {
				parent,
				kind: "function",
				defaultVisibility: "local",
				templateDependent,
			});
			statementStart = index + 1;
		}
	}

	private parseVariableStatement(prefix: Prefix, endIndex: number, scope: Scope, access: Visibility): void {
		this.parseVariableRange(
			prefix.startIndex,
			endIndex,
			scope.kind === "class" ? { ...scope, defaultVisibility: access } : scope,
			prefix,
		);
	}

	private parseVariableRange(startIndex: number, endIndex: number, scope: Scope, prefix?: Prefix): void {
		const first = this.significantIndexes(startIndex, endIndex)[0] ?? -1;
		const firstValue = tokenAt(this.tokens, first)?.text;
		if (first < 0 || firstValue === undefined || this.isStatementKeyword(firstValue)) return;
		const indexes = this.significantIndexes(startIndex, endIndex);
		if (indexes.length === 0) return;
		const segments: Array<{ start: number; end: number }> = [];
		let segmentStart = startIndex;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = startIndex; index <= endIndex; index++) {
			const value = tokenAt(this.tokens, index)?.text;
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			if ((value === "," && parentheses === 0 && brackets === 0 && braces === 0) || index === endIndex) {
				segments.push({ start: segmentStart, end: index });
				segmentStart = index + 1;
			}
		}
		let inheritedType = "";
		for (const segment of segments) {
			const result = this.variableSegment(segment.start, segment.end, scope, prefix, inheritedType);
			if (result === null) continue;
			if (inheritedType === "") inheritedType = result.typeText;
		}
	}

	private variableSegment(
		startIndex: number,
		endIndex: number,
		scope: Scope,
		prefix: Prefix | undefined,
		inheritedType: string,
	): { typeText: string } | null {
		const meaningful = this.significantIndexes(startIndex, endIndex);
		if (meaningful.length === 0) return null;
		const contentStart =
			prefix !== undefined && startIndex === prefix.startIndex ? prefix.keywordIndex : startIndex;
		const equals = this.findNextText(contentStart, "=", endIndex);
		const initializerStart = equals >= 0 ? equals + 1 : endIndex;
		const firstParen = this.findTopLevelAny(contentStart, ["(", "["], endIndex);
		const nameEnd = equals >= 0 ? equals : firstParen >= 0 ? firstParen : endIndex;
		const nameIndex = this.lastName(contentStart, nameEnd);
		if (nameIndex < 0) return null;
		const typeStart = contentStart;
		const beforeName = this.significantIndexes(typeStart, nameIndex);
		let typeText = formatType(this.tokens, beforeName);
		if (typeText === "") typeText = inheritedType;
		if (!this.isVariableType(typeText, beforeName)) return null;
		for (const typeIndex of beforeName) {
			if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
		}
		const declarationStart = prefix?.startIndex ?? startIndex;
		const declarationEnd = Math.max(nameIndex + 1, endIndex);
		const modifiers = prefix?.modifiers ?? new Set<string>();
		const isConstant =
			modifiers.has("const") ||
			modifiers.has("constexpr") ||
			modifiers.has("constinit") ||
			beforeName.some(
				(index) =>
					tokenAt(this.tokens, index)?.text === "const" || tokenAt(this.tokens, index)?.text === "constexpr",
			);
		const kind: Declaration["kind"] = scope.kind === "class" ? "field" : isConstant ? "constant" : "variable";
		const visibility =
			scope.kind === "function" ? "local" : this.visibilityFor(scope, modifiers, scope.defaultVisibility);
		const name = tokenAt(this.tokens, nameIndex)?.value ?? "value";
		const type = scope.templateDependent
			? unknownTemplateType("template-dependent variable type is not resolved")
			: draftTypeFor(typeText, this.tokens, initializerStart, endIndex);
		this.addDraft({
			parent: scope.parent,
			own: { kind: "term", name },
			kind,
			name,
			visibility,
			languageKind: isConstant ? "constant" : undefined,
			exported: prefix?.exported ?? false,
			startIndex: declarationStart,
			endIndex: declarationEnd,
			nameStartIndex: nameIndex,
			nameEndIndex: nameIndex + 1,
			signature: joinTokens(this.tokens, declarationStart, declarationEnd),
			metrics: bodyMetrics(this.tokens, declarationStart, declarationEnd),
			type,
			templateDependent: scope.templateDependent,
			parameterNames: new Set(),
		});
		this.excludedTokenIndexes.add(nameIndex);
		return { typeText };
	}

	private isVariableType(typeText: string, typeIndexes: number[]): boolean {
		const values = typeIndexes
			.map((index) => tokenAt(this.tokens, index)?.text)
			.filter((value) => value !== undefined);
		if (values.some((value) => value === "." || value === "->" || value === "->*")) return false;
		if (values.length === 0) return false;
		const first = values[0];
		if (first === undefined || tokenAt(this.tokens, typeIndexes[0] as number)?.kind !== "identifier") return false;
		if (
			TYPE_WORDS.has(first) ||
			isShoutCase(first) ||
			["class", "enum", "struct", "typename", "union"].includes(first)
		)
			return true;
		if (
			this.drafts.some(
				(draft) =>
					(draft.kind === "class" ||
						draft.kind === "struct" ||
						draft.kind === "enum" ||
						draft.kind === "typeParameter") &&
					draft.name === first,
			)
		)
			return true;
		return values.includes("::") && values.at(-1) !== "::" && typeText !== "";
	}

	private isStatementKeyword(value: string): boolean {
		return new Set([
			"return",
			"throw",
			"if",
			"else",
			"for",
			"while",
			"switch",
			"case",
			"break",
			"continue",
			"goto",
			"using",
			"class",
			"struct",
			"enum",
			"namespace",
			"static_assert",
		]).has(value);
	}

	private addTemplateParameters(template: TemplateInfo | null, parent: DraftRecord, scope: Scope): void {
		if (template === null) return;
		for (const parameter of template.parameters) {
			const draft = this.addDraft({
				parent,
				own: { kind: "typeParameter", name: parameter.name },
				kind: "typeParameter",
				name: parameter.name,
				visibility: "local",
				languageKind: parameter.typeText || "template parameter",
				exported: false,
				startIndex: parameter.startIndex,
				endIndex: Math.max(parameter.nameEndIndex, parameter.endIndex),
				nameStartIndex: parameter.nameStartIndex,
				nameEndIndex: parameter.nameEndIndex,
				signature: joinTokens(
					this.tokens,
					parameter.startIndex,
					Math.max(parameter.nameEndIndex, parameter.endIndex),
				),
				metrics: bodyMetrics(
					this.tokens,
					parameter.startIndex,
					Math.max(parameter.nameEndIndex, parameter.endIndex),
				),
				templateDependent: true,
				parameterNames: new Set(),
			});
			this.excludedTokenIndexes.add(parameter.nameStartIndex);
			parent.parameterNames.add(parameter.name);
			draft.parameterNames.add(parameter.name);
		}
		void scope;
	}

	private addDraft(input: DraftInput): DraftRecord {
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
		for (let index = draft.nameStartIndex; index < draft.nameEndIndex; index++)
			this.excludedTokenIndexes.add(index);
		return draft;
	}

	private visibilityFor(scope: Scope, modifiers: Set<string>, fallback?: Visibility): Visibility {
		if (scope.kind === "function") return "local";
		if (scope.kind === "class") return fallback ?? scope.defaultVisibility;
		return modifiers.has("static") ? "fileLocal" : (fallback ?? scope.defaultVisibility);
	}

	private findNextText(startIndex: number, value: string, limit: number): number {
		for (let index = Math.max(0, startIndex); index < limit; index++)
			if (tokenAt(this.tokens, index)?.text === value) return index;
		return -1;
	}

	private findPreviousText(startIndex: number, value: string, limit: number): number {
		for (let index = startIndex - 1; index >= limit; index--)
			if (tokenAt(this.tokens, index)?.text === value) return index;
		return -1;
	}

	private findTopLevelAny(startIndex: number, values: string[], limit: number): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = startIndex; index < limit; index++) {
			const value = tokenAt(this.tokens, index)?.text;
			if (value === "(" && parentheses === 0 && brackets === 0 && braces === 0 && values.includes(value))
				return index;
			if (value === "[" && parentheses === 0 && brackets === 0 && braces === 0 && values.includes(value))
				return index;
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
		}
		return -1;
	}

	private optionalSemicolon(closeIndex: number, limit: number): number {
		if (closeIndex < 0) return limit;
		const next = significantAfter(this.tokens, closeIndex, limit);
		return tokenAt(this.tokens, next)?.text === ";" ? next + 1 : closeIndex + 1;
	}

	private significantIndexes(startIndex: number, endIndex: number): number[] {
		const indexes: number[] = [];
		for (let index = Math.max(0, startIndex); index < endIndex; index++) {
			const token = tokenAt(this.tokens, index);
			if (token !== undefined && isSignificant(token) && !this.declarationSpecifierTokenIndexes.has(index))
				indexes.push(index);
		}
		return indexes;
	}

	private firstName(startIndex: number, endIndex: number): number {
		for (const index of this.significantIndexes(startIndex, endIndex))
			if (isNameToken(tokenAt(this.tokens, index))) return index;
		return -1;
	}

	private lastName(startIndex: number, endIndex: number): number {
		const indexes = this.significantIndexes(startIndex, endIndex);
		for (let index = indexes.length - 1; index >= 0; index--) {
			const tokenIndex = indexes[index] as number;
			if (isNameToken(tokenAt(this.tokens, tokenIndex))) return tokenIndex;
		}
		return -1;
	}

	private markRoleAfter(startIndex: number, endIndex: number, role: Reference["role"]): void {
		for (let index = startIndex + 1; index < endIndex; index++) {
			const token = tokenAt(this.tokens, index);
			if (token?.kind === "identifier" && !KEYWORDS.has(token.value)) this.roleByToken.set(index, role);
		}
	}

	private markClassBases(startIndex: number, bodyIndex: number): void {
		const colon = this.findNextText(startIndex, ":", bodyIndex);
		if (colon < 0) return;
		let startsBase = true;
		for (let index = colon + 1; index < bodyIndex; index++) {
			const token = tokenAt(this.tokens, index);
			if (token?.text === ",") {
				startsBase = true;
				continue;
			}
			if (token?.kind !== "identifier" || KEYWORDS.has(token.value)) continue;
			if (startsBase) {
				this.roleByToken.set(index, "extends");
				startsBase = false;
			} else if (!this.roleByToken.has(index)) {
				this.roleByToken.set(index, "typeUse");
			}
		}
	}

	private findQualifiedParent(qualifier: string[]): DraftRecord | null {
		if (qualifier.length === 0) return null;
		const candidates = this.drafts
			.filter((draft) => draft.kind === "class" || draft.kind === "struct" || draft.kind === "namespace")
			.filter((draft) => {
				const names = namePath(draft).map((descriptor) => descriptor.name);
				return (
					names.length >= qualifier.length &&
					qualifier.every((name, index) => names[names.length - qualifier.length + index] === name)
				);
			});
		return candidates.sort((left, right) => namePath(right).length - namePath(left).length)[0] ?? null;
	}

	private addTemplateReturnInference(record: DraftRecord, bodyIndex: number, bodyClose: number): void {
		if (record.type?.status !== "unknown" && record.type !== undefined) return;
		const types: string[] = [];
		for (let index = bodyIndex; index < bodyClose; index++) {
			if (tokenAt(this.tokens, index)?.text !== "return") continue;
			const end = statementEnd(this.tokens, index, bodyClose);
			const inferred = inferExpressionType(this.tokens, index + 1, end);
			if (inferred === null) {
				record.type = unknownTemplateType("a return expression has no inferred type");
				return;
			}
			types.push(inferred);
		}
		const first = types[0];
		if (first === undefined) {
			record.type = {
				status: "unknown",
				reason: "NotImplemented",
				detail: "no return expression determines auto",
			};
			return;
		}
		if (types.some((type) => type !== first)) {
			record.type = {
				status: "unknown",
				reason: "Ambiguous",
				detail: "return expressions infer different C++ types",
			};
			return;
		}
		record.type = { status: "inferred", display: first, basis: "return expressions" };
	}

	private hasAutoReturn(prefix: Prefix, nameInfo: { nameStartIndex: number }): boolean {
		return this.significantIndexes(prefix.keywordIndex, nameInfo.nameStartIndex).some(
			(index) => tokenAt(this.tokens, index)?.text === "auto",
		);
	}
}

export function parseCppFile(module: string, text: string): CppFacts {
	const source = tokenize(text, module);
	const parser = new StructuralParser(module, source.tokens, source.diagnostics);
	parser.parse();
	return parser.finish();
}
