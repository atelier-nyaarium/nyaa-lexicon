// Words, their parts, and arithmetic: the literals, the reads, and the writes an expansion or `++` performs.

import { Cursor, defined, type HeaderSpan, type OffsetRange, type Reference } from "@nyaa-lexicon/protocol";
import { type ArithmeticExpression, parse, type Word, type WordPart } from "unbash";
import {
	bareNumber,
	type DeclaredType,
	IDENTIFIER_RE,
	NAME_CHAR_RE,
	pushLiteral,
	pushOpaque,
	pushReference,
	rangeAt,
	type Scope,
	staticValue,
	subscripted,
	type Walk,
	wordRange,
} from "./context.js";
import type { HeaderOf } from "./header.js";
import { declareOrWrite, resolve, subshell } from "./scope.js";

////////////////////////////////
//  Interfaces & Types

/** Name and offset in a `$NAME` or `${...}` parameter. */
interface Parameter {
	at: number;
	name: string;
}

////////////////////////////////
//  Constants

const ARITHMETIC_WRITES = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "|=", "^="]);
const ASSIGNING_EXPANSIONS = new Set(["=", ":="]);
const QUOTED = new Set(["SingleQuoted", "AnsiCQuoted", "DoubleQuoted", "LocaleString"]);
const RAW = new Set(["SingleQuoted", "AnsiCQuoted"]);
/** What `$`, `${`, `${#` and `${!` put before a name. */
const SIGILS = new Set(["$", "{", "#", "!"]);

////////////////////////////////
//  Functions & Helpers

function markPart(w: Walk, part: WordPart, at: number, end: number): void {
	if (QUOTED.has(part.type)) w.quoted.push(at, end);
	if (RAW.has(part.type)) w.raw.push(at, end);
}

/** The quoted parts of a word no walk descends into. */
export function markQuoted(w: Walk, word: Word): void {
	let at = word.pos;
	for (const part of word.parts ?? []) {
		const end = at + part.text.length;
		markPart(w, part, at, end);
		at = end;
	}
}

/** A word naming a variable a builtin writes; `NAME[i]` names NAME. */
export function declareOrWriteWord(
	w: Walk,
	scope: Scope,
	word: Word | undefined,
	header: HeaderOf,
	declaredType?: DeclaredType,
): void {
	if (word === undefined) return;
	const { name } = subscripted(word.value);
	if (!IDENTIFIER_RE.test(name)) {
		walkWord(w, scope, word);
		return;
	}
	const selection = rangeAt(w, word.pos, word.pos + name.length);
	declareOrWrite(w, scope, name, selection, wordRange(w, word), {
		kind: "variable",
		local: false,
		...defined({ declaredType }),
		header: header(word),
	});
	// A subscript may expand, and the word's text is data either way.
	walkWord(w, scope, word, false);
}

function parameterOf(text: string): Parameter {
	const cursor = new Cursor(text);
	cursor.takeWhile((character) => SIGILS.has(character));
	const at = cursor.offset;
	return { at, name: cursor.takeWhile((character) => NAME_CHAR_RE.test(character)) };
}

/** `$NAME` and every `${NAME...}` form name NAME; a positional or special parameter is no name. */
function expansionReference(
	w: Walk,
	scope: Scope,
	{ at, name }: Parameter,
	part: OffsetRange,
	role: Reference["role"] = "read",
): void {
	if (!IDENTIFIER_RE.test(name) || name === "_") return;
	const range = rangeAt(w, part.start + at, part.start + at + name.length);
	if (role === "write") {
		declareOrWrite(w, scope, name, range, rangeAt(w, part.start, part.end), {
			kind: "variable",
			local: false,
			header: { start: part.start, end: part.end },
		});
	} else pushReference(w, scope, { name, range, role });
}

/** A tree parsed on its own, moved to where its text sits; static text expands nothing. */
function relocated(expression: ArithmeticExpression, by: number): ArithmeticExpression {
	const pos = expression.pos + by;
	const end = expression.end + by;
	switch (expression.type) {
		case "ArithmeticBinary":
			return {
				...expression,
				pos,
				end,
				left: relocated(expression.left, by),
				right: relocated(expression.right, by),
			};
		case "ArithmeticUnary":
			return { ...expression, pos, end, operand: relocated(expression.operand, by) };
		case "ArithmeticTernary":
			return {
				...expression,
				pos,
				end,
				test: relocated(expression.test, by),
				consequent: relocated(expression.consequent, by),
				alternate: relocated(expression.alternate, by),
			};
		case "ArithmeticGroup":
			return { ...expression, pos, end, expression: relocated(expression.expression, by) };
		case "ArithmeticWord":
			return { type: "ArithmeticWord", pos, end, value: expression.value };
		case "ArithmeticCommandExpansion":
			return { type: "ArithmeticWord", pos, end, value: expression.text };
	}
}

/** Parse static text as `(( ))` at source offset `at`. */
export function arithmeticAt(text: string, at: number): ArithmeticExpression | undefined {
	const script = parse(`((${text}))`);
	const statement = script.commands[0];
	if ((script.errors?.length ?? 0) > 0 || script.commands.length !== 1 || statement === undefined) return undefined;
	const command = statement.command;
	if (command.type !== "ArithmeticCommand" || command.body !== text || command.expression === undefined) {
		return undefined;
	}
	return relocated(command.expression, at - 2);
}

/** Source offset per static value character; undefined if escapes shift offsets. */
export function valueOffsets(word: Word): number[] | undefined {
	const offsets: number[] = [];
	const lay = (from: number, length: number): void => {
		for (let at = from; at < from + length; at++) offsets.push(at);
	};
	if (word.parts === undefined) {
		if (word.value !== word.text) return undefined;
		lay(word.pos, word.value.length);
		return offsets;
	}
	let at = word.pos;
	for (const part of word.parts) {
		switch (part.type) {
			case "Literal":
				if (part.value !== part.text) return undefined;
				lay(at, part.value.length);
				break;
			case "SingleQuoted":
			case "AnsiCQuoted": {
				const opening = part.type === "SingleQuoted" ? 1 : 2;
				// An escape shortens the value.
				if (part.text.length !== opening + part.value.length + 1) return undefined;
				lay(at + opening, part.value.length);
				break;
			}
			case "DoubleQuoted":
			case "LocaleString": {
				let inner = at + (part.type === "DoubleQuoted" ? 1 : 2);
				for (const child of part.parts) {
					if (child.type !== "Literal" || child.value !== child.text) return undefined;
					lay(inner, child.value.length);
					inner += child.text.length;
				}
				break;
			}
			default:
				return undefined;
		}
		at += part.text.length;
	}
	return offsets;
}

/** Static value over its word text, with delimiters as spaces to preserve offsets. */
export function inPlaceValue(word: Word): string | undefined {
	const value = staticValue(word);
	const offsets = valueOffsets(word);
	if (value === undefined || offsets === undefined || offsets.length !== value.length) return undefined;
	const cursor = new Cursor(value);
	let laid = "";
	for (const offset of offsets) laid += " ".repeat(offset - word.pos - laid.length) + cursor.next();
	return laid + " ".repeat(word.text.length - laid.length);
}

/** Arithmetic for an indexed array; an associative array's static key is a string. */
export function walkIndex(
	w: Walk,
	scope: Scope,
	array: string,
	index: string | undefined,
	parts: WordPart[] | undefined,
	at: number,
): void {
	if (index === undefined) return;
	if (parts !== undefined) {
		walkParts(w, scope, parts, at);
		return;
	}
	if (resolve(w, scope, array, { local: false })?.declaredType === "assoc") return;
	walkArithmetic(w, scope, arithmeticAt(index, at));
}

/** Parts are contiguous, so each one's offset is the sum of the texts before it. */
function walkParts(w: Walk, scope: Scope, parts: WordPart[], start: number): void {
	let at = start;
	for (const part of parts) {
		const end = at + part.text.length;
		markPart(w, part, at, end);
		switch (part.type) {
			// A text run beside an expansion in the same word: its own literal, since the word as a
			// whole is not one value.
			case "Literal":
				pushLiteral(w, scope, part.value, at, end);
				pushOpaque(w, at, end);
				break;
			case "SingleQuoted":
			case "AnsiCQuoted":
				pushLiteral(w, scope, part.value, at, end);
				pushOpaque(w, at, end);
				break;
			case "DoubleQuoted":
			case "LocaleString": {
				const opening = part.type === "DoubleQuoted" ? 1 : 2;
				if (part.parts.every((child) => child.type === "Literal")) {
					// One literal for the whole quoted text; walking the children too would report it twice.
					pushLiteral(w, scope, part.parts.map((child) => child.value).join(""), at, end);
					pushOpaque(w, at, end);
					break;
				}
				walkParts(w, scope, part.parts, at + opening);
				break;
			}
			case "SimpleExpansion":
				expansionReference(w, scope, parameterOf(part.text), { start: at, end });
				pushOpaque(w, at, end);
				break;
			case "ParameterExpansion": {
				// `${!prefix*}` lists names and reads no variable.
				const listing = part.indirect === true && (part.operator === "*" || part.operator === "@");
				const role = ASSIGNING_EXPANSIONS.has(part.operator ?? "") ? "write" : "read";
				const named = parameterOf(part.text);
				if (!listing && named.name === part.parameter) {
					expansionReference(w, scope, named, { start: at, end }, role);
				}
				const index = at + named.at + part.parameter.length + 1;
				walkIndex(w, scope, part.parameter, part.index, part.indexParts, index);
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
	/** Every write's header; else the writer's span. */
	header?: HeaderSpan,
	writer?: ArithmeticExpression,
): void {
	if (expression === undefined) return;
	switch (expression.type) {
		case "ArithmeticBinary":
			walkArithmetic(
				w,
				scope,
				expression.left,
				header,
				ARITHMETIC_WRITES.has(expression.operator) ? expression : undefined,
			);
			walkArithmetic(w, scope, expression.right, header);
			break;
		case "ArithmeticUnary":
			walkArithmetic(
				w,
				scope,
				expression.operand,
				header,
				expression.operator === "++" || expression.operator === "--" ? expression : undefined,
			);
			break;
		case "ArithmeticTernary":
			walkArithmetic(w, scope, expression.test, header);
			walkArithmetic(w, scope, expression.consequent, header);
			walkArithmetic(w, scope, expression.alternate, header);
			break;
		case "ArithmeticGroup":
			walkArithmetic(w, scope, expression.expression, header);
			break;
		case "ArithmeticWord": {
			if (expression.parts !== undefined) {
				walkParts(w, scope, expression.parts, expression.pos);
				break;
			}
			const { name, index } = subscripted(expression.value);
			if (!IDENTIFIER_RE.test(name)) break;
			const selection = rangeAt(w, expression.pos, expression.pos + name.length);
			if (writer !== undefined) {
				declareOrWrite(w, scope, name, selection, selection, {
					kind: "variable",
					local: false,
					header: header ?? { start: writer.pos, end: writer.end },
				});
			} else pushReference(w, scope, { name, range: selection, role: "read" });
			walkIndex(w, scope, name, index, undefined, expression.pos + name.length + 1);
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
export function bareValue(w: Walk, scope: Scope, word: Word | undefined): void {
	if (word === undefined || word.parts !== undefined || word.text === "") return;
	pushLiteral(w, scope, word.text, word.pos, word.end);
}
