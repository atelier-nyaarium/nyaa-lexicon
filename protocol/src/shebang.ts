// The interpreter a shebang names, `env` looked through; the one reading of a file's first line.

////////////////////////////////
//  Constants

const SHEBANG_RE = /^#![ \t]*([^\s\0]+)((?:[ \t]+[^\s\0]+)*)/;
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

/**
 * `bash` for `#!/bin/bash`, `#!/usr/bin/env bash` and `#!/usr/bin/env -S bash -e`; undefined without a shebang.
 * The name the line gives, not what one kernel runs: `env bash -e` counts, though Linux hands `env` one argument.
 */
export function shebangInterpreter(firstLine: string): string | undefined {
	const match = SHEBANG_RE.exec(firstLine);
	if (match === null) return undefined;
	const words = [match[1] as string, ...(match[2] as string).trim().split(/[ \t]+/)].filter((word) => word !== "");
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
