// The one reading of the JSON family. A dialect differs only in what its parser TOLERATES, so
// tolerance is a parameter and the walk is not repeated per extension. Rules in formats/CLAUDE.md.

import {
	type CommentSpan,
	composeSymbolId,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type Literal,
	type Range,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
// The ESM entry by path, because the package has no `exports` map and its `main` is a UMD file whose
// inner requires survive bundling and then fail on node. Pinned exact so the path cannot move.
// It resolves only through a bundler: the entry's own imports are extensionless, which node refuses.
import {
	createScanner,
	type Node,
	type ParseError,
	parseTree,
	printParseErrorCode,
	type ScanError,
} from "jsonc-parser/lib/esm/main.js";
import { type CommentSyntax, isTooDeep, nestedTooDeep, TOO_DEEP } from "./depth.js";
import { droppedKey } from "./dropped.js";

const JSON_COMMENTS: CommentSyntax = { line: ["//"], block: ["/*", "*/"] };

////////////////////////////////
//  Interfaces & Types

export interface JsonContext {
	language: string;
	module: string;
	text: string;
	/** Where the text starts in its file, so a record inside JSONL still addresses the file. */
	offset: number;
	coordinates: TextCoordinates;
	/** The extension names the strict dialect, so comments and trailing commas are read and noted. */
	strict: boolean;
	/** Descriptors above the root, which is how JSONL gives each record its own path. */
	parents?: Descriptor[];
}

export interface JsonFacts {
	declarations: Declaration[];
	literals: Literal[];
	comments: CommentSpan[];
	diagnostics: Diagnostic[];
}

////////////////////////////////
//  Functions & Helpers

function literalOf(value: unknown): { kind: Literal["kind"]; value: string; number?: number } | null {
	if (typeof value === "string") return { kind: "string", value };
	if (typeof value === "boolean") return { kind: "boolean", value: String(value) };
	if (typeof value === "number" && Number.isFinite(value))
		return { kind: "number", value: String(value), number: value };
	return null;
}

/** What strict JSON lacks, from the value scanner. */
interface Lenience {
	comments: CommentSpan[];
	trailingCommas: Range[];
}

/** Closers and scalars: what a trailing comma follows. */
const VALUE_END = new Set([2, 4, 7, 8, 9, 10, 11]);

/** One pass, so a string's marker stays a string. */
function scanLenience(text: string, offset: number, coordinates: TextCoordinates): Lenience {
	const scanner = createScanner(text, false);
	const comments: CommentSpan[] = [];
	const trailingCommas: Range[] = [];
	// Last significant token; a comma after a value.
	let previous = 0;
	let commaAt: [number, number] | null = null;
	for (;;) {
		const token = scanner.scan();
		// 17 ends the stream. 12 and 13 are the line and block comment tokens.
		if (token === 17) break;
		const at = scanner.getTokenOffset();
		// Clamped: an unterminated `/*` at the end reports a length one past the text, which for a
		// JSONL record is inside the file and spans into the next line rather than being refused.
		const end = Math.min(at + scanner.getTokenLength(), text.length);
		if (token === 12 || token === 13) {
			const range = coordinates.rangeAt(offset + at, offset + end);
			// Sliced from the source rather than taken from the scanner, so a span's range and its text
			// cannot disagree: getTokenValue carries leading trivia that the offset does not.
			const source = text.slice(at, end);
			if (range !== undefined && source !== "") comments.push({ range, text: source });
			continue;
		}
		if (token === 14 || token === 15) continue;
		// Value, comma, closer.
		if ((token === 2 || token === 4) && previous === 5 && commaAt !== null) {
			const range = coordinates.rangeAt(offset + commaAt[0], offset + commaAt[1]);
			if (range !== undefined) trailingCommas.push(range);
		}
		if (token === 5) commaAt = VALUE_END.has(previous) ? [at, end] : null;
		previous = token;
	}
	return { comments, trailingCommas };
}

/** Once per kind, never a fault. */
function noted(what: string, count: number, module: string, range: Range | undefined): Diagnostic {
	const plural = count === 1 ? what : `${what}s`;
	return {
		severity: "info",
		message: `read ${count} ${plural}; the strict dialect this extension names has none`,
		path: module,
		...(range === undefined ? {} : { range }),
	};
}

/** Every property in an object, at any depth, with the values this index can hold. */
export function readJson(context: JsonContext): JsonFacts {
	const { language, module, text, offset, coordinates, strict } = context;
	const declarations: Declaration[] = [];
	const literals: Literal[] = [];
	const diagnostics: Diagnostic[] = [];
	const problems: ParseError[] = [];

	// Before the parser recurses.
	if (nestedTooDeep(text, JSON_COMMENTS)) {
		diagnostics.push({ severity: "error", message: TOO_DEEP, path: module });
		return { declarations, literals, comments: [], diagnostics };
	}

	// Building the tree recurses too, so it exhausts the stack before the walk ever gets a chance.
	let tree: Node | undefined;
	let tooDeep = false;
	try {
		// Every dialect reads leniently; strictness only notes.
		tree = parseTree(text, problems, {
			disallowComments: false,
			allowTrailingComma: true,
			allowEmptyContent: true,
		});
	} catch (failure) {
		if (!isTooDeep(failure)) throw failure;
		tooDeep = true;
	}

	for (const problem of problems) {
		const end = Math.min(problem.offset + problem.length, text.length);
		const range = coordinates.rangeAt(offset + problem.offset, offset + end);
		diagnostics.push({
			severity: "error",
			message: printParseErrorCode(problem.error as unknown as ParseError["error"] & ScanError),
			path: module,
			...(range === undefined ? {} : { range }),
		});
	}

	function push(node: Node, containerId: string | undefined): void {
		const held = literalOf(node.value);
		if (held === null) return;
		const range = coordinates.rangeAt(offset + node.offset, offset + node.offset + node.length);
		if (range === undefined) return;
		literals.push({
			kind: held.kind,
			value: held.value,
			...(held.number === undefined ? {} : { number: held.number }),
			range,
			...(containerId === undefined ? {} : { containerId }),
		});
	}

	function walk(node: Node | undefined, parents: Descriptor[], containerId: string | undefined): void {
		if (node === undefined) return;
		// An element has no name, so it is no declaration, but its ordinal must still reach the keys
		// below it or every sibling mints one id. A root array has no container and still has keys.
		if (node.type === "array") {
			(node.children ?? []).forEach((item, index) => {
				walk(item, [...parents, { kind: "namespace", name: `[${index}]` }], containerId);
			});
			return;
		}
		if (node.type !== "object") {
			push(node, containerId);
			return;
		}

		// A repeated key is ONE addressable thing, so only its last occurrence is walked: two of them
		// would mint one id twice and the store would keep whichever it wrote last. The parser does not
		// complain, so the file's own defect is reported here or nowhere.
		const properties = node.children ?? [];
		const owner = new Map<string, number>();
		properties.forEach((property, index) => {
			const name = property.children?.[0]?.value;
			if (typeof name === "string") owner.set(name, index);
		});

		for (const [index, property] of properties.entries()) {
			const [key, value] = property.children ?? [];
			if (key === undefined || typeof key.value !== "string") continue;
			const at = coordinates.rangeAt(offset + key.offset, offset + key.offset + key.length);
			if (key.value === "") {
				diagnostics.push(droppedKey("nameless", module, at));
				continue;
			}
			if (owner.get(key.value) !== index) {
				diagnostics.push(droppedKey("repeated", module, at, key.value));
				continue;
			}

			const selectionRange = coordinates.rangeAt(offset + key.offset, offset + key.offset + key.length);
			const end = value === undefined ? key.offset + key.length : value.offset + value.length;
			const range = coordinates.rangeAt(offset + key.offset, offset + end);
			if (selectionRange === undefined || range === undefined) continue;

			const descriptors: Descriptor[] = [...parents, { kind: "term", name: key.value }];
			const symbolId = composeSymbolId({ language, module, descriptors });
			declarations.push({
				symbolId,
				kind: "property",
				name: key.value,
				range,
				selectionRange,
				visibility: "public",
				...(containerId === undefined ? {} : { containerId }),
			});
			walk(value, descriptors, symbolId);
		}
	}

	// A property of the FILE, so it belongs in a diagnostic. Thrown, it becomes a transport error and
	// stops the scan over a file nobody asked to be fatal.
	try {
		if (!tooDeep) walk(tree, context.parents ?? [], undefined);
	} catch (failure) {
		if (!isTooDeep(failure)) throw failure;
		tooDeep = true;
	}
	if (tooDeep) diagnostics.push({ severity: "error", message: TOO_DEEP, path: module });

	const lenience = scanLenience(text, offset, coordinates);
	if (strict) {
		const { comments, trailingCommas } = lenience;
		if (comments.length > 0) diagnostics.push(noted("comment", comments.length, module, comments[0]?.range));
		if (trailingCommas.length > 0)
			diagnostics.push(noted("trailing comma", trailingCommas.length, module, trailingCommas[0]));
	}

	return { declarations, literals, comments: lenience.comments, diagnostics };
}
