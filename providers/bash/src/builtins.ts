// The builtins that declare or write a variable, and the assignment prefix before a command.

import { type Conflict, defined, type ImportEdge, type Range, SourceCursor } from "@nyaa-lexicon/protocol";
import {
	assignmentOf,
	expandsPath,
	FUNCTION_NAME_RE,
	IDENTIFIER_RE,
	pushLiteral,
	pushReference,
	rangeAt,
	type Scope,
	staticValue,
	subscripted,
	type Walk,
	wordRange,
} from "./context.js";
import { assignmentFolds, commandHeader, leadOf, operandHeader } from "./header.js";
import { confinedIn, declare, declareOrWrite, resolve } from "./scope.js";
import type { AssignmentPrefix, Word } from "./syntax/ast.js";
import { parseArithmeticAt } from "./syntax/parser.js";
import {
	bareValue,
	declareOrWriteWord,
	inPlaceValue,
	markQuoted,
	nameRange,
	valueOffsets,
	walkArithmetic,
	walkIndex,
	walkWord,
	walkWords,
} from "./words.js";

////////////////////////////////
//  Interfaces & Types

interface Options {
	flags: Set<string>;
	/** Each valued option's word, by its flag. */
	valued: Map<string, Word>;
	operands: Word[];
}

////////////////////////////////
//  Constants

export const DECLARING = new Set(["local", "declare", "typeset", "readonly", "export"]);

const NO_VALUES: ReadonlySet<string> = new Set();
const READ_VALUED = new Set(["a", "d", "i", "n", "N", "p", "t", "u"]);
const MAPFILE_VALUED = new Set(["d", "n", "O", "s", "u", "C", "c"]);
const PRINTF_VALUED = new Set(["v"]);
const BLANK_RE = /^\s$/;

/** A later definition replaces an earlier one, sourced or local. */
const LATER_WINS: Conflict = { priority: 0, amongTransfers: "laterWins", againstLocal: "sourceOrder" };

////////////////////////////////
//  Functions & Helpers

/** Flags cluster after one dash, `--` ends them, a valued flag takes the next word, and the first operand ends them too. */
function options(words: Word[], valued: ReadonlySet<string>): Options {
	const parsed: Options = { flags: new Set(), valued: new Map(), operands: [] };
	let index = 0;
	for (; index < words.length; index++) {
		const text = (words[index] as Word).text;
		if (text === "--") {
			index++;
			break;
		}
		const cursor = new SourceCursor(text);
		if (cursor.next() !== "-" || !cursor.good()) break;
		let last = "";
		while (cursor.good()) {
			last = cursor.next();
			parsed.flags.add(last);
		}
		if (valued.has(last) && index + 1 < words.length) {
			index++;
			parsed.valued.set(last, words[index] as Word);
		}
	}
	parsed.operands = words.slice(index);
	return parsed;
}

export function walkAssignmentPrefix(w: Walk, scope: Scope, prefix: AssignmentPrefix, beforeCommand: boolean): void {
	const name = prefix.name;
	if (name !== undefined && IDENTIFIER_RE.test(name)) {
		const selection = rangeAt(w, prefix.pos, prefix.pos + name.length);
		// `NAME=value cmd` binds NAME for that command alone; it declares nothing.
		if (beforeCommand) {
			const existing = resolve(w, scope, name, { local: false });
			if (existing !== undefined)
				pushReference(w, scope, { name, range: selection, role: "write", target: existing.symbolId });
		} else {
			declareOrWrite(w, scope, name, selection, rangeAt(w, prefix.pos, prefix.end), {
				kind: "variable",
				local: false,
				header: { start: prefix.pos, end: prefix.end, folds: assignmentFolds(prefix.text, prefix.pos) },
			});
		}
		walkIndex(w, scope, name, prefix.index, prefix.indexParts, prefix.pos + name.length + 1);
	}
	bareValue(w, scope, prefix.value);
	walkWord(w, scope, prefix.value, false);
	for (const word of prefix.array ?? []) walkWord(w, scope, word);
}

/** `local`, `declare`, `typeset`, `readonly` and `export`, each naming variables after its flags. */
export function declaring(w: Walk, scope: Scope, builtin: string, command: Word, words: Word[]): void {
	if (builtin === "local" && scope.descriptor === undefined) {
		w.out.diagnostics.push({
			severity: "error",
			message: "local: can only be used in a function",
			range: wordRange(w, command),
			path: w.module,
		});
		walkWords(w, scope, words);
		return;
	}
	const { flags, operands } = options(words, NO_VALUES);
	const lead = leadOf(command, words, operands);
	for (const word of operands) {
		const text = word.text;
		const spelled = staticValue(word) ?? text;
		const head = assignmentOf(spelled);
		const name = head?.name ?? (IDENTIFIER_RE.test(spelled) ? spelled : undefined);
		if (name === undefined) {
			walkWord(w, scope, word);
			continue;
		}
		const offsets = readOffsets(word);
		// An escape in the value alone leaves the head where the text spells it.
		const written = assignmentOf(text);
		const aligned = written?.name === name ? written : undefined;
		const selection =
			readRange(w, offsets, 0, name.length) ??
			(aligned === undefined ? wordRange(w, word) : rangeAt(w, word.pos, word.pos + name.length));
		// `-p` prints and `-f` names a function; neither declares a variable.
		if (flags.has("p")) {
			pushReference(w, scope, { name, range: selection, role: "read" });
			continue;
		}
		if (flags.has("f") || flags.has("F")) {
			pushReference(w, scope, { name, range: selection, role: "read", ofFunction: true });
			continue;
		}
		const constant = builtin === "readonly" || flags.has("r");
		const global = flags.has("g") && !confinedIn(scope);
		const local =
			builtin === "local" ||
			((builtin === "declare" || builtin === "typeset") && !global && scope.descriptor !== undefined);
		const nameref = builtin !== "export" && flags.has("n");
		const unexport = builtin === "export" && flags.has("n");
		const declaredType = nameref
			? "nameref"
			: flags.has("A")
				? "assoc"
				: flags.has("a")
					? "array"
					: flags.has("i")
						? "integer"
						: undefined;
		const exported = (builtin === "export" && !unexport) || flags.has("x");
		const existing = resolve(w, scope, name, { local, global });
		// Naming a declared variable again changes what it is; only a value writes it.
		if (existing !== undefined) {
			if (exported) existing.exported = true;
			if (unexport) existing.exported = false;
			if (constant) existing.kind = "constant";
			if (declaredType !== undefined) existing.declaredType = declaredType;
		}
		if (head === undefined && (existing !== undefined || unexport)) continue;
		declareOrWrite(w, scope, name, selection, wordRange(w, word), {
			kind: constant ? "constant" : "variable",
			local,
			global,
			...(exported ? { exported } : {}),
			...defined({ declaredType }),
			header: { ...operandHeader(lead, word), folds: assignmentFolds(text, word.pos) },
		});
		if (head !== undefined) {
			const value = head.value;
			if (nameref && IDENTIFIER_RE.test(value)) {
				const range = readRange(w, offsets, head.valueAt, head.valueAt + value.length) ?? wordRange(w, word);
				pushReference(w, scope, { name: value, range, role: "read" });
			} else if (!head.array && word.parts === undefined && aligned !== undefined && aligned.value !== "") {
				pushLiteral(w, scope, aligned.value, word.pos + aligned.valueAt, word.end);
			}
		}
		walkWord(w, scope, word, false);
	}
}

/** Where `declare` reads each character of an operand, in its text; undefined when an escape moves one. */
function readOffsets(word: Word): readonly number[] | undefined {
	if (staticValue(word) !== undefined) return valueOffsets(word);
	return Array.from({ length: word.text.length }, (_, index) => word.pos + index);
}

/** The text holding what `declare` reads from character `from` to `to`. */
function readRange(w: Walk, offsets: readonly number[] | undefined, from: number, to: number): Range | undefined {
	const first = offsets?.[from];
	const last = offsets?.[to - 1];
	return first === undefined || last === undefined ? undefined : rangeAt(w, first, last + 1);
}

/** `read` writes every name after its options; `-a` names an array. */
export function reading(w: Walk, scope: Scope, command: Word, words: Word[]): void {
	const { valued, operands } = options(words, READ_VALUED);
	for (const [flag, word] of valued) {
		if (flag === "a") declareOrWriteWord(w, scope, word, (named) => commandHeader(command, named), "array");
		else walkWord(w, scope, word);
	}
	const lead = leadOf(command, words, operands);
	for (const word of operands) declareOrWriteWord(w, scope, word, (named) => operandHeader(lead, named));
}

/** `mapfile` and `readarray` fill the array named after their options. */
export function mapping(w: Walk, scope: Scope, command: Word, words: Word[]): void {
	const { valued, operands } = options(words, MAPFILE_VALUED);
	for (const word of valued.values()) walkWord(w, scope, word);
	declareOrWriteWord(w, scope, operands[0], (named) => commandHeader(command, named), "array");
}

/** `printf -v NAME` writes the name in place of printing. */
export function printing(w: Walk, scope: Scope, command: Word, words: Word[]): void {
	const { valued, operands } = options(words, PRINTF_VALUED);
	declareOrWriteWord(w, scope, valued.get("v"), (named) => commandHeader(command, named));
	walkWords(w, scope, operands);
}

/** Each static `let` word is an arithmetic expression, read in place; an escape leaves it unread. */
export function letting(w: Walk, scope: Scope, command: Word, words: Word[]): void {
	const lead = { start: command.pos, end: command.end };
	for (const word of words) {
		if (staticValue(word) === undefined) {
			walkWord(w, scope, word, false);
			continue;
		}
		markQuoted(w, word);
		const laid = inPlaceValue(word);
		if (laid === undefined) continue;
		walkArithmetic(w, scope, parseArithmeticAt(laid, word.pos), operandHeader(lead, word));
	}
}

/** `unset` writes what it removes; `-f` names functions. */
export function unsetting(w: Walk, scope: Scope, words: Word[]): void {
	const { flags, operands } = options(words, NO_VALUES);
	const functions = flags.has("f");
	for (const word of operands) {
		const { name } = subscripted(word.value);
		if (!(functions ? FUNCTION_NAME_RE : IDENTIFIER_RE).test(name)) {
			walkWord(w, scope, word);
			continue;
		}
		const range = nameRange(w, word, name);
		if (functions) pushReference(w, scope, { name, range, role: "write", ofFunction: true });
		else {
			const target = resolve(w, scope, name, { local: false })?.symbolId;
			pushReference(w, scope, { name, range, role: "write", ...defined({ target }) });
		}
		walkWord(w, scope, word, false);
	}
}

export function aliases(w: Walk, scope: Scope, command: Word, words: Word[]): void {
	const { operands } = options(words, NO_VALUES);
	const lead = leadOf(command, words, operands);
	for (const word of operands) {
		const cursor = new SourceCursor(word.text);
		const name = cursor.readWhile((character) => character !== "=" && !BLANK_RE.test(character));
		if (name === "" || cursor.next() !== "=") continue;
		declare(w, scope, name, rangeAt(w, word.pos, word.pos + name.length), wordRange(w, word), {
			kind: "function",
			local: false,
			languageKind: "alias",
			header: operandHeader(lead, word),
		});
		walkWord(w, scope, word, false);
	}
}

/** `source f` or `. f`: the sourced file's definitions run in this scope. */
export function sourced(w: Walk, scope: Scope, command: Word, word: Word | undefined): void {
	if (word === undefined) return;
	const specifier = staticValue(word) ?? word.text;
	const range = wordRange(w, word);
	const literal = !expandsPath(word);
	w.out.sources.push({ specifier, literal, range });
	const edge: ImportEdge = {
		kind: "injection",
		span: rangeAt(w, command.pos, word.end),
		bindsLocally: true,
		selector: { kind: "visible" },
		conflict: LATER_WINS,
		certainty: literal ? { status: "known" } : { status: "unknown", reason: "RuntimeConstructed" },
		order: w.out.imports.length,
	};
	w.out.imports.push({ specifier, edges: [edge] });
	pushReference(w, scope, { name: specifier, range, role: "import" });
	walkWord(w, scope, word, false);
}
