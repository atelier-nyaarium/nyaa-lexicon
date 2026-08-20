import {
	comparePositions,
	composeSymbolId,
	type Declaration,
	type Diagnostic,
	type Import,
	type ImportedName,
	type Literal,
	type Range,
	type Reference,
} from "@nyaa-lexicon/protocol";
import { sourceRange } from "./cursor.js";
import type { ImportBinding, ParsedFile, RawDeclaration, RawReference, RustDescriptor, TypeAnswer } from "./model.js";
import { type RustToken, tokenize } from "./tokens.js";

const LANGUAGE = "rust";

const KEYWORDS = new Set([
	"as",
	"async",
	"await",
	"break",
	"const",
	"continue",
	"crate",
	"dyn",
	"else",
	"enum",
	"extern",
	"false",
	"fn",
	"for",
	"if",
	"impl",
	"in",
	"let",
	"loop",
	"match",
	"mod",
	"move",
	"mut",
	"pub",
	"ref",
	"return",
	"self",
	"Self",
	"static",
	"struct",
	"super",
	"trait",
	"true",
	"type",
	"unsafe",
	"use",
	"where",
	"while",
	"yield",
]);

const MODIFIERS = new Set(["async", "const", "default", "extern", "unsafe", "auto", "safe", "gen"]);

const TYPE_WORDS = new Set([
	"bool",
	"char",
	"str",
	"u8",
	"u16",
	"u32",
	"u64",
	"u128",
	"usize",
	"i8",
	"i16",
	"i32",
	"i64",
	"i128",
	"isize",
	"f32",
	"f64",
	"Self",
	"self",
	"dyn",
	"impl",
]);

const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

interface ParseContext {
	descriptors: RustDescriptor[];
	containerId?: string;
	kind: "root" | "module" | "type" | "trait" | "impl" | "function";
	implTrait?: string;
	typeName?: string;
}

interface Prefix {
	index: number;
	start: RustToken;
	visibility: Declaration["visibility"];
	exported: boolean;
	modifiers: Set<string>;
}

interface UseEntry {
	path: string[];
	sourceName: string | null;
	localName: string | null;
	sourceToken?: RustToken;
	localToken?: RustToken;
	glob: boolean;
}

interface SpanRange {
	startOffset: number;
	endOffset: number;
}

function tokenAt(tokens: RustToken[], index: number): RustToken | undefined {
	return tokens[index];
}

function isValueToken(token: RustToken | undefined, value: string): boolean {
	return token !== undefined && (token.kind === "symbol" || token.kind === "identifier") && token.value === value;
}

function angleDelta(token: RustToken): number {
	if (token.kind !== "symbol") return 0;
	if (token.value === "<") return 1;
	if (token.value === "<<" || token.value === "<<=") return 2;
	if (token.value === ">") return -1;
	if (token.value === ">>" || token.value === ">>=") return -2;
	return 0;
}

function isNameToken(token: RustToken | undefined): token is RustToken {
	return token !== undefined && (token.kind === "identifier" || token.value === "self" || token.value === "Self");
}

function rangeOfTokens(tokens: RustToken[], start: number, end: number): Range | undefined {
	const first = tokenAt(tokens, start);
	const last = tokenAt(tokens, end - 1);
	if (first === undefined || last === undefined) return undefined;
	return { start: first.start, end: last.end };
}

function sourceOfTokens(source: string, tokens: RustToken[], start: number, end: number): string {
	const first = tokenAt(tokens, start);
	const last = tokenAt(tokens, end - 1);
	if (first === undefined || last === undefined) return "";
	return sourceRange(source, first.startOffset, last.endOffset).trim();
}

function appendUnique(values: RustDescriptor[], descriptor: RustDescriptor): RustDescriptor[] {
	return [...values, descriptor];
}

function descriptorKey(descriptors: RustDescriptor[]): string {
	return descriptors.map((descriptor) => `${descriptor.kind}:${descriptor.name}`).join("/");
}

function sanitizeDisambiguator(value: string): string {
	const cleaned = [...value].filter((character) => /[A-Za-z0-9._-]/u.test(character)).join("");
	return cleaned === "" ? "impl" : cleaned;
}

const INTEGER_SUFFIX = "(?:u(?:8|16|32|64|128|size)|i(?:8|16|32|64|128|size))";
const FLOAT_SUFFIX = "(?:f32|f64)";
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SAFE_INTEGER_TEXT = String(Number.MAX_SAFE_INTEGER);

function safeIntegerValue(prefix: string, digits: string): number | undefined {
	const value = BigInt(`${prefix}${digits}`);
	return value <= MAX_SAFE_INTEGER_BIGINT ? Number(value) : undefined;
}

function decimalExceedsSafeInteger(body: string): boolean {
	const exponentIndex = body.search(/[eE]/u);
	const mantissa = exponentIndex < 0 ? body : body.slice(0, exponentIndex);
	const exponentText = exponentIndex < 0 ? undefined : body.slice(exponentIndex + 1);
	const exponent = exponentText === undefined ? 0 : Number.parseInt(exponentText, 10);
	const [integerPart = "", fractionPart = ""] = mantissa.split(".");
	const digits = `${integerPart}${fractionPart}`.replace(/^0+/u, "");
	if (digits === "") return false;
	if (!Number.isFinite(exponent)) return exponent > 0;
	const scale = fractionPart.length - exponent;
	if (scale <= 0) {
		const trailingZeroes = -scale;
		const digitCount = digits.length + trailingZeroes;
		if (digitCount !== MAX_SAFE_INTEGER_TEXT.length) return digitCount > MAX_SAFE_INTEGER_TEXT.length;
		return BigInt(`${digits}${"0".repeat(trailingZeroes)}`) > MAX_SAFE_INTEGER_BIGINT;
	}
	const thresholdLength = MAX_SAFE_INTEGER_TEXT.length + scale;
	if (digits.length !== thresholdLength) return digits.length > thresholdLength;
	return BigInt(digits) > MAX_SAFE_INTEGER_BIGINT * 10n ** BigInt(scale);
}

function numericValue(raw: string): number | undefined {
	const cleaned = raw.replaceAll("_", "");
	const hex = new RegExp(`^0[xX]([0-9a-fA-F]+)(?:${INTEGER_SUFFIX})?$`, "u").exec(cleaned);
	if (hex !== null) return safeIntegerValue("0x", hex[1] ?? "");
	const binary = new RegExp(`^0[bB]([01]+)(?:${INTEGER_SUFFIX})?$`, "u").exec(cleaned);
	if (binary !== null) return safeIntegerValue("0b", binary[1] ?? "");
	const octal = new RegExp(`^0[oO]([0-7]+)(?:${INTEGER_SUFFIX})?$`, "u").exec(cleaned);
	if (octal !== null) return safeIntegerValue("0o", octal[1] ?? "");
	const decimalInteger = new RegExp(`^(\\d+)(?:${INTEGER_SUFFIX})?$`, "u").exec(cleaned);
	if (decimalInteger !== null) return safeIntegerValue("", decimalInteger[1] ?? "");
	const decimalFloat = new RegExp(`^((?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)(?:${FLOAT_SUFFIX})?$`, "u").exec(
		cleaned,
	);
	if (decimalFloat === null) return undefined;
	const body = decimalFloat[1] ?? "";
	const value = Number(body);
	return Number.isFinite(value) && !decimalExceedsSafeInteger(body) ? value : undefined;
}

function primitiveTypeForLiteral(token: RustToken): string | undefined {
	if (token.kind === "string") return "&str";
	if (token.kind === "char") return "char";
	if (token.value === "true" || token.value === "false") return "bool";
	if (token.kind === "number") return /[.eE]/u.test(token.value) ? "f64" : "i32";
	return undefined;
}

export class RustParser {
	private readonly scan: ReturnType<typeof tokenize>;
	private readonly tokens: RustToken[];
	private readonly matching = new Map<number, number>();
	private readonly rawDeclarations: RawDeclaration[] = [];
	private readonly rawReferences: RawReference[] = [];
	private readonly importBindings: ImportBinding[] = [];
	private readonly imports: Import[] = [];
	private readonly typeAnswers = new Map<string, TypeAnswer>();
	private readonly ignoredRanges: SpanRange[] = [];
	private readonly attributeTokens = new Set<number>();
	private readonly useRanges: SpanRange[] = [];
	private readonly declarationNameTokens = new Set<number>();
	private readonly implTraitTokens = new Set<number>();
	private readonly implTypeTokens = new Set<number>();
	private readonly methodCounts = new Map<string, number>();
	private localOrdinal = 0;

	constructor(
		private readonly module: string,
		private readonly text: string,
		private readonly depth: "full" | "outline" = "full",
	) {
		this.scan = tokenize(text);
		this.tokens = this.scan.tokens;
		this.buildMatching();
	}

	parse(): ParsedFile {
		this.parseItems(0, this.tokens.length, { descriptors: [], kind: "root" });
		const declarations = this.rawDeclarations.map((raw) => raw.declaration);
		const references = this.depth === "outline" ? [] : this.extractReferences();
		const literals = this.depth === "outline" ? [] : this.extractLiterals();
		const diagnostics = this.diagnostics();
		return {
			module: this.module,
			text: this.text,
			declarations,
			references,
			imports: this.imports,
			literals,
			comments: this.depth === "outline" ? [] : this.scan.comments,
			diagnostics,
			rawDeclarations: this.rawDeclarations,
			rawReferences: this.depth === "outline" ? [] : this.rawReferences,
			importBindings: this.importBindings,
			typeAnswers: this.depth === "outline" ? new Map() : this.typeAnswers,
			lineTokens: this.scan.lineTokens,
		};
	}

	private buildMatching(): void {
		const stack: Array<{ value: string; index: number }> = [];
		const opens = new Set(["(", "[", "{"]);
		const closes = new Map([
			[")", "("],
			["]", "["],
			["}", "{"],
		]);
		let guard = -1;
		for (let index = 0; index < this.tokens.length; index++) {
			if (index <= guard) throw new Error("delimiter scan failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			if (token.kind === "symbol" && opens.has(token.value)) {
				stack.push({ value: token.value, index });
				continue;
			}
			if (token.kind !== "symbol") continue;
			const opening = closes.get(token.value);
			if (opening === undefined) continue;
			const previous = stack.pop();
			if (previous === undefined || previous.value !== opening) {
				this.addDiagnostic("unexpected closing delimiter", token);
				if (previous !== undefined) stack.push(previous);
				continue;
			}
			this.matching.set(previous.index, index);
			this.matching.set(index, previous.index);
		}
		for (const open of stack)
			this.addDiagnostic("opening delimiter is not closed before end of file", this.tokens[open.index]);
	}

	private diagnostics(): Diagnostic[] {
		const diagnostics: Diagnostic[] = this.scan.diagnostics.map((diagnostic) => ({
			severity: "error",
			message: diagnostic.message,
			path: this.module,
			range: { start: diagnostic.span.start, end: diagnostic.span.end },
		}));
		for (const diagnostic of this.pendingDiagnostics) diagnostics.push(diagnostic);
		return diagnostics.sort((left, right) => {
			const leftStart = left.range?.start ?? {
				line: Number.MAX_SAFE_INTEGER,
				character: Number.MAX_SAFE_INTEGER,
			};
			const rightStart = right.range?.start ?? {
				line: Number.MAX_SAFE_INTEGER,
				character: Number.MAX_SAFE_INTEGER,
			};
			return comparePositions(leftStart, rightStart);
		});
	}

	private readonly pendingDiagnostics: Diagnostic[] = [];

	private addDiagnostic(message: string, token: RustToken | undefined): void {
		this.pendingDiagnostics.push({
			severity: "error",
			message,
			path: this.module,
			...(token === undefined ? {} : { range: { start: token.start, end: token.end } }),
		});
	}

	private matchingIndex(index: number): number {
		return this.matching.get(index) ?? -1;
	}

	private skipAttributes(start: number, end: number): number {
		let index = start;
		while (index < end && isValueToken(this.tokens[index], "#")) {
			const open = isValueToken(this.tokens[index + 1], "!") ? index + 2 : index + 1;
			if (!isValueToken(this.tokens[open], "[")) break;
			const close = this.matchingIndex(open);
			if (close < 0 || close >= end) {
				this.addDiagnostic("attribute has no closing bracket", this.tokens[open]);
				return end;
			}
			for (let tokenIndex = index; tokenIndex <= close; tokenIndex++) this.attributeTokens.add(tokenIndex);
			index = close + 1;
		}
		return index;
	}

	private prefix(start: number, end: number): Prefix {
		let index = start;
		let visibility: Declaration["visibility"] = "private";
		let exported = false;
		const modifiers = new Set<string>();
		const startToken = tokenAt(this.tokens, start) ?? tokenAt(this.tokens, end - 1);
		while (index < end) {
			const token = tokenAt(this.tokens, index);
			if (isValueToken(token, "pub")) {
				exported = true;
				visibility = "public";
				index++;
				if (isValueToken(this.tokens[index], "(")) {
					const close = this.matchingIndex(index);
					if (close >= 0) {
						const inner = this.tokens.slice(index + 1, close).map((value) => value.value);
						if (inner.includes("crate") || inner.includes("super") || inner.includes("in")) {
							visibility = "internal";
						}
						index = close + 1;
						continue;
					}
				}
				continue;
			}
			if (token !== undefined && MODIFIERS.has(token.value)) {
				if (token.value === "const" && isValueToken(this.tokens[index + 1], "fn")) {
					modifiers.add(token.value);
					index++;
					continue;
				}
				if (token.value !== "const") {
					modifiers.add(token.value);
					index++;
					continue;
				}
			}
			break;
		}
		return {
			index,
			start:
				startToken ??
				({
					startOffset: 0,
					endOffset: 0,
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
					kind: "symbol",
					value: "",
					raw: "",
				} as RustToken),
			visibility,
			exported,
			modifiers,
		};
	}

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
			const prefix = this.prefix(index, end);
			index = prefix.index;
			const token = tokenAt(this.tokens, index);
			if (token === undefined) break;
			if (token.value === "use") {
				index = this.parseUse(index, end, prefix, context);
				continue;
			}
			if (token.value === "fn") {
				index = this.parseFunction(index, end, prefix, context);
				continue;
			}
			if (token.value === "struct") {
				index = this.parseStruct(index, end, prefix, context);
				continue;
			}
			if (token.value === "enum") {
				index = this.parseEnum(index, end, prefix, context);
				continue;
			}
			if (token.value === "trait") {
				index = this.parseTrait(index, end, prefix, context);
				continue;
			}
			if (token.value === "impl") {
				index = this.parseImpl(index, end, prefix, context);
				continue;
			}
			if (token.value === "mod") {
				index = this.parseModule(index, end, prefix, context);
				continue;
			}
			if (token.value === "type") {
				index = this.parseTypeAlias(index, end, prefix, context);
				continue;
			}
			if (token.value === "const" || token.value === "static") {
				index = this.parseConstant(index, end, prefix, context);
				continue;
			}
			if (token.value === "macro_rules") {
				index = this.parseMacroRules(index, end, prefix, context);
				continue;
			}
			if (isValueToken(token, "}")) break;
			index++;
		}
	}

	private statementEnd(start: number, end: number): number {
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("statement parser failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			if (isValueToken(token, ";")) return index;
			index++;
		}
		return Math.max(start, end - 1);
	}

	private addRawDeclaration(
		nameToken: RustToken,
		startToken: RustToken,
		endToken: RustToken,
		context: ParseContext,
		descriptor: RustDescriptor,
		kind: Declaration["kind"],
		languageKind: string,
		visibility: Declaration["visibility"],
		exported: boolean,
		options: {
			signature?: string;
			typeName?: string;
			typeDisplay?: string;
			typeRange?: Range;
			metrics?: Declaration["metrics"];
			localOrdinal?: number;
		},
	): RawDeclaration {
		const descriptorPath = appendUnique(context.descriptors, descriptor);
		const symbolId =
			options.localOrdinal === undefined
				? composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: descriptorPath })
				: composeSymbolId({
						language: LANGUAGE,
						module: this.module,
						descriptors: [],
						local: options.localOrdinal,
					});
		const declaration: Declaration = {
			symbolId,
			kind,
			languageKind,
			name: nameToken.value,
			range: { start: startToken.start, end: endToken.end },
			selectionRange: { start: nameToken.start, end: nameToken.end },
			visibility,
			exported,
			...(context.containerId === undefined ? {} : { containerId: context.containerId }),
			...(options.signature === undefined ? {} : { signature: options.signature }),
			metrics: options.metrics ?? { lines: endToken.end.line - startToken.start.line + 1 },
		};
		const raw: RawDeclaration = {
			declaration,
			startOffset: startToken.startOffset,
			endOffset: endToken.endOffset,
			nameToken,
			descriptorPath,
			containerPath: context.descriptors,
			...(options.typeName === undefined ? {} : { typeName: options.typeName }),
			...(options.typeDisplay === undefined ? {} : { typeDisplay: options.typeDisplay }),
			...(options.typeRange === undefined ? {} : { typeRange: options.typeRange }),
			...(options.localOrdinal === undefined ? {} : { localOrdinal: options.localOrdinal }),
		};
		this.rawDeclarations.push(raw);
		this.declarationNameTokens.add(this.tokens.indexOf(nameToken));
		if (this.depth !== "outline" && options.typeDisplay !== undefined) {
			this.typeAnswers.set(symbolId, {
				status: "known",
				display: options.typeDisplay,
				...(options.typeName === undefined ? {} : { typeName: options.typeName }),
			});
		}
		return raw;
	}

	private methodDescriptor(context: ParseContext, name: string): RustDescriptor {
		const key = `${descriptorKey(context.descriptors)}:${name}`;
		const count = this.methodCounts.get(key) ?? 0;
		this.methodCounts.set(key, count + 1);
		if (count === 0) return { kind: "method", name };
		const trait = context.implTrait === undefined ? "overload" : sanitizeDisambiguator(context.implTrait);
		return { kind: "method", name, disambiguator: `${trait}-${count}` };
	}

	private parseFunction(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const fnToken = this.tokens[start] as RustToken;
		let nameIndex = start + 1;
		while (nameIndex < end && !isNameToken(this.tokens[nameIndex])) nameIndex++;
		const nameToken = tokenAt(this.tokens, nameIndex);
		if (nameToken === undefined) {
			this.addDiagnostic("function has no name", fnToken);
			return this.statementEnd(start, end) + 1;
		}
		let open = nameIndex + 1;
		while (open < end && !isValueToken(this.tokens[open], "(") && !isValueToken(this.tokens[open], "{")) open++;
		if (!isValueToken(this.tokens[open], "(")) {
			this.addDiagnostic("function has no parameter list", nameToken);
			return this.statementEnd(start, end) + 1;
		}
		const close = this.matchingIndex(open);
		if (close < 0) {
			this.addDiagnostic("function parameter list is not closed", this.tokens[open]);
			return end;
		}
		let bodyOpen = close + 1;
		let braceDepth = 0;
		let bodyEnd = -1;
		let semicolon = -1;
		for (let index = close + 1; index < end; index++) {
			const token = this.tokens[index] as RustToken;
			if (isValueToken(token, "{") && braceDepth === 0) {
				bodyOpen = index;
				bodyEnd = this.matchingIndex(index);
				break;
			}
			if (isValueToken(token, ";") && braceDepth === 0) {
				semicolon = index;
				break;
			}
			if (isValueToken(token, "(") || isValueToken(token, "[")) braceDepth++;
			if (isValueToken(token, ")") || isValueToken(token, "]")) braceDepth = Math.max(0, braceDepth - 1);
			braceDepth = Math.max(0, braceDepth + angleDelta(token));
		}
		const endIndex = bodyEnd >= 0 ? bodyEnd : semicolon >= 0 ? semicolon : close;
		const endToken = tokenAt(this.tokens, endIndex);
		if (endToken === undefined) return end;
		if (bodyEnd < 0 && semicolon < 0) this.addDiagnostic("function has no body or semicolon", endToken);
		const returnInfo =
			this.depth === "outline" ? undefined : this.returnType(close + 1, bodyOpen < end ? bodyOpen : endIndex);
		const descriptor = this.methodDescriptor(context, nameToken.value);
		const signatureEnd = bodyOpen < endIndex ? bodyOpen : endIndex + 1;
		const baseSignature = sourceOfTokens(this.text, this.tokens, start, signatureEnd);
		const signature =
			context.implTrait === undefined ? baseSignature : `${baseSignature} (impl ${context.implTrait})`;
		const kind = context.kind === "impl" || context.kind === "trait" ? "method" : "function";
		const typeOptions =
			this.depth === "outline"
				? {}
				: {
						typeDisplay:
							returnInfo === undefined
								? `fn(${this.parameterTypes(open + 1, close).join(", ")})`
								: `fn(${this.parameterTypes(open + 1, close).join(", ")}) -> ${returnInfo.display}`,
						...(returnInfo?.typeName === undefined ? {} : { typeName: returnInfo.typeName }),
					};
		const raw = this.addRawDeclaration(
			nameToken,
			prefix.start,
			endToken,
			context,
			descriptor,
			kind,
			context.kind === "impl" && context.implTrait !== undefined ? "traitImplMethod" : "fn",
			prefix.visibility,
			prefix.exported,
			{
				signature,
				...typeOptions,
				...(this.depth === "outline"
					? {}
					: {
							metrics: {
								lines: endToken.end.line - prefix.start.start.line + 1,
								parameters: this.parameterCount(open + 1, close),
								...(bodyEnd < 0 ? {} : this.bodyMetrics(bodyOpen + 1, bodyEnd)),
							},
						}),
			},
		);
		if (this.depth !== "outline") this.parseParameters(open + 1, close, raw);
		if (bodyEnd >= 0 && this.depth !== "outline") {
			raw.functionId = raw.declaration.symbolId;
			this.parseLocals(bodyOpen + 1, bodyEnd, raw);
		}
		return endIndex + 1;
	}

	private returnType(start: number, end: number): { display: string; typeName?: string } | undefined {
		let arrow = -1;
		for (let index = start; index < end; index++) if (isValueToken(this.tokens[index], "->")) arrow = index;
		if (arrow < 0 || arrow + 1 >= end) return undefined;
		const typeEnd = this.topLevelStop(arrow + 1, end, new Set(["where", "{"]));
		const display = sourceOfTokens(this.text, this.tokens, arrow + 1, typeEnd);
		if (display === "") return undefined;
		const typeName = this.simpleTypeName(arrow + 1, typeEnd);
		return { display, ...(typeName === undefined ? {} : { typeName }) };
	}

	private parameterTypes(start: number, end: number): string[] {
		const values: string[] = [];
		for (const [from, to] of this.segments(start, end)) {
			const colon = this.topLevelToken(from, to, ":");
			if (colon >= 0) values.push(sourceOfTokens(this.text, this.tokens, colon + 1, to));
		}
		return values;
	}

	private parameterCount(start: number, end: number): number {
		return this.segments(start, end).filter(([from, to]) => to > from && !isValueToken(this.tokens[from], "self"))
			.length;
	}

	private parseParameters(start: number, end: number, functionRaw: RawDeclaration): void {
		const functionDescriptor = functionRaw.descriptorPath.at(-1);
		if (functionDescriptor === undefined) return;
		for (const [from, to] of this.segments(start, end)) {
			const colon = this.topLevelToken(from, to, ":");
			const nameIndex = this.parameterNameIndex(from, colon >= 0 ? colon : to);
			const nameToken = tokenAt(this.tokens, nameIndex);
			if (nameToken === undefined || nameToken.value === "_") continue;
			const last = tokenAt(this.tokens, Math.max(from, to - 1));
			if (last === undefined) continue;
			const typeEnd = colon >= 0 ? to : -1;
			const typeDisplay = typeEnd >= 0 ? sourceOfTokens(this.text, this.tokens, colon + 1, typeEnd) : undefined;
			const typeName = typeEnd >= 0 ? this.simpleTypeName(colon + 1, typeEnd) : undefined;
			const descriptor: RustDescriptor = { kind: "parameter", name: nameToken.value };
			const parameter = this.addRawDeclaration(
				nameToken,
				nameToken,
				last,
				{
					descriptors: functionRaw.descriptorPath,
					containerId: functionRaw.declaration.symbolId,
					kind: "function",
				},
				descriptor,
				"variable",
				"parameter",
				"local",
				false,
				{
					...(typeDisplay === undefined
						? {}
						: { typeDisplay, ...(typeName === undefined ? {} : { typeName }) }),
				},
			);
			parameter.functionId = functionRaw.declaration.symbolId;
		}
	}

	private parameterNameIndex(start: number, end: number): number {
		for (let index = end - 1; index >= start; index--) {
			const token = this.tokens[index] as RustToken;
			if (isNameToken(token) && !new Set(["mut", "ref", "self", "Self"]).has(token.value)) return index;
		}
		if (isValueToken(this.tokens[start], "self")) return start;
		return -1;
	}

	private parseLocals(start: number, end: number, functionRaw: RawDeclaration): void {
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("local parser failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			if (token.value === "let") {
				const boundary = this.topLevelStop(index + 1, end, new Set(["=", ":", ";"]));
				const colon = isValueToken(this.tokens[boundary], ":")
					? boundary
					: this.topLevelToken(index + 1, boundary, ":");
				const patternEnd = colon >= 0 ? colon : boundary;
				const names = this.patternNames(index + 1, patternEnd);
				const typeEnd = colon >= 0 ? this.topLevelStop(colon + 1, end, new Set(["=", ";"])) : -1;
				const typeDisplay =
					typeEnd >= 0 ? sourceOfTokens(this.text, this.tokens, colon + 1, typeEnd) : undefined;
				const typeName = typeEnd >= 0 ? this.simpleTypeName(colon + 1, typeEnd) : undefined;
				const equal = this.topLevelToken(index + 1, end, "=");
				const initializerEnd = equal >= 0 ? this.topLevelStop(equal + 1, end, new Set([";"])) : -1;
				const initializer = equal >= 0 ? this.literalInitializer(equal + 1, initializerEnd) : undefined;
				const typeOptions =
					initializer === undefined
						? typeDisplay === undefined
							? {}
							: { typeDisplay, ...(typeName === undefined ? {} : { typeName }) }
						: { typeDisplay: initializer.display };
				for (const nameIndex of names) {
					const nameToken = this.tokens[nameIndex] as RustToken;
					const ordinal = this.localOrdinal++;
					const raw = this.addRawDeclaration(
						nameToken,
						nameToken,
						tokenAt(
							this.tokens,
							Math.max(nameIndex, (initializerEnd >= 0 ? initializerEnd : patternEnd) - 1),
						) ?? nameToken,
						{
							descriptors: functionRaw.descriptorPath,
							containerId: functionRaw.declaration.symbolId,
							kind: "function",
						},
						{ kind: "term", name: nameToken.value },
						"variable",
						"let",
						"local",
						false,
						{
							localOrdinal: ordinal,
							...typeOptions,
						},
					);
					if (initializer !== undefined)
						this.typeAnswers.set(raw.declaration.symbolId, {
							status: "inferred",
							display: initializer.display,
							basis: initializer.basis,
						});
					raw.functionId = functionRaw.declaration.symbolId;
				}
				index = Math.max(index + 1, initializerEnd >= 0 ? initializerEnd : patternEnd);
				continue;
			}
			if (token.value === "for") {
				const name = tokenAt(this.tokens, index + 1);
				if (isNameToken(name) && name.value !== "_" && !this.declarationNameTokens.has(index + 1)) {
					const ordinal = this.localOrdinal++;
					const raw = this.addRawDeclaration(
						name,
						name,
						name,
						{
							descriptors: functionRaw.descriptorPath,
							containerId: functionRaw.declaration.symbolId,
							kind: "function",
						},
						{ kind: "term", name: name.value },
						"variable",
						"forBinding",
						"local",
						false,
						{ localOrdinal: ordinal },
					);
					raw.functionId = functionRaw.declaration.symbolId;
					index += 2;
					continue;
				}
			}
			index++;
		}
	}

	private patternNames(start: number, end: number): number[] {
		const names: number[] = [];
		for (let index = start; index < end; index++) {
			const token = this.tokens[index] as RustToken;
			if (!isNameToken(token) || token.value === "_" || KEYWORDS.has(token.value)) continue;
			if (isValueToken(this.tokens[index - 1], ".")) continue;
			names.push(index);
		}
		return names.length === 0 && isNameToken(this.tokens[start]) ? [start] : names;
	}

	private literalInitializer(start: number, end: number): { display: string; basis: string } | undefined {
		if (end - start !== 1) return undefined;
		const token = tokenAt(this.tokens, start);
		if (token === undefined) return undefined;
		const display = primitiveTypeForLiteral(token);
		return display === undefined ? undefined : { display, basis: "literal initializer" };
	}

	private parseStruct(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const name = tokenAt(this.tokens, start + 1);
		if (name === undefined || !isNameToken(name)) {
			this.addDiagnostic("struct has no name", this.tokens[start]);
			return this.statementEnd(start, end) + 1;
		}
		const descriptor: RustDescriptor = { kind: "type", name: name.value };
		const bodyOpen = this.nextStructural(start + 2, end, new Set(["{", "(", ";"]));
		const bodyEnd = bodyOpen >= 0 && isValueToken(this.tokens[bodyOpen], "{") ? this.matchingIndex(bodyOpen) : -1;
		const endIndex = bodyEnd >= 0 ? bodyEnd : bodyOpen >= 0 ? bodyOpen : this.statementEnd(start, end);
		const endToken = tokenAt(this.tokens, endIndex) ?? name;
		const raw = this.addRawDeclaration(
			name,
			prefix.start,
			endToken,
			context,
			descriptor,
			"struct",
			"struct",
			prefix.visibility,
			prefix.exported,
			{},
		);
		if (bodyEnd >= 0) this.parseStructFields(bodyOpen + 1, bodyEnd, raw, prefix);
		return endIndex + 1;
	}

	private parseStructFields(start: number, end: number, structRaw: RawDeclaration, prefix: Prefix): void {
		let tupleIndex = 0;
		for (const [from, to] of this.segments(start, end)) {
			const fieldPrefix = this.prefix(from, to);
			let fieldStart = fieldPrefix.index;
			while (
				fieldStart < to &&
				(isValueToken(this.tokens[fieldStart], "(") || isValueToken(this.tokens[fieldStart], ")"))
			)
				fieldStart++;
			const first = tokenAt(this.tokens, fieldStart);
			if (first === undefined) continue;
			const colon = this.topLevelToken(fieldStart, to, ":");
			const named = colon >= 0 && isNameToken(first);
			const nameToken = named ? first : first;
			const name = named ? first.value : String(tupleIndex++);
			const synthetic = named ? nameToken : { ...first, value: name };
			const typeStart = colon >= 0 ? colon + 1 : fieldStart;
			const typeDisplay =
				this.depth === "outline" ? undefined : sourceOfTokens(this.text, this.tokens, typeStart, to);
			const typeName = this.depth === "outline" ? undefined : this.simpleTypeName(typeStart, to);
			const descriptor: RustDescriptor = { kind: "term", name };
			const fieldTypeRange = this.depth === "outline" ? undefined : rangeOfTokens(this.tokens, typeStart, to);
			this.addRawDeclaration(
				synthetic,
				tokenAt(this.tokens, from) ?? first,
				tokenAt(this.tokens, to - 1) ?? first,
				{
					descriptors: structRaw.descriptorPath,
					containerId: structRaw.declaration.symbolId,
					kind: "type",
					typeName: structRaw.declaration.name,
				},
				descriptor,
				"field",
				"field",
				fieldPrefix.visibility,
				fieldPrefix.exported,
				{
					...(typeDisplay === undefined ? {} : { typeDisplay }),
					...(typeName === undefined ? {} : { typeName }),
					...(fieldTypeRange === undefined ? {} : { typeRange: fieldTypeRange }),
				},
			);
		}
	}

	private parseEnum(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const name = tokenAt(this.tokens, start + 1);
		if (name === undefined || !isNameToken(name)) {
			this.addDiagnostic("enum has no name", this.tokens[start]);
			return this.statementEnd(start, end) + 1;
		}
		const bodyOpen = this.nextStructural(start + 2, end, new Set(["{", ";"]));
		const bodyEnd = bodyOpen >= 0 && isValueToken(this.tokens[bodyOpen], "{") ? this.matchingIndex(bodyOpen) : -1;
		const endIndex = bodyEnd >= 0 ? bodyEnd : bodyOpen >= 0 ? bodyOpen : this.statementEnd(start, end);
		const raw = this.addRawDeclaration(
			name,
			prefix.start,
			tokenAt(this.tokens, endIndex) ?? name,
			context,
			{ kind: "type", name: name.value },
			"enum",
			"enum",
			prefix.visibility,
			prefix.exported,
			{},
		);
		if (bodyEnd >= 0) {
			for (const [from, to] of this.segments(bodyOpen + 1, bodyEnd)) {
				const variant = tokenAt(this.tokens, from);
				if (variant === undefined || !isNameToken(variant)) continue;
				const descriptor: RustDescriptor = { kind: "term", name: variant.value };
				this.addRawDeclaration(
					variant,
					variant,
					tokenAt(this.tokens, to - 1) ?? variant,
					{
						descriptors: raw.descriptorPath,
						containerId: raw.declaration.symbolId,
						kind: "type",
						typeName: raw.declaration.name,
					},
					descriptor,
					"constant",
					"variant",
					prefix.visibility,
					prefix.exported,
					{},
				);
			}
		}
		return endIndex + 1;
	}

	private parseTrait(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const name = tokenAt(this.tokens, start + 1);
		if (name === undefined || !isNameToken(name)) {
			this.addDiagnostic("trait has no name", this.tokens[start]);
			return this.statementEnd(start, end) + 1;
		}
		const bodyOpen = this.nextStructural(start + 2, end, new Set(["{", ";"]));
		const bodyEnd = bodyOpen >= 0 && isValueToken(this.tokens[bodyOpen], "{") ? this.matchingIndex(bodyOpen) : -1;
		const endIndex = bodyEnd >= 0 ? bodyEnd : bodyOpen >= 0 ? bodyOpen : this.statementEnd(start, end);
		const raw = this.addRawDeclaration(
			name,
			prefix.start,
			tokenAt(this.tokens, endIndex) ?? name,
			context,
			{ kind: "type", name: name.value },
			"interface",
			"trait",
			prefix.visibility,
			prefix.exported,
			{},
		);
		if (bodyEnd >= 0)
			this.parseItems(bodyOpen + 1, bodyEnd, {
				descriptors: raw.descriptorPath,
				containerId: raw.declaration.symbolId,
				kind: "trait",
				typeName: name.value,
			});
		return endIndex + 1;
	}

	private parseImpl(start: number, end: number, _prefix: Prefix, context: ParseContext): number {
		const bodyOpen = this.nextStructural(start + 1, end, new Set(["{", ";"]));
		if (bodyOpen < 0 || !isValueToken(this.tokens[bodyOpen], "{")) {
			this.addDiagnostic("impl block has no body", this.tokens[start]);
			return this.statementEnd(start, end) + 1;
		}
		const bodyEnd = this.matchingIndex(bodyOpen);
		if (bodyEnd < 0) return end;
		const forIndex = this.topLevelToken(start + 1, bodyOpen, "for");
		const targetStart = forIndex >= 0 ? forIndex + 1 : start + 1;
		const targetIndex = this.firstTypeName(targetStart, forIndex >= 0 ? bodyOpen : bodyOpen);
		const targetToken = tokenAt(this.tokens, targetIndex);
		if (targetToken === undefined) {
			this.addDiagnostic("impl block has no target type", this.tokens[start]);
			return bodyEnd + 1;
		}
		const traitName = forIndex >= 0 ? sourceOfTokens(this.text, this.tokens, start + 1, forIndex) : undefined;
		const targetName = targetToken.value;
		if (forIndex >= 0) {
			for (let index = start + 1; index < forIndex; index++) this.implTraitTokens.add(index);
		}
		this.implTypeTokens.add(targetIndex);
		const existing = this.rawDeclarations.find(
			(raw) =>
				raw.declaration.name === targetName &&
				["struct", "enum", "interface", "class"].includes(raw.declaration.kind),
		);
		const targetPath = existing?.descriptorPath ?? [...context.descriptors, { kind: "type", name: targetName }];
		const targetId =
			existing?.declaration.symbolId ??
			composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: targetPath });
		this.parseItems(bodyOpen + 1, bodyEnd, {
			descriptors: targetPath,
			containerId: targetId,
			kind: "impl",
			...(traitName === undefined ? {} : { implTrait: traitName }),
			typeName: targetName,
		});
		return bodyEnd + 1;
	}

	private parseModule(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const name = tokenAt(this.tokens, start + 1);
		if (name === undefined || !isNameToken(name)) {
			this.addDiagnostic("module has no name", this.tokens[start]);
			return this.statementEnd(start, end) + 1;
		}
		const next = this.nextStructural(start + 2, end, new Set(["{", ";"]));
		const bodyEnd = next >= 0 && isValueToken(this.tokens[next], "{") ? this.matchingIndex(next) : -1;
		const endIndex = bodyEnd >= 0 ? bodyEnd : next >= 0 ? next : this.statementEnd(start, end);
		const raw = this.addRawDeclaration(
			name,
			prefix.start,
			tokenAt(this.tokens, endIndex) ?? name,
			context,
			{ kind: "namespace", name: name.value },
			"module",
			"module",
			prefix.visibility,
			prefix.exported,
			{},
		);
		if (bodyEnd >= 0)
			this.parseItems(next + 1, bodyEnd, {
				descriptors: raw.descriptorPath,
				containerId: raw.declaration.symbolId,
				kind: "module",
			});
		return endIndex + 1;
	}

	private parseTypeAlias(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const name = tokenAt(this.tokens, start + 1);
		if (name === undefined || !isNameToken(name)) {
			this.addDiagnostic("type alias has no name", this.tokens[start]);
			return this.statementEnd(start, end) + 1;
		}
		const endIndex = this.statementEnd(start, end);
		const equal = this.topLevelToken(start + 2, endIndex, "=");
		const typeDisplay =
			this.depth === "outline" || equal < 0
				? undefined
				: sourceOfTokens(this.text, this.tokens, equal + 1, endIndex);
		const typeName = this.depth === "outline" || equal < 0 ? undefined : this.simpleTypeName(equal + 1, endIndex);
		this.addRawDeclaration(
			name,
			prefix.start,
			tokenAt(this.tokens, endIndex) ?? name,
			context,
			{ kind: "type", name: name.value },
			"class",
			"typeAlias",
			prefix.visibility,
			prefix.exported,
			{
				...(typeDisplay === undefined ? {} : { typeDisplay, ...(typeName === undefined ? {} : { typeName }) }),
			},
		);
		return endIndex + 1;
	}

	private parseConstant(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const keyword = this.tokens[start] as RustToken;
		const nameIndex = this.firstTypeName(start + 1, end);
		const name = tokenAt(this.tokens, nameIndex);
		if (name === undefined) {
			this.addDiagnostic("constant has no name", keyword);
			return this.statementEnd(start, end) + 1;
		}
		const endIndex = this.statementEnd(start, end);
		const colon = this.topLevelToken(nameIndex + 1, endIndex, ":");
		const equal = this.topLevelToken(nameIndex + 1, endIndex, "=");
		const typeEnd = equal >= 0 ? equal : endIndex;
		const typeDisplay =
			this.depth === "outline" || colon < 0
				? undefined
				: sourceOfTokens(this.text, this.tokens, colon + 1, typeEnd);
		const typeName = this.depth === "outline" || colon < 0 ? undefined : this.simpleTypeName(colon + 1, typeEnd);
		const typeRange =
			this.depth === "outline" || colon < 0 ? undefined : rangeOfTokens(this.tokens, colon + 1, typeEnd);
		const raw = this.addRawDeclaration(
			name,
			prefix.start,
			tokenAt(this.tokens, endIndex) ?? name,
			context,
			{ kind: "term", name: name.value },
			"constant",
			keyword.value === "static" ? "static" : "const",
			prefix.visibility,
			prefix.exported,
			{
				...(typeDisplay === undefined
					? {}
					: {
							typeDisplay,
							...(typeName === undefined ? {} : { typeName }),
							...(typeRange === undefined ? {} : { typeRange }),
						}),
			},
		);
		if (this.depth !== "outline" && typeDisplay === undefined && equal >= 0) {
			const inferred = this.literalInitializer(equal + 1, endIndex);
			if (inferred !== undefined)
				this.typeAnswers.set(raw.declaration.symbolId, {
					status: "inferred",
					display: inferred.display,
					basis: inferred.basis,
				});
		}
		return endIndex + 1;
	}

	private parseMacroRules(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		let nameIndex = start + 1;
		while (nameIndex < end && !isNameToken(this.tokens[nameIndex])) nameIndex++;
		const name = tokenAt(this.tokens, nameIndex);
		if (name === undefined) {
			this.addDiagnostic("macro_rules definition has no name", this.tokens[start]);
			return this.statementEnd(start, end) + 1;
		}
		const bodyOpen = this.nextStructural(nameIndex + 1, end, new Set(["{"]));
		const bodyEnd = bodyOpen >= 0 ? this.matchingIndex(bodyOpen) : -1;
		const endToken = tokenAt(this.tokens, bodyEnd >= 0 ? bodyEnd : this.statementEnd(start, end)) ?? name;
		this.addRawDeclaration(
			name,
			prefix.start,
			endToken,
			context,
			{ kind: "term", name: name.value },
			"function",
			"macroRules",
			prefix.visibility,
			prefix.exported,
			{},
		);
		const bodyToken = bodyOpen >= 0 ? tokenAt(this.tokens, bodyOpen) : undefined;
		if (bodyToken !== undefined && bodyEnd >= 0)
			this.ignoredRanges.push({ startOffset: prefix.start.startOffset, endOffset: endToken.endOffset });
		return bodyEnd >= 0
			? bodyEnd + 1
			: endToken.endOffset > name.endOffset
				? this.tokens.indexOf(endToken) + 1
				: nameIndex + 1;
	}

	private nextStructural(start: number, end: number, values: Set<string>): number {
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("structural scan failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			if (token.kind === "symbol" && values.has(token.value)) return index;
			index++;
		}
		return -1;
	}

	private topLevelToken(start: number, end: number, value: string): number {
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		let angles = 0;
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("top-level scan failed to advance");
			guard = index;
			const current = this.tokens[index] as RustToken;
			if (parentheses === 0 && brackets === 0 && braces === 0 && angles === 0 && isValueToken(current, value))
				return index;
			if (isValueToken(current, "(")) parentheses++;
			else if (isValueToken(current, ")")) parentheses = Math.max(0, parentheses - 1);
			else if (isValueToken(current, "[")) brackets++;
			else if (isValueToken(current, "]")) brackets = Math.max(0, brackets - 1);
			else if (isValueToken(current, "{")) braces++;
			else if (isValueToken(current, "}")) braces = Math.max(0, braces - 1);
			else angles = Math.max(0, angles + angleDelta(current));
			index++;
		}
		return -1;
	}

	private topLevelStop(start: number, end: number, values: Set<string>): number {
		let index = start;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		let angles = 0;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("stop scan failed to advance");
			guard = index;
			const current = this.tokens[index] as RustToken;
			if (
				parentheses === 0 &&
				brackets === 0 &&
				braces === 0 &&
				angles === 0 &&
				(current.kind === "symbol" || current.kind === "identifier") &&
				values.has(current.value)
			)
				return index;
			if (isValueToken(current, "(")) parentheses++;
			else if (isValueToken(current, ")")) parentheses = Math.max(0, parentheses - 1);
			else if (isValueToken(current, "[")) brackets++;
			else if (isValueToken(current, "]")) brackets = Math.max(0, brackets - 1);
			else if (isValueToken(current, "{")) braces++;
			else if (isValueToken(current, "}")) braces = Math.max(0, braces - 1);
			else angles = Math.max(0, angles + angleDelta(current));
			index++;
		}
		return end;
	}

	private segments(start: number, end: number): Array<[number, number]> {
		const segments: Array<[number, number]> = [];
		let segmentStart = start;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		let angles = 0;
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("segment scan failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			if (isValueToken(token, "(")) parentheses++;
			else if (isValueToken(token, ")")) parentheses = Math.max(0, parentheses - 1);
			else if (isValueToken(token, "[")) brackets++;
			else if (isValueToken(token, "]")) brackets = Math.max(0, brackets - 1);
			else if (isValueToken(token, "{")) braces++;
			else if (isValueToken(token, "}")) braces = Math.max(0, braces - 1);
			else angles = Math.max(0, angles + angleDelta(token));
			if (isValueToken(token, ",") && parentheses === 0 && brackets === 0 && braces === 0 && angles === 0) {
				segments.push([segmentStart, index]);
				segmentStart = index + 1;
			}
			index++;
		}
		if (segmentStart < end) segments.push([segmentStart, end]);
		return segments;
	}

	private firstTypeName(start: number, end: number): number {
		let index = start;
		if (isValueToken(this.tokens[index], "<")) {
			let depth = 0;
			while (index < end) {
				const token = this.tokens[index] as RustToken;
				const delta = angleDelta(token);
				if (delta > 0) depth += delta;
				if (delta < 0) {
					depth = Math.max(0, depth + delta);
					if (depth === 0) {
						index++;
						break;
					}
				}
				index++;
			}
		}
		while (index < end) {
			const token = this.tokens[index] as RustToken;
			if (isNameToken(token) && !new Set(["const", "mut", "ref", "dyn", "impl", "for", "where"]).has(token.value))
				return index;
			index++;
		}
		return -1;
	}

	private simpleTypeName(start: number, end: number): string | undefined {
		for (let index = end - 1; index >= start; index--) {
			const token = this.tokens[index] as RustToken | undefined;
			if (!isNameToken(token) || TYPE_WORDS.has(token.value) || KEYWORDS.has(token.value)) continue;
			return token.value;
		}
		return undefined;
	}

	private bodyMetrics(start: number, end: number): { nesting: number; branches: number } {
		let depth = 0;
		let nesting = 0;
		let branches = 1;
		for (let index = start; index < end; index++) {
			const token = this.tokens[index] as RustToken;
			if (isValueToken(token, "{")) {
				depth++;
				nesting = Math.max(nesting, depth);
			}
			if (isValueToken(token, "}")) depth = Math.max(0, depth - 1);
			if (
				isValueToken(token, "if") ||
				isValueToken(token, "else") ||
				isValueToken(token, "for") ||
				isValueToken(token, "while") ||
				isValueToken(token, "match") ||
				isValueToken(token, "?") ||
				isValueToken(token, "&&") ||
				isValueToken(token, "||")
			)
				branches++;
		}
		return { nesting, branches };
	}

	private parseUse(start: number, end: number, prefix: Prefix, context: ParseContext): number {
		const statement = this.statementEnd(start, end);
		const pathStart = start + 1;
		const pathEnd = statement;
		const specifier = sourceOfTokens(this.text, this.tokens, pathStart, pathEnd);
		const useToken = tokenAt(this.tokens, start);
		const statementToken = tokenAt(this.tokens, statement);
		if (useToken === undefined || statementToken === undefined) return end;
		this.useRanges.push({ startOffset: useToken.startOffset, endOffset: statementToken.endOffset });
		const entries = this.useTree(pathStart, pathEnd, []);
		const imported: ImportedName[] = [];
		for (const entry of entries) {
			if (entry.glob) {
				if (entry.sourceToken !== undefined)
					imported.push({ name: "*", range: { start: entry.sourceToken.start, end: entry.sourceToken.end } });
			} else if (entry.sourceName !== null && entry.sourceToken !== undefined) {
				const importedName: ImportedName = {
					name: entry.sourceName,
					range: { start: entry.sourceToken.start, end: entry.sourceToken.end },
					...(entry.localName === null || entry.localToken === undefined
						? {}
						: {
								local: entry.localName,
								localRange: { start: entry.localToken.start, end: entry.localToken.end },
							}),
				};
				imported.push(importedName);
			}
			const binding: ImportBinding = {
				specifier,
				path: entry.path,
				sourceName: entry.sourceName,
				localName: entry.localName,
				glob: entry.glob,
				...(entry.sourceToken === undefined
					? {}
					: { sourceRange: { start: entry.sourceToken.start, end: entry.sourceToken.end } }),
				...(entry.localToken === undefined
					? {}
					: { localRange: { start: entry.localToken.start, end: entry.localToken.end } }),
				...(context.containerId === undefined ? {} : { containerId: context.containerId }),
				ambiguous: entry.glob,
			};
			this.importBindings.push(binding);
		}
		this.imports.push({ specifier, imported, reExport: prefix.exported });
		return statement + 1;
	}

	private useTree(start: number, end: number, prefix: string[]): UseEntry[] {
		const entries: UseEntry[] = [];
		let index = start;
		let path = [...prefix];
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("use tree parser failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			if (token.value === ",") {
				path = [...prefix];
				index++;
				continue;
			}
			if (token.value === "}") break;
			if (token.value === "*") {
				entries.push({ path, sourceName: null, localName: null, sourceToken: token, glob: true });
				index++;
				continue;
			}
			if (!isNameToken(token)) {
				index++;
				continue;
			}
			const segment = token.value;
			const next = tokenAt(this.tokens, index + 1);
			if (next?.value === "::" && isValueToken(this.tokens[index + 2], "{")) {
				const nested = this.useTree(index + 3, this.matchingIndex(index + 2), [...path, segment]);
				entries.push(...nested);
				index = this.matchingIndex(index + 2) + 1;
				path = [...prefix];
				continue;
			}
			if (next?.value === "::") {
				path.push(segment);
				index += 2;
				continue;
			}
			const sourcePath = segment === "self" && path.length > 0 ? path : [...path, segment];
			const sourceName = sourcePath.at(-1) ?? segment;
			let localName = sourceName;
			let localToken = token;
			if (isValueToken(this.tokens[index + 1], "as") && isNameToken(this.tokens[index + 2])) {
				localName = (this.tokens[index + 2] as RustToken).value;
				localToken = this.tokens[index + 2] as RustToken;
				index += 2;
			}
			entries.push({ path: sourcePath, sourceName, localName, sourceToken: token, localToken, glob: false });
			index++;
		}
		return entries;
	}

	private isInRange(offset: number, range: SpanRange): boolean {
		return offset >= range.startOffset && offset <= range.endOffset;
	}

	private isIgnored(offset: number): boolean {
		return this.ignoredRanges.some((range) => this.isInRange(offset, range));
	}

	private isUse(offset: number): boolean {
		return this.useRanges.some((range) => this.isInRange(offset, range));
	}

	private containerAt(offset: number): string | undefined {
		const candidates = this.rawDeclarations.filter(
			(raw) =>
				raw.startOffset <= offset &&
				offset <= raw.endOffset &&
				raw.declaration.kind !== "variable" &&
				raw.declaration.kind !== "field" &&
				raw.declaration.kind !== "constant",
		);
		candidates.sort((left, right) => left.endOffset - left.startOffset - (right.endOffset - right.startOffset));
		return candidates[0]?.declaration.symbolId;
	}

	private literalContainerAt(offset: number): string | undefined {
		const candidates = this.rawDeclarations.filter((raw) => raw.startOffset <= offset && offset <= raw.endOffset);
		candidates.sort((left, right) => left.endOffset - left.startOffset - (right.endOffset - right.startOffset));
		return candidates[0]?.declaration.symbolId;
	}

	private typeContext(index: number, token: RustToken): boolean {
		if (this.implTraitTokens.has(index) || this.implTypeTokens.has(index) || token.value === "Self") return true;
		for (const raw of this.rawDeclarations) {
			const range = raw.typeRange;
			if (range === undefined) continue;
			if (comparePositions(range.start, token.start) <= 0 && comparePositions(range.end, token.end) >= 0)
				return true;
		}
		const previous = tokenAt(this.tokens, index - 1)?.value;
		return (
			previous === ":" ||
			previous === "->" ||
			previous === "as" ||
			previous === "impl" ||
			previous === "dyn" ||
			previous === "where"
		);
	}

	private typeDeclaration(name: string): RawDeclaration | undefined {
		return this.rawDeclarations.find(
			(raw) =>
				raw.declaration.name === name &&
				["struct", "enum", "interface", "class"].includes(raw.declaration.kind),
		);
	}

	private extractReferences(): Reference[] {
		const references: Reference[] = [];
		for (const binding of this.importBindings) {
			if (binding.sourceName === null || binding.sourceRange === undefined) continue;
			const sourceStart = binding.sourceRange.start;
			const token = this.tokens.find((candidate) => comparePositions(candidate.start, sourceStart) === 0);
			if (token === undefined) continue;
			const reference: Reference = {
				name: binding.sourceName,
				range: binding.sourceRange,
				role: "import",
				binding: {
					status: "unbound",
					reason: "NotIndexed",
					detail: "import binding awaits workspace resolution",
				},
				...(binding.containerId === undefined ? {} : { fromId: binding.containerId }),
			};
			references.push(reference);
			this.rawReferences.push({
				reference,
				token,
				...(binding.containerId === undefined ? {} : { containerId: binding.containerId }),
				importBinding: binding,
				path: binding.path,
			});
		}
		let index = 0;
		let guard = -1;
		while (index < this.tokens.length) {
			if (index <= guard) throw new Error("reference parser failed to advance");
			guard = index;
			const token = this.tokens[index] as RustToken;
			if (this.attributeTokens.has(index) || this.isIgnored(token.startOffset) || this.isUse(token.startOffset)) {
				index++;
				continue;
			}
			if (
				!isNameToken(token) ||
				KEYWORDS.has(token.value) ||
				(this.declarationNameTokens.has(index) &&
					!this.implTraitTokens.has(index) &&
					!this.implTypeTokens.has(index))
			) {
				index++;
				continue;
			}
			if (isValueToken(this.tokens[index - 1], "'")) {
				index++;
				continue;
			}
			const next = tokenAt(this.tokens, index + 1);
			if (TYPE_WORDS.has(token.value) && token.value !== "Self") {
				index++;
				continue;
			}
			if (isValueToken(next, "!")) {
				this.addReference(references, token, "call", {
					status: "unbound",
					reason: "RuntimeConstructed",
					detail: "macro expansion can construct runtime items",
				});
				index++;
				continue;
			}
			const role = this.referenceRole(index, token);
			const receiver = isValueToken(this.tokens[index - 1], "::") ? tokenAt(this.tokens, index - 2) : undefined;
			const path = receiver !== undefined && isNameToken(receiver) ? [receiver.value] : [];
			if (role === "write" && ASSIGNMENT_OPERATORS.has(next?.value ?? "")) {
				if (next?.value !== "=") this.addReference(references, token, "read", undefined, path);
				this.addReference(references, token, "write", undefined, path);
			} else {
				this.addReference(references, token, role, undefined, path);
			}
			index++;
		}
		return references;
	}

	private referenceRole(index: number, token: RustToken): Reference["role"] {
		if (this.implTraitTokens.has(index)) return "implements";
		if (this.typeContext(index, token)) return "typeUse";
		const next = tokenAt(this.tokens, index + 1)?.value;
		if (next === "{" && this.typeDeclaration(token.value) !== undefined) return "instantiate";
		if (next === "(") {
			if (this.typeDeclaration(token.value) !== undefined) return "instantiate";
			if (!["if", "while", "for", "match", "loop"].includes(token.value)) return "call";
		}
		if (ASSIGNMENT_OPERATORS.has(next ?? "")) return "write";
		return "read";
	}

	private addReference(
		references: Reference[],
		token: RustToken,
		role: Reference["role"],
		binding: Reference["binding"] = {
			status: "unbound",
			reason: "NotIndexed",
			detail: "name awaits scope resolution",
		},
		path: string[] = [],
	): void {
		const reference: Reference = {
			name: token.value,
			range: { start: token.start, end: token.end },
			role,
			binding,
			...(this.containerAt(token.startOffset) === undefined
				? {}
				: { fromId: this.containerAt(token.startOffset) }),
		};
		references.push(reference);
		const containerId = this.containerAt(token.startOffset);
		this.rawReferences.push({ reference, token, ...(containerId === undefined ? {} : { containerId }), path });
	}

	private extractLiterals(): Literal[] {
		const literals: Literal[] = [];
		for (const [index, token] of this.tokens.entries()) {
			if (this.isIgnored(token.startOffset) || this.attributeTokens.has(index)) continue;
			if (token.kind === "string") {
				const containerId = this.literalContainerAt(token.startOffset);
				literals.push({
					kind: "string",
					value: token.value,
					range: { start: token.start, end: token.end },
					...(containerId === undefined ? {} : { containerId }),
				});
				continue;
			}
			if (token.value === "true" || token.value === "false") {
				const containerId = this.literalContainerAt(token.startOffset);
				literals.push({
					kind: "boolean",
					value: token.value,
					range: { start: token.start, end: token.end },
					...(containerId === undefined ? {} : { containerId }),
				});
				continue;
			}
			if (token.kind === "number") {
				const number = numericValue(token.value);
				const containerId = this.literalContainerAt(token.startOffset);
				literals.push({
					kind: "number",
					value: token.value,
					...(number === undefined ? {} : { number }),
					range: { start: token.start, end: token.end },
					...(containerId === undefined ? {} : { containerId }),
				});
			}
		}
		return literals;
	}
}

export function parseRustFile(module: string, text: string, depth: "full" | "outline" = "full"): ParsedFile {
	return new RustParser(module, text, depth).parse();
}
