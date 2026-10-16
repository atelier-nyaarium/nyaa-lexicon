import {
	defined,
	type Export,
	type FileNote,
	type FileRole,
	FileRoleSchema,
	type ImportEdge,
	type Landing,
	type Metrics,
	type ReferenceOrigin,
	type StoredComment,
	type StoredDeclaration,
	type StoredDoc,
	type StoredExport,
	type StoredImport,
	type StoredLiteral,
	type StoredReference,
} from "@nyaa-lexicon/protocol";
import type { GeneratedReason, GeneratedVerdict } from "./fileScope.js";

interface NoteRow {
	severity: "warning" | "info";
	message: string;
	path: string | null;
	startLine: number | null;
	startChar: number | null;
	endLine: number | null;
	endChar: number | null;
}

////////////////////////////////
//  Functions & Helpers

/** A stored verdict read back; a pair the store never writes reads as none. */
function verdictFromRow(status: string, reason: string | null): GeneratedVerdict | null {
	if ((status === "yes" || status === "no") && reason === null) return { status };
	if (status === "unknown" && (reason === "noGit" || reason === "gitFailed")) {
		return { status, reason: reason as GeneratedReason };
	}
	return null;
}

interface RoleRow {
	role: string | null;
	roleHow: string | null;
	roleSymbolId: string | null;
	roleReason: string | null;
}

/** Row shapes, named so the mappers read as field access rather than a wall of casts. */
interface SymbolRow {
	symbolId: string;
	factId: string;
	module: string;
	name: string;
	kind: string;
	visibility: string;
	exported: number | null;
	containerId: string | null;
	signature: string | null;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
	nameLine: number;
	nameChar: number;
	nameEndLine: number;
	nameEndChar: number;
	synthesizedName: number | null;
	mLines: number | null;
	mParameters: number | null;
	mNesting: number | null;
	mBranches: number | null;
	contains: string | null;
	memberInsertLine: number | null;
	languageKind: string | null;
	valueStatus: string | null;
}

interface RefRow {
	factId: string;
	module: string;
	name: string;
	role: string;
	targetId: string | null;
	fromId: string | null;
	qualified: number | null;
	provenance: string;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
	originKind: string | null;
	originStartLine: number | null;
	originStartChar: number | null;
	originEndLine: number | null;
	originEndChar: number | null;
	originPath: string | null;
}

interface LiteralRow {
	factId: string;
	module: string;
	kind: string;
	value: string;
	number: number | null;
	containerId: string | null;
	containerName?: string | null;
	containerKind?: string | null;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
}

interface DocRow {
	factId: string;
	module: string;
	raw: string;
	normalized: string;
	fenced: number;
	anchorId: string | null;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
}

interface CommentRow {
	factId: string;
	module: string;
	raw: string;
	normalized: string;
	form: string;
	placement: string;
	anchorId: string | null;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
}

interface ImportRow {
	factId: string;
	module: string;
	specifier: string;
	edge: string;
	loads: string | null;
	elided: number | null;
	landing: string | null;
}

interface ExportRow {
	factId: string;
	module: string;
	edge: string;
}

function rowToNote(row: NoteRow): FileNote {
	const ranged = row.startLine !== null && row.startChar !== null && row.endLine !== null && row.endChar !== null;
	return {
		severity: row.severity,
		message: row.message,
		...(row.path === null ? {} : { path: row.path }),
		...(ranged
			? {
					range: {
						start: { line: row.startLine as number, character: row.startChar as number },
						end: { line: row.endLine as number, character: row.endChar as number },
					},
				}
			: {}),
	};
}

function roleFromRow(row: RoleRow): FileRole | null {
	if (row.role === null) return null;
	const parsed = FileRoleSchema.safeParse({
		kind: row.role,
		...defined({
			how: row.roleHow ?? undefined,
			symbolId: row.roleSymbolId ?? undefined,
			reason: row.roleReason ?? undefined,
		}),
	});
	return parsed.success ? parsed.data : null;
}

/** Absent stays absent through the round trip, so "not measured" never arrives looking like zero. */
function metricsOf(row: SymbolRow): { metrics?: Metrics } {
	const metrics: Metrics = {
		...(row.mLines === null ? {} : { lines: row.mLines }),
		...(row.mParameters === null ? {} : { parameters: row.mParameters }),
		...(row.mNesting === null ? {} : { nesting: row.mNesting }),
		...(row.mBranches === null ? {} : { branches: row.mBranches }),
	};
	return Object.keys(metrics).length === 0 ? {} : { metrics };
}

function rowToDeclaration(raw: unknown): StoredDeclaration {
	const row = raw as SymbolRow;
	return {
		symbolId: row.symbolId,
		factId: row.factId,
		module: row.module,
		name: row.name,
		kind: row.kind as StoredDeclaration["kind"],
		visibility: row.visibility as StoredDeclaration["visibility"],
		range: {
			start: { line: row.startLine, character: row.startChar },
			end: { line: row.endLine, character: row.endChar },
		},
		// A row from before the flag reads as named, which every row then was.
		...(row.synthesizedName === 1
			? {}
			: {
					selectionRange: {
						start: { line: row.nameLine, character: row.nameChar },
						end: { line: row.nameEndLine, character: row.nameEndChar },
					},
				}),
		...metricsOf(row),
		// Omitted rather than stored as null, so an absent field stays absent through a round trip.
		...(row.exported === null ? {} : { exported: row.exported === 1 }),
		...(row.containerId === null ? {} : { containerId: row.containerId }),
		...(row.signature === null ? {} : { signature: row.signature }),
		...(row.contains === null ? {} : { contains: row.contains as StoredDeclaration["contains"] }),
		...(row.memberInsertLine === null ? {} : { memberInsertLine: row.memberInsertLine }),
		...(row.languageKind === null ? {} : { languageKind: row.languageKind }),
		...(row.valueStatus === null ? {} : { valueStatus: row.valueStatus as StoredDeclaration["valueStatus"] }),
	};
}

function rowToComment(raw: unknown): StoredComment {
	const row = raw as CommentRow;
	return {
		factId: row.factId,
		module: row.module,
		raw: row.raw,
		normalized: row.normalized,
		form: row.form as StoredComment["form"],
		placement: row.placement,
		anchorId: row.anchorId,
		range: {
			start: { line: row.startLine, character: row.startChar },
			end: { line: row.endLine, character: row.endChar },
		},
	};
}

/**
 * The one place a doc anchor is checked, before anything is written.
 *
 * An anchor is any non-empty string on the wire, so every reader downstream would otherwise
 * re-decide what it is allowed to be, and the third reader to forget is the one that ships a hit
 * in one file labelled with a heading from another.
 *
 * REFUSED rather than nulled: null already means the region sits under no heading, and reusing it
 * for "the provider named something we could not verify" would hide a contract violation behind a
 * legitimate answer. Refused before the transaction opens, so the file's previous facts survive.
 */
function rowToDoc(raw: unknown): StoredDoc {
	const row = raw as DocRow;
	return {
		factId: row.factId,
		module: row.module,
		raw: row.raw,
		normalized: row.normalized,
		fenced: row.fenced !== 0,
		anchorId: row.anchorId,
		range: {
			start: { line: row.startLine, character: row.startChar },
			end: { line: row.endLine, character: row.endChar },
		},
	};
}

function rowToLiteral(raw: unknown): StoredLiteral {
	const row = raw as LiteralRow;
	return {
		factId: row.factId,
		module: row.module,
		kind: row.kind as StoredLiteral["kind"],
		value: row.value,
		number: row.number,
		containerId: row.containerId,
		...(row.containerName === null || row.containerName === undefined ? {} : { containerName: row.containerName }),
		...(row.containerKind === null || row.containerKind === undefined ? {} : { containerKind: row.containerKind }),
		range: {
			start: { line: row.startLine, character: row.startChar },
			end: { line: row.endLine, character: row.endChar },
		},
	};
}

/** The edge as the provider sent it, with where its specifier landed. Written only by this store. */
function rowToImport(raw: unknown): StoredImport {
	const row = raw as ImportRow;
	return {
		...(JSON.parse(row.edge) as ImportEdge),
		...(row.loads === null ? {} : { loads: row.loads as ImportEdge["loads"] }),
		...(row.elided === null ? {} : { elided: row.elided === 1 }),
		factId: row.factId,
		module: row.module,
		specifier: row.specifier,
		landing: row.landing === null ? null : (JSON.parse(row.landing) as Landing),
	};
}

function rowToExport(raw: unknown): StoredExport {
	const row = raw as ExportRow;
	return { ...(JSON.parse(row.edge) as Export), factId: row.factId, module: row.module };
}

function rowToReference(raw: unknown): StoredReference {
	const row = raw as RefRow;
	return {
		factId: row.factId,
		module: row.module,
		name: row.name,
		role: row.role as StoredReference["role"],
		targetId: row.targetId,
		fromId: row.fromId,
		qualified: row.qualified === null ? null : row.qualified === 1,
		provenance: row.provenance,
		startLine: row.startLine,
		startCharacter: row.startChar,
		endLine: row.endLine,
		endCharacter: row.endChar,
		origin: originOf(row),
	};
}

/** Null when unproved, which is unknown. */
function originOf(row: RefRow): ReferenceOrigin | null {
	if (row.originKind === "declaration") return { kind: "declaration" };
	if (row.originKind !== "import" || row.originStartLine === null) return null;
	const path = row.originPath === null ? undefined : (JSON.parse(row.originPath) as string[]);
	return {
		kind: "import",
		span: {
			start: { line: row.originStartLine, character: row.originStartChar ?? 0 },
			end: { line: row.originEndLine ?? row.originStartLine, character: row.originEndChar ?? 0 },
		},
		...(path === undefined ? {} : { path }),
	};
}

export type { NoteRow, RoleRow };
export {
	roleFromRow,
	rowToComment,
	rowToDeclaration,
	rowToDoc,
	rowToExport,
	rowToImport,
	rowToLiteral,
	rowToNote,
	rowToReference,
	verdictFromRow,
};
