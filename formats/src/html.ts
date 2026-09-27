import {
	type CommentSpan,
	composeSymbolId,
	type Declaration,
	type Diagnostic,
	type DocRegion,
	defined,
	isTooDeep,
	type Literal,
	NestingGauge,
	type OffsetRange,
	type Range,
	type TextCoordinates,
	TOO_DEEP,
} from "@nyaa-lexicon/protocol";
import { type DefaultTreeAdapterMap, defaultTreeAdapter, parse, type TreeAdapter } from "parse5";
import { droppedKey } from "./dropped.js";
import { LayoutRecorder, trimmedSpan } from "./layout.js";
import { startTagSignature } from "./startTag.js";

export interface HtmlContext {
	language: string;
	module: string;
	text: string;
	offset: number;
	coordinates: TextCoordinates;
}

export interface HtmlFacts {
	declarations: Declaration[];
	literals: Literal[];
	comments: CommentSpan[];
	/** Absent when the text was not read. */
	blankLines?: number[];
	docs: DocRegion[];
	diagnostics: Diagnostic[];
}

const LIMIT = 16_384;
const RAW = ["script", "style"];
const PHRASING = new Set([
	"a",
	"abbr",
	"b",
	"bdi",
	"bdo",
	"br",
	"cite",
	"code",
	"data",
	"dfn",
	"em",
	"i",
	"img",
	"kbd",
	"mark",
	"q",
	"rp",
	"rt",
	"ruby",
	"s",
	"samp",
	"small",
	"span",
	"strong",
	"sub",
	"sup",
	"time",
	"u",
	"var",
	"wbr",
	"input",
	"label",
	"button",
	"select",
	"textarea",
	"output",
]);
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Location = { startOffset: number; endOffset: number };
type ElementLocation = { startTag: Location; endTag?: Location; attrs?: Record<string, Location> };

function rangeAt(context: HtmlContext, start: number, end: number): Range | undefined {
	return context.coordinates.rangeAt(context.offset + start, context.offset + end);
}

/** parse5's open-element stack, bounded. */
function gaugedTree(): TreeAdapter<DefaultTreeAdapterMap> {
	const gauge = new NestingGauge();
	return { ...defaultTreeAdapter, onItemPush: () => gauge.open(), onItemPop: () => gauge.close() };
}

function location(node: { sourceCodeLocation?: Location | ElementLocation | null }): Location | undefined {
	const value = node.sourceCodeLocation;
	return value && "startOffset" in value ? value : undefined;
}

function collapse(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/** The value's span in an attribute's source, quotes included, and the text inside them. */
interface ValueSpan {
	start: number;
	end: number;
	inner: { start: number; end: number };
}

/** An attribute's value as written: quoted, or bare to the attribute's end; none for a bare name. */
function attributeValue(text: string, start: number, end: number): ValueSpan | undefined {
	let i = start;
	while (i < end && text[i] !== "=") i++;
	if (i >= end) return undefined;
	i++;
	while (i < end && /\s/u.test(text[i] as string)) i++;
	const quote = text[i];
	if (quote !== '"' && quote !== "'") return { start: i, end, inner: { start: i, end } };
	let close = i + 1;
	while (close < end && text[close] !== quote) close++;
	const valueEnd = Math.min(close + 1, end);
	return { start: i, end: valueEnd, inner: { start: i + 1, end: Math.max(i + 1, close) } };
}

/** Nothing anyone wrote as prose lives under these. */
const SILENT = new Set(["#comment", "#documentType", "template", "script", "style"]);

/** Every text below a node, or only the text reachable without crossing a block when `inline`. */
function textOf(node: Node, inline = false): string {
	let result = "";
	const pending: Node[] = [node];
	while (pending.length > 0) {
		const current = pending.pop() as Node;
		if (current.nodeName === "#text") {
			result += (current as DefaultTreeAdapterMap["textNode"]).value;
			continue;
		}
		if (SILENT.has(current.nodeName)) continue;
		if (inline && current !== node && "tagName" in current && !PHRASING.has(current.tagName.toLowerCase()))
			continue;
		if ("childNodes" in current) {
			for (let index = current.childNodes.length - 1; index >= 0; index--)
				pending.push(current.childNodes[index] as Node);
		}
	}
	return result;
}

const HEADING = /^h[1-6]$/u;

function sourceEnd(node: Node): number {
	let end = 0;
	const pending: Node[] = [node];
	while (pending.length > 0) {
		const current = pending.pop() as Node;
		const value = current.sourceCodeLocation;
		if (value !== undefined && value !== null) {
			if ("endOffset" in value) end = Math.max(end, value.endOffset);
			if ("endTag" in value && value.endTag !== undefined) {
				end = Math.max(end, value.endTag.endOffset);
				continue;
			}
		}
		if ("childNodes" in current) {
			for (const child of current.childNodes) pending.push(child as Node);
		}
	}
	return end;
}

/** The first span starting at or after `offset`, in spans sorted by start. */
function firstFrom(spans: readonly Location[], offset: number): number {
	let low = 0;
	let high = spans.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((spans[middle] as Location).startOffset < offset) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * Every token's lines from parse5's own locations: tags, doctypes and text are code.
 *
 * A text node's location runs from its first character token to its last, so one merged across a
 * tag or comment elsewhere is cut at them. Only its non-whitespace stretches are code.
 */
function recordLayout(document: Node, text: string, layout: LayoutRecorder, file: (offset: number) => number): void {
	const walls: Location[] = [];
	const texts: Location[] = [];
	const wall = (span: Location | undefined, code: boolean, comment?: string): void => {
		if (span === undefined) return;
		walls.push(span);
		if (code) layout.code(file(span.startOffset), file(span.endOffset));
		else layout.comment(file(span.startOffset), file(span.endOffset), comment);
	};
	const pending: Array<{ node: Node; inTemplate: boolean }> = [{ node: document, inTemplate: false }];
	while (pending.length > 0) {
		const { node, inTemplate } = pending.pop() as { node: Node; inTemplate: boolean };
		const span = location(node);
		if (node.nodeName === "#text") {
			if (span !== undefined) texts.push(span);
			continue;
		}
		if (node.nodeName === "#comment") {
			const source = span === undefined ? "" : text.slice(span.startOffset, span.endOffset);
			// CDATA outside foreign content reads as a comment nobody wrote; template content is not indexed.
			wall(span, false, inTemplate || source.startsWith("<![CDATA[") ? undefined : source);
			continue;
		}
		if (node.nodeName === "#documentType") {
			wall(span, true);
			continue;
		}
		if ("tagName" in node) {
			const loc = node.sourceCodeLocation as ElementLocation | null | undefined;
			wall(loc?.startTag, true);
			wall(loc?.endTag, true);
		}
		if (node.nodeName === "template") {
			const content = (node as DefaultTreeAdapterMap["template"]).content;
			for (const child of content.childNodes) pending.push({ node: child as Node, inTemplate: true });
		}
		if ("childNodes" in node)
			for (const child of node.childNodes) pending.push({ node: child as Node, inTemplate });
	}

	walls.sort((left, right) => left.startOffset - right.startOffset);
	for (const span of texts) {
		const segments: OffsetRange[] = [];
		let from = span.startOffset;
		for (let at = firstFrom(walls, from); at < walls.length; at++) {
			const cut = walls[at] as Location;
			if (cut.startOffset >= span.endOffset) break;
			segments.push({ start: from, end: cut.startOffset });
			from = Math.max(from, cut.endOffset);
		}
		segments.push({ start: from, end: span.endOffset });
		for (const segment of segments) {
			if (segment.end <= segment.start) continue;
			const code = trimmedSpan(text.slice(segment.start, segment.end), segment.start);
			if (code !== undefined) layout.code(file(code.start), file(code.end));
		}
	}
}

export function readHtml(context: HtmlContext): HtmlFacts {
	const declarations: Declaration[] = [];
	const literals: Literal[] = [];
	const docs: DocRegion[] = [];
	const diagnostics: Diagnostic[] = [];
	const bom = context.text.startsWith("\uFEFF") ? 1 : 0;
	const text = context.text.slice(bom);
	let document: DefaultTreeAdapterMap["document"];
	try {
		document = parse(text, { sourceCodeLocationInfo: true, treeAdapter: gaugedTree() });
	} catch (failure) {
		if (!isTooDeep(failure)) throw failure;
		return {
			declarations,
			literals,
			comments: [],
			docs,
			diagnostics: [{ severity: "error", message: TOO_DEEP, path: context.module }],
		};
	}
	const layout = new LayoutRecorder(context.coordinates);
	recordLayout(document, text, layout, (offset) => context.offset + bom + offset);
	const { comments, blankLines } = layout.finish({
		start: context.offset,
		end: context.offset + context.text.length,
	});
	let heading: string | undefined;
	const addLiteral = (value: string, start: number, end: number, containerId: string, label: string): void => {
		if (value.trim() === "") return;
		if (value.length > LIMIT) {
			diagnostics.push(droppedKey("oversized", context.module, undefined, label, value.length));
			return;
		}
		const range = rangeAt(context, bom + start, bom + end);
		if (range !== undefined) literals.push({ kind: "string", value, range, containerId });
	};
	const pending: Array<{
		node: Node;
		parentId?: string;
		inFence: boolean;
		parents: Array<{ kind: "term"; name: string }>;
	}> = document.childNodes.map((node) => ({ node, inFence: false, parents: [] })).reverse();
	while (pending.length > 0) {
		const current = pending.pop() as {
			node: Node;
			parentId?: string;
			inFence: boolean;
			parents: Array<{ kind: "term"; name: string }>;
		};
		const node = current.node;
		const parentId = current.parentId;
		const inFence = current.inFence;
		const parents = current.parents;
		if (node.nodeName === "#comment" || node.nodeName === "#text") continue;
		if (node.nodeName === "#documentType" || node.nodeName === "template") continue;
		if (!("tagName" in node)) {
			if ("childNodes" in node)
				for (let index = node.childNodes.length - 1; index >= 0; index--)
					pending.push({
						node: node.childNodes[index] as Node,
						...defined({ parentId }),
						inFence,
						parents,
					});
			continue;
		}
		const element = node as Element;
		const loc = element.sourceCodeLocation as ElementLocation | null | undefined;
		if (loc === null || loc === undefined) {
			for (let index = element.childNodes.length - 1; index >= 0; index--)
				pending.push({
					node: element.childNodes[index] as Node,
					...defined({ parentId }),
					inFence,
					parents,
				});
			continue;
		}
		const tag = element.tagName.toLowerCase();
		const startTag = loc.startTag;
		const start = startTag.startOffset;
		const end = loc.endTag?.endOffset ?? sourceEnd(element);
		const isHeading = HEADING.test(tag);
		// A heading is named by what it says; every other element by its identity, else its tag.
		const identityAttribute = isHeading
			? undefined
			: element.attrs.find(
					(attribute) =>
						["id", "name", "key"].includes(attribute.name.toLowerCase().split(":").pop() ?? "") &&
						attribute.value !== "",
				);
		const identityLocation = identityAttribute === undefined ? undefined : loc.attrs?.[identityAttribute.name];
		const identityValue =
			identityLocation === undefined
				? undefined
				: attributeValue(text, identityLocation.startOffset, identityLocation.endOffset);
		const headingText = isHeading ? collapse(textOf(element)) : "";
		const declarationName = identityAttribute?.value ?? (headingText !== "" ? headingText : tag);
		const descriptors = [...parents, { kind: "term" as const, name: declarationName }];
		const symbolId = composeSymbolId({ language: context.language, module: context.module, descriptors });
		const declarationRange = rangeAt(context, bom + start, bom + end);
		const selection =
			identityValue === undefined
				? rangeAt(context, bom + start + 1, bom + start + 1 + tag.length)
				: rangeAt(context, bom + identityValue.inner.start, bom + identityValue.inner.end);
		if (declarationRange !== undefined && selection !== undefined) {
			const values = element.attrs.flatMap((attribute) => {
				const at = loc.attrs?.[attribute.name];
				const value = at === undefined ? undefined : attributeValue(text, at.startOffset, at.endOffset);
				return value === undefined ? [] : [value];
			});
			declarations.push({
				symbolId,
				kind: isHeading ? "heading" : "property",
				name: declarationName,
				range: declarationRange,
				selectionRange: selection,
				visibility: "public",
				...defined({
					signature: startTagSignature(text, start, startTag.endOffset, values),
					containerId: parentId,
				}),
			});
		}
		for (const attribute of element.attrs) {
			const attrLoc = loc.attrs?.[attribute.name];
			if (attrLoc === undefined) continue;
			const attrId = composeSymbolId({
				language: context.language,
				module: context.module,
				descriptors: [...descriptors, { kind: "term", name: attribute.name }],
			});
			const attrRange = rangeAt(context, bom + attrLoc.startOffset, bom + attrLoc.endOffset);
			const attrNameEnd = attrLoc.startOffset + attribute.name.length;
			const value = attributeValue(text, attrLoc.startOffset, attrLoc.endOffset);
			if (attrRange !== undefined)
				declarations.push({
					symbolId: attrId,
					kind: "field",
					name: attribute.name,
					range: attrRange,
					selectionRange: rangeAt(context, bom + attrLoc.startOffset, bom + attrNameEnd),
					visibility: "public",
					containerId: symbolId,
				});
			if (value !== undefined) addLiteral(attribute.value, value.start, value.end, attrId, attribute.name);
		}
		if (isHeading) heading = symbolId;
		// A block's own prose: the text reachable without crossing another block, over its inner source.
		if (!isHeading && !PHRASING.has(tag) && !RAW.includes(tag)) {
			const visible = collapse(textOf(element, true));
			if (visible !== "") {
				const innerStart = startTag.endOffset;
				const innerEnd = loc.endTag?.startOffset ?? end;
				const regionRange = rangeAt(context, bom + innerStart, bom + innerEnd);
				if (regionRange !== undefined)
					docs.push({
						range: regionRange,
						text: text.slice(innerStart, innerEnd),
						plain: visible,
						fenced: inFence || tag === "pre" || tag === "code",
						...defined({ anchorId: heading }),
					});
			}
		}
		if (RAW.includes(tag)) continue;
		for (let index = element.childNodes.length - 1; index >= 0; index--)
			pending.push({
				node: element.childNodes[index] as Node,
				parentId: symbolId,
				inFence: inFence || tag === "pre" || tag === "code",
				parents: descriptors,
			});
	}
	return { declarations, literals, comments, blankLines, docs, diagnostics };
}
