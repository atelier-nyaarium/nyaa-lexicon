// Owns GDScript declaration extraction and declaration spans.

import { coordinatesOf, defined, type Metrics, type Range, type TextCoordinates } from "@nyaa-lexicon/protocol";
import { type Blocks, blockHeader, blocksOf, bodyEndLine, hasCode, headerEndLine } from "./blocks.js";
import { HeaderReader, type HeaderStop } from "./header.js";
import { withMemberInsertLines } from "./layout.js";
import { basenameOf, parseLineHeads } from "./line-syntax.js";
import type {
	ActiveEnum,
	ActiveFunctionHeader,
	ComposeSymbolId,
	DeclarationFact,
	DeclarationKind,
	Descriptor,
	ParsedKeyword,
	ParsedLine,
	ReferenceToken,
	Scope,
	SourceLine,
	Token,
	Visibility,
} from "./parse-model.js";
import {
	firstLineToken,
	isIgnorable,
	type LexedSource,
	lexSource,
	matchingReferenceToken,
	nextReferenceToken,
	tokenAt,
} from "./tokens.js";

//////// Declarations

function rangeOf(coordinates: TextCoordinates, line: SourceLine): Range {
	return rangeOfLines(coordinates, line, line);
}

function rangeOfLines(coordinates: TextCoordinates, start: SourceLine, end: SourceLine): Range {
	const startOffset = coordinates.offsetAt({ line: start.line, character: 0 });
	const endOffset = coordinates.offsetAt({ line: end.line, character: end.end });
	if (startOffset === undefined || endOffset === undefined) throw new Error("source line has no coordinate");
	const range = coordinates.rangeAt(startOffset, endOffset);
	if (range === undefined) throw new Error("source line range is invalid");
	return range;
}

function selectionRangeOf(line: SourceLine, token: Token): Range {
	return {
		start: { line: line.line, character: token.start },
		end: { line: line.line, character: token.start + token.name.length },
	};
}

function visibilityOf(name: string, local: boolean): Visibility {
	if (local) return "local";
	return name.startsWith("_") ? "private" : "public";
}

/** Where the header stops, and whether its colon opens a type. */
function lineHeader(headers: HeaderReader, line: SourceLine, parsed: ParsedLine, name: Token): string | undefined {
	const keyword = parsed.keyword;
	const stop: HeaderStop =
		keyword === "func" || keyword === "var" || keyword === "const" || keyword === "for" || keyword === "class"
			? "colon"
			: keyword === "enum"
				? "brace"
				: "line";
	const typed = keyword === "var" || keyword === "const" || keyword === "for";
	return headers.header({ line, head: parsed.head, name: name.start, stop, typed });
}

function memberHeader(headers: HeaderReader, line: SourceLine, member: Token): string | undefined {
	return headers.header({ line, head: member.start, name: member.start, stop: "member" });
}

/** `get` or `set`, then its parameters or colon. */
export function isAccessorHead(lexed: LexedSource, line: number): boolean {
	const [first, second] = (lexed.lineTokens[line] ?? []).slice(0, 2).map((index) => lexed.tokens[index]);
	if (first?.kind !== "identifier" || (first.value !== "set" && first.value !== "get")) return false;
	return second?.value === "(" || second?.value === ":";
}

function accessorEndLine(lexed: LexedSource, declarationIndex: number, declarationIndent: number): SourceLine {
	const lines = lexed.lines;
	let index = declarationIndex + 1;
	while (index < lines.length && isIgnorable(lexed, index)) index++;
	const accessor = lines[index] as SourceLine | undefined;
	if (accessor === undefined || accessor.indent < declarationIndent || !isAccessorHead(lexed, index)) {
		return lines[declarationIndex] as SourceLine;
	}

	let end = index;
	const accessorIndent = accessor.indent;
	index++;
	while (index < lines.length) {
		const line = lines[index] as SourceLine;
		if (isIgnorable(lexed, index)) {
			index++;
			continue;
		}
		const indent = line.indent;
		if (indent > accessorIndent) {
			end = index;
			index++;
			continue;
		}
		if (indent === accessorIndent && isAccessorHead(lexed, index)) {
			end = index;
			index++;
			continue;
		}
		break;
	}
	return lines[end] as SourceLine;
}

function descriptorFor(keyword: ParsedKeyword, name: string): Descriptor {
	if (keyword === "func") return { kind: "method", name };
	if (keyword === "class_name" || keyword === "class" || keyword === "enum") return { kind: "type", name };
	return { kind: "term", name };
}

function declarationKindFor(keyword: ParsedKeyword, local: boolean): DeclarationKind {
	if (keyword === "class_name" || keyword === "class") return "class";
	if (keyword === "func") return "method";
	if (keyword === "var") return local ? "variable" : "property";
	if (keyword === "const") return "constant";
	if (keyword === "signal") return "event";
	if (keyword === "enum") return "enum";
	if (keyword === "for") return "variable";
	return "variable";
}

function makeDeclaration(
	compose: ComposeSymbolId,
	module: string,
	coordinates: TextCoordinates,
	line: SourceLine,
	token: Token,
	keyword: ParsedKeyword,
	name: string,
	scope: Scope,
	languageKind: string | undefined,
	visibility: Visibility,
	signature: string | undefined,
	exported?: boolean,
): DeclarationFact {
	const descriptors = [...scope.descriptors, descriptorFor(keyword, name)];
	const symbolId = compose({ language: "gdscript", module, descriptors });
	const local = scope.functionScope;
	return {
		symbolId,
		kind: declarationKindFor(keyword, local),
		...defined({ languageKind }),
		name,
		range: rangeOf(coordinates, line),
		selectionRange: selectionRangeOf(line, token),
		visibility,
		...defined({ exported, signature }),
		...(scope.containerId === "" ? {} : { containerId: scope.containerId }),
	};
}

function makeImplicitClass(
	compose: ComposeSymbolId,
	module: string,
	coordinates: TextCoordinates,
	line: SourceLine,
	name: string,
	className: Token | null,
	signature: string | undefined,
): DeclarationFact {
	const token = className ?? { name, start: 0 };
	const symbolId = compose({
		language: "gdscript",
		module,
		descriptors: [{ kind: "type", name }],
	});
	return {
		symbolId,
		kind: "class",
		languageKind: className === null ? "script" : "class_name",
		name,
		range: rangeOf(coordinates, line),
		selectionRange: selectionRangeOf(line, token),
		visibility: visibilityOf(name, false),
		...defined({ signature }),
	};
}

interface ParameterSegment {
	start: number;
	end: number;
}

function parameterSegments(tokens: ReferenceToken[], start: number, end: number): ParameterSegment[] {
	const segments: ParameterSegment[] = [];
	let segmentStart = start;
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = start; index < end; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else if (value === "{") braces++;
		else if (value === "}") braces--;
		else if (value === "," && parentheses === 0 && brackets === 0 && braces === 0) {
			segments.push({ start: segmentStart, end: index });
			segmentStart = index + 1;
		}
	}
	segments.push({ start: segmentStart, end });
	return segments;
}

/** The parentheses right after a function's name. */
function parameterList(
	lexed: LexedSource,
	declaration: Pick<DeclarationFact, "selectionRange">,
): { open: number; close: number } | undefined {
	const { start } = declaration.selectionRange;
	const name = tokenAt(lexed, start.line, start.character);
	if (name < 0) return undefined;
	const open = nextReferenceToken(lexed.tokens, name);
	if (open < 0 || (lexed.tokens[open] as ReferenceToken).value !== "(") return undefined;
	const close = matchingReferenceToken(lexed.tokens, open, "(", ")");
	return close < 0 ? undefined : { open, close };
}

function parameterNameAndEnd(
	tokens: ReferenceToken[],
	segment: ParameterSegment,
): { name: ReferenceToken; end: ReferenceToken } | null {
	let name: ReferenceToken | null = null;
	let defaultIndex = segment.end;
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = segment.start; index < segment.end; index++) {
		const token = tokens[index] as ReferenceToken;
		const value = token.value;
		if (name === null && token.kind === "identifier") name = token;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else if (value === "{") braces++;
		else if (value === "}") braces--;
		else if (parentheses === 0 && brackets === 0 && braces === 0 && (value === "=" || value === ":=")) {
			defaultIndex = index;
			break;
		}
	}
	if (name === null) return null;
	let endIndex = defaultIndex - 1;
	while (endIndex >= segment.start && (tokens[endIndex] as ReferenceToken).kind === "newline") endIndex--;
	const end = tokens[endIndex] as ReferenceToken | undefined;
	return end === undefined ? null : { name, end };
}

function addFunctionParameters(
	declarations: DeclarationFact[],
	module: string,
	compose: ComposeSymbolId,
	declaration: DeclarationFact,
	scope: Scope,
	lexed: LexedSource,
): void {
	const list = parameterList(lexed, declaration);
	if (list === undefined) return;
	for (const segment of parameterSegments(lexed.tokens, list.open + 1, list.close)) {
		const parameter = parameterNameAndEnd(lexed.tokens, segment);
		if (parameter === null) continue;
		const parameterId = compose({
			language: "gdscript",
			module,
			descriptors: [
				...scope.descriptors,
				{ kind: "method", name: declaration.name },
				{ kind: "parameter", name: parameter.name.value },
			],
		});
		declarations.push({
			symbolId: parameterId,
			kind: "variable",
			languageKind: "parameter",
			name: parameter.name.value,
			range: {
				start: { line: parameter.name.line, character: parameter.name.character },
				end: { line: parameter.end.line, character: parameter.end.character + parameter.end.value.length },
			},
			selectionRange: {
				start: { line: parameter.name.line, character: parameter.name.character },
				end: { line: parameter.name.line, character: parameter.name.character + parameter.name.value.length },
			},
			visibility: "local",
			containerId: declaration.symbolId,
		});
	}
}

/** Members written after the line's `{`. */
function enumMembers(lexed: LexedSource, line: number): Token[] {
	const members: Token[] = [];
	let inside = false;
	let expectName = false;
	let expressionDepth = 0;
	for (const index of lexed.lineTokens[line] ?? []) {
		const token = lexed.tokens[index] as ReferenceToken;
		const value = token.value;
		if (!inside) {
			if (value === "{") {
				inside = true;
				expectName = true;
			}
			continue;
		}
		if (expressionDepth > 0) {
			if (value === "(") expressionDepth++;
			if (value === ")") expressionDepth--;
			continue;
		}
		if (value === "}") break;
		if (value === "(") expressionDepth = 1;
		else if (value === ",") expectName = true;
		else if (expectName && token.kind === "identifier") {
			members.push({ name: value, start: token.character });
			expectName = false;
		}
	}
	return members;
}

/** An enum member leading a line of a multi-line enum. */
function multilineEnumMember(lexed: LexedSource, line: number): Token | null {
	const first = firstLineToken(lexed, line);
	return first?.kind === "identifier" ? { name: first.value, start: first.character } : null;
}

/** Opens a brace it does not close. */
function opensBrace(lexed: LexedSource, line: number): boolean {
	const values = (lexed.lineTokens[line] ?? []).map((index) => (lexed.tokens[index] as ReferenceToken).value);
	return values.includes("{") && !values.includes("}");
}

export function extractGdscript(module: string, text: string, compose: ComposeSymbolId): DeclarationFact[] {
	const coordinates = coordinatesOf(text);
	const lexed = lexSource(text);
	const blocks = blocksOf(lexed);
	const statementLines = new Set(blocks.statements.map((statement) => statement.line));
	const lines = lexed.lines;
	const headers = new HeaderReader(text, lexed);
	const classLine = lines
		.map((line) => ({
			line,
			parsed: parseLineHeads(lexed, line.line).find((candidate) => candidate.keyword === "class_name"),
		}))
		.find((entry) => entry.parsed?.keyword === "class_name" && entry.parsed.name !== null);
	const className = classLine?.parsed?.name ?? null;
	const classHeader =
		classLine?.parsed === undefined || className === null
			? undefined
			: lineHeader(headers, classLine.line, classLine.parsed, className);
	const rootName = className?.name ?? basenameOf(module);
	const rootLine = classLine?.line ?? {
		line: 0,
		text: "",
		code: "",
		indent: 0,
		end: 0,
		hasString: false,
		endsInString: false,
	};
	const root = makeImplicitClass(compose, module, coordinates, rootLine, rootName, className, classHeader);
	// The script IS the class, so the root's range spans the whole file. A one-line range here made
	// a class-level move relocate only the class_name line and orphan every member behind it.
	const firstLine = lines[0] ?? rootLine;
	const lastLine = lines[lines.length - 1] ?? firstLine;
	root.range = rangeOfLines(coordinates, firstLine, lastLine);
	const declarations: DeclarationFact[] = [root];
	const scopes: Scope[] = [
		{
			indent: -1,
			descriptors: [{ kind: "type", name: rootName }],
			containerId: root.symbolId,
			functionScope: false,
		},
	];
	let activeEnum: ActiveEnum | null = null;
	let activeFunctionHeader: ActiveFunctionHeader | null = null;
	const openFunction = (header: ActiveFunctionHeader): void => {
		addFunctionParameters(declarations, module, compose, header.declaration, header.scope, lexed);
		scopes.push({
			indent: header.indent,
			descriptors: [...header.scope.descriptors, { kind: "method", name: header.declaration.name }],
			containerId: header.declaration.symbolId,
			functionScope: true,
		});
	};

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex] as SourceLine;
		if (activeFunctionHeader !== null) {
			if (line.line < activeFunctionHeader.endLine) continue;
			activeFunctionHeader.declaration.range = rangeOfLines(coordinates, activeFunctionHeader.start, line);
			openFunction(activeFunctionHeader);
			activeFunctionHeader = null;
			continue;
		}

		const parsedLines = parseLineHeads(lexed, line.line);
		if (isIgnorable(lexed, line.line)) continue;

		const indent = line.indent;
		if (activeEnum !== null) {
			if (indent <= activeEnum.indent || parsedLines.length > 0) {
				activeEnum = null;
			} else {
				const member = multilineEnumMember(lexed, line.line);
				if (member !== null && !activeEnum.names.has(member.name)) {
					activeEnum.names.add(member.name);
					const declaration = makeDeclaration(
						compose,
						module,
						coordinates,
						line,
						member,
						"const",
						member.name,
						{
							indent: activeEnum.indent,
							descriptors: activeEnum.descriptors,
							containerId: activeEnum.containerId,
							functionScope: false,
						},
						"enumMember",
						visibilityOf(member.name, false),
						memberHeader(headers, line, member),
					);
					declarations.push(declaration);
				}
				continue;
			}
		}
		// A continuation line closes no scope.
		if (statementLines.has(line.line)) {
			while (scopes.length > 1 && indent <= (scopes[scopes.length - 1] as Scope).indent) scopes.pop();
		}
		for (const parsed of parsedLines) {
			if (parsed.keyword === "class_name") continue;
			const scope = scopes[scopes.length - 1] as Scope;
			if (parsed.keyword === "func" && parsed.name === null) {
				scopes.push({
					indent,
					descriptors: scope.descriptors,
					containerId: scope.containerId,
					functionScope: true,
				});
				continue;
			}
			if (parsed.name === null || parsed.keyword === "extends") continue;

			if (parsed.keyword === "class") {
				const declaration = makeDeclaration(
					compose,
					module,
					coordinates,
					line,
					parsed.name,
					parsed.keyword,
					parsed.name.name,
					scope,
					"innerClass",
					visibilityOf(parsed.name.name, false),
					lineHeader(headers, line, parsed, parsed.name),
				);
				declarations.push(declaration);
				scopes.push({
					indent,
					descriptors: [...scope.descriptors, { kind: "type", name: parsed.name.name }],
					containerId: declaration.symbolId,
					functionScope: false,
				});
				continue;
			}
			if (parsed.keyword === "enum") {
				const declaration = makeDeclaration(
					compose,
					module,
					coordinates,
					line,
					parsed.name,
					parsed.keyword,
					parsed.name.name,
					scope,
					"enum",
					visibilityOf(parsed.name.name, false),
					lineHeader(headers, line, parsed, parsed.name),
				);
				declarations.push(declaration);
				const members = enumMembers(lexed, line.line);
				for (const member of members) {
					const memberDeclaration = makeDeclaration(
						compose,
						module,
						coordinates,
						line,
						member,
						"const",
						member.name,
						{
							...scope,
							descriptors: [...scope.descriptors, { kind: "type", name: parsed.name.name }],
							containerId: declaration.symbolId,
						},
						"enumMember",
						visibilityOf(member.name, false),
						memberHeader(headers, line, member),
					);
					declarations.push(memberDeclaration);
				}
				if (opensBrace(lexed, line.line)) {
					activeEnum = {
						indent,
						descriptors: [...scope.descriptors, { kind: "type", name: parsed.name.name }],
						containerId: declaration.symbolId,
						names: new Set(members.map((member) => member.name)),
					};
				}
				continue;
			}

			const local = scope.functionScope;
			const languageKind =
				parsed.keyword === "signal"
					? "signal"
					: parsed.keyword === "func"
						? parsed.static
							? "static"
							: undefined
						: local
							? undefined
							: "property";
			const declaration = makeDeclaration(
				compose,
				module,
				coordinates,
				line,
				parsed.name,
				parsed.keyword,
				parsed.name.name,
				scope,
				languageKind,
				visibilityOf(parsed.name.name, local),
				lineHeader(headers, line, parsed, parsed.name),
			);
			if (parsed.keyword === "var") {
				declaration.range = rangeOfLines(coordinates, line, accessorEndLine(lexed, lineIndex, indent));
			}
			declarations.push(declaration);
			if (parsed.keyword !== "func") continue;
			const header = { indent, scope, declaration, start: line, endLine: headerEndLine(blocks, declaration) };
			if (header.endLine > line.line) activeFunctionHeader = header;
			else openFunction(header);
		}
	}

	const spanned = declarations.map((declaration) => {
		if (declaration.kind !== "method" && declaration.languageKind !== "innerClass") return declaration;
		const start = lines[declaration.range.start.line] as SourceLine | undefined;
		const end = lines[bodyEndLine(blocks, declaration) - 1] as SourceLine | undefined;
		return start === undefined || end === undefined
			? declaration
			: { ...declaration, range: rangeOfLines(coordinates, start, end) };
	});
	return withMemberInsertLines(spanned, lexed.scanned, lexed.tokens, coordinates);
}

function functionParameterCount(lexed: LexedSource, declaration: DeclarationFact): number {
	const list = parameterList(lexed, declaration);
	if (list === undefined) return 0;
	return parameterSegments(lexed.tokens, list.open + 1, list.close).filter((segment) =>
		hasCode(lexed.tokens, segment),
	).length;
}

const CONTROL_WORDS = new Set(["if", "elif", "else", "for", "while", "match"]);

/** A body line: its indent and the code tokens starting on it. */
interface BodyRow {
	indent: number;
	tokens: ReferenceToken[];
}

/** Lines in `start..end` holding code. */
function bodyRows(lexed: LexedSource, start: number, end: number): BodyRow[] {
	const rows: BodyRow[] = [];
	for (let line = start; line < end; line++) {
		if (isIgnorable(lexed, line)) continue;
		rows.push({
			indent: (lexed.lines[line] as SourceLine).indent,
			tokens: (lexed.lineTokens[line] ?? []).map((index) => lexed.tokens[index] as ReferenceToken),
		});
	}
	return rows;
}

function wordCount(tokens: ReferenceToken[], words: readonly string[]): number {
	return tokens.filter((token) => token.kind === "identifier" && words.includes(token.value)).length;
}

function controlHeader(tokens: ReferenceToken[]): string | null {
	const first = tokens[0];
	return first?.kind === "identifier" && CONTROL_WORDS.has(first.value) ? first.value : null;
}

function hasTopLevelColon(tokens: ReferenceToken[]): boolean {
	let depth = 0;
	for (const { value } of tokens) {
		if (value === "(" || value === "[" || value === "{") depth++;
		else if (value === ")" || value === "]" || value === "}") depth--;
		else if (value === ":" && depth === 0) return true;
	}
	return false;
}

function matchArmCount(rows: readonly BodyRow[]): number {
	const matches: { indent: number; armIndent: number | null }[] = [];
	let count = 0;
	for (const { indent, tokens } of rows) {
		while (matches.length > 0 && indent <= (matches[matches.length - 1] as { indent: number }).indent)
			matches.pop();
		const current = matches[matches.length - 1];
		if (current !== undefined && indent > current.indent) {
			if (current.armIndent === null) current.armIndent = indent;
			if (indent === current.armIndent && hasTopLevelColon(tokens)) count++;
		}
		if (controlHeader(tokens) === "match") matches.push({ indent, armIndent: null });
	}
	return count;
}

function bodyMetrics(rows: readonly BodyRow[]): Pick<Metrics, "nesting" | "branches"> {
	const controls: number[] = [];
	let nesting = 0;
	let branches = matchArmCount(rows);
	for (const { indent, tokens } of rows) {
		while (controls.length > 0 && indent <= (controls[controls.length - 1] as number)) controls.pop();
		nesting = Math.max(nesting, controls.length);
		const header = controlHeader(tokens);
		if (header !== null) {
			if (header !== "match") branches++;
			controls.push(indent);
			continue;
		}
		// A conditional expression, then each short-circuit.
		if (wordCount(tokens, ["if"]) > 0 && wordCount(tokens, ["else"]) > 0) branches++;
		branches += wordCount(tokens, ["and", "or"]);
	}
	return { nesting, branches: branches + 1 };
}

function metricsForDeclaration(blocks: Blocks, declaration: DeclarationFact): Metrics {
	const metrics: Metrics = {
		lines: declaration.range.end.line - declaration.range.start.line + 1,
	};
	if (declaration.kind !== "method") return metrics;
	const lexed = blocks.lexed;
	const headerEnd = headerEndLine(blocks, declaration);
	const end = bodyEndLine(blocks, declaration);
	const lastBodyLine = Math.max(headerEnd, end - 1);
	metrics.lines = lastBodyLine - declaration.range.start.line + 1;
	metrics.parameters = functionParameterCount(lexed, declaration);
	const header = blockHeader(blocks, declaration);
	if (header !== undefined && hasCode(lexed.tokens, header.inline)) {
		const { start, end: stop } = header.inline;
		const tokens = lexed.tokens.slice(start, stop).filter((token) => token.kind !== "newline");
		Object.assign(metrics, bodyMetrics([{ indent: header.statement.indent, tokens }]));
		return metrics;
	}
	const rows = bodyRows(lexed, headerEnd + 1, end);
	if (rows.length > 0) Object.assign(metrics, bodyMetrics(rows));
	return metrics;
}

function addDeclarationMetrics(declarations: DeclarationFact[], text: string): DeclarationFact[] {
	const blocks = blocksOf(lexSource(text));
	return declarations.map((declaration) => ({
		...declaration,
		metrics: metricsForDeclaration(blocks, declaration),
	}));
}

function extractGeneric(module: string, text: string, compose: ComposeSymbolId): DeclarationFact[] {
	const declarations: DeclarationFact[] = [];
	const coordinates = coordinatesOf(text);
	const lexed = lexSource(text);
	const headers = new HeaderReader(text, lexed);
	for (const line of lexed.lines) {
		const parsed = parseLineHeads(lexed, line.line, true)[0];
		if (parsed === undefined || parsed.name === null) continue;
		const signature = headers.header({
			line,
			head: parsed.head,
			name: parsed.name.start,
			stop: parsed.keyword === "const" ? "line" : "brace",
		});
		const declaration = makeDeclaration(
			compose,
			module,
			coordinates,
			line,
			parsed.name,
			parsed.keyword,
			parsed.name.name,
			{ indent: -1, descriptors: [], containerId: "", functionScope: false },
			undefined,
			"public",
			signature,
			true,
		);
		declarations.push({
			...declaration,
			kind: parsed.keyword === "class" ? "class" : parsed.keyword === "func" ? "function" : "constant",
		});
	}
	return declarations;
}

export function extractDeclarationsCore(module: string, text: string, compose: ComposeSymbolId): DeclarationFact[] {
	const declarations = module.endsWith(".gd")
		? extractGdscript(module, text, compose)
		: extractGeneric(module, text, compose);
	return module.endsWith(".gd") ? addDeclarationMetrics(declarations, text) : declarations;
}
