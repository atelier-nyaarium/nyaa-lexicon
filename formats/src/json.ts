// The one reading of the JSON family, shared by every provider that meets some.
//
// A dialect differs only in what its parser TOLERATES, so tolerance is a parameter and the walk
// over the tree is not repeated per extension.

import {
	type CommentSpan,
	composeSymbolId,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type Literal,
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

////////////////////////////////
//  Interfaces & Types

export interface JsonContext {
	language: string;
	module: string;
	text: string;
	/** Where the text starts in its file, so a record inside JSONL still addresses the file. */
	offset: number;
	coordinates: TextCoordinates;
	/** Comments and trailing commas. False for strict `.json`, true for JSONC. */
	lenient: boolean;
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

/** Comments from the scanner that reads the values, so a marker inside a string stays a string. */
function scanComments(text: string, offset: number, coordinates: TextCoordinates): CommentSpan[] {
	const scanner = createScanner(text, false);
	const spans: CommentSpan[] = [];
	for (;;) {
		const token = scanner.scan();
		// 17 ends the stream. 12 and 13 are the line and block comment tokens.
		if (token === 17) break;
		if (token !== 12 && token !== 13) continue;
		const at = scanner.getTokenOffset();
		// Clamped: an unterminated `/*` at the end reports a length one past the text, which for a
		// JSONL record is inside the file and spans into the next line rather than being refused.
		const end = Math.min(at + scanner.getTokenLength(), text.length);
		const range = coordinates.rangeAt(offset + at, offset + end);
		// Sliced from the source rather than taken from the scanner, so a span's range and its text
		// cannot disagree: getTokenValue carries leading trivia that the offset does not.
		const source = text.slice(at, end);
		if (range !== undefined && source !== "") spans.push({ range, text: source });
	}
	return spans;
}

/** Every property in an object, at any depth, with the values this index can hold. */
export function readJson(context: JsonContext): JsonFacts {
	const { language, module, text, offset, coordinates, lenient } = context;
	const declarations: Declaration[] = [];
	const literals: Literal[] = [];
	const diagnostics: Diagnostic[] = [];
	const problems: ParseError[] = [];

	const tree = parseTree(text, problems, {
		disallowComments: !lenient,
		allowTrailingComma: lenient,
		allowEmptyContent: true,
	});

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
		// An array element has no name, so it is no declaration. Its VALUE is still a literal and
		// carries the key the array sits under.
		// An element has no name, so it is no declaration. Its ordinal still has to reach the keys
		// BELOW it, or every element of an array of objects mints the same id as its siblings.
		// A root array holds real keys, so the walk never depends on having a container: a literal
		// simply carries none, which the schema allows and which beats reporting an empty file.
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

		for (const property of node.children ?? []) {
			const [key, value] = property.children ?? [];
			if (key === undefined || typeof key.value !== "string" || key.value === "") continue;

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

	walk(tree, context.parents ?? [], undefined);
	return {
		declarations,
		literals,
		comments: lenient ? scanComments(text, offset, coordinates) : [],
		diagnostics,
	};
}
