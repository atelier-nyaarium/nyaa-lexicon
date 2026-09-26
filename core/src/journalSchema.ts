// Journal operations derive from this registry.

import type { DatabaseSync } from "node:sqlite";
import { EVIDENCE_IN, STATE_IN } from "./subjects.js";

////////////////////////////////
//  Interfaces & Types

export interface JournalTable {
	/** Added in place when absent. */
	ddl: string;
	/** Carried across a rebuild. */
	salvage: boolean;
	/** Row changes advance open revisions. */
	revision: boolean;
	/** Blob hash columns and retention scope. */
	blobs?: { columns: readonly string[]; where?: string };
}

////////////////////////////////
//  Constants

export const SETTLEMENTS_KEPT = 128;

export const SETTLED_IMAGES_KEPT = 32;

export const JOURNAL_TABLES = {
	// The partial index enforces one open transaction.
	refactor_transactions: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_transactions (
  id        TEXT PRIMARY KEY,
  state     TEXT NOT NULL,
  startedAt INTEGER NOT NULL,
  revision  INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  -- Recovery closes 'own'; NULL means 'explicit'.
  origin    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS refactor_one_open ON refactor_transactions(state) WHERE state = 'open';
`,
		salvage: true,
		revision: false,
	},
	// Persist phases before their work for recovery.
	refactor_steps: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_steps (
  transactionId TEXT NOT NULL,
  stepNo        INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  phase         TEXT NOT NULL,
  -- Recovery does not replay this plan.
  plan          TEXT,
  createdAt     INTEGER NOT NULL,
  PRIMARY KEY (transactionId, stepNo)
);
`,
		salvage: true,
		revision: true,
	},
	// Atomic rows preserve rebinds' prior states.
	refactor_rebinds: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_rebinds (
  transactionId   TEXT NOT NULL,
  stepNo          INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL,
  subjectId       TEXT NOT NULL,
  fromSymbolId    TEXT NOT NULL,
  toSymbolId      TEXT NOT NULL,
  priorFrom       TEXT,
  priorEvidence   TEXT NOT NULL CHECK (priorEvidence IN (${EVIDENCE_IN})),
  priorBoundAt    INTEGER NOT NULL,
  priorState      TEXT NOT NULL CHECK (priorState IN (${STATE_IN})),
  priorOrphanedAt INTEGER,
  PRIMARY KEY (transactionId, stepNo, ordinal),
  CHECK ((priorState = 'bound' AND priorOrphanedAt IS NULL) OR (priorState = 'orphaned' AND priorOrphanedAt IS NOT NULL)),
  CHECK (typeof(subjectId) = 'text' AND subjectId != ''),
  CHECK (typeof(fromSymbolId) = 'text' AND fromSymbolId != ''),
  CHECK (typeof(toSymbolId) = 'text' AND toSymbolId != ''),
  CHECK (priorFrom IS NULL OR (typeof(priorFrom) = 'text' AND priorFrom != '')),
  CHECK (typeof(priorBoundAt) = 'integer'),
  CHECK (priorOrphanedAt IS NULL OR typeof(priorOrphanedAt) = 'integer')
);
`,
		salvage: true,
		revision: true,
	},
	refactor_recovery_intents: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_recovery_intents (
  transactionId TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('undo', 'revert')),
  stepNo INTEGER,
  diskStates TEXT
);
`,
		salvage: true,
		revision: true,
	},
	refactor_known_states: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_known_states (
  transactionId TEXT NOT NULL,
  module        TEXT NOT NULL,
  existed       INTEGER NOT NULL CHECK (existed IN (0, 1)),
  contentHash   TEXT,
  edited        INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  PRIMARY KEY (transactionId, module),
  CHECK ((existed = 0 AND contentHash IS NULL) OR (existed = 1 AND contentHash IS NOT NULL))
);
`,
		salvage: true,
		revision: true,
		blobs: { columns: ["contentHash"] },
	},
	// Content addressing deduplicates exact byte images.
	refactor_blobs: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_blobs (
  hash  TEXT PRIMARY KEY,
  bytes BLOB NOT NULL
);
`,
		salvage: true,
		revision: false,
	},
	// Baselines serve revert; step images serve undo.
	// Existence distinguishes absent files from empty files.
	refactor_images: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_images (
  transactionId TEXT NOT NULL,
  scope         TEXT NOT NULL,
  stepNo        INTEGER,
  module        TEXT NOT NULL,
  existedBefore INTEGER NOT NULL,
  beforeHash    TEXT,
  existsAfter   INTEGER,
  afterHash     TEXT,
  beforeEdited  INTEGER NOT NULL DEFAULT 0 CHECK (beforeEdited IN (0, 1)),
  PRIMARY KEY (transactionId, scope, stepNo, module)
);
CREATE INDEX IF NOT EXISTS refactor_images_txn ON refactor_images(transactionId);
`,
		salvage: true,
		revision: true,
		blobs: { columns: ["beforeHash", "afterHash"] },
	},
	// Per-step issues name commit refusals.
	refactor_issues: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_issues (
  transactionId TEXT NOT NULL,
  stepNo        INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  detail        TEXT NOT NULL,
  module        TEXT,
  line          INTEGER
);
CREATE INDEX IF NOT EXISTS refactor_issues_txn ON refactor_issues(transactionId);
`,
		salvage: true,
		revision: true,
	},
	// AUTOINCREMENT preserves pruned sequence numbers.
	refactor_settlements: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_settlements (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  transactionId TEXT NOT NULL UNIQUE,
  origin        TEXT NOT NULL CHECK (origin IN ('explicit', 'own')),
  outcome       TEXT NOT NULL CHECK (outcome IN ('committed', 'reverted')),
  closedAt      INTEGER NOT NULL
);
`,
		salvage: true,
		revision: false,
	},
	// Null hashes mark absent files.
	refactor_settled_files: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_settled_files (
  seq         INTEGER NOT NULL,
  module      TEXT NOT NULL,
  opened      TEXT,
  settled     TEXT,
  drifted     INTEGER NOT NULL DEFAULT 0 CHECK (drifted IN (0, 1)),
  driftedHash TEXT,
  PRIMARY KEY (seq, module),
  CHECK (drifted = 1 OR driftedHash IS NULL)
);
`,
		salvage: true,
		revision: false,
		blobs: {
			columns: ["opened", "settled"],
			where: `seq IN (SELECT seq FROM refactor_settlements WHERE origin = 'explicit' ORDER BY seq DESC LIMIT ${SETTLED_IMAGES_KEPT})`,
		},
	},
} as const satisfies Record<string, JournalTable>;

export type JournalTableName = keyof typeof JOURNAL_TABLES;

export const JOURNAL_TABLE_NAMES = Object.keys(JOURNAL_TABLES) as JournalTableName[];

export const JOURNAL_DDL = Object.values(JOURNAL_TABLES)
	.map((table) => table.ddl)
	.join("");

////////////////////////////////
//  Functions & Helpers

/** Update triggers compare every table column. */
export function installRevisionTriggers(db: DatabaseSync): void {
	for (const table of JOURNAL_TABLE_NAMES) {
		const entry: JournalTable = JOURNAL_TABLES[table];
		if (!entry.revision) continue;
		const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
			(column) => column.name,
		);
		const changed = columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
		const bump = (row: "NEW" | "OLD") =>
			`BEGIN UPDATE refactor_transactions SET revision = revision + 1 WHERE id = ${row}.transactionId AND state = 'open'; END;`;
		db.exec(`
			DROP TRIGGER IF EXISTS ${table}_revision_insert;
			DROP TRIGGER IF EXISTS ${table}_revision_update;
			DROP TRIGGER IF EXISTS ${table}_revision_delete;
			CREATE TRIGGER ${table}_revision_insert AFTER INSERT ON ${table} ${bump("NEW")}
			CREATE TRIGGER ${table}_revision_update AFTER UPDATE ON ${table} WHEN ${changed} ${bump("NEW")}
			CREATE TRIGGER ${table}_revision_delete AFTER DELETE ON ${table} ${bump("OLD")}
		`);
	}
}

/** Query for retained blob hashes. */
export function keptBlobs(): string {
	return JOURNAL_TABLE_NAMES.flatMap((table) => {
		const { blobs }: JournalTable = JOURNAL_TABLES[table];
		if (blobs === undefined) return [];
		const where = blobs.where === undefined ? "" : ` AND ${blobs.where}`;
		return blobs.columns.map((column) => `SELECT ${column} FROM ${table} WHERE ${column} IS NOT NULL${where}`);
	}).join(" UNION ");
}
