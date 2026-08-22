// The one reading of YAML. Markdown frontmatter and a `.yml` file both arrive here, differing only
// in where their text sits. Package rules in formats/CLAUDE.md.

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
import { type CommentSyntax, isTooDeep, nestedTooDeep, saysTooDeep, TOO_DEEP } from "./depth.js";
import { droppedKey } from "./dropped.js";

const YAML_COMMENTS: CommentSyntax = { line: ["#"] };

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
	// a property of the FILE and belongs in a diagnostic; thrown, it stops the scan. The guard runs
	// first, since an exhausted stack is not always catchable.
	let documents: ReturnType<typeof parseAllDocuments> = [];
	let tooDeep = nestedTooDeep(text, YAML_COMMENTS);
	if (!tooDeep) {
		try {
			documents = parseAllDocuments(text);
		} catch (failure) {
			if (!isTooDeep(failure)) throw failure;
			tooDeep = true;
		}
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
				const at = span == null ? undefined : coordinates.rangeAt(offset + span[0], offset + span[1]);
				diagnostics.push(droppedKey("unnameable", module, at));
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
				diagnostics.push(droppedKey("nameless", module, keySpan));
				continue;
			}
			// An id carries a name, not a type, so `1:` and `"1":` are one id however YAML reads them.
			// The library calls those distinct keys and says nothing, so the loss is reported here.
			if (owner.get(name) !== index) {
				diagnostics.push(droppedKey("repeated", module, keySpan, name));
				continue;
			}

			const keyStart = offset + key[0];
			const keyEnd = offset + key[1];
			// A zero-width key is an absent one, and `: 1` would otherwise be declared as "null".
			if (keyEnd <= keyStart) continue;

			// Any node, so a sequence or an alias value ends the declaration where its value ends.
			// Naming node kinds here spans only the key.
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
			// The library CATCHES a stack overflow and files it as a document error, so the guard below
			// never sees it and the raw engine message would reach a reader as if it were about the file.
			if (saysTooDeep(problem.message)) {
				tooDeep = true;
				continue;
			}
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
			if (!isTooDeep(failure)) throw failure;
			tooDeep = true;
		}
	});
	if (tooDeep) diagnostics.push({ severity: "error", message: TOO_DEEP, path: module });

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
	if (nestedTooDeep(text, YAML_COMMENTS)) return [];
	try {
		for (const token of new Parser().parse(text)) collect(token);
	} catch (failure) {
		if (!isTooDeep(failure)) throw failure;
	}
	return spans.sort((left, right) => left.range.start.line - right.range.start.line);
}
