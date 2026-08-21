// The one reading of YAML, shared by every provider that meets some.
//
// Markdown frontmatter and a `.yml` file are the same mapping in the same syntax, so two readers
// would be two answers to one question. What varies is only where the text sits, which arrives as
// context rather than as a second implementation.

import {
	type CommentSpan,
	composeSymbolId,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type Literal,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import { isMap, isNode, isPair, isScalar, isSeq, Parser, parseAllDocuments, type Scalar } from "yaml";

////////////////////////////////
//  Interfaces & Types

/** Where the YAML sits and who is reading it. Everything format-specific stays out here. */
export interface YamlContext {
	language: string;
	module: string;
	/** The YAML itself, which may be a slice of a larger file. */
	text: string;
	/** Where that slice starts, so every range addresses the FILE rather than the slice. */
	offset: number;
	/** The whole file's map, since a range must be readable against the file. */
	coordinates: TextCoordinates;
	/** Descriptors above the root, for YAML embedded in something that already has a path. */
	parents?: Descriptor[];
}

export interface YamlFacts {
	declarations: Declaration[];
	literals: Literal[];
	diagnostics: Diagnostic[];
}

////////////////////////////////
//  Functions & Helpers

/**
 * A scalar this index can hold, or nothing.
 *
 * The RESOLVED value decides, never the tag: `!!str` and `!custom` land as strings, `!!binary` and
 * `!!timestamp` resolve outside the three kinds and are omitted, as is null. An omitted value keeps
 * its key, which claims the key exists and its value is not one this index carries.
 */
function literalKind(value: unknown): { kind: Literal["kind"]; value: string; number?: number } | null {
	if (typeof value === "string") return { kind: "string", value };
	if (typeof value === "boolean") return { kind: "boolean", value: String(value) };
	if (typeof value === "number" && Number.isFinite(value))
		return { kind: "number", value: String(value), number: value };
	return null;
}

/** Every key in a mapping, at any depth, with values this index can hold. */
export function readYaml(context: YamlContext): YamlFacts {
	const { language, module, text, offset, coordinates } = context;
	const declarations: Declaration[] = [];
	const literals: Literal[] = [];
	const diagnostics: Diagnostic[] = [];
	const documents = parseAllDocuments(text);

	function walk(node: unknown, parents: Descriptor[], containerId: string | undefined): void {
		// An element has no name, so it is no declaration, but its ordinal must still reach the keys
		// below it or every sibling mints one id. A root sequence has no container and still has keys.
		if (isSeq(node)) {
			node.items.forEach((item, index) => {
				if (isScalar(item)) {
					pushScalar(item, containerId);
					return;
				}
				walk(item, [...parents, { kind: "namespace", name: `[${index}]` }], containerId);
			});
			return;
		}
		if (isScalar(node)) {
			pushScalar(node, containerId);
			return;
		}
		if (!isMap(node)) return;

		for (const pair of node.items) {
			if (!isPair(pair) || !isScalar(pair.key)) continue;
			const key = pair.key.range;
			const name = String(pair.key.value);
			if (key === null || key === undefined || name === "") continue;

			const keyStart = offset + key[0];
			const keyEnd = offset + key[1];
			// A zero-width key is an absent one, and `: 1` would otherwise be declared as "null".
			if (keyEnd <= keyStart) continue;

			// Any node, so a sequence or an alias value ends the declaration where it ends. Naming the
			// node kinds instead left a sequence-valued key spanning only its own name.
			const value = pair.value;
			const valueRange = isNode(value) ? value.range : undefined;
			const selectionRange = coordinates.rangeAt(keyStart, keyEnd);
			const range = coordinates.rangeAt(keyStart, valueRange == null ? keyEnd : offset + valueRange[1]);
			if (selectionRange === undefined || range === undefined) continue;

			const descriptors: Descriptor[] = [...parents, { kind: "term", name }];
			const symbolId = composeSymbolId({ language, module, descriptors });
			declarations.push({
				symbolId,
				kind: "property",
				name,
				range,
				selectionRange,
				visibility: "public",
				...(containerId === undefined ? {} : { containerId }),
			});

			if (isScalar(value)) pushScalar(value, symbolId);
			else walk(value, descriptors, symbolId);
		}
	}

	function pushScalar(scalar: Scalar, containerId: string | undefined): void {
		const held = literalKind(scalar.value);
		const span = scalar.range;
		if (held === null || span == null) return;
		const range = coordinates.rangeAt(offset + span[0], offset + span[1]);
		if (range === undefined) return;
		literals.push({
			kind: held.kind,
			value: held.value,
			...(held.number === undefined ? {} : { number: held.number }),
			range,
			...(containerId === undefined ? {} : { containerId }),
		});
	}

	// A file holds one document unless it says otherwise, so the common case keeps unprefixed ids and
	// frontmatter is untouched. Numbering starts only where a second `---` makes keys ambiguous.
	const many = documents.length > 1;
	documents.forEach((document, index) => {
		for (const problem of document.errors) {
			const range = coordinates.rangeAt(offset + problem.pos[0], offset + problem.pos[1]);
			diagnostics.push({
				severity: "error",
				message: problem.message,
				path: module,
				...(range === undefined ? {} : { range }),
			});
		}
		const parents = context.parents ?? [];
		walk(document.contents, many ? [...parents, { kind: "namespace", name: `[${index}]` }] : parents, undefined);
	});
	return { declarations, literals, diagnostics };
}

/**
 * Comments from the library's OWN parser, never a second scan for markers.
 *
 * A `#` is a comment only where it is not inside a string, a block scalar or another comment, which
 * is the one rule a separate scanner always gets wrong. The parser that reads the values already
 * knows, so it is the only thing asked.
 */
export function readYamlComments(text: string, offset: number, coordinates: TextCoordinates): CommentSpan[] {
	const spans: CommentSpan[] = [];

	function collect(token: unknown): void {
		if (token === null || typeof token !== "object") return;
		const node = token as { type?: string; offset?: number; source?: string };
		if (node.type === "comment" && typeof node.offset === "number" && typeof node.source === "string") {
			const range = coordinates.rangeAt(offset + node.offset, offset + node.offset + node.source.length);
			if (range !== undefined && node.source !== "") spans.push({ range, text: node.source });
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) for (const item of value) collect(item);
			else if (value !== null && typeof value === "object") collect(value);
		}
	}

	for (const token of new Parser().parse(text)) collect(token);
	return spans.sort((left, right) => left.range.start.line - right.range.start.line);
}
