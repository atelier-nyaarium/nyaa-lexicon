import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	composeSymbolId,
	type Declaration,
	parseSymbolId,
	type TypeInfo,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import { extractDeclarationsCore, extractTypeAnnotationsCore, type TypeAnnotationFact } from "./extractCore.js";

//////// Types

type Range = Declaration["range"];

interface TypeFacts {
	module: string;
	declarations: Declaration[];
	annotations: TypeAnnotationFact[];
	inferred: Map<string, TypeInfo>;
}

interface TypeResolver {
	resolveType(module: string, name: string): Declaration | undefined;
	resolvePreloadType(module: string, expression: string): Declaration | undefined;
}

interface InferenceLine {
	text: string;
	code: string;
	indent: number;
	line: number;
}

interface AbstractValue {
	base: string;
	literal?: string;
	symbolId?: string;
}

interface KnownResult {
	status: "known";
	values: AbstractValue[];
}

interface UnknownResult {
	status: "unknown";
	reason: UnknownReason;
	detail: string;
}

type EvalResult = KnownResult | UnknownResult;

interface FlowResult {
	values: AbstractValue[];
	unknown?: UnknownResult;
	fallsThrough: boolean;
}

interface FunctionFact {
	declaration: Declaration;
	headerIndent: number;
	bodyStart: number;
	bodyEnd: number;
	inlineBody: string;
}

interface InferenceContext {
	module: string;
	resolver: TypeResolver;
	lines: InferenceLine[];
	declarations: Declaration[];
	annotations: TypeAnnotationFact[];
	moduleValues: Map<string, EvalResult>;
	functions: Map<string, FunctionFact>;
	functionAnswers: Map<string, EvalResult>;
	implicitReturns: Map<string, boolean>;
	activeFunctions: Set<string>;
	depth: number;
}

//////// Helpers

function positionInRange(range: Range, position: Range["start"]): boolean {
	if (position.line < range.start.line || position.line > range.end.line) return false;
	if (position.line === range.start.line && position.character < range.start.character) return false;
	if (position.line === range.end.line && position.character > range.end.character) return false;
	return true;
}

function absoluteModule(workspaceRoot: string, module: string): string | null {
	const absolute = path.resolve(workspaceRoot, ...module.split("/"));
	const relative = path.relative(workspaceRoot, absolute);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return absolute;
}

function unknownType(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

function namedTypeName(display: string): string | undefined {
	return /^([\p{L}_][\p{L}\p{M}\p{N}_]*)$/u.exec(display.trim())?.[1];
}

function declaredType(module: string, annotation: TypeAnnotationFact, resolver: TypeResolver): TypeInfo {
	const name = namedTypeName(annotation.display);
	const declaration = name === undefined ? undefined : resolver.resolveType(module, name);
	return {
		status: "known",
		display: annotation.display,
		provenance: "declared",
		...(declaration === undefined ? {} : { symbolId: declaration.symbolId }),
	};
}

function unknownResult(reason: UnknownReason, detail: string): UnknownResult {
	return { status: "unknown", reason, detail };
}

function known(...values: AbstractValue[]): KnownResult {
	return { status: "known", values: uniqueValues(values) };
}

function value(base: string, literal?: string, symbolId?: string): AbstractValue {
	return {
		base,
		...(literal === undefined ? {} : { literal }),
		...(symbolId === undefined ? {} : { symbolId }),
	};
}

function uniqueValues(values: AbstractValue[]): AbstractValue[] {
	const seen = new Set<string>();
	const unique: AbstractValue[] = [];
	for (const item of values) {
		const key = `${item.base}\u0000${item.literal ?? ""}\u0000${item.symbolId ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(item);
	}
	return unique;
}

function mergeResults(first: EvalResult, second: EvalResult): EvalResult {
	if (first.status === "unknown") return first;
	if (second.status === "unknown") return second;
	return known(...first.values, ...second.values);
}

function mergeFlow(first: FlowResult, second: FlowResult): FlowResult {
	return {
		values: uniqueValues([...first.values, ...second.values]),
		...(first.unknown === undefined ? {} : { unknown: first.unknown }),
		fallsThrough: first.fallsThrough || second.fallsThrough,
	};
}

function lineIndent(text: string): number {
	let width = 0;
	for (const character of text) {
		if (character === " ") width++;
		else if (character === "\t") width += 4;
		else break;
	}
	return width;
}

function tripleAt(text: string, index: number, quote: "'" | '"'): boolean {
	return text[index] === quote && text[index + 1] === quote && text[index + 2] === quote;
}

function structuralLine(text: string): string {
	let code = "";
	let quote: "'" | '"' | null = null;
	let triple = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index] as string;
		if (quote !== null) {
			if (triple && tripleAt(text, index, quote)) {
				code += "   ";
				index += 2;
				quote = null;
				triple = false;
				continue;
			}
			code += " ";
			if (!triple && !escaped && character === quote) quote = null;
			escaped = !triple && !escaped && character === "\\";
			if (character !== "\\") escaped = false;
			continue;
		}
		if (character === "#") {
			code += " ".repeat(text.length - index);
			break;
		}
		if (character === "'" || character === '"') {
			if (tripleAt(text, index, character)) {
				code += "   ";
				index += 2;
				quote = character;
				triple = true;
			} else {
				code += " ";
				quote = character;
				triple = false;
			}
			continue;
		}
		code += character;
	}
	return code;
}

function inferenceLines(text: string): InferenceLine[] {
	return text.split("\n").map((line, index) => ({
		text: line,
		code: structuralLine(line),
		indent: lineIndent(line),
		line: index,
	}));
}

function meaningful(line: InferenceLine): boolean {
	return line.code.trim() !== "";
}

function nextMeaningful(lines: InferenceLine[], start: number, end: number): number {
	for (let index = start; index < end; index++) {
		if (meaningful(lines[index] as InferenceLine)) return index;
	}
	return end;
}

function blockEnd(lines: InferenceLine[], start: number, parentIndent: number, end: number): number {
	for (let index = start; index < end; index++) {
		const line = lines[index] as InferenceLine;
		if (meaningful(line) && line.indent <= parentIndent) return index;
	}
	return end;
}

function keywordLine(code: string, keyword: string): boolean {
	const trimmed = code.trimStart();
	return trimmed === keyword || trimmed.startsWith(`${keyword} `) || trimmed.startsWith(`${keyword}:`);
}

function colonIndex(code: string): number {
	for (let index = code.length - 1; index >= 0; index--) {
		if (code[index] === ":") return index;
	}
	return -1;
}

function stripExpressionComment(text: string): string {
	let quote: "'" | '"' | null = null;
	let triple = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index] as string;
		if (quote !== null) {
			if (triple && tripleAt(text, index, quote)) {
				index += 2;
				quote = null;
				triple = false;
				continue;
			}
			if (!triple && !escaped && character === quote) quote = null;
			escaped = !triple && !escaped && character === "\\";
			if (character !== "\\") escaped = false;
			continue;
		}
		if (character === "#") return text.slice(0, index);
		if (character === "'" || character === '"') {
			quote = character;
			triple = tripleAt(text, index, character);
			if (triple) index += 2;
		}
	}
	return text;
}

function outerParentheses(text: string): string {
	let result = text.trim();
	while (result.startsWith("(") && matchingClose(result, 0) === result.length - 1) {
		result = result.slice(1, -1).trim();
	}
	return result;
}

function matchingClose(text: string, start: number): number {
	let depth = 0;
	let quote: "'" | '"' | null = null;
	let triple = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const character = text[index] as string;
		if (quote !== null) {
			if (triple && tripleAt(text, index, quote)) {
				index += 2;
				quote = null;
				triple = false;
				escaped = false;
			} else if (!triple && !escaped && character === quote) {
				quote = null;
				escaped = false;
			} else if (!triple) {
				escaped = character === "\\" && !escaped;
				if (character !== "\\") escaped = false;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			triple = tripleAt(text, index, character);
			if (triple) index += 2;
			escaped = false;
			continue;
		}
		if (character === "(") depth++;
		if (character === ")") {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function findTopLevelWord(text: string, word: string, start = 0): number {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	let quote: "'" | '"' | null = null;
	let triple = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const character = text[index] as string;
		if (quote !== null) {
			if (triple && tripleAt(text, index, quote)) {
				index += 2;
				quote = null;
				triple = false;
				escaped = false;
			} else if (!triple && !escaped && character === quote) {
				quote = null;
				escaped = false;
			} else if (!triple) {
				escaped = character === "\\" && !escaped;
				if (character !== "\\") escaped = false;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			triple = tripleAt(text, index, character);
			if (triple) index += 2;
			escaped = false;
			continue;
		}
		if (character === "(") parentheses++;
		else if (character === ")") parentheses--;
		else if (character === "[") brackets++;
		else if (character === "]") brackets--;
		else if (character === "{") braces++;
		else if (character === "}") braces--;
		if (parentheses !== 0 || brackets !== 0 || braces !== 0) continue;
		if (!text.startsWith(word, index)) continue;
		const before = index === 0 ? " " : (text[index - 1] as string);
		const after = text[index + word.length] ?? " ";
		if (!/\w/.test(before) && !/\w/.test(after)) return index;
	}
	return -1;
}

function findTopLevelOperator(text: string, operators: string[]): { index: number; operator: string } | null {
	return findTopLevelOperatorForward(text, operators);
}

function findTopLevelOperatorForward(text: string, operators: string[]): { index: number; operator: string } | null {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	let quote: "'" | '"' | null = null;
	let triple = false;
	let escaped = false;
	let found: { index: number; operator: string } | null = null;
	for (let index = 0; index < text.length; index++) {
		const character = text[index] as string;
		if (quote !== null) {
			if (triple && tripleAt(text, index, quote)) {
				index += 2;
				quote = null;
				triple = false;
				escaped = false;
			} else if (!triple && !escaped && character === quote) {
				quote = null;
				escaped = false;
			} else if (!triple) {
				escaped = character === "\\" && !escaped;
				if (character !== "\\") escaped = false;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			triple = tripleAt(text, index, character);
			if (triple) index += 2;
			escaped = false;
			continue;
		}
		if (character === "(") parentheses++;
		else if (character === ")") parentheses--;
		else if (character === "[") brackets++;
		else if (character === "]") brackets--;
		else if (character === "{") braces++;
		else if (character === "}") braces--;
		if (parentheses !== 0 || brackets !== 0 || braces !== 0) continue;
		for (const operator of operators) {
			if (!text.startsWith(operator, index)) continue;
			if ((operator === "+" || operator === "-") && text.slice(0, index).trim() === "") continue;
			found = { index, operator };
		}
	}
	return found;
}

function renderValues(values: AbstractValue[], includeLiterals: boolean): string {
	const unique = uniqueValues(values);
	const groups = new Map<string, AbstractValue[]>();
	for (const item of unique) groups.set(item.base, [...(groups.get(item.base) ?? []), item]);
	const parts: string[] = [];
	for (const [base, group] of groups) {
		const literals = group.map((item) => item.literal).filter((item): item is string => item !== undefined);
		if (includeLiterals && literals.length === group.length && literals.length > 0 && base !== "null") {
			parts.push(`${base} (${literals.join(" | ")})`);
		} else {
			parts.push(base);
		}
	}
	return parts.join(" | ");
}

function singleSymbolId(values: AbstractValue[]): string | undefined {
	if (values.length === 0 || values.some((item) => item.symbolId === undefined)) return undefined;
	const ids = new Set(values.map((item) => item.symbolId as string));
	return ids.size === 1 ? [...ids][0] : undefined;
}

function annotationValue(display: string, module: string, resolver: TypeResolver): AbstractValue {
	const normalized = display.trim();
	const name = namedTypeName(normalized);
	const declaration = name === undefined ? undefined : resolver.resolveType(module, name);
	return value(normalized, undefined, declaration?.symbolId);
}

function stringLiteral(text: string): AbstractValue | null {
	const quote = text[0] as "'" | '"' | undefined;
	if (quote !== "'" && quote !== '"') return null;
	const triple = tripleAt(text, 0, quote);
	const closeSize = triple ? 3 : 1;
	if (!text.endsWith(quote.repeat(closeSize))) return null;
	if (text.includes("$") && !text.includes("$$")) return value("String");
	return value("String", text);
}

function primitiveLiteral(text: string): AbstractValue | null {
	if (text === "true" || text === "false") return value("bool", text);
	if (text === "null") return value("null", "null");
	const string = stringLiteral(text);
	if (string !== null) return string;
	if (/^[+-]?(?:0x[0-9A-Fa-f]+|0b[01]+|\d+)$/.test(text)) return value("int", text);
	if (/^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+[eE][+-]?\d+|\d+\.\d*[eE][+-]?\d+)$/.test(text)) return value("float", text);
	return null;
}

function simpleTypeFromExpression(text: string): AbstractValue | null {
	if (text.startsWith("[") && text.endsWith("]")) return value("Array");
	if (text.startsWith("{") && text.endsWith("}")) return value("Dictionary");
	return primitiveLiteral(text);
}

function functionHeaderInlineBody(line: InferenceLine): string {
	const index = colonIndex(line.code);
	return index < 0 ? "" : line.text.slice(index + 1).trim();
}

function inlineFlow(text: string, context: InferenceContext, environment: Map<string, EvalResult>): FlowResult {
	const structural = structuralLine(text).trim();
	if (structural === "") return { values: [], fallsThrough: true };
	const returnMatch = /^return\b/.exec(structural);
	if (returnMatch !== null) {
		const leading = text.length - text.trimStart().length;
		const expression = stripExpressionComment(text.slice(leading + returnMatch[0].length)).trim();
		const result =
			expression === "" ? known(value("null", "null")) : inferExpression(expression, context, environment);
		if (result.status === "unknown") return { values: [], unknown: result, fallsThrough: false };
		return { values: result.values, fallsThrough: false };
	}
	return { values: [], fallsThrough: true };
}

function branchBody(
	lines: InferenceLine[],
	lineIndex: number,
	parentIndent: number,
	end: number,
	context: InferenceContext,
	environment: Map<string, EvalResult>,
): { flow: FlowResult; next: number } {
	const line = lines[lineIndex] as InferenceLine;
	const colon = colonIndex(line.code);
	const inline = colon < 0 ? "" : line.text.slice(colon + 1).trim();
	const child = nextMeaningful(lines, lineIndex + 1, end);
	if (child >= end || (lines[child] as InferenceLine).indent <= parentIndent) {
		return { flow: inlineFlow(inline, context, environment), next: lineIndex + 1 };
	}
	const childIndent = (lines[child] as InferenceLine).indent;
	const childEnd = blockEnd(lines, child, parentIndent, end);
	const flow = analyzeBlock(context, child, childEnd, childIndent, new Map(environment));
	return { flow: inline === "" ? flow : mergeFlow(inlineFlow(inline, context, environment), flow), next: childEnd };
}

function analyzeIfGroup(
	context: InferenceContext,
	start: number,
	end: number,
	environment: Map<string, EvalResult>,
): { flow: FlowResult; next: number } {
	const first = context.lines[start] as InferenceLine;
	const indent = first.indent;
	let cursor = start;
	let hasElse = false;
	let combined: FlowResult = { values: [], fallsThrough: false };
	while (cursor < end) {
		const line = context.lines[cursor] as InferenceLine;
		const trimmed = line.code.trim();
		if (cursor !== start && line.indent !== indent) break;
		if (cursor !== start && !trimmed.startsWith("elif") && !trimmed.startsWith("else")) break;
		if (trimmed.startsWith("else")) hasElse = true;
		const branch = branchBody(context.lines, cursor, indent, end, context, environment);
		combined = mergeFlow(combined, branch.flow);
		const next = nextMeaningful(context.lines, branch.next, end);
		if (next >= end)
			return { flow: { ...combined, fallsThrough: combined.fallsThrough || !hasElse }, next: branch.next };
		const nextLine = context.lines[next] as InferenceLine;
		if (
			nextLine.indent !== indent ||
			(!nextLine.code.trim().startsWith("elif") && !nextLine.code.trim().startsWith("else"))
		) {
			return { flow: { ...combined, fallsThrough: combined.fallsThrough || !hasElse }, next: branch.next };
		}
		cursor = next;
	}
	return { flow: { ...combined, fallsThrough: combined.fallsThrough || !hasElse }, next: cursor };
}

function analyzeMatch(
	context: InferenceContext,
	start: number,
	end: number,
	environment: Map<string, EvalResult>,
): { flow: FlowResult; next: number } {
	const line = context.lines[start] as InferenceLine;
	const firstArm = nextMeaningful(context.lines, start + 1, end);
	if (firstArm >= end || (context.lines[firstArm] as InferenceLine).indent <= line.indent) {
		return { flow: { values: [], fallsThrough: true }, next: start + 1 };
	}
	const armIndent = (context.lines[firstArm] as InferenceLine).indent;
	let cursor = firstArm;
	let wildcard = false;
	let combined: FlowResult = { values: [], fallsThrough: false };
	while (cursor < end) {
		const arm = context.lines[cursor] as InferenceLine;
		if (!meaningful(arm) || arm.indent !== armIndent) break;
		const armColon = colonIndex(arm.code);
		const pattern = armColon < 0 ? arm.code.trim() : arm.code.slice(0, armColon).trim();
		if (pattern === "_" || pattern.startsWith("_ when")) wildcard = pattern === "_";
		const branch = branchBody(context.lines, cursor, armIndent, end, context, environment);
		combined = mergeFlow(combined, branch.flow);
		const next = nextMeaningful(context.lines, branch.next, end);
		if (next >= end || (context.lines[next] as InferenceLine).indent !== armIndent) {
			return { flow: { ...combined, fallsThrough: combined.fallsThrough || !wildcard }, next: branch.next };
		}
		cursor = next;
	}
	return { flow: { ...combined, fallsThrough: combined.fallsThrough || !wildcard }, next: cursor };
}

function analyzeStatement(
	context: InferenceContext,
	index: number,
	end: number,
	environment: Map<string, EvalResult>,
): { flow: FlowResult; next: number } {
	const line = context.lines[index] as InferenceLine;
	if (keywordLine(line.code, "if")) return analyzeIfGroup(context, index, end, environment);
	if (keywordLine(line.code, "match")) return analyzeMatch(context, index, end, environment);
	if (keywordLine(line.code, "for") || keywordLine(line.code, "while")) {
		const child = nextMeaningful(context.lines, index + 1, end);
		if (child < end && (context.lines[child] as InferenceLine).indent > line.indent) {
			const childEnd = blockEnd(context.lines, child, line.indent, end);
			const body = analyzeBlock(
				context,
				child,
				childEnd,
				(context.lines[child] as InferenceLine).indent,
				new Map(environment),
			);
			return { flow: { ...body, fallsThrough: true }, next: childEnd };
		}
		return { flow: { values: [], fallsThrough: true }, next: index + 1 };
	}
	const inline = inlineFlow(line.text, context, environment);
	return { flow: inline, next: index + 1 };
}

function analyzeBlock(
	context: InferenceContext,
	start: number,
	end: number,
	indent: number,
	environment: Map<string, EvalResult>,
): FlowResult {
	let cursor = nextMeaningful(context.lines, start, end);
	let combined: FlowResult = { values: [], fallsThrough: true };
	while (cursor < end) {
		const line = context.lines[cursor] as InferenceLine;
		if (line.indent < indent) break;
		if (line.indent > indent) {
			cursor++;
			continue;
		}
		const statement = analyzeStatement(context, cursor, end, environment);
		combined = {
			values: uniqueValues([...combined.values, ...statement.flow.values]),
			...(combined.unknown === undefined
				? statement.flow.unknown === undefined
					? {}
					: { unknown: statement.flow.unknown }
				: { unknown: combined.unknown }),
			fallsThrough: statement.flow.fallsThrough,
		};
		cursor = nextMeaningful(context.lines, statement.next, end);
		if (!combined.fallsThrough) break;
	}
	return combined;
}

function functionFacts(lines: InferenceLine[], declarations: Declaration[]): Map<string, FunctionFact> {
	const facts = new Map<string, FunctionFact>();
	for (const declaration of declarations) {
		if (declaration.kind !== "method") continue;
		const header = lines[declaration.range.start.line] as InferenceLine | undefined;
		if (header === undefined) continue;
		const bodyStart = declaration.range.end.line + 1;
		facts.set(declaration.name, {
			declaration,
			headerIndent: header.indent,
			bodyStart,
			bodyEnd: blockEnd(lines, bodyStart, header.indent, lines.length),
			inlineBody: functionHeaderInlineBody(lines[declaration.range.end.line] as InferenceLine),
		});
	}
	return facts;
}

function declarationInitializer(declaration: Declaration, lines: InferenceLine[]): string | null {
	const line = lines[declaration.selectionRange.start.line] as InferenceLine | undefined;
	if (line === undefined) return null;
	const start = declaration.selectionRange.end.character;
	for (let index = start; index < line.code.length; index++) {
		if (line.code[index] !== "=") continue;
		if (line.code[index - 1] === "=" || line.code[index + 1] === "=") continue;
		const expressionEnd = line.code.indexOf(";", index + 1);
		const end = expressionEnd < 0 ? line.text.length : expressionEnd;
		return stripExpressionComment(line.text.slice(index + 1, end)).trim();
	}
	return null;
}

function annotationForDeclaration(
	declaration: Declaration,
	annotations: TypeAnnotationFact[],
): TypeAnnotationFact | undefined {
	return annotations.find((annotation) => annotation.symbolId === declaration.symbolId);
}

function parameterEnvironment(
	functionFact: FunctionFact,
	annotations: TypeAnnotationFact[],
	lines: InferenceLine[],
	module: string,
	resolver: TypeResolver,
): Map<string, EvalResult> {
	const environment = new Map<string, EvalResult>();
	for (const annotation of annotations) {
		const isReturnAnnotation = annotation.symbolId === functionFact.declaration.symbolId;
		const isParameterAnnotation =
			annotation.symbolId !== functionFact.declaration.symbolId &&
			annotation.targetRange.start.line >= functionFact.declaration.range.start.line &&
			annotation.targetRange.start.line <= functionFact.declaration.range.end.line;
		if (!isReturnAnnotation && !isParameterAnnotation) continue;
		if (isReturnAnnotation) continue;
		const line = lines[annotation.targetRange.start.line] as InferenceLine | undefined;
		if (line === undefined) continue;
		const name = line.text.slice(annotation.targetRange.start.character, annotation.targetRange.end.character);
		if (name !== "") environment.set(name, known(annotationValue(annotation.display, module, resolver)));
	}
	return environment;
}

function inferExpression(
	expression: string,
	context: InferenceContext,
	environment: Map<string, EvalResult>,
): EvalResult {
	const text = outerParentheses(stripExpressionComment(expression).trim());
	if (text === "") return known(value("null", "null"));
	if (text.startsWith("await ") || text.startsWith("await(")) {
		return unknownResult("NotImplemented", "await changes the returned value and is not inferred");
	}
	const conditional = findTopLevelWord(text, "if");
	if (conditional > 0) {
		const otherwise = findTopLevelWord(text, "else", conditional + 2);
		if (otherwise > conditional) {
			return mergeResults(
				inferExpression(text.slice(0, conditional), context, environment),
				inferExpression(text.slice(otherwise + 4), context, environment),
			);
		}
	}
	const literal = simpleTypeFromExpression(text);
	if (literal !== null) return known(literal);
	if (text.startsWith("not ")) return known(value("bool"));
	const comparison = findTopLevelOperator(text, ["==", "!=", "<=", ">=", "<", ">"]);
	if (comparison !== null || findTopLevelWord(text, "in") >= 0 || findTopLevelWord(text, "is") >= 0)
		return known(value("bool"));
	const arithmetic = findTopLevelOperator(text, ["+", "-", "*", "/", "%"]);
	if (arithmetic !== null) {
		const left = inferExpression(text.slice(0, arithmetic.index), context, environment);
		const right = inferExpression(text.slice(arithmetic.index + arithmetic.operator.length), context, environment);
		if (left.status === "unknown") return left;
		if (right.status === "unknown") return right;
		if (left.values.every((item) => item.base === "String") && right.values.every((item) => item.base === "String"))
			return known(value("String"));
		if (
			left.values.every((item) => item.base === "int") &&
			right.values.every((item) => item.base === "int") &&
			arithmetic.operator !== "/"
		)
			return known(value("int"));
		if (
			left.values.every((item) => item.base === "int" || item.base === "float") &&
			right.values.every((item) => item.base === "int" || item.base === "float")
		)
			return known(
				value(
					arithmetic.operator === "/" ||
						left.values.some((item) => item.base === "float") ||
						right.values.some((item) => item.base === "float")
						? "float"
						: "int",
				),
			);
		return unknownResult("NotImplemented", "the arithmetic operands do not have a supported static type");
	}
	const asIndex = findTopLevelWord(text, "as");
	if (asIndex > 0) return known(annotationValue(text.slice(asIndex + 2), context.module, context.resolver));
	const identifier = /^([\p{L}_][\p{L}\p{M}\p{N}_]*)$/u.exec(text)?.[1];
	if (identifier !== undefined) {
		return (
			environment.get(identifier) ??
			unknownResult("DynamicallyTyped", `the value of ${identifier} is not statically known`)
		);
	}
	const constructed = /^([\p{L}_][\p{L}\p{M}\p{N}_]*)\s*\.\s*new\s*\(/u.exec(text);
	if (constructed !== null) {
		const name = constructed[1] as string;
		const declaration = context.resolver.resolveType(context.module, name);
		return known(value(declaration?.name ?? name, undefined, declaration?.symbolId));
	}
	const preloaded = context.resolver.resolvePreloadType(context.module, text);
	if (preloaded !== undefined) return known(value(preloaded.name, undefined, preloaded.symbolId));
	const call = /^([\p{L}_][\p{L}\p{M}\p{N}_]*)\s*\(/u.exec(text);
	if (call !== null) {
		const functionFact = context.functions.get(call[1] as string);
		if (functionFact !== undefined) return inferFunction(functionFact, context);
		if (call[1] === "preload")
			return unknownResult("ExternalDependency", "the resource type is outside the indexed type database");
		if (call[1] === "load") return unknownResult("RuntimeConstructed", "load produces a runtime resource value");
		return unknownResult("NotImplemented", "the called function has no available type summary");
	}
	return unknownResult("NotImplemented", "the expression is outside the supported inference subset");
}

function localEnvironment(functionFact: FunctionFact, context: InferenceContext): Map<string, EvalResult> {
	const environment = new Map(context.moduleValues);
	for (const [name, result] of parameterEnvironment(
		functionFact,
		context.annotations,
		context.lines,
		context.module,
		context.resolver,
	))
		environment.set(name, result);
	for (const declaration of context.declarations) {
		if (declaration.containerId !== functionFact.declaration.symbolId) continue;
		if (declaration.languageKind === "parameter") continue;
		if (declaration.kind !== "variable" && declaration.kind !== "constant" && declaration.kind !== "property")
			continue;
		const annotation = annotationForDeclaration(declaration, context.annotations);
		const result =
			annotation === undefined
				? (() => {
						const initializer = declarationInitializer(declaration, context.lines);
						return initializer === null
							? unknownResult("DynamicallyTyped", "the local has no declared type or initializer")
							: inferExpression(initializer, context, environment);
					})()
				: known(annotationValue(annotation.display, context.module, context.resolver));
		environment.set(declaration.name, result);
	}
	return environment;
}

function inferFunction(functionFact: FunctionFact, context: InferenceContext): EvalResult {
	const symbolId = functionFact.declaration.symbolId;
	const cached = context.functionAnswers.get(symbolId);
	if (cached !== undefined) return cached;
	if (context.activeFunctions.has(symbolId) || context.depth >= 32) {
		return unknownResult("RecursionLimit", "function inference reached a recursive call or depth limit");
	}
	context.activeFunctions.add(symbolId);
	context.depth++;
	const environment = localEnvironment(functionFact, context);
	let flow: FlowResult;
	if (functionFact.inlineBody !== "") {
		flow = inlineFlow(functionFact.inlineBody, context, environment);
		if (flow.fallsThrough && functionFact.bodyStart < functionFact.bodyEnd) {
			flow = mergeFlow(
				flow,
				analyzeBlock(
					context,
					functionFact.bodyStart,
					functionFact.bodyEnd,
					(context.lines[functionFact.bodyStart] as InferenceLine).indent,
					environment,
				),
			);
		}
	} else if (functionFact.bodyStart < functionFact.bodyEnd) {
		const bodyLine = context.lines[functionFact.bodyStart] as InferenceLine;
		flow = analyzeBlock(context, functionFact.bodyStart, functionFact.bodyEnd, bodyLine.indent, environment);
	} else {
		flow = { values: [], fallsThrough: true };
	}
	context.implicitReturns.set(symbolId, flow.fallsThrough);
	if (flow.fallsThrough) flow.values.push(value("null", "null"));
	const result: EvalResult = flow.unknown === undefined ? known(...flow.values) : flow.unknown;
	context.depth--;
	context.activeFunctions.delete(symbolId);
	context.functionAnswers.set(symbolId, result);
	return result;
}

function inferFile(
	module: string,
	declarations: Declaration[],
	annotations: TypeAnnotationFact[],
	text: string,
	resolver: TypeResolver,
): Map<string, TypeInfo> {
	const lines = inferenceLines(text);
	const context: InferenceContext = {
		module,
		resolver,
		lines,
		declarations,
		annotations,
		moduleValues: new Map(),
		functions: functionFacts(lines, declarations),
		functionAnswers: new Map(),
		implicitReturns: new Map(),
		activeFunctions: new Set(),
		depth: 0,
	};
	for (const declaration of declarations) {
		if (declaration.containerId !== undefined) continue;
		if (declaration.kind !== "property" && declaration.kind !== "variable" && declaration.kind !== "constant")
			continue;
		const annotation = annotationForDeclaration(declaration, annotations);
		const result =
			annotation === undefined
				? (() => {
						const initializer = declarationInitializer(declaration, lines);
						return initializer === null
							? unknownResult("DynamicallyTyped", "the declaration has no declared type or initializer")
							: inferExpression(initializer, context, context.moduleValues);
					})()
				: known(annotationValue(annotation.display, context.module, context.resolver));
		context.moduleValues.set(declaration.name, result);
	}
	for (const functionFact of context.functions.values()) {
		inferFunction(functionFact, context);
	}
	const inferred = new Map<string, TypeInfo>();
	for (const declaration of declarations) {
		if (annotationForDeclaration(declaration, annotations) !== undefined) continue;
		if (declaration.kind === "method") {
			const answer = context.functionAnswers.get(declaration.symbolId);
			if (answer?.status === "known") {
				const explicitReturns = countReturns(
					context.functions.get(declaration.name) as FunctionFact,
					context.lines,
				);
				const basis = `${explicitReturns} return statement${explicitReturns === 1 ? "" : "s"}${context.implicitReturns.get(declaration.symbolId) === true ? (explicitReturns === 0 ? " with implicit null" : " and implicit null") : ""}`;
				inferred.set(declaration.symbolId, {
					status: "inferred",
					display: renderValues(answer.values, true),
					basis,
					...(singleSymbolId(answer.values) === undefined ? {} : { symbolId: singleSymbolId(answer.values) }),
				});
			} else if (answer?.status === "unknown") inferred.set(declaration.symbolId, answer);
			continue;
		}
		if (declaration.containerId !== undefined) {
			const environment = localEnvironment(
				{
					declaration: declarations.find(
						(candidate) => candidate.symbolId === declaration.containerId,
					) as Declaration,
					headerIndent: 0,
					bodyStart: 0,
					bodyEnd: 0,
					inlineBody: "",
				},
				context,
			);
			const result = environment.get(declaration.name);
			if (result?.status === "known")
				inferred.set(declaration.symbolId, {
					status: "inferred",
					display: renderValues(result.values, declaration.kind === "constant"),
					basis: "initializer",
					...(singleSymbolId(result.values) === undefined ? {} : { symbolId: singleSymbolId(result.values) }),
				});
			else if (result?.status === "unknown") inferred.set(declaration.symbolId, result);
			continue;
		}
		const result = context.moduleValues.get(declaration.name);
		if (result?.status === "known")
			inferred.set(declaration.symbolId, {
				status: "inferred",
				display: renderValues(result.values, declaration.kind === "constant"),
				basis: "initializer",
				...(singleSymbolId(result.values) === undefined ? {} : { symbolId: singleSymbolId(result.values) }),
			});
		else if (result?.status === "unknown") inferred.set(declaration.symbolId, result);
	}
	return inferred;
}

function countReturns(functionFact: FunctionFact, lines: InferenceLine[]): number {
	let count = 0;
	for (let index = functionFact.bodyStart; index < functionFact.bodyEnd; index++) {
		count += (lines[index] as InferenceLine).code.match(/\breturn\b/g)?.length ?? 0;
	}
	count += structuralLine(functionFact.inlineBody).match(/\breturn\b/g)?.length ?? 0;
	return count;
}

//////// Index

export class GDScriptTypeIndex {
	private readonly factsByModule = new Map<string, TypeFacts>();

	constructor(
		private readonly workspaceRoot: string,
		private readonly resolver: TypeResolver,
	) {}

	registerFile(module: string, text: string, declarations: Declaration[]): void {
		const annotations = extractTypeAnnotationsCore(module, text, composeSymbolId);
		this.factsByModule.set(module, {
			module,
			declarations,
			annotations,
			inferred: inferFile(module, declarations, annotations, text, this.resolver),
		});
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) return this.typeOfSymbol(params.symbolId);
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknownType("NotIndexed", "module is not indexed");

		const position = params.range.start;
		const annotation = facts.annotations.find(
			(candidate) =>
				positionInRange(candidate.targetRange, position) || positionInRange(candidate.typeRange, position),
		);
		if (annotation !== undefined) return declaredType(facts.module, annotation, this.resolver);

		const declaration = facts.declarations.find((candidate) => positionInRange(candidate.selectionRange, position));
		if (declaration !== undefined) return this.typeOfDeclaration(facts, declaration);
		return unknownType("NotIndexed", "no indexed declaration or annotation matched the requested range");
	}

	private typeOfSymbol(symbolId: string): TypeInfo {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== "gdscript") {
			return unknownType("ParseError", "the symbol id is not a GDScript workspace id");
		}
		const facts = this.factsForModule(parsed.module);
		if (facts === null) return unknownType("NotIndexed", "module is not indexed");
		const declaration = facts.declarations.find((candidate) => candidate.symbolId === symbolId);
		if (declaration === undefined) return unknownType("ParseError", "the symbol id has no declaration");
		return this.typeOfDeclaration(facts, declaration);
	}

	private typeOfDeclaration(facts: TypeFacts, declaration: Declaration): TypeInfo {
		const annotation = facts.annotations.find((candidate) => candidate.symbolId === declaration.symbolId);
		if (annotation !== undefined) return declaredType(facts.module, annotation, this.resolver);
		return (
			facts.inferred.get(declaration.symbolId) ??
			unknownType("NotImplemented", "GDScript inference has no answer for this declaration")
		);
	}

	private factsForModule(module: string): TypeFacts | null {
		const cached = this.factsByModule.get(module);
		if (cached !== undefined) return cached;
		const absolute = absoluteModule(this.workspaceRoot, module);
		if (absolute === null || !existsSync(absolute)) return null;
		try {
			const text = readFileSync(absolute, "utf8");
			const declarations = extractDeclarationsCore(module, text, composeSymbolId) as Declaration[];
			this.registerFile(module, text, declarations);
			return this.factsByModule.get(module) ?? null;
		} catch {
			return null;
		}
	}
}
