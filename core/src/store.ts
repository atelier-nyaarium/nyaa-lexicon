// The index. Facts only: traversal, ranking and cycle collapsing happen in application code.
//
// Reverse lookup is the reason this is a database. References are recorded at the use site, so
// "who uses this" has no cheap answer in memory, and an index on the target column turns it into
// the same read as "what is this".

import { DatabaseSync } from "node:sqlite";
import {
	type Declaration,
	declarationFactId,
	type Import,
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
import { compileSearchRegex } from "./search.js";

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
// 9: a meta table holding the fingerprint of the code that wrote the facts. A per-file hash cannot
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
export const SCHEMA_VERSION = 13;

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
  indexedAt   INTEGER NOT NULL
);
CREATE INDEX files_indexed_at ON files(indexedAt);

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
  docComment  TEXT,
  startLine   INTEGER NOT NULL,
  startChar   INTEGER NOT NULL,
  endLine     INTEGER NOT NULL,
  endChar     INTEGER NOT NULL,
  -- The name alone. A rename rewrites this span, never the declaration's whole range.
  nameLine    INTEGER NOT NULL,
  nameChar    INTEGER NOT NULL,
  nameEndLine INTEGER NOT NULL,
  nameEndChar INTEGER NOT NULL,
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
`;

/**
 * Every table a file contributes rows to, keyed by module.
 *
 * One list, because replaceFile and forgetFile must clear exactly the same set. Written out
 * separately, a table added to one and not the other leaves a deleted file's rows in the index
 * forever, still answering searches.
 */
const FACT_TABLES = ["refs", "symbols", "imports", "literals"] as const;

/** Where the indexer fingerprint lives in the meta table. */
const FINGERPRINT_KEY = "indexerFingerprint";

/**
 * Where the indexed workspace's path lives in the meta table.
 *
 * Written so a store can say what it indexed with no daemon running: the path is otherwise only
 * in the lock file, which a stopped daemon takes with it, leaving a hashed directory name and no
 * way to tell a long-gone project from a live one.
 */
const WORKSPACE_KEY = "workspaceRoot";

/** What survives a rebuild: the tables holding work no re-index can regenerate. */
interface SalvagedKnowledge {
	answers: Array<Record<string, unknown>>;
	gaps: Array<Record<string, unknown>>;
}

/** Read by column NAME, so rows written under an older schema carry what they have. */
function salvageKnowledge(db: DatabaseSync): SalvagedKnowledge {
	const read = (table: string): Array<Record<string, unknown>> => {
		try {
			return db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
		} catch {
			return [];
		}
	};
	return { answers: read("answers"), gaps: read("gaps") };
}

function restoreKnowledge(db: DatabaseSync, salvaged: SalvagedKnowledge): void {
	const answer = db.prepare(
		`INSERT OR REPLACE INTO answers (symbolId, question, factId, prose, citations, thin, model, createdAt,
		 doubtId, doubtReason, doubtAt, doubtBy)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const row of salvaged.answers) {
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
	for (const row of salvaged.gaps) {
		const symbolId = row["symbolId"];
		if (typeof symbolId !== "string") continue;
		gap.run(
			symbolId,
			String(row["question"] ?? "describe"),
			typeof row["askCount"] === "number" ? row["askCount"] : 1,
			typeof row["lastAsked"] === "number" ? row["lastAsked"] : 0,
		);
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

////////////////////////////////
//  Class

export class IndexStore {
	private constructor(private readonly db: DatabaseSync) {}

	/** node:sqlite has no transaction helper, so one wrapper owns the begin/commit/rollback. */
	private inTransaction(work: () => void): void {
		this.db.exec("BEGIN");
		try {
			work();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * Opens the index, rebuilding from empty when it cannot be trusted.
	 *
	 * An index is always derivable from source, so a wrong version or an unreadable file is a
	 * re-index rather than data loss. Migrating instead would mean carrying every past shape
	 * forever to protect something we can regenerate.
	 *
	 * `fingerprint` identifies the code that WROTE the facts. A schema bump catches a changed shape;
	 * this catches a changed meaning, which no per-file hash can see because the files did not move.
	 * Absent means the caller has no fingerprint to offer and the check is skipped.
	 */
	static open(
		file: string,
		fingerprint?: string | null,
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
		const stored = version === SCHEMA_VERSION ? readMeta(db, FINGERPRINT_KEY) : null;
		if (version === SCHEMA_VERSION && fingerprint != null && stored !== null && stored !== fingerprint) {
			version = -1;
			reason = "the providers or protocol changed since this index was written";
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
			for (const table of tables) db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
			db.exec(SCHEMA);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			restoreKnowledge(db, salvaged);
			rebuilt = version !== 0;
		}

		// Index additions are safe to apply in place, so existing stores get this lookup without a rebuild.
		db.exec("CREATE INDEX IF NOT EXISTS files_indexed_at ON files(indexedAt)");

		// Written on every open rather than only after a rebuild, so an index built before this check
		// existed adopts the current fingerprint instead of rebuilding forever.
		if (fingerprint != null) writeMeta(db, FINGERPRINT_KEY, fingerprint);
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
	): void {
		this.inTransaction(() => {
			for (const table of FACT_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE module = ?`).run(module);
			this.db
				.prepare("INSERT OR REPLACE INTO files (module, contentHash, indexedAt) VALUES (?, ?, ?)")
				.run(module, contentHash, Date.now());

			const symbol = this.db.prepare(
				`INSERT OR REPLACE INTO symbols
				 (symbolId, factId, module, name, kind, visibility, exported, containerId, signature, docComment,
				  startLine, startChar, endLine, endChar, nameLine, nameChar, nameEndLine, nameEndChar,
				  mLines, mParameters, mNesting, mBranches)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const d of declarations) {
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
					d.docComment ?? null,
					d.range.start.line,
					d.range.start.character,
					d.range.end.line,
					d.range.end.character,
					d.selectionRange.start.line,
					d.selectionRange.start.character,
					d.selectionRange.end.line,
					d.selectionRange.end.character,
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
		});
	}

	/** Everything a file contributed, gone. Used when a file is deleted rather than changed. */
	forgetFile(module: string): void {
		this.inTransaction(() => {
			for (const table of FACT_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE module = ?`).run(module);
			this.db.prepare("DELETE FROM files WHERE module = ?").run(module);
		});
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

		// The id carries its kind, so this reads one table rather than searching four.
		if (parsed.kind === "declaration") {
			const row = this.db.prepare("SELECT * FROM symbols WHERE factId = ?").get(factId);
			return row ? { fact: "declaration", ...rowToDeclaration(row) } : null;
		}
		if (parsed.kind === "reference") {
			const row = this.db.prepare("SELECT * FROM refs WHERE factId = ?").get(factId);
			return row ? { fact: "reference", ...rowToReference(row) } : null;
		}
		if (parsed.kind === "import") {
			const row = this.db.prepare("SELECT * FROM imports WHERE factId = ?").get(factId);
			return row ? { fact: "import", ...rowToImport(row) } : null;
		}
		if (parsed.kind === "answer") {
			const row = this.db.prepare("SELECT * FROM answers WHERE factId = ?").get(factId);
			return row ? { fact: "answer", ...rowToAnswer(row as unknown as AnswerRow) } : null;
		}
		// A doubt id is a clear-handshake token, not a citable fact. Refusing to resolve it here is
		// what keeps an answer from being grounded on someone's transient distrust.
		if (parsed.kind === "doubt") return null;
		const row = this.db.prepare("SELECT * FROM literals WHERE factId = ?").get(factId);
		return row ? { fact: "literal", ...rowToLiteral(row) } : null;
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
			values.push(`%${text.replace(/[%_\\]/g, "\\$&")}%`);
		}
		if (options.kind !== undefined) {
			clauses.push("kind = ?");
			values.push(options.kind);
		}
		if (options.module !== undefined) {
			clauses.push("module LIKE ? ESCAPE '\\'");
			values.push(`%${options.module.replace(/[%_\\]/g, "\\$&")}%`);
		}
		if (clauses.length === 0) clauses.push("1 = 1");
		const limit = regex === undefined ? " LIMIT ?" : "";
		if (regex === undefined) values.push(options.limit);

		const rows = this.db
			.prepare(`SELECT * FROM symbols WHERE ${clauses.join(" AND ")} ORDER BY module, startLine${limit}`)
			.all(...values)
			.map(rowToDeclaration);
		if (regex === undefined) return rows;

		return rows
			.filter((row) => {
				regex.lastIndex = 0;
				return regex.test(row.name);
			})
			.slice(0, options.limit);
	}

	/** Imports whose specifier contains this text. "Which files import X", by the name as written. */
	importsMatching(specifier: string, limit: number): StoredImport[] {
		const rows = this.db
			.prepare("SELECT * FROM imports WHERE specifier LIKE ? ESCAPE '\\' ORDER BY module, startLine LIMIT ?")
			.all(`%${specifier.replace(/[%_\\]/g, "\\$&")}%`, limit);
		return rows.map(rowToImport);
	}

	/** Every module held by the index, including files with no declarations. */
	indexedFiles(): string[] {
		const rows = this.db.prepare("SELECT module FROM files ORDER BY module").all() as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Every module with facts, ordered by symbol count. */
	moduleSummary(): Array<{ module: string; symbols: number }> {
		return this.db
			.prepare("SELECT module, COUNT(*) AS symbols FROM symbols GROUP BY module ORDER BY symbols DESC")
			.all() as Array<{ module: string; symbols: number }>;
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

	/** Numeric range, as arithmetic. A string comparison would put "10" before "9". */
	literalsInRange(low: number, high: number, limit: number): StoredLiteral[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM literals WHERE number IS NOT NULL AND number BETWEEN ? AND ? ORDER BY number LIMIT ?",
			)
			.all(low, high, limit);
		return rows.map(rowToLiteral);
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
	docComment: string | null;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
	nameLine: number;
	nameChar: number;
	nameEndLine: number;
	nameEndChar: number;
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
		selectionRange: {
			start: { line: row.nameLine, character: row.nameChar },
			end: { line: row.nameEndLine, character: row.nameEndChar },
		},
		...metricsOf(row),
		// Omitted rather than stored as null, so an absent field stays absent through a round trip.
		...(row.exported === null ? {} : { exported: row.exported === 1 }),
		...(row.containerId === null ? {} : { containerId: row.containerId }),
		...(row.signature === null ? {} : { signature: row.signature }),
		...(row.docComment === null ? {} : { docComment: row.docComment }),
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
