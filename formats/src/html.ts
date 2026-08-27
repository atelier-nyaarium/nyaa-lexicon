import {
	composeSymbolId,
	type Declaration,
	type Diagnostic,
	type DocRegion,
	type Literal,
	type Range,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import { markupTooDeep, TOO_DEEP } from "./depth.js";
import { droppedKey } from "./dropped.js";

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
	comments: Array<{ range: Range; text: string }>;
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

/** A start tag as a signature, cut so a value of megabytes does not ride along. */
const SIGNATURE_CAP = 160;

function signatureOf(text: string, start: number, end: number): string {
	const tag = text.slice(start, end);
	return tag.length > SIGNATURE_CAP ? `${tag.slice(0, SIGNATURE_CAP)}...` : tag;
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

export function readHtml(context: HtmlContext): HtmlFacts {
	const declarations: Declaration[] = [];
	const literals: Literal[] = [];
	const comments: Array<{ range: Range; text: string }> = [];
	const docs: DocRegion[] = [];
	const diagnostics: Diagnostic[] = [];
	const bom = context.text.startsWith("\uFEFF") ? 1 : 0;
	const text = context.text.slice(bom);
	if (markupTooDeep(text, undefined, RAW))
		return {
			declarations,
			literals,
			comments,
			docs,
			diagnostics: [{ severity: "error", message: TOO_DEEP, path: context.module }],
		};
	const document = parse(text, { sourceCodeLocationInfo: true }) as DefaultTreeAdapterMap["document"];
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
		if (node.nodeName === "#comment") {
			const span = location(node);
			if (span !== undefined && !text.slice(span.startOffset, span.endOffset).startsWith("<![CDATA[")) {
				const range = rangeAt(context, bom + span.startOffset, bom + span.endOffset);
				if (range !== undefined) comments.push({ range, text: text.slice(span.startOffset, span.endOffset) });
			}
			continue;
		}
		if (node.nodeName === "#text") continue;
		if (node.nodeName === "#documentType" || node.nodeName === "template") continue;
		if (!("tagName" in node)) {
			if ("childNodes" in node)
				for (let index = node.childNodes.length - 1; index >= 0; index--)
					pending.push({
						node: node.childNodes[index] as Node,
						...(parentId === undefined ? {} : { parentId }),
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
					...(parentId === undefined ? {} : { parentId }),
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
			declarations.push({
				symbolId,
				kind: isHeading ? "heading" : "property",
				name: declarationName,
				range: declarationRange,
				selectionRange: selection,
				visibility: "public",
				signature: signatureOf(text, start, startTag.endOffset),
				...(parentId === undefined ? {} : { containerId: parentId }),
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
						...(heading === undefined ? {} : { anchorId: heading }),
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
	return { declarations, literals, comments, docs, diagnostics };
}
