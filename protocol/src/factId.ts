// The SOLE owner of the fact id grammar: composer, parser, predicates, and the per-kind tuples.
//
// A symbol id names a SYMBOL and is built to survive edits, which is its whole job. A fact id names
// one row of the index as it currently stands, which is a different thing. An answer in the
// knowledge layer cites the facts it read, and that citation has to go stale when one of them
// changes, so the two ids cannot be the same id.
//
// Shape: `lexfact <kind> <module> <digest>`, space-separated and module-encoded exactly like a
// symbol id, so one module spells the same in both grammars.
//
// IDENTITY IS CONTENT RELATIVE TO THE OWNER. The digest covers every field that makes the fact what
// it is, so resolving an id and checking whether it changed are ONE operation: an id that no longer
// resolves is exactly a fact that changed or vanished. `docs/knowledge-layer.md` wants mechanical
// invalidation to be a comparison rather than a judgement, and this is that comparison.
//
// Position enters as an offset from the fact's OWNER, the declaration it belongs to: a declaration
// owns itself, a reference its `fromId`, a literal its container, a comment or doc region its
// anchor. An edit above the owner, or moving the owner within its file, keeps every id it owns. A
// fact with no owner (an import, a module-level reference) keeps its absolute range, so it still
// changes when anything above it moves. An ordinal among identical siblings was the rejected
// alternative: inserting one sibling renumbers every later one, and nothing announces it.

import { createHash } from "node:crypto";
import { Cursor, err, ok, type ParseResult } from "./cursor.js";
import type { CommentSpan, DocRegion, ImportedName, Literal } from "./project.js";
import {
	decodeModuleField,
	encodeModuleField,
	expectIdSpace,
	isCanonicalModule,
	moduleOf,
	readIdField,
} from "./symbolId.js";
import type { Declaration, Position, Range, Reference } from "./symbols.js";

////////////////////////////////
//  Interfaces & Types

export type FactKind = "declaration" | "reference" | "import" | "literal" | "comment" | "doc" | "answer" | "doubt";

export interface FactId {
	kind: FactKind;
	module: string;
	digest: string;
}

export type OwnerStarts = ReadonlyMap<string, Position>;

/** One tuple slot. Absent is encoded distinctly from empty, so the two never hash alike. */
type FactField = string | number | boolean | null | undefined;

////////////////////////////////
//  Constants

export const FACT_SCHEME = "lexfact";

/**
 * Closed, like every other vocabulary here. A kind the core cannot render is worse than none.
 *
 * `answer` is the doc's "answers are facts one layer up" made literal: a recorded answer gets an id
 * in the same grammar, so an answer can cite another answer and staleness cascades through the same
 * resolution that catches an edited file. Its digest covers the prose and the citations, so
 * re-recording an answer retires the old id and everything built on it reports stale.
 */
export const FACT_KINDS = [
	"declaration",
	"reference",
	"import",
	"literal",
	"comment",
	"doc",
	"answer",
	"doubt",
] as const;

const KIND_SET = new Set<string>(FACT_KINDS);

/** 64 bits. Across ten million facts the birthday odds are about five in a million. */
const DIGEST_LENGTH = 16;

const DIGEST_RE = /^[0-9a-f]+$/;

////////////////////////////////
//  Functions & Helpers

/**
 * Length-prefixed, because a literal's value can contain any character including the separator.
 *
 * Joining on a delimiter would let two different tuples encode to one string, which is a collision
 * we would have written ourselves rather than one the hash gave us.
 */
function canonicalize(parts: FactField[]): string {
	let out = "";
	for (const part of parts) {
		if (part === null || part === undefined) {
			out += "0:-";
			continue;
		}
		const text = typeof part === "string" ? part : String(part);
		out += `${Buffer.byteLength(text, "utf8")}:=${text}`;
	}
	return out;
}

function digestOf(kind: FactKind, module: string, parts: FactField[]): string {
	return createHash("sha256")
		.update(canonicalize([kind, module, ...parts]))
		.digest("hex")
		.slice(0, DIGEST_LENGTH);
}

/** Relative lines and first-line columns. */
function relativeTo(position: Position, origin: Position): [number, number] {
	const line = position.line - origin.line;
	return [line, line === 0 ? position.character - origin.character : position.character];
}

/** Four slots whether or not the range exists, so an absent one cannot shift the tuple. */
function rangeFields(range: Range | undefined, origin?: Position): FactField[] {
	if (range === undefined) return [null, null, null, null];
	if (origin === undefined) return [range.start.line, range.start.character, range.end.line, range.end.character];
	return [...relativeTo(range.start, origin), ...relativeTo(range.end, origin)];
}

/** The owner start supplies the origin. */
function ownedRangeFields(range: Range, owner: string | null | undefined, owners: OwnerStarts): FactField[] {
	if (owner === null || owner === undefined) return rangeFields(range);
	const origin = owners.get(owner);
	if (origin === undefined) throw new Error(`a fact's owner is not declared in its file: ${owner}`);
	return rangeFields(range, origin);
}

function composeFactId(kind: FactKind, module: string, parts: FactField[]): string {
	if (!isCanonicalModule(module)) throw new Error(`module is not in canonical form: ${module}`);
	return `${FACT_SCHEME} ${kind} ${encodeModuleField(module)} ${digestOf(kind, module, parts)}`;
}

export function ownerStarts(declarations: readonly Declaration[]): OwnerStarts {
	return new Map(declarations.map((d) => [d.symbolId, d.range.start]));
}

/** Everything that makes this declaration what it is, so a changed signature is a changed fact. */
export function declarationFactId(module: string, d: Declaration): string {
	return composeFactId("declaration", module, [
		d.symbolId,
		d.name,
		d.kind,
		d.languageKind,
		d.visibility,
		d.exported,
		d.containerId,
		d.signature,
		...rangeFields(d.range, d.range.start),
		...rangeFields(d.selectionRange, d.range.start),
		d.metrics?.lines,
		d.metrics?.parameters,
		d.metrics?.nesting,
		d.metrics?.branches,
		// Omitted fields add no digest slot.
		...(d.contains === undefined ? [] : [d.contains]),
	]);
}

/** The binding is part of the fact: the same call newly resolving is news, not the same news. */
export function referenceFactId(module: string, r: Reference, owners: OwnerStarts): string {
	const target = r.binding.status === "bound" ? r.binding.symbolId : null;
	const candidates = r.binding.status === "ambiguous" ? r.binding.candidates.join(",") : null;
	const how = r.binding.status === "unbound" ? r.binding.reason : r.binding.provenance;
	return composeFactId("reference", module, [
		r.name,
		r.role,
		r.binding.status,
		target,
		candidates,
		how,
		r.fromId,
		...ownedRangeFields(r.range, r.fromId, owners),
	]);
}

/**
 * One name an import writes, or the statement itself when it names none.
 *
 * Two identical statements in one file mint one id. They are the same fact stated twice, so that is
 * the right answer rather than a collision to design around.
 */
export function importFactId(module: string, specifier: string, reExport: boolean, name?: ImportedName): string {
	return composeFactId("import", module, [
		specifier,
		reExport,
		name?.name,
		...rangeFields(name?.range),
		name?.local,
		...rangeFields(name?.localRange),
	]);
}

export function literalFactId(module: string, l: Literal, owners: OwnerStarts): string {
	return composeFactId("literal", module, [
		l.kind,
		l.value,
		l.number,
		l.containerId,
		...ownedRangeFields(l.range, l.containerId, owners),
	]);
}

/** Comment anchors define identity. */
export function commentFactId(
	module: string,
	c: CommentSpan & { anchorId: string | null },
	owners: OwnerStarts,
): string {
	return composeFactId("comment", module, [c.text, c.anchorId, ...ownedRangeFields(c.range, c.anchorId, owners)]);
}

/** Fenced rides along: the same words as prose and as a command are not the same fact. */
export function docFactId(module: string, d: DocRegion, owners: OwnerStarts): string {
	return composeFactId("doc", module, [
		d.text,
		d.fenced,
		d.anchorId,
		...ownedRangeFields(d.range, d.anchorId, owners),
	]);
}

/**
 * The id of a recorded answer, whose module is its SUBJECT's module.
 *
 * Identity is prose plus citations plus what was asked about, and deliberately NOT the timestamp or
 * the model: re-affirming the same words over the same inputs is the same answer, while changing a
 * word or a citation retires the id and cascades staleness into everything that cited it.
 */
export function answerFactId(
	subjectId: string,
	recordedAs: string,
	question: string,
	prose: string,
	citations: string[],
): string {
	const module = moduleOf(recordedAs);
	if (module === null) throw new Error(`an answer's address must be a well-formed symbol id: ${recordedAs}`);
	return composeFactId("answer", module, [subjectId, recordedAs, question, prose, ...citations]);
}

/**
 * The id of a declared doubt on a recorded answer, whose module is the SUBJECT's module.
 *
 * A doubt id is a handshake token rather than a citable fact: clearing a doubt requires citing this
 * id back, and the only way to hold it is to have recalled the answer and read the reason. That is
 * what stops a parallel writer erasing a doubt it never saw. The timestamp is IN the identity, so a
 * doubt declared again after a clear mints a fresh id and a saved-up old token cannot clear it.
 */
export function doubtFactId(
	subjectId: string,
	recordedAs: string,
	question: string,
	reason: string,
	at: number,
): string {
	const module = moduleOf(recordedAs);
	if (module === null) throw new Error(`a doubt's address must be a well-formed symbol id: ${recordedAs}`);
	return composeFactId("doubt", module, [subjectId, recordedAs, question, reason, at]);
}

/** Canonical form, carrying a diagnosis. `parseFactId` is the null-returning shim over it. */
export function parseFactIdResult(text: string): ParseResult<FactId> {
	const c = new Cursor(text);

	const scheme = readIdField(c, "the scheme");
	if (!scheme.ok) return scheme;
	if (scheme.value !== FACT_SCHEME) return err(c.fail(`expected scheme ${FACT_SCHEME}`));
	const afterScheme = expectIdSpace(c, "the scheme");
	if (afterScheme) return err(afterScheme);

	const kind = readIdField(c, "the fact kind");
	if (!kind.ok) return kind;
	if (!KIND_SET.has(kind.value)) return err(c.fail(`unknown fact kind: ${kind.value}`));
	const afterKind = expectIdSpace(c, "the fact kind");
	if (afterKind) return err(afterKind);

	const moduleField = readIdField(c, "the module");
	if (!moduleField.ok) return moduleField;
	const module = decodeModuleField(moduleField.value);
	// The parser must accept exactly what the composer emits, or an id becomes host-dependent.
	if (!isCanonicalModule(module)) return err(c.fail(`module is not in canonical form: ${module}`));
	const afterModule = expectIdSpace(c, "the module");
	if (afterModule) return err(afterModule);

	const digest = readIdField(c, "the digest");
	if (!digest.ok) return digest;
	if (digest.value.length !== DIGEST_LENGTH || !DIGEST_RE.test(digest.value)) {
		return err(c.fail(`digest must be ${DIGEST_LENGTH} lowercase hex characters`));
	}
	if (c.good()) return err(c.fail("unexpected trailing text after the digest"));

	return ok({ kind: kind.value as FactKind, module, digest: digest.value });
}

/** Null rather than throwing: a fact id arrives from a stored answer and from a tool caller. */
export function parseFactId(text: string): FactId | null {
	const result = parseFactIdResult(text);
	return result.ok ? result.value : null;
}

export function isFactId(text: string): boolean {
	return parseFactIdResult(text).ok;
}

/** The file a citation depends on, which is what per-file invalidation keys on. */
export function factModuleOf(text: string): string | null {
	return parseFactId(text)?.module ?? null;
}

export function factKindOf(text: string): FactKind | null {
	return parseFactId(text)?.kind ?? null;
}
