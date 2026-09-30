// Imports a move plans: their forms, their text, and where each joins or lands.

import type { MoveBlockedReason, MoveBlockedSite, Range, TextCoordinates, TextEdit } from "@nyaa-lexicon/protocol";
import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

export type PlannedImport =
	| { clause: "default" | "namespace" | "require"; typeOnly: boolean; specifier: string; localName: string }
	| { clause: "named"; typeOnly: boolean; specifier: string; importedName: string; localName: string };

export type PlannedNamed = Extract<PlannedImport, { clause: "named" }>;

export type Quote = "'" | '"';

/** One key per module a specifier written here lands on; an unresolved one keys by its text. */
export type LandingKey = (specifier: string) => string;

/** Lookup steps a move takes, counted for tests that bound its work. */
export interface WorkMeter {
	steps: number;
}

////////////////////////////////
//  Rendering

/** One statement: a named group from one module, or one default, namespace or `require` binding. */
export function renderImport(group: readonly PlannedImport[], quote: Quote): string {
	const planned = group[0] as PlannedImport;
	const keyword = planned.typeOnly ? "import type" : "import";
	const from = quoted(planned.specifier, quote);
	if (planned.clause === "require") return `${keyword} ${planned.localName} = require(${from});`;
	if (planned.clause !== "named") {
		const binding = planned.clause === "namespace" ? `* as ${planned.localName}` : planned.localName;
		return `${keyword} ${binding} from ${from};`;
	}
	const elements = group.flatMap((item) => (item.clause === "named" ? [namedElement(item, quote)] : []));
	return `${keyword} { ${elements.join(", ")} } from ${from};`;
}

/** An export name that is no identifier stays a string, as `import { "a-b" as ab }` writes it. */
function namedElement(planned: PlannedNamed, quote: Quote): string {
	const imported = isIdentifierName(planned.importedName)
		? planned.importedName
		: quoted(planned.importedName, quote);
	return imported === planned.localName ? imported : `${imported} as ${planned.localName}`;
}

function isIdentifierName(name: string): boolean {
	const points = [...name].map((character) => character.codePointAt(0) as number);
	const [first, ...rest] = points;
	return (
		first !== undefined &&
		ts.isIdentifierStart(first, ts.ScriptTarget.ESNext) &&
		rest.every((point) => ts.isIdentifierPart(point, ts.ScriptTarget.ESNext))
	);
}

/** Named imports of one form and module share a statement. */
export function standaloneImports(planned: readonly PlannedImport[], quote: Quote): string[] {
	const groups = new Map<string, PlannedImport[]>();
	for (const item of planned) {
		const key = item.clause === "named" ? `named ${item.typeOnly} ${item.specifier}` : renderImport([item], quote);
		append(groups, key, item);
	}
	return [...groups.values()].map((group) => renderImport(group, quote));
}

/** A string literal holding `value`, escaping what would end or break it. */
export function quoted(value: string, quote: Quote): string {
	let body = "";
	for (const character of value) {
		const code = character.codePointAt(0) as number;
		if (character === quote || character === "\\") body += `\\${character}`;
		else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
			body += `\\u${code.toString(16).padStart(4, "0")}`;
		} else body += character;
	}
	return `${quote}${body}${quote}`;
}

////////////////////////////////
//  Merging

/**
 * The first import a named addition can join, by form and landing: its own named list, or a lone
 * default binding. Skips `excluded` and statements other edits touch.
 */
export function mergeIndex(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	edits: readonly TextEdit[],
	landingKey: LandingKey,
	excluded: ReadonlySet<ts.Node>,
	meter?: WorkMeter,
): Map<string, ts.ImportDeclaration> {
	const index = new Map<string, ts.ImportDeclaration>();
	const touched = overlapIndex(coordinates, edits, meter);
	for (const statement of source.statements) {
		if (excluded.has(statement)) continue;
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		// Attributes can change which export binds a name.
		if (statement.attributes !== undefined) continue;
		const clause = statement.importClause;
		if (clause === undefined) continue;
		const named = clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings);
		// `import type D, { X }` is not TypeScript, so a type-only default takes no list.
		const loneDefault = clause.namedBindings === undefined && clause.name !== undefined && !clause.isTypeOnly;
		if (!named && !loneDefault) continue;
		if (touched(statement.getStart(source), statement.getEnd())) continue;
		const key = mergeKey(clause.isTypeOnly, landingKey(statement.moduleSpecifier.text));
		if (!index.has(key)) index.set(key, statement);
	}
	return index;
}

export function mergeKey(typeOnly: boolean, landing: string): string {
	return `${typeOnly ? "type" : "value"}\0${landing}`;
}

/** Whether an offset span overlaps any edit, answered after one sort. */
function overlapIndex(
	coordinates: TextCoordinates,
	edits: readonly TextEdit[],
	meter?: WorkMeter,
): (start: number, end: number) => boolean {
	const spans = edits
		.flatMap((edit) => {
			const offsets = coordinates.offsetsForRange(edit.range);
			return offsets === undefined ? [] : [offsets];
		})
		.sort((left, right) => left.start - right.start);
	// The furthest end among the spans up to each one.
	const reach: number[] = [];
	for (const span of spans) reach.push(Math.max(span.end, reach.at(-1) ?? -1));
	return (start, end) => {
		let low = 0;
		let high = spans.length - 1;
		let last = -1;
		while (low <= high) {
			if (meter !== undefined) meter.steps++;
			const middle = (low + high) >> 1;
			if ((spans[middle] as { start: number }).start < end) {
				last = middle;
				low = middle + 1;
			} else high = middle - 1;
		}
		return last !== -1 && (reach[last] as number) > start;
	};
}

/** Adds names after the last element, or a list after a lone default, leaving the rest as written. */
export function mergedImport(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	statement: ts.ImportDeclaration,
	planned: readonly PlannedNamed[],
	quote: Quote,
): TextEdit | undefined {
	const clause = statement.importClause;
	const named = clause?.namedBindings;
	const elements = planned.map((item) => namedElement(item, quote)).join(", ");
	if (named === undefined && clause?.name !== undefined) {
		const point = coordinates.positionAt(clause.name.getEnd());
		return point === undefined ? undefined : { range: { start: point, end: point }, newText: `, { ${elements} }` };
	}
	if (named === undefined || !ts.isNamedImports(named)) return undefined;
	const last = named.elements.at(-1);
	if (last === undefined) {
		const open = named.getStart(source);
		if (named.getEnd() - open === 2) {
			const range = coordinates.rangeAt(open, named.getEnd());
			return range === undefined ? undefined : { range, newText: `{ ${elements} }` };
		}
		// Whatever sits between the braces stays after the names.
		const point = coordinates.positionAt(open + 1);
		return point === undefined ? undefined : { range: { start: point, end: point }, newText: ` ${elements}` };
	}
	const point = coordinates.positionAt(last.getEnd());
	return point === undefined ? undefined : { range: { start: point, end: point }, newText: `, ${elements}` };
}

////////////////////////////////
//  Insertion

/**
 * After the leading imports and directives. Without them, at the top: past a header comment a blank
 * line sets apart, above any banner or doc comment, with a blank line after.
 */
export function importInsertion(source: ts.SourceFile): { offset: number; lineBreak: boolean; blankAfter: boolean } {
	let head: ts.Statement | undefined;
	for (const statement of source.statements) {
		if (!isImportLike(statement) && !isDirective(statement)) break;
		head = statement;
	}
	if (head !== undefined) return { ...lineAfter(head, source), blankAfter: false };
	const first = source.statements[0];
	if (first === undefined) return { ...lineBefore(source.endOfFileToken, source), blankAfter: false };
	const text = source.text;
	const comments = ts.getLeadingCommentRanges(text, first.pos) ?? [];
	const blankBetween = (from: number, to: number) => /\n[ \t]*\r?\n/.test(text.slice(from, to));
	const headerEnd = comments.findIndex((comment, at) =>
		blankBetween(comment.end, comments[at + 1]?.pos ?? first.getStart(source)),
	);
	const after = headerEnd === -1 ? undefined : comments[headerEnd + 1];
	const offset =
		headerEnd === -1 ? (comments[0]?.pos ?? first.getStart(source)) : (after?.pos ?? first.getStart(source));
	return { offset, lineBreak: false, blankAfter: true };
}

/** Start of the line after `node` and its trailing comments. */
function lineAfter(node: ts.Node, source: ts.SourceFile): { offset: number; lineBreak: boolean } {
	const text = source.text;
	const comments = ts.getTrailingCommentRanges(text, node.getEnd()) ?? [];
	const end = Math.max(node.getEnd(), ...comments.map((comment) => comment.end));
	const lineEnd = /[ \t]*\r?\n/y;
	lineEnd.lastIndex = end;
	const match = lineEnd.exec(text);
	return match === null ? { offset: end, lineBreak: true } : { offset: end + match[0].length, lineBreak: false };
}

/** Just before `node`, breaking the line when a token or comment ends on it first. */
function lineBefore(node: ts.Node, source: ts.SourceFile): { offset: number; lineBreak: boolean } {
	const offset = node.getStart(source);
	return { offset, lineBreak: contentLineBefore(node, source) === lineOf(source, offset) };
}

/** Line of the last token or comment before `node`, if any. */
export function contentLineBefore(node: ts.Node, source: ts.SourceFile): number | undefined {
	const text = source.text;
	// Its `pos` is the previous token's end, and its trivia holds any comment before it.
	const comments = [
		...(ts.getTrailingCommentRanges(text, node.pos) ?? []),
		...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
	];
	const end = Math.max(node.pos, ts.getShebang(text)?.length ?? 0, ...comments.map((comment) => comment.end));
	return end > 0 ? lineOf(source, end - 1) : undefined;
}

export function lineOf(source: ts.SourceFile, offset: number): number {
	return source.getLineAndCharacterOfPosition(offset).line;
}

/** A prologue string such as `"use client"`. */
function isDirective(statement: ts.Statement): boolean {
	return ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
}

function isImportLike(statement: ts.Statement): boolean {
	return (
		ts.isImportDeclaration(statement) ||
		ts.isExportDeclaration(statement) ||
		ts.isImportEqualsDeclaration(statement)
	);
}

////////////////////////////////
//  Shared

export function append<K, V>(buckets: Map<K, V[]>, key: K, value: V): void {
	const bucket = buckets.get(key);
	if (bucket === undefined) buckets.set(key, [value]);
	else bucket.push(value);
}

export function blockedSite(range: Range | undefined, reason: MoveBlockedReason, detail: string): MoveBlockedSite {
	return range === undefined ? { reason, detail } : { range, reason, detail };
}
