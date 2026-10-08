// This module owns relation row storage; relation meaning belongs to the ledger.

import type { DatabaseSync } from "node:sqlite";

////////////////////////////////
//  Interfaces & Types

export type RelationProvenanceColumn = "computed" | "person" | "agent" | "model";

export type RelationStatusColumn = "proposed" | "confirmed" | "doubted";

/** A stated relation's own columns, the lesser subject first. */
export interface StatedColumns {
	recordedAs: string;
	otherAs: string;
	provenance: RelationProvenanceColumn;
	status: RelationStatusColumn;
	revision: number;
	why: string | null;
	author: string | null;
	authoredAt: number;
	judgedBy: string | null;
	judgedAt: number | null;
	reason: string | null;
	digest: string | null;
	otherDigest: string | null;
}

/** A stated relation with each subject's current address, state and digest. */
export interface StatedRow extends StatedColumns {
	subjectId: string;
	otherId: string;
	symbolId: string;
	state: "bound" | "orphaned";
	lastDigest: string | null;
	otherSymbolId: string;
	otherState: "bound" | "orphaned";
	otherLastDigest: string | null;
}

export interface FeedbackCounts {
	accepted: number;
	rejected: number;
}

export interface DiscoveryRow {
	module: string;
	symbolId: string;
	score: number;
	via: string[];
	at: number;
}

export interface GapRow {
	symbolId: string;
	module: string;
	at: number;
}

////////////////////////////////
//  Constants

/** Discovery's tables and the feedback counters: rebuilt by use, never salvaged. */
export const RELATION_TABLES = `
-- Decayed accepted and rejected prediction counts, scoped by pair and consumer intent.
CREATE TABLE IF NOT EXISTS relation_feedback (
  symbolId TEXT NOT NULL,
  otherId  TEXT NOT NULL,
  intent   TEXT NOT NULL,
  accepted REAL NOT NULL,
  rejected REAL NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (symbolId, otherId, intent),
  CHECK (symbolId < otherId)
);
CREATE INDEX IF NOT EXISTS relation_feedback_other ON relation_feedback(otherId);

-- Each module's exports as discovery last saw them: a JSON object of symbol id to kind and signature.
CREATE TABLE IF NOT EXISTS relation_exports (
  module  TEXT PRIMARY KEY,
  exports TEXT NOT NULL
);

-- New or changed exports waiting for discovery.
CREATE TABLE IF NOT EXISTS relation_queue (
  symbolId TEXT PRIMARY KEY,
  module   TEXT NOT NULL,
  queuedAt INTEGER NOT NULL
);

-- An export suggested to a module that does not use it, and the related symbols there that found it.
CREATE TABLE IF NOT EXISTS relation_discovery (
  module       TEXT NOT NULL,
  symbolId     TEXT NOT NULL,
  exportModule TEXT NOT NULL,
  score        REAL NOT NULL,
  via          TEXT NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (module, symbolId)
);
CREATE INDEX IF NOT EXISTS relation_discovery_symbol ON relation_discovery(symbolId);
CREATE INDEX IF NOT EXISTS relation_discovery_export ON relation_discovery(exportModule);

-- New exports nothing relates to strongly, until a model answers.
CREATE TABLE IF NOT EXISTS relation_gaps (
  symbolId   TEXT PRIMARY KEY,
  module     TEXT NOT NULL,
  at         INTEGER NOT NULL,
  answeredAt INTEGER
);
`;

/** Feedback half-life in milliseconds. */
export const FEEDBACK_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** No count grows past this, so a burst never outweighs the evidence for long. */
export const FEEDBACK_CAP = 10;

/** Counts below this on both sides are forgotten. */
const FEEDBACK_FLOOR = 0.05;

////////////////////////////////
//  Functions & Helpers

/** A pair in key order. */
export function orderedPair(a: string, b: string): [string, string] {
	return a < b ? [a, b] : [b, a];
}

/** A count `elapsed` milliseconds after it was written. */
export function decayed(count: number, elapsed: number): number {
	return count * 2 ** (-Math.max(0, elapsed) / FEEDBACK_HALF_LIFE_MS);
}

/** The only insert into the stated relations table. */
export function insertRelation(db: DatabaseSync, subjectId: string, otherId: string, row: StatedColumns): void {
	db.prepare(
		`INSERT OR REPLACE INTO symbol_relations (subjectId, otherId, recordedAs, otherAs, provenance, status,
		 revision, why, author, authoredAt, judgedBy, judgedAt, reason, digest, otherDigest)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		subjectId,
		otherId,
		row.recordedAs,
		row.otherAs,
		row.provenance,
		row.status,
		row.revision,
		row.why,
		row.author,
		row.authoredAt,
		row.judgedBy,
		row.judgedAt,
		row.reason,
		row.digest,
		row.otherDigest,
	);
}

function viaOf(text: string): string[] {
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

////////////////////////////////
//  Class

export class RelationRows {
	constructor(
		private readonly db: DatabaseSync,
		private readonly recordKnowledgeWrite: (changed: boolean) => void,
	) {}

	////////////////////////////////
	//  Stated

	/** Every stated relation either end of which stands at `symbolId`. */
	statedFor(symbolId: string): StatedRow[] {
		return this.db
			.prepare("SELECT * FROM relations_addressed WHERE symbolId = ? OR otherSymbolId = ?")
			.all(symbolId, symbolId) as unknown as StatedRow[];
	}

	statedBetween(subjectId: string, otherId: string): StatedRow | null {
		const [a, b] = orderedPair(subjectId, otherId);
		const row = this.db.prepare("SELECT * FROM relations_addressed WHERE subjectId = ? AND otherId = ?").get(a, b);
		return row === undefined ? null : (row as unknown as StatedRow);
	}

	/** A subject's digest, null before a full parse or when the subject is gone. */
	digestOf(subjectId: string): string | null {
		const row = this.db.prepare("SELECT lastDigest FROM subjects_addressed WHERE subjectId = ?").get(subjectId) as
			| { lastDigest: string | null }
			| undefined;
		return row?.lastDigest ?? null;
	}

	/** `subjectId` must be the lesser. */
	save(subjectId: string, otherId: string, row: StatedColumns): void {
		insertRelation(this.db, subjectId, otherId, row);
		this.recordKnowledgeWrite(true);
	}

	remove(subjectId: string, otherId: string): void {
		const [a, b] = orderedPair(subjectId, otherId);
		const removed = this.db.prepare("DELETE FROM symbol_relations WHERE subjectId = ? AND otherId = ?").run(a, b);
		this.recordKnowledgeWrite(removed.changes > 0);
	}

	////////////////////////////////
	//  Feedback

	/** Decayed counts for each pair holding `symbolId`, keyed by the other end; one intent's, or all summed. */
	feedbackFor(symbolId: string, intent: string | null, now: number): Map<string, FeedbackCounts> {
		const rows = this.db
			.prepare(
				`SELECT symbolId, otherId, accepted, rejected, at FROM relation_feedback
				 WHERE (symbolId = ? OR otherId = ?) AND (? IS NULL OR intent = ?)`,
			)
			.all(symbolId, symbolId, intent, intent) as Array<{
			symbolId: string;
			otherId: string;
			accepted: number;
			rejected: number;
			at: number;
		}>;
		const counts = new Map<string, FeedbackCounts>();
		for (const row of rows) {
			const other = row.symbolId === symbolId ? row.otherId : row.symbolId;
			const held = counts.get(other) ?? { accepted: 0, rejected: 0 };
			counts.set(other, {
				accepted: held.accepted + decayed(row.accepted, now - row.at),
				rejected: held.rejected + decayed(row.rejected, now - row.at),
			});
		}
		return counts;
	}

	/** One outcome more for the pair, after decaying what it held. */
	addFeedback(
		symbolId: string,
		otherId: string,
		intent: string,
		outcome: "accepted" | "rejected",
		now: number,
	): void {
		const [a, b] = orderedPair(symbolId, otherId);
		const held = this.db
			.prepare(
				"SELECT accepted, rejected, at FROM relation_feedback WHERE symbolId = ? AND otherId = ? AND intent = ?",
			)
			.get(a, b, intent) as { accepted: number; rejected: number; at: number } | undefined;
		const accepted = held === undefined ? 0 : decayed(held.accepted, now - held.at);
		const rejected = held === undefined ? 0 : decayed(held.rejected, now - held.at);
		this.db
			.prepare(
				`INSERT OR REPLACE INTO relation_feedback (symbolId, otherId, intent, accepted, rejected, at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				a,
				b,
				intent,
				Math.min(FEEDBACK_CAP, accepted + (outcome === "accepted" ? 1 : 0)),
				Math.min(FEEDBACK_CAP, rejected + (outcome === "rejected" ? 1 : 0)),
				now,
			);
	}

	/** Forgets counts that decayed away, and pairs naming a symbol the index no longer holds. */
	pruneFeedback(now: number): number {
		const rows = this.db
			.prepare(
				`SELECT f.symbolId, f.otherId, f.intent, f.accepted, f.rejected, f.at FROM relation_feedback f
				 LEFT JOIN symbols a ON a.symbolId = f.symbolId LEFT JOIN symbols b ON b.symbolId = f.otherId
				 WHERE a.symbolId IS NULL OR b.symbolId IS NULL OR f.at < ?`,
			)
			.all(now - FEEDBACK_HALF_LIFE_MS) as Array<{
			symbolId: string;
			otherId: string;
			intent: string;
			accepted: number;
			rejected: number;
			at: number;
		}>;
		const drop = this.db.prepare("DELETE FROM relation_feedback WHERE symbolId = ? AND otherId = ? AND intent = ?");
		const held = this.db.prepare("SELECT 1 FROM symbols WHERE symbolId = ?");
		let dropped = 0;
		for (const row of rows) {
			const gone = held.get(row.symbolId) === undefined || held.get(row.otherId) === undefined;
			const faded =
				decayed(row.accepted, now - row.at) < FEEDBACK_FLOOR &&
				decayed(row.rejected, now - row.at) < FEEDBACK_FLOOR;
			if (!gone && !faded) continue;
			drop.run(row.symbolId, row.otherId, row.intent);
			dropped++;
		}
		return dropped;
	}

	////////////////////////////////
	//  Exports discovery has seen

	hasExports(): boolean {
		return this.db.prepare("SELECT 1 FROM relation_exports LIMIT 1").get() !== undefined;
	}

	exportModules(): string[] {
		const rows = this.db.prepare("SELECT module FROM relation_exports ORDER BY module").all() as Array<{
			module: string;
		}>;
		return rows.map((row) => row.module);
	}

	exportsOf(module: string): Map<string, string> | null {
		const row = this.db.prepare("SELECT exports FROM relation_exports WHERE module = ?").get(module) as
			| { exports: string }
			| undefined;
		if (row === undefined) return null;
		try {
			const parsed: unknown = JSON.parse(row.exports);
			if (parsed === null || typeof parsed !== "object") return new Map();
			return new Map(
				Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			);
		} catch {
			return new Map();
		}
	}

	setExports(module: string, exports: ReadonlyMap<string, string>): void {
		this.db
			.prepare("INSERT OR REPLACE INTO relation_exports (module, exports) VALUES (?, ?)")
			.run(module, JSON.stringify(Object.fromEntries([...exports].sort(([a], [b]) => (a < b ? -1 : 1)))));
	}

	/** An export gone from its module: its suggestions, queue entry and gap. */
	forgetExport(symbolId: string): void {
		this.db.prepare("DELETE FROM relation_discovery WHERE symbolId = ?").run(symbolId);
		this.db.prepare("DELETE FROM relation_queue WHERE symbolId = ?").run(symbolId);
		this.db.prepare("DELETE FROM relation_gaps WHERE symbolId = ?").run(symbolId);
	}

	/** A module gone from the index: what discovery held about it and its exports. */
	forgetModule(module: string): void {
		this.db.prepare("DELETE FROM relation_exports WHERE module = ?").run(module);
		this.db.prepare("DELETE FROM relation_queue WHERE module = ?").run(module);
		this.db.prepare("DELETE FROM relation_gaps WHERE module = ?").run(module);
		this.db.prepare("DELETE FROM relation_discovery WHERE module = ? OR exportModule = ?").run(module, module);
	}

	////////////////////////////////
	//  Queue

	enqueue(entries: ReadonlyArray<{ symbolId: string; module: string }>, now: number): void {
		const insert = this.db.prepare(
			"INSERT OR REPLACE INTO relation_queue (symbolId, module, queuedAt) VALUES (?, ?, ?)",
		);
		for (const entry of entries) insert.run(entry.symbolId, entry.module, now);
	}

	/** The oldest waiting export. */
	nextQueued(): { symbolId: string; module: string } | null {
		const row = this.db
			.prepare("SELECT symbolId, module FROM relation_queue ORDER BY queuedAt, symbolId LIMIT 1")
			.get() as { symbolId: string; module: string } | undefined;
		return row ?? null;
	}

	dequeue(symbolId: string): void {
		this.db.prepare("DELETE FROM relation_queue WHERE symbolId = ?").run(symbolId);
	}

	queued(): number {
		return (this.db.prepare("SELECT COUNT(*) AS n FROM relation_queue").get() as { n: number }).n;
	}

	////////////////////////////////
	//  Discovery

	/** An export's suggestions replaced whole; each module keeps its `perModule` newest. */
	replaceDiscovery(
		symbolId: string,
		exportModule: string,
		rows: ReadonlyArray<{ module: string; score: number; via: readonly string[] }>,
		now: number,
		perModule: number,
	): void {
		this.db.prepare("DELETE FROM relation_discovery WHERE symbolId = ?").run(symbolId);
		const insert = this.db.prepare(
			`INSERT OR REPLACE INTO relation_discovery (module, symbolId, exportModule, score, via, at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		const trim = this.db.prepare(
			`DELETE FROM relation_discovery WHERE module = ? AND symbolId NOT IN
			 (SELECT symbolId FROM relation_discovery WHERE module = ? ORDER BY at DESC, score DESC LIMIT ?)`,
		);
		for (const row of rows) {
			insert.run(row.module, symbolId, exportModule, row.score, JSON.stringify(row.via), now);
			trim.run(row.module, row.module, perModule);
		}
	}

	/** A module's suggestions found since `since`, newest first. */
	discoveryFor(module: string, since: number): DiscoveryRow[] {
		const rows = this.db
			.prepare(
				"SELECT module, symbolId, score, via, at FROM relation_discovery WHERE module = ? AND at >= ? ORDER BY at DESC, score DESC",
			)
			.all(module, since) as Array<{ module: string; symbolId: string; score: number; via: string; at: number }>;
		return rows.map((row) => ({ ...row, via: viaOf(row.via) }));
	}

	/** Suggestions older than `before`, gone. */
	expireDiscovery(before: number): void {
		this.db.prepare("DELETE FROM relation_discovery WHERE at < ?").run(before);
	}

	////////////////////////////////
	//  Gaps

	addGap(symbolId: string, module: string, now: number): void {
		this.db
			.prepare("INSERT OR IGNORE INTO relation_gaps (symbolId, module, at, answeredAt) VALUES (?, ?, ?, NULL)")
			.run(symbolId, module, now);
	}

	/** Unanswered gaps, newest first. */
	gaps(limit: number): { rows: GapRow[]; total: number } {
		const rows = this.db
			.prepare(
				"SELECT symbolId, module, at FROM relation_gaps WHERE answeredAt IS NULL ORDER BY at DESC, symbolId LIMIT ?",
			)
			.all(limit) as unknown as GapRow[];
		const total = (
			this.db.prepare("SELECT COUNT(*) AS n FROM relation_gaps WHERE answeredAt IS NULL").get() as { n: number }
		).n;
		return { rows, total };
	}

	isOpenGap(symbolId: string): boolean {
		return (
			this.db.prepare("SELECT 1 FROM relation_gaps WHERE symbolId = ? AND answeredAt IS NULL").get(symbolId) !==
			undefined
		);
	}

	answerGap(symbolId: string, now: number): void {
		this.db.prepare("UPDATE relation_gaps SET answeredAt = ? WHERE symbolId = ?").run(now, symbolId);
	}

	/** An open gap something now relates to, gone; an answered one stays, so a model is not asked twice. */
	closeGap(symbolId: string): void {
		this.db.prepare("DELETE FROM relation_gaps WHERE symbolId = ? AND answeredAt IS NULL").run(symbolId);
	}
}
