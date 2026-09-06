// What a walk over the unbash tree carries, and the facts it collects.

import type {
	Declaration,
	Descriptor,
	Diagnostic,
	Import,
	Literal,
	Range,
	Reference,
	SymbolKind,
	TextCoordinates,
} from "@nyaa-lexicon/protocol";
import type { Statement, Word, WordPart } from "unbash";

////////////////////////////////
//  Interfaces & Types

export type DeclaredType = "array" | "assoc" | "integer" | "nameref";

export interface BashDeclaration extends Declaration {
	/** From a declaring builtin's `-a`, `-A`, `-i` or `-n`; a shell variable is otherwise a string. */
	declaredType?: DeclaredType;
}

/** A reference before binding; a function name is kept only when it binds. */
export interface BashReference {
	name: string;
	range: Range;
	role: Reference["role"];
	fromId?: string;
	/** The declaration in this file the name settled on. */
	target?: string;
	/** The name is a function's, not a variable's. */
	ofFunction?: boolean;
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

export interface Scope {
	fromId?: string;
	/** The enclosing function's descriptor, so a local's id nests under it. */
	descriptor?: Descriptor;
	locals: Map<string, BashDeclaration>;
	parent?: Scope;
	/** A subshell keeps every assignment to itself. */
	confined: boolean;
}

/** A reference and the scope it was read in; targets settle after the whole file is read. */
export interface Pending {
	reference: BashReference;
	scope: Scope;
}

export interface Walk {
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
	/** The statement walk, handed in so a command substitution descends without a module cycle. */
	statements: (scope: Scope, statements: Statement[]) => void;
}

export interface DeclareOptions {
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

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A function may carry what a variable may not, short of the shell's own metacharacters. */
export const FUNCTION_NAME_RE = /^[A-Za-z_.][A-Za-z0-9_.:@+,-]*$/;
const NUMBER_RE = /^[0-9]+$/;

////////////////////////////////
//  Functions & Helpers

/** A word may end on the `\r` of a line ending, which is no position; the line's content end is. */
function clamp(w: Walk, offset: number): number {
	return w.text[offset] === "\n" && w.text[offset - 1] === "\r" ? offset - 1 : offset;
}

export function rangeAt(w: Walk, start: number, end: number): Range {
	const range = w.coordinates.rangeAt(clamp(w, start) + w.shift, clamp(w, end) + w.shift);
	if (range !== undefined) return range;
	const zero = { line: 0, character: 0 };
	return { start: zero, end: zero };
}

export function wordRange(w: Walk, word: Word): Range {
	return rangeAt(w, word.pos, word.end);
}

/** A word's value when nothing in it expands at run time. */
export function staticValue(word: Word | undefined): string | undefined {
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

export function pushLiteral(w: Walk, scope: Scope, value: string, start: number, end: number): void {
	const number = NUMBER_RE.test(value) ? Number(value) : undefined;
	w.out.literals.push({
		kind: number === undefined ? "string" : "number",
		value,
		...(number === undefined ? {} : { number }),
		range: rangeAt(w, start, end),
		...(scope.fromId === undefined ? {} : { containerId: scope.fromId }),
	});
}

export function pushReference(w: Walk, scope: Scope, reference: BashReference): void {
	w.pending.push({
		reference: { ...reference, ...(scope.fromId === undefined ? {} : { fromId: scope.fromId }) },
		scope,
	});
}

/** A bare word is a number literal when it is all digits; anything else it holds is walked elsewhere. */
export function bareNumber(w: Walk, scope: Scope, word: Word): void {
	if (NUMBER_RE.test(word.text)) pushLiteral(w, scope, word.text, word.pos, word.end);
}
