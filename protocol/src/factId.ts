// The SOLE owner of the fact id grammar: composer, parser, predicates, and the per-kind tuples.
//
// A symbol id names a SYMBOL and is built to survive edits, which is its whole job. A fact id names
// one row of the index as it currently stands, which is a different thing: a caller holding one,
// such as a literal to replace or a rename stop, must learn when that row changed.
//
// Shape: `lexfact <kind> <module> <digest>`, space-separated and module-encoded exactly like a
// symbol id, so one module spells the same in both grammars.
//
// IDENTITY IS CONTENT RELATIVE TO THE OWNER. The digest covers every field that makes the fact what
// it is, so resolving an id and checking whether it changed are ONE operation: an id that no longer
// resolves is exactly a fact that changed or vanished.
//
// Position enters as an offset from the fact's OWNER, the declaration it belongs to: a declaration
// owns itself, a reference its `fromId`, a literal its container, a comment or doc region its
// anchor. An edit above the owner, or moving the owner within its file, keeps every id it owns. A
// fact with no owner (an import, a module-level reference) keeps its absolute range, so it still
// changes when anything above it moves. An ordinal among identical siblings was the rejected
// alternative: inserting one sibling renumbers every later one, and nothing announces it.

import { createHash } from "node:crypto";
import { err, ok, type ParseResult } from "./parseResult.js";
import type { Certainty, CommentSpan, Conflict, DocRegion, Export, ImportEdge, Literal, Selector } from "./project.js";
import { SourceCursor } from "./sourceCursor.js";
import { decodeModuleField, encodeModuleField, expectIdSpace, isCanonicalModule, readIdField } from "./symbolId.js";
import type { Declaration, Position, Range, Reference, ReferenceOrigin } from "./symbols.js";

////////////////////////////////
//  Interfaces & Types

export type FactKind = (typeof FACT_KINDS)[number];

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

/** Closed, like every other vocabulary here. A kind the core cannot render is worse than none. */
export const FACT_KINDS = ["declaration", "reference", "import", "export", "literal", "comment", "doc"] as const;

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

/** Counted, so a list mid-tuple cannot run into the next field. */
function listFields(list: readonly string[] | undefined): FactField[] {
	return list === undefined ? [null] : [list.length, ...list];
}

function selectorFields(selector: Selector | undefined): FactField[] {
	return [
		selector?.kind,
		...listFields(selector?.kind === "names" ? selector.names : undefined),
		selector?.kind === "pattern" ? selector.glob : null,
		selector?.kind === "pattern" ? selector.caseInsensitive : null,
	];
}

function conflictFields(conflict: Conflict | undefined): FactField[] {
	return [conflict?.priority, conflict?.amongTransfers, conflict?.againstLocal];
}

function certaintyFields(certainty: Certainty): FactField[] {
	return [certainty.status, certainty.status === "unknown" ? certainty.reason : null];
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

/**
 * The import edge a reference's origin names: its statement's specifier, and its occurrence among
 * identical edges in the file.
 */
export interface OriginEdge {
	specifier: string;
	edge: ImportEdge;
	occurrence: number;
}

/**
 * An origin by the edge it names, never where that edge sits: references are owner-relative, so an
 * import block shifting must not re-mint every reference through it.
 */
function originFields(origin: ReferenceOrigin, through: OriginEdge | undefined): FactField[] {
	if (origin.kind === "declaration") return [origin.kind];
	if (through === undefined) throw new Error("a reference's import origin names no edge in its file");
	const { specifier, edge, occurrence } = through;
	return [
		origin.kind,
		...listFields(origin.path),
		specifier,
		edge.kind,
		edge.name,
		edge.local,
		edge.bindsLocally,
		edge.typeOnly === true,
		...selectorFields(edge.selector),
		...conflictFields(edge.conflict),
		...listFields(edge.meaning),
		edge.visibility,
		...certaintyFields(edge.certainty),
		occurrence,
	];
}

/** The binding is part of the fact: the same call newly resolving is news, not the same news. */
export function referenceFactId(module: string, r: Reference, owners: OwnerStarts, through?: OriginEdge): string {
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
		r.qualified,
		...ownedRangeFields(r.range, r.fromId, owners),
		// An absent origin adds no slot.
		...(r.origin === undefined ? [] : originFields(r.origin, through)),
	]);
}

/** One edge an import makes. Its span tells two identical statements apart. */
export function importFactId(module: string, specifier: string, edge: ImportEdge): string {
	return composeFactId("import", module, [
		specifier,
		edge.kind,
		...rangeFields(edge.span),
		edge.name,
		...rangeFields(edge.range),
		edge.local,
		...rangeFields(edge.localRange),
		edge.bindsLocally,
		edge.typeOnly === true,
		...selectorFields(edge.selector),
		...conflictFields(edge.conflict),
		...listFields(edge.meaning),
		edge.visibility,
		...certaintyFields(edge.certainty),
		edge.order,
	]);
}

/** Every field that changes what a module exposes. */
export function exportFactId(module: string, edge: Export): string {
	const target = edge.target;
	return composeFactId("export", module, [
		edge.form,
		...rangeFields(edge.span),
		edge.name,
		...rangeFields(edge.range),
		...rangeFields(edge.sourceRange),
		target.kind,
		target.kind === "symbol" ? target.symbolId : null,
		...rangeFields(target.kind === "import" ? target.span : undefined),
		target.kind === "unknown" ? target.reason : null,
		edge.scopeId,
		...selectorFields(edge.selector),
		...conflictFields(edge.conflict),
		...listFields(edge.meaning),
		edge.visibility,
		...certaintyFields(edge.certainty),
		edge.order,
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

/** Canonical form, carrying a diagnosis. `parseFactId` is the null-returning shim over it. */
export function parseFactIdResult(text: string): ParseResult<FactId> {
	const c = new SourceCursor(text);

	const scheme = readIdField(c, "the scheme");
	if (!scheme.ok) return scheme;
	if (scheme.value.text !== FACT_SCHEME) return err(c.failure(`expected scheme ${FACT_SCHEME}`, scheme.value.start));
	const afterScheme = expectIdSpace(c, "the scheme", scheme.value.start);
	if (afterScheme) return err(afterScheme);

	const kind = readIdField(c, "the fact kind");
	if (!kind.ok) return kind;
	if (!KIND_SET.has(kind.value.text))
		return err(c.failure(`unknown fact kind: ${kind.value.text}`, kind.value.start));
	const afterKind = expectIdSpace(c, "the fact kind", kind.value.start);
	if (afterKind) return err(afterKind);

	const moduleField = readIdField(c, "the module");
	if (!moduleField.ok) return moduleField;
	const module = decodeModuleField(moduleField.value.text);
	// The parser must accept exactly what the composer emits, or an id becomes host-dependent.
	if (!isCanonicalModule(module))
		return err(c.failure(`module is not in canonical form: ${module}`, moduleField.value.start));
	const afterModule = expectIdSpace(c, "the module", moduleField.value.start);
	if (afterModule) return err(afterModule);

	const digest = readIdField(c, "the digest");
	if (!digest.ok) return digest;
	const hex = digest.value.text;
	if (hex.length !== DIGEST_LENGTH || !DIGEST_RE.test(hex)) {
		return err(c.failure(`digest must be ${DIGEST_LENGTH} lowercase hex characters`, digest.value.start));
	}
	if (c.good()) return err(c.failure("unexpected trailing text after the digest", digest.value.start));

	return ok({ kind: kind.value.text as FactKind, module, digest: hex });
}

/** Null rather than throwing: a fact id arrives from a stored answer and from a tool caller. */
export function parseFactId(text: string): FactId | null {
	const result = parseFactIdResult(text);
	return result.ok ? result.value : null;
}

export function isFactId(text: string): boolean {
	return parseFactIdResult(text).ok;
}

/** The file a fact belongs to, which is what per-file invalidation keys on. */
export function factModuleOf(text: string): string | null {
	return parseFactId(text)?.module ?? null;
}

export function factKindOf(text: string): FactKind | null {
	return parseFactId(text)?.kind ?? null;
}
