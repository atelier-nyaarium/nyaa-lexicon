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

	// Parsing recurses, and so does the walk below, so nesting deep enough exhausts the stack. That is
	// a property of the FILE and belongs in a diagnostic; thrown, it stops the scan.
	let documents: ReturnType<typeof parseAllDocuments> = [];
	let tooDeep = false;
	try {
		documents = parseAllDocuments(text);
	} catch (failure) {
		if (!(failure instanceof RangeError)) throw failure;
		tooDeep = true;
	}

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

		// A repeated key is ONE addressable thing, so only its last occurrence is walked: two of them
		// would mint one id twice and the store would keep whichever it wrote last.
		const owner = new Map<string, number>();
		node.items.forEach((pair, index) => {
			if (isPair(pair) && isScalar(pair.key)) owner.set(String(pair.key.value), index);
		});

		for (const [index, pair] of node.items.entries()) {
			if (!isPair(pair)) continue;
			// An explicit key that is a sequence or a map has no name a symbol id can carry. Saying so
			// beats skipping in silence, which leaves a valid file in scope reporting nothing.
			if (!isScalar(pair.key)) {
				const span = isNode(pair.key) ? pair.key.range : undefined;
				unnamed(
					"a key that is not a scalar cannot be named, so it is not indexed",
					span == null ? undefined : coordinates.rangeAt(offset + span[0], offset + span[1]),
				);
				continue;
			}
			const key = pair.key.range;
			const name = String(pair.key.value);
			if (key === null || key === undefined) continue;
			// A merge key is a directive, not a key. Its target is already indexed under its own anchor,
			// which is the same reason an alias is not expanded.
			if (name === "<<") continue;

			const keySpan = coordinates.rangeAt(offset + key[0], offset + key[1]);
			if (name === "") {
				unnamed("a key with no name cannot be addressed, so it is not indexed", keySpan);
				continue;
			}
			// An id carries a name, not a type, so `1:` and `"1":` are one id however YAML reads them.
			// The library calls those distinct keys and says nothing, so the loss is reported here.
			if (owner.get(name) !== index) {
				unnamed(`a key spelled ${JSON.stringify(name)} appears more than once; the last is indexed`, keySpan);
				continue;
			}

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

	/** A key the index drops. Said out loud, so a file in scope never reports nothing without a reason. */
	function unnamed(message: string, range: ReturnType<TextCoordinates["rangeAt"]>): void {
		diagnostics.push({ severity: "info", message, path: module, ...(range === undefined ? {} : { range }) });
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
		try {
			walk(
				document.contents,
				many ? [...parents, { kind: "namespace", name: `[${index}]` }] : parents,
				undefined,
			);
		} catch (failure) {
			if (!(failure instanceof RangeError)) throw failure;
			tooDeep = true;
		}
	});
	if (tooDeep) diagnostics.push({ severity: "error", message: "nested too deeply to index", path: module });

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

	// Deep enough nesting exhausts the stack here too. There is no diagnostic channel on this call, and
	// `readYaml` already reports the depth for the same file, so the spans found so far are the answer.
	try {
		for (const token of new Parser().parse(text)) collect(token);
	} catch (failure) {
		if (!(failure instanceof RangeError)) throw failure;
	}
	return spans.sort((left, right) => left.range.start.line - right.range.start.line);
}
