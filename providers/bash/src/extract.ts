// unbash owns the grammar and every position; this file owns what the tree means to an index.

import {
	comparePositions,
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type Import,
	type Literal,
	parseSymbolId,
	type Range,
	type Reference,
	type SymbolKind,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import {
	type ArithmeticExpression,
	type AssignmentPrefix,
	type Command,
	type Node,
	parse,
	type Redirect,
	type Statement,
	type TestExpression,
	type Word,
	type WordPart,
} from "unbash";

////////////////////////////////
//  Interfaces & Types

export type DeclaredType = "array" | "assoc" | "integer" | "nameref";

export interface BashDeclaration extends Declaration {
	/** From a declaring builtin's `-a`, `-A`, `-i` or `-n`; a shell variable is otherwise a string. */
	declaredType?: DeclaredType;
}

/** A reference before binding; a command name is kept only when it binds to a function. */
export interface BashReference {
	name: string;
	range: Range;
	role: Reference["role"];
	fromId?: string;
	/** The declaration in this file the name settled on. */
	target?: string;
	/** The name is a function's, not a variable's. */
	command?: boolean;
}

export interface SourceImport {
	specifier: string;
	/** False when the path holds an expansion, so nothing static resolves it. */
	literal: boolean;
	range: Range;
}

export interface ParsedBashFile {
	module: string;
	text: string;
	declarations: BashDeclaration[];
	references: BashReference[];
	imports: Import[];
	sources: SourceImport[];
	literals: Literal[];
	diagnostics: Diagnostic[];
	/** Every definition of a name in source order; the last is the one a call reaches. */
	functionsByName: Map<string, BashDeclaration[]>;
	globalsByName: Map<string, BashDeclaration>;
}

interface Scope {
	fromId?: string;
	/** The enclosing function's descriptor, so a local's id nests under it. */
	descriptor?: Descriptor;
	locals: Map<string, BashDeclaration>;
	parent?: Scope;
	/** A subshell keeps every assignment to itself. */
	confined: boolean;
}

/** A reference and the scope it was read in; targets settle after the whole file is read. */
interface Pending {
	reference: BashReference;
	scope: Scope;
}

interface Walk {
	module: string;
	/** The text unbash read: the file without its byte order mark. */
	text: string;
	/** Code units the file holds before the parsed text. */
	shift: number;
	coordinates: TextCoordinates;
	out: ParsedBashFile;
	pending: Pending[];
	/** Where the next here-document body may begin; bodies on one line stack. */
	heredocNext: number;
	/** Name paths already minted, so a repeat carries an occurrence. */
	minted: Map<string, number>;
	/** Where each function was defined, since one defined in a subshell is unknown outside it. */
	definedIn: WeakMap<BashDeclaration, Scope>;
}

interface DeclareOptions {
	kind: SymbolKind;
	local: boolean;
	/** `declare -g` names the file's variable even inside a function. */
	global?: boolean;
	exported?: boolean;
	declaredType?: DeclaredType;
	languageKind?: string;
}

////////////////////////////////
//  Constants

export const LANGUAGE = "bash";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A function may carry what a variable may not, short of the shell's own metacharacters. */
const FUNCTION_NAME_RE = /^[A-Za-z_.][A-Za-z0-9_.:@+,-]*$/;
const NUMBER_RE = /^[0-9]+$/;
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const LET_RE = /(\+\+|--)?([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\s*(\+\+|--|(?:<<|>>|[-+*/%&|^])?=(?!=))?/g;
const DECLARING = new Set(["local", "declare", "typeset", "readonly", "export"]);
/** `read` options that take the next word; `-a` names the array and is handled apart. */
const READ_VALUED = new Set(["d", "i", "n", "N", "p", "t", "u"]);
const MAPFILE_VALUED = new Set(["d", "n", "O", "s", "u", "C", "c"]);
const ARITHMETIC_WRITES = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "|=", "^="]);
const ASSIGNING_EXPANSIONS = new Set(["=", ":="]);

////////////////////////////////
//  Functions & Helpers

/** A word may end on the `\r` of a line ending, which is no position; the line's content end is. */
function clamp(w: Walk, offset: number): number {
	return w.text[offset] === "\n" && w.text[offset - 1] === "\r" ? offset - 1 : offset;
}

function rangeAt(w: Walk, start: number, end: number): Range {
	const range = w.coordinates.rangeAt(clamp(w, start) + w.shift, clamp(w, end) + w.shift);
	if (range !== undefined) return range;
	const zero = { line: 0, character: 0 };
	return { start: zero, end: zero };
}

function wordRange(w: Walk, word: Word): Range {
	return rangeAt(w, word.pos, word.end);
}

/** A word's value when nothing in it expands at run time. */
function staticValue(word: Word | undefined): string | undefined {
	if (word === undefined) return undefined;
	const parts = word.parts;
	if (parts === undefined) return word.value;
	return parts.every(isStatic) ? word.value : undefined;
}

function isStatic(part: WordPart): boolean {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
		case "AnsiCQuoted":
			return true;
		case "DoubleQuoted":
		case "LocaleString":
			return part.parts.every((child) => child.type === "Literal");
		default:
			return false;
	}
}

function pushLiteral(w: Walk, scope: Scope, value: string, start: number, end: number): void {
	const number = NUMBER_RE.test(value) ? Number(value) : undefined;
	w.out.literals.push({
		kind: number === undefined ? "string" : "number",
		value,
		...(number === undefined ? {} : { number }),
		range: rangeAt(w, start, end),
		...(scope.fromId === undefined ? {} : { containerId: scope.fromId }),
	});
}

function pushReference(w: Walk, scope: Scope, reference: BashReference): void {
	w.pending.push({
		reference: { ...reference, ...(scope.fromId === undefined ? {} : { fromId: scope.fromId }) },
		scope,
	});
}

function subshell(scope: Scope): Scope {
	return {
		...(scope.fromId === undefined ? {} : { fromId: scope.fromId }),
		...(scope.descriptor === undefined ? {} : { descriptor: scope.descriptor }),
		locals: new Map(),
		parent: scope,
		confined: true,
	};
}

/** Inside a subshell at any depth, nothing reaches the file's variables, `-g` included. */
function confinedIn(scope: Scope): boolean {
	for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) if (s.confined) return true;
	return false;
}

/** The declaration a name reaches while walking: the nearest enclosing local, then the file's. */
function held(w: Walk, scope: Scope, name: string, options: Pick<DeclareOptions, "local" | "global">) {
	if (options.global) return w.out.globalsByName.get(name);
	if (options.local) return scope.locals.get(name);
	for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) {
		const local = s.locals.get(name);
		if (local !== undefined) return local;
	}
	return w.out.globalsByName.get(name);
}

/** A repeated name path carries an occurrence, so what it holds nests under its own definition. */
function mint(w: Walk, descriptors: Descriptor[]): string {
	const base = composeSymbolId({ language: LANGUAGE, module: w.module, descriptors });
	const seen = (w.minted.get(base) ?? 0) + 1;
	w.minted.set(base, seen);
	if (seen === 1) return base;
	const last = descriptors.at(-1) as Descriptor;
	return composeSymbolId({
		language: LANGUAGE,
		module: w.module,
		descriptors: [...descriptors.slice(0, -1), { ...last, occurrence: seen }],
	});
}

function declare(
	w: Walk,
	scope: Scope,
	name: string,
	selection: Range,
	range: Range,
	options: DeclareOptions,
): BashDeclaration {
	const confined = options.local || scope.confined;
	const nested = confined && scope.descriptor !== undefined;
	const own: Descriptor = { kind: options.kind === "function" ? "method" : "term", name };
	const declaration: BashDeclaration = {
		symbolId: mint(w, nested && scope.descriptor !== undefined ? [scope.descriptor, own] : [own]),
		kind: options.kind,
		...(options.languageKind === undefined ? {} : { languageKind: options.languageKind }),
		name,
		range,
		selectionRange: selection,
		visibility: confined ? "local" : "public",
		...(options.exported === undefined ? {} : { exported: options.exported }),
		...(nested && scope.fromId !== undefined ? { containerId: scope.fromId } : {}),
		...(options.declaredType === undefined ? {} : { declaredType: options.declaredType }),
	};
	w.out.declarations.push(declaration);
	if (options.kind === "function") {
		w.definedIn.set(declaration, scope);
		const definitions = w.out.functionsByName.get(name);
		if (definitions === undefined) w.out.functionsByName.set(name, [declaration]);
		else definitions.push(declaration);
	} else if (confined) scope.locals.set(name, declaration);
	else w.out.globalsByName.set(name, declaration);
	return declaration;
}

/** An assignment declares a name the first time and writes it after. */
function assign(w: Walk, scope: Scope, name: string, selection: Range, range: Range, options: DeclareOptions): void {
	const existing = held(w, scope, name, options);
	if (existing !== undefined) {
		pushReference(w, scope, { name, range: selection, role: "write", target: existing.symbolId });
		return;
	}
	declare(w, scope, name, selection, range, options);
}

function assignWord(w: Walk, scope: Scope, word: Word | undefined, declaredType?: DeclaredType): void {
	if (word === undefined) return;
	const name = word.value.replace(/\[.*$/, "");
	if (!IDENTIFIER_RE.test(name)) {
		walkWord(w, scope, word);
		return;
	}
	const selection = rangeAt(w, word.pos, word.pos + name.length);
	assign(w, scope, name, selection, wordRange(w, word), {
		kind: "variable",
		local: false,
		...(declaredType === undefined ? {} : { declaredType }),
	});
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
	if (role === "write")
		assign(w, scope, name, range, rangeAt(w, at, at + text.length), { kind: "variable", local: false });
	else pushReference(w, scope, { name, range, role });
}

/** A subscript is arithmetic, where a bare name is a variable, unless it holds an expansion. */
function walkIndex(w: Walk, scope: Scope, index: string | undefined, parts: WordPart[] | undefined, at: number): void {
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
				break;
			}
			case "CommandExpansion":
			case "ProcessSubstitution":
				if (part.script !== undefined) walkStatements(w, subshell(scope), part.script.commands);
				break;
			case "ArithmeticExpansion":
				walkArithmetic(w, scope, part.expression);
				break;
			default:
				break;
		}
		at = end;
	}
}

/** Inside arithmetic a bare name is the variable; an assignment or `++` writes it. */
function walkArithmetic(w: Walk, scope: Scope, expression: ArithmeticExpression | undefined, write = false): void {
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
			if (write) assign(w, scope, name, selection, selection, { kind: "variable", local: false });
			else pushReference(w, scope, { name, range: selection, role: "read" });
			if (bracket !== -1) {
				walkIndex(w, scope, expression.value.slice(bracket + 1, -1), undefined, expression.pos + bracket + 1);
			}
			break;
		}
		case "ArithmeticCommandExpansion":
			if (expression.script !== undefined) walkStatements(w, subshell(scope), expression.script.commands);
			break;
	}
}

function walkWord(w: Walk, scope: Scope, word: Word | undefined, numbers = true): void {
	if (word === undefined) return;
	if (word.parts === undefined) {
		if (numbers && NUMBER_RE.test(word.text)) pushLiteral(w, scope, word.text, word.pos, word.end);
		return;
	}
	walkParts(w, scope, word.parts, word.pos);
}

function walkWords(w: Walk, scope: Scope, words: Word[]): void {
	for (const word of words) walkWord(w, scope, word);
}

/** An unquoted assignment value is still a string; a quoted one is reported by its quotes. */
function bareValue(w: Walk, scope: Scope, word: Word | undefined, from = 0): void {
	if (word === undefined || word.parts !== undefined) return;
	const text = word.text.slice(from);
	if (text !== "") pushLiteral(w, scope, text, word.pos + from, word.end);
}

function assignment(w: Walk, scope: Scope, prefix: AssignmentPrefix, beforeCommand: boolean): void {
	const name = prefix.name;
	if (name !== undefined && IDENTIFIER_RE.test(name)) {
		const selection = rangeAt(w, prefix.pos, prefix.pos + name.length);
		// `NAME=value cmd` binds NAME for that command alone; it declares nothing.
		if (beforeCommand) {
			const existing = held(w, scope, name, { local: false });
			if (existing !== undefined)
				pushReference(w, scope, { name, range: selection, role: "write", target: existing.symbolId });
		} else {
			assign(w, scope, name, selection, rangeAt(w, prefix.pos, prefix.end), { kind: "variable", local: false });
		}
		walkIndex(w, scope, prefix.index, prefix.indexParts, prefix.pos + prefix.text.indexOf("[") + 1);
	}
	bareValue(w, scope, prefix.value);
	walkWord(w, scope, prefix.value, false);
	for (const word of prefix.array ?? []) walkWord(w, scope, word);
}

/** `local`, `declare`, `typeset`, `readonly` and `export`, each naming variables after its flags. */
function declaring(w: Walk, scope: Scope, builtin: string, command: Word, words: Word[]): void {
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
	const flags = new Set<string>();
	let names = false;
	for (const word of words) {
		const text = word.text;
		if (!names && text.startsWith("-")) {
			if (text === "--") names = true;
			else for (const flag of text.slice(1)) flags.add(flag);
			continue;
		}
		names = true;
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
			pushReference(w, scope, { name, range: selection, role: "read", command: true });
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
		const existing = held(w, scope, name, { local, global });
		// Naming a declared variable again changes what it is; only a value writes it.
		if (existing !== undefined) {
			if (exported) existing.exported = true;
			if (unexport) existing.exported = false;
			if (constant) existing.kind = "constant";
			if (declaredType !== undefined) existing.declaredType = declaredType;
		}
		if (match === null && (existing !== undefined || unexport)) continue;
		assign(w, scope, name, selection, wordRange(w, word), {
			kind: constant ? "constant" : "variable",
			local,
			global,
			...(exported ? { exported } : {}),
			...(declaredType === undefined ? {} : { declaredType }),
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
function reading(w: Walk, scope: Scope, words: Word[]): void {
	let next: "skip" | "array" | undefined;
	for (const word of words) {
		const text = word.text;
		if (next === "array") {
			assignWord(w, scope, word, "array");
			next = undefined;
		} else if (next === "skip") {
			walkWord(w, scope, word);
			next = undefined;
		} else if (text.startsWith("-")) {
			const last = text.at(-1) ?? "";
			next = last === "a" ? "array" : READ_VALUED.has(last) ? "skip" : undefined;
		} else assignWord(w, scope, word);
	}
}

/** `mapfile` and `readarray` fill the array named after their options. */
function mapping(w: Walk, scope: Scope, words: Word[]): void {
	let skip = false;
	for (const word of words) {
		const text = word.text;
		if (skip) {
			walkWord(w, scope, word);
			skip = false;
		} else if (text.startsWith("-")) skip = MAPFILE_VALUED.has(text.at(-1) ?? "");
		else {
			assignWord(w, scope, word, "array");
			return;
		}
	}
}

/** `printf -v NAME` writes the name in place of printing. */
function printing(w: Walk, scope: Scope, words: Word[]): void {
	let next = false;
	for (const word of words) {
		if (next) assignWord(w, scope, word);
		else walkWord(w, scope, word);
		next = word.text === "-v";
	}
}

/** Each `let` word is an arithmetic expression; a name before `=` or beside `++` is written, else read. */
function letting(w: Walk, scope: Scope, words: Word[]): void {
	for (const word of words) {
		const spelled = staticValue(word);
		if (spelled === undefined) {
			walkWord(w, scope, word, false);
			continue;
		}
		let cursor = 0;
		for (const match of spelled.matchAll(LET_RE)) {
			const name = match[2] as string;
			const at = word.pos + word.text.indexOf(name, cursor);
			cursor = at - word.pos + name.length;
			const range = rangeAt(w, at, at + name.length);
			if (match[1] !== undefined || match[3] !== undefined) {
				assign(w, scope, name, range, range, { kind: "variable", local: false });
			} else pushReference(w, scope, { name, range, role: "read" });
		}
	}
}

/** `unset` writes what it removes; `-f` names functions. */
function unsetting(w: Walk, scope: Scope, words: Word[]): void {
	let functions = false;
	let names = false;
	for (const word of words) {
		const text = word.text;
		if (!names && text.startsWith("-")) {
			if (text === "--") names = true;
			else if (text.includes("f")) functions = true;
			continue;
		}
		names = true;
		const name = word.value.replace(/\[.*$/, "");
		if (!(functions ? FUNCTION_NAME_RE : IDENTIFIER_RE).test(name)) {
			walkWord(w, scope, word);
			continue;
		}
		const range = rangeAt(w, word.pos, word.pos + name.length);
		if (functions) {
			pushReference(w, scope, { name, range, role: "write", command: true });
			continue;
		}
		const target = held(w, scope, name, { local: false })?.symbolId;
		pushReference(w, scope, { name, range, role: "write", ...(target === undefined ? {} : { target }) });
	}
}

function aliases(w: Walk, scope: Scope, words: Word[]): void {
	let names = false;
	for (const word of words) {
		if (!names && word.text.startsWith("-")) {
			names = word.text === "--";
			continue;
		}
		names = true;
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

function sourced(w: Walk, scope: Scope, word: Word | undefined): void {
	if (word === undefined) return;
	const value = staticValue(word);
	const specifier = value ?? word.text;
	const range = wordRange(w, word);
	w.out.sources.push({ specifier, literal: value !== undefined, range });
	w.out.imports.push({ specifier, imported: [], reExport: false });
	pushReference(w, scope, { name: specifier, range, role: "import" });
	walkWord(w, scope, word, false);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// unbash places only an expanding here-document body; a quoted or unclosed one is found by this scan.
// Stand-in for upstream body positions; remove by 2026-09-19.
function walkRedirect(w: Walk, scope: Scope, redirect: Redirect): void {
	walkWord(w, scope, redirect.target, false);
	if (redirect.operator !== "<<" && redirect.operator !== "<<-") return;
	const content = redirect.content;
	if (content === undefined) return;
	const body = redirect.body;
	const start = body?.pos ?? Math.max(w.text.indexOf("\n", redirect.end) + 1, w.heredocNext);
	const end = body?.end ?? start + content.length;
	if (start <= 0) return;
	// `<<-` strips leading tabs from every body line.
	const value = redirect.operator === "<<-" ? content.replace(/^\t+/gm, "") : content;
	if (body === undefined || staticValue(body) !== undefined) pushLiteral(w, scope, value, start, end);
	walkWord(w, scope, body, false);
	const delimiter = redirect.target?.value ?? "";
	const closing =
		delimiter === "" ? null : new RegExp(`^\\t*${escapeRegExp(delimiter)}(?:\\r?\\n|$)`).exec(w.text.slice(end));
	w.heredocNext = end + (closing?.[0].length ?? 0);
	if (closing === null) {
		w.out.diagnostics.push({
			severity: "warning",
			message: `here-document delimited by end-of-file (wanted \`${delimiter}')`,
			range: rangeAt(w, redirect.pos, redirect.end),
			path: w.module,
		});
	}
}

function walkCommand(w: Walk, scope: Scope, node: Command): void {
	const name = node.name;
	if (name === undefined) {
		for (const prefix of node.prefix) assignment(w, scope, prefix, false);
	} else {
		for (const prefix of node.prefix) assignment(w, scope, prefix, true);
		const builtin = staticValue(name);
		const words = node.suffix;
		if (builtin !== undefined && DECLARING.has(builtin)) {
			declaring(w, scope, builtin, name, words);
		} else if (builtin === "read") {
			reading(w, scope, words);
		} else if (builtin === "mapfile" || builtin === "readarray") {
			mapping(w, scope, words);
		} else if (builtin === "printf") {
			printing(w, scope, words);
		} else if (builtin === "getopts") {
			walkWord(w, scope, words[0]);
			assignWord(w, scope, words[1]);
			walkWords(w, scope, words.slice(2));
		} else if (builtin === "let") {
			letting(w, scope, words);
		} else if (builtin === "unset") {
			unsetting(w, scope, words);
		} else if (builtin === "alias") {
			aliases(w, scope, words);
		} else if (builtin === "source" || builtin === ".") {
			sourced(w, scope, words[0]);
			walkWords(w, scope, words.slice(1));
		} else {
			if (builtin !== undefined && FUNCTION_NAME_RE.test(builtin)) {
				pushReference(w, scope, { name: builtin, range: wordRange(w, name), role: "call", command: true });
			} else {
				walkWord(w, scope, name, false);
			}
			walkWords(w, scope, words);
		}
	}
	for (const redirect of node.redirects) walkRedirect(w, scope, redirect);
}

function walkTest(w: Walk, scope: Scope, expression: TestExpression): void {
	switch (expression.type) {
		case "TestUnary":
			walkWord(w, scope, expression.operand);
			break;
		case "TestBinary":
			walkWord(w, scope, expression.left);
			walkWord(w, scope, expression.right);
			break;
		case "TestLogical":
			walkTest(w, scope, expression.left);
			walkTest(w, scope, expression.right);
			break;
		case "TestNot":
			walkTest(w, scope, expression.operand);
			break;
		case "TestGroup":
			walkTest(w, scope, expression.expression);
			break;
	}
}

function walkFunction(w: Walk, scope: Scope, node: Extract<Node, { type: "Function" }>): void {
	const name = node.name.value;
	const range = rangeAt(w, node.pos, node.end);
	const declaration = declare(w, scope, name, wordRange(w, node.name), range, { kind: "function", local: false });
	declaration.metrics = { lines: range.end.line - range.start.line + 1 };
	const own = parseSymbolId(declaration.symbolId)?.descriptors.at(-1) ?? { kind: "method", name };
	const inner: Scope = {
		fromId: declaration.symbolId,
		descriptor: own,
		locals: new Map(),
		parent: scope,
		confined: false,
	};
	walkNode(w, inner, node.body);
	for (const redirect of node.redirects) walkRedirect(w, inner, redirect);
}

function walkStatements(w: Walk, scope: Scope, statements: Statement[]): void {
	for (const statement of statements) walkNode(w, scope, statement);
}

function walkNode(w: Walk, scope: Scope, node: Node | undefined): void {
	if (node === undefined) return;
	switch (node.type) {
		case "Statement":
			walkNode(w, scope, node.command);
			for (const redirect of node.redirects) walkRedirect(w, scope, redirect);
			break;
		case "Command":
			walkCommand(w, scope, node);
			break;
		case "Function":
			walkFunction(w, scope, node);
			break;
		case "Pipeline":
			// Each side of a pipe runs in its own subshell.
			for (const command of node.commands)
				walkNode(w, node.commands.length > 1 ? subshell(scope) : scope, command);
			break;
		case "AndOr":
			for (const command of node.commands) walkNode(w, scope, command);
			break;
		case "CompoundList":
			walkStatements(w, scope, node.commands);
			break;
		case "Subshell":
			walkNode(w, subshell(scope), node.body);
			break;
		case "BraceGroup":
			walkNode(w, scope, node.body);
			break;
		case "If":
			walkNode(w, scope, node.clause);
			walkNode(w, scope, node.then);
			walkNode(w, scope, node.else);
			break;
		case "For":
		case "Select":
			assignWord(w, scope, node.name);
			walkWords(w, scope, node.wordlist);
			walkNode(w, scope, node.body);
			break;
		case "While":
			walkNode(w, scope, node.clause);
			walkNode(w, scope, node.body);
			break;
		case "Case":
			walkWord(w, scope, node.word);
			for (const item of node.items) {
				walkWords(w, scope, item.pattern);
				walkNode(w, scope, item.body);
			}
			break;
		case "Coproc":
			assignWord(w, scope, node.name, "array");
			walkNode(w, subshell(scope), node.body);
			for (const redirect of node.redirects) walkRedirect(w, scope, redirect);
			break;
		case "ArithmeticFor":
			walkArithmetic(w, scope, node.initialize);
			walkArithmetic(w, scope, node.test);
			walkArithmetic(w, scope, node.update);
			walkNode(w, scope, node.body);
			break;
		case "TestCommand":
			walkTest(w, scope, node.expression);
			break;
		case "ArithmeticCommand":
			walkArithmetic(w, scope, node.expression);
			break;
	}
}

function encloses(outer: Scope, inner: Scope): boolean {
	for (let s: Scope | undefined = inner; s !== undefined; s = s.parent) if (s === outer) return true;
	return false;
}

/** A call at the top level reaches the definition before it; inside a function, the last in the file. */
function functionFor(w: Walk, scope: Scope, reference: BashReference): BashDeclaration | undefined {
	const definitions = (w.out.functionsByName.get(reference.name) ?? []).filter((definition) => {
		const home = w.definedIn.get(definition);
		return home === undefined || !home.confined || encloses(home, scope);
	});
	if (scope.fromId !== undefined) return definitions.at(-1);
	let found: BashDeclaration | undefined;
	for (const definition of definitions) {
		if (comparePositions(definition.range.start, reference.range.start) < 0) found = definition;
	}
	return found;
}

/** The nearest enclosing local, declared before the use when it is the function's own, then the file's variable. */
function variableFor(w: Walk, scope: Scope, reference: BashReference): BashDeclaration | undefined {
	for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) {
		const local = s.locals.get(reference.name);
		if (local === undefined) continue;
		// An enclosing function's local is live whenever this body runs, wherever it was declared.
		if (s.fromId !== scope.fromId || comparePositions(local.range.start, reference.range.start) <= 0) return local;
	}
	return w.out.globalsByName.get(reference.name);
}

/** A name settles once every declaration is known, against the scope it was read in. */
function settle(w: Walk): void {
	for (const { reference, scope } of w.pending) {
		if (reference.role === "import") {
			w.out.references.push(reference);
			continue;
		}
		const target =
			reference.target ??
			(reference.command ? functionFor(w, scope, reference) : variableFor(w, scope, reference))?.symbolId;
		w.out.references.push(target === undefined ? reference : { ...reference, target });
	}
}

export function parseBash(module: string, source: string): ParsedBashFile {
	const shift = source.charCodeAt(0) === 0xfeff ? 1 : 0;
	const text = source.slice(shift);
	const out: ParsedBashFile = {
		module,
		text: source,
		declarations: [],
		references: [],
		imports: [],
		sources: [],
		literals: [],
		diagnostics: [],
		functionsByName: new Map(),
		globalsByName: new Map(),
	};
	const w: Walk = {
		module,
		text,
		shift,
		coordinates: coordinatesOf(source),
		out,
		pending: [],
		heredocNext: 0,
		minted: new Map(),
		definedIn: new WeakMap(),
	};
	const script = parse(text);
	walkStatements(w, { locals: new Map(), confined: false }, script.commands);
	settle(w);
	for (const error of script.errors ?? []) {
		out.diagnostics.push({
			severity: "error",
			message: error.message,
			range: rangeAt(w, error.pos, Math.min(error.pos + 1, text.length)),
			path: module,
		});
	}
	return out;
}
