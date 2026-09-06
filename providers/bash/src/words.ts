// Words, their parts, and arithmetic: the literals, the reads, and the writes an expansion or `++` performs.

import { defined, type Reference } from "@nyaa-lexicon/protocol";
import type { ArithmeticExpression, Word, WordPart } from "unbash";
import {
	bareNumber,
	type DeclaredType,
	IDENTIFIER_RE,
	pushLiteral,
	pushOpaque,
	pushReference,
	rangeAt,
	type Scope,
	type Walk,
	wordRange,
} from "./context.js";
import { declareOrWrite, subshell } from "./scope.js";

////////////////////////////////
//  Constants

const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const ARITHMETIC_WRITES = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "|=", "^="]);
const ASSIGNING_EXPANSIONS = new Set(["=", ":="]);

////////////////////////////////
//  Functions & Helpers

/** A word naming a variable a builtin writes; `NAME[i]` names NAME. */
export function declareOrWriteWord(w: Walk, scope: Scope, word: Word | undefined, declaredType?: DeclaredType): void {
	if (word === undefined) return;
	const name = word.value.replace(/\[.*$/, "");
	if (!IDENTIFIER_RE.test(name)) {
		walkWord(w, scope, word);
		return;
	}
	const selection = rangeAt(w, word.pos, word.pos + name.length);
	declareOrWrite(w, scope, name, selection, wordRange(w, word), {
		kind: "variable",
		local: false,
		...defined({ declaredType }),
	});
	// A subscript may expand, and the word's text is data either way.
	walkWord(w, scope, word, false);
}

/** `$NAME` and every `${NAME...}` form name NAME; a positional or special parameter is no name. */
function expansionReference(
	w: Walk,
	scope: Scope,
	text: string,
	at: number,
	parameter?: string,
	role: Reference["role"] = "read",
): void {
	const name = parameter ?? text.replace(/^\$\{?/, "").replace(/\}$/, "");
	if (!IDENTIFIER_RE.test(name) || name === "_") return;
	const offset = text.indexOf(name, 1);
	if (offset === -1) return;
	const range = rangeAt(w, at + offset, at + offset + name.length);
	if (role === "write") {
		declareOrWrite(w, scope, name, range, rangeAt(w, at, at + text.length), { kind: "variable", local: false });
	} else pushReference(w, scope, { name, range, role });
}

/** A subscript is arithmetic, where a bare name is a variable, unless it holds an expansion. */
export function walkIndex(
	w: Walk,
	scope: Scope,
	index: string | undefined,
	parts: WordPart[] | undefined,
	at: number,
): void {
	if (index === undefined) return;
	if (parts !== undefined) {
		walkParts(w, scope, parts, at);
		return;
	}
	for (const match of index.matchAll(NAME_RE)) {
		const start = at + match.index;
		pushReference(w, scope, { name: match[0], range: rangeAt(w, start, start + match[0].length), role: "read" });
	}
}

/** Parts are contiguous, so each one's offset is the sum of the texts before it. */
function walkParts(w: Walk, scope: Scope, parts: WordPart[], start: number): void {
	let at = start;
	for (const part of parts) {
		const end = at + part.text.length;
		switch (part.type) {
			case "SingleQuoted":
			case "AnsiCQuoted":
				pushLiteral(w, scope, part.value, at, end);
				pushOpaque(w, at, end);
				break;
			case "DoubleQuoted":
			case "LocaleString": {
				const opening = part.type === "DoubleQuoted" ? 1 : 2;
				if (part.parts.every((child) => child.type === "Literal")) {
					pushLiteral(w, scope, part.parts.map((child) => child.value).join(""), at, end);
				}
				walkParts(w, scope, part.parts, at + opening);
				break;
			}
			case "SimpleExpansion":
				expansionReference(w, scope, part.text, at);
				pushOpaque(w, at, end);
				break;
			case "ParameterExpansion": {
				// `${!prefix*}` lists names and reads no variable.
				const listing = part.indirect === true && (part.operator === "*" || part.operator === "@");
				const role = ASSIGNING_EXPANSIONS.has(part.operator ?? "") ? "write" : "read";
				if (!listing) expansionReference(w, scope, part.text, at, part.parameter, role);
				walkIndex(w, scope, part.index, part.indexParts, at + part.text.indexOf("[") + 1);
				for (const word of [
					part.operand,
					part.slice?.offset,
					part.slice?.length,
					part.replace?.pattern,
					part.replace?.replacement,
				]) {
					walkWord(w, scope, word, false);
				}
				pushOpaque(w, at, end);
				break;
			}
			case "CommandExpansion":
			case "ProcessSubstitution":
				// A comment can sit inside; the words within mark themselves.
				if (part.script !== undefined) w.statements(subshell(scope), part.script.commands);
				else pushOpaque(w, at, end);
				break;
			case "ArithmeticExpansion":
				walkArithmetic(w, scope, part.expression);
				pushOpaque(w, at, end);
				break;
			default:
				pushOpaque(w, at, end);
				break;
		}
		at = end;
	}
}

/** Inside arithmetic a bare name is the variable; an assignment or `++` writes it. */
export function walkArithmetic(
	w: Walk,
	scope: Scope,
	expression: ArithmeticExpression | undefined,
	write = false,
): void {
	if (expression === undefined) return;
	switch (expression.type) {
		case "ArithmeticBinary":
			walkArithmetic(w, scope, expression.left, ARITHMETIC_WRITES.has(expression.operator));
			walkArithmetic(w, scope, expression.right);
			break;
		case "ArithmeticUnary":
			walkArithmetic(w, scope, expression.operand, expression.operator === "++" || expression.operator === "--");
			break;
		case "ArithmeticTernary":
			walkArithmetic(w, scope, expression.test);
			walkArithmetic(w, scope, expression.consequent);
			walkArithmetic(w, scope, expression.alternate);
			break;
		case "ArithmeticGroup":
			walkArithmetic(w, scope, expression.expression);
			break;
		case "ArithmeticWord": {
			if (expression.parts !== undefined) {
				walkParts(w, scope, expression.parts, expression.pos);
				break;
			}
			const bracket = expression.value.indexOf("[");
			const name = bracket === -1 ? expression.value : expression.value.slice(0, bracket);
			if (!IDENTIFIER_RE.test(name)) break;
			const selection = rangeAt(w, expression.pos, expression.pos + name.length);
			if (write) declareOrWrite(w, scope, name, selection, selection, { kind: "variable", local: false });
			else pushReference(w, scope, { name, range: selection, role: "read" });
			if (bracket !== -1) {
				walkIndex(w, scope, expression.value.slice(bracket + 1, -1), undefined, expression.pos + bracket + 1);
			}
			break;
		}
		case "ArithmeticCommandExpansion":
			if (expression.script !== undefined) w.statements(subshell(scope), expression.script.commands);
			break;
	}
}

export function walkWord(w: Walk, scope: Scope, word: Word | undefined, numbers = true): void {
	if (word === undefined) return;
	if (word.parts === undefined) {
		if (numbers) bareNumber(w, scope, word);
		pushOpaque(w, word.pos, word.end);
		return;
	}
	walkParts(w, scope, word.parts, word.pos);
}

export function walkWords(w: Walk, scope: Scope, words: Word[]): void {
	for (const word of words) walkWord(w, scope, word);
}

/** An unquoted assignment value is still a string; a quoted one is reported by its quotes. */
export function bareValue(w: Walk, scope: Scope, word: Word | undefined, from = 0): void {
	if (word === undefined || word.parts !== undefined) return;
	const text = word.text.slice(from);
	if (text !== "") pushLiteral(w, scope, text, word.pos + from, word.end);
}
