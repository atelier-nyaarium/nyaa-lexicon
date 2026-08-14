// Owns GDScript reference tokenization and token navigation.

import { Cursor, isIdentifierPart, isIdentifierStart } from "./cursor.js";
import type { ReferenceToken, SourceLine } from "./parse-model.js";

//////// Tokens

const referenceOperators = [
	"**=",
	">>=",
	"<<=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"->",
	":=",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"**",
	"<<",
	">>",
	"++",
	"--",
];

export const referenceAssignmentOperators = new Set([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**=",
	"<<=",
	">>=",
	"&=",
	"|=",
	"^=",
	":=",
]);

export const referenceKeywords = new Set([
	"and",
	"as",
	"await",
	"break",
	"class",
	"class_name",
	"const",
	"continue",
	"elif",
	"else",
	"enum",
	"extends",
	"false",
	"for",
	"func",
	"if",
	"in",
	"is",
	"match",
	"not",
	"null",
	"or",
	"pass",
	"return",
	"self",
	"signal",
	"static",
	"super",
	"true",
	"var",
	"void",
	"when",
	"while",
]);

export const referenceCallKeywords = new Set([
	"class",
	"class_name",
	"const",
	"enum",
	"extends",
	"for",
	"func",
	"if",
	"match",
	"return",
	"signal",
	"when",
	"while",
]);

export function referenceTokens(lines: SourceLine[]): ReferenceToken[] {
	const cursor = new Cursor(lines.map((line) => line.code).join("\n"));
	const tokens: ReferenceToken[] = [];
	while (cursor.good()) {
		const character = cursor.peek();
		if (character === "\n") {
			const line = cursor.line;
			const column = cursor.column;
			cursor.next();
			tokens.push({ kind: "newline", value: "\n", line, character: column });
			continue;
		}
		if (character === " " || character === "\t" || character === "\r") {
			cursor.next();
			continue;
		}
		const line = cursor.line;
		const column = cursor.column;
		if (isIdentifierStart(character)) {
			let value = cursor.next();
			while (isIdentifierPart(cursor.peek())) value += cursor.next();
			tokens.push({ kind: "identifier", value, line, character: column });
			continue;
		}
		const operator = referenceOperators.find((candidate) =>
			candidate.split("").every((part, index) => cursor.peek(index) === part),
		);
		if (operator !== undefined) {
			for (let index = 0; index < operator.length; index++) cursor.next();
			tokens.push({ kind: "symbol", value: operator, line, character: column });
			continue;
		}
		tokens.push({ kind: "symbol", value: cursor.next(), line, character: column });
	}
	return tokens;
}

//////// Navigation

export function nextReferenceToken(tokens: ReferenceToken[], index: number): number {
	let next = index + 1;
	while (next < tokens.length && tokens[next]?.kind === "newline") next++;
	return next < tokens.length ? next : -1;
}

export function matchingReferenceToken(tokens: ReferenceToken[], start: number, open: string, close: string): number {
	let depth = 0;
	for (let index = start; index < tokens.length; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === open) depth++;
		if (value === close) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}
