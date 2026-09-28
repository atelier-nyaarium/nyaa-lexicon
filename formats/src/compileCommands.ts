// The one reading of a JSON compilation database, `compile_commands.json`: each translation unit's
// include search lists and preprocessor defines, as the compiler it names would see them. Search
// directories come back absolute. Rules in formats/AGENTS.md.

import path from "node:path";
import { type Diagnostic, isTooDeep, SourceCursor, TOO_DEEP } from "@nyaa-lexicon/protocol";
// The ESM entry by path, as `json.ts` reads it, so the database reads with the same tolerance.
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser/lib/esm/main.js";

////////////////////////////////
//  Interfaces & Types

/** Where a unit's includes are searched, in the compiler's order within each list. */
export interface IncludeSearch {
	/** Whether a quoted include tries its includer's own directory first; `-I-` turns it off. */
	includerDirectory: boolean;
	/** `-iquote`, and `-I` before `-I-`: for quoted includes only. */
	quote: string[];
	/** `-I`. */
	user: string[];
	/** `-isystem`. */
	system: string[];
	/** `-idirafter`. */
	after: string[];
}

export interface CompileCommand {
	/** The translation unit. */
	file: string;
	/** The working directory its paths are relative to. */
	directory: string;
	includes: IncludeSearch;
	/** `-include` and `/FI`, as written: looked for in `directory`, then along the quoted search. */
	forcedIncludes: string[];
	/** Each name `-D` defines and `-U` leaves standing; `-DX` defines `1`. */
	defines: Record<string, string>;
	/** Names `-U` removed that no later `-D` defined again. */
	undefines: string[];
}

export interface CompileDatabase {
	commands: CompileCommand[];
	diagnostics: Diagnostic[];
}

export interface CompileDatabaseContext {
	/** Where diagnostics point. */
	module: string;
	text: string;
	/** The directory the database sits in, absolute: a relative `directory` resolves against it. */
	location: string;
}

type Flag = "quote" | "user" | "system" | "after" | "forced" | "define" | "undefine";

////////////////////////////////
//  Constants

/** Options taking a value, joined or as the next argument; longest first where one prefixes another. */
const OPTIONS: ReadonlyArray<readonly [string, Flag]> = [
	["-idirafter", "after"],
	["-isystem", "system"],
	["-iquote", "quote"],
	["-include", "forced"],
	["--include-directory=", "user"],
	["-I", "user"],
	["-D", "define"],
	["-U", "undefine"],
];

/** Options that take a value this reader has no use for, so the value is not read as an option. */
const SKIPPED_OPTIONS: ReadonlySet<string> = new Set(["-include-pch", "-imacros", "-iprefix", "-iwithprefix", "-o"]);

/** A whole option an `OPTIONS` spelling prefixes, which takes no value: `-undef` defines nothing. */
const LOOKALIKES: ReadonlySet<string> = new Set(["-undef"]);

/** Splits the quoted search from the rest: `-I` before it serves quoted includes only. */
const SPLIT_OPTION = "-I-";

/** What a backslash escapes inside POSIX double quotes; before anything else it is itself. */
const DOUBLE_QUOTED_ESCAPES: ReadonlySet<string> = new Set(["$", "`", '"', "\\", "\n"]);

/** MSVC's spellings, for a `cl` driver. */
const MSVC_OPTIONS: ReadonlyArray<readonly [string, Flag]> = [
	["/FI", "forced"],
	["/I", "user"],
	["/D", "define"],
	["/U", "undefine"],
];

////////////////////////////////
//  Functions & Helpers

function isSpace(character: string): boolean {
	return character === " " || character === "\t" || character === "\n" || character === "\r";
}

/** POSIX shell words, nothing expanded: `'` quotes literally, `"` quotes, and `\` escapes outside them. */
function splitPosix(command: string): string[] {
	const cursor = new SourceCursor(command);
	const words: string[] = [];
	let word = "";
	let started = false;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("command split failed to advance");
		guard = cursor.offset;
		const character = cursor.next();
		if (isSpace(character)) {
			if (started) words.push(word);
			word = "";
			started = false;
			continue;
		}
		started = true;
		if (character === "'") {
			word += cursor.readWhile((next) => next !== "'");
			cursor.take("'");
		} else if (character === '"') word += doubleQuoted(cursor);
		else if (character === "\\") word += escaped(cursor);
		else word += character;
	}
	if (started) words.push(word);
	return words;
}

/** The character a backslash escapes; a backslash-newline joins lines and leaves nothing. */
function escaped(cursor: SourceCursor): string {
	const character = cursor.next();
	return character === "\n" ? "" : character;
}

/** A double-quoted word's text through its closing quote: a backslash escapes only what POSIX lets it there. */
function doubleQuoted(cursor: SourceCursor): string {
	let text = "";
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("command split failed to advance");
		guard = cursor.offset;
		const character = cursor.next();
		if (character === '"') return text;
		text += character === "\\" && DOUBLE_QUOTED_ESCAPES.has(cursor.peek()) ? escaped(cursor) : character;
	}
	return text;
}

/**
 * Windows command-line words: `"` quotes, `""` inside quotes is one `"`, and a backslash is literal
 * except in a run before `"`, where each pair is one backslash and an odd one escapes the quote.
 */
function splitWindows(command: string): string[] {
	const cursor = new SourceCursor(command);
	const words: string[] = [];
	let word = "";
	let started = false;
	let quoted = false;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("command split failed to advance");
		guard = cursor.offset;
		const character = cursor.peek();
		started ||= !isSpace(character) || quoted;
		if (character === "\\") {
			const run = cursor.readWhile((next) => next === "\\");
			if (cursor.peek() !== '"') word += run;
			else {
				word += "\\".repeat(Math.floor(run.length / 2));
				if (run.length % 2 === 1) word += cursor.next();
			}
		} else if (character === '"') {
			cursor.next();
			if (quoted && cursor.peek() === '"') word += cursor.next();
			else quoted = !quoted;
		} else if (!quoted && isSpace(character)) {
			cursor.next();
			if (started) words.push(word);
			word = "";
			started = false;
		} else word += cursor.next();
	}
	if (started) words.push(word);
	return words;
}

function msvcDriver(driver: string | undefined): boolean {
	return driver !== undefined && /^(clang-)?cl(\.exe)?$/iu.test(path.basename(driver.replace(/\\/gu, "/")));
}

/**
 * A `command` string split into arguments as its driver's shell would: Windows rules for `cl` and
 * `clang-cl`, whose paths keep their backslashes, POSIX rules for the rest. Nothing expands.
 */
export function splitCommand(command: string): string[] {
	const windows = splitWindows(command);
	return msvcDriver(windows[0]) ? windows : splitPosix(command);
}

/** `argument` past `prefix`, which it starts with. */
function after(argument: string, prefix: string): string {
	const cursor = new SourceCursor(argument);
	cursor.take(prefix);
	return cursor.readWhile(() => true);
}

/** One entry's arguments read into its search lists and defines. */
function commandOf(file: string, directory: string, args: readonly string[]): CompileCommand {
	const includes: IncludeSearch = { includerDirectory: true, quote: [], user: [], system: [], after: [] };
	const forcedIncludes: string[] = [];
	const defines = new Map<string, string>();
	const undefines = new Set<string>();
	const options = msvcDriver(args[0]) ? [...OPTIONS, ...MSVC_OPTIONS] : OPTIONS;
	// Each list's members, so a repeat is found without a scan.
	const members = new Map<string[], Set<string>>();
	const listed = (list: string[], directory: string) => {
		const known = members.get(list) ?? new Set(list);
		members.set(list, known);
		if (known.has(directory)) return;
		known.add(directory);
		list.push(directory);
	};
	const take = (flag: Flag, value: string): void => {
		if (flag === "define") {
			const cursor = new SourceCursor(value);
			const name = cursor.readWhile((character) => character !== "=");
			if (name === "") return;
			defines.set(name, cursor.take("=") ? cursor.readWhile(() => true) : "1");
			undefines.delete(name);
		} else if (flag === "undefine") {
			if (value === "") return;
			defines.delete(value);
			undefines.add(value);
		} else if (flag === "forced") {
			if (value !== "") forcedIncludes.push(value);
		} else if (value !== "") listed(includes[flag], path.resolve(directory, value));
	};
	for (let index = 1; index < args.length; index++) {
		const argument = args[index] as string;
		if (LOOKALIKES.has(argument)) continue;
		if (argument === SPLIT_OPTION) {
			for (const before of includes.user) listed(includes.quote, before);
			includes.user = [];
			includes.includerDirectory = false;
			continue;
		}
		if (SKIPPED_OPTIONS.has(argument)) {
			index++;
			continue;
		}
		const option = options.find(([spelling]) => argument.startsWith(spelling));
		if (option === undefined) continue;
		const [spelling, flag] = option;
		if (argument !== spelling || spelling.endsWith("=")) take(flag, after(argument, spelling));
		else if (index + 1 < args.length) take(flag, args[++index] as string);
	}
	return {
		file: path.resolve(directory, file),
		directory,
		includes,
		forcedIncludes,
		defines: Object.fromEntries(defines),
		undefines: [...undefines],
	};
}

function problem(module: string, message: string): Diagnostic {
	return { severity: "warning", message, path: module };
}

/** Each entry that names a file, its directory and its command; a diagnostic for any that does not. */
export function readCompileCommands(context: CompileDatabaseContext): CompileDatabase {
	const { module, text, location } = context;
	const diagnostics: Diagnostic[] = [];
	const errors: ParseError[] = [];
	let value: unknown;
	try {
		value = parse(text, errors, { disallowComments: false, allowTrailingComma: true, allowEmptyContent: true });
	} catch (failure) {
		if (!isTooDeep(failure)) throw failure;
		return { commands: [], diagnostics: [{ severity: "error", message: TOO_DEEP, path: module }] };
	}
	for (const error of errors)
		diagnostics.push(problem(module, `compile_commands.json: ${printParseErrorCode(error.error)}`));
	if (!Array.isArray(value)) {
		diagnostics.push(problem(module, "compile_commands.json holds no array of commands"));
		return { commands: [], diagnostics };
	}
	const commands: CompileCommand[] = [];
	value.forEach((entry: unknown, index) => {
		const fields = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
		const { file, directory, command, arguments: listed } = fields;
		const args = Array.isArray(listed)
			? listed.filter((argument): argument is string => typeof argument === "string")
			: typeof command === "string"
				? splitCommand(command)
				: undefined;
		if (typeof file !== "string" || typeof directory !== "string" || args === undefined) {
			diagnostics.push(
				problem(module, `compile_commands.json entry ${index} needs a file, a directory and a command`),
			);
			return;
		}
		commands.push(commandOf(file, path.resolve(location, directory), args));
	});
	return { commands, diagnostics };
}
