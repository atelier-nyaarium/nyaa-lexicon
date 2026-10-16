// Journal operations derive from this registry.

import type { Database } from "./database.js";
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
	/** Hash columns and retention. */
	hashes?: {
		module: string;
		columns: readonly string[];
		blobs?: readonly string[];
		transaction?: string;
		retained?: string;
	};
	/** JSON image hashes. */
	jsonHashes?: readonly JournalJsonHashes[];
}

export interface JournalJsonHashes {
	column: string;
	key: string;
	array: string;
	module: string;
	hashes: readonly string[];
	purge: "nullify" | "remove";
}

////////////////////////////////
//  Constants

export const SETTLEMENTS_KEPT = 128;

export const SETTLED_IMAGES_KEPT = 32;

export const CLIENT_STEPS_KEPT = 256;

export const JOURNAL_TABLES = {
	refactor_admissions: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_admissions (
  module TEXT NOT NULL,
  hash   TEXT NOT NULL,
  stamp  TEXT,
  PRIMARY KEY (module, hash),
  CHECK (typeof(module) = 'text' AND module != ''),
  CHECK (typeof(hash) = 'text' AND hash != ''),
  CHECK (stamp IS NULL OR typeof(stamp) = 'text')
);
CREATE INDEX IF NOT EXISTS refactor_admissions_hash ON refactor_admissions(hash);
`,
		salvage: true,
		revision: false,
	},
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
		jsonHashes: [
			{
				column: "diskStates",
				key: "transactionId",
				array: "$",
				module: "module",
				hashes: ["hash"],
				purge: "remove",
			},
		],
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
		hashes: { module: "module", columns: ["contentHash"], transaction: "transactionId" },
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
		hashes: {
			module: "module",
			columns: ["beforeHash", "afterHash"],
			transaction: "transactionId",
		},
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
	// A client's name for a committed step, so a lost answer can be asked for again.
	refactor_client_steps: {
		ddl: `
CREATE TABLE IF NOT EXISTS refactor_client_steps (
  stepId     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('rename', 'move')),
  state      TEXT NOT NULL CHECK (state IN ('planning', 'writing', 'cancelled', 'interrupted', 'answered')),
  answer     TEXT,
  recordedAt INTEGER NOT NULL,
  CHECK ((state = 'answered') = (answer IS NOT NULL))
);
`,
		salvage: true,
		revision: false,
		jsonHashes: [
			{
				column: "answer",
				key: "stepId",
				array: "$.files",
				module: "module",
				hashes: ["before", "after"],
				purge: "nullify",
			},
		],
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
		hashes: {
			module: "module",
			columns: ["opened", "settled", "driftedHash"],
			blobs: ["opened", "settled"],
			retained: `seq IN (SELECT seq FROM refactor_settlements WHERE origin = 'explicit' ORDER BY seq DESC LIMIT ${SETTLED_IMAGES_KEPT})`,
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
export function installRevisionTriggers(db: Database): void {
	for (const table of JOURNAL_TABLE_NAMES) {
		const entry: JournalTable = JOURNAL_TABLES[table];
		if (!entry.revision) continue;
		const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
			(column) => column.name,
		);
		const changed = columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
		const bump = (row: "NEW" | "OLD") =>
			`UPDATE refactor_transactions SET revision = revision + 1 WHERE id = ${row}.transactionId AND state = 'open';`;
		const expected = [
			{
				name: `${table}_revision_insert`,
				sql: `CREATE TRIGGER ${table}_revision_insert AFTER INSERT ON ${table} BEGIN ${bump("NEW")} END`,
			},
			{
				name: `${table}_revision_update`,
				sql: `CREATE TRIGGER ${table}_revision_update AFTER UPDATE ON ${table} WHEN ${changed} BEGIN ${bump("NEW")} END`,
			},
			{
				name: `${table}_revision_delete`,
				sql: `CREATE TRIGGER ${table}_revision_delete AFTER DELETE ON ${table} BEGIN ${bump("OLD")} END`,
			},
		];
		const installed = new Map(
			(
				db
					.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?")
					.all(table) as Array<{ name: string; sql: string | null }>
			).map(({ name, sql }) => [name, sql]),
		);
		const changedTriggers = expected.filter(({ name, sql }) => {
			const current = installed.get(name);
			return current?.replace(/\s+/g, " ").trim().toLowerCase() !== sql.toLowerCase();
		});
		if (changedTriggers.length === 0) continue;
		db.exec(changedTriggers.map(({ name, sql }) => `DROP TRIGGER IF EXISTS ${name}; ${sql};`).join("\n"));
	}
}

/** Reject images without policy rows. */
export function installAdmissionTriggers(db: Database): void {
	for (const table of JOURNAL_TABLE_NAMES) {
		const entry: JournalTable = JOURNAL_TABLES[table];
		const hashes = entry.hashes;
		if (hashes !== undefined) {
			for (const column of hashes.columns) {
				const admitted = `NEW.${column} IS NOT NULL AND NOT EXISTS (
					SELECT 1 FROM refactor_admissions WHERE module = NEW.${hashes.module} AND hash = NEW.${column}
				)`;
				for (const [event, operation] of [
					["INSERT", "insert"] as const,
					[`UPDATE OF module, ${column}`, "update"] as const,
				]) {
					const name = `${table}_${column}_admission_${operation}`;
					db.exec(
						`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${event} ON ${table}
							 WHEN ${admitted}
							 BEGIN SELECT RAISE(ABORT, 'journal image lacks policy admission'); END;`,
					);
				}
			}
		}
		for (const reference of entry.jsonHashes ?? []) {
			const pairs = reference.hashes
				.map(
					(hash) =>
						`json_extract(image.value, '$.${reference.module}') IS NOT NULL
							AND json_extract(image.value, '$.${hash}') IS NOT NULL
							AND NOT EXISTS (
								SELECT 1 FROM refactor_admissions AS admission
								WHERE admission.module = json_extract(image.value, '$.${reference.module}')
									AND admission.hash = json_extract(image.value, '$.${hash}')
							)`,
				)
				.join(" OR ");
			const unadmitted = `NEW.${reference.column} IS NOT NULL AND (
				NOT json_valid(NEW.${reference.column}) OR EXISTS (
					SELECT 1 FROM json_each(
						CASE WHEN json_valid(NEW.${reference.column}) THEN NEW.${reference.column} ELSE '{}' END,
						'${reference.array}'
					) AS image WHERE ${pairs}
				)
			)`;
			for (const [event, operation] of [
				["INSERT", "insert"] as const,
				[`UPDATE OF ${reference.column}`, "update"] as const,
			]) {
				const name = `${table}_${reference.column}_json_admission_${operation}`;
				db.exec(
					`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${event} ON ${table}
						 WHEN ${unadmitted}
						 BEGIN SELECT RAISE(ABORT, 'journal image lacks policy admission'); END;`,
				);
			}
		}
	}
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS refactor_blobs_admission_insert BEFORE INSERT ON refactor_blobs
		WHEN NOT EXISTS (SELECT 1 FROM refactor_admissions WHERE hash = NEW.hash)
		BEGIN SELECT RAISE(ABORT, 'journal blob lacks policy admission'); END;
		CREATE TRIGGER IF NOT EXISTS refactor_blobs_admission_update BEFORE UPDATE OF hash ON refactor_blobs
		WHEN NOT EXISTS (SELECT 1 FROM refactor_admissions WHERE hash = NEW.hash)
		BEGIN SELECT RAISE(ABORT, 'journal blob lacks policy admission'); END;
	`);
}

/** Query for retained blob hashes. */
export function keptBlobs(): string {
	return JOURNAL_TABLE_NAMES.flatMap((table) => {
		const { hashes }: JournalTable = JOURNAL_TABLES[table];
		if (hashes === undefined) return [];
		const retained = hashes.retained === undefined ? "" : ` AND ${hashes.retained}`;
		return (hashes.blobs ?? hashes.columns).map(
			(column) => `SELECT ${column} FROM ${table} WHERE ${column} IS NOT NULL${retained}`,
		);
	}).join(" UNION ");
}

/** Query retained hash pairs. */
export function keptHashPairs(): string {
	return JOURNAL_TABLE_NAMES.flatMap((table) => {
		const { hashes }: JournalTable = JOURNAL_TABLES[table];
		const direct =
			hashes?.columns.map(
				(column) =>
					`SELECT ${hashes.module} AS module, ${column} AS hash FROM ${table} WHERE ${column} IS NOT NULL`,
			) ?? [];
		const entry: JournalTable = JOURNAL_TABLES[table];
		const json = (entry.jsonHashes ?? []).flatMap((reference) =>
			reference.hashes.map(
				(hash) =>
					`SELECT json_extract(image.value, '$.${reference.module}') AS module,
						json_extract(image.value, '$.${hash}') AS hash
					 FROM ${table} AS parent,
						json_each(CASE WHEN json_valid(parent.${reference.column}) THEN parent.${reference.column} ELSE '{}' END, '${reference.array}') AS image
					 WHERE parent.${reference.column} IS NOT NULL
						AND json_extract(image.value, '$.${hash}') IS NOT NULL`,
			),
		);
		return [...direct, ...json];
	}).join(" UNION ");
}
