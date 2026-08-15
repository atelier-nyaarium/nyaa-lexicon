import {
	type Binding,
	composeSymbolId,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type ImportedName,
	type Literal,
	type Position,
	type Range,
	type Reference,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";

export const LANGUAGE = "kotlin";

export const REFERENCE_ROLES = ["call", "read", "write", "import", "extends", "instantiate", "typeUse"] as const;

type ReferenceRole = (typeof REFERENCE_ROLES)[number];

interface Mark {
	offset: number;
	line: number;
	character: number;
}

export class SourceCursor {
	private offsetValue = 0;
	private lineValue = 0;
	private characterValue = 0;

	constructor(private readonly source: string) {}

	get offset(): number {
		return this.offsetValue;
	}

	get line(): number {
		return this.lineValue;
	}

	get character(): number {
		return this.characterValue;
	}

	good(): boolean {
		return this.offsetValue < this.source.length;
	}

	peek(ahead = 0): string {
		let offset = this.offsetValue;
		for (let index = 0; index < ahead; index++) {
			const codePoint = this.source.codePointAt(offset);
			if (codePoint === undefined) return "";
			offset += String.fromCodePoint(codePoint).length;
		}
		const codePoint = this.source.codePointAt(offset);
		return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
	}

	startsWith(value: string): boolean {
		const mark = this.mark();
		for (const character of value) {
			if (this.peek() !== character) {
				this.rewind(mark);
				return false;
			}
			this.next();
		}
		this.rewind(mark);
		return true;
	}

	next(): string {
		const character = this.peek();
		if (character === "") return "";
		this.offsetValue += character.length;
		if (character === "\n") {
			this.lineValue++;
			this.characterValue = 0;
		} else {
			this.characterValue += character.length;
		}
		return character;
	}

	mark(): Mark {
		return { offset: this.offsetValue, line: this.lineValue, character: this.characterValue };
	}

	rewind(mark: Mark): void {
		this.offsetValue = mark.offset;
		this.lineValue = mark.line;
		this.characterValue = mark.character;
	}

	readUntil(delimiter: string): string {
		let value = "";
		let guard = -1;
		while (this.good() && !this.startsWith(delimiter)) {
			if (this.offset <= guard) throw new Error("readUntil failed to advance");
			guard = this.offset;
			value += this.next();
		}
		return value;
	}
}

export interface KotlinToken {
	kind: "identifier" | "keyword" | "string" | "number" | "symbol" | "newline" | "doc";
	value: string;
	raw: string;
	start: Position;
	end: Position;
	startOffset: number;
	endOffset: number;
	closed?: boolean;
}

interface LexResult {
	tokens: KotlinToken[];
	diagnostics: Diagnostic[];
}

const KEYWORDS = new Set([
	"as",
	"break",
	"class",
	"continue",
	"do",
	"else",
	"false",
	"for",
	"fun",
	"if",
	"in",
	"interface",
	"is",
	"null",
	"object",
	"package",
	"return",
	"super",
	"this",
	"throw",
	"true",
	"try",
	"typealias",
	"typeof",
	"val",
	"var",
	"when",
	"while",
	"by",
	"catch",
	"constructor",
	"delegate",
	"dynamic",
	"field",
	"file",
	"finally",
	"get",
	"import",
	"init",
	"param",
	"property",
	"receiver",
	"set",
	"setparam",
	"where",
	"actual",
	"abstract",
	"annotation",
	"companion",
	"const",
	"crossinline",
	"data",
	"enum",
	"expect",
	"external",
	"final",
	"infix",
	"inline",
	"inner",
	"internal",
	"lateinit",
	"noinline",
	"open",
	"operator",
	"out",
	"override",
	"private",
	"protected",
	"public",
	"reified",
	"sealed",
	"suspend",
	"tailrec",
	"vararg",
	"value",
]);

const MODIFIERS = new Set([
	"actual",
	"abstract",
	"annotation",
	"companion",
	"const",
	"crossinline",
	"data",
	"enum",
	"expect",
	"external",
	"final",
	"infix",
	"inline",
	"inner",
	"internal",
	"lateinit",
	"noinline",
	"open",
	"operator",
	"override",
	"private",
	"protected",
	"public",
	"reified",
	"sealed",
	"suspend",
	"tailrec",
	"vararg",
	"value",
]);

const BUILTIN_TYPES = new Set([
	"Any",
	"Boolean",
	"Byte",
	"Char",
	"Double",
	"Float",
	"Int",
	"Long",
	"Nothing",
	"Short",
	"String",
	"Unit",
	"Array",
	"List",
	"Set",
	"Map",
	"Collection",
	"Iterable",
	"Sequence",
	"Throwable",
	"Exception",
	"Comparable",
	"Number",
]);

const SOFT_IDENTIFIER_KEYWORDS = new Set([
	"by",
	"catch",
	"constructor",
	"delegate",
	"dynamic",
	"field",
	"file",
	"finally",
	"get",
	"param",
	"property",
	"receiver",
	"set",
	"setparam",
	"value",
	"where",
]);

const MULTI_SYMBOLS = [
	"===",
	"!==",
	">>>=",
	"::",
	"?.",
	"?:",
	"!!",
	"->",
	"==",
	"!=",
	"<=",
	">=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&&",
	"||",
	"++",
	"--",
	"..<",
	"..",
	"<<",
	">>>",
	">>",
];

function isIdentifierStart(character: string): boolean {
	return character === "_" || /^\p{L}$/u.test(character);
}

function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || /^[\p{M}\p{N}]$/u.test(character);
}

function isDigit(character: string): boolean {
	return /^[0-9]$/u.test(character);
}

function positionOf(cursor: SourceCursor): Position {
	return { line: cursor.line, character: cursor.character };
}

function rangeFromToken(token: KotlinToken): Range {
	return { start: token.start, end: token.end };
}

function diagnostic(module: string, message: string, range?: Range): Diagnostic {
	return { severity: "error", message, ...(range === undefined ? {} : { range }), path: module };
}

function decodeEscape(character: string): string {
	const simple: Record<string, string> = {
		"0": "\0",
		b: "\b",
		n: "\n",
		r: "\r",
		t: "\t",
		"\\": "\\",
		'"': '"',
		"'": "'",
	};
	return simple[character] ?? character;
}

function decodeString(body: string): string {
	let value = "";
	let index = 0;
	let guard = -1;
	while (index < body.length) {
		if (index <= guard) throw new Error("decodeString failed to advance");
		guard = index;
		const character = body[index] as string;
		if (character !== "\\" || index + 1 >= body.length) {
			value += character;
			index++;
			continue;
		}
		const escaped = body[index + 1] as string;
		if (escaped === "u" && index + 5 < body.length) {
			const hex = body.slice(index + 2, index + 6);
			const codePoint = Number.parseInt(hex, 16);
			if (Number.isFinite(codePoint)) {
				value += String.fromCodePoint(codePoint);
				index += 6;
				continue;
			}
		}
		value += decodeEscape(escaped);
		index += 2;
	}
	return value;
}

function docComment(body: string): string {
	const lines = body.split(/\r?\n/u).map((line) => {
		const trimmed = line.trimStart();
		if (!trimmed.startsWith("*")) return trimmed;
		return trimmed.slice(1).replace(/^ /u, "");
	});
	while (lines[0] === "") lines.shift();
	while (lines.at(-1) === "") lines.pop();
	return lines.join("\n").trim();
}

function readNestedBlockComment(cursor: SourceCursor): { body: string; closed: boolean } {
	let body = "";
	let depth = 1;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("readNestedBlockComment failed to advance");
		guard = cursor.offset;
		if (cursor.startsWith("/*")) {
			body += cursor.next();
			body += cursor.next();
			depth++;
			continue;
		}
		if (cursor.startsWith("*/")) {
			if (depth === 1) return { body, closed: true };
			body += cursor.next();
			body += cursor.next();
			depth--;
			continue;
		}
		body += cursor.next();
	}
	return { body, closed: false };
}

function quoteRun(cursor: SourceCursor): number {
	let count = 0;
	let guard = -1;
	while (cursor.peek(count) === '"') {
		if (count <= guard) throw new Error("quoteRun failed to advance");
		guard = count;
		count++;
	}
	return count;
}

function readTemplateExpression(cursor: SourceCursor): { raw: string; closed: boolean } {
	let raw = "";
	let depth = 1;
	let guard = -1;
	raw += cursor.next();
	raw += cursor.next();
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("readTemplateExpression failed to advance");
		guard = cursor.offset;
		if (cursor.startsWith("//")) {
			raw += cursor.next();
			raw += cursor.next();
			raw += cursor.readUntil("\n");
			continue;
		}
		if (cursor.startsWith("/*")) {
			raw += cursor.next();
			raw += cursor.next();
			const block = readNestedBlockComment(cursor);
			raw += block.body;
			if (!block.closed) return { raw, closed: false };
			raw += cursor.next();
			raw += cursor.next();
			continue;
		}
		const character = cursor.peek();
		if (character === '"' || character === "'") {
			const string = lexString(cursor, character);
			raw += string.raw;
			if (!string.closed) return { raw, closed: false };
			continue;
		}
		if (character === "{") {
			depth++;
			raw += cursor.next();
			continue;
		}
		if (character === "}") {
			depth--;
			raw += cursor.next();
			if (depth === 0) return { raw, closed: true };
			continue;
		}
		raw += cursor.next();
	}
	return { raw, closed: false };
}

function lexString(cursor: SourceCursor, quote: string): { raw: string; value: string; closed: boolean } {
	let raw = "";
	let body = "";
	const triple = quote === '"' && cursor.startsWith('"""');
	if (triple) {
		for (let index = 0; index < 3; index++) raw += cursor.next();
		let closed = false;
		let guard = -1;
		while (cursor.good()) {
			if (cursor.offset <= guard) throw new Error("lexRawString failed to advance");
			guard = cursor.offset;
			if (cursor.startsWith("${")) {
				const template = readTemplateExpression(cursor);
				raw += template.raw;
				body += template.raw;
				if (!template.closed) break;
				continue;
			}
			const quotes = quoteRun(cursor);
			if (quotes >= 3) {
				for (let index = 0; index < quotes - 3; index++) {
					const character = cursor.next();
					raw += character;
					body += character;
				}
				for (let index = 0; index < 3; index++) raw += cursor.next();
				closed = true;
				break;
			}
			const character = cursor.next();
			raw += character;
			body += character;
		}
		return { raw, value: body, closed };
	}
	for (let index = 0; index < quote.length; index++) raw += cursor.next();
	let closed = false;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("lexString failed to advance");
		guard = cursor.offset;
		if (cursor.startsWith(quote)) {
			raw += cursor.next();
			closed = true;
			break;
		}
		const character = cursor.next();
		raw += character;
		if (!triple && character === "\\" && cursor.good()) {
			const escaped = cursor.next();
			raw += escaped;
			body += `\\${escaped}`;
			continue;
		}
		body += character;
	}
	return { raw, value: triple ? body : decodeString(body), closed };
}

function lexNumber(cursor: SourceCursor): string {
	let raw = "";
	const consumeDigits = (predicate: (character: string) => boolean): void => {
		let guard = -1;
		while (predicate(cursor.peek())) {
			if (cursor.offset <= guard) throw new Error("lexNumber failed to advance");
			guard = cursor.offset;
			raw += cursor.next();
		}
	};
	if (cursor.peek() === "0" && (cursor.peek(1) === "x" || cursor.peek(1) === "X")) {
		raw += cursor.next();
		raw += cursor.next();
		consumeDigits((character) => /^[0-9A-Fa-f_]$/u.test(character));
	} else if (cursor.peek() === "0" && (cursor.peek(1) === "b" || cursor.peek(1) === "B")) {
		raw += cursor.next();
		raw += cursor.next();
		consumeDigits((character) => /^[01_]$/u.test(character));
	} else {
		consumeDigits((character) => isDigit(character) || character === "_");
		if (cursor.peek() === "." && cursor.peek(1) !== ".") {
			raw += cursor.next();
			consumeDigits((character) => isDigit(character) || character === "_");
		}
		if (cursor.peek() === "e" || cursor.peek() === "E") {
			raw += cursor.next();
			if (cursor.peek() === "+" || cursor.peek() === "-") raw += cursor.next();
			consumeDigits((character) => isDigit(character) || character === "_");
		}
	}
	if (cursor.peek() === "L" || cursor.peek() === "l" || cursor.peek() === "f" || cursor.peek() === "F") {
		raw += cursor.next();
	}
	return raw;
}

function lex(source: string, module: string): LexResult {
	const cursor = new SourceCursor(source);
	const tokens: KotlinToken[] = [];
	const diagnostics: Diagnostic[] = [];
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("lex failed to advance");
		guard = cursor.offset;
		const start = cursor.mark();
		const character = cursor.peek();
		if (character === " " || character === "\t" || character === "\r") {
			cursor.next();
			continue;
		}
		if (character === "\n") {
			const raw = cursor.next();
			tokens.push({
				kind: "newline",
				value: raw,
				raw,
				start: { line: start.line, character: start.character },
				end: positionOf(cursor),
				startOffset: start.offset,
				endOffset: cursor.offset,
			});
			continue;
		}
		if (character === "/" && cursor.peek(1) === "/") {
			cursor.next();
			cursor.next();
			cursor.readUntil("\n");
			continue;
		}
		if (character === "/" && cursor.peek(1) === "*") {
			cursor.next();
			cursor.next();
			const doc = cursor.peek() === "*" && cursor.peek(1) !== "/";
			if (doc) cursor.next();
			const block = readNestedBlockComment(cursor);
			const body = block.body;
			let raw = `${doc ? "/**" : "/*"}${body}`;
			if (block.closed) {
				raw += cursor.next();
				raw += cursor.next();
			} else {
				diagnostics.push(
					diagnostic(module, "Block comment has no closing delimiter.", {
						start: { line: start.line, character: start.character },
						end: positionOf(cursor),
					}),
				);
			}
			if (doc) {
				tokens.push({
					kind: "doc",
					value: docComment(body),
					raw,
					start: { line: start.line, character: start.character },
					end: positionOf(cursor),
					startOffset: start.offset,
					endOffset: cursor.offset,
					closed: block.closed,
				});
			}
			continue;
		}
		if (character === '"' || character === "'") {
			const string = lexString(cursor, character);
			tokens.push({
				kind: "string",
				value: string.value,
				raw: string.raw,
				start: { line: start.line, character: start.character },
				end: positionOf(cursor),
				startOffset: start.offset,
				endOffset: cursor.offset,
				closed: string.closed,
			});
			if (!string.closed) {
				diagnostics.push(
					diagnostic(
						module,
						"String literal has no closing quote.",
						rangeFromToken(tokens.at(-1) as KotlinToken),
					),
				);
			}
			continue;
		}
		if (character === "`") {
			cursor.next();
			const value = cursor.readUntil("`");
			let raw = `\`${value}`;
			if (cursor.peek() === "`") raw += cursor.next();
			else
				diagnostics.push(
					diagnostic(module, "Backticked identifier has no closing delimiter.", {
						start: { line: start.line, character: start.character },
						end: positionOf(cursor),
					}),
				);
			tokens.push({
				kind: "identifier",
				value,
				raw,
				start: { line: start.line, character: start.character },
				end: positionOf(cursor),
				startOffset: start.offset,
				endOffset: cursor.offset,
			});
			continue;
		}
		if (isIdentifierStart(character)) {
			let value = cursor.next();
			let guardIdentifier = -1;
			while (isIdentifierPart(cursor.peek())) {
				if (cursor.offset <= guardIdentifier) throw new Error("identifier lexing failed to advance");
				guardIdentifier = cursor.offset;
				value += cursor.next();
			}
			tokens.push({
				kind: KEYWORDS.has(value) ? "keyword" : "identifier",
				value,
				raw: value,
				start: { line: start.line, character: start.character },
				end: positionOf(cursor),
				startOffset: start.offset,
				endOffset: cursor.offset,
			});
			continue;
		}
		if (isDigit(character)) {
			const raw = lexNumber(cursor);
			tokens.push({
				kind: "number",
				value: raw,
				raw,
				start: { line: start.line, character: start.character },
				end: positionOf(cursor),
				startOffset: start.offset,
				endOffset: cursor.offset,
			});
			continue;
		}
		const symbol = MULTI_SYMBOLS.find((candidate) => cursor.startsWith(candidate));
		const raw = symbol ?? cursor.next();
		if (symbol !== undefined) {
			for (let index = 0; index < symbol.length; index++) cursor.next();
		}
		tokens.push({
			kind: "symbol",
			value: raw,
			raw,
			start: { line: start.line, character: start.character },
			end: positionOf(cursor),
			startOffset: start.offset,
			endOffset: cursor.offset,
		});
	}
	return { tokens, diagnostics };
}

interface ScopeContext {
	descriptors: Descriptor[];
	containerId?: string;
	kind: "module" | "class" | "function";
	classId?: string;
	functionId?: string;
	parentId?: string;
}

interface ScopeSpan {
	startIndex: number;
	endIndex: number;
	scopeId: string;
	parentId?: string;
	kind: "class" | "function";
}

interface TypeFact {
	symbolId: string;
	answer: TypeInfo;
	annotationRange?: Range;
	startIndex?: number;
	endIndex?: number;
}

interface DeclarationMeta {
	declaration: Declaration;
	descriptors: Descriptor[];
	nameTokenIndex: number;
	startIndex: number;
	endIndex: number;
	bodyStartIndex?: number;
	bodyEndIndex?: number;
	scopeId?: string;
	parentClassId?: string;
	functionLike: boolean;
	typeLike: boolean;
	parameterCount?: number;
}

interface ReferenceInfo {
	reference: Reference;
	tokenIndex: number;
	scopeId?: string;
	importInfo?: ImportInfo;
}

interface ImportInfo {
	specifier: string;
	imported: ImportedName[];
	reExport: boolean;
	startIndex: number;
	endIndex: number;
	star: boolean;
	importedName?: string;
	localName?: string;
}

export interface KotlinFile {
	module: string;
	packageName?: string;
	tokens: KotlinToken[];
	declarations: Declaration[];
	declarationMeta: DeclarationMeta[];
	references: ReferenceInfo[];
	imports: ImportInfo[];
	literals: Literal[];
	typeFacts: TypeFact[];
	scopeSpans: ScopeSpan[];
	scopeParents: Map<string, string | undefined>;
	diagnostics: Diagnostic[];
}

function isIdentifierToken(token: KotlinToken | undefined): boolean {
	return token?.kind === "identifier" || (token?.kind === "keyword" && SOFT_IDENTIFIER_KEYWORDS.has(token.value));
}

function isNameToken(token: KotlinToken | undefined): boolean {
	return token?.kind === "identifier" || token?.kind === "keyword";
}

function symbolValue(token: KotlinToken | undefined): string | undefined {
	return token?.kind === "symbol" ? token.value : undefined;
}

function isSeparator(token: KotlinToken | undefined): boolean {
	return token?.kind === "newline" || symbolValue(token) === ";";
}

function nextToken(tokens: KotlinToken[], index: number, end: number): number {
	let next = index + 1;
	while (next < end && isSeparator(tokens[next])) next++;
	return next < end ? next : -1;
}

function previousToken(tokens: KotlinToken[], index: number): number {
	let previous = index - 1;
	while (previous >= 0 && isSeparator(tokens[previous])) previous--;
	return previous;
}

function rangeOfTokens(tokens: KotlinToken[], start: number, end: number): Range | undefined {
	const first = tokens[start];
	const last = tokens[end];
	if (first === undefined || last === undefined) return undefined;
	return { start: first.start, end: last.end };
}

function rangeOfToken(tokens: KotlinToken[], index: number): Range | undefined {
	const token = tokens[index];
	return token === undefined ? undefined : rangeFromToken(token);
}

function renderTokens(tokens: KotlinToken[], start: number, end: number): string {
	const parts: string[] = [];
	let previous = "";
	for (let index = start; index <= end; index++) {
		const token = tokens[index];
		if (token === undefined || token.kind === "doc") continue;
		if (token.kind === "newline") {
			parts.push("\n");
			previous = "";
			continue;
		}
		const value = token.raw;
		const noSpaceBefore = new Set(["(", ",", ")", "]", "}", ".", "?.", "::", ":", "?", "!", "!!", ";"]);
		const noSpaceAfter = new Set(["(", "[", "{", ".", "?.", "::", "@"]);
		const tightBefore =
			noSpaceBefore.has(value) ||
			[">", ">>", ">>>"].includes(value) ||
			(value === "<" && !["fun", "val", "var"].includes(previous));
		const tightAfter = noSpaceAfter.has(previous) || previous === "<";
		if (parts.length > 0 && previous !== "" && !tightBefore && !tightAfter && previous !== "@") {
			parts.push(" ");
		}
		parts.push(value);
		previous = value;
	}
	return parts.join("").trim();
}

function matchingToken(tokens: KotlinToken[], start: number, open: string, close: string, end: number): number {
	let depth = 0;
	let guard = start - 1;
	for (let index = start; index < end; index++) {
		if (index <= guard) throw new Error("matchingToken failed to advance");
		guard = index;
		const value = symbolValue(tokens[index]);
		if (value === open) depth++;
		if (value === close) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function angleDelta(value: string): number {
	if (value === "<") return 1;
	if (value === ">") return -1;
	if (value === ">>") return -2;
	if (value === ">>>") return -3;
	return 0;
}

function matchingAngle(tokens: KotlinToken[], start: number, end: number): number {
	let angles = 0;
	let guard = start - 1;
	for (let index = start; index < end; index++) {
		if (index <= guard) throw new Error("matchingAngle failed to advance");
		guard = index;
		angles += angleDelta(symbolValue(tokens[index]) ?? "");
		if (angles <= 0) return index;
	}
	return -1;
}

function findTopLevel(tokens: KotlinToken[], start: number, end: number, wanted: string): number {
	let parentheses = 0;
	let brackets = 0;
	let angles = 0;
	let guard = start - 1;
	for (let index = start; index < end; index++) {
		if (index <= guard) throw new Error("findTopLevel failed to advance");
		guard = index;
		const value = symbolValue(tokens[index]);
		if (value === wanted && parentheses === 0 && brackets === 0 && angles === 0) return index;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses = Math.max(0, parentheses - 1);
		else if (value === "[") brackets++;
		else if (value === "]") brackets = Math.max(0, brackets - 1);
		const delta = angleDelta(value ?? "");
		if (delta !== 0) angles = Math.max(0, angles + delta);
	}
	return -1;
}

function functionParameterOpen(tokens: KotlinToken[], start: number, end: number): number {
	const candidate = findTopLevel(tokens, start, end, "(");
	if (candidate < 0) return -1;
	const close = matchingToken(tokens, candidate, "(", ")", end);
	if (close < 0) return candidate;
	const after = nextToken(tokens, close, end);
	if (after >= 0 && symbolValue(tokens[after]) === ".") {
		const parameter = findTopLevel(tokens, after + 1, end, "(");
		if (parameter >= 0) return parameter;
	}
	return candidate;
}

function anonymousFunctionEnd(tokens: KotlinToken[], keywordIndex: number, open: number, end: number): number {
	const close = matchingToken(tokens, open, "(", ")", end);
	if (close < 0) return -1;
	const bodyOpen = findBodyOpen(tokens, close + 1, end);
	if (bodyOpen >= 0) {
		const bodyClose = matchingToken(tokens, bodyOpen, "{", "}", end);
		return bodyClose < 0 ? end : bodyClose + 1;
	}
	const equals = findTopLevel(tokens, close + 1, end, "=");
	return equals < 0 ? -1 : statementEnd(tokens, keywordIndex, end) + 1;
}

function propertyNameToken(tokens: KotlinToken[], keywordIndex: number, end: number): number {
	let index = nextToken(tokens, keywordIndex, end);
	if (index < 0) return -1;
	if (symbolValue(tokens[index]) === "<") {
		const close = matchingAngle(tokens, index, end);
		if (close < 0) return -1;
		index = nextToken(tokens, close, end);
		if (index < 0) return -1;
	}
	const boundaries = [":", "=", "by"]
		.map((wanted) => findTopLevel(tokens, index, end, wanted))
		.filter((candidate) => candidate >= 0);
	const boundary = boundaries.length === 0 ? end : Math.min(...boundaries);
	let angles = 0;
	let dot = -1;
	let guard = index - 1;
	for (let current = index; current < boundary; current++) {
		if (current <= guard) throw new Error("propertyNameToken failed to advance");
		guard = current;
		const token = tokens[current];
		if (token === undefined) continue;
		const delta = angleDelta(symbolValue(token) ?? "");
		if (delta !== 0) {
			angles = Math.max(0, angles + delta);
			continue;
		}
		if (symbolValue(token) === "." && angles === 0) dot = current;
	}
	return dot >= 0 ? nextToken(tokens, dot, boundary) : index;
}

function isNamedObject(tokens: KotlinToken[], keywordIndex: number, end: number, modifiers: string[]): boolean {
	if (modifiers.includes("companion")) return true;
	const nameIndex = nextToken(tokens, keywordIndex, end);
	return nameIndex >= 0 && isNameToken(tokens[nameIndex]);
}

function findBodyOpen(tokens: KotlinToken[], start: number, end: number): number {
	let parentheses = 0;
	let brackets = 0;
	let angles = 0;
	let guard = start - 1;
	for (let index = start; index < end; index++) {
		if (index <= guard) throw new Error("findBodyOpen failed to advance");
		guard = index;
		const token = tokens[index];
		if (token === undefined) continue;
		if (
			parentheses === 0 &&
			brackets === 0 &&
			angles === 0 &&
			(token.kind === "newline" || symbolValue(token) === ";")
		)
			return -1;
		const value = symbolValue(token);
		if (value === "{" && parentheses === 0 && brackets === 0 && angles === 0) return index;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses = Math.max(0, parentheses - 1);
		else if (value === "[") brackets++;
		else if (value === "]") brackets = Math.max(0, brackets - 1);
		const delta = angleDelta(value ?? "");
		if (delta !== 0) angles = Math.max(0, angles + delta);
	}
	return -1;
}

function statementEnd(tokens: KotlinToken[], start: number, end: number): number {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	let last = start;
	let guard = start - 1;
	for (let index = start; index < end; index++) {
		if (index <= guard) throw new Error("statementEnd failed to advance");
		guard = index;
		const token = tokens[index];
		if (token === undefined) continue;
		if (token.kind === "newline" && parentheses === 0 && brackets === 0 && braces === 0)
			return Math.max(start, last);
		const value = symbolValue(token);
		if (value === ";" && parentheses === 0 && brackets === 0 && braces === 0) return Math.max(start, last);
		if (value === "(") parentheses++;
		else if (value === ")") parentheses = Math.max(0, parentheses - 1);
		else if (value === "[") brackets++;
		else if (value === "]") brackets = Math.max(0, brackets - 1);
		else if (value === "{") braces++;
		else if (value === "}") {
			if (braces === 0 && parentheses === 0 && brackets === 0) return Math.max(start, last);
			braces = Math.max(0, braces - 1);
		}
		if (token.kind !== "newline") last = index;
	}
	return Math.max(start, last);
}

function lastNameToken(tokens: KotlinToken[], start: number, end: number): number {
	let found = -1;
	let guard = start - 1;
	for (let index = start; index < end; index++) {
		if (index <= guard) throw new Error("lastNameToken failed to advance");
		guard = index;
		if (isNameToken(tokens[index])) found = index;
	}
	return found;
}

function firstNameToken(tokens: KotlinToken[], start: number, end: number): number {
	for (let index = start; index < end; index++) {
		const value = tokens[index]?.value;
		if (
			value === "val" ||
			value === "var" ||
			value === "vararg" ||
			value === "noinline" ||
			value === "crossinline" ||
			value === "private" ||
			value === "protected" ||
			value === "internal" ||
			value === "public"
		)
			continue;
		if (isNameToken(tokens[index])) return index;
	}
	return -1;
}

function functionNameToken(tokens: KotlinToken[], start: number, end: number): number {
	let angles = 0;
	let found = -1;
	for (let index = start; index < end; index++) {
		const value = symbolValue(tokens[index]);
		const delta = angleDelta(value ?? "");
		if (delta !== 0) {
			angles = Math.max(0, angles + delta);
			continue;
		}
		if (angles === 0 && isNameToken(tokens[index])) found = index;
	}
	return found;
}

function typeName(tokens: KotlinToken[], start: number, end: number): string | undefined {
	if (end < start) return undefined;
	const rendered = renderTokens(tokens, start, end);
	return rendered === "" ? undefined : rendered;
}

function modifiersBetween(tokens: KotlinToken[], start: number, end: number): string[] {
	const modifiers: string[] = [];
	for (let index = start; index < end; index++) {
		const value = tokens[index]?.value;
		if (value !== undefined && MODIFIERS.has(value)) modifiers.push(value);
	}
	return modifiers;
}

function literalType(token: KotlinToken | undefined): { display: string; value: string; number?: number } | null {
	if (token === undefined) return null;
	if (token.kind === "string") {
		return { display: token.raw.startsWith("'") ? "Char" : "String", value: token.value };
	}
	if (token.kind === "keyword" && (token.value === "true" || token.value === "false")) {
		return { display: "Boolean", value: token.value };
	}
	if (token.kind === "keyword" && token.value === "null") return { display: "Nothing?", value: "null" };
	if (token.kind !== "number") return null;
	const normalized = token.value.replaceAll("_", "");
	const suffix = normalized.at(-1)?.toLowerCase();
	const hexadecimalOrBinary = /^0[xb]/iu.test(normalized);
	const hasSuffix = suffix === "l" || (suffix === "f" && !hexadecimalOrBinary);
	const withoutSuffix = hasSuffix ? normalized.slice(0, -1) : normalized;
	const number = Number(withoutSuffix);
	if (!Number.isFinite(number)) return null;
	return {
		display:
			suffix === "l" && hasSuffix
				? "Long"
				: suffix === "f" && hasSuffix
					? "Float"
					: /[.eE]/u.test(withoutSuffix)
						? "Double"
						: "Int",
		value: token.value,
		number,
	};
}

class KotlinParser {
	private readonly tokens: KotlinToken[];
	private readonly diagnostics: Diagnostic[];
	private readonly declarations: DeclarationMeta[] = [];
	private readonly imports: ImportInfo[] = [];
	private readonly typeFacts: TypeFact[] = [];
	private readonly scopeSpans: ScopeSpan[] = [];
	private readonly scopeParents = new Map<string, string | undefined>();
	private readonly declarationIndexes = new Set<number>();
	private readonly ignoredIndexes = new Set<number>();
	private readonly typeIndexes = new Set<number>();
	private readonly heritageIndexes = new Set<number>();
	private readonly nameCounts = new Map<string, number>();
	private readonly packageIndexes = new Set<number>();
	private readonly importIndexes = new Set<number>();
	private packageName: string | undefined;

	constructor(
		private readonly module: string,
		text: string,
		private readonly outline = false,
	) {
		const lexed = lex(text, module);
		this.tokens = lexed.tokens;
		this.diagnostics = [...lexed.diagnostics];
	}

	parse(): KotlinFile {
		this.parsePackage();
		this.parseImports();
		this.parseRegion(0, this.tokens.length, {
			descriptors: [],
			kind: "module",
		});
		this.addMetrics();
		this.addDelimiterDiagnostics();
		const literals = this.outline ? [] : this.extractLiterals();
		const references = this.outline ? [] : this.extractReferences();
		const declarations = this.declarations.map((meta) => meta.declaration);
		return {
			module: this.module,
			...(this.packageName === undefined ? {} : { packageName: this.packageName }),
			tokens: this.tokens,
			declarations,
			declarationMeta: this.declarations,
			references,
			imports: this.imports,
			literals,
			typeFacts: this.typeFacts,
			scopeSpans: this.scopeSpans,
			scopeParents: this.scopeParents,
			diagnostics: this.diagnostics,
		};
	}

	private parsePackage(): void {
		const packageIndex = this.tokens.findIndex((token) => token.kind === "keyword" && token.value === "package");
		if (packageIndex < 0) return;
		const end = statementEnd(this.tokens, packageIndex, this.tokens.length);
		const parts: string[] = [];
		for (let index = packageIndex + 1; index <= end; index++) {
			const token = this.tokens[index];
			if (token === undefined || token.kind === "newline") continue;
			if (token.value === "." || isNameToken(token)) {
				parts.push(token.value);
				this.packageIndexes.add(index);
			}
		}
		if (parts.length === 0) {
			this.diagnostics.push(
				diagnostic(this.module, "Package declaration needs a name.", rangeOfToken(this.tokens, packageIndex)),
			);
			return;
		}
		this.packageName = parts.join("");
		this.packageIndexes.add(packageIndex);
		const last = Math.max(packageIndex, end);
		const range = rangeOfTokens(this.tokens, packageIndex, last);
		const nameIndex = parts.length === 0 ? packageIndex : lastNameToken(this.tokens, packageIndex + 1, last + 1);
		if (range === undefined || nameIndex < 0) return;
		const descriptor: Descriptor = { kind: "namespace", name: this.packageName };
		const symbolId = composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: [descriptor] });
		this.declarations.push({
			declaration: {
				symbolId,
				kind: "package",
				languageKind: "package",
				name: this.packageName,
				range,
				selectionRange: rangeOfToken(this.tokens, nameIndex) ?? range,
				visibility: "public",
				exported: true,
				metrics: { lines: range.end.line - range.start.line + 1 },
			},
			descriptors: [descriptor],
			nameTokenIndex: nameIndex,
			startIndex: packageIndex,
			endIndex: last,
			functionLike: false,
			typeLike: true,
		});
		this.declarationIndexes.add(nameIndex);
	}

	private parseImports(): void {
		let index = 0;
		let guard = -1;
		while (index < this.tokens.length) {
			if (index <= guard) throw new Error("parseImports failed to advance");
			guard = index;
			const token = this.tokens[index];
			if (token?.kind !== "keyword" || token.value !== "import") {
				index++;
				continue;
			}
			const end = statementEnd(this.tokens, index, this.tokens.length);
			const pathTokens: number[] = [];
			let aliasIndex = -1;
			let starIndex = -1;
			for (let current = index + 1; current <= end; current++) {
				const candidate = this.tokens[current];
				if (candidate === undefined || candidate.kind === "newline") continue;
				this.importIndexes.add(current);
				if (candidate.value === "as") {
					aliasIndex = current;
					continue;
				}
				if (aliasIndex >= 0) continue;
				if (candidate.value === "*") {
					starIndex = current;
					pathTokens.push(current);
					continue;
				}
				if (candidate.value === "." || isNameToken(candidate)) pathTokens.push(current);
			}
			this.importIndexes.add(index);
			if (pathTokens.length === 0) {
				this.diagnostics.push(
					diagnostic(this.module, "Import declaration needs a specifier.", rangeOfToken(this.tokens, index)),
				);
				index = end + 1;
				continue;
			}
			const specifier = pathTokens.map((pathIndex) => this.tokens[pathIndex]?.value ?? "").join("");
			const sourceIndex =
				starIndex >= 0
					? starIndex
					: lastNameToken(this.tokens, index + 1, aliasIndex >= 0 ? aliasIndex : end + 1);
			const alias = aliasIndex < 0 ? -1 : nextToken(this.tokens, aliasIndex, end + 1);
			const imported: ImportedName[] = [];
			if (sourceIndex >= 0) {
				const source = this.tokens[sourceIndex];
				if (source !== undefined) {
					if (starIndex >= 0) {
						imported.push({ name: "*", range: rangeFromToken(source) });
					} else {
						const localIndex = alias >= 0 ? alias : sourceIndex;
						const local = this.tokens[localIndex];
						if (local !== undefined) {
							imported.push({
								name: source.value,
								range: rangeFromToken(source),
								local: local.value,
								localRange: rangeFromToken(local),
							});
						}
					}
				}
			}
			const importedName = sourceIndex >= 0 && starIndex < 0 ? this.tokens[sourceIndex]?.value : undefined;
			const localName =
				starIndex >= 0
					? undefined
					: alias >= 0
						? this.tokens[alias]?.value
						: sourceIndex >= 0
							? this.tokens[sourceIndex]?.value
							: undefined;
			this.imports.push({
				specifier,
				imported,
				reExport: false,
				startIndex: index,
				endIndex: end,
				star: starIndex >= 0,
				...(importedName === undefined ? {} : { importedName }),
				...(localName === undefined ? {} : { localName }),
			});
			index = end + 1;
		}
	}

	private skipAnnotation(start: number, end: number): number {
		let index = start;
		this.ignoredIndexes.add(index);
		index++;
		const name = this.tokens[index];
		if (name !== undefined && isNameToken(name)) {
			this.ignoredIndexes.add(index);
			index++;
		}
		if (symbolValue(this.tokens[index]) === ":") {
			this.ignoredIndexes.add(index);
			index++;
			if (this.tokens[index] !== undefined) {
				this.ignoredIndexes.add(index);
				index++;
			}
		}
		if (symbolValue(this.tokens[index]) === "(") {
			const close = matchingToken(this.tokens, index, "(", ")", end);
			if (close < 0) {
				this.diagnostics.push(
					diagnostic(this.module, "Annotation arguments are not closed.", rangeOfToken(this.tokens, index)),
				);
				return end;
			}
			for (let current = index; current <= close; current++) this.ignoredIndexes.add(current);
			return close + 1;
		}
		return index;
	}

	private readModifiers(start: number, end: number): { index: number; modifiers: string[] } {
		const modifiers: string[] = [];
		let index = start;
		let guard = start - 1;
		while (index < end) {
			if (index <= guard) throw new Error("readModifiers failed to advance");
			guard = index;
			if (symbolValue(this.tokens[index]) === "@") {
				index = this.skipAnnotation(index, end);
				continue;
			}
			const value = this.tokens[index]?.value;
			if (value === undefined || !MODIFIERS.has(value)) break;
			modifiers.push(value);
			index++;
		}
		return { index, modifiers };
	}

	private visibility(
		modifiers: string[],
		scope: ScopeContext,
	): { visibility: Declaration["visibility"]; exported: boolean } {
		if (scope.kind === "function") return { visibility: "local", exported: false };
		if (modifiers.includes("private")) return { visibility: "private", exported: false };
		if (modifiers.includes("protected")) return { visibility: "protected", exported: false };
		if (modifiers.includes("internal")) return { visibility: "internal", exported: true };
		return { visibility: "public", exported: true };
	}

	private descriptor(kind: Descriptor["kind"], name: string, parent: Descriptor[], method = false): Descriptor {
		const key = `${parent.map((item) => `${item.kind}:${item.name}`).join("/")}|${kind}:${name}`;
		const count = this.nameCounts.get(key) ?? 0;
		this.nameCounts.set(key, count + 1);
		if (count === 0 || !method) return { kind, name: count === 0 ? name : `${name}@${count}` };
		return { kind: "method", name, disambiguator: String(count) };
	}

	private addDeclaration(input: {
		startIndex: number;
		endIndex: number;
		nameIndex: number;
		name: string;
		kind: Declaration["kind"];
		languageKind?: string;
		modifiers: string[];
		scope: ScopeContext;
		descriptorKind: Descriptor["kind"];
		functionLike: boolean;
		typeLike: boolean;
		signature?: string;
		doc?: string;
		bodyStartIndex?: number;
		bodyEndIndex?: number;
		parameterCount?: number;
	}): DeclarationMeta | null {
		const range = rangeOfTokens(this.tokens, input.startIndex, input.endIndex);
		const selectionRange = rangeOfToken(this.tokens, input.nameIndex);
		if (range === undefined || selectionRange === undefined) return null;
		const descriptor = this.descriptor(
			input.descriptorKind,
			input.name,
			input.scope.descriptors,
			input.functionLike,
		);
		const descriptors = [...input.scope.descriptors, descriptor];
		const symbolId = composeSymbolId({ language: LANGUAGE, module: this.module, descriptors });
		const access = this.visibility(input.modifiers, input.scope);
		const declaration: Declaration = {
			symbolId,
			kind: input.kind,
			...(input.languageKind === undefined ? {} : { languageKind: input.languageKind }),
			name: input.name,
			range,
			selectionRange,
			visibility: access.visibility,
			exported: access.exported,
			...(input.signature === undefined ? {} : { signature: input.signature }),
			...(input.doc === undefined ? {} : { docComment: input.doc }),
			...(input.scope.containerId === undefined ? {} : { containerId: input.scope.containerId }),
			metrics: { lines: range.end.line - range.start.line + 1 },
		};
		const meta: DeclarationMeta = {
			declaration,
			descriptors,
			nameTokenIndex: input.nameIndex,
			startIndex: input.startIndex,
			endIndex: input.endIndex,
			...(input.bodyStartIndex === undefined ? {} : { bodyStartIndex: input.bodyStartIndex }),
			...(input.bodyEndIndex === undefined ? {} : { bodyEndIndex: input.bodyEndIndex }),
			...(input.scope.containerId === undefined ? {} : { scopeId: input.scope.containerId }),
			...(input.scope.classId === undefined ? {} : { parentClassId: input.scope.classId }),
			functionLike: input.functionLike,
			typeLike: input.typeLike,
			...(input.parameterCount === undefined ? {} : { parameterCount: input.parameterCount }),
		};
		this.declarations.push(meta);
		this.declarationIndexes.add(input.nameIndex);
		return meta;
	}

	private parseRegion(start: number, end: number, scope: ScopeContext): void {
		let index = start;
		let pendingDoc: KotlinToken | undefined;
		let guard = start - 1;
		while (index < end) {
			if (index <= guard) throw new Error("parseRegion failed to advance");
			guard = index;
			const token = this.tokens[index];
			if (token === undefined) {
				index++;
				continue;
			}
			if (token.kind === "doc") {
				pendingDoc = token;
				index++;
				continue;
			}
			if (isSeparator(token)) {
				index++;
				continue;
			}
			if (pendingDoc !== undefined && token.start.line > pendingDoc.end.line + 1) pendingDoc = undefined;
			if (this.packageIndexes.has(index) || this.importIndexes.has(index)) {
				index++;
				continue;
			}
			if (symbolValue(token) === "@") {
				index = this.skipAnnotation(index, end);
				continue;
			}
			const declarationStart = index;
			const modifiersResult = this.readModifiers(index, end);
			index = modifiersResult.index;
			const modifiers = modifiersResult.modifiers;
			const keywordToken = this.tokens[index];
			const keyword = keywordToken?.kind === "keyword" ? keywordToken.value : undefined;
			const doc = pendingDoc?.value;
			pendingDoc = undefined;
			const previous = previousToken(this.tokens, index);
			if (keyword === "class" && previous >= 0 && symbolValue(this.tokens[previous]) === "::") {
				index = declarationStart + 1;
				continue;
			}
			if (
				keyword === "class" ||
				keyword === "interface" ||
				(keyword === "object" && isNamedObject(this.tokens, index, end, modifiers))
			) {
				const next = this.parseType(declarationStart, index, end, scope, modifiers, doc);
				index = Math.max(index + 1, next);
				continue;
			}
			if (keyword === "typealias") {
				const next = this.parseTypealias(declarationStart, index, end, scope, modifiers, doc);
				index = Math.max(index + 1, next);
				continue;
			}
			if (keyword === "fun") {
				const next = this.parseFunction(declarationStart, index, end, scope, modifiers, doc);
				index = Math.max(index + 1, next);
				continue;
			}
			if (keyword === "val" || keyword === "var") {
				const next = this.parseProperty(declarationStart, index, end, scope, modifiers, doc);
				index = Math.max(index + 1, next);
				continue;
			}
			if (keyword === "constructor" && scope.kind === "class") {
				const next = this.parseConstructor(declarationStart, index, end, scope, modifiers, doc);
				index = Math.max(index + 1, next);
				continue;
			}
			if (keyword === "init") {
				const open = nextToken(this.tokens, index, end + 1);
				if (open >= 0 && symbolValue(this.tokens[open]) === "{") {
					const close = matchingToken(this.tokens, open, "{", "}", end);
					index = close < 0 ? end : close + 1;
					continue;
				}
			}
			index = declarationStart + 1;
		}
	}

	private parseType(
		start: number,
		keywordIndex: number,
		end: number,
		scope: ScopeContext,
		modifiers: string[],
		doc: string | undefined,
	): number {
		let nameIndex = nextToken(this.tokens, keywordIndex, end);
		const companion = modifiers.includes("companion");
		if (
			companion &&
			(nameIndex < 0 || symbolValue(this.tokens[nameIndex]) === "{" || isSeparator(this.tokens[nameIndex]))
		) {
			nameIndex = keywordIndex;
		}
		const nameToken = nameIndex < 0 ? undefined : this.tokens[nameIndex];
		if (nameToken === undefined || (!isNameToken(nameToken) && !companion)) {
			this.diagnostics.push(
				diagnostic(this.module, "Type declaration needs a name.", rangeOfToken(this.tokens, keywordIndex)),
			);
			return statementEnd(this.tokens, keywordIndex, end) + 1;
		}
		const name = companion && nameIndex === keywordIndex ? "Companion" : nameToken.value;
		const bodyOpen = findBodyOpen(this.tokens, Math.max(keywordIndex + 1, nameIndex + 1), end);
		const bodyClose = bodyOpen < 0 ? -1 : matchingToken(this.tokens, bodyOpen, "{", "}", end);
		if (bodyOpen >= 0 && bodyClose < 0) {
			this.diagnostics.push(
				diagnostic(this.module, "Type body has no closing brace.", rangeOfToken(this.tokens, bodyOpen)),
			);
		}
		const declarationEnd = bodyClose >= 0 ? bodyClose : statementEnd(this.tokens, keywordIndex, end);
		const declarationKind: Declaration["kind"] = modifiers.includes("enum")
			? "enum"
			: this.tokens[keywordIndex]?.value === "interface"
				? "interface"
				: "class";
		const languageParts = [
			...modifiers.filter((modifier) =>
				["data", "sealed", "abstract", "inner", "enum", "annotation", "value"].includes(modifier),
			),
			...(this.tokens[keywordIndex]?.value === "object" ? [companion ? "companionObject" : "object"] : []),
			...(this.tokens[keywordIndex]?.value === "interface" ? ["interface"] : []),
		];
		const languageKind = languageParts.length === 0 ? undefined : languageParts.join(" ");
		const headerEnd = bodyOpen >= 0 ? bodyOpen - 1 : declarationEnd;
		const meta = this.addDeclaration({
			startIndex: start,
			endIndex: declarationEnd,
			nameIndex,
			name,
			kind: declarationKind,
			...(languageKind === undefined ? {} : { languageKind }),
			modifiers,
			scope,
			descriptorKind: "type",
			functionLike: false,
			typeLike: true,
			signature: renderTokens(this.tokens, start, headerEnd),
			...(doc === undefined ? {} : { doc }),
			...(bodyOpen < 0 || bodyClose < 0 ? {} : { bodyStartIndex: bodyOpen + 1, bodyEndIndex: bodyClose - 1 }),
		});
		if (meta === null) return declarationEnd + 1;
		const classScope: ScopeContext = {
			descriptors: meta.descriptors,
			containerId: meta.declaration.symbolId,
			kind: "class",
			classId: meta.declaration.symbolId,
			...(scope.containerId === undefined ? {} : { parentId: scope.containerId }),
		};
		this.collectHeritage(keywordIndex + 1, bodyOpen >= 0 ? bodyOpen : declarationEnd + 1);
		this.scopeParents.set(meta.declaration.symbolId, scope.containerId);
		if (bodyOpen >= 0 && bodyClose >= 0) {
			this.scopeSpans.push({
				startIndex: bodyOpen + 1,
				endIndex: bodyClose - 1,
				scopeId: meta.declaration.symbolId,
				...(scope.containerId === undefined ? {} : { parentId: scope.containerId }),
				kind: "class",
			});
		}
		const primaryOpen = this.primaryConstructorOpen(keywordIndex, bodyOpen < 0 ? declarationEnd + 1 : bodyOpen);
		if (primaryOpen >= 0) {
			const primaryClose = matchingToken(this.tokens, primaryOpen, "(", ")", bodyOpen < 0 ? end : bodyOpen);
			if (primaryClose < 0) {
				this.diagnostics.push(
					diagnostic(
						this.module,
						"Primary constructor has no closing parenthesis.",
						rangeOfToken(this.tokens, primaryOpen),
					),
				);
			} else {
				const constructorIndex = this.constructorKeywordBetween(keywordIndex, primaryOpen);
				const constructorStart = constructorIndex >= 0 ? constructorIndex : nameIndex;
				const constructorMeta = this.addDeclaration({
					startIndex: constructorStart,
					endIndex: primaryClose,
					nameIndex: constructorIndex >= 0 ? constructorIndex : nameIndex,
					name,
					kind: "constructor",
					languageKind: "primaryConstructor",
					modifiers:
						constructorIndex >= 0 ? modifiersBetween(this.tokens, nameIndex + 1, constructorIndex) : [],
					scope: classScope,
					descriptorKind: "method",
					functionLike: true,
					typeLike: false,
					signature: renderTokens(this.tokens, constructorStart, primaryClose),
					parameterCount: this.parameterCount(primaryOpen + 1, primaryClose),
				});
				if (constructorMeta !== null)
					this.parseParameters(primaryOpen + 1, primaryClose, classScope, constructorMeta, true);
			}
		}
		if (declarationKind === "enum" && bodyOpen >= 0 && bodyClose >= 0)
			this.parseEnumEntries(bodyOpen + 1, bodyClose, classScope);
		if (bodyOpen >= 0 && bodyClose >= 0) this.parseRegion(bodyOpen + 1, bodyClose, classScope);
		return declarationEnd + 1;
	}

	private collectHeritage(start: number, end: number): void {
		if (this.outline) return;
		const colon = findTopLevel(this.tokens, start, end, ":");
		if (colon < 0) return;
		let guard = colon;
		for (let index = colon + 1; index < end; index++) {
			if (index <= guard) throw new Error("collectHeritage failed to advance");
			guard = index;
			const token = this.tokens[index];
			if (symbolValue(token) === "{") break;
			if (token !== undefined && isIdentifierToken(token) && !BUILTIN_TYPES.has(token.value))
				this.heritageIndexes.add(index);
		}
	}

	private primaryConstructorOpen(start: number, end: number): number {
		const colon = findTopLevel(this.tokens, start + 1, end, ":");
		const limit = colon >= 0 ? colon : end;
		return findTopLevel(this.tokens, start + 1, limit, "(");
	}

	private constructorKeywordBetween(start: number, end: number): number {
		for (let index = start; index < end; index++) if (this.tokens[index]?.value === "constructor") return index;
		return -1;
	}

	private parameterCount(start: number, end: number): number {
		let count = 0;
		let segmentStart = start;
		let parentheses = 0;
		let brackets = 0;
		let guard = start - 1;
		for (let index = start; index <= end; index++) {
			if (index <= guard) throw new Error("parameterCount failed to advance");
			guard = index;
			const value = symbolValue(this.tokens[index]);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			if ((value === "," && parentheses === 0 && brackets === 0) || index === end) {
				if (lastNameToken(this.tokens, segmentStart, index + (index === end ? 0 : 1)) >= 0) count++;
				segmentStart = index + 1;
			}
		}
		return count;
	}

	private parameterSegments(start: number, end: number): Array<{ start: number; end: number }> {
		const segments: Array<{ start: number; end: number }> = [];
		let segmentStart = start;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		let guard = start - 1;
		for (let index = start; index <= end; index++) {
			if (index <= guard) throw new Error("parameterSegments failed to advance");
			guard = index;
			const value = symbolValue(this.tokens[index]);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (value === "{") braces++;
			else if (value === "}") braces--;
			if ((value === "," && parentheses === 0 && brackets === 0 && braces === 0) || index === end) {
				const segmentEnd = index === end ? index - 1 : index - 1;
				if (segmentEnd >= segmentStart) segments.push({ start: segmentStart, end: segmentEnd });
				segmentStart = index + 1;
			}
		}
		return segments;
	}

	private findTypeEnd(start: number, end: number): number {
		let parentheses = 0;
		let brackets = 0;
		let angles = 0;
		let guard = start - 1;
		for (let index = start; index < end; index++) {
			if (index <= guard) throw new Error("findTypeEnd failed to advance");
			guard = index;
			const value = symbolValue(this.tokens[index]);
			if (value === "(" || value === "[") {
				if (value === "(") parentheses++;
				else brackets++;
				continue;
			}
			if (value === ")") {
				if (parentheses === 0 && brackets === 0 && angles === 0) return index - 1;
				parentheses--;
				continue;
			}
			if (value === "]") {
				brackets = Math.max(0, brackets - 1);
				continue;
			}
			const delta = angleDelta(value ?? "");
			if (delta !== 0) angles = Math.max(0, angles + delta);
			if (
				parentheses === 0 &&
				brackets === 0 &&
				angles === 0 &&
				(value === "=" || value === "," || value === ";" || value === "{" || value === "->")
			) {
				return index - 1;
			}
			if (this.tokens[index]?.kind === "newline" && parentheses === 0 && brackets === 0 && angles === 0)
				return index - 1;
		}
		return end - 1;
	}

	private addTypeFact(declaration: DeclarationMeta, start: number, end: number, display: string): void {
		if (this.outline || display === "") return;
		const annotationRange = rangeOfTokens(this.tokens, start, end);
		this.typeFacts.push({
			symbolId: declaration.declaration.symbolId,
			answer: { status: "known", display, provenance: "declared" },
			...(annotationRange === undefined ? {} : { annotationRange }),
			startIndex: start,
			endIndex: end,
		});
		for (let index = start; index <= end; index++) this.typeIndexes.add(index);
	}

	private addInferredLiteral(declaration: DeclarationMeta, index: number): void {
		if (this.outline) return;
		const literal = literalType(this.tokens[index]);
		if (literal === null) return;
		this.typeFacts.push({
			symbolId: declaration.declaration.symbolId,
			answer: { status: "inferred", display: literal.display, basis: "literal initializer" },
		});
	}

	private parseParameters(
		start: number,
		end: number,
		scope: ScopeContext,
		owner: DeclarationMeta,
		constructorProperties: boolean,
	): void {
		for (const segment of this.parameterSegments(start, end)) {
			const nameIndex = firstNameToken(this.tokens, segment.start, segment.end + 1);
			if (nameIndex < 0 || !isNameToken(this.tokens[nameIndex])) continue;
			const name = this.tokens[nameIndex]?.value;
			if (name === undefined) continue;
			const colon = this.outline ? -1 : findTopLevel(this.tokens, nameIndex + 1, segment.end + 1, ":");
			const equals = this.outline ? -1 : findTopLevel(this.tokens, nameIndex + 1, segment.end + 1, "=");
			const typeEnd = colon < 0 ? -1 : this.findTypeEnd(colon + 1, equals >= 0 ? equals : segment.end + 1);
			const display = typeEnd >= colon + 1 ? typeName(this.tokens, colon + 1, typeEnd) : undefined;
			const parameterModifiers = [
				...modifiersBetween(this.tokens, segment.start, nameIndex),
				...this.tokens
					.slice(segment.start, nameIndex)
					.map((token) => token.value)
					.filter((value) => value === "val" || value === "var"),
			];
			const propertyParameter =
				constructorProperties && (parameterModifiers.includes("val") || parameterModifiers.includes("var"));
			if (propertyParameter) {
				const propertyMeta = this.addDeclaration({
					startIndex: segment.start,
					endIndex: segment.end,
					nameIndex,
					name,
					kind: "property",
					languageKind: parameterModifiers.includes("var") ? "constructorVar" : "constructorVal",
					modifiers: parameterModifiers,
					scope,
					descriptorKind: "term",
					functionLike: false,
					typeLike: false,
					signature: renderTokens(this.tokens, segment.start, segment.end),
				});
				if (propertyMeta !== null && display !== undefined && typeEnd >= colon + 1)
					this.addTypeFact(propertyMeta, colon + 1, typeEnd, display);
				if (propertyMeta !== null && display === undefined && equals >= 0 && equals + 1 === segment.end)
					this.addInferredLiteral(propertyMeta, equals + 1);
				continue;
			}
			const parameterScope: ScopeContext = {
				descriptors: owner.descriptors,
				containerId: owner.declaration.symbolId,
				kind: "function",
				functionId: owner.declaration.symbolId,
				...(scope.classId === undefined ? {} : { classId: scope.classId }),
				...(scope.containerId === undefined ? {} : { parentId: scope.containerId }),
			};
			const parameterMeta = this.addDeclaration({
				startIndex: segment.start,
				endIndex: segment.end,
				nameIndex,
				name,
				kind: "variable",
				languageKind: "parameter",
				modifiers: [],
				scope: parameterScope,
				descriptorKind: "parameter",
				functionLike: false,
				typeLike: false,
				signature: renderTokens(this.tokens, segment.start, segment.end),
			});
			if (parameterMeta !== null && display !== undefined && typeEnd >= colon + 1)
				this.addTypeFact(parameterMeta, colon + 1, typeEnd, display);
		}
	}

	private parseFunction(
		start: number,
		keywordIndex: number,
		end: number,
		scope: ScopeContext,
		modifiers: string[],
		doc: string | undefined,
	): number {
		const open = functionParameterOpen(this.tokens, keywordIndex + 1, end);
		if (open < 0) {
			this.diagnostics.push(
				diagnostic(
					this.module,
					"Function declaration needs a parameter list.",
					rangeOfToken(this.tokens, keywordIndex),
				),
			);
			return statementEnd(this.tokens, keywordIndex, end) + 1;
		}
		const nameIndex = functionNameToken(this.tokens, keywordIndex + 1, open);
		if (nameIndex < 0) {
			const anonymousEnd = anonymousFunctionEnd(this.tokens, keywordIndex, open, end);
			if (anonymousEnd >= 0) return anonymousEnd;
			this.diagnostics.push(
				diagnostic(this.module, "Function declaration needs a name.", rangeOfToken(this.tokens, keywordIndex)),
			);
			return open + 1;
		}
		const close = matchingToken(this.tokens, open, "(", ")", end);
		if (close < 0) {
			this.diagnostics.push(
				diagnostic(
					this.module,
					"Function parameter list has no closing parenthesis.",
					rangeOfToken(this.tokens, open),
				),
			);
			return end;
		}
		const equals = findTopLevel(this.tokens, close + 1, end, "=");
		const bodyOpen = findBodyOpen(this.tokens, close + 1, end);
		const blockBody = bodyOpen >= 0 && (equals < 0 || bodyOpen < equals);
		const bodyClose = blockBody ? matchingToken(this.tokens, bodyOpen, "{", "}", end) : -1;
		if (blockBody && bodyClose < 0)
			this.diagnostics.push(
				diagnostic(this.module, "Function body has no closing brace.", rangeOfToken(this.tokens, bodyOpen)),
			);
		const declarationEnd = blockBody
			? bodyClose >= 0
				? bodyClose
				: end - 1
			: statementEnd(this.tokens, keywordIndex, end);
		const colon = this.outline
			? -1
			: findTopLevel(this.tokens, close + 1, equals >= 0 ? equals : bodyOpen >= 0 ? bodyOpen : end, ":");
		const typeEnd =
			colon < 0 ? -1 : this.findTypeEnd(colon + 1, equals >= 0 ? equals : bodyOpen >= 0 ? bodyOpen : end);
		const returnType = typeEnd >= colon + 1 ? typeName(this.tokens, colon + 1, typeEnd) : undefined;
		const receiver = this.tokens.slice(keywordIndex + 1, nameIndex).some((token) => symbolValue(token) === ".");
		if (receiver && !this.outline) {
			for (let index = keywordIndex + 1; index < nameIndex; index++) {
				if (isIdentifierToken(this.tokens[index])) this.typeIndexes.add(index);
			}
		}
		const languageParts = [
			...(modifiers.includes("suspend") ? ["suspend"] : []),
			...(receiver ? ["extensionFunction"] : []),
		];
		const languageKind = languageParts.length === 0 ? undefined : languageParts.join(" ");
		const headerEnd = blockBody ? bodyOpen - 1 : equals >= 0 ? equals - 1 : declarationEnd;
		const meta = this.addDeclaration({
			startIndex: start,
			endIndex: declarationEnd,
			nameIndex,
			name: this.tokens[nameIndex]?.value ?? "function",
			kind: scope.kind === "class" ? "method" : "function",
			...(languageKind === undefined ? {} : { languageKind }),
			modifiers,
			scope,
			descriptorKind: "method",
			functionLike: true,
			typeLike: false,
			signature: renderTokens(this.tokens, start, headerEnd),
			...(doc === undefined ? {} : { doc }),
			...(blockBody && bodyClose >= 0 ? { bodyStartIndex: bodyOpen + 1, bodyEndIndex: bodyClose - 1 } : {}),
			parameterCount: this.parameterCount(open + 1, close),
		});
		if (meta === null) return declarationEnd + 1;
		if (returnType !== undefined && typeEnd >= colon + 1) this.addTypeFact(meta, colon + 1, typeEnd, returnType);
		this.parseParameters(open + 1, close, scope, meta, false);
		if (blockBody && bodyClose >= 0) {
			const functionScope: ScopeContext = {
				descriptors: meta.descriptors,
				containerId: meta.declaration.symbolId,
				kind: "function",
				functionId: meta.declaration.symbolId,
				...(scope.classId === undefined ? {} : { classId: scope.classId }),
				...(scope.containerId === undefined ? {} : { parentId: scope.containerId }),
			};
			this.scopeParents.set(meta.declaration.symbolId, scope.containerId);
			this.scopeSpans.push({
				startIndex: bodyOpen + 1,
				endIndex: bodyClose - 1,
				scopeId: meta.declaration.symbolId,
				...(scope.containerId === undefined ? {} : { parentId: scope.containerId }),
				kind: "function",
			});
			this.parseRegion(bodyOpen + 1, bodyClose, functionScope);
		}
		return declarationEnd + 1;
	}

	private parseProperty(
		start: number,
		keywordIndex: number,
		end: number,
		scope: ScopeContext,
		modifiers: string[],
		doc: string | undefined,
	): number {
		const declarationEnd = statementEnd(this.tokens, keywordIndex, end);
		const first = nextToken(this.tokens, keywordIndex, declarationEnd + 1);
		const nameIndex = propertyNameToken(this.tokens, keywordIndex, declarationEnd + 1);
		if (nameIndex < 0 || !isNameToken(this.tokens[nameIndex])) {
			if (first >= 0 && (symbolValue(this.tokens[first]) === "(" || symbolValue(this.tokens[first]) === "[")) {
				return declarationEnd + 1;
			}
			this.diagnostics.push(
				diagnostic(this.module, "Property declaration needs a name.", rangeOfToken(this.tokens, keywordIndex)),
			);
			return declarationEnd + 1;
		}
		const equals = findTopLevel(this.tokens, nameIndex + 1, declarationEnd + 1, "=");
		const colon = this.outline
			? -1
			: findTopLevel(this.tokens, nameIndex + 1, equals >= 0 ? equals : declarationEnd + 1, ":");
		const typeEnd = colon < 0 ? -1 : this.findTypeEnd(colon + 1, equals >= 0 ? equals : declarationEnd + 1);
		const display = typeEnd >= colon + 1 ? typeName(this.tokens, colon + 1, typeEnd) : undefined;
		const initializerStart = equals < 0 ? -1 : equals + 1;
		const name = this.tokens[nameIndex]?.value ?? "property";
		if (
			!this.outline &&
			this.tokens.slice(keywordIndex + 1, nameIndex).some((token) => symbolValue(token) === ".")
		) {
			for (let index = keywordIndex + 1; index < nameIndex; index++) {
				if (isIdentifierToken(this.tokens[index])) this.typeIndexes.add(index);
			}
		}
		const kind: Declaration["kind"] =
			scope.kind === "function" ? "variable" : modifiers.includes("const") ? "constant" : "property";
		const languageKind = modifiers.includes("const") ? "constVal" : this.tokens[keywordIndex]?.value;
		const meta = this.addDeclaration({
			startIndex: start,
			endIndex: declarationEnd,
			nameIndex,
			name,
			kind,
			...(languageKind === undefined ? {} : { languageKind }),
			modifiers,
			scope,
			descriptorKind: "term",
			functionLike: false,
			typeLike: false,
			signature: renderTokens(this.tokens, start, equals >= 0 ? equals - 1 : declarationEnd),
			...(doc === undefined ? {} : { doc }),
		});
		if (meta !== null && display !== undefined && typeEnd >= colon + 1)
			this.addTypeFact(meta, colon + 1, typeEnd, display);
		if (meta !== null && display === undefined && initializerStart >= 0 && initializerStart === declarationEnd)
			this.addInferredLiteral(meta, initializerStart);
		return declarationEnd + 1;
	}

	private parseTypealias(
		start: number,
		keywordIndex: number,
		end: number,
		scope: ScopeContext,
		modifiers: string[],
		doc: string | undefined,
	): number {
		const nameIndex = nextToken(this.tokens, keywordIndex, end);
		if (nameIndex < 0 || !isNameToken(this.tokens[nameIndex])) {
			this.diagnostics.push(
				diagnostic(this.module, "Typealias declaration needs a name.", rangeOfToken(this.tokens, keywordIndex)),
			);
			return statementEnd(this.tokens, keywordIndex, end) + 1;
		}
		const declarationEnd = statementEnd(this.tokens, keywordIndex, end);
		const meta = this.addDeclaration({
			startIndex: start,
			endIndex: declarationEnd,
			nameIndex,
			name: this.tokens[nameIndex]?.value ?? "typealias",
			kind: "class",
			languageKind: "typealias",
			modifiers,
			scope,
			descriptorKind: "type",
			functionLike: false,
			typeLike: true,
			signature: renderTokens(this.tokens, start, declarationEnd),
			...(doc === undefined ? {} : { doc }),
		});
		const equals = this.outline ? -1 : findTopLevel(this.tokens, nameIndex + 1, declarationEnd + 1, "=");
		if (!this.outline && meta !== null && equals >= 0 && equals + 1 <= declarationEnd) {
			const display = typeName(this.tokens, equals + 1, declarationEnd);
			if (display !== undefined) this.addTypeFact(meta, equals + 1, declarationEnd, display);
		}
		return declarationEnd + 1;
	}

	private parseConstructor(
		start: number,
		keywordIndex: number,
		end: number,
		scope: ScopeContext,
		modifiers: string[],
		doc: string | undefined,
	): number {
		const open = findTopLevel(this.tokens, keywordIndex + 1, end, "(");
		if (open < 0) {
			this.diagnostics.push(
				diagnostic(
					this.module,
					"Constructor declaration needs a parameter list.",
					rangeOfToken(this.tokens, keywordIndex),
				),
			);
			return statementEnd(this.tokens, keywordIndex, end) + 1;
		}
		const close = matchingToken(this.tokens, open, "(", ")", end);
		if (close < 0) {
			this.diagnostics.push(
				diagnostic(
					this.module,
					"Constructor parameter list has no closing parenthesis.",
					rangeOfToken(this.tokens, open),
				),
			);
			return end;
		}
		const bodyOpen = findBodyOpen(this.tokens, close + 1, end);
		const bodyClose = bodyOpen < 0 ? -1 : matchingToken(this.tokens, bodyOpen, "{", "}", end);
		if (bodyOpen >= 0 && bodyClose < 0)
			this.diagnostics.push(
				diagnostic(this.module, "Constructor body has no closing brace.", rangeOfToken(this.tokens, bodyOpen)),
			);
		const declarationEnd =
			bodyClose >= 0 ? bodyClose : bodyOpen >= 0 ? end - 1 : statementEnd(this.tokens, keywordIndex, end);
		const classDeclaration =
			scope.classId === undefined
				? undefined
				: this.declarations.find((meta) => meta.declaration.symbolId === scope.classId);
		const name = classDeclaration?.declaration.name ?? "constructor";
		const meta = this.addDeclaration({
			startIndex: start,
			endIndex: declarationEnd,
			nameIndex: keywordIndex,
			name,
			kind: "constructor",
			languageKind: "secondaryConstructor",
			modifiers,
			scope,
			descriptorKind: "method",
			functionLike: true,
			typeLike: false,
			signature: renderTokens(this.tokens, start, bodyOpen >= 0 ? bodyOpen - 1 : declarationEnd),
			...(doc === undefined ? {} : { doc }),
			...(bodyOpen >= 0 && bodyClose >= 0 ? { bodyStartIndex: bodyOpen + 1, bodyEndIndex: bodyClose - 1 } : {}),
			parameterCount: this.parameterCount(open + 1, close),
		});
		if (meta === null) return declarationEnd + 1;
		this.parseParameters(open + 1, close, scope, meta, false);
		if (bodyOpen >= 0 && bodyClose >= 0) {
			const functionScope: ScopeContext = {
				descriptors: meta.descriptors,
				containerId: meta.declaration.symbolId,
				kind: "function",
				functionId: meta.declaration.symbolId,
				...(scope.classId === undefined ? {} : { classId: scope.classId }),
				...(scope.containerId === undefined ? {} : { parentId: scope.containerId }),
			};
			this.scopeParents.set(meta.declaration.symbolId, scope.containerId);
			this.scopeSpans.push({
				startIndex: bodyOpen + 1,
				endIndex: bodyClose - 1,
				scopeId: meta.declaration.symbolId,
				...(scope.containerId === undefined ? {} : { parentId: scope.containerId }),
				kind: "function",
			});
			this.parseRegion(bodyOpen + 1, bodyClose, functionScope);
		}
		return declarationEnd + 1;
	}

	private parseEnumEntries(start: number, end: number, scope: ScopeContext): void {
		let index = start;
		let expectName = true;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		let guard = start - 1;
		while (index < end) {
			if (index <= guard) throw new Error("parseEnumEntries failed to advance");
			guard = index;
			const token = this.tokens[index];
			if (token === undefined || token.kind === "newline") {
				index++;
				continue;
			}
			const value = symbolValue(token);
			if (value === ";" && parentheses === 0 && brackets === 0 && braces === 0) return;
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (value === "{") braces++;
			else if (value === "}") braces--;
			if (expectName && parentheses === 0 && brackets === 0 && braces === 0 && isNameToken(token)) {
				const entryStart = index;
				const entryEnd = this.enumEntryEnd(index + 1, end);
				const meta = this.addDeclaration({
					startIndex: entryStart,
					endIndex: entryEnd,
					nameIndex: index,
					name: token.value,
					kind: "constant",
					languageKind: "enumEntry",
					modifiers: [],
					scope,
					descriptorKind: "term",
					functionLike: false,
					typeLike: false,
					signature: renderTokens(this.tokens, entryStart, entryEnd),
				});
				if (meta !== null) this.declarationIndexes.add(index);
				expectName = false;
				index = entryEnd + 1;
				continue;
			}
			if (value === "," && parentheses === 0 && brackets === 0 && braces === 0) expectName = true;
			index++;
		}
	}

	private enumEntryEnd(start: number, end: number): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		let last = start - 1;
		let guard = start - 1;
		for (let index = start; index < end; index++) {
			if (index <= guard) throw new Error("enumEntryEnd failed to advance");
			guard = index;
			const value = symbolValue(this.tokens[index]);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses--;
			else if (value === "[") brackets++;
			else if (value === "]") brackets--;
			else if (value === "{") braces++;
			else if (value === "}") {
				if (braces === 0 && parentheses === 0 && brackets === 0) return Math.max(start - 1, last);
				braces--;
			}
			if ((value === "," || value === ";") && parentheses === 0 && brackets === 0 && braces === 0)
				return Math.max(start - 1, last);
			if (this.tokens[index]?.kind !== "newline") last = index;
		}
		return Math.max(start - 1, last);
	}

	private addDelimiterDiagnostics(): void {
		const stack: Array<{ value: string; index: number }> = [];
		const openings = new Set(["(", "[", "{"]);
		const closing = new Map([
			[")", "("],
			["]", "["],
			["}", "{"],
		]);
		let guard = -1;
		for (let index = 0; index < this.tokens.length; index++) {
			if (index <= guard) throw new Error("addDelimiterDiagnostics failed to advance");
			guard = index;
			const token = this.tokens[index];
			if (token === undefined || token.kind !== "symbol") continue;
			if (openings.has(token.value)) {
				stack.push({ value: token.value, index });
				continue;
			}
			const expected = closing.get(token.value);
			if (expected === undefined) continue;
			const open = stack.at(-1);
			if (open?.value === expected) {
				stack.pop();
				continue;
			}
			this.diagnostics.push(
				diagnostic(
					this.module,
					`Closing ${token.value} does not match its opening delimiter.`,
					rangeFromToken(token),
				),
			);
		}
		for (const open of stack)
			this.diagnostics.push(
				diagnostic(
					this.module,
					`Opening ${open.value} is not closed before end of file.`,
					rangeOfToken(this.tokens, open.index),
				),
			);
	}

	private addMetrics(): void {
		for (const meta of this.declarations) {
			const range = meta.declaration.range;
			const metrics: { lines: number; parameters?: number; nesting?: number; branches?: number } = {
				lines: range.end.line - range.start.line + 1,
			};
			if (meta.parameterCount !== undefined) metrics.parameters = meta.parameterCount;
			if (
				meta.bodyStartIndex !== undefined &&
				meta.bodyEndIndex !== undefined &&
				meta.bodyEndIndex >= meta.bodyStartIndex
			) {
				let branches = 1;
				let nesting = 0;
				let braceDepth = 0;
				let guard = meta.bodyStartIndex - 1;
				for (let index = meta.bodyStartIndex; index <= meta.bodyEndIndex; index++) {
					if (index <= guard) throw new Error("addMetrics failed to advance");
					guard = index;
					const token = this.tokens[index];
					if (token === undefined) continue;
					const value = symbolValue(token);
					if (value === "{") {
						braceDepth++;
						nesting = Math.max(nesting, braceDepth);
					} else if (value === "}") braceDepth = Math.max(0, braceDepth - 1);
					if (token.kind === "keyword" && ["if", "when", "for", "while", "catch"].includes(token.value))
						branches++;
				}
				metrics.nesting = nesting;
				metrics.branches = branches;
			}
			meta.declaration.metrics = metrics;
		}
	}

	private containerFor(index: number): string | undefined {
		const candidates = this.declarations
			.filter((meta) => meta.startIndex <= index && meta.endIndex >= index)
			.sort((left, right) => right.startIndex - left.startIndex || left.endIndex - right.endIndex);
		return candidates[0]?.declaration.symbolId;
	}

	private extractLiterals(): Literal[] {
		const literals: Literal[] = [];
		for (let index = 0; index < this.tokens.length; index++) {
			const token = this.tokens[index];
			if (token === undefined) continue;
			if (token.kind === "keyword" && token.value === "null") continue;
			const literal = literalType(token);
			if (literal === null) continue;
			literals.push({
				kind: token.kind === "string" ? "string" : token.kind === "number" ? "number" : "boolean",
				value: literal.value,
				...(literal.number === undefined ? {} : { number: literal.number }),
				range: rangeFromToken(token),
				...(this.containerFor(index) === undefined ? {} : { containerId: this.containerFor(index) }),
			});
		}
		return literals;
	}

	private scopeAt(index: number): ScopeSpan | undefined {
		return this.scopeSpans
			.filter((span) => span.startIndex <= index && span.endIndex >= index)
			.sort((left, right) => left.endIndex - left.startIndex - (right.endIndex - right.startIndex))[0];
	}

	private placeholderBinding(): Binding {
		return { status: "unbound", reason: "NotIndexed", detail: "binding is resolved by the provider index" };
	}

	private addReference(index: number, role: ReferenceRole, importInfo?: ImportInfo): ReferenceInfo | null {
		const token = this.tokens[index];
		if (token === undefined || token.value === "") return null;
		const scope = this.scopeAt(index);
		const reference: Reference = {
			name: token.value,
			range: rangeFromToken(token),
			role,
			binding: this.placeholderBinding(),
			...(scope === undefined ? {} : { fromId: scope.scopeId }),
		};
		return {
			reference,
			tokenIndex: index,
			...(scope === undefined ? {} : { scopeId: scope.scopeId }),
			...(importInfo === undefined ? {} : { importInfo }),
		};
	}

	private tokenForRange(range: Range): number {
		return this.tokens.findIndex(
			(token) =>
				token.start.line === range.start.line &&
				token.start.character === range.start.character &&
				token.end.line === range.end.line &&
				token.end.character === range.end.character,
		);
	}

	private extractReferences(): ReferenceInfo[] {
		const references: ReferenceInfo[] = [];
		for (const importInfo of this.imports) {
			const imported = importInfo.imported[0];
			if (imported?.name === undefined || imported.name === "*") continue;
			const sourceRange = imported.range;
			if (sourceRange === undefined) continue;
			const index = this.tokenForRange(sourceRange);
			if (index < 0) continue;
			const reference = this.addReference(index, "import", importInfo);
			if (reference !== null) references.push(reference);
		}
		let guard = -1;
		for (let index = 0; index < this.tokens.length; index++) {
			if (index <= guard) throw new Error("extractReferences failed to advance");
			guard = index;
			const token = this.tokens[index];
			if (
				token === undefined ||
				!isIdentifierToken(token) ||
				this.declarationIndexes.has(index) ||
				this.ignoredIndexes.has(index) ||
				this.importIndexes.has(index) ||
				this.packageIndexes.has(index)
			)
				continue;
			if (BUILTIN_TYPES.has(token.value)) continue;
			const previous = previousToken(this.tokens, index);
			const next = nextToken(this.tokens, index, this.tokens.length);
			const previousValue = previous < 0 ? "" : this.tokens[previous]?.value;
			const nextValue = next < 0 ? "" : this.tokens[next]?.value;
			if (previousValue === "@" || previousValue === "::") continue;
			let role: ReferenceRole;
			if (this.heritageIndexes.has(index)) role = "extends";
			else if (this.typeIndexes.has(index) || previousValue === "is" || previousValue === "as") role = "typeUse";
			else if (nextValue === "++" || nextValue === "--" || previousValue === "++" || previousValue === "--") {
				const read = this.addReference(index, "read");
				const write = this.addReference(index, "write");
				if (read !== null) references.push(read);
				if (write !== null) references.push(write);
				continue;
			} else if (["=", "+=", "-=", "*=", "/=", "%="].includes(nextValue ?? "")) {
				if (nextValue !== "=") {
					const read = this.addReference(index, "read");
					if (read !== null) references.push(read);
				}
				const write = this.addReference(index, "write");
				if (write !== null) references.push(write);
				continue;
			} else if (nextValue === "(") {
				const isType = this.declarations.some((meta) => meta.declaration.name === token.value && meta.typeLike);
				role = isType ? "instantiate" : "call";
			} else role = "read";
			const reference = this.addReference(index, role);
			if (reference !== null) references.push(reference);
		}
		return references;
	}
}

export function parseKotlin(module: string, text: string, outline = false): KotlinFile {
	return new KotlinParser(module, text, outline).parse();
}
