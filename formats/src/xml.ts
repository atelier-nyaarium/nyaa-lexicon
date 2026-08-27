import {
	composeSymbolId,
	type Declaration,
	type Diagnostic,
	type Literal,
	type Range,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import { parseXml, XmlCdata, XmlComment, XmlElement, type XmlNode, XmlText } from "@rgrove/parse-xml";
import { markupTooDeep, TOO_DEEP } from "./depth.js";
import { droppedKey } from "./dropped.js";

export interface XmlContext {
	language: string;
	module: string;
	text: string;
	offset: number;
	coordinates: TextCoordinates;
}

export interface XmlFacts {
	declarations: Declaration[];
	literals: Literal[];
	comments: Array<{ range: Range; text: string }>;
	diagnostics: Diagnostic[];
}

const LIMIT = 16_384;

interface AttributeSpan {
	name: string;
	value: string;
	nameStart: number;
	valueStart: number;
	valueEnd: number;
}

function localName(name: string): string {
	const at = name.indexOf(":");
	return (at < 0 ? name : name.slice(at + 1)).toLowerCase();
}

function tagEnd(text: string, start: number): number | undefined {
	let quote: string | null = null;
	for (let i = start; i < text.length; i++) {
		const ch = text[i] as string;
		if (quote !== null) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === ">") return i;
	}
	return undefined;
}

/** A start tag as a signature, cut so a value of megabytes does not ride along. */
const SIGNATURE_CAP = 160;

function signatureOf(text: string, start: number, end: number): string {
	const tag = text.slice(start, end);
	return tag.length > SIGNATURE_CAP ? `${tag.slice(0, SIGNATURE_CAP)}...` : tag;
}

/** The attributes as written in one start tag, by a cursor that stops at the closing bracket. */
function scanAttributes(text: string, start: number, end: number): { spans: AttributeSpan[] } {
	const spans: AttributeSpan[] = [];
	let i = start + 1;
	while (i < end && /\s/u.test(text[i] as string)) i++;
	while (i < end && text[i] !== ">") {
		if (text[i] === "/") {
			i++;
			continue;
		}
		const nameStart = i;
		while (i < end && !/[\s=/>]/u.test(text[i] as string)) i++;
		if (i === nameStart) {
			i++;
			continue;
		}
		const name = text.slice(nameStart, i);
		while (i < end && /\s/u.test(text[i] as string)) i++;
		if (text[i] !== "=") continue;
		i++;
		while (i < end && /\s/u.test(text[i] as string)) i++;
		const quote = text[i] as string;
		if (quote !== '"' && quote !== "'") continue;
		const valueStart = i;
		i++;
		while (i < end && text[i] !== quote) i++;
		const valueEnd = Math.min(i + 1, end);
		spans.push({
			name,
			value: text.slice(valueStart + 1, Math.max(valueStart + 1, i)),
			nameStart,
			valueStart,
			valueEnd,
		});
		i = valueEnd;
	}
	return { spans };
}

function rangeAt(context: XmlContext, start: number, end: number): Range | undefined {
	return context.coordinates.rangeAt(context.offset + start, context.offset + end);
}

export function readXml(context: XmlContext): XmlFacts {
	const declarations: Declaration[] = [];
	const literals: Literal[] = [];
	const comments: Array<{ range: Range; text: string }> = [];
	const diagnostics: Diagnostic[] = [];
	const bom = context.text.startsWith("\uFEFF") ? 1 : 0;
	const text = context.text.slice(bom);
	if (text.trim() === "") return { declarations, literals, comments, diagnostics };
	if (markupTooDeep(text))
		return {
			declarations,
			literals,
			comments,
			diagnostics: [{ severity: "error", message: TOO_DEEP, path: context.module }],
		};
	let document: { children: XmlNode[] };
	try {
		document = parseXml(text, { includeOffsets: true, preserveComments: true, preserveCdata: true }) as unknown as {
			children: XmlNode[];
		};
	} catch (error) {
		const failure = error as { message?: string; pos?: number };
		const at = typeof failure.pos === "number" ? rangeAt(context, bom + failure.pos, bom + failure.pos) : undefined;
		return {
			declarations,
			literals,
			comments,
			diagnostics: [
				{
					severity: "error",
					message: failure.message ?? String(error),
					path: context.module,
					...(at === undefined ? {} : { range: at }),
				},
			],
		};
	}

	const addLiteral = (value: string, start: number, end: number, containerId: string, label: string): void => {
		if (value.trim() === "") return;
		const range = rangeAt(context, bom + start, bom + end);
		if (value.length > LIMIT) {
			diagnostics.push(droppedKey("oversized", context.module, range, label, value.length));
			return;
		}
		if (range !== undefined) literals.push({ kind: "string", value, range, containerId });
	};

	interface Pending {
		node: XmlNode;
		parentId?: string;
		parentName?: string;
		parents: Array<{ kind: "term"; name: string }>;
	}
	const pending: Pending[] = document.children.map((node) => ({ node, parents: [] })).reverse();
	while (pending.length > 0) {
		const current = pending.pop() as Pending;
		const node = current.node;
		const parentId = current.parentId;
		const parents = current.parents;
		if (node instanceof XmlComment) {
			const range = rangeAt(context, bom + node.start, bom + node.end);
			if (range !== undefined) comments.push({ range, text: text.slice(node.start, node.end) });
			continue;
		}
		if (node instanceof XmlText || node instanceof XmlCdata) {
			if (parentId !== undefined) addLiteral(node.text, node.start, node.end, parentId, current.parentName ?? "");
			continue;
		}
		if (!(node instanceof XmlElement)) continue;
		const end = tagEnd(text, node.start);
		if (end === undefined) continue;
		const scan = scanAttributes(text, node.start, end);
		const parsedNames = Object.keys(node.attributes);
		if (scan.spans.length !== parsedNames.length || scan.spans.some((item) => !(item.name in node.attributes))) {
			diagnostics.push({
				severity: "info",
				message: `attribute scan disagreed with the parser on ${node.name}`,
				path: context.module,
			});
		}
		const identity = ["id", "name", "key"].map((wanted) =>
			scan.spans.find((item) => localName(item.name) === wanted && item.value !== ""),
		);
		const promoted = identity.find((item) => item !== undefined);
		const name = promoted?.value ?? node.name;
		// The rename span is the identity as written, inside its quotes.
		const selectionRange =
			promoted === undefined
				? rangeAt(context, bom + node.start + 1, bom + node.start + 1 + node.name.length)
				: rangeAt(
						context,
						bom + promoted.valueStart + 1,
						bom + Math.max(promoted.valueStart + 1, promoted.valueEnd - 1),
					);
		const range = rangeAt(context, bom + node.start, bom + node.end);
		if (selectionRange === undefined || range === undefined) continue;
		const descriptors = [...parents, { kind: "term" as const, name }];
		const elementId = composeSymbolId({ language: context.language, module: context.module, descriptors });
		declarations.push({
			symbolId: elementId,
			kind: "property",
			name,
			range,
			selectionRange,
			visibility: "public",
			signature: signatureOf(text, node.start, end + 1),
			...(parentId === undefined ? {} : { containerId: parentId }),
		});
		for (const attribute of scan.spans) {
			const attrRange = rangeAt(context, bom + attribute.nameStart, bom + attribute.valueEnd);
			const attrSelection = rangeAt(
				context,
				bom + attribute.nameStart,
				bom + attribute.nameStart + attribute.name.length,
			);
			if (attrRange === undefined || attrSelection === undefined) continue;
			const attrId = composeSymbolId({
				language: context.language,
				module: context.module,
				descriptors: [...descriptors, { kind: "term", name: attribute.name }],
			});
			declarations.push({
				symbolId: attrId,
				kind: "field",
				name: attribute.name,
				range: attrRange,
				selectionRange: attrSelection,
				visibility: "public",
				containerId: elementId,
			});
			addLiteral(attribute.value, attribute.valueStart, attribute.valueEnd, attrId, attribute.name);
		}
		for (let index = node.children.length - 1; index >= 0; index--) {
			const child = node.children[index] as XmlNode;
			pending.push({ node: child, parentId: elementId, parentName: name, parents: descriptors });
		}
	}
	return { declarations, literals, comments, diagnostics };
}
