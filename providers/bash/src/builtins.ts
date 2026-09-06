// The builtins that declare or write a variable, and the assignment prefix before a command.

import { defined } from "@nyaa-lexicon/protocol";
import type { AssignmentPrefix, Word } from "unbash";
import {
	FUNCTION_NAME_RE,
	IDENTIFIER_RE,
	pushOpaque,
	pushReference,
	rangeAt,
	type Scope,
	staticValue,
	type Walk,
	wordRange,
} from "./context.js";
import { confinedIn, declare, declareOrWrite, resolve } from "./scope.js";
import { bareValue, declareOrWriteWord, walkIndex, walkWord, walkWords } from "./words.js";

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

const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/;
const LET_RE = /(\+\+|--)?([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\s*(\+\+|--|(?:<<|>>|[-+*/%&|^])?=(?!=))?/g;
const NO_VALUES: ReadonlySet<string> = new Set();
const READ_VALUED = new Set(["a", "d", "i", "n", "N", "p", "t", "u"]);
const MAPFILE_VALUED = new Set(["d", "n", "O", "s", "u", "C", "c"]);
const PRINTF_VALUED = new Set(["v"]);

////////////////////////////////
//  Functions & Helpers

/** Flags cluster after one dash, `--` ends them, a valued flag takes the next word, and the first operand ends them too. */
function options(words: Word[], valued: ReadonlySet<string>): Options {
	const parsed: Options = { flags: new Set(), valued: new Map(), operands: [] };
	let index = 0;
	for (; index < words.length; index++) {
		const text = (words[index] as Word).text;
		if (!text.startsWith("-") || text === "-") break;
		if (text === "--") {
			index++;
			break;
		}
		for (const flag of text.slice(1)) parsed.flags.add(flag);
		const last = text.at(-1) as string;
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
			});
		}
		walkIndex(w, scope, prefix.index, prefix.indexParts, prefix.pos + prefix.text.indexOf("[") + 1);
	}
	bareValue(w, scope, prefix.value);
	walkWord(w, scope, prefix.value, false);
	// The name and its `=` are data; the value marks itself, and an array body may hold a comment.
	const valueAt =
		prefix.value?.pos ?? (prefix.array === undefined ? prefix.end : prefix.pos + prefix.text.indexOf("(") + 1);
	pushOpaque(w, prefix.pos, valueAt);
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
	for (const word of operands) {
		const text = word.text;
		const spelled = staticValue(word) ?? text;
		const match = ASSIGNMENT_RE.exec(spelled);
		const name = match?.[1] ?? (IDENTIFIER_RE.test(spelled) ? spelled : undefined);
		if (name === undefined) {
			walkWord(w, scope, word);
			continue;
		}
		const nameAt = word.pos + text.indexOf(name);
		const selection = rangeAt(w, nameAt, nameAt + name.length);
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
		if (match === null && (existing !== undefined || unexport)) continue;
		declareOrWrite(w, scope, name, selection, wordRange(w, word), {
			kind: constant ? "constant" : "variable",
			local,
			global,
			...(exported ? { exported } : {}),
			...defined({ declaredType }),
		});
		if (match !== null) {
			const value = spelled.slice(match[0].length);
			if (nameref && IDENTIFIER_RE.test(value)) {
				const at = word.pos + text.indexOf(value, text.indexOf("=") + 1);
				pushReference(w, scope, { name: value, range: rangeAt(w, at, at + value.length), role: "read" });
			} else if (!value.startsWith("(")) bareValue(w, scope, word, match[0].length);
		}
		walkWord(w, scope, word, false);
	}
}

/** `read` writes every name after its options; `-a` names an array. */
export function reading(w: Walk, scope: Scope, words: Word[]): void {
	const { valued, operands } = options(words, READ_VALUED);
	for (const [flag, word] of valued) {
		if (flag === "a") declareOrWriteWord(w, scope, word, "array");
		else walkWord(w, scope, word);
	}
	for (const word of operands) declareOrWriteWord(w, scope, word);
}

/** `mapfile` and `readarray` fill the array named after their options. */
export function mapping(w: Walk, scope: Scope, words: Word[]): void {
	const { valued, operands } = options(words, MAPFILE_VALUED);
	for (const word of valued.values()) walkWord(w, scope, word);
	declareOrWriteWord(w, scope, operands[0], "array");
}

/** `printf -v NAME` writes the name in place of printing. */
export function printing(w: Walk, scope: Scope, words: Word[]): void {
	const { valued, operands } = options(words, PRINTF_VALUED);
	declareOrWriteWord(w, scope, valued.get("v"));
	walkWords(w, scope, operands);
}

/** Each `let` word is an arithmetic expression; a name before `=` or beside `++` is written, else read. */
export function letting(w: Walk, scope: Scope, words: Word[]): void {
	for (const word of words) {
		const spelled = staticValue(word);
		if (spelled === undefined) {
			walkWord(w, scope, word, false);
			continue;
		}
		pushOpaque(w, word.pos, word.end);
		let cursor = 0;
		for (const match of spelled.matchAll(LET_RE)) {
			const name = match[2] as string;
			const at = word.pos + word.text.indexOf(name, cursor);
			cursor = at - word.pos + name.length;
			const range = rangeAt(w, at, at + name.length);
			if (match[1] !== undefined || match[3] !== undefined) {
				declareOrWrite(w, scope, name, range, range, { kind: "variable", local: false });
			} else pushReference(w, scope, { name, range, role: "read" });
		}
	}
}

/** `unset` writes what it removes; `-f` names functions. */
export function unsetting(w: Walk, scope: Scope, words: Word[]): void {
	const { flags, operands } = options(words, NO_VALUES);
	const functions = flags.has("f");
	for (const word of operands) {
		const name = word.value.replace(/\[.*$/, "");
		if (!(functions ? FUNCTION_NAME_RE : IDENTIFIER_RE).test(name)) {
			walkWord(w, scope, word);
			continue;
		}
		const range = rangeAt(w, word.pos, word.pos + name.length);
		if (functions) pushReference(w, scope, { name, range, role: "write", ofFunction: true });
		else {
			const target = resolve(w, scope, name, { local: false })?.symbolId;
			pushReference(w, scope, { name, range, role: "write", ...defined({ target }) });
		}
		walkWord(w, scope, word, false);
	}
}

export function aliases(w: Walk, scope: Scope, words: Word[]): void {
	for (const word of options(words, NO_VALUES).operands) {
		const match = /^([^=\s]+)=/.exec(word.text);
		if (match === null) continue;
		const name = match[1] as string;
		declare(w, scope, name, rangeAt(w, word.pos, word.pos + name.length), wordRange(w, word), {
			kind: "function",
			local: false,
			languageKind: "alias",
		});
		walkWord(w, scope, word, false);
	}
}

export function sourced(w: Walk, scope: Scope, word: Word | undefined): void {
	if (word === undefined) return;
	const value = staticValue(word);
	const specifier = value ?? word.text;
	const range = wordRange(w, word);
	w.out.sources.push({ specifier, literal: value !== undefined, range });
	w.out.imports.push({ specifier, imported: [], reExport: false });
	pushReference(w, scope, { name: specifier, range, role: "import" });
	walkWord(w, scope, word, false);
}
