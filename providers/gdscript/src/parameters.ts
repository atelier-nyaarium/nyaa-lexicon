import { hasCode } from "./blocks.js";
import type { DeclarationFact, ReferenceToken } from "./parse-model.js";
import { type LexedSource, matchingReferenceToken, nextReferenceToken, tokenAt } from "./tokens.js";

export interface ParameterSegment {
	start: number;
	end: number;
}

export function parameterSegments(tokens: ReferenceToken[], start: number, end: number): ParameterSegment[] {
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
export function parameterList(
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

export function parameterNameAndEnd(
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

export function parameterCount(lexed: LexedSource, declaration: Pick<DeclarationFact, "selectionRange">): number {
	const list = parameterList(lexed, declaration);
	if (list === undefined) return 0;
	return parameterSegments(lexed.tokens, list.open + 1, list.close).filter((segment) =>
		hasCode(lexed.tokens, segment),
	).length;
}
