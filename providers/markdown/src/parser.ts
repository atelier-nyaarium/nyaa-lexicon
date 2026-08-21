// Markdown structure and prose, adapted from mdast.
//
// Positions come from node OFFSETS through the shared coordinate map, never from mdast's own line
// and column: only the map counts UTF-16 code units, which is the unit the protocol pins.

import { readYaml, type YamlFacts } from "@nyaa-lexicon/formats/yaml";
import {
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type DocRegion,
	type Literal,
	type Range,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import type { Heading, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { toString as inlineText } from "mdast-util-to-string";
import { frontmatter } from "micromark-extension-frontmatter";

////////////////////////////////
//  Interfaces & Types

export interface ParsedMarkdownFile {
	module: string;
	declarations: Declaration[];
	literals: Literal[];
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

/** The shared reader, so frontmatter and a `.yml` file cannot disagree about what YAML means. */
function frontmatterFacts(module: string, coordinates: TextCoordinates, content: OffsetSpan, text: string): YamlFacts {
	const facts = readYaml({ language: LANGUAGE, module, text, offset: content.start, coordinates });
	return {
		...facts,
		diagnostics: facts.diagnostics.map((problem) => ({ ...problem, message: `frontmatter: ${problem.message}` })),
	};
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
	const literals: Literal[] = [];
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
			const facts = frontmatterFacts(module, coordinates, content, text.slice(content.start, content.end));
			declarations.push(...facts.declarations);
			literals.push(...facts.literals);
			diagnostics.push(...facts.diagnostics);
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
		// Whitespace alone normalizes to nothing, so it would store as a region no search can reach.
		if (range === undefined || regionText.trim() === "") continue;

		docs.push({
			range,
			text: regionText,
			fenced,
			...(anchorId === undefined ? {} : { anchorId }),
		});
	}

	return { module, declarations, literals, docs, diagnostics };
}
