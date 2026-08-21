// Markdown structure and prose, adapted from mdast.
//
// Positions come from node OFFSETS through the shared coordinate map, never from mdast's own line
// and column: only the map counts UTF-16 code units, which is the unit the protocol pins.

import {
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type DocRegion,
	type Range,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import type { Heading, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { toString as inlineText } from "mdast-util-to-string";
import { frontmatter } from "micromark-extension-frontmatter";
import { isMap, isPair, isScalar, parseDocument } from "yaml";

////////////////////////////////
//  Interfaces & Types

export interface ParsedMarkdownFile {
	module: string;
	declarations: Declaration[];
	docs: DocRegion[];
	diagnostics: Diagnostic[];
}

interface OffsetSpan {
	start: number;
	end: number;
}

interface HeadingFrame {
	depth: number;
	symbolId: string;
	descriptors: Descriptor[];
	/** Occurrence per sibling name, since a repeat is numbered per parent. */
	seen: Map<string, number>;
}

////////////////////////////////
//  Constants

export const LANGUAGE = "markdown";

/** Frontmatter rides every markdown extension: plain `.md` carries it constantly. */
export const EXTENSIONS = [".md", ".mdc", ".markdown"];

/** Punctuation rather than prose, so it is not a searchable region. */
const STRUCTURAL_BLOCKS = new Set(["thematicBreak"]);

/** Escaped, since a raw zero-width character is forbidden in this repo's sources. */
const BYTE_ORDER_MARK = "\uFEFF";

////////////////////////////////
//  Functions & Helpers

/**
 * How far mdast's offsets sit behind the file's.
 *
 * A leading byte order mark is stripped before parsing, so every offset comes back short by its
 * width and a range built from one addresses the character before the one it means.
 */
function bomWidth(text: string): number {
	return text.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
}

function offsetsOf(node: RootContent, shift: number): OffsetSpan | null {
	const start = node.position?.start.offset;
	const end = node.position?.end.offset;
	return start === undefined || end === undefined ? null : { start: start + shift, end: end + shift };
}

/**
 * The content lines of a delimited block, delimiters excluded.
 *
 * Line ARITHMETIC rather than the node's `value`, because mdast strips a fence's indentation and
 * may normalize its line endings, and a range must slice the source back out verbatim.
 */
function delimitedContent(coordinates: TextCoordinates, openOffset: number, value: string): OffsetSpan | null {
	if (value === "") return null;
	const open = coordinates.positionAt(openOffset);
	if (open === undefined) return null;

	// The owner counts the value's lines too, so one definition of a line serves both texts.
	const lastLine = open.line + coordinatesOf(value).lineCount();
	const start = coordinates.offsetAt({ line: open.line + 1, character: 0 });
	const width = coordinates.lineText(lastLine)?.length;
	if (start === undefined || width === undefined) return null;

	const end = coordinates.offsetAt({ line: lastLine, character: width });
	return end === undefined || end < start ? null : { start, end };
}

/** An mdast code node does not say which kind it is, and an indented block is not fenced. */
function isFencedCode(coordinates: TextCoordinates, openOffset: number): boolean {
	const open = coordinates.positionAt(openOffset);
	if (open === undefined) return false;
	const line = (coordinates.lineText(open.line) ?? "").replace(/^ {0,3}/u, "");
	return line.startsWith("```") || line.startsWith("~~~");
}

function headingName(node: Heading): string {
	return inlineText(node).trim();
}

/** The SOURCE span of the name, so inline markup is highlighted with the text it renders. */
function headingSelection(node: Heading, shift: number): OffsetSpan | null {
	const first = node.children[0]?.position?.start.offset;
	const last = node.children[node.children.length - 1]?.position?.end.offset;
	return first === undefined || last === undefined ? null : { start: first + shift, end: last + shift };
}

/** A section runs to the next heading of the same or a shallower level. */
function sectionEnd(children: RootContent[], index: number, depth: number, shift: number): number | null {
	let last = index;
	for (let next = index + 1; next < children.length; next++) {
		const node = children[next] as RootContent;
		if (node.type === "heading" && node.depth <= depth) break;
		last = next;
	}
	return offsetsOf(children[last] as RootContent, shift)?.end ?? null;
}

function declarationFor(
	symbolId: string,
	name: string,
	range: Range,
	selectionRange: Range,
	containerId: string | undefined,
	kind: "heading" | "property",
): Declaration {
	return {
		symbolId,
		kind,
		name,
		range,
		selectionRange,
		visibility: "public",
		...(containerId === undefined ? {} : { containerId }),
	};
}

/**
 * Frontmatter keys as `property` declarations, nested maps chained through `containerId`.
 *
 * Sequence entries are omitted: an element has no name and a declaration requires one.
 */
function frontmatterDeclarations(
	module: string,
	coordinates: TextCoordinates,
	content: OffsetSpan,
	text: string,
): { declarations: Declaration[]; diagnostics: Diagnostic[] } {
	const declarations: Declaration[] = [];
	const diagnostics: Diagnostic[] = [];
	const document = parseDocument(text);

	for (const problem of document.errors) {
		const range = coordinates.rangeAt(content.start + problem.pos[0], content.start + problem.pos[1]);
		diagnostics.push({
			severity: "error",
			message: `frontmatter: ${problem.message}`,
			path: module,
			...(range === undefined ? {} : { range }),
		});
	}

	function walk(node: unknown, parents: Descriptor[], containerId: string | undefined): void {
		if (!isMap(node)) return;
		for (const pair of node.items) {
			if (!isPair(pair) || !isScalar(pair.key)) continue;
			const key = pair.key.range;
			const name = String(pair.key.value);
			if (key === null || key === undefined || name === "") continue;

			const keyStart = content.start + key[0];
			const keyEnd = content.start + key[1];
			// A zero-width key is an absent one, and `: 1` would otherwise be declared as "null".
			if (keyEnd <= keyStart) continue;
			const valueEnd = isScalar(pair.value) || isMap(pair.value) ? pair.value.range?.[1] : undefined;
			const selectionRange = coordinates.rangeAt(keyStart, keyEnd);
			const range = coordinates.rangeAt(keyStart, valueEnd === undefined ? keyEnd : content.start + valueEnd);
			if (selectionRange === undefined || range === undefined) continue;

			const descriptors: Descriptor[] = [...parents, { kind: "term", name }];
			const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
			declarations.push(declarationFor(symbolId, name, range, selectionRange, containerId, "property"));
			walk(pair.value, descriptors, symbolId);
		}
	}

	walk(document.contents, [], undefined);
	return { declarations, diagnostics };
}

/**
 * Only TOP-LEVEL headings are the document's own structure.
 *
 * A heading inside a blockquote or a list item is quoted or embedded material, so it stays prose
 * rather than growing a section the document does not have.
 */
export function parseMarkdown(module: string, text: string): ParsedMarkdownFile {
	const coordinates = coordinatesOf(text);
	const declarations: Declaration[] = [];
	const docs: DocRegion[] = [];
	const diagnostics: Diagnostic[] = [];

	// Stripped explicitly rather than left to the parser, so the shift is a known width.
	const shift = bomWidth(text);
	const tree: Root = fromMarkdown(text.slice(shift), {
		extensions: [frontmatter(["yaml"])],
		mdastExtensions: [frontmatterFromMarkdown(["yaml"])],
	});

	const stack: HeadingFrame[] = [];
	const rootSeen = new Map<string, number>();
	let anchorId: string | undefined;

	for (const [index, node] of tree.children.entries()) {
		const span = offsetsOf(node, shift);
		if (span === null) continue;

		if (node.type === "yaml") {
			const content = delimitedContent(coordinates, span.start, node.value);
			if (content === null) continue;
			const parsed = frontmatterDeclarations(
				module,
				coordinates,
				content,
				text.slice(content.start, content.end),
			);
			declarations.push(...parsed.declarations);
			diagnostics.push(...parsed.diagnostics);
			continue;
		}

		if (node.type === "heading") {
			anchorId = undefined;
			while (stack.length > 0 && (stack[stack.length - 1] as HeadingFrame).depth >= node.depth) stack.pop();

			const name = headingName(node);
			const selection = headingSelection(node, shift);
			const end = sectionEnd(tree.children, index, node.depth, shift);
			const selectionRange = selection === null ? undefined : coordinates.rangeAt(selection.start, selection.end);
			const range = end === null ? undefined : coordinates.rangeAt(span.start, end);
			if (name === "" || selectionRange === undefined || range === undefined) {
				const at = coordinates.rangeAt(span.start, span.end);
				diagnostics.push({
					severity: "info",
					message: "a heading with no text is not addressable, so it reports no section",
					path: module,
					...(at === undefined ? {} : { range: at }),
				});
				continue;
			}

			const parent = stack[stack.length - 1];
			const seen = parent?.seen ?? rootSeen;
			const occurrence = (seen.get(name) ?? 0) + 1;
			seen.set(name, occurrence);
			if (occurrence > 1) {
				diagnostics.push({
					severity: "info",
					message: `heading ${JSON.stringify(name)} repeats under one parent, so its id carries occurrence ${occurrence} and moves if a sibling is inserted above it`,
					path: module,
					range: selectionRange,
				});
			}

			const descriptor: Descriptor = {
				kind: "namespace",
				name,
				...(occurrence > 1 ? { disambiguator: String(occurrence) } : {}),
			};
			const descriptors: Descriptor[] = [...(parent?.descriptors ?? []), descriptor];
			const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });

			declarations.push(declarationFor(symbolId, name, range, selectionRange, parent?.symbolId, "heading"));
			stack.push({ depth: node.depth, symbolId, descriptors, seen: new Map() });
			anchorId = symbolId;
			continue;
		}

		if (STRUCTURAL_BLOCKS.has(node.type)) continue;

		const fenced = node.type === "code" && isFencedCode(coordinates, span.start);
		const content = fenced ? delimitedContent(coordinates, span.start, node.value) : span;
		if (content === null) continue;

		const range = coordinates.rangeAt(content.start, content.end);
		const regionText = text.slice(content.start, content.end);
		if (range === undefined || regionText === "") continue;

		docs.push({
			range,
			text: regionText,
			fenced,
			...(anchorId === undefined ? {} : { anchorId }),
		});
	}

	return { module, declarations, docs, diagnostics };
}
