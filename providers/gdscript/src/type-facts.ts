// Owns GDScript type annotation facts and their source ranges.

import {
	comparePositions,
	coordinatesOf,
	type Position,
	type Range,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import { extractGdscript, headerEndLine } from "./declarations.js";
import type { ComposeSymbolId, DeclarationFact, ReferenceToken } from "./parse-model.js";
import { referenceRange, sourceBetween } from "./references.js";
import { readLines } from "./source-scan.js";
import { matchingReferenceToken, nextReferenceToken, referenceTokens } from "./tokens.js";

export interface TypeAnnotationFact {
	symbolId?: string;
	targetRange: Range;
	typeRange: Range;
	display: string;
}

//////// Type facts

function tokenIndexAt(tokens: ReferenceToken[], position: Position): number {
	return tokens.findIndex((token) => comparePositions(token, position) === 0);
}

function typeExpressionEnd(tokens: ReferenceToken[], start: number, stops: Set<string>, allowNewline = false): number {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = start; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind === "newline" && !allowNewline && parentheses === 0 && brackets === 0 && braces === 0)
			return index;
		if (parentheses === 0 && brackets === 0 && braces === 0 && stops.has(token.value)) return index;
		if (token.value === "(") parentheses++;
		else if (token.value === ")") parentheses--;
		else if (token.value === "[") brackets++;
		else if (token.value === "]") brackets--;
		else if (token.value === "{") braces++;
		else if (token.value === "}") braces--;
	}
	return tokens.length;
}

function typeFact(
	coordinates: TextCoordinates,
	tokens: ReferenceToken[],
	start: number,
	end: number,
	targetRange: Range,
	symbolId?: string,
): TypeAnnotationFact | null {
	if (end <= start) return null;
	const first = tokens[start] as ReferenceToken;
	const last = tokens[end - 1] as ReferenceToken;
	if (first.kind === "newline" || last.kind === "newline") return null;
	const display = sourceBetween(coordinates, first, last)?.trim();
	if (display === undefined || display === "") return null;
	return {
		...(symbolId === undefined ? {} : { symbolId }),
		targetRange,
		typeRange: {
			start: referenceRange(first).start,
			end: referenceRange(last).end,
		},
		display,
	};
}

function addParameterTypeFacts(
	coordinates: TextCoordinates,
	tokens: ReferenceToken[],
	start: number,
	end: number,
	facts: TypeAnnotationFact[],
	parameterDeclarations: DeclarationFact[],
): void {
	let segmentStart = start;
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	const addSegment = (from: number, to: number): void => {
		let nameIndex = -1;
		for (let index = from; index < to; index++) {
			if ((tokens[index] as ReferenceToken).kind === "identifier") {
				nameIndex = index;
				break;
			}
		}
		if (nameIndex < 0) return;
		let colon = -1;
		for (let index = nameIndex + 1; index < to; index++) {
			const token = tokens[index] as ReferenceToken;
			if (token.value === "=") break;
			if (token.value === ":") {
				colon = index;
				break;
			}
		}
		if (colon < 0) return;
		const typeEnd = typeExpressionEnd(tokens, colon + 1, new Set(["=", ",", ")", ";"]), true);
		const name = tokens[nameIndex] as ReferenceToken;
		// Every declaration this provider extracts has its name in the source.
		const parameter = parameterDeclarations.find(
			(candidate) =>
				candidate.selectionRange !== undefined && comparePositions(candidate.selectionRange.start, name) === 0,
		);
		const fact = typeFact(
			coordinates,
			tokens,
			colon + 1,
			Math.min(typeEnd, to),
			referenceRange(name),
			parameter?.symbolId,
		);
		if (fact !== null) facts.push(fact);
	};
	for (let index = start; index < end; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else if (value === "{") braces++;
		else if (value === "}") braces--;
		else if (value === "," && parentheses === 0 && brackets === 0 && braces === 0) {
			addSegment(segmentStart, index);
			segmentStart = index + 1;
		}
	}
	addSegment(segmentStart, end);
}

export function extractTypeAnnotationsCore(
	module: string,
	text: string,
	compose: ComposeSymbolId,
): TypeAnnotationFact[] {
	if (!module.endsWith(".gd")) return [];
	const coordinates = coordinatesOf(text);
	const lines = readLines(text);
	const declarations = extractGdscript(module, text, compose);
	const tokens = referenceTokens(lines);
	const facts: TypeAnnotationFact[] = [];
	for (const declaration of declarations) {
		// Every declaration this provider extracts has its name in the source.
		const nameIndex = tokenIndexAt(tokens, (declaration.selectionRange ?? declaration.range).start);
		if (nameIndex < 0) continue;
		const name = tokens[nameIndex] as ReferenceToken;
		if (
			(declaration.kind === "property" || declaration.kind === "variable" || declaration.kind === "constant") &&
			declaration.languageKind !== "parameter"
		) {
			const colon = nextReferenceToken(tokens, nameIndex);
			if (colon >= 0 && (tokens[colon] as ReferenceToken).value === ":") {
				const typeEnd = typeExpressionEnd(tokens, colon + 1, new Set(["=", ",", ";", "in"]));
				const fact = typeFact(
					coordinates,
					tokens,
					colon + 1,
					typeEnd,
					referenceRange(name),
					declaration.symbolId,
				);
				if (fact !== null) facts.push(fact);
			}
		}
		if (declaration.kind !== "method") continue;
		let open = nextReferenceToken(tokens, nameIndex);
		while (open >= 0 && (tokens[open] as ReferenceToken).value !== "(") open = nextReferenceToken(tokens, open);
		if (open < 0) continue;
		const close = matchingReferenceToken(tokens, open, "(", ")");
		if (close < 0) continue;
		addParameterTypeFacts(
			coordinates,
			tokens,
			open + 1,
			close,
			facts,
			declarations.filter(
				(candidate) => candidate.containerId === declaration.symbolId && candidate.languageKind === "parameter",
			),
		);
		for (let index = close + 1; index <= tokens.length; index++) {
			const token = tokens[index] as ReferenceToken | undefined;
			if (token === undefined || token.line > headerEndLine(lines, declaration)) break;
			if (token.value !== "->") continue;
			const typeEnd = typeExpressionEnd(tokens, index + 1, new Set([":"]));
			const fact = typeFact(coordinates, tokens, index + 1, typeEnd, referenceRange(name), declaration.symbolId);
			if (fact !== null) facts.push(fact);
			break;
		}
	}
	return facts;
}
