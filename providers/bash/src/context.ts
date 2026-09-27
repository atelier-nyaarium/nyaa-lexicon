// What a walk over the syntax tree carries, and the facts it collects.

import {
	type CommentSpan,
	Cursor,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	defined,
	type FileRole,
	type HeaderSpan,
	type Import,
	type Literal,
	type Range,
	type Reference,
	type SymbolKind,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import type { Statement, Word, WordPart } from "./syntax/ast.js";

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
	role: FileRole;
	declarations: BashDeclaration[];
	references: BashReference[];
	imports: Import[];
	sources: SourceImport[];
	literals: Literal[];
	comments: CommentSpan[];
	blankLines: number[];
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

/** A header, rendered once comments are known. */
export interface PendingHeader {
	declaration: BashDeclaration;
	span: HeaderSpan;
}

export interface Walk {
	module: string;
	/** The parsed text: the file without its byte order mark. */
	text: string;
	/** Code units the file holds before the parsed text. */
	shift: number;
	coordinates: TextCoordinates;
	out: ParsedBashFile;
	pending: Pending[];
	headers: PendingHeader[];
	/** Name paths already minted, so a repeat carries an occurrence. */
	minted: Map<string, number>;
	/** Where each function was defined, since one defined in a subshell is unknown outside it. */
	definedIn: WeakMap<BashDeclaration, Scope>;
	/** The statement walk, handed in so a command substitution descends without a module cycle. */
	statements: (scope: Scope, statements: Statement[]) => void;
	/** Start and end pairs of every quoted part, which a header keeps as written. */
	quoted: number[];
}

/** A word's `NAME=`, `NAME+=` or `NAME[...]=` head, as `declare` reads its operands. */
export interface AssignmentHead {
	name: string;
	/** Where the value starts in the text. */
	valueAt: number;
	value: string;
	/** The value opens with `(`. */
	array: boolean;
}

/** `NAME` or `NAME[...]`, the subscript without its brackets. */
export interface Subscripted {
	name: string;
	index?: string;
}

export interface DeclareOptions {
	kind: SymbolKind;
	local: boolean;
	/** `declare -g` names the file's variable even inside a function. */
	global?: boolean;
	exported?: boolean;
	declaredType?: DeclaredType;
	languageKind?: string;
	/** Offsets into the text; comments removed later. */
	header: HeaderSpan;
}

////////////////////////////////
//  Constants

export const LANGUAGE = "bash";

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const NAME_CHAR_RE = /^[A-Za-z0-9_]$/;
/** A function may carry what a variable may not, short of the shell's own metacharacters. */
export const FUNCTION_NAME_RE = /^[A-Za-z_.][A-Za-z0-9_.:@+,-]*$/;
const NUMBER_RE = /^[0-9]+$/;

////////////////////////////////
//  Functions & Helpers

/** A word may end on the `\r` of a line ending, which is no position; the line's content end is. */
export function contentOffset(w: Walk, offset: number): number {
	const position = w.coordinates.positionAt(offset + w.shift);
	return position !== undefined && w.coordinates.offsetAt(position) === undefined ? offset - 1 : offset;
}

export function rangeAt(w: Walk, start: number, end: number): Range {
	const range = w.coordinates.rangeAt(contentOffset(w, start) + w.shift, contentOffset(w, end) + w.shift);
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
	const range = rangeAt(w, start, end);
	// A lone `\r` right before the line's `\n` clamps away to nothing: no span left to report.
	if (range.start.line === range.end.line && range.start.character === range.end.character) return;
	const number = NUMBER_RE.test(value) ? Number(value) : undefined;
	w.out.literals.push({
		kind: number === undefined ? "string" : "number",
		value,
		...defined({ number }),
		range,
		...defined({ containerId: scope.fromId }),
	});
}

export function pushReference(w: Walk, scope: Scope, reference: BashReference): void {
	w.pending.push({
		reference: { ...reference, ...defined({ fromId: scope.fromId }) },
		scope,
	});
}

/** A bare word is a number literal when it is all digits; anything else it holds is walked elsewhere. */
export function bareNumber(w: Walk, scope: Scope, word: Word): void {
	if (NUMBER_RE.test(word.text)) pushLiteral(w, scope, word.text, word.pos, word.end);
}

/** The subscript runs to the first `]`. */
export function assignmentOf(text: string): AssignmentHead | undefined {
	const cursor = new Cursor(text);
	const name = cursor.takeWhile((character) => NAME_CHAR_RE.test(character));
	if (!IDENTIFIER_RE.test(name)) return undefined;
	if (cursor.peek() === "[") {
		cursor.takeWhile((character) => character !== "]");
		if (cursor.next() !== "]") return undefined;
	}
	if (cursor.peek() === "+") cursor.next();
	if (cursor.next() !== "=") return undefined;
	const valueAt = cursor.offset;
	const array = cursor.peek() === "(";
	return { name, valueAt, value: cursor.takeWhile(() => true), array };
}

/** The name runs to the first `[`, and a final `]` closes the subscript. */
export function subscripted(text: string): Subscripted {
	const cursor = new Cursor(text);
	const name = cursor.takeWhile((character) => character !== "[");
	if (cursor.next() !== "[") return { name };
	let index = "";
	while (cursor.good()) {
		const character = cursor.next();
		if (character === "]" && !cursor.good()) break;
		index += character;
	}
	return { name, index };
}
