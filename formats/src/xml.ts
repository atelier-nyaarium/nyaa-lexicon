import {
	type CommentSpan,
	composeSymbolId,
	type Declaration,
	type Diagnostic,
	defined,
	type Literal,
	type Range,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import { droppedKey } from "./dropped.js";
import { LayoutRecorder } from "./layout.js";
import { startTagSignature } from "./startTag.js";
import { isBlankDocument, parseXmlDocument } from "./xml/parser.js";
import { contentSpan, isWhiteSpace, type XmlContent } from "./xml/syntax.js";

// The tree itself, for a provider reading its own XML (MSBuild projects).
export { parseXmlDocument } from "./xml/parser.js";
export type {
	XmlAttribute,
	XmlContent,
	XmlDocument,
	XmlElement,
	XmlParse,
	XmlProblem,
	XmlText,
} from "./xml/syntax.js";

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
	comments: CommentSpan[];
	/** Absent when the text did not parse. */
	blankLines?: number[];
	diagnostics: Diagnostic[];
}

const LIMIT = 16_384;

/** Attributes that name their element, first found first. */
const IDENTITY = ["id", "name", "key"];

function localName(name: string): string {
	const at = name.indexOf(":");
	return (at < 0 ? name : name.slice(at + 1)).toLowerCase();
}

function rangeAt(context: XmlContext, start: number, end: number): Range | undefined {
	return context.coordinates.rangeAt(context.offset + start, context.offset + end);
}

export function readXml(context: XmlContext): XmlFacts {
	const declarations: Declaration[] = [];
	const literals: Literal[] = [];
	const diagnostics: Diagnostic[] = [];
	const text = context.text;
	const layout = new LayoutRecorder(context.coordinates);
	const extent = { start: context.offset, end: context.offset + text.length };
	if (isBlankDocument(text))
		return { declarations, literals, comments: [], blankLines: layout.finish(extent).blankLines, diagnostics };
	const parsed = parseXmlDocument(text);
	if (parsed.problem !== undefined) {
		const { message, pos } = parsed.problem;
		const range = rangeAt(context, pos, pos);
		diagnostics.push({ severity: "error", message, path: context.module, ...defined({ range }) });
		return { declarations, literals, comments: [], diagnostics };
	}
	const { document } = parsed;

	const file = (offset: number): number => context.offset + offset;
	for (const token of document.tokens) {
		const piece = text.slice(token.pos, token.end);
		if (token.kind === "comment") layout.comment(file(token.pos), file(token.end), piece);
		else if (token.kind !== "text") layout.code(file(token.pos), file(token.end));
		else {
			// White space text is not code.
			const code = contentSpan(piece, token.pos);
			if (code !== undefined) layout.code(file(code.pos), file(code.end));
		}
	}

	const addLiteral = (value: string, start: number, end: number, containerId: string, label: string): void => {
		if (isWhiteSpace(value)) return;
		const range = rangeAt(context, start, end);
		if (value.length > LIMIT) {
			diagnostics.push(droppedKey("oversized", context.module, range, label, value.length));
			return;
		}
		if (range !== undefined) literals.push({ kind: "string", value, range, containerId });
	};

	interface Pending {
		node: XmlContent;
		parentId?: string;
		parentName?: string;
		parents: Array<{ kind: "term"; name: string }>;
	}
	const pending: Pending[] = [{ node: document.root, parents: [] }];
	while (pending.length > 0) {
		const { node, parentId, parentName, parents } = pending.pop() as Pending;
		if (node.type === "text" || node.type === "cdata") {
			if (parentId !== undefined) addLiteral(node.text, node.pos, node.end, parentId, parentName ?? "");
			continue;
		}
		if (node.type !== "element") continue;
		const promoted = IDENTITY.map((wanted) =>
			node.attributes.find((attribute) => localName(attribute.name) === wanted && attribute.value !== ""),
		).find((attribute) => attribute !== undefined);
		const name = promoted?.value ?? node.name;
		// The rename span is the identity as written, inside its quotes.
		const selectionRange =
			promoted === undefined
				? rangeAt(context, node.pos + 1, node.pos + 1 + node.name.length)
				: rangeAt(context, promoted.valuePos + 1, Math.max(promoted.valuePos + 1, promoted.end - 1));
		const range = rangeAt(context, node.pos, node.end);
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
			...defined({
				signature: startTagSignature(
					text,
					node.pos,
					node.startTagEnd,
					node.attributes.map((attribute) => ({ start: attribute.valuePos, end: attribute.end })),
				),
				containerId: parentId,
			}),
		});
		for (const attribute of node.attributes) {
			const attrRange = rangeAt(context, attribute.pos, attribute.end);
			const attrSelection = rangeAt(context, attribute.pos, attribute.nameEnd);
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
			addLiteral(attribute.value, attribute.valuePos, attribute.end, attrId, attribute.name);
		}
		for (let index = node.children.length - 1; index >= 0; index--) {
			const child = node.children[index] as XmlContent;
			pending.push({ node: child, parentId: elementId, parentName: name, parents: descriptors });
		}
	}
	const { comments, blankLines } = layout.finish(extent);
	return { declarations, literals, comments, blankLines, diagnostics };
}
