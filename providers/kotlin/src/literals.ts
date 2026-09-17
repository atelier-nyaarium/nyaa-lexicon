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
