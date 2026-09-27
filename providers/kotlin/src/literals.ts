import { defined } from "@nyaa-lexicon/protocol";
import { childOfType, type SyntaxNode } from "./tree.js";

export interface LiteralShape {
	kind: "string" | "number" | "boolean" | "null";
	display: string;
	value: string;
	number?: number;
}

const ESCAPES: Record<string, string> = {
	b: "\b",
	n: "\n",
	r: "\r",
	t: "\t",
	"0": "\0",
};

function decodeEscape(raw: string): string {
	const body = raw.slice(1);
	if (body.startsWith("u") && body.length === 5) {
		const code = Number.parseInt(body.slice(1), 16);
		if (Number.isFinite(code)) return String.fromCharCode(code);
	}
	return ESCAPES[body] ?? body;
}

const HEX_RE = /^[0-9A-Fa-f]{4}/u;

/** A template opener as the grammar read it. */
export interface TemplateEntry {
	/** The `$` or `${` leaf. */
	opener: SyntaxNode;
	/** Dollars ending at the opener. */
	dollars: number;
	/** `$name` read as content: the name. */
	name?: [number, number];
}

function identifierCharacter(character: string, first: boolean): boolean {
	return character === "_" || /^\p{L}$/u.test(character) || (!first && /^\p{Nd}$/u.test(character));
}

/** The grammar leaves `"$name"` as contents `$` and `name`. */
export function shortTemplateName(text: string, node: SyntaxNode): [number, number] | undefined {
	if (node.type !== "string_content" || node.end - node.start !== 1 || text.charAt(node.start) !== "$") return;
	const siblings = node.parent?.children ?? [];
	const next = siblings[siblings.indexOf(node) + 1];
	if (next?.type !== "string_content" || next.start !== node.end) return;
	let end = next.start;
	while (end < next.end && identifierCharacter(text.charAt(end), end === next.start)) end++;
	return end === next.start ? undefined : [next.start, end];
}

/** `$` characters ending one content's own text. */
function trailingDollars(part: string): number {
	let count = 0;
	while (count < part.length && part.charAt(part.length - 1 - count) === "$") count++;
	return count;
}

/** Dollars ending the adjacent contents before `index`. */
function dollarsBefore(text: string, children: SyntaxNode[], index: number): number {
	let count = 0;
	for (let at = index - 1; at >= 0; at--) {
		const content = children[at] as SyntaxNode;
		if (content.type !== "string_content" || content.end !== (children[at + 1] as SyntaxNode).start) break;
		const part = text.slice(content.start, content.end);
		const dollars = trailingDollars(part);
		count += dollars;
		if (dollars < part.length) break;
	}
	return count;
}

/** Every template opener in a string literal. */
export function templateEntries(text: string, literal: SyntaxNode): TemplateEntry[] {
	const entries: TemplateEntry[] = [];
	const { children } = literal;
	for (let index = 0; index < children.length; index++) {
		const child = children[index] as SyntaxNode;
		const name = shortTemplateName(text, child);
		const opener = child.type === "interpolation" ? child.children[0] : name === undefined ? undefined : child;
		if (opener !== undefined)
			entries.push({ opener, dollars: 1 + dollarsBefore(text, children, index), ...defined({ name }) });
	}
	return entries;
}

/** The grammar splits `A` into contents `\u` and `0041`. */
function stringValue(text: string, node: SyntaxNode): string {
	let value = "";
	let unicode = false;
	for (const child of node.children) {
		let part = text.slice(child.start, child.end);
		if (unicode && child.type === "string_content" && HEX_RE.test(part)) {
			value = value.slice(0, -2) + String.fromCharCode(Number.parseInt(part.slice(0, 4), 16));
			part = part.slice(4);
		}
		unicode = node.type === "string_literal" && child.type === "string_content" && part.endsWith("\\u");
		if (child.type === "string_content" || child.type === "interpolation") value += part;
		else if (child.type === "escape_sequence") value += decodeEscape(part);
	}
	return value;
}

function numberShape(raw: string): LiteralShape | null {
	let body = raw.replaceAll("_", "");
	const radix = /^0[xXbB]/u.test(body);
	let long = false;
	let unsigned = false;
	let float = false;
	if (/[lL]$/u.test(body)) {
		long = true;
		body = body.slice(0, -1);
	}
	if (/[uU]$/u.test(body)) {
		unsigned = true;
		body = body.slice(0, -1);
	}
	if (!radix && !long && !unsigned && /[fF]$/u.test(body)) {
		float = true;
		body = body.slice(0, -1);
	}
	const number = Number(body);
	if (!Number.isFinite(number)) return null;
	const display = unsigned
		? long
			? "ULong"
			: "UInt"
		: long
			? "Long"
			: float
				? "Float"
				: !radix && /[.eE]/u.test(body)
					? "Double"
					: "Int";
	return { kind: "number", display, value: raw, number };
}

export function literalShape(text: string, node: SyntaxNode): LiteralShape | null {
	switch (node.type) {
		case "string_literal":
		case "multiline_string_literal":
			return { kind: "string", display: "String", value: stringValue(text, node) };
		case "character_literal": {
			const sequence = childOfType(node, "escape_sequence");
			const value =
				sequence === undefined
					? text.slice(node.start + 1, node.end - 1)
					: decodeEscape(text.slice(sequence.start, sequence.end));
			return { kind: "string", display: "Char", value };
		}
		case "number_literal":
		case "float_literal":
			return numberShape(text.slice(node.start, node.end));
		case "identifier": {
			const word = text.slice(node.start, node.end);
			if (word === "true" || word === "false") return { kind: "boolean", display: "Boolean", value: word };
			if (word === "null") return { kind: "null", display: "Nothing?", value: word };
			return null;
		}
		default:
			return null;
	}
}
