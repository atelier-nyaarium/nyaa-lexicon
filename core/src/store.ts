// The index. Facts only: traversal, ranking and cycle collapsing happen in application code.
//
// Reverse lookup is the reason this is a database. References are recorded at the use site, so
// "who uses this" has no cheap answer in memory, and an index on the target column turns it into
// the same read as "what is this".

import { DatabaseSync } from "node:sqlite";
import {
	commentFactId,
	type Declaration,
	type DocRegion,
	declarationFactId,
	docFactId,
	type FileContent,
	type Import,
	type IndexDepth,
	importFactId,
	type Literal,
	literalFactId,
	type Metrics,
	parseFactId,
	type Range,
	type Reference,
	referenceFactId,
} from "@nyaa-lexicon/protocol";
import type { Answer, Doubt } from "./answers.js";
import type { AttachedComment } from "./commentAttach.js";
import { admitFacts } from "./factAdmission.js";
import { normalizeDocText } from "./proseText.js";
import { compileSearchRegex, searchTerm } from "./search.js";

////////////////////////////////
//  Interfaces & Types

export interface StoredReference {
	/** Citable id for this row. Every fact carries one, which is what a knowledge answer cites. */
	factId: string;
	module: string;
	name: string;
	role: string;
	/** Absent when the reference did not bind, which is a fact worth keeping. */
	targetId: string | null;
	fromId: string | null;
	provenance: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

export interface StoredDeclaration extends Declaration {
	factId: string;
	module: string;
}

/** Scan counts. */
export interface ScanCounts {
	tracked: number;
	claimed: number;
	unclaimed: number;
	generated: number;
	denied: number;
}

/** One literal value written in one place. */
export interface StoredLiteral {
	factId: string;
	module: string;
	kind: string;
	value: string;
	number: number | null;
	containerId: string | null;
	range: Range;
}

/** One comment as stored: what it says, where it says it, and what it says it about. */
export interface StoredComment {
	factId: string;
	module: string;
	raw: string;
	normalized: string;
	form: string;
	placement: string;
	anchorId: string | null;
	range: Range;
}

export interface CommentFilter {
	form?: string | undefined;
	module?: string | undefined;
}

/** One stretch of a document's prose, with the heading it sits under. */
export interface StoredDoc {
	factId: string;
	module: string;
	raw: string;
	normalized: string;
	fenced: boolean;
	/** Null when the region sits under no heading, which is prose before the first one. */
	anchorId: string | null;
	range: Range;
}

export interface DocFilter {
	/** Restricts to fenced regions when true, to prose when false, to neither when absent. */
	fenced?: boolean | undefined;
	module?: string | undefined;
}

/** One name written by one import statement, with the spans a rewrite would replace. */
export interface StoredImport {
	factId: string;
	module: string;
	specifier: string;
	reExport: boolean;
	/** Absent when the statement names no export. The edge is still real; only rename skips it. */
	name?: string;
	range?: Range;
	/** Present only when the import writes an alias, which renames must NOT follow. */
	local?: string;
	localRange?: Range;
}

/**
 * Any one row, tagged with what it is.
 *
 * What `factById` returns, so a stored citation can be turned back into the thing it cited. The id
 * carries its own kind and module, which is what makes that lookup one indexed read of one table
 * rather than a search of four.
 */
export type StoredFact =
	| ({ fact: "declaration" } & StoredDeclaration)
	| ({ fact: "reference" } & StoredReference)
	| ({ fact: "import" } & StoredImport)
	| ({ fact: "literal" } & StoredLiteral)
	| ({ fact: "comment" } & StoredComment)
	| ({ fact: "doc" } & StoredDoc)
	| ({ fact: "answer" } & Answer);

////////////////////////////////
//  Constants

/** Bumped whenever the shape changes. A mismatch rebuilds rather than migrating. */
// 2: exported became nullable, so a provider that cannot answer is not stored as false.
// 3: full ranges, and a declaration's name span, because a rewrite needs to know what to replace.
// 4: an index on a reference's name, which rename needs to find same-spelling occurrences that
//    did NOT bind, since those are exactly the ones a rewrite might miss.
// 5: imports, which were parsed and then thrown away. A name written inside an import statement is
//    an occurrence a rewrite has to reach, and it was in no table at all.
// 6: literals and per-declaration metrics. A name inside a string is not a reference, so it was in
//    no table either, which is why a rename could leave `__all__` stale and never notice.
// 7: an import that names no export gets a row anyway. Storing only named entries dropped the edge
//    with the name, so `import os` and `import * as ns` were absent from the import graph entirely.
// 8: a factId on every row. A symbol had a citable id and no other fact did, so the knowledge
//    layer's contract that an answer lists what it consumed had nothing to list.
// 9: a meta table holding the compatibility key for stored facts. A per-file hash cannot
//    see a provider changing how it classifies, because the files it describes have not moved.
// 10: answers, the knowledge layer's read side. Kept in the same database as the facts they cite so
//    a rebuild of the index cannot leave citations pointing into a store that no longer exists.
// 11: answers carry fact ids so an answer can cite an answer, and a gaps ledger counts every ask
//    that found nothing, so "which answers are worth writing" is measured rather than guessed.
// 12: answers carry a thinness mark, and answers plus gaps SURVIVE a rebuild. "The index is always
//    derivable from source" was true until answers existed: they are the one thing here that is
//    not, and a schema bump or provider change was silently deleting the knowledge base.
// 13: answers carry a declared doubt. Mechanical staleness cannot see semantic drift, so an agent
//    that changed a function's purpose needs a way to flag the recorded explanation without
//    rewriting it, and the flag must survive a re-record by a writer who never saw it.
// 16: comments, with their attachment resolved, and docComment retired from symbols. Doctrine in a
//    codebase lives in comments, and they were the one thing every fallback to grep was looking
//    for. A doc comment is now the leading-attached comment rather than a second copy of the same
//    prose on the declaration, so the two can no longer disagree.
// 17: document prose, anchored to the heading it sits under. A comment answers with the symbol it
//    documents; a document region answers with the heading path it was found under, which is a
//    different question and so a different table.
export const SCHEMA_VERSION = 17;

/** Per content class. Unknown is a row written before the class was recorded. */
export interface ContentCounts {
	code: number;
	data: number;
	document: number;
	unknown: number;
}

export interface ContentTotals {
	files: ContentCounts;
	symbols: ContentCounts;
}

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
  contentHash TEXT NOT NULL,
  indexedAt   INTEGER NOT NULL,
  -- Outline rows require a full parse.
  depth       TEXT NOT NULL DEFAULT 'full',
  -- What the owning provider declared its files are; NULL on a row written before that was kept.
  content     TEXT
);
CREATE INDEX files_indexed_at ON files(indexedAt);
CREATE INDEX files_depth ON files(depth);

-- Parse failures persist until a successful parse or file removal.
CREATE TABLE parse_failures (
  module   TEXT PRIMARY KEY,
  reason   TEXT NOT NULL,
  failedAt INTEGER NOT NULL
);
${NOTES_TABLE}
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
  mBranches   INTEGER
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
  provenance TEXT NOT NULL,
  startLine  INTEGER NOT NULL,
  startChar  INTEGER NOT NULL,
  endLine    INTEGER NOT NULL,
  endChar    INTEGER NOT NULL
);
CREATE INDEX refs_module ON refs(module);
-- The whole reason for a database: this turns reverse lookup into an indexed read.
CREATE INDEX refs_target ON refs(targetId);
CREATE INDEX refs_name ON refs(name);
-- Not unique, here or on any fact table. Two identical statements in one file are the same fact
-- written twice, so one id for both is the right answer rather than a collision to design around.
CREATE INDEX refs_fact ON refs(factId);

-- One row per NAME an import brings in, not one per statement: the rewritable thing is the name.
-- The specifier is kept unresolved because resolving every one at index time costs a provider
-- round trip per import, and only the handful sharing a name with a rename target ever need it.
CREATE TABLE imports (
  factId     TEXT NOT NULL,
  module     TEXT NOT NULL,
  specifier  TEXT NOT NULL,
  reExport   INTEGER NOT NULL,
  -- Null when the statement names no export: a bare module import, a namespace import, a preload
  -- const. The EDGE is still real, so the row exists and only rename filters it out.
  name       TEXT,
  startLine  INTEGER,
  startChar  INTEGER,
  endLine    INTEGER,
  endChar    INTEGER,
  -- The local alias and its span, both null when the import writes no alias.
  localName      TEXT,
  localStartLine INTEGER,
  localStartChar INTEGER,
  localEndLine   INTEGER,
  localEndChar   INTEGER
);
CREATE INDEX imports_module ON imports(module);
CREATE INDEX imports_name ON imports(name);
CREATE INDEX imports_fact ON imports(factId);

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

-- The knowledge layer's read side. One answer per symbol per question class, replaced rather than
-- versioned, because a superseded answer is a decision to make deliberately rather than a pile to
-- accumulate. Citations are stored as JSON: they are read whole, never queried by element.
-- The factId makes an answer citable BY other answers; replacing an answer retires its id, which is
-- how staleness cascades into everything built on it without any bookkeeping.
CREATE TABLE answers (
  symbolId  TEXT NOT NULL,
  question  TEXT NOT NULL,
  factId    TEXT NOT NULL,
  prose     TEXT NOT NULL,
  citations TEXT NOT NULL,
  -- Structurally computed at record time: 1 when nothing cited reaches beyond the subject's own
  -- declaration. Stored rather than derived on read, because deriving it re-resolves every
  -- citation and the flag has to survive those citations going stale.
  thin      INTEGER NOT NULL DEFAULT 0,
  model     TEXT,
  createdAt INTEGER NOT NULL,
  -- A declared doubt, all four columns present or all null. The id is a handshake token: clearing
  -- the doubt requires citing it, which proves the clearing writer recalled and read the reason.
  doubtId     TEXT,
  doubtReason TEXT,
  doubtAt     INTEGER,
  doubtBy     TEXT,
  PRIMARY KEY (symbolId, question)
);
CREATE INDEX answers_symbol ON answers(symbolId);
CREATE INDEX answers_fact ON answers(factId);

-- Demand for knowledge nobody has written, counted per ask. The ledger half of honest
-- incompleteness: a gap is not an error, it is a measured fact about where effort would pay.
CREATE TABLE gaps (
  symbolId  TEXT NOT NULL,
  question  TEXT NOT NULL,
  askCount  INTEGER NOT NULL,
  lastAsked INTEGER NOT NULL,
  PRIMARY KEY (symbolId, question)
);

-- The refactor journal. One open transaction per workspace, enforced by the partial index below
-- rather than by whoever happens to check first.
CREATE TABLE refactor_transactions (
  id        TEXT PRIMARY KEY,
  state     TEXT NOT NULL,
  startedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX refactor_one_open ON refactor_transactions(state) WHERE state = 'open';

-- The phase is what recovery reads. A crash between any two of these leaves a state that has to
-- be distinguishable from the others, so it is committed before the work it names, not after.
CREATE TABLE refactor_steps (
  transactionId TEXT NOT NULL,
  stepNo        INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  phase         TEXT NOT NULL,
  -- The plan as decided, so applying never recomputes it and cannot drift from what was reported.
  plan          TEXT,
  createdAt     INTEGER NOT NULL,
  PRIMARY KEY (transactionId, stepNo)
);

-- Content addressed, so snapshotting every layer of a long transaction stores each distinct file
-- version once rather than once per layer. Bytes, not text: a file that is not valid UTF-8 still
-- has to come back byte-identical.
CREATE TABLE refactor_blobs (
  hash  TEXT PRIMARY KEY,
  bytes BLOB NOT NULL
);

-- The scope separates the transaction's opening image of a file from each step's. Revert reads
-- the baseline, undo reads the step, and collapsing them would make one of the two wrong.
--
-- Existence is recorded on both sides because absent and empty are different files: a target the
-- transaction created has existedBefore 0, and undoing it means deleting rather than writing "".
CREATE TABLE refactor_images (
  transactionId TEXT NOT NULL,
  scope         TEXT NOT NULL,
  stepNo        INTEGER,
  module        TEXT NOT NULL,
  existedBefore INTEGER NOT NULL,
  beforeHash    TEXT,
  existsAfter   INTEGER,
  afterHash     TEXT,
  PRIMARY KEY (transactionId, scope, stepNo, module)
);
CREATE INDEX refactor_images_txn ON refactor_images(transactionId);

-- Problems a step introduced, kept per step so status can say which one to look at, and so a
-- commit refusal names the step rather than the workspace.
CREATE TABLE refactor_issues (
  transactionId TEXT NOT NULL,
  stepNo        INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  detail        TEXT NOT NULL,
  module        TEXT,
  line          INTEGER
);
CREATE INDEX refactor_issues_txn ON refactor_issues(transactionId);
`;

/**
 * Every table a file contributes rows to, keyed by module.
 *
 * One list, because replaceFile and forgetFile must clear exactly the same set. Written out
 * separately, a table added to one and not the other leaves a deleted file's rows in the index
 * forever, still answering searches.
 */
const FACT_TABLES = ["refs", "symbols", "imports", "literals", "comments", "docs", "notes"] as const;

/** Meta key for store compatibility. */
const COMPATIBILITY_KEY = "storeCompatibility";

/** Meta key: when notes began. */
const NOTES_SINCE_KEY = "notesSince";

export interface FileNote {
	severity: "warning" | "info";
	message: string;
	range?: Range;
	path?: string;
}

/** Unknown until a read with notes. */
export type FileNotes =
	| { module: string; known: true; notes: FileNote[] }
	| { module: string; known: false; reason: "notIndexed" | "indexedBeforeNotes" };

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

/** Where the last scan's coverage arithmetic lives in the meta table. */
const SCAN_SUMMARY_KEY = "scanSummary";

/**
 * Where the indexed workspace's path lives in the meta table.
 *
 * Written so a store can say what it indexed with no daemon running: the path is otherwise only
 * in the lock file, which a stopped daemon takes with it, leaving a hashed directory name and no
 * way to tell a long-gone project from a live one.
 */
const WORKSPACE_KEY = "workspaceRoot";

/** Tables a rebuild carries across, because no re-index can regenerate what is in them. */
const SALVAGED_TABLES = [
	"answers",
	"gaps",
	"refactor_transactions",
	"refactor_steps",
	"refactor_blobs",
	"refactor_images",
	"refactor_issues",
] as const;

/** Journal tables, whose loss is worse than a failed open: it strands edits already on disk. */
const JOURNAL_TABLES = SALVAGED_TABLES.filter((table) => table.startsWith("refactor_"));

/** What survives a rebuild, keyed by table so a new salvaged table needs no new field. */
type SalvagedKnowledge = Record<string, Array<Record<string, unknown>>>;

/**
 * Read by column NAME, so rows written under an older schema carry what they have.
 *
 * A knowledge table that cannot be read salvages empty, since an answer nobody can parse is not
 * worth failing an open over. A JOURNAL table that cannot be read throws: it describes files
 * already written to disk, and opening as though the transaction never existed would strand a
 * half-applied refactor with nothing left that knows how to undo it.
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
			if (JOURNAL_TABLES.includes(table)) {
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

function restoreKnowledge(db: DatabaseSync, salvaged: SalvagedKnowledge): void {
	const answer = db.prepare(
		`INSERT OR REPLACE INTO answers (symbolId, question, factId, prose, citations, thin, model, createdAt,
		 doubtId, doubtReason, doubtAt, doubtBy)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const row of salvaged["answers"] ?? []) {
		const [symbolId, prose, factId] = [row["symbolId"], row["prose"], row["factId"]];
		// A row missing its identity or prose is corruption, and restoring it would enshrine that.
		if (typeof symbolId !== "string" || typeof prose !== "string" || typeof factId !== "string") continue;
		answer.run(
			symbolId,
			String(row["question"] ?? "describe"),
			factId,
			prose,
			String(row["citations"] ?? "[]"),
			typeof row["thin"] === "number" ? row["thin"] : 0,
			typeof row["model"] === "string" ? row["model"] : null,
			typeof row["createdAt"] === "number" ? row["createdAt"] : 0,
			// Doubt survives a rebuild for the same reason the answer does: someone's declared
			// distrust is not derivable from source, and a schema bump erasing it is a silent clear.
			typeof row["doubtId"] === "string" ? row["doubtId"] : null,
			typeof row["doubtReason"] === "string" ? row["doubtReason"] : null,
			typeof row["doubtAt"] === "number" ? row["doubtAt"] : null,
			typeof row["doubtBy"] === "string" ? row["doubtBy"] : null,
		);
	}

	const gap = db.prepare("INSERT OR REPLACE INTO gaps (symbolId, question, askCount, lastAsked) VALUES (?, ?, ?, ?)");
	for (const row of salvaged["gaps"] ?? []) {
		const symbolId = row["symbolId"];
		if (typeof symbolId !== "string") continue;
		gap.run(
			symbolId,
			String(row["question"] ?? "describe"),
			typeof row["askCount"] === "number" ? row["askCount"] : 1,
			typeof row["lastAsked"] === "number" ? row["lastAsked"] : 0,
		);
	}

	for (const table of JOURNAL_TABLES) restoreByColumn(db, table, salvaged[table] ?? []);
}

/**
 * Restores rows into whatever columns the new schema shares with the old ones.
 *
 * Column-wise rather than positional, so adding a journal column keeps old rows loadable instead
 * of dropping every one of them the first time the schema moves. A row losing a column it no
 * longer has is fine; a row losing its whole transaction is not.
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

function tableExists(db: DatabaseSync, name: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return columns.some((row) => row.name === column);
}

////////////////////////////////
//  Class

export class IndexStore {
	private constructor(private readonly db: DatabaseSync) {}

	/** node:sqlite has no transaction helper, so one wrapper owns the begin/commit/rollback. */
	private inTransaction<T>(work: () => T): T {
		this.db.exec("BEGIN");
		try {
			const result = work();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
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
	): { store: IndexStore; rebuilt: boolean; reason?: string } {
		const db = new DatabaseSync(file);
		db.exec("PRAGMA journal_mode = WAL");

		let rebuilt = false;
		let reason: string | undefined;
		let version = 0;
		try {
			version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		} catch {
			version = -1;
		}

		// Read before any rebuild drops the table it lives in.
		const stored = version === SCHEMA_VERSION ? readMeta(db, COMPATIBILITY_KEY) : null;
		if (version === SCHEMA_VERSION && compatibility != null && stored !== null && stored !== compatibility) {
			version = -1;
			reason = "a major version has shipped since this index was written";
		} else if (version !== SCHEMA_VERSION && version !== 0) {
			reason = "the index schema changed";
		}

		if (version !== SCHEMA_VERSION) {
			// The knowledge base is carried across the rebuild. FACTS are derivable from source, so
			// dropping them is a re-index; ANSWERS are written by people and models and are the one
			// thing here that cannot be regenerated. Their citations keep working too, because a fact
			// id is a digest of content: re-indexing unchanged code mints the identical ids.
			const salvaged = salvageKnowledge(db);

			// Asked of the database rather than listed here. A hand-maintained drop list silently
			// diverges from SCHEMA the first time a table is added, and the failure is a rebuild that
			// dies on "table already exists" long after the change that caused it.
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all() as Array<{ name: string }>;

			// One transaction over drop, create and restore. Crashing between them would otherwise
			// leave a store with no journal and a workspace with a half-applied refactor in it.
			db.exec("BEGIN");
			try {
				for (const table of tables) db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
				db.exec(SCHEMA);
				restoreKnowledge(db, salvaged);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			rebuilt = version !== 0;
		}

		// Index additions are safe to apply in place, so existing stores get this lookup without a rebuild.
		db.exec("CREATE INDEX IF NOT EXISTS files_indexed_at ON files(indexedAt)");
		// Nullable, so the add is one atomic statement and an old row reads as not yet recorded.
		if (!columnExists(db, "files", "content")) db.exec("ALTER TABLE files ADD COLUMN content TEXT");
		if (!columnExists(db, "symbols", "synthesizedName")) {
			db.exec("ALTER TABLE symbols ADD COLUMN synthesizedName INTEGER");
		}

		// Marker and table together, or a crash between them reads as a fresh table.
		if (!tableExists(db, "notes")) {
			db.exec("BEGIN");
			try {
				if (readMeta(db, NOTES_SINCE_KEY) === null) writeMeta(db, NOTES_SINCE_KEY, String(Date.now()));
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
		if (workspaceRoot !== undefined) writeMeta(db, WORKSPACE_KEY, workspaceRoot);

		return { store: new IndexStore(db), rebuilt, ...(reason === undefined ? {} : { reason }) };
	}

	////////////////////////////////
	//  Writing

	/**
	 * Replaces everything one file contributed, in one transaction.
	 *
	 * Surgical by module, which is what makes an edit cost a delete and some inserts rather than a
	 * whole-index rebuild. The delete-then-insert is not an optimization: a symbol removed from a
	 * file has to disappear, and an upsert alone would leave it behind forever.
	 */
	replaceFile(
		module: string,
		contentHash: string,
		declarations: Declaration[],
		references: Reference[],
		imports: Import[] = [],
		literals: Literal[] = [],
		depth: IndexDepth = "full",
		comments: AttachedComment[] = [],
		docs: DocRegion[] = [],
		notes: FileNote[] = [],
		content: FileContent = "code",
	): void {
		admitFacts(module, { declarations, references, literals, docs });
		this.inTransaction(() => {
			for (const table of FACT_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE module = ?`).run(module);
			this.db
				.prepare(
					"INSERT OR REPLACE INTO files (module, contentHash, indexedAt, depth, content) VALUES (?, ?, ?, ?, ?)",
				)
				.run(module, contentHash, Date.now(), depth, content);
			// A successful parse clears its failure record.
			this.db.prepare("DELETE FROM parse_failures WHERE module = ?").run(module);

			const symbol = this.db.prepare(
				`INSERT OR REPLACE INTO symbols
				 (symbolId, factId, module, name, kind, visibility, exported, containerId, signature,
				  startLine, startChar, endLine, endChar, nameLine, nameChar, nameEndLine, nameEndChar,
				  synthesizedName, mLines, mParameters, mNesting, mBranches)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const d of declarations) {
				// The name columns are NOT NULL from before names could be absent; the flag says which.
				const named = d.selectionRange ?? { start: d.range.start, end: d.range.start };
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
				);
			}

			const reference = this.db.prepare(
				`INSERT INTO refs (factId, module, name, role, targetId, fromId, provenance, startLine, startChar, endLine, endChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const r of references) {
				// An unbound reference keeps its REASON where a bound one keeps its provenance:
				// both answer "how do you know", and losing the reason discards why it failed.
				const target = r.binding.status === "bound" ? r.binding.symbolId : null;
				const how = r.binding.status === "unbound" ? r.binding.reason : r.binding.provenance;
				reference.run(
					referenceFactId(module, r),
					module,
					r.name,
					r.role,
					target,
					r.fromId ?? null,
					how,
					r.range.start.line,
					r.range.start.character,
					r.range.end.line,
					r.range.end.character,
				);
			}

			const importRow = this.db.prepare(
				`INSERT INTO imports (factId, module, specifier, reExport, name, startLine, startChar, endLine, endChar,
				 localName, localStartLine, localStartChar, localEndLine, localEndChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			// One row per entry, and one for a statement that names nothing. Skipping the latter
			// dropped the EDGE along with the name: `import os`, `import * as ns` and a preload const
			// all bind locally without naming an export, so the import graph silently lost them and
			// "who imports this" answered zero for a whole class of real imports. Rename filters on a
			// non-null name; the graph does not.
			for (const statement of imports) {
				const entries = statement.imported.length > 0 ? statement.imported : [undefined];
				for (const name of entries) {
					importRow.run(
						importFactId(module, statement.specifier, statement.reExport, name),
						module,
						statement.specifier,
						statement.reExport ? 1 : 0,
						name?.name ?? null,
						name?.range?.start.line ?? null,
						name?.range?.start.character ?? null,
						name?.range?.end.line ?? null,
						name?.range?.end.character ?? null,
						name?.local ?? null,
						name?.localRange?.start.line ?? null,
						name?.localRange?.start.character ?? null,
						name?.localRange?.end.line ?? null,
						name?.localRange?.end.character ?? null,
					);
				}
			}

			const literalRow = this.db.prepare(
				`INSERT INTO literals (factId, module, kind, value, number, containerId, startLine, startChar, endLine, endChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const literal of literals) {
				literalRow.run(
					literalFactId(module, literal),
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
					commentFactId(module, { range: comment.range, text: comment.raw }),
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
					docFactId(module, region),
					module,
					region.text,
					normalizeDocText(region.text),
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
		});
	}

	/** Everything a file contributed, gone. Used when a file is deleted rather than changed. */
	forgetFile(module: string): void {
		this.inTransaction(() => {
			for (const table of FACT_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE module = ?`).run(module);
			this.db.prepare("DELETE FROM files WHERE module = ?").run(module);
			this.db.prepare("DELETE FROM parse_failures WHERE module = ?").run(module);
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

	/** The depth a module's stored facts were extracted at, or null when it is not indexed. */
	depthOf(module: string): IndexDepth | null {
		const row = this.db.prepare("SELECT depth FROM files WHERE module = ?").get(module) as
			| { depth: IndexDepth }
			| undefined;
		return row?.depth ?? null;
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
			.run(module, reason, Date.now());
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

	/** Persists scan counts used to explain coverage gaps. */
	writeScanSummary(summary: ScanCounts): void {
		writeMeta(this.db, SCAN_SUMMARY_KEY, JSON.stringify({ ...summary, at: Date.now() }));
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

	/** Runs `work` inside one SQLite transaction, exposed so the journal writes atomically. */
	journal<T>(work: (db: DatabaseSync) => T): T {
		return this.inTransaction(() => work(this.db));
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

	/** Blobs no image still points at. Called after a transaction settles, never during one. */
	pruneBlobs(): number {
		const result = this.db
			.prepare(
				`DELETE FROM refactor_blobs WHERE hash NOT IN (
				   SELECT beforeHash FROM refactor_images WHERE beforeHash IS NOT NULL
				   UNION SELECT afterHash FROM refactor_images WHERE afterHash IS NOT NULL
				 )`,
			)
			.run();
		return Number(result.changes);
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
			case "literal": {
				const row = this.db.prepare("SELECT * FROM literals WHERE factId = ?").get(factId);
				return row ? { fact: "literal", ...rowToLiteral(row) } : null;
			}
			case "comment": {
				const row = this.db.prepare("SELECT * FROM comments WHERE factId = ?").get(factId);
				return row ? { fact: "comment", ...rowToComment(row) } : null;
			}
			case "answer": {
				const row = this.db.prepare("SELECT * FROM answers WHERE factId = ?").get(factId);
				return row ? { fact: "answer", ...rowToAnswer(row as unknown as AnswerRow) } : null;
			}
			// A doubt id is a clear-handshake token, not a citable fact. Refusing to resolve it here is
			// what keeps an answer from being grounded on someone's transient distrust.
			case "doubt":
				return null;
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
	//  Answers

	/** Writes or replaces one answer. Validation happens above this: the store records, it does not judge. */
	saveAnswer(answer: Answer): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO answers (symbolId, question, factId, prose, citations, thin, model, createdAt,
				 doubtId, doubtReason, doubtAt, doubtBy)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				answer.symbolId,
				answer.question,
				answer.factId,
				answer.prose,
				JSON.stringify(answer.citations),
				answer.thin ? 1 : 0,
				answer.model ?? null,
				answer.createdAt,
				answer.doubt?.factId ?? null,
				answer.doubt?.reason ?? null,
				answer.doubt?.at ?? null,
				answer.doubt?.by ?? null,
			);
		// Answering closes the gap. The ask count served its purpose; keeping the row would make
		// every later gap query filter it out forever.
		this.db.prepare("DELETE FROM gaps WHERE symbolId = ? AND question = ?").run(answer.symbolId, answer.question);
	}

	/**
	 * Attach or replace a doubt on an existing answer without touching anything else.
	 *
	 * Deliberately NOT `saveAnswer`: that path closes the gap row, and a doubt is the opposite of an
	 * answer arriving. Returns false when no answer exists to doubt.
	 */
	setDoubt(symbolId: string, question: string, doubt: Doubt): boolean {
		const result = this.db
			.prepare(
				"UPDATE answers SET doubtId = ?, doubtReason = ?, doubtAt = ?, doubtBy = ? WHERE symbolId = ? AND question = ?",
			)
			.run(doubt.factId, doubt.reason, doubt.at, doubt.by ?? null, symbolId, question);
		return result.changes > 0;
	}

	/** How many answers currently carry a declared doubt. A count, so it stays cheap at any size. */
	doubtedCount(): number {
		return (this.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE doubtId IS NOT NULL").get() as { n: number })
			.n;
	}

	/** Every answer carrying a declared doubt. One indexed read, cheap at any knowledge-base size. */
	doubtedAnswers(): Answer[] {
		const rows = this.db
			.prepare("SELECT * FROM answers WHERE doubtId IS NOT NULL ORDER BY symbolId, question")
			.all();
		return rows.map((row) => rowToAnswer(row as unknown as AnswerRow));
	}

	/** Counts one ask that found nothing, or found something stale. The demand half of the ledger. */
	recordGap(symbolId: string, question: string, at: number): void {
		this.db
			.prepare(
				`INSERT INTO gaps (symbolId, question, askCount, lastAsked) VALUES (?, ?, 1, ?)
				 ON CONFLICT(symbolId, question) DO UPDATE SET askCount = askCount + 1, lastAsked = excluded.lastAsked`,
			)
			.run(symbolId, question, at);
	}

	/** Open gaps, most asked-for first. Fan-in joins in above this, since it lives in refs. */
	gaps(limit: number): Array<{ symbolId: string; question: string; askCount: number; lastAsked: number }> {
		return this.db
			.prepare("SELECT * FROM gaps ORDER BY askCount DESC, lastAsked DESC LIMIT ?")
			.all(limit) as Array<{ symbolId: string; question: string; askCount: number; lastAsked: number }>;
	}

	/** One gap's ask count, zero when nobody has asked. */
	askCount(symbolId: string, question: string): number {
		const row = this.db
			.prepare("SELECT askCount FROM gaps WHERE symbolId = ? AND question = ?")
			.get(symbolId, question) as { askCount: number } | undefined;
		return row?.askCount ?? 0;
	}

	answer(symbolId: string, question: string): Answer | null {
		const row = this.db
			.prepare("SELECT * FROM answers WHERE symbolId = ? AND question = ?")
			.get(symbolId, question) as AnswerRow | undefined;
		return row === undefined ? null : rowToAnswer(row);
	}

	/** Every answer about one symbol, whatever was asked. */
	/**
	 * Moves recorded knowledge from one symbol id to another.
	 *
	 * Renaming and moving both re-mint an id, and the prose written about a symbol is the one thing
	 * here no re-index can regenerate. A row whose destination already has an answer is left alone:
	 * the new id's own answer was written about the code as it stands, and overwriting it with the
	 * old symbol's would be a silent downgrade.
	 */
	migrateKnowledge(fromId: string, toId: string): { answers: number; gaps: number } {
		return this.inTransaction(() => {
			const answers = this.db
				.prepare(
					`UPDATE OR IGNORE answers SET symbolId = ? WHERE symbolId = ?
					 AND question NOT IN (SELECT question FROM answers WHERE symbolId = ?)`,
				)
				.run(toId, fromId, toId);
			const gaps = this.db
				.prepare(
					`UPDATE OR IGNORE gaps SET symbolId = ? WHERE symbolId = ?
					 AND question NOT IN (SELECT question FROM gaps WHERE symbolId = ?)`,
				)
				.run(toId, fromId, toId);

			// Anything left behind names a symbol that no longer exists, and keeping it would leave
			// prose attached to an id nothing can resolve.
			this.db.prepare("DELETE FROM answers WHERE symbolId = ?").run(fromId);
			this.db.prepare("DELETE FROM gaps WHERE symbolId = ?").run(fromId);

			return { answers: Number(answers.changes), gaps: Number(gaps.changes) };
		});
	}

	/** Every symbol id the index holds for one module, which is the subtree a rename re-mints. */
	symbolIdsIn(module: string): string[] {
		const rows = this.db.prepare("SELECT symbolId FROM symbols WHERE module = ?").all(module) as Array<{
			symbolId: string;
		}>;
		return rows.map((row) => row.symbolId);
	}

	answersFor(symbolId: string): Answer[] {
		const rows = this.db.prepare("SELECT * FROM answers WHERE symbolId = ? ORDER BY question").all(symbolId);
		return rows.map((row) => rowToAnswer(row as unknown as AnswerRow));
	}

	/** The whole knowledge base, for coverage reporting. Small by nature: prose, not facts. */
	allAnswers(): Answer[] {
		const rows = this.db.prepare("SELECT * FROM answers ORDER BY symbolId, question").all();
		return rows.map((row) => rowToAnswer(row as unknown as AnswerRow));
	}

	/** How many answers exist, and how many under one author tag. The count nobody has to keep. */
	answerCounts(model?: string): { total: number; byModel?: number } {
		const total = (this.db.prepare("SELECT COUNT(*) AS n FROM answers").get() as { n: number }).n;
		if (model === undefined) return { total };
		const byModel = (
			this.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE model = ?").get(model) as { n: number }
		).n;
		return { total, byModel };
	}

	/** Literals written inside one declaration. The text a symbol carries, as opposed to near it. */
	literalsContainedBy(containerId: string, limit: number): StoredLiteral[] {
		const rows = this.db
			.prepare("SELECT * FROM literals WHERE containerId = ? ORDER BY startLine, startChar LIMIT ?")
			.all(containerId, limit);
		return rows.map(rowToLiteral);
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
		const rows = this.db.prepare("SELECT * FROM symbols WHERE module = ? ORDER BY startLine").all(module);
		return rows.map(rowToDeclaration);
	}

	/** Reverse lookup: the indexed read the whole storage choice exists for. */
	referencesTo(symbolId: string): StoredReference[] {
		const rows = this.db.prepare("SELECT * FROM refs WHERE targetId = ? ORDER BY module, startLine").all(symbolId);
		return rows.map(rowToReference);
	}

	referencesIn(module: string): StoredReference[] {
		const rows = this.db.prepare("SELECT * FROM refs WHERE module = ? ORDER BY startLine").all(module);
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
				 WHERE localName = ? OR (localName IS NULL AND name = ?)
				 ORDER BY module, startLine`,
			)
			.all(localName, localName);
		return rows.map(rowToImport);
	}

	importsIn(module: string): StoredImport[] {
		const rows = this.db.prepare("SELECT * FROM imports WHERE module = ? ORDER BY startLine").all(module);
		return rows.map(rowToImport);
	}

	/** Import rows for bounded application-side searches. */
	importsForScan(scanLimit: number): StoredImport[] {
		const rows = this.db.prepare("SELECT * FROM imports ORDER BY module, startLine LIMIT ?").all(scanLimit);
		return rows.map(rowToImport);
	}

	/** Search declarations by name substring or regular expression. */
	searchSymbols(
		text: string | undefined,
		options: { regex?: string | undefined; kind?: string; module?: string; limit: number },
	): StoredDeclaration[] {
		const regex = options.regex === undefined ? undefined : compileSearchRegex(options.regex);
		const clauses: string[] = [];
		const values: Array<string | number> = [];
		if (text !== undefined) {
			clauses.push("name LIKE ? ESCAPE '\\'");
			values.push(`%${likePattern(text)}%`);
		}
		if (options.kind !== undefined) {
			clauses.push("kind = ?");
			values.push(options.kind);
		}
		if (options.module !== undefined) {
			clauses.push("module LIKE ? ESCAPE '\\'");
			values.push(`%${likePattern(options.module)}%`);
		}
		if (clauses.length === 0) clauses.push("1 = 1");
		const limit = regex === undefined ? " LIMIT ?" : "";
		if (regex === undefined) values.push(options.limit);

		const rows = this.db
			.prepare(`SELECT * FROM symbols WHERE ${clauses.join(" AND ")} ORDER BY module, startLine${limit}`)
			.all(...values)
			.map(rowToDeclaration);
		if (regex === undefined) return rows;

		return rows.filter((row) => regex.test(row.name)).slice(0, options.limit);
	}

	/** Imports whose specifier contains this text. "Which files import X", by the name as written. */
	importsMatching(specifier: string, limit: number): StoredImport[] {
		const rows = this.db
			.prepare("SELECT * FROM imports WHERE specifier LIKE ? ESCAPE '\\' ORDER BY module, startLine LIMIT ?")
			.all(`%${likePattern(specifier)}%`, limit);
		return rows.map(rowToImport);
	}

	/** Every module held by the index, including files with no declarations. */
	indexedFiles(): string[] {
		const rows = this.db.prepare("SELECT module FROM files ORDER BY module").all() as Array<{ module: string }>;
		return rows.map((row) => row.module);
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
		const files: ContentCounts = { code: 0, data: 0, document: 0, unknown: 0 };
		const symbols: ContentCounts = { code: 0, data: 0, document: 0, unknown: 0 };
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

	/** Exact decoded value. The cheap case, and an indexed read. */
	literalsWithValue(value: string, limit: number): StoredLiteral[] {
		const rows = this.db
			.prepare("SELECT * FROM literals WHERE value = ? ORDER BY module, startLine LIMIT ?")
			.all(value, limit);
		return rows.map(rowToLiteral);
	}

	/** The true count, so a page never reports its own cap as a total. */
	countLiteralsWithValue(value: string): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM literals WHERE value = ?").get(value);
		return (row as { n: number }).n;
	}

	/** Numeric range, as arithmetic. A string comparison would put "10" before "9". */
	literalsInRange(low: number, high: number, limit: number): StoredLiteral[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM literals WHERE number IS NOT NULL AND number BETWEEN ? AND ? ORDER BY number LIMIT ?",
			)
			.all(low, high, limit);
		return rows.map(rowToLiteral);
	}

	countLiteralsInRange(low: number, high: number): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM literals WHERE number IS NOT NULL AND number BETWEEN ? AND ?")
			.get(low, high);
		return (row as { n: number }).n;
	}

	/**
	 * Every literal, for a caller that must match them itself.
	 *
	 * SQLite has no REGEXP without an extension, and node:sqlite ships none, so a regex search
	 * reads and filters. Bounded by the caller rather than unbounded here, because a workspace has
	 * far more literals than symbols and an unbounded read is how a query becomes a hang.
	 */
	literalsOfKind(kind: string, scanLimit: number): StoredLiteral[] {
		const rows = this.db
			.prepare("SELECT * FROM literals WHERE kind = ? ORDER BY module, startLine LIMIT ?")
			.all(kind, scanLimit);
		return rows.map(rowToLiteral);
	}

	////////////////////////////////
	//  Comments

	/** Substring over the NORMALIZED text, so a phrase the writer wrapped still matches. */
	commentsContaining(text: string, limit: number, filter: CommentFilter = {}): StoredComment[] {
		const { clause, values } = commentWhere(filter, text);
		const rows = this.db.prepare(`SELECT * FROM comments ${clause} ${COMMENT_ORDER} LIMIT ?`).all(...values, limit);
		return rows.map(rowToComment);
	}

	/** The true count, so a page never reports its own cap as a total. */
	countCommentsContaining(text: string, filter: CommentFilter = {}): number {
		const { clause, values } = commentWhere(filter, text);
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM comments ${clause}`).get(...values) as { n: number }).n;
	}

	/** Every comment a caller must match itself, for the same reason literals need one: no REGEXP. */
	commentsToScan(scanLimit: number, filter: CommentFilter = {}): StoredComment[] {
		const { clause, values } = commentWhere(filter);
		const rows = this.db
			.prepare(`SELECT * FROM comments ${clause} ${COMMENT_ORDER} LIMIT ?`)
			.all(...values, scanLimit);
		return rows.map(rowToComment);
	}

	countComments(filter: CommentFilter = {}): number {
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

	////////////////////////////////
	//  Documents

	docsContaining(text: string, limit: number, filter: DocFilter = {}): StoredDoc[] {
		const { clause, values } = docWhere(filter, text);
		const rows = this.db.prepare(`SELECT * FROM docs ${clause} ${DOC_ORDER} LIMIT ?`).all(...values, limit);
		return rows.map(rowToDoc);
	}

	/** The true count, so a page never reports its own cap as a total. */
	countDocsContaining(text: string, filter: DocFilter = {}): number {
		const { clause, values } = docWhere(filter, text);
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM docs ${clause}`).get(...values) as { n: number }).n;
	}

	/** Every region a caller must match itself, for the same reason comments need one: no REGEXP. */
	docsToScan(scanLimit: number, filter: DocFilter = {}): StoredDoc[] {
		const { clause, values } = docWhere(filter);
		const rows = this.db.prepare(`SELECT * FROM docs ${clause} ${DOC_ORDER} LIMIT ?`).all(...values, scanLimit);
		return rows.map(rowToDoc);
	}

	countDocs(filter: DocFilter = {}): number {
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
	): Array<{ value: string; kind: string; files: number; uses: number }> {
		const rows = this.db
			.prepare(
				`SELECT value, kind, COUNT(DISTINCT module) AS files, COUNT(*) AS uses
				 FROM literals GROUP BY value, kind HAVING files >= ? ORDER BY files DESC, uses DESC LIMIT ?`,
			)
			.all(minimumFiles, limit) as Array<{ value: string; kind: string; files: number; uses: number }>;
		return rows;
	}

	////////////////////////////////
	//  Graph

	/** What this symbol uses, as distinct targets. Fan-out to reverse lookup's fan-in. */
	referencesFrom(symbolId: string): StoredReference[] {
		const rows = this.db
			.prepare("SELECT * FROM refs WHERE fromId = ? AND targetId IS NOT NULL ORDER BY module, startLine")
			.all(symbolId);
		return rows.map(rowToReference);
	}

	/** Every bound edge, for a traversal that needs the whole graph rather than one neighbourhood. */
	allEdges(): Array<{ from: string; to: string }> {
		return this.db
			.prepare(
				"SELECT DISTINCT fromId AS 'from', targetId AS 'to' FROM refs WHERE fromId IS NOT NULL AND targetId IS NOT NULL",
			)
			.all() as Array<{ from: string; to: string }>;
	}

	/** Most-referenced symbols first. Hub rank, which is fan-in sorted. */
	mostReferenced(limit: number): Array<{ symbolId: string; count: number }> {
		return this.db
			.prepare(
				`SELECT targetId AS symbolId, COUNT(*) AS count FROM refs
				 WHERE targetId IS NOT NULL GROUP BY targetId ORDER BY count DESC LIMIT ?`,
			)
			.all(limit) as Array<{ symbolId: string; count: number }>;
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
	provenance: string;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
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
	};
}

interface LiteralRow {
	factId: string;
	module: string;
	kind: string;
	value: string;
	number: number | null;
	containerId: string | null;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
}

/** Escapes what LIKE treats as wildcards, so a search for `100%` is a search for `100%`. */
function likePattern(text: string): string {
	return searchTerm(text).replace(/[%_\\]/g, "\\$&");
}

/** Source order, and by column too: two comments can share a line. */
const COMMENT_ORDER = "ORDER BY module, startLine, startChar";

/** One place builds the clause, so a count and its page can never disagree about what matched. */
function commentWhere(filter: CommentFilter, text?: string): { clause: string; values: Array<string | number> } {
	const where: string[] = [];
	const values: Array<string | number> = [];
	if (text !== undefined) {
		where.push("normalized LIKE ? ESCAPE '\\'");
		values.push(`%${likePattern(text)}%`);
	}
	if (filter.form !== undefined) {
		where.push("form = ?");
		values.push(filter.form);
	}
	if (filter.module !== undefined) {
		where.push("module = ?");
		values.push(filter.module);
	}
	return { clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
}

/** Document order, and by column too: a range can start where the previous one ended. */
const DOC_ORDER = "ORDER BY module, startLine, startChar";

/** One place builds the clause, so a count and its page can never disagree about what matched. */
function docWhere(filter: DocFilter, text?: string): { clause: string; values: Array<string | number> } {
	const where: string[] = [];
	const values: Array<string | number> = [];
	if (text !== undefined) {
		where.push("normalized LIKE ? ESCAPE '\\'");
		values.push(`%${likePattern(text)}%`);
	}
	if (filter.fenced !== undefined) {
		where.push("fenced = ?");
		values.push(filter.fenced ? 1 : 0);
	}
	if (filter.module !== undefined) {
		where.push("module = ?");
		values.push(filter.module);
	}
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
		form: row.form,
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
		kind: row.kind,
		value: row.value,
		number: row.number,
		containerId: row.containerId,
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
	reExport: number;
	name: string | null;
	startLine: number | null;
	startChar: number | null;
	endLine: number | null;
	endChar: number | null;
	localName: string | null;
	localStartLine: number | null;
	localStartChar: number | null;
	localEndLine: number | null;
	localEndChar: number | null;
}

function rowToImport(raw: unknown): StoredImport {
	const row = raw as ImportRow;
	const alias =
		row.localName === null || row.localStartLine === null
			? {}
			: {
					local: row.localName,
					localRange: {
						start: { line: row.localStartLine, character: row.localStartChar ?? 0 },
						end: { line: row.localEndLine ?? row.localStartLine, character: row.localEndChar ?? 0 },
					},
				};

	const named =
		row.name === null || row.startLine === null
			? {}
			: {
					name: row.name,
					range: {
						start: { line: row.startLine, character: row.startChar ?? 0 },
						end: { line: row.endLine ?? row.startLine, character: row.endChar ?? 0 },
					},
				};

	return {
		factId: row.factId,
		module: row.module,
		specifier: row.specifier,
		reExport: row.reExport === 1,
		...named,
		...alias,
	};
}

interface AnswerRow {
	symbolId: string;
	question: string;
	factId: string;
	prose: string;
	citations: string;
	thin: number;
	model: string | null;
	createdAt: number;
	doubtId: string | null;
	doubtReason: string | null;
	doubtAt: number | null;
	doubtBy: string | null;
}

function rowToAnswer(row: AnswerRow): Answer {
	// Written by this store and never by hand, so a parse failure means corruption rather than input
	// to validate. An empty citation list would be refused before it could be stored.
	const citations = JSON.parse(row.citations) as string[];
	const doubt: Doubt | undefined =
		row.doubtId === null || row.doubtReason === null || row.doubtAt === null
			? undefined
			: {
					factId: row.doubtId,
					reason: row.doubtReason,
					at: row.doubtAt,
					...(row.doubtBy === null ? {} : { by: row.doubtBy }),
				};
	return {
		symbolId: row.symbolId,
		question: row.question as Answer["question"],
		factId: row.factId,
		prose: row.prose,
		citations,
		thin: row.thin === 1,
		createdAt: row.createdAt,
		...(row.model === null ? {} : { model: row.model }),
		...(doubt === undefined ? {} : { doubt }),
	};
}

function rowToReference(raw: unknown): StoredReference {
	const row = raw as RefRow;
	return {
		factId: row.factId,
		module: row.module,
		name: row.name,
		role: row.role,
		targetId: row.targetId,
		fromId: row.fromId,
		provenance: row.provenance,
		startLine: row.startLine,
		startCharacter: row.startChar,
		endLine: row.endLine,
		endCharacter: row.endChar,
	};
}
