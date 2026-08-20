// Owns GDScript declaration extraction and declaration spans.

import { coordinatesOf, type Metrics, type Range, type TextCoordinates } from "@nyaa-lexicon/protocol";
import { Cursor } from "./cursor.js";
import { basenameOf, containsCharacter, indentOf, isIgnorable, parseLineHead, parseLineHeads } from "./line-syntax.js";
import type {
	ActiveEnum,
	ActiveFunctionHeader,
	ComposeSymbolId,
	DeclarationFact,
	DeclarationKind,
	Descriptor,
	ParsedKeyword,
	ReferenceToken,
	Scope,
	SourceLine,
	Token,
	Visibility,
} from "./parse-model.js";
import { readLines } from "./source-scan.js";
import { matchingReferenceToken, nextReferenceToken, referenceTokens } from "./tokens.js";

//////// Declarations

export function contentEndCharacter(line: SourceLine): number {
	return line.text.endsWith("\r") ? line.text.length - 1 : line.text.length;
}

function rangeOf(coordinates: TextCoordinates, line: SourceLine): Range {
	return rangeOfLines(coordinates, line, line);
}

function rangeOfLines(coordinates: TextCoordinates, start: SourceLine, end: SourceLine): Range {
	const startOffset = coordinates.offsetAt({ line: start.line, character: 0 });
	const endOffset = coordinates.offsetAt({ line: end.line, character: contentEndCharacter(end) });
	if (startOffset === undefined || endOffset === undefined) throw new Error("source line has no coordinate");
	const range = coordinates.rangeAt(startOffset, endOffset);
	if (range === undefined) throw new Error("source line range is invalid");
	return range;
}

export function headerEndLine(lines: readonly { code: string }[], declaration: Pick<DeclarationFact, "range">): number {
	for (let line = declaration.range.start.line; line < lines.length; line++) {
		if ((lines[line]?.code ?? "").trimEnd().endsWith(":")) return line;
	}
	return declaration.range.end.line;
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

function signatureOf(line: SourceLine): string | undefined {
	const cursor = new Cursor(line.text);
	cursor.skipWhitespace();
	let signature = "";
	while (cursor.good()) signature += cursor.next();
	return signature === "" ? undefined : signature;
}

function signatureOfLines(lines: SourceLine[]): string | undefined {
	const signatures: string[] = [];
	for (const line of lines) {
		const signature = signatureOf(line);
		if (signature !== undefined) signatures.push(signature);
	}
	return signatures.length === 0 ? undefined : signatures.join("\n");
}

function functionHeaderComplete(lines: SourceLine[]): boolean {
	let parameterDepth = 0;
	let closedParameters = false;
	for (const line of lines) {
		const cursor = new Cursor(line.code);
		while (cursor.good()) {
			const character = cursor.next();
			if (character === "(") parameterDepth++;
			if (character === ")" && parameterDepth > 0) {
				parameterDepth--;
				closedParameters = parameterDepth === 0;
			}
			if (character === ":" && closedParameters) return true;
		}
	}
	return false;
}

export function isAccessorHead(line: SourceLine): boolean {
	const cursor = new Cursor(line.code);
	cursor.skipWhitespace();
	const name = cursor.readIdentifier();
	if (name === null || (name.name !== "set" && name.name !== "get")) return false;
	cursor.skipWhitespace();
	return cursor.peek() === "(" || cursor.peek() === ":";
}

function accessorEndLine(lines: SourceLine[], declarationIndex: number, declarationIndent: number): SourceLine {
	let index = declarationIndex + 1;
	while (index < lines.length && isIgnorable(lines[index] as SourceLine)) index++;
	const accessor = lines[index] as SourceLine | undefined;
	if (accessor === undefined || indentOf(accessor.text) < declarationIndent || !isAccessorHead(accessor)) {
		return lines[declarationIndex] as SourceLine;
	}

	let end = index;
	const accessorIndent = indentOf(accessor.text);
	index++;
	while (index < lines.length) {
		const line = lines[index] as SourceLine;
		if (isIgnorable(line)) {
			index++;
			continue;
		}
		const indent = indentOf(line.text);
		if (indent > accessorIndent) {
			end = index;
			index++;
			continue;
		}
		if (indent === accessorIndent && isAccessorHead(line)) {
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
	exported?: boolean,
): DeclarationFact {
	const descriptors = [...scope.descriptors, descriptorFor(keyword, name)];
	const symbolId = compose({ language: "gdscript", module, descriptors });
	const local = scope.functionScope;
	const signature = signatureOf(line);
	return {
		symbolId,
		kind: declarationKindFor(keyword, local),
		...(languageKind === undefined ? {} : { languageKind }),
		name,
		range: rangeOf(coordinates, line),
		selectionRange: selectionRangeOf(line, token),
		visibility,
		...(exported === undefined ? {} : { exported }),
		...(signature === undefined ? {} : { signature }),
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
): DeclarationFact {
	const token = className ?? { name, start: 0 };
	const symbolId = compose({
		language: "gdscript",
		module,
		descriptors: [{ kind: "type", name }],
	});
	const signature = signatureOf(line);
	return {
		symbolId,
		kind: "class",
		languageKind: className === null ? "script" : "class_name",
		name,
		range: rangeOf(coordinates, line),
		selectionRange: selectionRangeOf(line, token),
		visibility: visibilityOf(name, false),
		...(className === null || signature === undefined ? {} : { signature }),
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
	tokens: ReferenceToken[],
): void {
	const nameIndex = tokens.findIndex(
		(token) =>
			token.kind === "identifier" &&
			token.line === declaration.selectionRange.start.line &&
			token.character === declaration.selectionRange.start.character &&
			token.value === declaration.name,
	);
	if (nameIndex < 0) return;
	let open = nextReferenceToken(tokens, nameIndex);
	while (open >= 0 && (tokens[open] as ReferenceToken).value !== "(") open = nextReferenceToken(tokens, open);
	if (open < 0) return;
	const close = matchingReferenceToken(tokens, open, "(", ")");
	if (close < 0) return;
	for (const segment of parameterSegments(tokens, open + 1, close)) {
		const parameter = parameterNameAndEnd(tokens, segment);
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

function enumMembers(line: SourceLine): Token[] {
	const cursor = new Cursor(line.code);
	const members: Token[] = [];
	let inside = false;
	let expectName = false;
	let expressionDepth = 0;
	while (cursor.good()) {
		const character = cursor.peek();
		if (character === "#") break;
		if (!inside) {
			cursor.next();
			if (character === "{") {
				inside = true;
				expectName = true;
			}
			continue;
		}
		if (expressionDepth > 0) {
			const consumed = cursor.next();
			if (consumed === "(") expressionDepth++;
			if (consumed === ")") expressionDepth--;
			continue;
		}
		if (character === "}") break;
		if (character === "(") {
			expressionDepth = 1;
			cursor.next();
			continue;
		}
		if (character === ",") {
			expectName = true;
			cursor.next();
			continue;
		}
		if (character === "=" && expectName === false) {
			expectName = false;
			cursor.next();
			continue;
		}
		if (expectName) {
			const token = cursor.readIdentifier();
			if (token !== null) {
				members.push(token);
				expectName = false;
				continue;
			}
		}
		cursor.next();
	}
	return members;
}

function multilineEnumMember(line: SourceLine): Token | null {
	const cursor = new Cursor(line.code);
	cursor.skipWhitespace();
	if (cursor.peek() === "" || cursor.peek() === "#" || cursor.peek() === "}") return null;
	return cursor.readIdentifier();
}

export function extractGdscript(module: string, text: string, compose: ComposeSymbolId): DeclarationFact[] {
	const coordinates = coordinatesOf(text);
	const lines = readLines(text);
	const tokens = referenceTokens(lines);
	const classLine = lines
		.map((line) => ({ line, parsed: parseLineHeads(line).find((candidate) => candidate.keyword === "class_name") }))
		.find((entry) => entry.parsed?.keyword === "class_name" && entry.parsed.name !== null);
	const className = classLine?.parsed?.name ?? null;
	const rootName = className?.name ?? basenameOf(module);
	const rootLine = classLine?.line ?? {
		line: 0,
		text: "",
		code: "",
		hasString: false,
		stringStarts: [],
		endsInString: false,
	};
	const root = makeImplicitClass(compose, module, coordinates, rootLine, rootName, className);
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

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex] as SourceLine;
		if (activeFunctionHeader !== null) {
			activeFunctionHeader.lines.push(line);
			if (functionHeaderComplete(activeFunctionHeader.lines)) {
				activeFunctionHeader.declaration.range = rangeOfLines(
					coordinates,
					activeFunctionHeader.lines[0] as SourceLine,
					line,
				);
				const signature = signatureOfLines(activeFunctionHeader.lines);
				if (signature !== undefined) activeFunctionHeader.declaration.signature = signature;
				addFunctionParameters(
					declarations,
					module,
					compose,
					activeFunctionHeader.declaration,
					activeFunctionHeader.scope,
					tokens,
				);
				scopes.push({
					indent: activeFunctionHeader.indent,
					descriptors: [
						...activeFunctionHeader.scope.descriptors,
						{ kind: "method", name: activeFunctionHeader.declaration.name },
					],
					containerId: activeFunctionHeader.declaration.symbolId,
					functionScope: true,
				});
				activeFunctionHeader = null;
			}
			continue;
		}

		const parsedLines = parseLineHeads(line);
		if (isIgnorable(line)) continue;

		const indent = indentOf(line.text);
		if (activeEnum !== null) {
			if (indent <= activeEnum.indent || parsedLines.length > 0) {
				activeEnum = null;
			} else {
				const member = multilineEnumMember(line);
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
					);
					declarations.push(declaration);
				}
				continue;
			}
		}
		while (scopes.length > 1 && indent <= (scopes[scopes.length - 1] as Scope).indent) scopes.pop();
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
				);
				declarations.push(declaration);
				for (const member of enumMembers(line)) {
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
					);
					declarations.push(memberDeclaration);
				}
				if (containsCharacter(line.code, "{") && !containsCharacter(line.code, "}")) {
					activeEnum = {
						indent,
						descriptors: [...scope.descriptors, { kind: "type", name: parsed.name.name }],
						containerId: declaration.symbolId,
						names: new Set(enumMembers(line).map((member) => member.name)),
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
			);
			if (parsed.keyword === "var") {
				declaration.range = rangeOfLines(coordinates, line, accessorEndLine(lines, lineIndex, indent));
			}
			declarations.push(declaration);
			if (parsed.keyword !== "func") continue;
			if (functionHeaderComplete([line])) {
				addFunctionParameters(declarations, module, compose, declaration, scope, tokens);
				scopes.push({
					indent,
					descriptors: [...scope.descriptors, { kind: "method", name: parsed.name.name }],
					containerId: declaration.symbolId,
					functionScope: true,
				});
			} else {
				activeFunctionHeader = {
					indent,
					scope,
					declaration,
					lines: [line],
				};
			}
		}
	}

	return declarations.map((declaration) => {
		if (declaration.kind !== "method" && declaration.languageKind !== "innerClass") return declaration;
		const start = lines[declaration.range.start.line] as SourceLine | undefined;
		const end = lines[bodyEndLine(lines, declaration) - 1] as SourceLine | undefined;
		return start === undefined || end === undefined
			? declaration
			: { ...declaration, range: rangeOfLines(coordinates, start, end) };
	});
}

export function bodyEndLine(lines: SourceLine[], declaration: DeclarationFact): number {
	const header = lines[declaration.range.start.line] as SourceLine | undefined;
	if (header === undefined) return declaration.range.end.line + 1;
	const headerIndent = indentOf(header.text);
	const headerEnd = headerEndLine(lines, declaration);
	let last = headerEnd;
	for (let index = headerEnd + 1; index < lines.length; index++) {
		const line = lines[index] as SourceLine;
		const indent = indentOf(line.text);
		if (isIgnorable(line)) {
			if (line.text.trim() !== "" && indent > headerIndent) last = index;
			continue;
		}
		if (indent <= headerIndent) break;
		last = index;
	}
	return last + 1;
}

function functionParameterCount(lines: SourceLine[], declaration: DeclarationFact): number {
	const code = lines
		.slice(declaration.range.start.line, headerEndLine(lines, declaration) + 1)
		.map((line) => line.code)
		.join("\n");
	const open = code.indexOf("(");
	if (open < 0) return 0;
	let depth = 0;
	let brackets = 0;
	let braces = 0;
	let parameters = 0;
	let hasValue = false;
	for (let index = open; index < code.length; index++) {
		const character = code[index] as string;
		if (character === "(") {
			depth++;
			continue;
		}
		if (character === ")") {
			depth--;
			if (depth === 0) return parameters + (hasValue ? 1 : 0);
			continue;
		}
		if (character === "[") brackets++;
		else if (character === "]") brackets--;
		else if (character === "{") braces++;
		else if (character === "}") braces--;
		if (depth !== 1) continue;
		if (character === "," && brackets === 0 && braces === 0) {
			if (hasValue) parameters++;
			hasValue = false;
			continue;
		}
		if (!/\s/.test(character)) hasValue = true;
	}
	return parameters + (hasValue ? 1 : 0);
}

function controlHeader(code: string): string | null {
	const trimmed = code.trimStart();
	for (const keyword of ["if", "elif", "else", "for", "while", "match"]) {
		if (trimmed === keyword || trimmed.startsWith(`${keyword} `) || trimmed.startsWith(`${keyword}:`))
			return keyword;
	}
	return null;
}

function topLevelColon(code: string): number {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = 0; index < code.length; index++) {
		const character = code[index] as string;
		if (character === "(") parentheses++;
		else if (character === ")") parentheses--;
		else if (character === "[") brackets++;
		else if (character === "]") brackets--;
		else if (character === "{") braces++;
		else if (character === "}") braces--;
		else if (character === ":" && parentheses === 0 && brackets === 0 && braces === 0) return index;
	}
	return -1;
}

function matchArmCount(lines: SourceLine[], start: number, end: number): number {
	const matches: { indent: number; armIndent: number | null }[] = [];
	let count = 0;
	for (let index = start; index < end; index++) {
		const line = lines[index] as SourceLine;
		if (!meaningfulLine(line)) continue;
		const indent = indentOf(line.text);
		while (matches.length > 0 && indent <= (matches[matches.length - 1] as { indent: number }).indent)
			matches.pop();
		const current = matches[matches.length - 1];
		if (current !== undefined && indent > current.indent) {
			if (current.armIndent === null) current.armIndent = indent;
			if (indent === current.armIndent && topLevelColon(line.code) >= 0) count++;
		}
		if (controlHeader(line.code) === "match") matches.push({ indent, armIndent: null });
	}
	return count;
}

function meaningfulLine(line: SourceLine): boolean {
	return !isIgnorable(line);
}

function bodyMetrics(lines: SourceLine[], start: number, end: number): Pick<Metrics, "nesting" | "branches"> {
	const controls: number[] = [];
	let nesting = 0;
	let branches = matchArmCount(lines, start, end);
	for (let index = start; index < end; index++) {
		const line = lines[index] as SourceLine;
		if (!meaningfulLine(line)) continue;
		const indent = indentOf(line.text);
		while (controls.length > 0 && indent <= (controls[controls.length - 1] as number)) controls.pop();
		nesting = Math.max(nesting, controls.length);
		const header = controlHeader(line.code);
		if (header !== null) {
			if (header !== "match") branches++;
			controls.push(indent);
		}
		if (!/^\s*(?:if|elif|else|for|while|match)\b/.test(line.code)) {
			if (/\bif\b/.test(line.code) && /\belse\b/.test(line.code)) branches++;
			branches += (line.code.match(/\b(?:and|or)\b/g) ?? []).length;
		}
	}
	return { nesting, branches: branches + 1 };
}

function metricsForDeclaration(lines: SourceLine[], declaration: DeclarationFact): Metrics {
	const metrics: Metrics = {
		lines: declaration.range.end.line - declaration.range.start.line + 1,
	};
	if (declaration.kind !== "method") return metrics;
	const headerEnd = headerEndLine(lines, declaration);
	const end = bodyEndLine(lines, declaration);
	const lastBodyLine = Math.max(headerEnd, end - 1);
	metrics.lines = lastBodyLine - declaration.range.start.line + 1;
	metrics.parameters = functionParameterCount(lines, declaration);
	const bodyStart = headerEnd + 1;
	if (bodyStart < end && lines.slice(bodyStart, end).some(meaningfulLine)) {
		Object.assign(metrics, bodyMetrics(lines, bodyStart, end));
	}
	return metrics;
}

function addDeclarationMetrics(declarations: DeclarationFact[], text: string): DeclarationFact[] {
	const lines = readLines(text);
	return declarations.map((declaration) => ({ ...declaration, metrics: metricsForDeclaration(lines, declaration) }));
}

function extractGeneric(module: string, text: string, compose: ComposeSymbolId): DeclarationFact[] {
	const declarations: DeclarationFact[] = [];
	const coordinates = coordinatesOf(text);
	for (const line of readLines(text)) {
		const parsed = parseLineHead(line, true);
		if (parsed === null || parsed.name === null) continue;
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
