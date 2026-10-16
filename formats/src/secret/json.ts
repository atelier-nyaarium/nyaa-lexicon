// Unions strict and tolerant JSON readers.
// Truncated tails can set any key; other errors stay container-scoped.
// The protocol owns masking.

import type { OffsetRange } from "@nyaa-lexicon/protocol";
import {
	type ScalarReading,
	SecretBudgetError,
	type SecretFormat,
	type SecretHazard,
	type SecretNode,
	type SecretSyntax,
	type SecretSyntaxDocument,
} from "@nyaa-lexicon/protocol/secretSyntax";
import { type Node, type ParseError, parseTree } from "jsonc-parser/lib/esm/main.js";
import {
	APOSTROPHE,
	BACKSLASH,
	COLON,
	CR,
	DOLLAR,
	hexRun,
	hexValue,
	includesWithin,
	isWord,
	type KeyRead,
	LF,
	QUOTE,
	SLASH,
	skipSpaces,
	someEscaped,
	someOccurrence,
	TAB,
	unitAt,
} from "./spelling.js";

////////////////////////////////
//  Constants

const MAX_DEPTH = 512;
const MAX_NODES = 3_000_000;
/** Files beyond this error budget start broken. */
const MAX_ERRORS = 32;
const BYTE_ORDER_MARK = 0xfeff;
const INTEGER = /^-?(?:0|[1-9][0-9]{0,14})$/;
/** Array indices have no key spelling. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

// jsonc-parser error codes.
const INVALID_NUMBER = 2;
const CLOSE_BRACE_EXPECTED = 7;
const CLOSE_BRACKET_EXPECTED = 8;
const END_OF_FILE_EXPECTED = 9;
const UNEXPECTED_END_OF_STRING = 12;
const INVALID_UNICODE = 14;
const INVALID_ESCAPE = 15;

/** Cached fields for document checks. */
interface Details {
	source: string;
	trees: Array<Node | undefined>;
	/** Malformed string and number offsets. */
	lossy: ReadonlySet<number>;
}

const details = new WeakMap<SecretSyntaxDocument, Details>();

////////////////////////////////
//  Functions & Helpers

function clamp(node: Node, length: number): OffsetRange {
	return { start: Math.min(node.offset, length), end: Math.min(node.offset + node.length, length) };
}

function nameOf(key: Node, text: string): string[] {
	const decoded = String(key.value);
	const end = Math.min(key.offset + key.length, text.length);
	const closed = end - key.offset >= 2 && text[end - 1] === '"';
	const raw = text.slice(key.offset + 1, closed ? end - 1 : end);
	return raw === decoded ? [decoded] : [decoded, raw];
}

function scalarOf(node: Node | undefined, text: string, lossy: boolean): ScalarReading {
	if (node === undefined) return { kind: "uncertain", empty: true };
	switch (node.type) {
		case "string": {
			const value = String(node.value);
			return lossy ? { kind: "uncertain", empty: value === "" } : { kind: "decided", value, empty: value === "" };
		}
		case "number": {
			const source = text.slice(node.offset, node.offset + node.length);
			return INTEGER.test(source)
				? { kind: "decided", value: source, empty: false }
				: { kind: "uncertain", empty: false };
		}
		case "boolean":
			return { kind: "decided", value: String(node.value), empty: false };
		case "null":
			return { kind: "uncertain", empty: true };
		default:
			return { kind: "uncertain", empty: (node.children?.length ?? 0) === 0 };
	}
}

/** Last unclosed node in the child spine. */
function unclosedContainer(root: Node | undefined, text: string, indexes: Map<Node, number>): number {
	let found = 0;
	for (let node = root; node !== undefined; ) {
		if (node.type === "object" || node.type === "array") {
			const closer = node.type === "object" ? "}" : "]";
			if (text[node.offset + node.length - 1] !== closer) return indexes.get(node) ?? found;
			found = indexes.get(node) ?? found;
		}
		const last = node.children?.[node.children.length - 1];
		node = node.type === "property" ? node.children?.[1] : last;
	}
	return found;
}

/** Innermost container at an offset. */
function containerAt(root: Node | undefined, offset: number, indexes: Map<Node, number>): number {
	let found = 0;
	let node = root;
	while (node !== undefined) {
		const next: Node | undefined = (node.children ?? [])
			.map((child) => (child.type === "property" ? child.children?.[1] : child))
			.find(
				(child) =>
					child !== undefined &&
					(child.type === "object" || child.type === "array") &&
					child.offset <= offset &&
					offset <= child.offset + child.length,
			);
		if (next === undefined) break;
		found = indexes.get(next) ?? found;
		node = next;
	}
	return found;
}

function hazardOf(error: ParseError, length: number, within: number): SecretHazard {
	const start = Math.min(error.offset, length);
	if (error.error === END_OF_FILE_EXPECTED)
		return { span: { start, end: length }, within: 0, reach: "any", reshapes: false };
	if (error.error === CLOSE_BRACE_EXPECTED || error.error === CLOSE_BRACKET_EXPECTED)
		return { span: { start, end: start }, within, reach: "any", reshapes: false };
	return {
		span: { start, end: Math.min(error.offset + error.length, length) },
		within,
		reach: "spelled",
		reshapes: false,
	};
}

function readJson(text: string): SecretSyntax {
	const errors: ParseError[] = [];
	const source = text.charCodeAt(0) === BYTE_ORDER_MARK ? ` ${text.slice(1)}` : text;
	const root = parseTree(source, errors, {
		disallowComments: false,
		allowTrailingComma: true,
		allowEmptyContent: true,
	});
	const nodes: SecretNode[] = [];
	const trees: Array<Node | undefined> = [];
	const indexes = new Map<Node, number>();
	const lossy = new Set<number>();
	for (const error of errors) {
		if (
			error.error !== INVALID_ESCAPE &&
			error.error !== INVALID_UNICODE &&
			error.error !== UNEXPECTED_END_OF_STRING &&
			error.error !== INVALID_NUMBER
		)
			continue;
		lossy.add(error.offset);
	}

	function add(
		node: Node | undefined,
		parent: number,
		names: string[],
		index: number | undefined,
		key: OffsetRange,
		missing: OffsetRange,
		depth: number,
	): number {
		if (depth > MAX_DEPTH) throw new SecretBudgetError("depth");
		if (nodes.length >= MAX_NODES) throw new SecretBudgetError("size");
		const at = nodes.length;
		const value = node === undefined ? missing : clamp(node, text.length);
		const children: number[] = [];
		const owned: SecretNode = {
			parent,
			names,
			...(index === undefined ? {} : { index }),
			key,
			value,
			children,
			via: [],
			virtual: false,
		};
		nodes.push(owned);
		trees.push(node);
		if (node === undefined) return at;
		if (node.type === "object") {
			if (errors.length > 0) indexes.set(node, at);
			for (const property of node.children ?? []) {
				const [keyNode, valueNode] = property.children ?? [];
				if (keyNode === undefined || keyNode.type !== "string") continue;
				const key = clamp(keyNode, text.length);
				const slot = { start: key.end, end: Math.max(key.end, clamp(property, text.length).end) };
				children.push(add(valueNode, at, nameOf(keyNode, source), undefined, key, slot, depth + 1));
			}
		} else if (node.type === "array") {
			if (errors.length > 0) indexes.set(node, at);
			(node.children ?? []).forEach((item, position) => {
				const start = Math.min(item.offset, text.length);
				children.push(
					add(
						item,
						at,
						[String(position)],
						position,
						{ start, end: start },
						{ start, end: start },
						depth + 1,
					),
				);
			});
		}
		return at;
	}

	add(root, -1, [], undefined, { start: 0, end: 0 }, { start: 0, end: 0 }, 0);
	const hazards: SecretHazard[] = [];
	if (errors.length > MAX_ERRORS) {
		hazards.push({
			span: { start: Math.min(errors[0]?.offset ?? 0, text.length), end: text.length },
			within: 0,
			reach: "any",
			reshapes: true,
		});
	} else {
		for (const error of errors) {
			const closing = error.error === CLOSE_BRACE_EXPECTED || error.error === CLOSE_BRACKET_EXPECTED;
			const within = closing
				? unclosedContainer(root, source, indexes)
				: containerAt(root, error.offset, indexes);
			hazards.push(hazardOf(error, text.length, within));
		}
	}
	const document: SecretSyntaxDocument = { nodes, hazards };
	details.set(document, { source, trees, lossy });
	return { documents: [document] };
}

////////////////////////////////
//  Prefilter

/** Bare key characters. */
function isIdentifier(code: number): boolean {
	return isWord(code) || code === DOLLAR;
}

/** Bare keys with escapes. */
function isBare(code: number): boolean {
	return isIdentifier(code) || code === BACKSLASH || code >= 0x80;
}

/** Whether a name spells a whole key. */
function isKeyToken(text: string, start: number, end: number): boolean {
	const before = unitAt(text, start - 1);
	if (before === QUOTE || before === APOSTROPHE) {
		const after = unitAt(text, end);
		return after === QUOTE || after === APOSTROPHE || after === LF || after === CR || after === -1;
	}
	if (isIdentifier(before) && isIdentifier(text.charCodeAt(start))) return false;
	const next = skipSpaces(text, end);
	if (next >= text.length || text.charCodeAt(next) === COLON) return true;
	return text.charCodeAt(next) === SLASH && (text[next + 1] === "/" || text[next + 1] === "*");
}

/** Escaped unit, or -1. */
function simpleEscape(code: number): number {
	switch (code) {
		case QUOTE:
		case BACKSLASH:
		case SLASH:
			return code;
		case 0x62: // b
			return 0x08;
		case 0x66: // f
			return 0x0c;
		case 0x6e: // n
			return LF;
		case 0x72: // r
			return CR;
		case 0x74: // t
			return TAB;
		default:
			return -1;
	}
}

/** Escapes read inconsistently by parsers. */
function isUndefinedEscape(text: string, slash: number): boolean {
	const next = text.charCodeAt(slash + 1);
	return next === 0x75 ? hexRun(text, slash + 2, 4) < 4 : simpleEscape(next) === -1;
}

/**
 * Reads a key spelling; unknown escapes belong to the caller.
 */
function readKey(text: string, start: number, opener: number, name: string, limit: number): KeyRead {
	const bare = opener !== QUOTE && opener !== APOSTROPHE;
	let at = start;
	let put = 0;
	while (at < text.length) {
		const code = text.charCodeAt(at);
		if (bare ? !isBare(code) : code === opener || code === LF || code === CR) break;
		let unit = code;
		let width = 1;
		if (code === BACKSLASH) {
			if (isUndefinedEscape(text, at)) return { found: false, end: at };
			const next = text.charCodeAt(at + 1);
			unit = next === 0x75 ? hexValue(text, at + 2, 4) : simpleEscape(next);
			width = next === 0x75 ? 6 : 2;
		}
		if (name.charCodeAt(put) !== unit) return { found: false, end: at };
		put += 1;
		at += width;
	}
	return { found: put === name.length && at <= limit, end: at };
}

/** Whether the span may contain this key. */
function spells(text: string, span: OffsetRange, name: string): boolean {
	if (ARRAY_INDEX.test(name) && includesWithin(text, "[", span)) return true;
	return (
		someOccurrence(text, name, span, (start, end) => isKeyToken(text, start, end)) ||
		someEscaped(
			text,
			span,
			name,
			(start, before) => {
				// Escaped or embedded starts are not keys.
				if (before === BACKSLASH || (isIdentifier(before) && isBare(text.charCodeAt(start)))) return null;
				return readKey(text, start, before, name, span.end);
			},
			(slash) => isUndefinedEscape(text, slash),
		)
	);
}

////////////////////////////////
//  Format

export const jsonFormat: SecretFormat & { id: "json" } = {
	id: "json",
	consumers: ["RFC 8259 parsers", "JSONC parsers"],
	matches: (module) => {
		const lower = module.toLowerCase();
		return lower.endsWith(".json") || lower.endsWith(".jsonc");
	},
	inert: /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[{}[\],:])/y,
	read: readJson,
	scalar(document, node) {
		const held = details.get(document);
		if (held === undefined || node >= held.trees.length) return { kind: "uncertain", empty: false };
		const tree = held.trees[node];
		return scalarOf(tree, held.source, tree !== undefined && held.lossy.has(tree.offset));
	},
	mayName: (text, span, names) => names.some((name) => spells(text, span, name)),
};
