// Owns GDScript declaration extraction and declaration spans.

import { defined, type Metrics, type Position, type Range, type TextCoordinates } from "@nyaa-lexicon/protocol";
import { type Blocks, blockHeader, bodyEndLine, hasCode, headerEndLine, indentedBodyEnd } from "./blocks.js";
import type { LogicalLine } from "./expression.js";
import { HeaderReader, type HeaderRequest, type HeaderStop } from "./header.js";
import { withMemberInsertLines } from "./layout.js";
import { annotationLine, basenameOf, declarationStart, parseLineHeads } from "./line-syntax.js";
import type {
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
import type { ParsedScript } from "./script.js";
import {
	firstLineToken,
	isIgnorable,
	type LexedSource,
	matchingReferenceToken,
	nextReferenceToken,
	tokenAt,
} from "./tokens.js";

//////// Declarations

/** Before a mid-line `var`: a pattern's bracket, brace, comma or entry colon, or an inline body's colon. */
const BINDING_OPENERS = new Set(["[", "{", ",", ":"]);

/** Its text's start, from column zero when only indentation precedes it. */
function rangeStart(lexed: LexedSource, line: number, head: number): Position {
	const start = declarationStart(lexed, line, head);
	const first = firstLineToken(lexed, start.line);
	return first !== undefined && first.character < start.character ? start : { line: start.line, character: 0 };
}

function rangeTo(coordinates: TextCoordinates, start: Position, end: SourceLine): Range {
	const startOffset = coordinates.offsetAt(start);
	const endOffset = coordinates.offsetAt({ line: end.line, character: end.end });
	if (startOffset === undefined || endOffset === undefined) throw new Error("source line has no coordinate");
	const range = coordinates.rangeAt(startOffset, endOffset);
	if (range === undefined) throw new Error("source line range is invalid");
	return range;
}

/** Its own start through `end`. */
function extendTo(coordinates: TextCoordinates, declaration: DeclarationFact, end: SourceLine): void {
	declaration.range = rangeTo(coordinates, declaration.range.start, end);
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
function lineRequest(line: SourceLine, parsed: ParsedLine, name: Token): HeaderRequest {
	const keyword = parsed.keyword;
	const stop: HeaderStop =
		keyword === "func" || keyword === "var" || keyword === "const" || keyword === "for" || keyword === "class"
			? "colon"
			: keyword === "enum"
				? "brace"
				: "line";
	const typed = keyword === "var" || keyword === "const" || keyword === "for";
	return { line, head: parsed.head, name: name.start, stop, typed };
}

function memberRequest(line: SourceLine, member: Token): HeaderRequest {
	return { line, head: member.start, name: member.start, stop: "member" };
}

/** `get` or `set`, then its parameters, colon, or `=` and a function. */
export function isAccessorHead(lexed: LexedSource, line: number): boolean {
	const [first, second] = (lexed.lineTokens[line] ?? []).slice(0, 2).map((index) => lexed.tokens[index]);
	if (first?.kind !== "identifier" || (first.value !== "set" && first.value !== "get")) return false;
	return second?.value === "(" || second?.value === ":" || second?.value === "=";
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

/** `static` marks a func or var the class itself holds. */
function memberLanguageKind(parsed: ParsedLine, local: boolean): string | undefined {
	if (parsed.keyword === "signal") return "signal";
	if (parsed.keyword === "func") return parsed.static ? "static" : undefined;
	if (local) return undefined;
	return parsed.static ? "static" : "property";
}

/** Its range and signature start from the one request. */
function makeDeclaration(
	script: ParsedScript,
	headers: HeaderReader,
	request: HeaderRequest,
	keyword: ParsedKeyword,
	name: string,
	scope: Scope,
	languageKind: string | undefined,
	visibility: Visibility,
	exported?: boolean,
): DeclarationFact {
	const { compose, module, coordinates, lexed } = script;
	const { line, head } = request;
	const descriptors = [...scope.descriptors, descriptorFor(keyword, name)];
	const symbolId = compose({ language: "gdscript", module, descriptors });
	const local = scope.functionScope;
	const signature = headers.header(request);
	return {
		symbolId,
		kind: declarationKindFor(keyword, local),
		...defined({ languageKind }),
		name,
		range: rangeTo(coordinates, rangeStart(lexed, line.line, head), line),
		selectionRange: selectionRangeOf(line, { name, start: request.name }),
		visibility,
		...defined({ exported, signature }),
		...(scope.containerId === "" ? {} : { containerId: scope.containerId }),
	};
}

function makeImplicitClass(
	compose: ComposeSymbolId,
	module: string,
	range: Range,
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
		range,
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

interface EnumBody {
	members: ReferenceToken[];
	/** The closing brace's line; the opening line when unclosed. */
	lastLine: number;
}

/** Members between the braces opened on `line`; an unclosed enum's on that line alone. */
function enumBody(lexed: LexedSource, line: number): EnumBody {
	const tokens = lexed.tokens;
	const lineTokens = lexed.lineTokens[line] ?? [];
	const open = lineTokens.find((index) => tokens[index]?.value === "{");
	if (open === undefined) return { members: [], lastLine: line };
	const close = matchingReferenceToken(tokens, open, "{", "}");
	const end = close < 0 ? (lineTokens.at(-1) as number) + 1 : close;
	const members: ReferenceToken[] = [];
	const names = new Set<string>();
	let depth = 0;
	let expectName = true;
	for (let index = open + 1; index < end; index++) {
		const token = tokens[index] as ReferenceToken;
		const value = token.value;
		if (token.kind === "newline") continue;
		if (value === "(" || value === "[" || value === "{") depth++;
		else if (value === ")" || value === "]" || value === "}") depth--;
		if (depth === 0 && value === ",") {
			expectName = true;
			continue;
		}
		if (expectName && depth === 0 && token.kind === "identifier" && !names.has(value)) {
			members.push(token);
			names.add(value);
		}
		expectName = false;
	}
	return { members, lastLine: close < 0 ? line : (tokens[close] as ReferenceToken).line };
}

/** `var` names bound mid-line: match patterns and inline bodies. */
function inlineBindings(lexed: LexedSource, line: number): Array<{ head: number; name: Token }> {
	const tokens = lexed.tokens;
	const bindings: Array<{ head: number; name: Token }> = [];
	for (const index of lexed.lineTokens[line] ?? []) {
		const token = tokens[index] as ReferenceToken;
		const previous = tokens[index - 1];
		const name = tokens[index + 1];
		if (token.kind !== "identifier" || token.value !== "var" || name?.kind !== "identifier") continue;
		if (previous === undefined || previous.line !== line || !BINDING_OPENERS.has(previous.value)) continue;
		bindings.push({ head: token.character, name: { name: name.value, start: name.character } });
	}
	return bindings;
}

/** The statement holding `name` ends by opening a lambda's block. */
function opensLambdaBlock(blocks: Blocks, statement: LogicalLine, name: number): boolean {
	const tokens = blocks.lexed.tokens;
	let last = statement.end - 1;
	while (last > name && (tokens[last] as ReferenceToken).kind === "newline") last--;
	if ((tokens[last] as ReferenceToken).value !== ":") return false;
	for (let index = name + 1; index < last; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind === "identifier" && token.value === "func") return true;
	}
	return false;
}

/** A script's `class_name` and `extends` lines, which only annotations and strings may precede. */
export interface ScriptHeader {
	line: number;
	/** Column of the first header line's head. */
	head: number;
	/** The `extends` target: a class name or a path. */
	base?: string;
}

/** A `class_name` or `extends` head at column zero. */
function scriptHeadOn(lexed: LexedSource, line: SourceLine): ParsedLine | undefined {
	const head = parseLineHeads(lexed, line.line)[0];
	return line.indent === 0 && (head?.keyword === "class_name" || head?.keyword === "extends") ? head : undefined;
}

/** A header line's `extends` target. */
function baseOn(lexed: LexedSource, line: number): string | undefined {
	for (const index of lexed.lineTokens[line] ?? []) {
		const token = lexed.tokens[index] as ReferenceToken;
		if (token.kind !== "identifier" || token.value !== "extends") continue;
		const target = lexed.tokens[nextReferenceToken(lexed.tokens, index)];
		return target?.kind === "identifier" ? target.value : target?.string?.value;
	}
	return undefined;
}

export function scriptHeaderOf(lexed: LexedSource): ScriptHeader | undefined {
	let header: ScriptHeader | undefined;
	for (const line of lexed.lines) {
		if (isIgnorable(lexed, line.line)) continue;
		if (header === undefined && annotationLine(lexed, line.line) !== null) continue;
		if (firstLineToken(lexed, line.line)?.kind === "string") continue;
		const head = scriptHeadOn(lexed, line);
		if (head === undefined) break;
		header ??= { line: line.line, head: head.head };
		const base = baseOn(lexed, line.line);
		if (base !== undefined) header.base ??= base;
	}
	return header;
}

export function extractGdscript(script: ParsedScript): DeclarationFact[] {
	const { coordinates, lexed, module, compose, blocks } = script;
	const statementLines = new Set(blocks.statements.map((statement) => statement.line));
	const lines = lexed.lines;
	const headers = new HeaderReader(script.text, lexed);
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
			: headers.header(lineRequest(classLine.line, classLine.parsed, className));
	const rootName = className?.name ?? basenameOf(module);
	const rootLine = classLine?.line ?? { line: 0, start: 0, indent: 0, end: 0, hasString: false, endsInString: false };
	// Godot's class extents: header to end of file.
	const scriptHeader = scriptHeaderOf(lexed);
	const rootStart =
		scriptHeader === undefined
			? { line: 0, character: 0 }
			: rangeStart(lexed, scriptHeader.line, scriptHeader.head);
	const rootRange = rangeTo(coordinates, rootStart, lines[lines.length - 1] ?? rootLine);
	const root = makeImplicitClass(compose, module, rootRange, rootLine, rootName, className, classHeader);
	const declarations: DeclarationFact[] = [root];
	const scopes: Scope[] = [
		{
			indent: -1,
			descriptors: [{ kind: "type", name: rootName }],
			containerId: root.symbolId,
			functionScope: false,
		},
	];
	let activeFunctionHeader: ActiveFunctionHeader | null = null;
	const addEnumMembers = (members: ReferenceToken[], scope: Scope): void => {
		for (const token of members) {
			const memberLine = lines[token.line] as SourceLine;
			const member = { name: token.value, start: token.character };
			declarations.push(
				makeDeclaration(
					script,
					headers,
					memberRequest(memberLine, member),
					"const",
					member.name,
					scope,
					"enumMember",
					visibilityOf(member.name, false),
				),
			);
		}
	};
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
			extendTo(coordinates, activeFunctionHeader.declaration, line);
			openFunction(activeFunctionHeader);
			activeFunctionHeader = null;
			continue;
		}

		const parsedLines = parseLineHeads(lexed, line.line);
		if (isIgnorable(lexed, line.line)) continue;

		const indent = line.indent;
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
			// An unnamed enum's members are the enclosing class's constants.
			if (parsed.keyword === "enum" && parsed.name === null) {
				addEnumMembers(enumBody(lexed, line.line).members, { ...scope, functionScope: false });
				continue;
			}
			if (parsed.name === null || parsed.keyword === "extends") continue;

			if (parsed.keyword === "class") {
				const declaration = makeDeclaration(
					script,
					headers,
					lineRequest(line, parsed, parsed.name),
					parsed.keyword,
					parsed.name.name,
					scope,
					"innerClass",
					visibilityOf(parsed.name.name, false),
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
					script,
					headers,
					lineRequest(line, parsed, parsed.name),
					parsed.keyword,
					parsed.name.name,
					scope,
					"enum",
					visibilityOf(parsed.name.name, false),
				);
				const body = enumBody(lexed, line.line);
				extendTo(coordinates, declaration, lines[body.lastLine] as SourceLine);
				declarations.push(declaration);
				addEnumMembers(body.members, {
					...scope,
					descriptors: [...scope.descriptors, { kind: "type", name: parsed.name.name }],
					containerId: declaration.symbolId,
					functionScope: false,
				});
				continue;
			}

			const local = scope.functionScope;
			const languageKind = memberLanguageKind(parsed, local);
			const declaration = makeDeclaration(
				script,
				headers,
				lineRequest(line, parsed, parsed.name),
				parsed.keyword,
				parsed.name.name,
				scope,
				languageKind,
				visibilityOf(parsed.name.name, local),
			);
			const nameIndex = tokenAt(lexed, line.line, parsed.name.start);
			const statementIndex = blocks.owner[nameIndex] ?? -1;
			const statement = blocks.statements[statementIndex];
			if ((parsed.keyword === "var" || parsed.keyword === "const") && statement !== undefined) {
				if (opensLambdaBlock(blocks, statement, nameIndex)) {
					const end = indentedBodyEnd(blocks, statementIndex, statement.indent, statement.lastLine);
					extendTo(coordinates, declaration, lines[end] as SourceLine);
					// A class-level lambda's locals are not members.
					if (!local)
						scopes.push({
							indent,
							descriptors: [...scope.descriptors, { kind: "term", name: declaration.name }],
							containerId: declaration.symbolId,
							functionScope: true,
						});
				} else if (parsed.keyword === "var" && !local) {
					extendTo(coordinates, declaration, accessorEndLine(lexed, lineIndex, indent));
				}
			}
			declarations.push(declaration);
			if (parsed.keyword !== "func") continue;
			const header = { indent, scope, declaration, endLine: headerEndLine(blocks, declaration) };
			if (header.endLine > line.line) activeFunctionHeader = header;
			else openFunction(header);
		}
		const scope = scopes[scopes.length - 1] as Scope;
		if (!scope.functionScope) continue;
		for (const binding of inlineBindings(lexed, line.line)) {
			declarations.push(
				makeDeclaration(
					script,
					headers,
					{ line, head: binding.head, name: binding.name.start, stop: "member" },
					"var",
					binding.name.name,
					scope,
					undefined,
					"local",
				),
			);
		}
	}

	const spanned = declarations.map((declaration) => {
		if (declaration.kind !== "method" && declaration.languageKind !== "innerClass") return declaration;
		const end = lines[bodyEndLine(blocks, declaration) - 1] as SourceLine | undefined;
		return end === undefined
			? declaration
			: { ...declaration, range: rangeTo(coordinates, declaration.range.start, end) };
	});
	return withMemberInsertLines(spanned, blocks, coordinates);
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

function extractGeneric(script: ParsedScript): DeclarationFact[] {
	const { lexed } = script;
	const declarations: DeclarationFact[] = [];
	const headers = new HeaderReader(script.text, lexed);
	for (const line of lexed.lines) {
		const parsed = parseLineHeads(lexed, line.line, true)[0];
		if (parsed === undefined || parsed.name === null) continue;
		const declaration = makeDeclaration(
			script,
			headers,
			{ line, head: parsed.head, name: parsed.name.start, stop: parsed.keyword === "const" ? "line" : "brace" },
			parsed.keyword,
			parsed.name.name,
			{ indent: -1, descriptors: [], containerId: "", functionScope: false },
			undefined,
			"public",
			true,
		);
		declarations.push({
			...declaration,
			kind: parsed.keyword === "class" ? "class" : parsed.keyword === "func" ? "function" : "constant",
		});
	}
	return declarations;
}

/** Metrics included. */
export function declarationsOf(script: ParsedScript): DeclarationFact[] {
	if (!script.module.endsWith(".gd")) return extractGeneric(script);
	return script.declarations.map((declaration) => ({
		...declaration,
		metrics: metricsForDeclaration(script.blocks, declaration),
	}));
}
