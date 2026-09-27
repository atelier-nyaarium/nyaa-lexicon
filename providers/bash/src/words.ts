// Words, their parts, and arithmetic: the literals, the reads, and the writes an expansion or `++` performs.

import { defined, type HeaderSpan, type Range, type Reference, SourceCursor } from "@nyaa-lexicon/protocol";
import {
	bareNumber,
	type DeclaredType,
	IDENTIFIER_RE,
	NAME_CHAR_RE,
	pushLiteral,
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
import type { ArithmeticExpression, ArithmeticWord, Span, Word, WordPart } from "./syntax/ast.js";
import { parseArithmeticAt } from "./syntax/parser.js";

////////////////////////////////
//  Constants

const ARITHMETIC_WRITES = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "|=", "^="]);
const ASSIGNING_EXPANSIONS = new Set(["=", ":="]);
const QUOTED = new Set(["SingleQuoted", "AnsiCQuoted", "DoubleQuoted", "LocaleString"]);

////////////////////////////////
//  Functions & Helpers

function markPart(w: Walk, part: WordPart): void {
	if (QUOTED.has(part.type)) w.quoted.push(part.pos, part.end);
}

/** The quoted parts of a word no walk descends into. */
export function markQuoted(w: Walk, word: Word): void {
	for (const part of word.parts ?? []) markPart(w, part);
}

/** Where the name opening a word's value is written, inside any quotes and past any escape. */
export function nameRange(w: Walk, word: Word, name: string): Range {
	const offsets = valueOffsets(word);
	const first = offsets?.[0];
	const last = offsets?.[name.length - 1];
	if (first === undefined || last === undefined) return rangeAt(w, word.pos, word.pos + name.length);
	return rangeAt(w, first, last + 1);
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
	declareOrWrite(w, scope, name, nameRange(w, word, name), wordRange(w, word), {
		kind: "variable",
		local: false,
		...defined({ declaredType }),
		header: header(word),
	});
	// A subscript may expand, and the word's text is data either way.
	walkWord(w, scope, word, false);
}

/** `$NAME` and every `${NAME...}` form name NAME; a positional or special parameter is no name. */
function expansionReference(w: Walk, scope: Scope, named: Span, part: Span, role: Reference["role"] = "read"): void {
	const name = w.text.slice(named.pos, named.end);
	if (!IDENTIFIER_RE.test(name) || name === "_") return;
	const range = rangeAt(w, named.pos, named.end);
	if (role === "write") {
		declareOrWrite(w, scope, name, range, rangeAt(w, part.pos, part.end), {
			kind: "variable",
			local: false,
			header: { start: part.pos, end: part.end },
		});
	} else pushReference(w, scope, { name, range, role });
}

/** The span's text is its source, with no escape a backquote removed. */
function inPlace(node: Span & { text: string }): boolean {
	return node.end - node.pos === node.text.length;
}

/**
 * Where each value character of a run of text sits: past the backslash of an escape, and nowhere
 * for a line continuation. In double quotes a backslash escapes only `$`, a backquote, `"`, `\` and
 * a line break. Undefined when the value is not the run's text read that way.
 */
function escapedOffsets(text: string, pos: number, value: string, quoted: boolean): number[] | undefined {
	const offsets: number[] = [];
	const cursor = new SourceCursor(text);
	while (cursor.good()) {
		const at = pos + cursor.offset;
		const character = cursor.next();
		if (character !== "\\" || !cursor.good()) {
			for (let unit = 0; unit < character.length; unit++) offsets.push(at + unit);
			continue;
		}
		const escaped = cursor.peek();
		if (escaped === "\n") cursor.next();
		else if (!quoted || escaped === "$" || escaped === "`" || escaped === '"' || escaped === "\\") {
			const escapedAt = pos + cursor.offset;
			cursor.next();
			for (let unit = 0; unit < escaped.length; unit++) offsets.push(escapedAt + unit);
		} else offsets.push(at);
	}
	return offsets.length === value.length ? offsets : undefined;
}

/** Source offset per static value character; undefined when an escape the text cannot place shifts one. */
export function valueOffsets(word: Word): number[] | undefined {
	const offsets: number[] = [];
	const lay = (from: number, length: number): void => {
		for (let at = from; at < from + length; at++) offsets.push(at);
	};
	if (!inPlace(word)) return undefined;
	if (word.parts === undefined) return escapedOffsets(word.text, word.pos, word.value, false);
	for (const part of word.parts) {
		switch (part.type) {
			case "Literal": {
				const laid = escapedOffsets(part.text, part.pos, part.value, false);
				if (laid === undefined) return undefined;
				offsets.push(...laid);
				break;
			}
			case "SingleQuoted":
			case "AnsiCQuoted": {
				const opening = part.type === "SingleQuoted" ? 1 : 2;
				// An escape shortens the value.
				if (part.text.length !== opening + part.value.length + 1) return undefined;
				lay(part.pos + opening, part.value.length);
				break;
			}
			case "DoubleQuoted":
			case "LocaleString":
				for (const child of part.parts) {
					const laid =
						child.type === "Literal" ? escapedOffsets(child.text, child.pos, child.value, true) : undefined;
					if (laid === undefined) return undefined;
					offsets.push(...laid);
				}
				break;
			default:
				return undefined;
		}
	}
	return offsets;
}

/** Static value over its word text, with delimiters as spaces to preserve offsets. */
export function inPlaceValue(word: Word): string | undefined {
	const value = staticValue(word);
	const offsets = valueOffsets(word);
	if (value === undefined || offsets === undefined || offsets.length !== value.length) return undefined;
	const cursor = new SourceCursor(value);
	let laid = "";
	while (cursor.good()) {
		const offset = offsets[cursor.offset] as number;
		laid += " ".repeat(offset - word.pos - laid.length) + cursor.next();
	}
	return laid + " ".repeat(word.text.length - laid.length);
}

/** Arithmetic for an indexed array; an associative array's key is a string, whose expansions still read. */
export function walkIndex(
	w: Walk,
	scope: Scope,
	array: string,
	index: string | undefined,
	parts: WordPart[] | undefined,
	at: number,
): void {
	if (index === undefined) return;
	if (resolve(w, scope, array, { local: false })?.declaredType !== "assoc") {
		const expression = parseArithmeticAt(index, at);
		if (expression !== undefined) {
			walkArithmetic(w, scope, expression);
			return;
		}
	}
	if (parts !== undefined) walkParts(w, scope, parts);
}

function walkParts(w: Walk, scope: Scope, parts: readonly WordPart[]): void {
	for (const part of parts) {
		markPart(w, part);
		switch (part.type) {
			// A text run beside an expansion in the same word: its own literal, since the word as a
			// whole is not one value. A run of stripped tabs holds none.
			case "Literal":
				if (part.value !== "") pushLiteral(w, scope, part.value, part.pos, part.end);
				break;
			case "SingleQuoted":
			case "AnsiCQuoted":
				pushLiteral(w, scope, part.value, part.pos, part.end);
				break;
			case "DoubleQuoted":
			case "LocaleString":
				if (part.parts.every((child) => child.type === "Literal")) {
					// One literal for the whole quoted text; walking the children too would report it twice.
					pushLiteral(w, scope, part.parts.map((child) => child.value).join(""), part.pos, part.end);
				} else walkParts(w, scope, part.parts);
				break;
			case "SimpleExpansion":
				expansionReference(w, scope, part.name, part);
				break;
			case "ParameterExpansion": {
				// `${!prefix*}` lists names and reads no variable.
				const listing = part.indirect === true && (part.operator === "*" || part.operator === "@");
				const role = ASSIGNING_EXPANSIONS.has(part.operator ?? "") ? "write" : "read";
				if (!listing) expansionReference(w, scope, part.name, part, role);
				walkIndex(w, scope, part.parameter, part.index, part.indexParts, part.name.end + 1);
				for (const word of [part.operand, part.replace?.pattern, part.replace?.replacement]) {
					walkWord(w, scope, word, false);
				}
				// A substring's offset and length are arithmetic.
				for (const word of [part.slice?.offset, part.slice?.length]) {
					const expression = word === undefined ? undefined : parseArithmeticAt(word.text, word.pos);
					if (expression !== undefined) walkArithmetic(w, scope, expression);
					else walkWord(w, scope, word, false);
				}
				break;
			}
			case "CommandExpansion":
			case "ProcessSubstitution":
				w.statements(subshell(scope), part.script.commands);
				break;
			case "ArithmeticExpansion":
				walkArithmetic(w, scope, part.expression);
				break;
			case "ExtendedGlob":
			case "BraceExpansion":
				// Only the quotes and expansions inside are parts.
				walkParts(w, scope, part.parts ?? []);
				break;
		}
	}
}

/** `NAME` or `NAME[...]` as an arithmetic operand. */
function arithmeticName(expression: ArithmeticWord): string | undefined {
	if (expression.parts === undefined) {
		const { name } = subscripted(expression.value);
		return IDENTIFIER_RE.test(name) ? name : undefined;
	}
	// `NAME[$i]`: the expansion sits in the subscript.
	const cursor = new SourceCursor(expression.value);
	const name = cursor.readWhile((character) => NAME_CHAR_RE.test(character));
	return IDENTIFIER_RE.test(name) && cursor.peek() === "[" ? name : undefined;
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
			const name = arithmeticName(expression);
			if (name !== undefined) {
				const selection = rangeAt(w, expression.pos, expression.pos + name.length);
				if (writer !== undefined) {
					declareOrWrite(w, scope, name, selection, selection, {
						kind: "variable",
						local: false,
						header: header ?? { start: writer.pos, end: writer.end },
					});
				} else pushReference(w, scope, { name, range: selection, role: "read" });
			}
			// Arithmetic text is no string; only its expansions are walked.
			if (expression.parts !== undefined) {
				walkParts(
					w,
					scope,
					expression.parts.filter((part) => part.type !== "Literal"),
				);
			} else if (name !== undefined) {
				const { index } = subscripted(expression.value);
				walkIndex(w, scope, name, index, undefined, expression.pos + name.length + 1);
			}
			break;
		}
	}
}

export function walkWord(w: Walk, scope: Scope, word: Word | undefined, numbers = true): void {
	if (word === undefined) return;
	if (word.parts === undefined) {
		if (numbers) bareNumber(w, scope, word);
		return;
	}
	walkParts(w, scope, word.parts);
}

export function walkWords(w: Walk, scope: Scope, words: Word[]): void {
	for (const word of words) walkWord(w, scope, word);
}

/** An unquoted assignment value is still a string; a quoted one is reported by its quotes. */
export function bareValue(w: Walk, scope: Scope, word: Word | undefined): void {
	if (word === undefined || word.parts !== undefined || word.text === "") return;
	pushLiteral(w, scope, word.text, word.pos, word.end);
}
