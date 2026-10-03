import { childOfType, nameText, type SyntaxNode } from "./tree.js";

export interface LiteralShape {
	kind: "string" | "number" | "boolean" | "null";
	display: string;
	value: string;
	number?: number;
	/** Its lines lose their common indentation. */
	dedented?: true;
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

function stringValue(text: string, node: SyntaxNode): string {
	let value = "";
	for (const child of node.children) {
		const part = text.slice(child.start, child.end);
		if (child.type === "string_content" || child.type === "interpolation") value += part;
		else if (child.type === "escape_sequence") value += decodeEscape(part);
	}
	return value;
}

/** A raw string receiving `.trimIndent()` directly; a non-blank first line joins the indent, so it must be blank. */
function trimsIndent(text: string, node: SyntaxNode): boolean {
	const navigation = node.parent;
	const call = navigation?.parent;
	if (navigation?.type !== "navigation_expression" || navigation.children[0] !== node) return false;
	const [, operator, name] = navigation.children;
	if ((operator?.type !== "." && operator?.type !== "?.") || name?.type !== "identifier") return false;
	if (nameText(text, name) !== "trimIndent") return false;
	if (call?.type !== "call_expression" || call.children[0] !== navigation) return false;
	const args = call.children[1];
	// The standard library's takes none.
	if (args?.type !== "value_arguments" || args.children.some((arg) => arg.type !== "(" && arg.type !== ")"))
		return false;
	const opener = node.children[0];
	if (opener === undefined) return false;
	const content = text.slice(opener.end, node.end);
	const lineBreak = content.search(/[\r\n]/u);
	return lineBreak !== -1 && content.slice(0, lineBreak).trim() === "";
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
			return { kind: "string", display: "String", value: stringValue(text, node) };
		case "multiline_string_literal": {
			const shape: LiteralShape = { kind: "string", display: "String", value: stringValue(text, node) };
			if (trimsIndent(text, node)) shape.dedented = true;
			return shape;
		}
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
