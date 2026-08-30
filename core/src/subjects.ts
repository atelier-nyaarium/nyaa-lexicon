// Knowledge is about a subject; a symbol id is its current address. The one owner of the subjects
// table: rows keyed by a subject never change key, and the store reads through the views below.

import type { DatabaseSync } from "node:sqlite";
import { hashContent, moduleOf } from "@nyaa-lexicon/protocol";
import type { PatternCoverage } from "./patternDigest.js";

////////////////////////////////
//  Interfaces & Types

export type SubjectState = "bound" | "orphaned";

export type SubjectEvidence =
	| "sameLocator"
	| "journalMove"
	| "journalRename"
	| "batchExactMatch"
	| "ambiguous"
	| "none";

/** What a rebind can claim; the other two values describe why an address stopped resolving. */
export type RebindEvidence = Exclude<SubjectEvidence, "ambiguous" | "none">;

export interface Subject {
	subjectId: string;
	/** The current address, kept across orphaning so the subject can be found again. */
	symbolId: string;
	state: SubjectState;
	boundAt: number;
	orphanedAt: number | null;
	/** The address vacated by the last rebind. */
	fromSymbolId: string | null;
	evidence: SubjectEvidence;
	lastDigest: string | null;
	lastCoverage: PatternCoverage | null;
}

/** What stands at an address, in one read each: for a refusal to say and a recall to carry. */
export interface SubjectStatus {
	subject: string | null;
	state: SubjectState | "none";
	/** Whether the index holds a declaration at the address. */
	resolves: boolean;
	orphanedAt: number | null;
	/** The subject's evidence, or the forwarding subject's when the address was vacated. */
	evidence: SubjectEvidence | null;
	/** The address the subject that vacated this one now holds. */
	forwardedTo: string | null;
	/** The address's module is present and failing to parse, so nothing about it is judged. */
	exempt: boolean;
	reason: string | null;
	answers: number;
	gaps: number;
}

export interface RebindEntry {
	from: string;
	to: string;
}

/** One move a rebind made, with the state it replaced, so a reversal restores exactly that. */
export interface AppliedRebind {
	subjectId: string;
	from: string;
	to: string;
	priorFrom: string | null;
	priorEvidence: SubjectEvidence;
	priorBoundAt: number;
	priorState: SubjectState;
	priorOrphanedAt: number | null;
}

export interface RebindResult {
	subjects: number;
	answers: number;
	gaps: number;
	applied: AppliedRebind[];
}

////////////////////////////////
//  Constants

/** The knowledge tables, keyed by subject, and the views the store reads them through. */
export const KNOWLEDGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_subjects (
  subjectId        TEXT PRIMARY KEY,
  currentSymbolId  TEXT NOT NULL UNIQUE,
  state            TEXT NOT NULL CHECK (state IN ('bound', 'orphaned')),
  boundAt          INTEGER NOT NULL,
  orphanedAt       INTEGER,
  fromSymbolId     TEXT,
  evidence         TEXT NOT NULL CHECK (evidence IN ('sameLocator', 'journalMove', 'journalRename', 'batchExactMatch', 'ambiguous', 'none')),
  lastDigest       TEXT,
  lastCoverage     TEXT CHECK (lastCoverage IN ('commentsStripped', 'commentsKept')),
  CHECK ((state = 'bound' AND orphanedAt IS NULL) OR (state = 'orphaned' AND orphanedAt IS NOT NULL)),
  CHECK (lastCoverage IS NULL OR lastDigest IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS knowledge_subjects_orphaned ON knowledge_subjects(orphanedAt);
CREATE INDEX IF NOT EXISTS knowledge_subjects_state ON knowledge_subjects(state);
CREATE INDEX IF NOT EXISTS knowledge_subjects_from ON knowledge_subjects(fromSymbolId);

-- Prose about a subject, cited from facts. recordedAs is the address at record time, never
-- rewritten, because the answer's own id digests it.
CREATE TABLE IF NOT EXISTS answers (
  subjectId   TEXT NOT NULL,
  question    TEXT NOT NULL,
  recordedAs  TEXT NOT NULL,
  factId      TEXT NOT NULL UNIQUE,
  prose       TEXT NOT NULL,
  citations   TEXT NOT NULL,
  thin        INTEGER NOT NULL DEFAULT 0,
  model       TEXT,
  createdAt   INTEGER NOT NULL,
  doubtId     TEXT,
  doubtReason TEXT,
  doubtAt     INTEGER,
  doubtBy     TEXT,
  PRIMARY KEY (subjectId, question)
);

-- Demand for knowledge nobody has written, counted per ask.
CREATE TABLE IF NOT EXISTS gaps (
  subjectId  TEXT NOT NULL,
  question   TEXT NOT NULL,
  recordedAs TEXT NOT NULL,
  askCount   INTEGER NOT NULL,
  lastAsked  INTEGER NOT NULL,
  PRIMARY KEY (subjectId, question)
);

-- A key never changes: identity moves by rebinding the subject's address and by nothing else.
CREATE TRIGGER IF NOT EXISTS knowledge_subjects_key_frozen BEFORE UPDATE OF subjectId ON knowledge_subjects
  BEGIN SELECT RAISE(ABORT, 'knowledge_subjects.subjectId never changes'); END;
CREATE TRIGGER IF NOT EXISTS answers_key_frozen BEFORE UPDATE OF subjectId ON answers
  BEGIN SELECT RAISE(ABORT, 'answers.subjectId never changes'); END;
CREATE TRIGGER IF NOT EXISTS gaps_key_frozen BEFORE UPDATE OF subjectId ON gaps
  BEGIN SELECT RAISE(ABORT, 'gaps.subjectId never changes'); END;

CREATE VIEW IF NOT EXISTS subjects_addressed AS
  SELECT subjectId, currentSymbolId AS symbolId, state, boundAt, orphanedAt, fromSymbolId, evidence, lastDigest, lastCoverage
  FROM knowledge_subjects;
CREATE VIEW IF NOT EXISTS answers_addressed AS
  SELECT a.*, s.currentSymbolId AS symbolId, s.state, s.orphanedAt, s.evidence, s.boundAt
  FROM answers a JOIN knowledge_subjects s ON s.subjectId = a.subjectId;
CREATE VIEW IF NOT EXISTS gaps_addressed AS
  SELECT g.*, s.currentSymbolId AS symbolId, s.state, s.orphanedAt, s.evidence
  FROM gaps g JOIN knowledge_subjects s ON s.subjectId = g.subjectId;

-- Work: rows whose address the index holds. A ranking reader reads these and cannot see a dead address.
CREATE VIEW IF NOT EXISTS answers_live AS
  SELECT a.* FROM answers_addressed a JOIN symbols y ON y.symbolId = a.symbolId;
CREATE VIEW IF NOT EXISTS gaps_live AS
  SELECT g.* FROM gaps_addressed g JOIN symbols y ON y.symbolId = g.symbolId;
`;

/** The view names, so a rebuild can drop them before the tables they read. */
export const KNOWLEDGE_VIEWS = [
	"subjects_addressed",
	"answers_addressed",
	"gaps_addressed",
	"answers_live",
	"gaps_live",
] as const;

/** The tables a rebuild salvages, subjects first so the rows that key by them restore after. */
export const KNOWLEDGE_TABLES = ["knowledge_subjects", "answers", "gaps"] as const;

/** The closed values the schema CHECKs, so a salvaged row from another version cannot fail the rebuild. */
const EVIDENCE = new Set<string>([
	"sameLocator",
	"journalMove",
	"journalRename",
	"batchExactMatch",
	"ambiguous",
	"none",
]);

const COVERAGE = new Set<string>(["commentsStripped", "commentsKept"]);

////////////////////////////////
//  Functions & Helpers

/** Minted once from the first address and the clock; opaque afterwards. The nonce separates a
 * reused address minted in the same millisecond as its first subject. */
export function mintSubjectId(symbolId: string, at: number, nonce = 0): string {
	return hashContent(nonce === 0 ? `${symbolId}\n${at}` : `${symbolId}\n${at}\n${nonce}`);
}

function rowToSubject(row: Record<string, unknown>): Subject {
	return {
		subjectId: row["subjectId"] as string,
		symbolId: row["currentSymbolId"] as string,
		state: row["state"] as SubjectState,
		boundAt: row["boundAt"] as number,
		orphanedAt: (row["orphanedAt"] as number | null) ?? null,
		fromSymbolId: (row["fromSymbolId"] as string | null) ?? null,
		evidence: row["evidence"] as SubjectEvidence,
		lastDigest: (row["lastDigest"] as string | null) ?? null,
		lastCoverage: (row["lastCoverage"] as PatternCoverage | null) ?? null,
	};
}

const INSERT_SUBJECT = `INSERT INTO knowledge_subjects
 (subjectId, currentSymbolId, state, boundAt, orphanedAt, fromSymbolId, evidence, lastDigest, lastCoverage)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** In the caller's transaction. One subject per address; rows keep their fact ids, so citations still resolve. */
export function rekeyKnowledge(db: DatabaseSync, now: number): void {
	// A rename rewrites any view over the table; none should exist here, and none may survive it.
	for (const view of KNOWLEDGE_VIEWS) db.exec(`DROP VIEW IF EXISTS "${view}"`);
	db.exec("ALTER TABLE answers RENAME TO answers_by_address");
	db.exec("ALTER TABLE gaps RENAME TO gaps_by_address");
	db.exec(KNOWLEDGE_SCHEMA);

	const addresses = db
		.prepare("SELECT symbolId FROM answers_by_address UNION SELECT symbolId FROM gaps_by_address ORDER BY symbolId")
		.all() as Array<{ symbolId: string }>;
	const held = db.prepare("SELECT 1 FROM symbols WHERE symbolId = ?");
	const insert = db.prepare(INSERT_SUBJECT);
	const subjects = new Map<string, string>();
	for (const { symbolId } of addresses) {
		const subjectId = mintSubjectId(symbolId, now);
		const bound = held.get(symbolId) !== undefined;
		insert.run(
			subjectId,
			symbolId,
			bound ? "bound" : "orphaned",
			now,
			bound ? null : now,
			null,
			"none",
			null,
			null,
		);
		subjects.set(symbolId, subjectId);
	}

	const answer = db.prepare(
		`INSERT INTO answers (subjectId, question, recordedAs, factId, prose, citations, thin, model, createdAt,
		 doubtId, doubtReason, doubtAt, doubtBy)
		 SELECT ?, question, symbolId, factId, prose, citations, thin, model, createdAt, doubtId, doubtReason, doubtAt, doubtBy
		 FROM answers_by_address WHERE symbolId = ?`,
	);
	const gap = db.prepare(
		`INSERT INTO gaps (subjectId, question, recordedAs, askCount, lastAsked)
		 SELECT ?, question, symbolId, askCount, lastAsked FROM gaps_by_address WHERE symbolId = ?`,
	);
	for (const [symbolId, subjectId] of subjects) {
		answer.run(subjectId, symbolId);
		gap.run(subjectId, symbolId);
	}

	db.exec("DROP TABLE answers_by_address");
	db.exec("DROP TABLE gaps_by_address");
}

/** A subject restores as it was; an address-keyed row gets one minted, bound, for the sweep to judge;
 * a subject-keyed row whose subject row is gone gets it back, same id, at the recorded address. */
export function restoreSubjects(
	db: DatabaseSync,
	salvaged: Record<string, Array<Record<string, unknown>>>,
	addresses: Iterable<string>,
	now: number,
	keyed: Iterable<{ subjectId: string; symbolId: string }> = [],
): Map<string, string> {
	const insert = db.prepare(INSERT_SUBJECT);
	const known = new Map<string, string>();
	for (const row of salvaged["knowledge_subjects"] ?? []) {
		const subjectId = row["subjectId"];
		const symbolId = row["currentSymbolId"];
		if (typeof subjectId !== "string" || typeof symbolId !== "string") continue;
		const state = row["state"] === "orphaned" ? "orphaned" : "bound";
		const evidence = row["evidence"];
		const lastDigest = typeof row["lastDigest"] === "string" ? row["lastDigest"] : null;
		const lastCoverage = row["lastCoverage"];
		insert.run(
			subjectId,
			symbolId,
			state,
			typeof row["boundAt"] === "number" ? row["boundAt"] : now,
			state === "orphaned" ? (typeof row["orphanedAt"] === "number" ? row["orphanedAt"] : now) : null,
			typeof row["fromSymbolId"] === "string" ? row["fromSymbolId"] : null,
			typeof evidence === "string" && EVIDENCE.has(evidence) ? evidence : "none",
			lastDigest,
			lastDigest !== null && typeof lastCoverage === "string" && COVERAGE.has(lastCoverage) ? lastCoverage : null,
		);
		known.set(symbolId, subjectId);
	}
	for (const symbolId of addresses) {
		if (known.has(symbolId)) continue;
		const subjectId = mintSubjectId(symbolId, now);
		insert.run(subjectId, symbolId, "bound", now, null, null, "none", null, null);
		known.set(symbolId, subjectId);
	}
	const ids = new Set(known.values());
	for (const { subjectId, symbolId } of keyed) {
		if (ids.has(subjectId) || known.has(symbolId)) continue;
		insert.run(subjectId, symbolId, "bound", now, null, null, "none", null, null);
		known.set(symbolId, subjectId);
		ids.add(subjectId);
	}
	return known;
}

////////////////////////////////
//  Class

/** Takes the store's handle: every statement here runs inside whatever transaction the store holds. */
export class KnowledgeSubjects {
	constructor(private readonly db: DatabaseSync) {}

	/** Bound or orphaned alike, since the address is kept. */
	forAddress(symbolId: string): Subject | null {
		const row = this.db.prepare("SELECT * FROM knowledge_subjects WHERE currentSymbolId = ?").get(symbolId);
		return row === undefined ? null : rowToSubject(row as Record<string, unknown>);
	}

	byId(subjectId: string): Subject | null {
		const row = this.db.prepare("SELECT * FROM knowledge_subjects WHERE subjectId = ?").get(subjectId);
		return row === undefined ? null : rowToSubject(row as Record<string, unknown>);
	}

	/** Only the last vacated address of a subject forwards; one two rebinds old names no row and reads as unminted. */
	stateOf(symbolId: string, failureOf: (module: string) => string | null): SubjectStatus {
		const subject = this.forAddress(symbolId);
		const forwarded = subject === null ? this.forwardedFrom(symbolId) : null;
		const resolves = this.db.prepare("SELECT 1 FROM symbols WHERE symbolId = ?").get(symbolId) !== undefined;
		const module = moduleOf(symbolId);
		const reason = module === null ? null : failureOf(module);
		const count = (table: "answers" | "gaps"): number =>
			subject === null
				? 0
				: (
						this.db
							.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE subjectId = ?`)
							.get(subject.subjectId) as { n: number }
					).n;
		return {
			subject: subject?.subjectId ?? null,
			state: subject?.state ?? "none",
			resolves,
			orphanedAt: subject?.orphanedAt ?? null,
			evidence: subject?.evidence ?? forwarded?.evidence ?? null,
			forwardedTo: forwarded?.symbolId ?? null,
			exempt: reason !== null,
			reason,
			answers: count("answers"),
			gaps: count("gaps"),
		};
	}

	/** The subject that vacated an address by its last rebind; the most recently bound one when several did. */
	forwardedFrom(symbolId: string): Subject | null {
		const row = this.db
			.prepare("SELECT * FROM knowledge_subjects WHERE fromSymbolId = ? ORDER BY boundAt DESC LIMIT 1")
			.get(symbolId);
		return row === undefined ? null : rowToSubject(row as Record<string, unknown>);
	}

	/** A new bound subject at an address nothing holds; an orphan kept there is restored instead. */
	mint(symbolId: string, now: number): Subject {
		const existing = this.forAddress(symbolId);
		if (existing !== null) return existing.state === "orphaned" ? this.restore(existing.subjectId, now) : existing;
		let subjectId = mintSubjectId(symbolId, now);
		for (let nonce = 1; this.byId(subjectId) !== null; nonce++) subjectId = mintSubjectId(symbolId, now, nonce);
		this.db.prepare(INSERT_SUBJECT).run(subjectId, symbolId, "bound", now, null, null, "sameLocator", null, null);
		return this.byId(subjectId) as Subject;
	}

	/** The subject a write lands on: minted or restored where the address resolves, the orphan kept where it does not. */
	claim(symbolId: string, now: number): Subject | null {
		const held = this.db.prepare("SELECT 1 FROM symbols WHERE symbolId = ?").get(symbolId) !== undefined;
		return held ? this.mint(symbolId, now) : this.forAddress(symbolId);
	}

	/** An orphan whose address resolves again. */
	restore(subjectId: string, now: number): Subject {
		this.db
			.prepare(
				"UPDATE knowledge_subjects SET state = 'bound', boundAt = ?, orphanedAt = NULL, evidence = 'sameLocator' WHERE subjectId = ?",
			)
			.run(now, subjectId);
		return this.byId(subjectId) as Subject;
	}

	/** The address stopped resolving. The address and the rows stay. */
	orphan(subjectId: string, now: number, evidence: "ambiguous" | "none"): void {
		this.db
			.prepare(
				"UPDATE knowledge_subjects SET state = 'orphaned', orphanedAt = ?, evidence = ? WHERE subjectId = ?",
			)
			.run(now, evidence, subjectId);
	}

	/** Moves subjects to new addresses; rows never move. An entry whose `from` holds no subject, or
	 * whose `to` holds one, is a no-op, so a replay is safe and a merge is impossible. */
	rebind(entries: RebindEntry[], evidence: RebindEvidence, now: number): RebindResult {
		const applied: AppliedRebind[] = [];
		let answers = 0;
		let gaps = 0;
		const move = this.db.prepare(
			"UPDATE knowledge_subjects SET currentSymbolId = ?, fromSymbolId = ?, boundAt = ?, state = 'bound', orphanedAt = NULL, evidence = ? WHERE subjectId = ?",
		);
		const countAnswers = this.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE subjectId = ?");
		const countGaps = this.db.prepare("SELECT COUNT(*) AS n FROM gaps WHERE subjectId = ?");
		for (const { from, to } of entries) {
			if (from === to) continue;
			const subject = this.forAddress(from);
			if (subject === null || this.forAddress(to) !== null) continue;
			move.run(to, from, now, evidence, subject.subjectId);
			applied.push({
				subjectId: subject.subjectId,
				from,
				to,
				priorFrom: subject.fromSymbolId,
				priorEvidence: subject.evidence,
				priorBoundAt: subject.boundAt,
				priorState: subject.state,
				priorOrphanedAt: subject.orphanedAt,
			});
			answers += (countAnswers.get(subject.subjectId) as { n: number }).n;
			gaps += (countGaps.get(subject.subjectId) as { n: number }).n;
		}
		return { subjects: applied.length, answers, gaps, applied };
	}

	/** Puts back exactly what a rebind moved: each subject still at its `to`, to the state it had,
	 * unless something else now holds its `from`. A replay finds nothing at `to` and does nothing. */
	rebindBack(applied: AppliedRebind[]): RebindResult {
		let subjects = 0;
		let answers = 0;
		let gaps = 0;
		const back = this.db.prepare(
			"UPDATE knowledge_subjects SET currentSymbolId = ?, fromSymbolId = ?, boundAt = ?, evidence = ?, state = ?, orphanedAt = ? WHERE subjectId = ?",
		);
		const countAnswers = this.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE subjectId = ?");
		const countGaps = this.db.prepare("SELECT COUNT(*) AS n FROM gaps WHERE subjectId = ?");
		for (const entry of applied) {
			const subject = this.byId(entry.subjectId);
			if (subject === null || subject.symbolId !== entry.to || this.forAddress(entry.from) !== null) continue;
			back.run(
				entry.from,
				entry.priorFrom,
				entry.priorBoundAt,
				entry.priorEvidence,
				entry.priorState,
				entry.priorOrphanedAt,
				entry.subjectId,
			);
			subjects++;
			answers += (countAnswers.get(entry.subjectId) as { n: number }).n;
			gaps += (countGaps.get(entry.subjectId) as { n: number }).n;
		}
		return { subjects, answers, gaps, applied: [] };
	}

	/** The subject and its rows, gone. */
	delete(subjectId: string): void {
		this.db.prepare("DELETE FROM answers WHERE subjectId = ?").run(subjectId);
		this.db.prepare("DELETE FROM gaps WHERE subjectId = ?").run(subjectId);
		this.db.prepare("DELETE FROM knowledge_subjects WHERE subjectId = ?").run(subjectId);
	}

	/** Orphans whose kept address the module holds again are bound: the address resolves, so nothing was lost. */
	restoreResolving(module: string, now: number): void {
		this.db
			.prepare(
				`UPDATE knowledge_subjects SET state = 'bound', orphanedAt = NULL, boundAt = ?, evidence = 'sameLocator'
				 WHERE state = 'orphaned' AND currentSymbolId IN (SELECT symbolId FROM symbols WHERE module = ?)`,
			)
			.run(now, module);
	}

	/** Copies a module's fresh pattern digests onto the bound subjects addressed in it. */
	refreshDigests(module: string): void {
		this.db
			.prepare(
				`UPDATE knowledge_subjects
				 SET lastDigest = (SELECT patternDigest FROM symbols WHERE symbols.symbolId = knowledge_subjects.currentSymbolId),
				     lastCoverage = (SELECT patternCoverage FROM symbols WHERE symbols.symbolId = knowledge_subjects.currentSymbolId)
				 WHERE state = 'bound'
				   AND currentSymbolId IN (SELECT symbolId FROM symbols WHERE module = ? AND patternDigest IS NOT NULL)`,
			)
			.run(module);
	}

	/** Bound subjects whose address no longer resolves, oldest first. */
	unresolved(limit: number): Subject[] {
		const rows = this.db
			.prepare(
				`SELECT s.* FROM knowledge_subjects s LEFT JOIN symbols y ON y.symbolId = s.currentSymbolId
				 WHERE s.state = 'bound' AND y.symbolId IS NULL ORDER BY s.subjectId LIMIT ?`,
			)
			.all(limit);
		return rows.map((row) => rowToSubject(row as Record<string, unknown>));
	}

	orphaned(limit: number): Subject[] {
		const rows = this.db
			.prepare("SELECT * FROM knowledge_subjects WHERE state = 'orphaned' ORDER BY orphanedAt, subjectId LIMIT ?")
			.all(limit);
		return rows.map((row) => rowToSubject(row as Record<string, unknown>));
	}

	orphanedCount(): number {
		return (
			this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_subjects WHERE state = 'orphaned'").get() as {
				n: number;
			}
		).n;
	}
}
