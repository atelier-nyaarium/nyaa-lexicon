import { z } from "zod";
import type { Statements } from "./database.js";
import { JOURNAL_TABLE_NAMES, JOURNAL_TABLES, type JournalTable } from "./journalSchema.js";
import { insertNote } from "./noteRows.js";
import { insertRelation, orderedPair } from "./relationRows.js";
import { KNOWLEDGE_TABLES, KnowledgeSubjects, normalizeSalvaged, restoreSubjects } from "./subjects.js";

type Database = Statements;

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
function salvageKnowledge(db: Database): SalvagedKnowledge {
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
	db: Database,
	salvaged: SalvagedKnowledge,
	now: number,
	seededAt: number | null,
): RestoreReport {
	const rows = normalizeSalvaged(salvaged, now, seededAt);
	restoreSubjects(db, rows.subjects);
	const subjects = new KnowledgeSubjects(db);
	let unplaced = 0;

	// A note's links follow the note to wherever it was placed.
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
		`INSERT OR IGNORE INTO symbol_note_links (subjectId, written, target, targetDigest)
		 VALUES (?, ?, ?, ?)`,
	);
	for (const row of rows.noteLinks) {
		const subjectId = notePlaced.get(row.subjectId);
		if (subjectId === undefined) continue;
		link.run(subjectId, row.written, row.target, row.targetDigest);
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
function restoreByColumn(db: Database, table: string, rows: Array<Record<string, unknown>>): void {
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
 * Copies applied rebinds from open legacy plans into the current journal. Returns how many entries
 * could not be preserved.
 */
function liftAppliedRebinds(db: Database): number {
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

function tableExists(db: Database, name: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function columnExists(db: Database, table: string, column: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return columns.some((row) => row.name === column);
}

export { columnExists, liftAppliedRebinds, restoreKnowledge, salvageKnowledge, tableExists };
