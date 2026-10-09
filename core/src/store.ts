// The index. Facts only: traversal, ranking and cycle collapsing happen in application code.
//
// Reverse lookup is the reason this is a database. References are recorded at the use site, so
// "who uses this" has no cheap answer in memory, and an index on the target column turns it into
// the same read as "what is this".

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	type AllList,
	type ContentCounts,
	type ContentTotals,
	commentFactId,
	compileExclusion,
	type Declaration,
	type DocRegion,
	declarationFactId,
	defined,
	docFactId,
	type EntryHow,
	type Export,
	exportFactId,
	type FileContent,
	type FileNote,
	type FileNotes,
	type FileRole,
	FileRoleSchema,
	hashContent,
	type Import,
	type ImportEdge,
	type ImportResolution,
	type IndexDepth,
	importFactId,
	type Landing,
	type Literal,
	literalFactId,
	type Metrics,
	type ModuleExclusion,
	type OriginEdge,
	ownerStarts,
	parseFactId,
	type Range,
	type Reference,
	type ReferenceOrigin,
	type ReferenceRole,
	type ResolutionMode,
	referenceFactId,
	SCHEMA_VERSION,
	type ScanCounts,
	type ScopeContribution,
	type StoredComment,
	type StoredDeclaration,
	type StoredDoc,
	type StoredExport,
	type StoredFact,
	type StoredImport,
	type StoredLiteral,
	type StoredReference,
} from "@nyaa-lexicon/protocol";
import { z } from "zod";
import { type Clock, systemClock } from "./clock.js";
import type { AttachedComment } from "./commentAttach.js";
import {
	type EffectiveExport,
	type ScopeLanding,
	scopeKey,
	scopeOfKey,
	settleProjections,
} from "./exportProjection.js";
import { admitFacts, spanKey } from "./factAdmission.js";
import type { GeneratedReason, GeneratedVerdict } from "./fileScope.js";
import {
	installRevisionTriggers,
	JOURNAL_DDL,
	JOURNAL_TABLE_NAMES,
	JOURNAL_TABLES,
	type JournalTable,
	keptBlobs,
} from "./journalSchema.js";
import { stampSeen } from "./lastSeen.js";
import { insertNote, NoteRows } from "./noteRows.js";
import type { PatternDigest } from "./patternDigest.js";
import { normalizeDocText } from "./proseText.js";
import { insertRelation, orderedPair, RELATION_TABLES, RelationRows } from "./relationRows.js";
import type { ScopeFilter } from "./scope.js";
import { compileSearchRegex, searchTerm } from "./search.js";
import {
	joinNoteFields,
	KNOWLEDGE_SCHEMA,
	KNOWLEDGE_TABLES,
	KnowledgeSubjects,
	normalizeSalvaged,
	restoreSubjects,
	SWEEP_START,
	type SweepCursor,
	type SweepPass,
	type SweepReport,
} from "./subjects.js";

export type {
	ContentCounts,
	ContentTotals,
	FileNote,
	FileNotes,
	ScanCounts,
	StoredComment,
	StoredDeclaration,
	StoredDoc,
	StoredFact,
	StoredImport,
	StoredLiteral,
	StoredReference,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

declare const hiddenBrand: unique symbol;

/** Modules a search skips; only the store mints one. */
export type HiddenModules = readonly string[] & { readonly [hiddenBrand]: true };

export const HiddenModules = {
	/** No exclusion asked. */
	none: Object.freeze([]) as unknown as HiddenModules,
};

export interface LiteralFilter {
	value?: string | undefined;
	kind?: string | undefined;
	low?: number | undefined;
	high?: number | undefined;
	key?: string | undefined;
	/** A file, or every module in a folder. */
	module?: string | undefined;
	scope?: ScopeFilter | undefined;
	hidden: HiddenModules;
}

export interface CommentFilter {
	form?: string | undefined;
	module?: string | undefined;
	hidden: HiddenModules;
}

export interface DocFilter {
	/** Restricts to fenced regions when true, to prose when false, to neither when absent. */
	fenced?: boolean | undefined;
	module?: string | undefined;
	hidden: HiddenModules;
}

export interface ReplaceFileInput {
	module: string;
	runtime?: "esm" | "cjs";
	contentHash: string;
	declarations: Declaration[];
	references: Reference[];
	imports?: Import[];
	literals?: Literal[];
	depth?: IndexDepth;
	comments?: AttachedComment[];
	docs?: DocRegion[];
	notes?: FileNote[];
	content?: FileContent;
	/** Provider id for this parse. */
	provider?: string;
	digests?: PatternDigest[];
	generated?: GeneratedVerdict | null;
	role?: FileRole | undefined;
	/** Where each specifier landed, as the provider resolved it, keyed by `resolutionKey`. */
	resolutions?: ReadonlyMap<string, ImportResolution | null>;
	/** Absent when the provider does not report exports, which is unknown coverage. */
	exports?: Export[] | undefined;
	allList?: AllList | undefined;
	scopeContributions?: ScopeContribution[] | undefined;
}

/** One commit of a module's rows: the depth they hold and the clock stamp the commit took. */
export interface FactsStamp {
	depth: IndexDepth;
	indexedAt: number;
}

/** A write that moved what other modules can bind to, and who may now bind differently. */
export interface SurfaceChange {
	/** Names of declarations the module did not hold in this form before. */
	gained: string[];
	/** Names of declarations the module held before in a form it no longer does. */
	lost: string[];
	/** Other modules with a reference bound to a declaration the module held before. */
	boundInto: string[];
	/** Whether the module held a surface before, so a provider may still hold a parse of what it was. */
	heldBefore: boolean;
	/** Scope keys the module contributed to before or after the write; their importers rebind too. */
	scopes: string[];
}

/** One declaration as another module may bind to it. */
interface SurfaceRow {
	symbolId: string;
	name: string;
	kind: string;
	/** A flavour can change what a binding to it loads, e.g. an enum inlined at compile time. */
	languageKind: string | null;
	visibility: string;
	exported: boolean | null;
}

/** One thing another module can bind to, keyed by everything a binding to it depends on. */
interface SurfaceEntry {
	key: string;
	/** The name a use spells; null for a re-export that names none. */
	name: string | null;
}

////////////////////////////////
//  Constants

export { SCHEMA_VERSION };

/** Added in place, so IF NOT EXISTS. */
const NOTES_TABLE = `
-- A provider's warnings and info for a file, replaced with its facts.
CREATE TABLE IF NOT EXISTS notes (
  module    TEXT NOT NULL,
  ordinal   INTEGER NOT NULL,
  severity  TEXT NOT NULL CHECK (severity IN ('warning', 'info')),
  message   TEXT NOT NULL,
  path      TEXT,
  startLine INTEGER,
  startChar INTEGER,
  endLine   INTEGER,
  endChar   INTEGER,
  PRIMARY KEY (module, ordinal)
);
CREATE INDEX IF NOT EXISTS notes_module ON notes(module);
`;

// Every range is stored whole. Keeping only a start meant the index could say where something was
// and never what text it occupied, which is the difference between navigating and editing.
const SCHEMA = `
-- Facts about the index itself rather than about any file. Free-form because the alternative is a
-- schema bump for every new thing worth remembering, and these are all short strings.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE files (
  module      TEXT PRIMARY KEY,
  runtime     TEXT CHECK (runtime IN ('esm', 'cjs')),
  contentHash TEXT NOT NULL,
  indexedAt   INTEGER NOT NULL,
  -- Outline rows require a full parse.
  depth       TEXT NOT NULL DEFAULT 'full',
  -- What the owning provider declared its files are; NULL on a row written before that was kept.
  content     TEXT,
  -- Provider id, or NULL when absent.
  provider    TEXT,
  -- Git's word: 'yes', 'no' or 'unknown' with its reason; NULL on a row written without asking.
  generated        TEXT,
  generatedReason  TEXT,
  -- library, entry, or unknown; NULL when no role was reported.
  role             TEXT,
  roleHow          TEXT,
  roleSymbolId     TEXT,
  roleReason       TEXT,
  -- Digest of what other modules can bind to; NULL on a row written before it was kept.
  surface          TEXT,
  -- 1 when the parse carried export facts; 0 is unknown coverage.
  exportsKnown     INTEGER NOT NULL DEFAULT 0,
  -- The star-export list as JSON; NULL when the language has none.
  allList          TEXT
);
CREATE INDEX files_indexed_at ON files(indexedAt);
CREATE INDEX files_depth ON files(depth);
CREATE INDEX files_role ON files(role);

-- Parse failures persist until a successful parse or file removal.
CREATE TABLE parse_failures (
  module   TEXT PRIMARY KEY,
  reason   TEXT NOT NULL,
  failedAt INTEGER NOT NULL
);
${NOTES_TABLE}
-- What a write moved of a module's surface, until the road that wrote it has made durable the
-- dependents it owes. Written with the facts, so a daemon stopping first leaves the question here.
CREATE TABLE surface_moves (
  module    TEXT PRIMARY KEY,
  -- JSON arrays: names gained, names lost, modules bound into what the module held.
  gained     TEXT NOT NULL,
  lost       TEXT NOT NULL,
  boundInto  TEXT NOT NULL,
  -- 1 when the module held a surface before, so a provider may still hold a parse of what it was.
  heldBefore INTEGER NOT NULL CHECK (heldBefore IN (0, 1)),
  -- JSON: the scope keys the module contributed to before or after.
  scopes     TEXT NOT NULL DEFAULT '[]'
);

-- Modules owed a parse because a move left their bindings stale, until a parse reading references
-- is admitted.
CREATE TABLE rebind_owed (
  module     TEXT PRIMARY KEY,
  -- Null when payable now; else the provider a failed parse waits on.
  blockedBy  TEXT,
  -- 'outage' waits for that provider to answer again; 'refusal' for its own file or a restart.
  blockedFor TEXT CHECK (blockedFor IN ('outage', 'refusal')),
  -- The daemon and provider process that failed it; either restarting retries it.
  blockedIn  TEXT
);
-- Every admitted parse asks for its provider's outages, so the ask is an indexed read.
CREATE INDEX rebind_owed_blocked ON rebind_owed(blockedBy, blockedFor);

CREATE TABLE symbols (
  symbolId    TEXT PRIMARY KEY,
  -- Not the same thing as symbolId, deliberately. A symbol id names the SYMBOL and survives edits;
  -- a fact id names this row as it currently reads, so a changed signature is a changed fact.
  factId      TEXT NOT NULL,
  module      TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  visibility  TEXT NOT NULL,
  exported    INTEGER,
  containerId TEXT,
  signature   TEXT,
  startLine   INTEGER NOT NULL,
  startChar   INTEGER NOT NULL,
  endLine     INTEGER NOT NULL,
  endChar     INTEGER NOT NULL,
  -- The name alone. A rename rewrites this span, never the declaration's whole range.
  nameLine    INTEGER NOT NULL,
  nameChar    INTEGER NOT NULL,
  nameEndLine INTEGER NOT NULL,
  nameEndChar INTEGER NOT NULL,
  -- 1 when the name is nowhere in the source and the name columns hold the range start instead.
  synthesizedName INTEGER,
  -- All nullable. A metric a provider does not compute is absent, never zero, because zero
  -- branches and "not measured" are different facts.
  mLines      INTEGER,
  mParameters INTEGER,
  mNesting    INTEGER,
  mBranches   INTEGER,
  -- Evidence that a vanished declaration reappeared elsewhere; null before a full parse.
  patternDigest   TEXT,
  patternCoverage TEXT,
  -- Null reads the kind.
  contains        TEXT CHECK (contains IN ('members', 'locals')),
  -- Null: the provider named no safe insertion line.
  memberInsertLine INTEGER,
  -- The provider's own word for the form, such as an extension or a trait method.
  languageKind    TEXT
);
CREATE INDEX symbols_module ON symbols(module);
CREATE INDEX symbols_name ON symbols(name);
CREATE INDEX symbols_fact ON symbols(factId);

CREATE TABLE refs (
  factId     TEXT NOT NULL,
  module     TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,
  targetId   TEXT,
  fromId     TEXT,
  -- Null when the provider did not say.
  qualified  INTEGER,
  provenance TEXT NOT NULL,
  startLine  INTEGER NOT NULL,
  startChar  INTEGER NOT NULL,
  endLine    INTEGER NOT NULL,
  endChar    INTEGER NOT NULL,
  -- The binding the use resolves through, when proved: declaration or import, with the import
  -- edge's span and the member path as JSON.
  originKind      TEXT,
  originStartLine INTEGER,
  originStartChar INTEGER,
  originEndLine   INTEGER,
  originEndChar   INTEGER,
  originPath      TEXT
);
CREATE INDEX refs_module ON refs(module);
-- The whole reason for a database: this turns reverse lookup into an indexed read.
CREATE INDEX refs_target ON refs(targetId);
CREATE INDEX refs_from ON refs(fromId);
CREATE INDEX refs_name ON refs(name);
-- Not unique, here or on any fact table. Two identical statements in one file are the same fact
-- written twice, so one id for both is the right answer rather than a collision to design around.
CREATE INDEX refs_fact ON refs(factId);
CREATE INDEX refs_origin ON refs(module, originStartLine, originStartChar);

-- One row per import EDGE, not one per statement: a name, a namespace, a wildcard, an injection or a
-- side effect. The edge column holds the whole protocol edge as JSON; the others are what queries read.
CREATE TABLE imports (
  factId     TEXT NOT NULL,
  module     TEXT NOT NULL,
  specifier  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  loads      TEXT CHECK (loads IN ('static', 'deferred')),
  elided     INTEGER CHECK (elided IN (0, 1)),
  -- The source name and its span; null when the edge names no export.
  name       TEXT,
  startLine  INTEGER,
  startChar  INTEGER,
  endLine    INTEGER,
  endChar    INTEGER,
  -- The local binding and its span; null when the edge writes none.
  localName      TEXT,
  localStartLine INTEGER,
  localStartChar INTEGER,
  localEndLine   INTEGER,
  localEndChar   INTEGER,
  -- The edge as written, which export targets and reference origins name it by.
  spanStartLine INTEGER NOT NULL,
  spanStartChar INTEGER NOT NULL,
  spanEndLine   INTEGER NOT NULL,
  spanEndChar   INTEGER NOT NULL,
  bindsLocally  INTEGER NOT NULL,
  typeOnly      INTEGER NOT NULL DEFAULT 0,
  edge          TEXT NOT NULL,
  -- Where the specifier landed when written, as JSON; null when unresolved or external.
  landing       TEXT,
  -- A module landing's module.
  target        TEXT,
  -- A scope landing's key, JSON [providerId, kind, scopeId].
  targetScope   TEXT,
  -- An external resolution's indexable module: reachability only, never a landing.
  surfaceTarget TEXT
);
CREATE INDEX imports_module ON imports(module);
CREATE INDEX imports_name ON imports(name);
CREATE INDEX imports_local ON imports(localName);
CREATE INDEX imports_fact ON imports(factId);
CREATE INDEX imports_target ON imports(target);
CREATE INDEX imports_scope ON imports(targetScope);
CREATE INDEX imports_surface ON imports(surfaceTarget);
CREATE INDEX imports_span ON imports(module, spanStartLine, spanStartChar);

-- One row per export edge. The edge column holds the protocol edge as JSON; the others are what queries read.
CREATE TABLE exports (
  factId         TEXT NOT NULL,
  module         TEXT NOT NULL,
  form           TEXT NOT NULL,
  name           TEXT,
  targetKind     TEXT NOT NULL,
  targetSymbolId TEXT,
  edge           TEXT NOT NULL
);
CREATE INDEX exports_module ON exports(module);
CREATE INDEX exports_name ON exports(name);
CREATE INDEX exports_target ON exports(targetSymbolId);
CREATE INDEX exports_fact ON exports(factId);

-- Each scope a module contributes to, empty contributions included, so a scope with no member is
-- told apart from one nothing admitted.
CREATE TABLE scope_contributions (
  module   TEXT NOT NULL,
  scopeKey TEXT NOT NULL,
  PRIMARY KEY (module, scopeKey)
);
CREATE INDEX scope_contributions_key ON scope_contributions(scopeKey);

CREATE TABLE scope_members (
  module   TEXT NOT NULL,
  scopeKey TEXT NOT NULL,
  memberId TEXT NOT NULL
);
CREATE INDEX scope_members_module ON scope_members(module);
CREATE INDEX scope_members_key ON scope_members(scopeKey);

-- Advanced by every write a contributor makes, so a plan can tell its scope moved.
CREATE TABLE scope_generations (
  scopeKey   TEXT PRIMARY KEY,
  generation INTEGER NOT NULL
);

-- Each module's effective exports, from the export resolver: a name, its meaning and origin as
-- JSON, and its certainty. A null name is an unnamed route, such as unknown coverage.
CREATE TABLE effective_exports (
  module         TEXT NOT NULL,
  name           TEXT,
  meaning        TEXT,
  origin         TEXT NOT NULL,
  originSymbolId TEXT,
  certainty      TEXT NOT NULL
);
CREATE INDEX effective_exports_module ON effective_exports(module);
CREATE INDEX effective_exports_origin ON effective_exports(originSymbolId);

-- Modules whose effective exports a write may have moved, until settlement recomputes them.
-- heldBefore: the index held the module before the write that owed it.
CREATE TABLE projection_debt (
  module     TEXT PRIMARY KEY,
  heldBefore INTEGER NOT NULL
);

-- Text as facts rather than as bytes. A name inside a string is not a reference, so without this
-- table an __all__ entry and a connect("thing_happened") argument are in no index anywhere.
CREATE TABLE literals (
  factId      TEXT NOT NULL,
  module      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL,
  -- Kept apart from value so a range query is arithmetic rather than a string comparison, where
  -- "10" sorts before "9" and 0xFF never equals 255.
  number      REAL,
  containerId TEXT,
  startLine   INTEGER NOT NULL,
  startChar   INTEGER NOT NULL,
  endLine     INTEGER NOT NULL,
  endChar     INTEGER NOT NULL
);
CREATE INDEX literals_module ON literals(module);
CREATE INDEX literals_value ON literals(value);
CREATE INDEX literals_number ON literals(number);
CREATE INDEX literals_fact ON literals(factId);
CREATE INDEX literals_container ON literals(containerId);

-- Doctrine lives here. Every other fact table answers "what is this code", and this one answers
-- "what did someone say about it", which was the one question that always fell back to grep.
CREATE TABLE comments (
  factId     TEXT NOT NULL,
  module     TEXT NOT NULL,
  -- Verbatim, markers included, because a citation quoting a comment must quote the file.
  raw        TEXT NOT NULL,
  -- Markers and wrapping removed. Search runs over this so a phrase split across a line break is
  -- still one phrase; display and citations use raw.
  normalized TEXT NOT NULL,
  form       TEXT NOT NULL,
  placement  TEXT NOT NULL,
  -- Null when the module is the container: a header, a licence, a banner. Absence is the answer
  -- here rather than a missing one, which is why nothing guesses a symbol to put in it.
  anchorId   TEXT,
  startLine  INTEGER NOT NULL,
  startChar  INTEGER NOT NULL,
  endLine    INTEGER NOT NULL,
  endChar    INTEGER NOT NULL
);
CREATE INDEX comments_module ON comments(module);
CREATE INDEX comments_anchor ON comments(anchorId);
CREATE INDEX comments_fact ON comments(factId);
CREATE INDEX comments_form ON comments(form);

-- A document's prose. Separate from comments because the answer shape differs: a comment result
-- names the symbol it documents, and a doc result names the heading PATH it was found under.
CREATE TABLE docs (
  factId     TEXT NOT NULL,
  module     TEXT NOT NULL,
  -- Verbatim, so a citation quoting a region quotes the file.
  raw        TEXT NOT NULL,
  -- Whitespace collapsed. Search runs over this so a sentence wrapped across lines is one phrase.
  normalized TEXT NOT NULL,
  -- Constrained, because rowToDoc reads any non-zero as true and would launder a bad write.
  fenced     INTEGER NOT NULL CHECK (fenced IN (0, 1)),
  -- Null before the first heading and in a document with none, which is the region belonging to the
  -- module. Absence is the answer, not a missing one, so nothing guesses a heading to put here.
  anchorId   TEXT,
  startLine  INTEGER NOT NULL,
  startChar  INTEGER NOT NULL,
  endLine    INTEGER NOT NULL,
  endChar    INTEGER NOT NULL
);
CREATE INDEX docs_module ON docs(module);
CREATE INDEX docs_anchor ON docs(anchorId);
CREATE INDEX docs_fact ON docs(factId);

-- The knowledge layer's tables, keyed by subject and owned by subjects.ts.
${KNOWLEDGE_SCHEMA}

${RELATION_TABLES}

${JOURNAL_DDL}
`;

/**
 * Every table a file contributes rows to, keyed by module.
 *
 * One list, because replaceFile and forgetFile must clear exactly the same set. Written out
 * separately, a table added to one and not the other leaves a deleted file's rows in the index
 * forever, still answering searches.
 */
const FACT_TABLES = [
	"refs",
	"symbols",
	"imports",
	"exports",
	"scope_contributions",
	"scope_members",
	"literals",
	"comments",
	"docs",
	"notes",
] as const;

/** Classifies use vs mention. */
const ROLE_CLASS: Readonly<Record<ReferenceRole, "use" | "mention">> = {
	call: "use",
	read: "use",
	write: "use",
	extends: "use",
	implements: "use",
	instantiate: "use",
	typeUse: "use",
	import: "mention",
	export: "mention",
};

/** SQL form of ROLE_CLASS. */
function useSql(alias: string): string {
	const uses = Object.entries(ROLE_CLASS).filter(([, kind]) => kind === "use");
	return `${alias}.role IN (${uses.map(([role]) => `'${role}'`).join(", ")})`;
}

/** Meta key for store compatibility. */
const COMPATIBILITY_KEY = "storeCompatibility";

/** Meta key: when notes began. */
const NOTES_SINCE_KEY = "notesSince";

interface NoteRow {
	severity: "warning" | "info";
	message: string;
	path: string | null;
	startLine: number | null;
	startChar: number | null;
	endLine: number | null;
	endChar: number | null;
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

/** Makes a held rebind debt payable again. */
const UNBLOCK = "UPDATE rebind_owed SET blockedBy = NULL, blockedFor = NULL, blockedIn = NULL";

/** Where the last scan's coverage arithmetic lives in the meta table. */
const SCAN_SUMMARY_KEY = "scanSummary";

/** Where the last capped sweep stopped, beside the scan summary. */
const SWEEP_CURSOR_KEY = "knowledgeSweepCursor";

/** Prefix of each provider's project fingerprint, suffixed with its id. */
const PROJECT_FINGERPRINT_KEY = "projectFingerprint";

/**
 * Where the indexed workspace's path lives in the meta table.
 *
 * Written so a store can say what it indexed with no daemon running: the path is otherwise only
 * in the lock file, which a stopped daemon takes with it, leaving a hashed directory name and no
 * way to tell a long-gone project from a live one.
 */
const WORKSPACE_KEY = "workspaceRoot";

/** Carries the ledger id across rebuilds. */
const LEDGER_KEY = "refactorLedger";

/** When describe answers seeded notes. */
const NOTES_SEEDED_KEY = "notesSeeded";

/** 1 for a module under a test directory or named as a test, so a name search lists source first. */
const TEST_PATH = `(module LIKE '%__tests__/%' OR module LIKE '%.test.%' OR module LIKE '%.spec.%'
 OR module LIKE 'test/%' OR module LIKE '%/test/%' OR module LIKE 'tests/%' OR module LIKE '%/tests/%')`;

/** 1 for a module under a dependency directory, so a name search lists the workspace's own code first. */
const VENDOR_PATH = `(module LIKE 'node_modules/%' OR module LIKE '%/node_modules/%' OR module LIKE 'vendor/%'
 OR module LIKE '%/vendor/%' OR module LIKE 'third_party/%' OR module LIKE '%/third_party/%')`;

/** Preserve journals needed to recover disk edits. */
const SALVAGED_JOURNAL: readonly string[] = JOURNAL_TABLE_NAMES.filter((table) => {
	const entry: JournalTable = JOURNAL_TABLES[table];
	return entry.salvage;
});

/** Tables a rebuild carries across, because no re-index can regenerate what is in them. */
const SALVAGED_TABLES: readonly string[] = [...KNOWLEDGE_TABLES, ...SALVAGED_JOURNAL];

/** What survives a rebuild, keyed by table so a new salvaged table needs no new field. */
type SalvagedKnowledge = Record<string, Array<Record<string, unknown>>>;

/**
 * Read by column NAME, so rows written under an older schema carry what they have.
 *
 * An unreadable knowledge table salvages empty. An unreadable JOURNAL table throws: its rows describe
 * files already on disk, and dropping them strands a half-applied refactor.
 */
function salvageKnowledge(db: DatabaseSync): SalvagedKnowledge {
	const exists = new Set(
		(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
			(row) => row.name,
		),
	);

	const salvaged: SalvagedKnowledge = {};
	for (const table of SALVAGED_TABLES) {
		if (!exists.has(table)) {
			salvaged[table] = [];
			continue;
		}
		try {
			salvaged[table] = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
		} catch (error) {
			if (SALVAGED_JOURNAL.includes(table)) {
				throw new Error(
					`the refactor journal in ${table} could not be read, so an unfinished refactor cannot be recovered: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			salvaged[table] = [];
		}
	}
	return salvaged;
}

/** How many rows found no subject, since another holds their address, and how many were unreadable. */
interface RestoreReport {
	unplaced: number;
	dropped: number;
}

/** The salvaged knowledge put back: subjects as they were, every other row through the one placement. */
function restoreKnowledge(
	db: DatabaseSync,
	salvaged: SalvagedKnowledge,
	now: number,
	seededAt: number | null,
): RestoreReport {
	const rows = normalizeSalvaged(salvaged, now, seededAt);
	restoreSubjects(db, rows.subjects);
	const subjects = new KnowledgeSubjects(db);
	let unplaced = 0;

	// A note's links and proposal follow the note to wherever it was placed.
	const notePlaced = new Map<string, string>();
	for (const row of rows.notes) {
		const placement = subjects.placeRow({ subjectId: row.subjectId, recordedAs: row.recordedAs, at: now });
		if (!placement.placed || notePlaced.has(placement.subjectId)) {
			unplaced++;
			continue;
		}
		if (row.subjectId !== null) notePlaced.set(row.subjectId, placement.subjectId);
		insertNote(db, placement.subjectId, row, false);
	}
	const link = db.prepare(
		`INSERT OR IGNORE INTO symbol_note_links (subjectId, proposed, written, target, targetDigest)
		 VALUES (?, ?, ?, ?, ?)`,
	);
	for (const row of rows.noteLinks) {
		const subjectId = notePlaced.get(row.subjectId);
		if (subjectId === undefined) continue;
		link.run(subjectId, row.proposed ? 1 : 0, row.written, row.target, row.targetDigest);
	}
	const proposal = db.prepare(
		`INSERT OR IGNORE INTO symbol_note_proposals (subjectId, baseRevision, text, proposedBy, proposedAt)
		 VALUES (?, ?, ?, ?, ?)`,
	);
	for (const row of rows.noteProposals) {
		const subjectId = notePlaced.get(row.subjectId);
		if (subjectId === undefined) continue;
		proposal.run(subjectId, row.baseRevision, row.text, row.proposedBy, row.proposedAt);
	}

	// Both ends placed, or the relation stays out: two subjects never merge.
	for (const row of rows.relations) {
		const one = subjects.placeRow({ subjectId: row.subjectId, recordedAs: row.recordedAs, at: now });
		const other = subjects.placeRow({ subjectId: row.otherId, recordedAs: row.otherAs, at: now });
		if (!one.placed || !other.placed || one.subjectId === other.subjectId) {
			unplaced++;
			continue;
		}
		const [first] = orderedPair(one.subjectId, other.subjectId);
		const swapped = first !== one.subjectId;
		insertRelation(db, swapped ? other.subjectId : one.subjectId, swapped ? one.subjectId : other.subjectId, {
			...row,
			recordedAs: swapped ? row.otherAs : row.recordedAs,
			otherAs: swapped ? row.recordedAs : row.otherAs,
			digest: swapped ? row.otherDigest : row.digest,
			otherDigest: swapped ? row.digest : row.otherDigest,
		});
	}

	for (const table of SALVAGED_JOURNAL) restoreByColumn(db, table, salvaged[table] ?? []);
	return { unplaced, dropped: rows.dropped };
}

/**
 * Restores rows into whatever columns the new schema shares with the old ones.
 *
 * Column-wise rather than positional, so adding a journal column keeps old rows loadable instead
 * of dropping every one of them the first time the schema moves. A row losing a column it no
 * longer has is fine; a row losing its whole transaction is not. A column added later must allow
 * NULL or carry a default, or every older row fails the open.
 */
function restoreByColumn(db: DatabaseSync, table: string, rows: Array<Record<string, unknown>>): void {
	if (rows.length === 0) return;

	const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
		(column) => column.name,
	);

	for (const row of rows) {
		const present = columns.filter((column) => row[column] !== undefined);
		if (present.length === 0) continue;
		const statement = db.prepare(
			`INSERT OR REPLACE INTO ${table} (${present.join(", ")}) VALUES (${present.map(() => "?").join(", ")})`,
		);
		statement.run(...present.map((column) => row[column] as string | number | null | Uint8Array));
	}
}

/**
 * Migration shim, removed at 4.0.0. A store from before 3.2.0 journaled what a step moved as JSON
 * in the step's plan; this is the last read of that shape. Returns how many entries the schema
 * refused.
 */
function liftAppliedRebinds(db: DatabaseSync): number {
	const steps = db
		.prepare(
			`SELECT s.transactionId, s.stepNo, s.plan FROM refactor_steps s
			 JOIN refactor_transactions t ON t.id = s.transactionId
			 WHERE t.state = 'open' AND s.plan IS NOT NULL`,
		)
		.all() as Array<{ transactionId: string; stepNo: number; plan: string }>;
	const insert = db.prepare(
		`INSERT INTO refactor_rebinds
		 (transactionId, stepNo, ordinal, subjectId, fromSymbolId, toSymbolId,
		  priorFrom, priorEvidence, priorBoundAt, priorState, priorOrphanedAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	let dropped = 0;
	for (const step of steps) {
		let applied: unknown;
		try {
			const parsed = LegacyPlanSchema.safeParse(JSON.parse(step.plan));
			applied = parsed.success ? parsed.data.rebind?.applied : undefined;
		} catch {
			continue;
		}
		if (!Array.isArray(applied)) continue;
		// A step named each move once; a repeat would read as moved on when the newer one retraced
		// first, so it is lifted once, and a repeat disagreeing on the prior state is not a record.
		const seen = new Map<string, string>();
		applied.forEach((entry, ordinal) => {
			const move = liftedMove(entry);
			if (move === null) {
				dropped++;
				return;
			}
			const key = JSON.stringify([move.subjectId, move.from, move.to]);
			const whole = JSON.stringify(move);
			const earlier = seen.get(key);
			if (earlier !== undefined) {
				if (earlier !== whole) dropped++;
				return;
			}
			seen.set(key, whole);
			try {
				insert.run(
					step.transactionId,
					step.stepNo,
					ordinal,
					move.subjectId,
					move.from,
					move.to,
					move.priorFrom,
					move.priorEvidence,
					move.priorBoundAt,
					move.priorState,
					move.priorOrphanedAt,
				);
			} catch {
				dropped++;
			}
		});
	}
	return dropped;
}

interface LiftedMove {
	subjectId: string;
	from: string;
	to: string;
	priorFrom: string | null;
	priorEvidence: string;
	priorBoundAt: number;
	priorState: string;
	priorOrphanedAt: number | null;
}

const LegacyMoveSchema = z.object({
	subjectId: z.string().min(1),
	from: z.string().min(1),
	to: z.string().min(1),
	priorFrom: z.string().min(1).nullable(),
	priorEvidence: z.enum(["sameLocator", "journalMove", "journalRename", "batchExactMatch"]),
	priorBoundAt: z.number().int(),
	priorState: z.enum(["bound", "orphaned"]),
	priorOrphanedAt: z.number().int().nullable(),
});
const LegacyPlanSchema = z.object({ rebind: z.object({ applied: z.array(z.unknown()).optional() }).optional() });

/** Each field read as the type its column declares, never coerced; the closed values are the CHECKs' to refuse. */
function liftedMove(entry: unknown): LiftedMove | null {
	const parsed = LegacyMoveSchema.safeParse(entry);
	return parsed.success ? parsed.data : null;
}

/** Null when the table is absent, which is the case on an index written before it existed. */
function readMeta(db: DatabaseSync, key: string): string | null {
	try {
		const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value ?? null;
	} catch {
		return null;
	}
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

/** The persisted cursor, or the start when none is held or the held one has no recognisable shape. */
function readSweepCursor(db: DatabaseSync): SweepCursor {
	const raw = readMeta(db, SWEEP_CURSOR_KEY);
	if (raw === null) return SWEEP_START;
	try {
		const parsed = JSON.parse(raw) as Partial<SweepCursor>;
		if (typeof parsed.epoch !== "number") return SWEEP_START;
		if (parsed.pass === "B" && (parsed.after === null || typeof parsed.after === "string")) {
			return { epoch: parsed.epoch, pass: "B", after: parsed.after };
		}
		if (parsed.pass === "A") {
			const after = parsed.after;
			if (after === null) return { epoch: parsed.epoch, pass: "A", after: null };
			if (
				typeof after === "object" &&
				typeof after.orphanedAt === "number" &&
				typeof after.subjectId === "string"
			) {
				return {
					epoch: parsed.epoch,
					pass: "A",
					after: { orphanedAt: after.orphanedAt, subjectId: after.subjectId },
				};
			}
		}
		return SWEEP_START;
	} catch {
		return SWEEP_START;
	}
}

/** A sweep report survives the summary only whole; a partial one reads as no sweep. */
function sweepReportOf(value: unknown): SweepReport | null {
	if (typeof value !== "object" || value === null) return null;
	const report = value as Record<string, unknown>;
	const counts = ["examined", "rebound", "orphaned", "deleted", "ambiguous"] as const;
	if (counts.some((key) => typeof report[key] !== "number") || typeof report["stoppedEarly"] !== "boolean")
		return null;
	return {
		examined: report["examined"] as number,
		rebound: report["rebound"] as number,
		orphaned: report["orphaned"] as number,
		deleted: report["deleted"] as number,
		ambiguous: report["ambiguous"] as number,
		stoppedEarly: report["stoppedEarly"] as boolean,
	};
}

function tableExists(db: DatabaseSync, name: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return columns.some((row) => row.name === column);
}

/** A declaration another module may bind to, keyed by its id, kind, flavour and exposure. */
function declarationEntry(row: SurfaceRow): SurfaceEntry {
	return {
		key: JSON.stringify([row.symbolId, row.kind, row.languageKind, row.visibility, row.exported]),
		name: row.name,
	};
}

/**
 * What a write lets another module bind to by declaration: one entry per id, as the symbols table
 * keeps them, locals aside. What it exports moves with its projection, at settlement.
 */
function surfaceOf(declarations: readonly Declaration[]): SurfaceEntry[] {
	const byId = new Map<string, SurfaceEntry>();
	for (const d of declarations) {
		if (d.visibility === "local") continue;
		const { symbolId, name, kind, visibility } = d;
		const languageKind = d.languageKind ?? null;
		byId.set(
			symbolId,
			declarationEntry({ symbolId, name, kind, languageKind, visibility, exported: d.exported ?? null }),
		);
	}
	return [...byId.values()].sort((left, right) => (left.key < right.key ? -1 : 1));
}

function namesOf(entries: readonly SurfaceEntry[]): string[] {
	return [...new Set(entries.flatMap((entry) => (entry.name === null ? [] : [entry.name])))].sort();
}

/** A `resolutions` key: one per specifier and resolution mode. */
export function resolutionKey(specifier: string, mode: ResolutionMode | undefined): string {
	return mode === undefined ? specifier : `${specifier}\u0000${mode}`;
}

/** A resolved specifier's landing; null when it is external or unresolved. */
function landingOf(resolution: ImportResolution | null): Landing | null {
	return resolution?.status === "resolved" ? resolution.landing : null;
}

/** JSON with sorted keys and no undefined values, so two equal objects spell alike. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, each]) => each !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : 1));
		return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * Each import edge by its span, with its occurrence among identical edges, for reference ids.
 * Position and source order stay out of the identity, so an import moving re-mints nothing.
 */
function originEdges(imports: readonly Import[]): Map<string, OriginEdge> {
	const seen = new Map<string, number>();
	const out = new Map<string, OriginEdge>();
	for (const statement of imports) {
		for (const edge of statement.edges) {
			const { span: _span, range: _range, localRange: _localRange, order: _order, ...content } = edge;
			const key = canonical([statement.specifier, content]);
			const occurrence = seen.get(key) ?? 0;
			seen.set(key, occurrence + 1);
			out.set(spanKey(edge.span), { specifier: statement.specifier, edge, occurrence });
		}
	}
	return out;
}

////////////////////////////////
//  Class

export class IndexStore {
	/** The one owner of knowledge identity. */
	readonly subjects: KnowledgeSubjects;
	/** Note rows, keyed by subject. */
	readonly notes: NoteRows;
	/** Stated relations, feedback counts and discovery state. */
	readonly relations: RelationRows;

	/** The newest stamp written or held, so no two commits share one. */
	private newestStamp: number;
	/** In-process knowledge-changing writes. */
	private knowledgeTurns = 0;
	private transactionDepth = 0;
	private speculating = false;
	private pendingKnowledgeWrite = false;

	private constructor(
		private readonly db: DatabaseSync,
		private readonly clock: Clock,
	) {
		this.subjects = new KnowledgeSubjects(db, (changed) => this.recordKnowledgeWrite(changed));
		this.notes = new NoteRows(db, (changed) => this.recordKnowledgeWrite(changed));
		this.relations = new RelationRows(db, (changed) => this.recordKnowledgeWrite(changed));
		this.newestStamp = this.newestIndexedAt() ?? 0;
	}

	/** Runs a note write in one transaction, so a note and its links never land apart. */
	noteWrite<T>(work: () => T): T {
		return this.inTransaction(work);
	}

	/** Runs a relation write in one transaction, so a relation and the subjects it claims land together. */
	relationWrite<T>(work: () => T): T {
		return this.inTransaction(work);
	}

	/** The later of the clock and one past the newest: two commits in one millisecond stay ordered. */
	private nextStamp(): number {
		this.newestStamp = Math.max(this.clock.now(), this.newestStamp + 1);
		return this.newestStamp;
	}

	/** node:sqlite has no transaction helper, so one wrapper owns the begin/commit/rollback. Under a
	 * speculation it is a savepoint, which the speculation's rollback discards with everything else. */
	private inTransaction<T>(work: () => T): T {
		const savepoint = this.speculating ? `nested${this.transactionDepth}` : null;
		this.db.exec(savepoint === null ? "BEGIN" : `SAVEPOINT ${savepoint}`);
		this.transactionDepth++;
		try {
			const result = work();
			this.db.exec(savepoint === null ? "COMMIT" : `RELEASE ${savepoint}`);
			this.transactionDepth--;
			if (this.transactionDepth === 0 && this.pendingKnowledgeWrite) {
				this.knowledgeTurns++;
				this.pendingKnowledgeWrite = false;
			}
			return result;
		} catch (error) {
			this.db.exec(savepoint === null ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
			this.transactionDepth--;
			if (this.transactionDepth === 0) this.pendingKnowledgeWrite = false;
			throw error;
		}
	}

	/**
	 * Reads with `facts` standing in for their modules' stored facts, projections settled, then rolls
	 * every write back; `read` gets the modules whose exports moved. Synchronous, so no other read sees them.
	 */
	readOverlaid<T>(facts: readonly ReplaceFileInput[], read: (moved: string[]) => T): T {
		return this.speculate(() => {
			for (const each of facts) this.replaceFile(each);
			return read(this.settleProjections());
		});
	}

	/**
	 * Runs `work` over writes that never land: every write inside it, settled projections included,
	 * rolls back when it returns or throws. Synchronous, so no other read sees the writes.
	 */
	private speculate<T>(work: () => T): T {
		if (this.transactionDepth > 0) throw new Error("a speculation cannot open inside a transaction");
		this.db.exec("BEGIN");
		this.transactionDepth++;
		this.speculating = true;
		try {
			const result = work();
			if (result instanceof Promise) throw new Error("a speculation must finish synchronously");
			return result;
		} finally {
			this.db.exec("ROLLBACK");
			this.transactionDepth--;
			this.speculating = false;
			this.pendingKnowledgeWrite = false;
		}
	}

	private recordKnowledgeWrite(changed: boolean): void {
		if (!changed) return;
		if (this.transactionDepth > 0) {
			this.pendingKnowledgeWrite = true;
			return;
		}
		this.knowledgeTurns++;
	}

	/**
	 * Opens or rebuilds the index.
	 * `compatibility` is the writing major.
	 * Schema mismatch triggers rebuild.
	 */
	static open(
		file: string,
		compatibility?: string | null,
		workspaceRoot?: string,
		clock: Clock = systemClock,
	): { store: IndexStore; rebuilt: boolean; reason?: string; unplaced?: number; dropped?: number } {
		const db = new DatabaseSync(file);
		db.exec("PRAGMA journal_mode = WAL");

		let rebuilt = false;
		let unplaced = 0;
		let dropped = 0;
		let reason: string | undefined;
		let version = 0;
		try {
			version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		} catch {
			version = -1;
		}

		// Read before any rebuild drops the table it lives in.
		const stored = version === SCHEMA_VERSION ? readMeta(db, COMPATIBILITY_KEY) : null;
		// Preserve the ledger id across rebuilds.
		const ledger = readMeta(db, LEDGER_KEY);
		const seeded = readMeta(db, NOTES_SEEDED_KEY);
		const seededAt = seeded === null || !Number.isFinite(Number(seeded)) ? null : Number(seeded);
		// Read before a rebuild creates it: a store without the table journaled its moves as JSON.
		const liftRebinds = !tableExists(db, "refactor_rebinds");
		if (version === SCHEMA_VERSION && compatibility != null && stored !== null && stored !== compatibility) {
			version = -1;
			reason = "a major version has shipped since this index was written";
		} else if (version !== SCHEMA_VERSION && version !== 0) {
			reason = "the index schema changed";
		}

		if (version !== SCHEMA_VERSION) {
			// Knowledge crosses the rebuild: facts reindex from source; notes cannot be regenerated.
			const salvaged = salvageKnowledge(db);

			// Asked of the database rather than listed here. A hand-maintained drop list silently
			// diverges from SCHEMA the first time a table is added, and the failure is a rebuild that
			// dies on "table already exists" long after the change that caused it.
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all() as Array<{ name: string }>;
			// Every view, so one over a retired table never outlives it.
			const views = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as Array<{
				name: string;
			}>;

			// One transaction over drop, create and restore. Crashing between them would otherwise
			// leave a store with no journal and a workspace with a half-applied refactor in it.
			db.exec("BEGIN");
			try {
				for (const view of views) db.exec(`DROP VIEW IF EXISTS "${view.name}"`);
				for (const table of tables) db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
				db.exec(SCHEMA);
				({ unplaced, dropped } = restoreKnowledge(db, salvaged, clock.now(), seededAt));
				// The steps are back, so what they journaled as JSON moves into the table in the same commit.
				if (liftRebinds) dropped += liftAppliedRebinds(db);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			rebuilt = version !== 0;
		} else if (liftRebinds) {
			// Table and lift in one commit, or a crash between them reads as a store that already lifted.
			db.exec("BEGIN");
			try {
				db.exec(JOURNAL_TABLES.refactor_rebinds.ddl);
				dropped += liftAppliedRebinds(db);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}

		// Index additions are safe to apply in place, so existing stores get this lookup without a rebuild.
		db.exec("CREATE INDEX IF NOT EXISTS files_indexed_at ON files(indexedAt)");
		db.exec("CREATE INDEX IF NOT EXISTS refs_from ON refs(fromId)");
		// Nullable, so the add is one atomic statement and an old row reads as not yet recorded.
		if (!columnExists(db, "files", "content")) db.exec("ALTER TABLE files ADD COLUMN content TEXT");
		// Each column checked on its own, so a crash between the two adds is finished on the next open.
		if (!columnExists(db, "files", "generated")) db.exec("ALTER TABLE files ADD COLUMN generated TEXT");
		if (!columnExists(db, "files", "generatedReason")) db.exec("ALTER TABLE files ADD COLUMN generatedReason TEXT");
		if (!columnExists(db, "symbols", "synthesizedName")) {
			db.exec("ALTER TABLE symbols ADD COLUMN synthesizedName INTEGER");
		}
		if (!columnExists(db, "symbols", "patternDigest")) db.exec("ALTER TABLE symbols ADD COLUMN patternDigest TEXT");
		if (!columnExists(db, "refactor_transactions", "origin")) {
			db.exec("ALTER TABLE refactor_transactions ADD COLUMN origin TEXT");
		}
		if (!columnExists(db, "refactor_transactions", "revision")) {
			db.exec(
				"ALTER TABLE refactor_transactions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)",
			);
		}
		if (!columnExists(db, "symbols", "patternCoverage")) {
			db.exec("ALTER TABLE symbols ADD COLUMN patternCoverage TEXT");
		}
		if (!columnExists(db, "symbols", "contains")) {
			db.exec("ALTER TABLE symbols ADD COLUMN contains TEXT CHECK (contains IN ('members', 'locals'))");
		}
		// Once, in place, keeping every note someone wrote.
		if (columnExists(db, "symbol_notes", "summary")) {
			db.exec("BEGIN");
			try {
				joinNoteFields(db, seededAt);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		// Every statement is IF NOT EXISTS, so an index, trigger or view added later lands on an existing store here.
		db.exec(KNOWLEDGE_SCHEMA);
		db.exec(RELATION_TABLES);
		db.exec(JOURNAL_DDL);
		if (!columnExists(db, "refactor_recovery_intents", "diskStates")) {
			db.exec("ALTER TABLE refactor_recovery_intents ADD COLUMN diskStates TEXT");
		}
		if (!columnExists(db, "refactor_images", "beforeEdited")) {
			db.exec(
				"ALTER TABLE refactor_images ADD COLUMN beforeEdited INTEGER NOT NULL DEFAULT 0 CHECK (beforeEdited IN (0, 1))",
			);
		}
		db.exec(`
			INSERT OR IGNORE INTO refactor_known_states (transactionId, module, existed, contentHash, edited)
			SELECT baseline.transactionId, baseline.module,
				CASE WHEN latest.existsAfter = 1 THEN 1
					WHEN latest.existsAfter = 0 THEN 0
					ELSE baseline.existedBefore END,
				CASE WHEN latest.existsAfter = 1 THEN latest.afterHash
					WHEN latest.existsAfter = 0 THEN NULL
					ELSE baseline.beforeHash END,
				0
			FROM refactor_images AS baseline
			LEFT JOIN refactor_images AS latest
				ON latest.transactionId = baseline.transactionId
				AND latest.module = baseline.module
				AND latest.scope = 'step'
				AND latest.stepNo = (
					SELECT MAX(image.stepNo)
					FROM refactor_images AS image
					JOIN refactor_steps AS step
						ON step.transactionId = image.transactionId AND step.stepNo = image.stepNo
					WHERE image.transactionId = baseline.transactionId
						AND image.module = baseline.module
						AND image.scope = 'step'
						AND step.phase IN ('written', 'reindexed', 'finalized')
						AND (image.existsAfter = 0 OR (image.existsAfter = 1 AND image.afterHash IS NOT NULL))
				)
			WHERE baseline.scope = 'baseline'
		`);
		installRevisionTriggers(db);
		if (readMeta(db, LEDGER_KEY) === null) writeMeta(db, LEDGER_KEY, ledger ?? randomUUID());

		// Marker and table together, or a crash between them reads as a fresh table.
		if (!tableExists(db, "notes")) {
			db.exec("BEGIN");
			try {
				if (readMeta(db, NOTES_SINCE_KEY) === null) writeMeta(db, NOTES_SINCE_KEY, String(clock.now()));
				db.exec(NOTES_TABLE);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		} else if (readMeta(db, NOTES_SINCE_KEY) === null) {
			writeMeta(db, NOTES_SINCE_KEY, "0");
		}

		// Persist the key on every open.
		if (compatibility != null) writeMeta(db, COMPATIBILITY_KEY, compatibility);
		if (workspaceRoot !== undefined) {
			writeMeta(db, WORKSPACE_KEY, workspaceRoot);
			// A daemon opening on its root has seen the root.
			stampSeen(db, clock.now());
		}

		return {
			store: new IndexStore(db, clock),
			rebuilt,
			...defined({ reason }),
			...(unplaced === 0 ? {} : { unplaced }),
			...(dropped === 0 ? {} : { dropped }),
		};
	}

	////////////////////////////////
	//  Writing

	/**
	 * Replaces everything one file contributed, in one transaction.
	 *
	 * Surgical by module, which is what makes an edit cost a delete and some inserts rather than a
	 * whole-index rebuild. The delete-then-insert is not an optimization: a symbol removed from a
	 * file has to disappear, and an upsert alone would leave it behind forever.
	 *
	 * Answers what the write moved of the module's declared surface, read before its old rows go, or
	 * null when other modules can bind to exactly what they could before. What it moved of the module's
	 * exports is settled after, from the projection debt the write records.
	 */
	replaceFile(input: ReplaceFileInput): SurfaceChange | null {
		const {
			module,
			contentHash,
			declarations,
			references,
			imports = [],
			literals = [],
			depth = "full",
			comments = [],
			docs = [],
			notes = [],
			content = "code",
			provider = null,
			digests = [],
			generated = null,
			role,
			resolutions = new Map(),
			exports,
			allList,
			scopeContributions = [],
		} = input;
		const landings = [...resolutions.values()].flatMap((resolution) => {
			const landing = landingOf(resolution);
			return landing === null ? [] : [landing];
		});
		admitFacts(module, {
			declarations,
			references,
			literals,
			docs,
			role,
			imports,
			exports,
			allList,
			landings,
			provider,
			scopeContributions,
		});
		const owners = ownerStarts(declarations);
		const digestOf = new Map(digests.map((digest) => [digest.symbolId, digest]));
		const through = originEdges(imports);
		const surface = surfaceOf(declarations);
		const surfaceDigest = hashContent(surface.map((entry) => entry.key).join("\n"));
		return this.inTransaction(() => {
			const change = this.surfaceChange(module, surface, surfaceDigest);
			const scopesBefore = this.scopeKeysOf(module);
			const before = this.db.prepare("SELECT allList FROM files WHERE module = ?").get(module) as
				| { allList: string | null }
				| undefined;
			const heldBefore = before !== undefined;
			const allListBefore = before?.allList ?? null;
			for (const table of FACT_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE module = ?`).run(module);
			this.db
				.prepare(
					`INSERT OR REPLACE INTO files (module, runtime, contentHash, indexedAt, depth, content, provider, generated, generatedReason,
					 role, roleHow, roleSymbolId, roleReason, surface, exportsKnown, allList)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					module,
					input.runtime ?? null,
					contentHash,
					this.nextStamp(),
					depth,
					content,
					provider,
					generated?.status ?? null,
					generated?.status === "unknown" ? generated.reason : null,
					role?.kind ?? null,
					role?.kind === "entry" ? role.how : null,
					role?.kind === "entry" && role.how === "main" ? role.symbolId : null,
					role?.kind === "unknown" ? role.reason : null,
					surfaceDigest,
					exports === undefined ? 0 : 1,
					allList === undefined ? null : JSON.stringify(allList),
				);
			// A successful parse clears its failure record.
			this.db.prepare("DELETE FROM parse_failures WHERE module = ?").run(module);
			if (change !== null) this.recordMove(module, change);
			// A parse reading references binds against every move so far, so it settles what was owed.
			if (depth !== "outline") this.db.prepare("DELETE FROM rebind_owed WHERE module = ?").run(module);

			const symbol = this.db.prepare(
				`INSERT OR REPLACE INTO symbols
				 (symbolId, factId, module, name, kind, visibility, exported, containerId, signature,
				  startLine, startChar, endLine, endChar, nameLine, nameChar, nameEndLine, nameEndChar,
				  synthesizedName, mLines, mParameters, mNesting, mBranches, patternDigest, patternCoverage, contains,
				  memberInsertLine, languageKind)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const d of declarations) {
				// The name columns are NOT NULL from before names could be absent; the flag says which.
				const named = d.selectionRange ?? { start: d.range.start, end: d.range.start };
				const digest = digestOf.get(d.symbolId);
				symbol.run(
					d.symbolId,
					declarationFactId(module, d),
					module,
					d.name,
					d.kind,
					d.visibility,
					// null, not 0: a provider that cannot answer must not be recorded as saying no.
					d.exported === undefined ? null : d.exported ? 1 : 0,
					d.containerId ?? null,
					d.signature ?? null,
					d.range.start.line,
					d.range.start.character,
					d.range.end.line,
					d.range.end.character,
					named.start.line,
					named.start.character,
					named.end.line,
					named.end.character,
					d.selectionRange === undefined ? 1 : 0,
					d.metrics?.lines ?? null,
					d.metrics?.parameters ?? null,
					d.metrics?.nesting ?? null,
					d.metrics?.branches ?? null,
					digest?.patternDigest ?? null,
					digest?.patternCoverage ?? null,
					d.contains ?? null,
					d.memberInsertLine ?? null,
					d.languageKind ?? null,
				);
			}
			this.subjects.restoreResolving(module, this.clock.now());
			this.subjects.refreshDigests(module);

			const reference = this.db.prepare(
				`INSERT INTO refs (factId, module, name, role, targetId, fromId, qualified, provenance, startLine, startChar, endLine, endChar,
				 originKind, originStartLine, originStartChar, originEndLine, originEndChar, originPath)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const r of references) {
				// An unbound reference keeps its REASON where a bound one keeps its provenance:
				// both answer "how do you know", and losing the reason discards why it failed.
				const target = r.binding.status === "bound" ? r.binding.symbolId : null;
				const how = r.binding.status === "unbound" ? r.binding.reason : r.binding.provenance;
				const span = r.origin?.kind === "import" ? r.origin.span : undefined;
				const path = r.origin?.kind === "import" ? r.origin.path : undefined;
				reference.run(
					referenceFactId(module, r, owners, span === undefined ? undefined : through.get(spanKey(span))),
					module,
					r.name,
					r.role,
					target,
					r.fromId ?? null,
					r.qualified === undefined ? null : r.qualified ? 1 : 0,
					how,
					r.range.start.line,
					r.range.start.character,
					r.range.end.line,
					r.range.end.character,
					r.origin?.kind ?? null,
					span?.start.line ?? null,
					span?.start.character ?? null,
					span?.end.line ?? null,
					span?.end.character ?? null,
					path === undefined ? null : JSON.stringify(path),
				);
			}

			const importRow = this.db.prepare(
				`INSERT INTO imports (factId, module, specifier, kind, loads, elided, name, startLine, startChar, endLine, endChar,
				 localName, localStartLine, localStartChar, localEndLine, localEndChar,
				 spanStartLine, spanStartChar, spanEndLine, spanEndChar, bindsLocally, typeOnly, edge,
				 landing, target, targetScope, surfaceTarget)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			// One row per edge, a side effect and a wildcard included: the edge is real when it names nothing.
			for (const statement of imports) {
				for (const edge of statement.edges) {
					const resolution = resolutions.get(resolutionKey(statement.specifier, edge.resolutionMode)) ?? null;
					const landing = landingOf(resolution);
					importRow.run(
						importFactId(module, statement.specifier, edge),
						module,
						statement.specifier,
						edge.kind,
						edge.loads ?? null,
						edge.elided === undefined ? null : edge.elided ? 1 : 0,
						edge.name ?? null,
						edge.range?.start.line ?? null,
						edge.range?.start.character ?? null,
						edge.range?.end.line ?? null,
						edge.range?.end.character ?? null,
						edge.local ?? null,
						edge.localRange?.start.line ?? null,
						edge.localRange?.start.character ?? null,
						edge.localRange?.end.line ?? null,
						edge.localRange?.end.character ?? null,
						edge.span.start.line,
						edge.span.start.character,
						edge.span.end.line,
						edge.span.end.character,
						edge.bindsLocally ? 1 : 0,
						edge.typeOnly === true ? 1 : 0,
						JSON.stringify(edge),
						landing === null ? null : JSON.stringify(landing),
						landing?.kind === "module" ? landing.module : null,
						landing === null || landing.kind === "module" ? null : scopeKey(landing),
						resolution?.status === "external" ? (resolution.surface?.module ?? null) : null,
					);
				}
			}

			const exportRow = this.db.prepare(
				"INSERT INTO exports (factId, module, form, name, targetKind, targetSymbolId, edge) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			for (const edge of exports ?? []) {
				exportRow.run(
					exportFactId(module, edge),
					module,
					edge.form,
					edge.name ?? null,
					edge.target.kind,
					edge.target.kind === "symbol" ? edge.target.symbolId : null,
					JSON.stringify(edge),
				);
			}

			const contribution = this.db.prepare(
				"INSERT OR IGNORE INTO scope_contributions (module, scopeKey) VALUES (?, ?)",
			);
			const member = this.db.prepare("INSERT INTO scope_members (module, scopeKey, memberId) VALUES (?, ?, ?)");
			for (const scope of scopeContributions) {
				const key = scopeKey({ kind: scope.kind, providerId: provider ?? "", scopeId: scope.scopeId });
				contribution.run(module, key);
				for (const memberId of scope.members) member.run(module, key, memberId);
			}

			const literalRow = this.db.prepare(
				`INSERT INTO literals (factId, module, kind, value, number, containerId, startLine, startChar, endLine, endChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const literal of literals) {
				literalRow.run(
					literalFactId(module, literal, owners),
					module,
					literal.kind,
					literal.value,
					literal.number ?? null,
					literal.containerId ?? null,
					literal.range.start.line,
					literal.range.start.character,
					literal.range.end.line,
					literal.range.end.character,
				);
			}

			const commentRow = this.db.prepare(
				`INSERT INTO comments (factId, module, raw, normalized, form, placement, anchorId, startLine, startChar, endLine, endChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const comment of comments) {
				// The anchor is recomputed on every pass and written fresh. Nothing migrates an old
				// one forward, so a symbol that moved cannot leave a comment pointing at where it was.
				commentRow.run(
					commentFactId(
						module,
						{ range: comment.range, text: comment.raw, anchorId: comment.anchorId },
						owners,
					),
					module,
					comment.raw,
					comment.normalized,
					comment.form,
					comment.placement,
					comment.anchorId,
					comment.range.start.line,
					comment.range.start.character,
					comment.range.end.line,
					comment.range.end.character,
				);
			}

			const docRow = this.db.prepare(
				`INSERT INTO docs (factId, module, raw, normalized, fenced, anchorId, startLine, startChar, endLine, endChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const region of docs) {
				docRow.run(
					docFactId(module, region, owners),
					module,
					region.text,
					normalizeDocText(region.plain ?? region.text),
					region.fenced ? 1 : 0,
					region.anchorId ?? null,
					region.range.start.line,
					region.range.start.character,
					region.range.end.line,
					region.range.end.character,
				);
			}

			const noteRow = this.db.prepare(
				`INSERT INTO notes (module, ordinal, severity, message, path, startLine, startChar, endLine, endChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			notes.forEach((note, ordinal) => {
				noteRow.run(
					module,
					ordinal,
					note.severity,
					note.message,
					note.path ?? null,
					note.range?.start.line ?? null,
					note.range?.start.character ?? null,
					note.range?.end.line ?? null,
					note.range?.end.character ?? null,
				);
			});
			// A star selecting by the module's list reads it, so a moved list owes its forwarders.
			if (allListBefore !== (allList === undefined ? null : JSON.stringify(allList))) this.oweForwarders(module);
			this.advanceGenerations(module, scopesBefore, heldBefore, change !== null);
			return change;
		});
	}

	/** What the module's declared surface moved, from the rows it holds before a write replaces them. */
	private surfaceChange(module: string, surface: SurfaceEntry[], digest: string): SurfaceChange | null {
		const file = this.db.prepare("SELECT surface FROM files WHERE module = ?").get(module) as
			| { surface: string | null }
			| undefined;
		if (file?.surface === digest) return null;
		const before = this.surfaceHeld(module);
		const keys = new Set(before.map((entry) => entry.key));
		const after = new Set(surface.map((entry) => entry.key));
		const gained = surface.filter((entry) => !keys.has(entry.key));
		const lost = before.filter((entry) => !after.has(entry.key));
		if (gained.length === 0 && lost.length === 0) return null;
		return {
			gained: namesOf(gained),
			lost: namesOf(lost),
			boundInto: this.boundInto(module),
			heldBefore: file !== undefined,
			scopes: [],
		};
	}

	/** What the module lets another module bind to by declaration, as its rows hold it. */
	private surfaceHeld(module: string): SurfaceEntry[] {
		const rows = this.db
			.prepare(
				"SELECT symbolId, name, kind, languageKind, visibility, exported FROM symbols WHERE module = ? AND visibility <> 'local'",
			)
			.all(module) as Array<Omit<SurfaceRow, "exported"> & { exported: number | null }>;
		return rows.map((row) =>
			declarationEntry({ ...row, exported: row.exported === null ? null : row.exported === 1 }),
		);
	}

	/** Other modules with a reference bound to a declaration this module holds. */
	boundInto(module: string): string[] {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT r.module FROM symbols s JOIN refs r ON r.targetId = s.symbolId
				 WHERE s.module = ? AND r.module <> ? ORDER BY r.module`,
			)
			.all(module, module) as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Adds a move to what the module's earlier writes left unasked. */
	private recordMove(module: string, change: SurfaceChange): void {
		const held = this.surfaceMovesOf([module]).get(module);
		const merged = (key: "gained" | "lost" | "boundInto" | "scopes") =>
			[...new Set([...(held?.[key] ?? []), ...change[key]])].sort();
		this.db
			.prepare(
				"INSERT OR REPLACE INTO surface_moves (module, gained, lost, boundInto, heldBefore, scopes) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				module,
				JSON.stringify(merged("gained")),
				JSON.stringify(merged("lost")),
				JSON.stringify(merged("boundInto")),
				held?.heldBefore === true || change.heldBefore ? 1 : 0,
				JSON.stringify(merged("scopes")),
			);
	}

	/** The moves writes left for `modules`, or for every module when null, still pending. */
	surfaceMovesOf(modules: readonly string[] | null): Map<string, SurfaceChange> {
		const columns = "SELECT module, gained, lost, boundInto, heldBefore, scopes FROM surface_moves";
		const rows = (
			modules === null
				? this.db.prepare(columns).all()
				: this.db
						.prepare(`${columns} WHERE module IN (SELECT value FROM json_each(?))`)
						.all(JSON.stringify(modules))
		) as Array<{
			module: string;
			gained: string;
			lost: string;
			boundInto: string;
			heldBefore: number;
			scopes: string;
		}>;
		return new Map(
			rows.map((row) => [
				row.module,
				{
					gained: JSON.parse(row.gained),
					lost: JSON.parse(row.lost),
					boundInto: JSON.parse(row.boundInto),
					heldBefore: row.heldBefore === 1,
					scopes: JSON.parse(row.scopes),
				},
			]),
		);
	}

	/**
	 * Writes the debt a road owes for moves it read, and acknowledges those moves, in one
	 * transaction, so a stop between the two leaves the move rather than losing both. A move a
	 * later write merged into since it was read stays pending.
	 */
	settleMoves(moves: ReadonlyMap<string, SurfaceChange>, owed: readonly string[]): void {
		const owe = this.db.prepare("INSERT OR IGNORE INTO rebind_owed (module) VALUES (?)");
		const acknowledge = this.db.prepare(
			`DELETE FROM surface_moves
			 WHERE module = ? AND gained = ? AND lost = ? AND boundInto = ? AND heldBefore = ? AND scopes = ?`,
		);
		this.inTransaction(() => {
			for (const module of owed) owe.run(module);
			for (const [module, change] of moves) {
				acknowledge.run(
					module,
					JSON.stringify(change.gained),
					JSON.stringify(change.lost),
					JSON.stringify(change.boundInto),
					change.heldBefore ? 1 : 0,
					JSON.stringify(change.scopes),
				);
			}
		});
	}

	////////////////////////////////
	//  Generations and projection

	/** The scope keys a module contributes to. */
	scopeKeysOf(module: string): string[] {
		const rows = this.db
			.prepare("SELECT scopeKey FROM scope_contributions WHERE module = ? ORDER BY scopeKey")
			.all(module) as Array<{ scopeKey: string }>;
		return rows.map((row) => row.scopeKey);
	}

	/**
	 * Advances the store-wide facts generation and every scope the module touched, owes its
	 * projection, and records as moved the scopes it left or joined, or every one it touched when
	 * its surface moved, all in the caller's transaction.
	 * `heldBefore`: the index held the module before this write.
	 */
	private advanceGenerations(
		module: string,
		scopesBefore: readonly string[],
		heldBefore: boolean,
		surfaceMoved: boolean,
	): void {
		const before = new Set(scopesBefore);
		const after = new Set(this.scopeKeysOf(module));
		const touched = [...new Set([...before, ...after])].sort();
		this.db
			.prepare(
				`INSERT INTO meta (key, value) VALUES ('factsGeneration', '1')
				 ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
			)
			.run();
		const bump = this.db.prepare(
			`INSERT INTO scope_generations (scopeKey, generation) VALUES (?, 1)
			 ON CONFLICT(scopeKey) DO UPDATE SET generation = generation + 1`,
		);
		for (const key of touched) bump.run(key);
		this.db
			.prepare(
				`INSERT INTO projection_debt (module, heldBefore) VALUES (?, ?)
				 ON CONFLICT(module) DO UPDATE SET heldBefore = MAX(heldBefore, excluded.heldBefore)`,
			)
			.run(module, heldBefore ? 1 : 0);
		// A forwarder from a touched scope reads its members; one landing on a module new to the index read none.
		this.oweForwarders(heldBefore ? null : module, touched);
		// A rewrite keeping its surface and its scopes moves nothing a scope's importer reads.
		const moved = surfaceMoved ? touched : touched.filter((key) => before.has(key) !== after.has(key));
		if (moved.length > 0) {
			this.recordMove(module, { gained: [], lost: [], boundInto: [], heldBefore, scopes: moved });
		}
	}

	/** Advanced by every fact admission, replacement and removal. */
	factsGeneration(): number {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = 'factsGeneration'").get() as
			| { value: string }
			| undefined;
		return row === undefined ? 0 : Number(row.value);
	}

	/** Advanced by every write a contributor to the scope makes. */
	scopeGeneration(key: string): number {
		const row = this.db.prepare("SELECT generation FROM scope_generations WHERE scopeKey = ?").get(key) as
			| { generation: number }
			| undefined;
		return row?.generation ?? 0;
	}

	fileOf(module: string): { exportsKnown: boolean; allList: AllList | null } | null {
		const row = this.db.prepare("SELECT exportsKnown, allList FROM files WHERE module = ?").get(module) as
			| { exportsKnown: number; allList: string | null }
			| undefined;
		if (row === undefined) return null;
		return { exportsKnown: row.exportsKnown === 1, allList: row.allList === null ? null : JSON.parse(row.allList) };
	}

	exportsIn(module: string): StoredExport[] {
		return this.db.prepare("SELECT * FROM exports WHERE module = ?").all(module).map(rowToExport);
	}

	/** Export edges whose target is this declaration, or whose name a module exposes it under. */
	exportsOf(symbolId: string): StoredExport[] {
		return this.db
			.prepare(
				`SELECT * FROM exports WHERE targetSymbolId = ?
				 UNION
				 SELECT e.* FROM exports e JOIN effective_exports x ON x.module = e.module AND x.name = e.name
				 WHERE x.originSymbolId = ?
				 ORDER BY module`,
			)
			.all(symbolId, symbolId)
			.map(rowToExport);
	}

	importEdgeAt(module: string, span: Range): StoredImport | null {
		const row = this.db
			.prepare(
				`SELECT * FROM imports WHERE module = ? AND spanStartLine = ? AND spanStartChar = ?
				 AND spanEndLine = ? AND spanEndChar = ?`,
			)
			.get(module, span.start.line, span.start.character, span.end.line, span.end.character);
		return row === undefined ? null : rowToImport(row);
	}

	exportedDeclarations(module: string): Array<{ symbolId: string; name: string }> {
		return this.db
			.prepare(
				`SELECT symbolId, name FROM symbols
				 WHERE module = ? AND containerId IS NULL AND visibility <> 'local' AND (exported IS NULL OR exported = 1)
				 ORDER BY startLine, startChar`,
			)
			.all(module) as Array<{ symbolId: string; name: string }>;
	}

	scopeMembers(landing: ScopeLanding): Array<{ symbolId: string; name: string }> | null {
		const key = scopeKey(landing);
		if (this.db.prepare("SELECT 1 FROM scope_contributions WHERE scopeKey = ? LIMIT 1").get(key) === undefined) {
			return null;
		}
		return this.db
			.prepare(
				`SELECT s.symbolId, s.name FROM scope_members m JOIN symbols s ON s.symbolId = m.memberId
				 WHERE m.scopeKey = ? ORDER BY s.module, s.startLine`,
			)
			.all(key) as Array<{ symbolId: string; name: string }>;
	}

	scopeExports(landing: ScopeLanding): Array<{ module: string; edge: StoredExport }> {
		return this.db
			.prepare(
				`SELECT e.* FROM exports e JOIN scope_contributions c ON c.module = e.module
				 WHERE c.scopeKey = ? AND json_extract(e.edge, '$.scopeId') = ? ORDER BY e.module`,
			)
			.all(scopeKey(landing), landing.scopeId)
			.map(rowToExport)
			.map((edge) => ({ module: edge.module, edge }));
	}

	/** The effective exports settlement last committed for a module. */
	effectiveExportsOf(module: string): EffectiveExport[] {
		const rows = this.db
			.prepare("SELECT name, meaning, origin, certainty FROM effective_exports WHERE module = ? ORDER BY rowid")
			.all(module) as Array<{ name: string | null; meaning: string | null; origin: string; certainty: string }>;
		return rows.map((row) => ({
			name: row.name,
			...(row.meaning === null ? {} : { meaning: JSON.parse(row.meaning) }),
			origin: JSON.parse(row.origin),
			certainty: JSON.parse(row.certainty),
		}));
	}

	nextProjectionDebt(): string | null {
		const row = this.db.prepare("SELECT module FROM projection_debt ORDER BY rowid LIMIT 1").get() as
			| { module: string }
			| undefined;
		return row?.module ?? null;
	}

	/**
	 * Commits one module's recomputed projection and clears its debt. When it moved, records the
	 * names gained and lost, and owes a projection to every module forwarding from it.
	 */
	commitProjection(module: string, rows: readonly EffectiveExport[]): boolean {
		return this.inTransaction(() => {
			const previous = this.effectiveExportsOf(module);
			const before = new Set(previous.map(canonical));
			const after = new Set(rows.map(canonical));
			const owed = this.db.prepare("SELECT heldBefore FROM projection_debt WHERE module = ?").get(module) as
				| { heldBefore: number }
				| undefined;
			this.db.prepare("DELETE FROM projection_debt WHERE module = ?").run(module);
			const moved = before.size !== after.size || [...after].some((key) => !before.has(key));
			if (!moved) return false;
			// A plan that read these exports read them as of the module's stamp.
			this.db.prepare("UPDATE files SET indexedAt = ? WHERE module = ?").run(this.nextStamp(), module);
			this.db.prepare("DELETE FROM effective_exports WHERE module = ?").run(module);
			const insert = this.db.prepare(
				"INSERT INTO effective_exports (module, name, meaning, origin, originSymbolId, certainty) VALUES (?, ?, ?, ?, ?, ?)",
			);
			for (const row of rows) {
				insert.run(
					module,
					row.name,
					row.meaning === undefined ? null : JSON.stringify(row.meaning),
					JSON.stringify(row.origin),
					row.origin.kind === "symbol" ? row.origin.symbolId : null,
					JSON.stringify(row.certainty),
				);
			}
			// Names whose rows the other side lacks.
			const fresh = (keys: ReadonlySet<string>, from: readonly EffectiveExport[]) =>
				[
					...new Set(
						from.flatMap((row) => (row.name !== null && !keys.has(canonical(row)) ? [row.name] : [])),
					),
				].sort();
			this.recordMove(module, {
				gained: fresh(before, rows),
				lost: fresh(after, previous),
				boundInto: [],
				heldBefore: owed === undefined || owed.heldBefore === 1,
				scopes: [],
			});
			this.oweForwarders(module);
			return true;
		});
	}

	/** Owes a projection to every module forwarding from an import landing on `module` or on one of `scopes`. */
	private oweForwarders(module: string | null, scopes: readonly string[] = []): void {
		const owe = this.db.prepare(
			"INSERT INTO projection_debt (module, heldBefore) VALUES (?, 1) ON CONFLICT(module) DO UPDATE SET heldBefore = 1",
		);
		for (const forwarder of this.forwardersOf(module, scopes)) owe.run(forwarder);
	}

	/** Modules whose export edges forward from an import landing on `module` or on one of `scopes`. */
	private forwardersOf(module: string | null, scopes: readonly string[]): string[] {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT i.module FROM imports i
				 JOIN exports e ON e.module = i.module AND e.targetKind = 'import'
				  AND json_extract(e.edge, '$.target.span.start.line') = i.spanStartLine
				  AND json_extract(e.edge, '$.target.span.start.character') = i.spanStartChar
				  AND json_extract(e.edge, '$.target.span.end.line') = i.spanEndLine
				  AND json_extract(e.edge, '$.target.span.end.character') = i.spanEndChar
				 WHERE i.target = ? OR i.targetScope IN (SELECT value FROM json_each(?))
				 ORDER BY i.module`,
			)
			.all(module, JSON.stringify(scopes)) as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Recomputes every owed projection to a fixpoint; answers the modules whose exports moved. */
	settleProjections(): string[] {
		return settleProjections(this);
	}

	/** Owes each module a parse for its bindings until one reading references is admitted. */
	oweRebinds(modules: readonly string[]): void {
		this.settleMoves(new Map(), modules);
	}

	/** The first payable owed module after `after` in module order, or null. */
	owedRebindAfter(after: string | null): string | null {
		const row = this.db
			.prepare("SELECT module FROM rebind_owed WHERE blockedBy IS NULL AND module > ? ORDER BY module LIMIT 1")
			.get(after ?? "") as { module: string } | undefined;
		return row?.module ?? null;
	}

	/** Holds a debt until `providerId` answers again, or `blockedIn` restarts, or the module's own parse lands. */
	blockRebind(module: string, providerId: string, blockedFor: "outage" | "refusal", blockedIn: string): void {
		this.db
			.prepare(
				`INSERT INTO rebind_owed (module, blockedBy, blockedFor, blockedIn) VALUES (?, ?, ?, ?)
				 ON CONFLICT (module) DO UPDATE SET blockedBy = excluded.blockedBy, blockedFor = excluded.blockedFor,
				 blockedIn = excluded.blockedIn`,
			)
			.run(module, providerId, blockedFor, blockedIn);
	}

	/** Debts held back by a failed parse, with who failed them and in which process. */
	blockedRebinds(): Array<{ module: string; blockedBy: string; blockedFor: string; blockedIn: string }> {
		return this.db
			.prepare("SELECT module, blockedBy, blockedFor, blockedIn FROM rebind_owed WHERE blockedBy IS NOT NULL")
			.all() as Array<{ module: string; blockedBy: string; blockedFor: string; blockedIn: string }>;
	}

	/** Which of these modules hold a debt their own refusal blocks. */
	refusalBlocked(modules: readonly string[]): string[] {
		const rows = this.db
			.prepare(
				`SELECT module FROM rebind_owed
				 WHERE blockedFor = 'refusal' AND module IN (SELECT value FROM json_each(?)) ORDER BY module`,
			)
			.all(JSON.stringify(modules)) as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Makes these held debts payable again. */
	unblockRebinds(modules: readonly string[]): void {
		const unblock = this.db.prepare(`${UNBLOCK} WHERE module = ?`);
		this.inTransaction(() => {
			for (const module of modules) unblock.run(module);
		});
	}

	/** Makes the debts one provider's outage held payable again, answering how many. */
	unblockOutages(providerId: string): number {
		return Number(
			this.db.prepare(`${UNBLOCK} WHERE blockedBy = ? AND blockedFor = 'outage'`).run(providerId).changes,
		);
	}

	/** Settles a debt nothing can pay: the module holds no facts to parse again. */
	clearRebind(module: string): void {
		this.db.prepare("DELETE FROM rebind_owed WHERE module = ?").run(module);
	}

	/** Modules with an import that landed on, or reaches through, one of `targets` when written, by target. */
	importersLandedOn(targets: readonly string[]): Array<{ module: string; target: string }> {
		if (targets.length === 0) return [];
		const listed = JSON.stringify(targets);
		return this.db
			.prepare(
				`SELECT DISTINCT module, target FROM imports WHERE target IN (SELECT value FROM json_each(?))
				 UNION SELECT DISTINCT module, surfaceTarget FROM imports WHERE surfaceTarget IN (SELECT value FROM json_each(?))
				 ORDER BY module`,
			)
			.all(listed, listed) as Array<{ module: string; target: string }>;
	}

	/** Modules with an import landing on one of these scopes, by scope. */
	importersOfScopes(keys: readonly string[]): Array<{ module: string; scope: string }> {
		if (keys.length === 0) return [];
		return this.db
			.prepare(
				`SELECT DISTINCT module, targetScope AS scope FROM imports
				 WHERE targetScope IN (SELECT value FROM json_each(?)) ORDER BY module`,
			)
			.all(JSON.stringify(keys)) as Array<{ module: string; scope: string }>;
	}

	/** Import edges that landed on `landing` when written: a module by its path, a scope by its key. */
	importEdgesLandingOn(landing: Landing): StoredImport[] {
		const order = "ORDER BY module, spanStartLine, spanStartChar";
		const rows =
			landing.kind === "module"
				? this.db.prepare(`SELECT * FROM imports WHERE target = ? ${order}`).all(landing.module)
				: this.db.prepare(`SELECT * FROM imports WHERE targetScope = ? ${order}`).all(scopeKey(landing));
		return rows.map(rowToImport);
	}

	/** Modules whose effective exports bind some name to this declaration. */
	modulesExposing(symbolId: string): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT module FROM effective_exports WHERE originSymbolId = ? ORDER BY module")
			.all(symbolId) as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** The scopes listing this declaration as a member. */
	scopesHolding(symbolId: string): ScopeLanding[] {
		const rows = this.db
			.prepare("SELECT DISTINCT scopeKey FROM scope_members WHERE memberId = ? ORDER BY scopeKey")
			.all(symbolId) as Array<{ scopeKey: string }>;
		return rows.map((row) => scopeOfKey(row.scopeKey));
	}

	/** Modules exposing `landing` under some name, as a namespace or a module value. */
	modulesHoldingNamespace(landing: Landing): string[] {
		const rows =
			landing.kind === "module"
				? this.db
						.prepare(
							`SELECT DISTINCT module FROM effective_exports
							 WHERE (json_extract(origin, '$.kind') = 'namespace' AND json_extract(origin, '$.landing.kind') = 'module'
							  AND json_extract(origin, '$.landing.module') = ?)
							 OR (json_extract(origin, '$.kind') = 'moduleValue' AND json_extract(origin, '$.module') = ?)
							 ORDER BY module`,
						)
						.all(landing.module, landing.module)
				: this.db
						.prepare(
							`SELECT DISTINCT module FROM effective_exports
							 WHERE json_extract(origin, '$.kind') = 'namespace' AND json_extract(origin, '$.landing.kind') = ?
							  AND json_extract(origin, '$.landing.providerId') = ? AND json_extract(origin, '$.landing.scopeId') = ?
							 ORDER BY module`,
						)
						.all(landing.kind, landing.providerId, landing.scopeId);
		return (rows as Array<{ module: string }>).map((row) => row.module);
	}

	/** Modules with an unbound reference spelled as one of `names`, by name. */
	modulesWithUnbound(names: readonly string[]): Array<{ module: string; name: string }> {
		if (names.length === 0) return [];
		return this.db
			.prepare(
				// The unary plus keeps the planner on refs_name: unbound rows are many, one name's are few.
				`SELECT DISTINCT module, name FROM refs
				 WHERE name IN (SELECT value FROM json_each(?)) AND +targetId IS NULL ORDER BY module`,
			)
			.all(JSON.stringify(names)) as Array<{ module: string; name: string }>;
	}

	/** Every import edge that states a load and lands on a module, in one read. */
	loadEdges(): Array<{
		module: string;
		target: string;
		span: Range;
		loads: "static" | "deferred";
		elided?: boolean;
		typeOnly: boolean;
	}> {
		const rows = this.db
			.prepare(
				`SELECT module, target, loads, elided, typeOnly, spanStartLine, spanStartChar, spanEndLine, spanEndChar
				 FROM imports WHERE target IS NOT NULL AND loads IS NOT NULL ORDER BY module`,
			)
			.all() as Array<{
			module: string;
			target: string;
			loads: "static" | "deferred";
			elided: number | null;
			typeOnly: number;
			spanStartLine: number;
			spanStartChar: number;
			spanEndLine: number;
			spanEndChar: number;
		}>;
		return rows.map((row) => ({
			module: row.module,
			target: row.target,
			span: {
				start: { line: row.spanStartLine, character: row.spanStartChar },
				end: { line: row.spanEndLine, character: row.spanEndChar },
			},
			loads: row.loads,
			...(row.elided === null ? {} : { elided: row.elided === 1 }),
			typeOnly: row.typeOnly === 1,
		}));
	}

	/** Each module's distinct import specifiers and modes, for asking where each lands. */
	importEdges(): Array<{ module: string; specifier: string; resolutionMode?: ResolutionMode }> {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT module, specifier, json_extract(edge, '$.resolutionMode') AS resolutionMode
				 FROM imports ORDER BY module, specifier`,
			)
			.all() as Array<{ module: string; specifier: string; resolutionMode: ResolutionMode | null }>;
		return rows.map(({ resolutionMode, ...row }) => (resolutionMode === null ? row : { ...row, resolutionMode }));
	}

	/** Everything a file contributed, gone. Used when a file is deleted rather than changed. */
	forgetFile(module: string): boolean {
		return this.inTransaction(() => {
			// Read while the rows it asks about still exist.
			const lost = namesOf(this.surfaceHeld(module));
			const boundInto = this.boundInto(module);
			const scopesBefore = this.scopeKeysOf(module);
			let removed = false;
			let held = false;
			for (const table of FACT_TABLES) {
				if (this.db.prepare(`DELETE FROM ${table} WHERE module = ?`).run(module).changes > 0) removed = true;
			}
			if (this.db.prepare("DELETE FROM files WHERE module = ?").run(module).changes > 0) held = true;
			if (this.db.prepare("DELETE FROM parse_failures WHERE module = ?").run(module).changes > 0) removed = true;
			// A module the index no longer holds owes nothing.
			this.db.prepare("DELETE FROM rebind_owed WHERE module = ?").run(module);
			if (removed || held) {
				this.recordMove(module, { gained: [], lost, boundInto, heldBefore: held, scopes: [] });
				this.advanceGenerations(module, scopesBefore, held, true);
				// What forwarded from it now lands on nothing the index holds.
				this.oweForwarders(module);
			}
			return removed || held;
		});
	}

	fileNotes(module: string): FileNotes {
		const file = this.db.prepare("SELECT indexedAt FROM files WHERE module = ?").get(module) as
			| { indexedAt: number }
			| undefined;
		if (file === undefined) return { module, known: false, reason: "notIndexed" };
		if (file.indexedAt < this.notesSince()) return { module, known: false, reason: "indexedBeforeNotes" };
		const rows = this.db
			.prepare(
				"SELECT severity, message, path, startLine, startChar, endLine, endChar FROM notes WHERE module = ? ORDER BY ordinal",
			)
			.all(module) as unknown as NoteRow[];
		return { module, known: true, notes: rows.map(rowToNote) };
	}

	private notesSince(): number {
		return Number(readMeta(this.db, NOTES_SINCE_KEY) ?? 0);
	}

	/** Files carrying notes, and files read before notes were kept. */
	noteTotals(): { noted: number; unknown: number } {
		const one = (sql: string, ...args: number[]) => (this.db.prepare(sql).get(...args) as { n: number }).n;
		return {
			noted: one("SELECT COUNT(DISTINCT module) AS n FROM notes"),
			unknown: one("SELECT COUNT(*) AS n FROM files WHERE indexedAt < ?", this.notesSince()),
		};
	}

	/** Fills a row written before content was recorded. A recorded class is never overwritten here. */
	recordContent(module: string, content: FileContent): void {
		this.db.prepare("UPDATE files SET content = ? WHERE module = ? AND content IS NULL").run(content, module);
	}

	/** Recorded module owners. */
	writers(): Map<string, string> {
		const rows = this.db.prepare("SELECT module, provider FROM files WHERE provider IS NOT NULL").all() as Array<{
			module: string;
			provider: string;
		}>;
		return new Map(rows.map((row) => [row.module, row.provider]));
	}

	/** Recorded provider id, if any. */
	writerOf(module: string): string | null {
		const row = this.db.prepare("SELECT provider FROM files WHERE module = ?").get(module) as
			| { provider: string | null }
			| undefined;
		return row?.provider ?? null;
	}

	/** The depth a module's stored facts were extracted at, or null when it is not indexed. */
	depthOf(module: string): IndexDepth | null {
		const row = this.db.prepare("SELECT depth FROM files WHERE module = ?").get(module) as
			| { depth: IndexDepth }
			| undefined;
		return row?.depth ?? null;
	}

	moduleRuntime(module: string): "esm" | "cjs" | null {
		const row = this.db.prepare("SELECT runtime FROM files WHERE module = ?").get(module) as
			| { runtime: "esm" | "cjs" | null }
			| undefined;
		return row?.runtime ?? null;
	}

	/** Each module's runtime, null where none was reported, in one read. */
	runtimesOf(modules: readonly string[]): Map<string, "esm" | "cjs" | null> {
		const rows = this.db
			.prepare("SELECT module, runtime FROM files WHERE module IN (SELECT value FROM json_each(?))")
			.all(JSON.stringify(modules)) as Array<{ module: string; runtime: "esm" | "cjs" | null }>;
		return new Map(rows.map((row) => [row.module, row.runtime]));
	}

	/**
	 * How many uses in `modules` each import edge carries, bound or not, by module and edge span, in
	 * one read. Roles in `skip` are left out.
	 */
	importUseCounts(
		modules: readonly string[],
		skip: readonly ReferenceRole[],
	): Array<{ module: string; origin: Range; count: number }> {
		const rows = this.db
			.prepare(
				`SELECT module, originStartLine, originStartChar, originEndLine, originEndChar, COUNT(*) AS count
				 FROM refs r WHERE r.module IN (SELECT value FROM json_each(?)) AND r.originKind = 'import' AND ${useSql("r")}
				 AND r.role NOT IN (SELECT value FROM json_each(?))
				 GROUP BY module, originStartLine, originStartChar, originEndLine, originEndChar
				 ORDER BY module, originStartLine, originStartChar`,
			)
			.all(JSON.stringify(modules), JSON.stringify(skip)) as Array<{
			module: string;
			originStartLine: number;
			originStartChar: number;
			originEndLine: number;
			originEndChar: number;
			count: number;
		}>;
		return rows.map((row) => ({
			module: row.module,
			origin: {
				start: { line: row.originStartLine, character: row.originStartChar },
				end: { line: row.originEndLine, character: row.originEndChar },
			},
			count: row.count,
		}));
	}

	/** The first `limit` uses in `module` through the import edge spanning `origin`, roles in `skip` aside. */
	importUsesThrough(
		module: string,
		origin: Range,
		skip: readonly ReferenceRole[],
		limit: number,
	): Array<{ name: string; range: Range }> {
		const rows = this.db
			.prepare(
				`SELECT name, startLine, startChar, endLine, endChar FROM refs r
				 WHERE r.module = ? AND r.originKind = 'import' AND ${useSql("r")}
				 AND r.originStartLine = ? AND r.originStartChar = ? AND r.originEndLine = ? AND r.originEndChar = ?
				 AND r.role NOT IN (SELECT value FROM json_each(?))
				 ORDER BY startLine, startChar LIMIT ?`,
			)
			.all(
				module,
				origin.start.line,
				origin.start.character,
				origin.end.line,
				origin.end.character,
				JSON.stringify(skip),
				limit,
			) as Array<{ name: string; startLine: number; startChar: number; endLine: number; endChar: number }>;
		return rows.map((row) => ({
			name: row.name,
			range: {
				start: { line: row.startLine, character: row.startChar },
				end: { line: row.endLine, character: row.endChar },
			},
		}));
	}

	/** Null means no role was reported. */
	roleOf(module: string): FileRole | null {
		const row = this.db
			.prepare("SELECT role, roleHow, roleSymbolId, roleReason FROM files WHERE module = ?")
			.get(module) as RoleRow | undefined;
		return row === undefined ? null : roleFromRow(row);
	}

	/**
	 * Entry files in scope, capped by `limit`. Null means no role was reported.
	 */
	entryPoints(include: (module: string) => boolean, limit: number): { entries: EntryPoint[]; more: number } | null {
		const rows = this.db
			.prepare(
				"SELECT module, role, roleHow, roleSymbolId, roleReason FROM files WHERE role IS NOT NULL ORDER BY module",
			)
			.iterate() as Iterable<RoleRow & { module: string }>;
		let reported = false;
		let more = 0;
		const entries: EntryPoint[] = [];
		for (const row of rows) {
			if (!include(row.module)) continue;
			const role = roleFromRow(row);
			if (role === null) continue;
			reported = true;
			if (role.kind !== "entry") continue;
			if (entries.length === limit) {
				more++;
				continue;
			}
			entries.push(
				role.how === "main"
					? { module: row.module, how: role.how, symbolId: role.symbolId }
					: { module: row.module, how: role.how },
			);
		}
		return reported ? { entries, more } : null;
	}

	/** What a module's rows were committed as, or null when it is not indexed. */
	stampOf(module: string): FactsStamp | null {
		const row = this.db.prepare("SELECT depth, indexedAt FROM files WHERE module = ?").get(module) as
			| FactsStamp
			| undefined;
		return row ?? null;
	}

	/** Modules still owing a full pass, in module order for deterministic upgrades. */
	outlineModules(): string[] {
		return (
			this.db.prepare("SELECT module FROM files WHERE depth = 'outline' ORDER BY module").all() as Array<{
				module: string;
			}>
		).map((row) => row.module);
	}

	/** How many stored files hold facts at each depth, for coverage reporting. */
	depthTotals(): { full: number; surface: number; outline: number } {
		const rows = this.db.prepare("SELECT depth, COUNT(*) AS n FROM files GROUP BY depth").all() as Array<{
			depth: string;
			n: number;
		}>;
		const totals = { full: 0, surface: 0, outline: 0 };
		for (const row of rows) {
			if (row.depth === "full" || row.depth === "surface" || row.depth === "outline") totals[row.depth] = row.n;
		}
		return totals;
	}

	/** Remembers a parse failure so coverage can name it after this process is gone. */
	recordFailure(module: string, reason: string): void {
		this.db
			.prepare("INSERT OR REPLACE INTO parse_failures (module, reason, failedAt) VALUES (?, ?, ?)")
			.run(module, reason, this.clock.now());
	}

	clearFailure(module: string): void {
		this.db.prepare("DELETE FROM parse_failures WHERE module = ?").run(module);
	}

	parseFailureCount(): number {
		return (this.db.prepare("SELECT COUNT(*) AS n FROM parse_failures").get() as { n: number }).n;
	}

	/** By path, so a sample and the full list agree on order. */
	parseFailures(limit?: number): Array<{ module: string; reason: string }> {
		const rows =
			limit === undefined
				? this.db.prepare("SELECT module, reason FROM parse_failures ORDER BY module").all()
				: this.db.prepare("SELECT module, reason FROM parse_failures ORDER BY module LIMIT ?").all(limit);
		return rows as Array<{ module: string; reason: string }>;
	}

	parseFailureOf(module: string): { module: string; reason: string } | null {
		const row = this.db.prepare("SELECT module, reason FROM parse_failures WHERE module = ?").get(module) as
			| { module: string; reason: string }
			| undefined;
		return row ?? null;
	}

	/** The project fingerprint a provider's stored facts were parsed under; null when it gave none. */
	projectFingerprint(providerId: string): string | null {
		return readMeta(this.db, `${PROJECT_FINGERPRINT_KEY}:${providerId}`);
	}

	recordProjectFingerprint(providerId: string, fingerprint: string): void {
		writeMeta(this.db, `${PROJECT_FINGERPRINT_KEY}:${providerId}`, fingerprint);
	}

	/** Persists scan counts used to explain coverage gaps. */
	writeScanSummary(summary: ScanCounts): void {
		writeMeta(this.db, SCAN_SUMMARY_KEY, JSON.stringify({ ...summary, at: this.clock.now() }));
	}

	/** One bounded sweep, one transaction, resuming from the cursor the last one persisted. */
	sweepSubjects(batch: number, pass: SweepPass, now: number): SweepReport {
		const report = this.inTransaction(() => {
			const { report, cursor } = this.subjects.sweepSubjects(batch, pass, now, readSweepCursor(this.db));
			writeMeta(this.db, SWEEP_CURSOR_KEY, JSON.stringify(cursor));
			return report;
		});
		return report;
	}

	readScanSummary(): (ScanCounts & { at: number }) | null {
		const raw = readMeta(this.db, SCAN_SUMMARY_KEY);
		if (raw === null) return null;
		try {
			const parsed = JSON.parse(raw) as Partial<ScanCounts> & { at?: number };
			// Every part or none. A defaulted field would print arithmetic that does not sum.
			const parts = [parsed.tracked, parsed.claimed, parsed.unclaimed, parsed.generated, parsed.denied];
			if (parts.some((part) => typeof part !== "number")) return null;
			return {
				tracked: parsed.tracked as number,
				claimed: parsed.claimed as number,
				unclaimed: parsed.unclaimed as number,
				generated: parsed.generated as number,
				denied: parsed.denied as number,
				outlined: parsed.outlined === true,
				...(sweepReportOf(parsed.knowledgeSweep) === null
					? {}
					: { knowledgeSweep: sweepReportOf(parsed.knowledgeSweep) as SweepReport }),
				at: parsed.at ?? 0,
			};
		} catch {
			return null;
		}
	}

	////////////////////////////////
	//  Refactor journal
	//
	// Rows only. Everything that decides what they MEAN lives in TransactionManager, which a
	// residue test holds as the single owner of the concept.

	/** Runs a journal read in a store-owned transaction. */
	journalRead<T>(work: (db: DatabaseSync) => T): T {
		return this.inTransaction(() => work(this.db));
	}

	/** Runs a journal write in a store-owned transaction. */
	journalWrite<T>(work: (db: DatabaseSync) => T): T {
		return this.inTransaction(() => work(this.db));
	}

	/** Legacy fixture access. Production code uses journalRead or journalWrite. */
	journal<T>(work: (db: DatabaseSync) => T): T {
		return this.journalRead(work);
	}

	/** Content addressed, so re-snapshotting an unchanged file costs a lookup and no bytes. */
	putBlob(hash: string, bytes: Uint8Array): void {
		this.db.prepare("INSERT OR IGNORE INTO refactor_blobs (hash, bytes) VALUES (?, ?)").run(hash, bytes);
	}

	blob(hash: string): Uint8Array | null {
		const row = this.db.prepare("SELECT bytes FROM refactor_blobs WHERE hash = ?").get(hash) as
			| { bytes: Uint8Array }
			| undefined;
		return row?.bytes ?? null;
	}

	/** Prunes unreferenced blobs after settlement. */
	pruneBlobs(): number {
		const result = this.db.prepare(`DELETE FROM refactor_blobs WHERE hash NOT IN (${keptBlobs()})`).run();
		return Number(result.changes);
	}

	/** Ledger identity survives store rebuilds. */
	refactorLedgerId(): string {
		const id = readMeta(this.db, LEDGER_KEY);
		if (id === null) throw new Error("the store has no settlement ledger id");
		return id;
	}

	/**
	 * The fact one id names, or null when it names nothing any more.
	 *
	 * Null IS the staleness signal. A fact id is a digest of the fact's own contents, so an id that
	 * no longer resolves is exactly a fact that changed or vanished, and a citation holder needs no
	 * second hash to compare.
	 */
	factById(factId: string): StoredFact | null {
		const parsed = parseFactId(factId);
		if (parsed === null) return null;

		// The id carries its kind, so this reads one table rather than searching every one.
		switch (parsed.kind) {
			case "declaration": {
				const row = this.db.prepare("SELECT * FROM symbols WHERE factId = ?").get(factId);
				return row ? { fact: "declaration", ...rowToDeclaration(row) } : null;
			}
			case "reference": {
				const row = this.db.prepare("SELECT * FROM refs WHERE factId = ?").get(factId);
				return row ? { fact: "reference", ...rowToReference(row) } : null;
			}
			case "import": {
				const row = this.db.prepare("SELECT * FROM imports WHERE factId = ?").get(factId);
				return row ? { fact: "import", ...rowToImport(row) } : null;
			}
			case "export": {
				const row = this.db.prepare("SELECT * FROM exports WHERE factId = ?").get(factId);
				return row ? { fact: "export", ...rowToExport(row) } : null;
			}
			case "literal": {
				const row = this.db.prepare("SELECT * FROM literals WHERE factId = ?").get(factId);
				return row ? { fact: "literal", ...rowToLiteral(row) } : null;
			}
			case "comment": {
				const row = this.db.prepare("SELECT * FROM comments WHERE factId = ?").get(factId);
				return row ? { fact: "comment", ...rowToComment(row) } : null;
			}
			case "doc": {
				const row = this.db.prepare("SELECT * FROM docs WHERE factId = ?").get(factId);
				return row ? { fact: "doc", ...rowToDoc(row) } : null;
			}
			default: {
				const unreachable: never = parsed.kind;
				return unreachable;
			}
		}
	}

	////////////////////////////////
	//  Knowledge

	/** Knowledge-changing write count. */
	knowledgeGeneration(): number {
		return this.knowledgeTurns;
	}

	/** A declaration's pattern digest and what it covers, or null before a full parse minted one. */
	patternDigestOf(symbolId: string): { digest: string; coverage: string } | null {
		const row = this.db
			.prepare("SELECT patternDigest, patternCoverage FROM symbols WHERE symbolId = ?")
			.get(symbolId) as { patternDigest: string | null; patternCoverage: string | null } | undefined;
		if (row === undefined || row.patternDigest === null || row.patternCoverage === null) return null;
		return { digest: row.patternDigest, coverage: row.patternCoverage };
	}

	/** Every symbol id the index holds for one module, which is the subtree a rename re-mints. */
	symbolIdsIn(module: string): string[] {
		const rows = this.db.prepare("SELECT symbolId FROM symbols WHERE module = ?").all(module) as Array<{
			symbolId: string;
		}>;
		return rows.map((row) => row.symbolId);
	}

	////////////////////////////////
	//  Reading

	contentHashOf(module: string): string | null {
		const row = this.db.prepare("SELECT contentHash FROM files WHERE module = ?").get(module) as
			| { contentHash: string }
			| undefined;
		return row?.contentHash ?? null;
	}

	newestIndexedAt(): number | null {
		const row = this.db.prepare("SELECT indexedAt FROM files ORDER BY indexedAt DESC LIMIT 1").get() as
			| { indexedAt: number }
			| undefined;
		return row?.indexedAt ?? null;
	}

	declaration(symbolId: string): StoredDeclaration | null {
		const row = this.db.prepare("SELECT * FROM symbols WHERE symbolId = ?").get(symbolId) as
			| Record<string, unknown>
			| undefined;
		return row ? rowToDeclaration(row) : null;
	}

	declarationsIn(module: string): StoredDeclaration[] {
		const rows = this.db
			.prepare("SELECT * FROM symbols WHERE module = ? ORDER BY startLine, startChar")
			.all(module);
		return rows.map(rowToDeclaration);
	}

	/** Mentions included; see usesTo. */
	referencesTo(symbolId: string): StoredReference[] {
		const rows = this.db
			.prepare("SELECT * FROM refs WHERE targetId = ? ORDER BY module, startLine, startChar")
			.all(symbolId);
		return rows.map(rowToReference);
	}

	/** Why the storage exists. */
	usesTo(symbolId: string): StoredReference[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM refs r WHERE r.targetId = ? AND ${useSql("r")} ORDER BY module, startLine, startChar`,
			)
			.all(symbolId);
		return rows.map(rowToReference);
	}

	/** Use counts per declaration, in one read; unused is absent. */
	useCountsIn(module: string): Map<string, number> {
		const rows = this.db
			.prepare(
				`SELECT r.targetId AS symbolId, COUNT(*) AS n FROM refs r
				 WHERE r.targetId IN (SELECT symbolId FROM symbols WHERE module = ?) AND ${useSql("r")}
				 GROUP BY r.targetId`,
			)
			.all(module) as Array<{ symbolId: string; n: number }>;
		return new Map(rows.map((row) => [row.symbolId, row.n]));
	}

	/** Distinct using declarations per symbol; top-level uses count their module, and unused symbols are absent. */
	holderCounts(symbolIds: readonly string[]): Map<string, number> {
		if (symbolIds.length === 0) return new Map();
		const rows = this.db
			.prepare(
				`SELECT r.targetId AS symbolId, COUNT(DISTINCT COALESCE(r.fromId, 'module ' || r.module)) AS n
				 FROM refs r WHERE r.targetId IN (SELECT value FROM json_each(?)) AND ${useSql("r")}
				 GROUP BY r.targetId`,
			)
			.all(JSON.stringify(symbolIds)) as Array<{ symbolId: string; n: number }>;
		return new Map(rows.map((row) => [row.symbolId, row.n]));
	}

	/** Whether a module's path reads as a test, by the rule name searches rank with. */
	testModule(module: string): boolean {
		const row = this.db.prepare(`SELECT ${TEST_PATH} AS test FROM (SELECT ? AS module)`).get(module) as {
			test: number;
		};
		return row.test === 1;
	}

	/** Each other module using something `module` declares, with up to three of those, `except` aside. */
	usesInto(module: string, except: string): Map<string, string[]> {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT r.module AS module, r.targetId AS targetId FROM refs r
				 JOIN symbols s ON s.symbolId = r.targetId
				 WHERE s.module = ? AND r.module <> ? AND r.targetId <> ? AND ${useSql("r")}
				 ORDER BY r.module, r.targetId`,
			)
			.all(module, module, except) as Array<{ module: string; targetId: string }>;
		const byModule = new Map<string, string[]>();
		for (const row of rows) {
			const held = byModule.get(row.module) ?? [];
			if (held.length < 3) held.push(row.targetId);
			byModule.set(row.module, held);
		}
		return byModule;
	}

	/** Whether `module` uses the symbol. */
	moduleUses(module: string, symbolId: string): boolean {
		return (
			this.db
				.prepare(`SELECT 1 FROM refs r WHERE r.module = ? AND r.targetId = ? AND ${useSql("r")} LIMIT 1`)
				.get(module, symbolId) !== undefined
		);
	}

	/** Use counts for a symbol, grouped by module. */
	usingModules(symbolId: string): Map<string, number> {
		const rows = this.db
			.prepare(
				`SELECT r.module AS module, COUNT(*) AS n FROM refs r WHERE r.targetId = ? AND ${useSql("r")}
				 GROUP BY r.module`,
			)
			.all(symbolId) as Array<{ module: string; n: number }>;
		return new Map(rows.map((row) => [row.module, row.n]));
	}

	/** Distinct resolved import targets for a module. */
	importTargets(module: string): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT target FROM imports WHERE module = ? AND target IS NOT NULL ORDER BY target")
			.all(module) as Array<{ target: string }>;
		return rows.map((row) => row.target);
	}

	/** Modules with at least one declaration marked exported by its provider. */
	exportingModules(): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT module FROM symbols WHERE exported = 1 ORDER BY module")
			.all() as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Mentions included; see usesIn. */
	referencesIn(module: string): StoredReference[] {
		const rows = this.db.prepare("SELECT * FROM refs WHERE module = ? ORDER BY startLine, startChar").all(module);
		return rows.map(rowToReference);
	}

	/** Includes unbound rows too. */
	usesIn(module: string): StoredReference[] {
		const rows = this.db
			.prepare(`SELECT * FROM refs r WHERE r.module = ? AND ${useSql("r")} ORDER BY startLine, startChar`)
			.all(module);
		return rows.map(rowToReference);
	}

	/**
	 * Occurrences spelled like this that did NOT bind to the given symbol.
	 *
	 * The set a rename has to worry about. Some are genuinely other symbols and some are uses of
	 * this one that binding could not follow, and nothing here can tell those apart, which is
	 * precisely why they are returned rather than filtered away.
	 */
	referencesSpelled(name: string, excludingTarget: string): StoredReference[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM refs WHERE name = ? AND (targetId IS NULL OR targetId != ?) ORDER BY module, startLine",
			)
			.all(name, excludingTarget);
		return rows.map(rowToReference);
	}

	/**
	 * Every import that writes this name, anywhere in the workspace.
	 *
	 * Returned unresolved. Whether one of these refers to a particular symbol depends on where its
	 * specifier lands, which only a provider can say, and asking about every import in the workspace
	 * to answer about one symbol would be the wrong trade.
	 */
	importsNamed(name: string): StoredImport[] {
		const rows = this.db.prepare("SELECT * FROM imports WHERE name = ? ORDER BY module, startLine").all(name);
		return rows.map(rowToImport);
	}

	/**
	 * Imports that BIND this name in the importing file, which is not the same question as `importsNamed`.
	 *
	 * `import { a as bar }` is named `a` and binds `bar`. A collision check cares about what the file
	 * calls it, and a rename of the source symbol cares about what the source module calls it, so the
	 * two questions read the same table through different columns.
	 */
	importsBinding(localName: string): StoredImport[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM imports
				 WHERE bindsLocally = 1 AND (localName = ? OR (localName IS NULL AND name = ?))
				 ORDER BY module, spanStartLine`,
			)
			.all(localName, localName);
		return rows.map(rowToImport);
	}

	importsIn(module: string): StoredImport[] {
		const rows = this.db
			.prepare("SELECT * FROM imports WHERE module = ? ORDER BY spanStartLine, spanStartChar")
			.all(module);
		return rows.map(rowToImport);
	}

	/** Each module whose effective exports name `name`, with what it binds to there. */
	exposuresNamed(name: string): Array<{ module: string; originSymbolId: string | null }> {
		return this.db
			.prepare("SELECT module, originSymbolId FROM effective_exports WHERE name = ? ORDER BY module")
			.all(name) as Array<{ module: string; originSymbolId: string | null }>;
	}

	/** Where `specifier` landed from `module` in `mode` when it was written; null when unknown. */
	importLanding(module: string, specifier: string, mode: ResolutionMode | undefined): Landing | null {
		const row = this.db
			.prepare(
				`SELECT landing FROM imports WHERE module = ? AND specifier = ?
				 AND json_extract(edge, '$.resolutionMode') IS ? AND landing IS NOT NULL LIMIT 1`,
			)
			.get(module, specifier, mode ?? null) as { landing: string } | undefined;
		return row === undefined ? null : (JSON.parse(row.landing) as Landing);
	}

	/**
	 * The declaration `name` means in `module`, through its effective exports. Null when nothing
	 * exports it, or it names a namespace or a module value.
	 */
	exportedSymbol(module: string, name: string): string | null {
		const row = this.db
			.prepare(
				`SELECT originSymbolId FROM effective_exports
				 WHERE module = ? AND name = ? AND originSymbolId IS NOT NULL ORDER BY rowid LIMIT 1`,
			)
			.get(module, name) as { originSymbolId: string } | undefined;
		return row?.originSymbolId ?? null;
	}

	/** Import rows for bounded application-side searches. */
	importsForScan(scanLimit: number, hidden: HiddenModules): StoredImport[] {
		const { clause, values } = importWhere(hidden);
		const rows = this.db
			.prepare(`SELECT * FROM imports ${clause} ORDER BY module, startLine LIMIT ?`)
			.all(...values, scanLimit);
		return rows.map(rowToImport);
	}

	/** Search declarations by name substring or regular expression. */
	searchSymbols(
		text: string | undefined,
		options: {
			regex?: string | undefined;
			kind?: string;
			module?: string;
			limit: number;
			scope?: ScopeFilter;
			hidden: HiddenModules;
		},
	): StoredDeclaration[] {
		const regex = options.regex === undefined ? undefined : compileSearchRegex(options.regex);
		const clauses: string[] = [];
		const values: Array<string | number> = [];
		leaveOut(options.hidden, clauses, values);
		if (text !== undefined) {
			clauses.push("name LIKE ? ESCAPE '\\'");
			values.push(`%${likePattern(text)}%`);
		}
		if (options.kind !== undefined) {
			clauses.push("kind = ?");
			values.push(options.kind);
		}
		if (options.module !== undefined) under("module", options.module, clauses, values);
		if (options.scope?.module !== undefined) {
			clauses.push("symbolId >= ? AND symbolId < ?");
			values.push(options.scope.low as string, options.scope.high as string);
		}
		if (options.scope?.like !== undefined) {
			clauses.push("symbolId LIKE ? ESCAPE '\\'");
			values.push(`${options.scope.head}%${likePattern(options.scope.like)}%`);
		}
		if (clauses.length === 0) clauses.push("1 = 1");
		// A scoped read is bounded even under a regex: the exact check runs after it and says so.
		const bounded = regex === undefined || options.scope !== undefined;
		const limit = bounded ? " LIMIT ?" : "";
		if (bounded) values.push(options.limit);

		const rows = this.db
			.prepare(`SELECT * FROM symbols WHERE ${clauses.join(" AND ")} ORDER BY module, startLine${limit}`)
			.all(...values)
			.map(rowToDeclaration);
		if (regex === undefined) return rows;

		return rows.filter((row) => regex.test(row.name)).slice(0, options.limit);
	}

	/** Declarations whose name contains `text`, any case: own code, then top-level, then exact names, then
	 * prefixes, then shortest. */
	symbolsNamedLike(text: string, limit: number, offset = 0, kinds?: readonly string[]): StoredDeclaration[] {
		const kindClause = kinds === undefined ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
		const escaped = likePattern(text);
		return this.db
			.prepare(
				`SELECT * FROM symbols WHERE name LIKE ? ESCAPE '\\'${kindClause}
				 ORDER BY ${VENDOR_PATH} ASC, (containerId IS NULL) DESC, (name = ? COLLATE NOCASE) DESC,
				 (name LIKE ? ESCAPE '\\') DESC, ${TEST_PATH} ASC, length(name), module, startLine
				 LIMIT ? OFFSET ?`,
			)
			.all(`%${escaped}%`, ...(kinds ?? []), text, `${escaped}%`, limit, offset)
			.map(rowToDeclaration);
	}

	/** Indexed files whose path contains `text`, any case: own code, then a name starting with it, then shortest. */
	filesNamedLike(text: string, limit: number): string[] {
		const escaped = likePattern(text);
		// The directory part is what rtrim leaves once every character but '/' is trimmed away.
		const rows = this.db
			.prepare(
				`SELECT module FROM files WHERE module LIKE ? ESCAPE '\\'
				 ORDER BY ${VENDOR_PATH} ASC, (substr(module, length(rtrim(module, replace(module, '/', ''))) + 1) LIKE ? ESCAPE '\\') DESC,
				 ${TEST_PATH} ASC, length(module), module LIMIT ?`,
			)
			.all(`%${escaped}%`, `${escaped}%`, limit) as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Imports whose specifier contains this text. "Which files import X", by the name as written. */
	importsMatching(specifier: string, limit: number, hidden: HiddenModules): StoredImport[] {
		const { clause, values } = importWhere(hidden, specifier);
		const rows = this.db
			.prepare(`SELECT * FROM imports ${clause} ORDER BY module, startLine LIMIT ?`)
			.all(...values, limit);
		return rows.map(rowToImport);
	}

	/** Every module held by the index, including files with no declarations. */
	indexedFiles(): string[] {
		const rows = this.db.prepare("SELECT module FROM files ORDER BY module").all() as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Modules `exclude` hides, for this hold's searches. */
	hiddenModules(exclude: ModuleExclusion | undefined): HiddenModules {
		if (exclude === undefined) return HiddenModules.none;
		return this.indexedFiles().filter(compileExclusion(exclude)) as readonly string[] as HiddenModules;
	}

	/** Every module with facts, ordered by symbol count. Content is null on a row written before it was kept. */
	moduleSummary(): Array<{ module: string; symbols: number; content: FileContent | null }> {
		return this.db
			.prepare(
				`SELECT s.module AS module, COUNT(*) AS symbols, f.content AS content
				 FROM symbols s LEFT JOIN files f ON f.module = s.module
				 GROUP BY s.module ORDER BY symbols DESC`,
			)
			.all() as Array<{ module: string; symbols: number; content: FileContent | null }>;
	}

	/** Files and symbols per content class, over the modules a live workspace predicate admits. */
	contentTotals(includeModule: (module: string) => boolean): ContentTotals {
		const rows = this.db
			.prepare(
				`SELECT f.module AS module, f.content AS content, COUNT(s.symbolId) AS symbols
				 FROM files f LEFT JOIN symbols s ON s.module = f.module
				 GROUP BY f.module`,
			)
			.all() as Array<{ module: string; content: FileContent | null; symbols: number }>;
		const files: ContentCounts = { code: 0, data: 0, document: 0, text: 0, unknown: 0 };
		const symbols: ContentCounts = { code: 0, data: 0, document: 0, text: 0, unknown: 0 };
		for (const row of rows) {
			if (!includeModule(row.module)) continue;
			const key = row.content ?? "unknown";
			files[key] += 1;
			symbols[key] += row.symbols;
		}
		return { files, symbols };
	}

	/** Counts for an overview, in one round trip rather than five. */
	totals(): { files: number; symbols: number; references: number; imports: number; literals: number } {
		const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
		return {
			files: one("SELECT COUNT(*) AS n FROM files"),
			symbols: one("SELECT COUNT(*) AS n FROM symbols"),
			references: one("SELECT COUNT(*) AS n FROM refs"),
			imports: one("SELECT COUNT(*) AS n FROM imports"),
			literals: one("SELECT COUNT(*) AS n FROM literals"),
		};
	}

	/**
	 * The symbol count split by kind, so one total cannot mean two things.
	 *
	 * A document's headings and keys are symbols and belong in the count, but a reader taking that
	 * count for callable code is reading it wrong once any document is indexed. Split rather than
	 * filtered, because which kinds are code is the caller's question and not this table's.
	 */
	symbolsByKind(): Record<string, number> {
		const rows = this.db.prepare("SELECT kind, COUNT(*) AS n FROM symbols GROUP BY kind").all() as Array<{
			kind: string;
			n: number;
		}>;
		return Object.fromEntries(rows.map((row) => [row.kind, row.n]));
	}

	/** Counts facts whose modules satisfy a live workspace predicate. */
	totalsForModules(includeModule: (module: string) => boolean): {
		files: number;
		symbols: number;
		references: number;
		imports: number;
		literals: number;
	} {
		const count = (table: "files" | (typeof FACT_TABLES)[number]): number => {
			const rows = this.db.prepare(`SELECT module, COUNT(*) AS n FROM ${table} GROUP BY module`).all() as Array<{
				module: string;
				n: number;
			}>;
			return rows.reduce((total, row) => (includeModule(row.module) ? total + row.n : total), 0);
		};
		return {
			files: count("files"),
			symbols: count("symbols"),
			references: count("refs"),
			imports: count("imports"),
			literals: count("literals"),
		};
	}

	/** Every symbol with a given name, across the workspace. The entry point for a name-only ask. */
	declarationsNamed(name: string): StoredDeclaration[] {
		const rows = this.db.prepare("SELECT * FROM symbols WHERE name = ? ORDER BY module, startLine").all(name);
		return rows.map(rowToDeclaration);
	}

	////////////////////////////////
	//  Literals

	literalsWhere(filter: LiteralFilter, limit: number): StoredLiteral[] {
		const { clause, values, join } = literalWhere(filter);
		const rows = this.db
			.prepare(
				`SELECT l.*, s.name AS containerName, s.kind AS containerKind FROM literals l ${join} ${clause} ORDER BY l.module, l.startLine LIMIT ?`,
			)
			.all(...values, limit);
		return rows.map(rowToLiteral);
	}

	countLiteralsWhere(filter: LiteralFilter): number {
		const { clause, values, join } = literalWhere(filter);
		return (
			this.db.prepare(`SELECT COUNT(*) AS n FROM literals l ${join} ${clause}`).get(...values) as { n: number }
		).n;
	}

	/** Every literal in one module, matching declarationsIn and referencesIn. */
	literalsIn(module: string): StoredLiteral[] {
		const rows = this.db
			.prepare("SELECT * FROM literals WHERE module = ? ORDER BY startLine, startChar")
			.all(module);
		return rows.map(rowToLiteral);
	}

	////////////////////////////////
	//  Comments

	/** Substring over the NORMALIZED text, so a phrase the writer wrapped still matches. */
	commentsContaining(text: string, limit: number, filter: CommentFilter): StoredComment[] {
		const { clause, values } = commentWhere(filter, text);
		const rows = this.db.prepare(`SELECT * FROM comments ${clause} ${COMMENT_ORDER} LIMIT ?`).all(...values, limit);
		return rows.map(rowToComment);
	}

	/** The true count, so a page never reports its own cap as a total. */
	countCommentsContaining(text: string, filter: CommentFilter): number {
		const { clause, values } = commentWhere(filter, text);
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM comments ${clause}`).get(...values) as { n: number }).n;
	}

	/** Every comment a caller must match itself, for the same reason literals need one: no REGEXP. */
	commentsToScan(scanLimit: number, filter: CommentFilter): StoredComment[] {
		const { clause, values } = commentWhere(filter);
		const rows = this.db
			.prepare(`SELECT * FROM comments ${clause} ${COMMENT_ORDER} LIMIT ?`)
			.all(...values, scanLimit);
		return rows.map(rowToComment);
	}

	countComments(filter: CommentFilter): number {
		const { clause, values } = commentWhere(filter);
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM comments ${clause}`).get(...values) as { n: number }).n;
	}

	/** What is written about one symbol, which is how describe gets its documentation. */
	commentsAnchoredTo(symbolId: string): StoredComment[] {
		const rows = this.db
			.prepare("SELECT * FROM comments WHERE anchorId = ? ORDER BY startLine, startChar")
			.all(symbolId);
		return rows.map(rowToComment);
	}

	/** Every comment in one module, matching declarationsIn and referencesIn. */
	commentsIn(module: string): StoredComment[] {
		const rows = this.db
			.prepare("SELECT * FROM comments WHERE module = ? ORDER BY startLine, startChar")
			.all(module);
		return rows.map(rowToComment);
	}

	////////////////////////////////
	//  Documents

	docsContaining(text: string, limit: number, filter: DocFilter): StoredDoc[] {
		const { clause, values } = docWhere(filter, text);
		const rows = this.db.prepare(`SELECT * FROM docs ${clause} ${DOC_ORDER} LIMIT ?`).all(...values, limit);
		return rows.map(rowToDoc);
	}

	/** The true count, so a page never reports its own cap as a total. */
	countDocsContaining(text: string, filter: DocFilter): number {
		const { clause, values } = docWhere(filter, text);
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM docs ${clause}`).get(...values) as { n: number }).n;
	}

	/** Every region a caller must match itself, for the same reason comments need one: no REGEXP. */
	docsToScan(scanLimit: number, filter: DocFilter): StoredDoc[] {
		const { clause, values } = docWhere(filter);
		const rows = this.db.prepare(`SELECT * FROM docs ${clause} ${DOC_ORDER} LIMIT ?`).all(...values, scanLimit);
		return rows.map(rowToDoc);
	}

	countDocs(filter: DocFilter): number {
		const { clause, values } = docWhere(filter);
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM docs ${clause}`).get(...values) as { n: number }).n;
	}

	/** The prose of one section, which is how describe answers about a heading. */
	docsAnchoredTo(symbolId: string): StoredDoc[] {
		const rows = this.db.prepare(`SELECT * FROM docs WHERE anchorId = ? ${DOC_ORDER}`).all(symbolId);
		return rows.map(rowToDoc);
	}

	/**
	 * Values written in more than one file, commonest first.
	 *
	 * The whole point of the tier: a magic string shared by two files is the strongest textual
	 * signal that they are related, and no graph edge connects them.
	 */
	sharedLiterals(
		minimumFiles: number,
		limit: number,
		hidden: HiddenModules,
	): Array<{ value: string; kind: string; files: number; uses: number }> {
		const { clause, values } = sharedWhere(hidden);
		const rows = this.db
			.prepare(
				`SELECT value, kind, COUNT(DISTINCT module) AS files, COUNT(*) AS uses
				 FROM literals ${clause} GROUP BY value, kind HAVING files >= ? ORDER BY files DESC, uses DESC LIMIT ?`,
			)
			.all(...values, minimumFiles, limit) as Array<{ value: string; kind: string; files: number; uses: number }>;
		return rows;
	}

	////////////////////////////////
	//  Graph

	/** Bound rows only; fan-out. */
	usesFrom(symbolId: string): StoredReference[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM refs r WHERE r.fromId = ? AND r.targetId IS NOT NULL AND ${useSql("r")} ORDER BY module, startLine, startChar`,
			)
			.all(symbolId);
		return rows.map(rowToReference);
	}

	/** Distinct bound targets used from any of `fromIds`, in one read however many there are. */
	targetsFrom(fromIds: readonly string[]): Set<string> {
		if (fromIds.length === 0) return new Set();
		const rows = this.db
			.prepare(
				`SELECT DISTINCT r.targetId AS targetId FROM refs r
				 WHERE r.fromId IN (SELECT value FROM json_each(?)) AND r.targetId IS NOT NULL AND ${useSql("r")}`,
			)
			.all(JSON.stringify(fromIds)) as Array<{ targetId: string }>;
		return new Set(rows.map((row) => row.targetId));
	}

	/** Distinct bound targets a module's top level uses. */
	topLevelTargets(module: string): Set<string> {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT r.targetId AS targetId FROM refs r
				 WHERE r.module = ? AND r.fromId IS NULL AND r.targetId IS NOT NULL AND ${useSql("r")}`,
			)
			.all(module) as Array<{ targetId: string }>;
		return new Set(rows.map((row) => row.targetId));
	}

	/** Every bound use edge, for a traversal that needs the whole graph rather than one neighbourhood. */
	useEdges(): Array<{ from: string; to: string }> {
		return this.db
			.prepare(
				`SELECT DISTINCT fromId AS 'from', targetId AS 'to' FROM refs r
				 WHERE fromId IS NOT NULL AND targetId IS NOT NULL AND ${useSql("r")}`,
			)
			.all() as Array<{ from: string; to: string }>;
	}

	/** Most-used symbols first. Hub rank, which is fan-in sorted, ties by id so two runs agree. */
	mostReferenced(limit: number): Array<{ symbolId: string; count: number }> {
		return this.db
			.prepare(
				`SELECT targetId AS symbolId, COUNT(*) AS count FROM refs r
				 WHERE targetId IS NOT NULL AND ${useSql("r")} GROUP BY targetId ORDER BY count DESC, targetId LIMIT ?`,
			)
			.all(limit) as Array<{ symbolId: string; count: number }>;
	}

	/** Git's word on a file as recorded; null on a row written without asking. */
	generatedOf(module: string): GeneratedVerdict | null {
		const row = this.db.prepare("SELECT generated, generatedReason FROM files WHERE module = ?").get(module) as
			| { generated: string | null; generatedReason: string | null }
			| undefined;
		if (row === undefined || row.generated === null) return null;
		return verdictFromRow(row.generated, row.generatedReason);
	}

	/** Every row takes the verdict admission just reached, so a file left unread keeps no stale one. */
	syncGenerated(verdicts: ReadonlyMap<string, GeneratedVerdict>): number {
		const rows = this.db.prepare("SELECT module, generated, generatedReason FROM files").all() as Array<{
			module: string;
			generated: string | null;
			generatedReason: string | null;
		}>;
		const stale = rows.flatMap((row) => {
			const verdict = verdicts.get(row.module);
			if (verdict === undefined) return [];
			const reason = verdict.status === "unknown" ? verdict.reason : null;
			return row.generated === verdict.status && row.generatedReason === reason
				? []
				: [{ module: row.module, status: verdict.status, reason }];
		});
		if (stale.length === 0) return 0;
		const update = this.db.prepare("UPDATE files SET generated = ?, generatedReason = ? WHERE module = ?");
		this.inTransaction(() => {
			for (const row of stale) update.run(row.status, row.reason, row.module);
		});
		return stale.length;
	}

	/** Symbols nothing references. Honest only as far as binding reaches, which the caller states. */
	unreferencedSymbols(): StoredDeclaration[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM symbols WHERE symbolId NOT IN (SELECT targetId FROM refs WHERE targetId IS NOT NULL)",
			)
			.all();
		return rows.map(rowToDeclaration);
	}

	close(): void {
		this.db.close();
	}
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

type EntryPoint = { module: string } & ({ how: "main"; symbolId: string } | { how: Exclude<EntryHow, "main"> });

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
	};
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

/** Excludes hidden modules, bound as a JSON list. */
function leaveOut(
	hidden: HiddenModules,
	where: string[],
	values: Array<string | number>,
	column: "module" | "l.module" = "module",
): void {
	if (hidden.length === 0) return;
	where.push(`${column} NOT IN (SELECT value FROM json_each(?))`);
	values.push(JSON.stringify(hidden));
}

function literalWhere(filter: LiteralFilter) {
	const where: string[] = [];
	const values: Array<string | number> = [];
	// A key is an inner match: a literal with no container has no name to match.
	const join =
		filter.key === undefined
			? "LEFT JOIN symbols s ON s.symbolId = l.containerId"
			: "JOIN symbols s ON s.symbolId = l.containerId";
	leaveOut(filter.hidden, where, values, "l.module");
	if (filter.value !== undefined) {
		where.push("l.value = ?");
		values.push(filter.value);
	}
	if (filter.kind !== undefined) {
		where.push("l.kind = ?");
		values.push(filter.kind);
	}
	if (filter.low !== undefined || filter.high !== undefined) {
		where.push("l.number IS NOT NULL AND l.number BETWEEN ? AND ?");
		values.push(filter.low ?? Number.NEGATIVE_INFINITY, filter.high ?? Number.POSITIVE_INFINITY);
	}
	if (filter.key !== undefined) {
		where.push("s.name = ?");
		values.push(filter.key);
	}
	if (filter.module !== undefined) under("l.module", filter.module, where, values);
	if (filter.scope?.module !== undefined) {
		where.push("l.containerId >= ? AND l.containerId < ?");
		values.push(filter.scope.low as string, filter.scope.high as string);
	}
	if (filter.scope?.like !== undefined) {
		where.push("l.containerId LIKE ? ESCAPE '\\'");
		values.push(`${filter.scope.head}%${likePattern(filter.scope.like)}%`);
	}
	return { join, clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
}

/** Escapes what LIKE treats as wildcards, so a search for `100%` is a search for `100%`. */
function likePattern(text: string): string {
	return searchTerm(text).replace(/[%_\\]/g, "\\$&");
}

/** A module path names that file, or every module in that folder. Case-sensitive, as LIKE is not. */
function under(column: string, path: string, where: string[], values: Array<string | number>): void {
	where.push(`(${column} = ? OR substr(${column}, 1, length(?)) = ?)`);
	values.push(path, `${path}/`, `${path}/`);
}

/** Source order, and by column too: two comments can share a line. */
const COMMENT_ORDER = "ORDER BY module, startLine, startChar";

/** One place builds the clause, so a count and its page can never disagree about what matched. */
function commentWhere(filter: CommentFilter, text?: string): { clause: string; values: Array<string | number> } {
	const where: string[] = [];
	const values: Array<string | number> = [];
	leaveOut(filter.hidden, where, values);
	if (text !== undefined) {
		where.push("normalized LIKE ? ESCAPE '\\'");
		values.push(`%${likePattern(text)}%`);
	}
	if (filter.form !== undefined) {
		where.push("form = ?");
		values.push(filter.form);
	}
	if (filter.module !== undefined) under("module", filter.module, where, values);
	return { clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
}

/** Document order, and by column too: a range can start where the previous one ended. */
const DOC_ORDER = "ORDER BY module, startLine, startChar";

/** One place builds the clause, so a count and its page can never disagree about what matched. */
function docWhere(filter: DocFilter, text?: string): { clause: string; values: Array<string | number> } {
	const where: string[] = [];
	const values: Array<string | number> = [];
	leaveOut(filter.hidden, where, values);
	if (text !== undefined) {
		where.push("normalized LIKE ? ESCAPE '\\'");
		values.push(`%${likePattern(text)}%`);
	}
	if (filter.fenced !== undefined) {
		where.push("fenced = ?");
		values.push(filter.fenced ? 1 : 0);
	}
	if (filter.module !== undefined) under("module", filter.module, where, values);
	return { clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
}

function importWhere(hidden: HiddenModules, specifier?: string): { clause: string; values: Array<string | number> } {
	const where: string[] = [];
	const values: Array<string | number> = [];
	leaveOut(hidden, where, values);
	if (specifier !== undefined) {
		where.push("specifier LIKE ? ESCAPE '\\'");
		values.push(`%${likePattern(specifier)}%`);
	}
	return { clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
}

function sharedWhere(hidden: HiddenModules): { clause: string; values: Array<string | number> } {
	const where: string[] = [];
	const values: Array<string | number> = [];
	leaveOut(hidden, where, values);
	return { clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
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

interface ImportRow {
	factId: string;
	module: string;
	specifier: string;
	edge: string;
	loads: string | null;
	elided: number | null;
	landing: string | null;
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

interface ExportRow {
	factId: string;
	module: string;
	edge: string;
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
