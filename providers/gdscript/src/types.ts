import {
	comparePositions,
	coordinatesOf,
	type Declaration,
	defined,
	parseSymbolId,
	type TextCoordinates,
	type TypeInfo,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import {
	blockColon,
	type Expression,
	expressionEnd,
	type LogicalLine,
	logicalLines,
	parseExpression,
	statements,
	type TokenSpan,
} from "./expression.js";
import type { TypeAnnotationFact } from "./extractCore.js";
import type { GDScriptStore, GDScriptValue } from "./module.js";
import type { ReferenceToken } from "./parse-model.js";
import { scanSource } from "./source-scan.js";
import { initializerStart, matchingReferenceToken, nextReferenceToken, referenceTokens } from "./tokens.js";

//////// Types

type Range = Declaration["range"];

interface TypeResolver {
	resolveType(module: string, name: string): Declaration | undefined;
	resolvePreloadType(module: string, resource: string): Declaration | undefined;
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
	/** Physical lines of the header. */
	headerLines: { first: number; last: number };
	/** Tokens after the header colon. */
	inline: TokenSpan;
	/** Logical lines, end exclusive. */
	bodyStart: number;
	bodyEnd: number;
}

interface InferenceContext {
	module: string;
	resolver: TypeResolver;
	coordinates: TextCoordinates;
	tokens: ReferenceToken[];
	lines: LogicalLine[];
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
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

function unknownType(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

function declaredType(module: string, annotation: TypeAnnotationFact, resolver: TypeResolver): TypeInfo {
	const name = annotation.typeName;
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
		...defined({ literal, symbolId }),
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
		...defined({ unknown: first.unknown ?? second.unknown }),
		fallsThrough: first.fallsThrough || second.fallsThrough,
	};
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

function annotationValue(
	type: { display: string; typeName?: string | undefined },
	module: string,
	resolver: TypeResolver,
): AbstractValue {
	const name = type.typeName;
	const declaration = name === undefined ? undefined : resolver.resolveType(module, name);
	return value(type.display, undefined, declaration?.symbolId);
}

//////// Literals

const STRING_TYPES = { "": "String", r: "String", "&": "StringName", "^": "NodePath" } as const;

function stringValue(token: ReferenceToken): AbstractValue {
	const base = STRING_TYPES[token.string?.prefix ?? ""];
	if (token.value.includes("$") && !token.value.includes("$$")) return value(base);
	return value(base, token.value);
}

/** A number token, its sign folded in. */
function numberValue(text: string): AbstractValue {
	const digits = text.startsWith("+") || text.startsWith("-") ? text.slice(1) : text;
	const base = digits.slice(0, 2).toLowerCase();
	const float = base !== "0x" && base !== "0b" && (digits.includes(".") || digits.toLowerCase().includes("e"));
	return value(float ? "float" : "int", text);
}

//////// Expressions

function arithmetic(operator: string, left: EvalResult, right: EvalResult): EvalResult {
	if (left.status === "unknown") return left;
	if (right.status === "unknown") return right;
	const all = (result: KnownResult, bases: string[]) => result.values.every((item) => bases.includes(item.base));
	if (all(left, ["String"]) && all(right, ["String"])) return known(value("String"));
	if (operator === "+" && all(left, ["Array"]) && all(right, ["Array"])) return known(value("Array"));
	if (all(left, ["int"]) && all(right, ["int"]) && operator !== "/") return known(value("int"));
	if (all(left, ["int", "float"]) && all(right, ["int", "float"])) {
		const float =
			operator === "/" ||
			left.values.some((item) => item.base === "float") ||
			right.values.some((item) => item.base === "float");
		return known(value(float ? "float" : "int"));
	}
	return unknownResult("NotImplemented", "the arithmetic operands do not have a supported static type");
}

const BOOLEAN_OPERATORS = new Set(["or", "||", "and", "&&", "in", "==", "!=", "<", ">", "<=", ">="]);
const ARITHMETIC_OPERATORS = new Set(["+", "-", "*", "/", "%"]);

function outsideSubset(): UnknownResult {
	return unknownResult("NotImplemented", "the expression is outside the supported inference subset");
}

function evaluateCall(expression: Extract<Expression, { kind: "call" }>, context: InferenceContext): EvalResult {
	const callee = expression.callee;
	if (callee.kind === "member" && callee.name === "new" && callee.target.kind === "name") {
		const name = callee.target.name;
		const declaration = context.resolver.resolveType(context.module, name);
		return known(value(declaration?.name ?? name, undefined, declaration?.symbolId));
	}
	if (callee.kind !== "name") return outsideSubset();
	const argument = expression.arguments.length === 1 ? (expression.arguments[0] as TokenSpan) : undefined;
	const path = argument === undefined ? undefined : literalPath(context.tokens, argument);
	if (callee.name === "preload" && path !== undefined) {
		const preloaded = context.resolver.resolvePreloadType(context.module, path);
		if (preloaded !== undefined) return known(value(preloaded.name, undefined, preloaded.symbolId));
	}
	const functionFact = context.functions.get(callee.name);
	if (functionFact !== undefined) return inferFunction(functionFact, context);
	if (callee.name === "preload")
		return unknownResult("ExternalDependency", "the resource type is outside the indexed type database");
	if (callee.name === "load") return unknownResult("RuntimeConstructed", "load produces a runtime resource value");
	return unknownResult("NotImplemented", "the called function has no available type summary");
}

/** A lone plain or StringName string. */
function literalPath(tokens: ReferenceToken[], span: TokenSpan): string | undefined {
	const first = nextReferenceToken(tokens, span.start - 1);
	const token = tokens[first];
	const string = token?.string;
	if (string === undefined || string.triple || (string.prefix !== "" && string.prefix !== "&")) return undefined;
	const after = nextReferenceToken(tokens, first);
	if (after >= 0 && after < span.end) return undefined;
	return token?.value.slice(string.prefix.length + 1, -1);
}

function evaluate(expression: Expression, context: InferenceContext, environment: Map<string, EvalResult>): EvalResult {
	switch (expression.kind) {
		case "number":
			return known(numberValue(expression.text));
		case "string":
			return known(stringValue(expression.token));
		case "keyword":
			return known(expression.value === "null" ? value("null", "null") : value("bool", expression.value));
		case "collection":
			return known(value(expression.base));
		case "name":
			return (
				environment.get(expression.name) ??
				unknownResult("DynamicallyTyped", `the value of ${expression.name} is not statically known`)
			);
		case "unary":
			return expression.operator === "not" ? known(value("bool")) : outsideSubset();
		case "typeTest":
			return known(value("bool"));
		case "binary":
			if (BOOLEAN_OPERATORS.has(expression.operator)) return known(value("bool"));
			if (!ARITHMETIC_OPERATORS.has(expression.operator)) return outsideSubset();
			return arithmetic(
				expression.operator,
				evaluate(expression.left, context, environment),
				evaluate(expression.right, context, environment),
			);
		case "ternary":
			return mergeResults(
				evaluate(expression.value, context, environment),
				evaluate(expression.otherwise, context, environment),
			);
		case "cast":
			return known(annotationValue(expression, context.module, context.resolver));
		case "await":
			return unknownResult("NotImplemented", "await changes the returned value and is not inferred");
		case "call":
			return evaluateCall(expression, context);
		case "member":
		case "subscript":
		case "nodePath":
			return outsideSubset();
	}
}

function inferExpression(span: TokenSpan, context: InferenceContext, environment: Map<string, EvalResult>): EvalResult {
	const first = nextReferenceToken(context.tokens, span.start - 1);
	if (first < 0 || first >= span.end) return known(value("null", "null"));
	const expression = parseExpression(context.tokens, span, context.coordinates);
	return expression === null ? outsideSubset() : evaluate(expression, context, environment);
}

//////// Flow

function firstWord(context: InferenceContext, line: LogicalLine): string {
	const token = context.tokens[line.start] as ReferenceToken;
	return token.kind === "identifier" ? token.value : "";
}

function blockEnd(lines: LogicalLine[], start: number, parentIndent: number, end: number): number {
	for (let index = start; index < end; index++) {
		if ((lines[index] as LogicalLine).indent <= parentIndent) return index;
	}
	return end;
}

function inlineFlow(span: TokenSpan, context: InferenceContext, environment: Map<string, EvalResult>): FlowResult {
	for (const statement of statements(context.tokens, span)) {
		const token = context.tokens[statement.start] as ReferenceToken;
		if (token.kind !== "identifier" || token.value !== "return") continue;
		const result = inferExpression({ start: statement.start + 1, end: statement.end }, context, environment);
		if (result.status === "unknown") return { values: [], unknown: result, fallsThrough: false };
		return { values: result.values, fallsThrough: false };
	}
	return { values: [], fallsThrough: true };
}

/** Inline tail, then indented block. */
function branchBody(
	context: InferenceContext,
	lineIndex: number,
	parentIndent: number,
	end: number,
	environment: Map<string, EvalResult>,
): { flow: FlowResult; next: number } {
	const line = context.lines[lineIndex] as LogicalLine;
	const colon = blockColon(context.tokens, line);
	const inline = { start: colon < 0 ? line.end : colon + 1, end: line.end };
	const child = lineIndex + 1;
	if (child >= end || (context.lines[child] as LogicalLine).indent <= parentIndent) {
		return { flow: inlineFlow(inline, context, environment), next: child };
	}
	const childIndent = (context.lines[child] as LogicalLine).indent;
	const childEnd = blockEnd(context.lines, child, parentIndent, end);
	const flow = analyzeBlock(context, child, childEnd, childIndent, new Map(environment));
	const hasInline = inline.end > inline.start;
	return { flow: hasInline ? mergeFlow(inlineFlow(inline, context, environment), flow) : flow, next: childEnd };
}

function analyzeIfGroup(
	context: InferenceContext,
	start: number,
	end: number,
	environment: Map<string, EvalResult>,
): { flow: FlowResult; next: number } {
	const indent = (context.lines[start] as LogicalLine).indent;
	const continues = (index: number): boolean => {
		const line = context.lines[index] as LogicalLine;
		const word = firstWord(context, line);
		return line.indent === indent && (word === "elif" || word === "else");
	};
	let cursor = start;
	let hasElse = false;
	let combined: FlowResult = { values: [], fallsThrough: false };
	while (cursor < end) {
		if (cursor !== start && !continues(cursor)) break;
		if (firstWord(context, context.lines[cursor] as LogicalLine) === "else") hasElse = true;
		const branch = branchBody(context, cursor, indent, end, environment);
		combined = mergeFlow(combined, branch.flow);
		if (branch.next >= end || !continues(branch.next)) {
			return { flow: { ...combined, fallsThrough: combined.fallsThrough || !hasElse }, next: branch.next };
		}
		cursor = branch.next;
	}
	return { flow: { ...combined, fallsThrough: combined.fallsThrough || !hasElse }, next: cursor };
}

function analyzeMatch(
	context: InferenceContext,
	start: number,
	end: number,
	environment: Map<string, EvalResult>,
): { flow: FlowResult; next: number } {
	const line = context.lines[start] as LogicalLine;
	const firstArm = start + 1;
	if (firstArm >= end || (context.lines[firstArm] as LogicalLine).indent <= line.indent) {
		return { flow: { values: [], fallsThrough: true }, next: firstArm };
	}
	const armIndent = (context.lines[firstArm] as LogicalLine).indent;
	let cursor = firstArm;
	let wildcard = false;
	let combined: FlowResult = { values: [], fallsThrough: false };
	while (cursor < end) {
		const arm = context.lines[cursor] as LogicalLine;
		if (arm.indent !== armIndent) break;
		const colon = blockColon(context.tokens, arm);
		const pattern = context.tokens
			.slice(arm.start, colon < 0 ? arm.end : colon)
			.filter((token) => token.kind !== "newline");
		if (pattern[0]?.value === "_" && (pattern.length === 1 || pattern[1]?.value === "when")) {
			wildcard = pattern.length === 1;
		}
		const branch = branchBody(context, cursor, armIndent, end, environment);
		combined = mergeFlow(combined, branch.flow);
		if (branch.next >= end || (context.lines[branch.next] as LogicalLine).indent !== armIndent) {
			return { flow: { ...combined, fallsThrough: combined.fallsThrough || !wildcard }, next: branch.next };
		}
		cursor = branch.next;
	}
	return { flow: { ...combined, fallsThrough: combined.fallsThrough || !wildcard }, next: cursor };
}

function analyzeStatement(
	context: InferenceContext,
	index: number,
	end: number,
	environment: Map<string, EvalResult>,
): { flow: FlowResult; next: number } {
	const line = context.lines[index] as LogicalLine;
	const word = firstWord(context, line);
	if (word === "if") return analyzeIfGroup(context, index, end, environment);
	if (word === "match") return analyzeMatch(context, index, end, environment);
	if (word === "for" || word === "while") {
		const child = index + 1;
		if (child < end && (context.lines[child] as LogicalLine).indent > line.indent) {
			const childEnd = blockEnd(context.lines, child, line.indent, end);
			const childIndent = (context.lines[child] as LogicalLine).indent;
			const body = analyzeBlock(context, child, childEnd, childIndent, new Map(environment));
			return { flow: { ...body, fallsThrough: true }, next: childEnd };
		}
		return { flow: { values: [], fallsThrough: true }, next: index + 1 };
	}
	return { flow: inlineFlow(line, context, environment), next: index + 1 };
}

function analyzeBlock(
	context: InferenceContext,
	start: number,
	end: number,
	indent: number,
	environment: Map<string, EvalResult>,
): FlowResult {
	let cursor = start;
	let combined: FlowResult = { values: [], fallsThrough: true };
	while (cursor < end) {
		const line = context.lines[cursor] as LogicalLine;
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
		cursor = statement.next;
		if (!combined.fallsThrough) break;
	}
	return combined;
}

//////// Declarations

function tokenIndexAt(tokens: ReferenceToken[], position: Range["start"]): number {
	return tokens.findIndex((token) => token.line === position.line && token.character === position.character);
}

function logicalLineOf(lines: LogicalLine[], token: number): number {
	return lines.findIndex((line) => token >= line.start && token < line.end);
}

function headerLinesOf(context: Pick<InferenceContext, "tokens" | "lines">, declaration: Declaration) {
	const start = (declaration.selectionRange ?? declaration.range).start;
	const line = context.lines[logicalLineOf(context.lines, tokenIndexAt(context.tokens, start))];
	return line === undefined ? { first: start.line, last: start.line } : { first: line.line, last: line.lastLine };
}

function functionFacts(
	context: Pick<InferenceContext, "tokens" | "lines" | "declarations">,
): Map<string, FunctionFact> {
	const { tokens, lines } = context;
	const facts = new Map<string, FunctionFact>();
	for (const declaration of context.declarations) {
		if (declaration.kind !== "method" || declaration.selectionRange === undefined) continue;
		const name = tokenIndexAt(tokens, declaration.selectionRange.start);
		const headerIndex = logicalLineOf(lines, name);
		const header = lines[headerIndex];
		if (header === undefined) continue;
		const open = nextReferenceToken(tokens, name);
		const close = tokens[open]?.value === "(" ? matchingReferenceToken(tokens, open, "(", ")") : -1;
		const colon = close < 0 ? -1 : blockColon(tokens, header, close + 1);
		const bodyStart = headerIndex + 1;
		facts.set(declaration.name, {
			declaration,
			headerLines: { first: header.line, last: header.lastLine },
			inline: { start: colon < 0 ? header.end : colon + 1, end: header.end },
			bodyStart,
			bodyEnd: blockEnd(lines, bodyStart, header.indent, lines.length),
		});
	}
	return facts;
}

function declarationInitializer(declaration: Declaration, context: InferenceContext): TokenSpan | null {
	// Every declaration this provider extracts has its name in the source.
	const name = tokenIndexAt(context.tokens, (declaration.selectionRange ?? declaration.range).start);
	const start = name < 0 ? -1 : initializerStart(context.tokens, name);
	return start < 0 ? null : { start, end: expressionEnd(context.tokens, start) };
}

function annotationForDeclaration(
	declaration: Declaration,
	annotations: TypeAnnotationFact[],
): TypeAnnotationFact | undefined {
	return annotations.find((annotation) => annotation.symbolId === declaration.symbolId);
}

function parameterEnvironment(
	functionFact: Pick<FunctionFact, "declaration" | "headerLines">,
	context: InferenceContext,
): Map<string, EvalResult> {
	const environment = new Map<string, EvalResult>();
	const { first, last } = functionFact.headerLines;
	for (const annotation of context.annotations) {
		if (annotation.symbolId === functionFact.declaration.symbolId) continue;
		const line = annotation.targetRange.start.line;
		if (line < first || line > last) continue;
		const name = context.coordinates.sliceRange(annotation.targetRange);
		if (name !== undefined && name !== "")
			environment.set(name, known(annotationValue(annotation, context.module, context.resolver)));
	}
	return environment;
}

function localEnvironment(
	functionFact: Pick<FunctionFact, "declaration" | "headerLines">,
	context: InferenceContext,
): Map<string, EvalResult> {
	const environment = new Map(context.moduleValues);
	for (const [name, result] of parameterEnvironment(functionFact, context)) environment.set(name, result);
	for (const declaration of context.declarations) {
		if (declaration.containerId !== functionFact.declaration.symbolId) continue;
		if (declaration.languageKind === "parameter") continue;
		if (declaration.kind !== "variable" && declaration.kind !== "constant" && declaration.kind !== "property")
			continue;
		environment.set(declaration.name, declarationValue(declaration, context, environment, "local"));
	}
	return environment;
}

function declarationValue(
	declaration: Declaration,
	context: InferenceContext,
	environment: Map<string, EvalResult>,
	scope: "local" | "declaration",
): EvalResult {
	const annotation = annotationForDeclaration(declaration, context.annotations);
	if (annotation !== undefined) return known(annotationValue(annotation, context.module, context.resolver));
	const initializer = declarationInitializer(declaration, context);
	return initializer === null
		? unknownResult("DynamicallyTyped", `the ${scope} has no declared type or initializer`)
		: inferExpression(initializer, context, environment);
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
	const hasBody = functionFact.bodyStart < functionFact.bodyEnd;
	const bodyFlow = () =>
		analyzeBlock(
			context,
			functionFact.bodyStart,
			functionFact.bodyEnd,
			(context.lines[functionFact.bodyStart] as LogicalLine).indent,
			environment,
		);
	let flow: FlowResult;
	if (functionFact.inline.end > functionFact.inline.start) {
		flow = inlineFlow(functionFact.inline, context, environment);
		if (flow.fallsThrough && hasBody) flow = mergeFlow(flow, bodyFlow());
	} else {
		flow = hasBody ? bodyFlow() : { values: [], fallsThrough: true };
	}
	context.implicitReturns.set(symbolId, flow.fallsThrough);
	if (flow.fallsThrough) flow.values.push(value("null", "null"));
	const result: EvalResult = flow.unknown === undefined ? known(...flow.values) : flow.unknown;
	context.depth--;
	context.activeFunctions.delete(symbolId);
	context.functionAnswers.set(symbolId, result);
	return result;
}

function countReturns(functionFact: FunctionFact, context: InferenceContext): number {
	const last = context.lines[functionFact.bodyEnd - 1];
	const end =
		functionFact.bodyStart < functionFact.bodyEnd && last !== undefined ? last.end : functionFact.inline.end;
	let count = 0;
	for (let index = functionFact.inline.start; index < end; index++) {
		const token = context.tokens[index] as ReferenceToken;
		if (token.kind === "identifier" && token.value === "return") count++;
	}
	return count;
}

function inferFile(
	module: string,
	declarations: Declaration[],
	annotations: TypeAnnotationFact[],
	text: string,
	resolver: TypeResolver,
): Map<string, TypeInfo> {
	const scanned = scanSource(text);
	const tokens = referenceTokens(scanned);
	const lines = logicalLines(tokens, scanned.lines);
	const context: InferenceContext = {
		module,
		resolver,
		coordinates: coordinatesOf(text),
		tokens,
		lines,
		declarations,
		annotations,
		moduleValues: new Map(),
		functions: functionFacts({ tokens, lines, declarations }),
		functionAnswers: new Map(),
		implicitReturns: new Map(),
		activeFunctions: new Set(),
		depth: 0,
	};
	for (const declaration of declarations) {
		if (declaration.containerId !== undefined) continue;
		if (declaration.kind !== "property" && declaration.kind !== "variable" && declaration.kind !== "constant")
			continue;
		context.moduleValues.set(
			declaration.name,
			declarationValue(declaration, context, context.moduleValues, "declaration"),
		);
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
				const explicitReturns = countReturns(context.functions.get(declaration.name) as FunctionFact, context);
				const basis = `${explicitReturns} return statement${explicitReturns === 1 ? "" : "s"}${context.implicitReturns.get(declaration.symbolId) === true ? (explicitReturns === 0 ? " with implicit null" : " and implicit null") : ""}`;
				inferred.set(declaration.symbolId, {
					status: "inferred",
					display: renderValues(answer.values, true),
					basis,
					...defined({ symbolId: singleSymbolId(answer.values) }),
				});
			} else if (answer?.status === "unknown") inferred.set(declaration.symbolId, answer);
			continue;
		}
		const container = declarations.find((candidate) => candidate.symbolId === declaration.containerId);
		const result =
			container === undefined
				? context.moduleValues.get(declaration.name)
				: localEnvironment(
						{ declaration: container, headerLines: headerLinesOf(context, container) },
						context,
					).get(declaration.name);
		if (result?.status === "known")
			inferred.set(declaration.symbolId, {
				status: "inferred",
				display: renderValues(result.values, declaration.kind === "constant"),
				basis: "initializer",
				...defined({ symbolId: singleSymbolId(result.values) }),
			});
		else if (result?.status === "unknown") inferred.set(declaration.symbolId, result);
	}
	return inferred;
}

//////// Index

export class GDScriptTypeIndex {
	constructor(
		private readonly store: GDScriptStore,
		private readonly resolver: TypeResolver,
	) {}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) return this.typeOfSymbol(params.symbolId);
		const value = this.store.load(params.module, "full");
		if (value === undefined) return unknownType("NotIndexed", "module is not indexed");

		const position = params.range.start;
		const annotation = value.annotations.find(
			(candidate) =>
				positionInRange(candidate.targetRange, position) || positionInRange(candidate.typeRange, position),
		);
		if (annotation !== undefined) return declaredType(params.module, annotation, this.resolver);

		const declaration = value.declarations.find(
			(candidate) =>
				candidate.selectionRange !== undefined && positionInRange(candidate.selectionRange, position),
		);
		if (declaration !== undefined) return this.typeOfDeclaration(params.module, value, declaration);
		return unknownType("NotIndexed", "no indexed declaration or annotation matched the requested range");
	}

	private typeOfSymbol(symbolId: string): TypeInfo {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== "gdscript") {
			return unknownType("ParseError", "the symbol id is not a GDScript workspace id");
		}
		const value = this.store.load(parsed.module, "full");
		if (value === undefined) return unknownType("NotIndexed", "module is not indexed");
		const declaration = value.declarations.find((candidate) => candidate.symbolId === symbolId);
		if (declaration === undefined) return unknownType("ParseError", "the symbol id has no declaration");
		return this.typeOfDeclaration(parsed.module, value, declaration);
	}

	private typeOfDeclaration(module: string, value: GDScriptValue, declaration: Declaration): TypeInfo {
		const annotation = value.annotations.find((candidate) => candidate.symbolId === declaration.symbolId);
		if (annotation !== undefined) return declaredType(module, annotation, this.resolver);
		return (
			this.inferred(module, value).get(declaration.symbolId) ??
			unknownType("NotImplemented", "GDScript inference has no answer for this declaration")
		);
	}

	private inferred(module: string, value: GDScriptValue): Map<string, TypeInfo> {
		return this.store.memo(`infer:${module}`, () => {
			const text = this.store.text(module)?.text;
			return text === undefined
				? new Map()
				: inferFile(module, value.declarations, value.annotations, text, this.resolver);
		});
	}
}
