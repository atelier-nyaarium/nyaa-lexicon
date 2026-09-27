// The interpreter a shebang names, `env` looked through; the one reading of a file's first line.

////////////////////////////////
//  Constants

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `env` options that take the next word. */
const ENV_VALUED_OPTIONS = new Set(["-u", "-C", "--unset", "--chdir"]);

////////////////////////////////
//  Functions & Helpers

/** The first line of a text, without its line ending. */
export function firstLineOf(text: string): string {
	const newline = text.indexOf("\n");
	const line = newline === -1 ? text : text.slice(0, newline);
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The program's own name; undefined for a bare directory such as `/bin/`. */
function basenameOf(program: string): string | undefined {
	const name = program.slice(program.lastIndexOf("/") + 1);
	return name === "" ? undefined : name;
}

/** Words after `#!`, split and unquoted as `env -S` does. A NUL ends the line. */
function wordsOf(line: string): string[] {
	const words: string[] = [];
	let word: string | null = null;
	let quote: string | null = null;
	for (let at = 2; at < line.length; at++) {
		const character = line[at] as string;
		if (character === "\0") break;
		if (quote !== null) {
			if (character === quote) quote = null;
			else if (character === "\\" && quote === '"' && at + 1 < line.length) word += line[++at] as string;
			else word += character;
			continue;
		}
		if (character.trim() === "") {
			if (word !== null) words.push(word);
			word = null;
			continue;
		}
		word ??= "";
		if (character === '"' || character === "'") quote = character;
		else if (character === "\\" && at + 1 < line.length) word += line[++at] as string;
		else word += character;
	}
	if (word !== null) words.push(word);
	return words;
}

/**
 * `bash` for `#!/bin/bash`, `#!/usr/bin/env bash` and `#!/usr/bin/env -S bash -e`; undefined without a shebang.
 * The name the line gives, not what one kernel runs: `env bash -e` counts, though Linux hands `env` one argument.
 */
export function shebangInterpreter(firstLine: string): string | undefined {
	if (!firstLine.startsWith("#!")) return undefined;
	const words = wordsOf(firstLine);
	if (words.length === 0) return undefined;
	const program = basenameOf(words[0] as string);
	if (program !== "env") return program;
	// `env` runs the first word that is not an option, an option's argument, or an assignment.
	for (let index = 1; index < words.length; index++) {
		const word = words[index] as string;
		if (word === "--") return basenameOf(words[index + 1] ?? "");
		if (ENV_VALUED_OPTIONS.has(word)) {
			index++;
			continue;
		}
		if (word.startsWith("-") || ASSIGNMENT_RE.test(word)) continue;
		return basenameOf(word);
	}
	return undefined;
}
