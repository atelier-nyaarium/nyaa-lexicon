// Knowledge is about a subject; a symbol id is its current address. The one owner of the subjects
// table: rows keyed by a subject never change key, and the store reads through the views below.

import type { DatabaseSync } from "node:sqlite";
import { hashContent, moduleOf, sameNameAndKind } from "@nyaa-lexicon/protocol";
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

/** A move a reversal left standing: the subject is gone, moved on past its `to`, or another holds its `from`. */
export interface KeptRebind {
	subjectId: string;
	from: string;
	to: string;
	reason: "gone" | "movedOn" | "fromHeld";
}

export interface RebindBackResult {
	subjects: number;
	answers: number;
	gaps: number;
	kept: KeptRebind[];
}

/** What the indexer knows about a module after its last prune; the store reads no file to learn it. */
export type ModulePresence = "presentParsing" | "presentFailing" | "absent";

/** What one sweep is handed: presence per module, and the modules first indexed in the pass that ran. */
export interface SweepPass {
	presence: (module: string) => ModulePresence;
	newModules: ReadonlySet<string>;
}

/** What one sweep did. `ambiguous` counts within `orphaned`. */
export interface SweepReport {
	examined: number;
	rebound: number;
	orphaned: number;
	deleted: number;
	ambiguous: number;
	stoppedEarly: boolean;
}

/** Where a capped sweep stopped, shaped by the pass it stopped in; the epoch advances when pass A ends. */
export type SweepCursor =
	| { epoch: number; pass: "B"; after: string | null }
	| { epoch: number; pass: "A"; after: { orphanedAt: number; subjectId: string } | null };

/** A salvaged subject row with every value closed, so a row from another version cannot fail the rebuild. */
export interface SalvagedSubject {
	subjectId: string;
	symbolId: string;
	state: SubjectState;
	boundAt: number;
	orphanedAt: number | null;
	fromSymbolId: string | null;
	evidence: SubjectEvidence;
	lastDigest: string | null;
	lastCoverage: PatternCoverage | null;
}

/** A salvaged answer; `subjectId` is null for a row written by address before subjects existed. */
export interface SalvagedAnswer {
	subjectId: string | null;
	recordedAs: string;
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

/** A salvaged demand row; `subjectId` is null for a row written by address before subjects existed. */
export interface SalvagedGap {
	subjectId: string | null;
	recordedAs: string;
	question: string;
	askCount: number;
	lastAsked: number;
}

/** The salvaged knowledge in closed shapes, and how many rows were unreadable. */
export interface NormalizedSalvage {
	subjects: SalvagedSubject[];
	answers: SalvagedAnswer[];
	gaps: SalvagedGap[];
	dropped: number;
}

/** Where a salvaged row's subject is, or why it has none: another subject holds its address. */
export type Placement = { placed: true; subjectId: string } | { placed: false; reason: "held" };

/** One orphaned subject's row, for the gap window: never work, always shown with its date. */
export interface StrandedRow {
	symbolId: string;
	question: string;
	held: "answer" | "demand";
	/** An answer under a standing doubt keeps saying so. */
	doubted: boolean;
	askCount: number;
	recordedAs: string;
	orphanedAt: number;
	evidence: SubjectEvidence;
}

////////////////////////////////
//  Constants

/** An orphan this long behind the clock is deleted with its rows. */
export const ORPHAN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SWEEP_START: SweepCursor = { epoch: 0, pass: "B", after: null };

const EVIDENCE_VALUES = [
	"sameLocator",
	"journalMove",
	"journalRename",
	"batchExactMatch",
	"ambiguous",
	"none",
] as const;

/** The closed values the schema CHECKs, spelled once for every table that holds a subject's state. */
export const STATE_IN = "'bound', 'orphaned'";
export const EVIDENCE_IN = EVIDENCE_VALUES.map((value) => `'${value}'`).join(", ");

/** The knowledge tables, keyed by subject, and the views the store reads them through. */
export const KNOWLEDGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_subjects (
  subjectId        TEXT PRIMARY KEY,
  currentSymbolId  TEXT NOT NULL UNIQUE,
  state            TEXT NOT NULL CHECK (state IN (${STATE_IN})),
  boundAt          INTEGER NOT NULL,
  orphanedAt       INTEGER,
  fromSymbolId     TEXT,
  evidence         TEXT NOT NULL CHECK (evidence IN (${EVIDENCE_IN})),
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

/** Checked before the insert, so a salvaged row from another version cannot fail the rebuild. */
const EVIDENCE = new Set<string>(EVIDENCE_VALUES);

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

/** The digest the index holds at an address, so a subject minted between scans still carries one. */
function digestAt(db: DatabaseSync, symbolId: string): { digest: string; coverage: PatternCoverage } | null {
	const row = db.prepare("SELECT patternDigest, patternCoverage FROM symbols WHERE symbolId = ?").get(symbolId) as
		| { patternDigest: string | null; patternCoverage: PatternCoverage | null }
		| undefined;
	if (row === undefined || row.patternDigest === null || row.patternCoverage === null) return null;
	return { digest: row.patternDigest, coverage: row.patternCoverage };
}

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
		const digest = bound ? digestAt(db, symbolId) : null;
		insert.run(
			subjectId,
			symbolId,
			bound ? "bound" : "orphaned",
			now,
			bound ? null : now,
			null,
			"none",
			digest?.digest ?? null,
			digest?.coverage ?? null,
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

/** Every salvaged table read once into closed values; nothing past this reads a raw row. */
export function normalizeSalvaged(raw: Record<string, Array<Record<string, unknown>>>, now: number): NormalizedSalvage {
	let dropped = 0;
	const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
	// A whole number, or a numeric string from a text-typed column, or a boolean flag; else the fallback.
	const num = (value: unknown, fallback: number): number => {
		if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : fallback;
		if (typeof value === "boolean") return value ? 1 : 0;
		if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
			return Math.trunc(Number(value));
		}
		return fallback;
	};
	// The address a row was keyed by, in either shape it was written in; an empty one is none.
	const addressOf = (row: Record<string, unknown>): string | null =>
		(str(row["recordedAs"]) || null) ?? (str(row["symbolId"]) || null);
	// Citations must read back as a list of ids, or the answer cannot be recalled at all.
	const citationsOf = (value: unknown): string | null => {
		const text = str(value) ?? "[]";
		try {
			const parsed: unknown = JSON.parse(text);
			return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? text : null;
		} catch {
			return null;
		}
	};

	const subjects: SalvagedSubject[] = [];
	for (const row of raw["knowledge_subjects"] ?? []) {
		const subjectId = str(row["subjectId"]);
		const symbolId = str(row["currentSymbolId"]);
		if (subjectId === null || symbolId === null) {
			dropped++;
			continue;
		}
		const state: SubjectState = row["state"] === "orphaned" ? "orphaned" : "bound";
		const evidence = str(row["evidence"]);
		const lastDigest = str(row["lastDigest"]);
		const lastCoverage = str(row["lastCoverage"]);
		subjects.push({
			subjectId,
			symbolId,
			state,
			boundAt: num(row["boundAt"], now),
			orphanedAt: state === "orphaned" ? num(row["orphanedAt"], now) : null,
			fromSymbolId: str(row["fromSymbolId"]),
			evidence: evidence !== null && EVIDENCE.has(evidence) ? (evidence as SubjectEvidence) : "none",
			lastDigest,
			lastCoverage:
				lastDigest !== null && lastCoverage !== null && COVERAGE.has(lastCoverage)
					? (lastCoverage as PatternCoverage)
					: null,
		});
	}

	const answers: SalvagedAnswer[] = [];
	for (const row of raw["answers"] ?? []) {
		const recordedAs = addressOf(row);
		const prose = str(row["prose"]);
		const factId = str(row["factId"]);
		const citations = citationsOf(row["citations"]);
		if (recordedAs === null || prose === null || factId === null || citations === null) {
			dropped++;
			continue;
		}
		answers.push({
			subjectId: str(row["subjectId"]),
			recordedAs,
			question: str(row["question"]) ?? "describe",
			factId,
			prose,
			citations,
			thin: num(row["thin"], 0),
			model: str(row["model"]),
			createdAt: num(row["createdAt"], 0),
			doubtId: str(row["doubtId"]),
			doubtReason: str(row["doubtReason"]),
			doubtAt: num(row["doubtAt"], -1) < 0 ? null : num(row["doubtAt"], -1),
			doubtBy: str(row["doubtBy"]),
		});
	}

	const gaps: SalvagedGap[] = [];
	for (const row of raw["gaps"] ?? []) {
		const recordedAs = addressOf(row);
		if (recordedAs === null) {
			dropped++;
			continue;
		}
		gaps.push({
			subjectId: str(row["subjectId"]),
			recordedAs,
			question: str(row["question"]) ?? "describe",
			askCount: num(row["askCount"], 1),
			lastAsked: num(row["lastAsked"], 0),
		});
	}
	return { subjects, answers, gaps, dropped };
}

/** Salvaged subject rows put back as they were; every other row finds its subject through `placeRow`. */
export function restoreSubjects(db: DatabaseSync, subjects: readonly SalvagedSubject[]): void {
	const insert = db.prepare(INSERT_SUBJECT);
	for (const row of subjects) {
		insert.run(
			row.subjectId,
			row.symbolId,
			row.state,
			row.boundAt,
			row.orphanedAt,
			row.fromSymbolId,
			row.evidence,
			row.lastDigest,
			row.lastCoverage,
		);
	}
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
		const digest = digestAt(this.db, symbolId);
		this.db
			.prepare(INSERT_SUBJECT)
			.run(
				subjectId,
				symbolId,
				"bound",
				now,
				null,
				null,
				"sameLocator",
				digest?.digest ?? null,
				digest?.coverage ?? null,
			);
		return this.byId(subjectId) as Subject;
	}

	/** The subject a write lands on: minted or restored where the address resolves, the orphan kept where it does not. */
	claim(symbolId: string, now: number): Subject | null {
		const held = this.db.prepare("SELECT 1 FROM symbols WHERE symbolId = ?").get(symbolId) !== undefined;
		return held ? this.mint(symbolId, now) : this.forAddress(symbolId);
	}

	/** The one decision of which subject a salvaged row belongs to. Idempotent; two subjects never merge. */
	placeRow(row: { subjectId: string | null; recordedAs: string; at: number }): Placement {
		if (row.subjectId !== null && this.byId(row.subjectId) !== null) {
			return { placed: true, subjectId: row.subjectId };
		}
		const holder = this.forAddress(row.recordedAs);
		if (row.subjectId !== null) {
			// Its subject is gone: revived at the recorded address, or refused where another stands.
			if (holder !== null) return { placed: false, reason: "held" };
			this.db
				.prepare(INSERT_SUBJECT)
				.run(row.subjectId, row.recordedAs, "bound", row.at, null, null, "none", null, null);
			return { placed: true, subjectId: row.subjectId };
		}
		if (holder !== null) return { placed: true, subjectId: holder.subjectId };
		let subjectId = mintSubjectId(row.recordedAs, row.at);
		for (let nonce = 1; this.byId(subjectId) !== null; nonce++)
			subjectId = mintSubjectId(row.recordedAs, row.at, nonce);
		this.db.prepare(INSERT_SUBJECT).run(subjectId, row.recordedAs, "bound", row.at, null, null, "none", null, null);
		return { placed: true, subjectId };
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

	/** Puts back exactly what a rebind moved: each subject still at its `to`, to the state it had.
	 * A move it cannot put back is named, never forced: two subjects never merge. */
	rebindBack(applied: readonly AppliedRebind[]): RebindBackResult {
		let subjects = 0;
		let answers = 0;
		let gaps = 0;
		const kept: KeptRebind[] = [];
		const back = this.db.prepare(
			"UPDATE knowledge_subjects SET currentSymbolId = ?, fromSymbolId = ?, boundAt = ?, evidence = ?, state = ?, orphanedAt = ? WHERE subjectId = ?",
		);
		const countAnswers = this.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE subjectId = ?");
		const countGaps = this.db.prepare("SELECT COUNT(*) AS n FROM gaps WHERE subjectId = ?");
		// Newest move first, so a subject moved twice in one step comes all the way back.
		for (const entry of [...applied].reverse()) {
			const subject = this.byId(entry.subjectId);
			const reason =
				subject === null
					? "gone"
					: subject.symbolId !== entry.to
						? "movedOn"
						: this.forAddress(entry.from) !== null
							? "fromHeld"
							: null;
			if (reason !== null) {
				kept.push({ subjectId: entry.subjectId, from: entry.from, to: entry.to, reason });
				continue;
			}
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
		return { subjects, answers, gaps, kept };
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

	/** Bound subjects in a module take exactly the digest the index holds, null when the write carried none,
	 * so a body the index does not know never matches. */
	refreshDigests(module: string): void {
		this.db
			.prepare(
				`UPDATE knowledge_subjects
				 SET lastDigest = (SELECT patternDigest FROM symbols WHERE symbols.symbolId = knowledge_subjects.currentSymbolId),
				     lastCoverage = (SELECT patternCoverage FROM symbols WHERE symbols.symbolId = knowledge_subjects.currentSymbolId)
				 WHERE state = 'bound'
				   AND currentSymbolId IN (SELECT symbolId FROM symbols WHERE module = ?)`,
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

	/** Orphaned subjects' rows in pass A's order; for the window, never for ranking. */
	strandedRows(limit: number): StrandedRow[] {
		const rows = this.db
			.prepare(
				`SELECT subjectId, symbolId, question, 'answer' AS held, doubtId IS NOT NULL AS doubted, 0 AS askCount,
				        recordedAs, orphanedAt, evidence
				 FROM answers_addressed WHERE state = 'orphaned'
				 UNION ALL
				 SELECT subjectId, symbolId, question, 'demand' AS held, 0 AS doubted, askCount,
				        recordedAs, orphanedAt, evidence
				 FROM gaps_addressed WHERE state = 'orphaned'
				 ORDER BY orphanedAt, subjectId, question LIMIT ?`,
			)
			.all(limit) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			symbolId: row["symbolId"] as string,
			question: row["question"] as string,
			held: row["held"] as "answer" | "demand",
			doubted: row["doubted"] === 1,
			askCount: row["askCount"] as number,
			recordedAs: row["recordedAs"] as string,
			orphanedAt: row["orphanedAt"] as number,
			evidence: row["evidence"] as SubjectEvidence,
		}));
	}

	strandedCount(): number {
		return (
			this.db
				.prepare(
					`SELECT (SELECT COUNT(*) FROM answers_addressed WHERE state = 'orphaned')
					      + (SELECT COUNT(*) FROM gaps_addressed WHERE state = 'orphaned') AS n`,
				)
				.get() as { n: number }
		).n;
	}

	/** One bounded sweep in the caller's transaction: pass B judges the unresolved, pass A deletes the
	 * expired, and a cap stops it where the cursor says. */
	sweepSubjects(
		batch: number,
		pass: SweepPass,
		now: number,
		cursor: SweepCursor,
	): { report: SweepReport; cursor: SweepCursor } {
		const report: SweepReport = {
			examined: 0,
			rebound: 0,
			orphaned: 0,
			deleted: 0,
			ambiguous: 0,
			stoppedEarly: false,
		};
		let at = cursor;
		// A budget of nothing would persist the same cursor forever, so the floor is one.
		let budget = Number.isFinite(batch) ? Math.max(1, Math.floor(batch)) : 1;
		let finished = false;

		if (at.pass === "B") {
			const asked = budget;
			const rows = this.unresolvedAfter(at.after, asked);
			for (const subject of rows) {
				this.judge(subject, pass, now, report);
				report.examined++;
				budget--;
				at = { epoch: at.epoch, pass: "B", after: subject.subjectId };
			}
			// Fewer than asked is the end of the pass.
			if (rows.length < asked) at = { epoch: at.epoch, pass: "A", after: null };
		}

		if (at.pass === "A" && budget > 0) {
			const asked = budget;
			const rows = this.orphanedAfter(at.after, asked);
			for (const subject of rows) {
				const orphanedAt = subject.orphanedAt as number;
				// A date ahead of the clock reads as now, so a clock that went backwards deletes nothing early.
				if (now - Math.min(orphanedAt, now) >= ORPHAN_TTL_MS) {
					this.delete(subject.subjectId);
					report.deleted++;
				}
				report.examined++;
				budget--;
				at = { epoch: at.epoch, pass: "A", after: { orphanedAt, subjectId: subject.subjectId } };
			}
			if (rows.length < asked) {
				at = { epoch: at.epoch + 1, pass: "B", after: null };
				finished = true;
			}
		}

		report.stoppedEarly = !finished;
		return { report, cursor: at };
	}

	/** Exempt when its module is present and failing; rebound on exactly one digest match the address is free for; orphaned otherwise. */
	private judge(subject: Subject, pass: SweepPass, now: number, report: SweepReport): void {
		const module = moduleOf(subject.symbolId);
		if (module !== null && pass.presence(module) === "presentFailing") return;

		const matches = this.digestMatches(subject, pass.newModules);
		if (matches.length === 1) {
			const { applied } = this.rebind(
				[{ from: subject.symbolId, to: matches[0] as string }],
				"batchExactMatch",
				now,
			);
			if (applied.length === 1) {
				report.rebound++;
				return;
			}
		}
		const ambiguous = matches.length >= 1;
		this.orphan(subject.subjectId, now, ambiguous ? "ambiguous" : "none");
		report.orphaned++;
		if (ambiguous) report.ambiguous++;
	}

	/** Declarations among the new modules carrying the subject's digest, coverage, name and kind. */
	private digestMatches(subject: Subject, newModules: ReadonlySet<string>): string[] {
		if (subject.lastDigest === null || subject.lastCoverage === null || newModules.size === 0) return [];
		const rows = this.db
			.prepare(
				"SELECT symbolId, module FROM symbols WHERE patternDigest = ? AND patternCoverage = ? ORDER BY symbolId",
			)
			.all(subject.lastDigest, subject.lastCoverage) as Array<{ symbolId: string; module: string }>;
		return rows
			.filter((row) => newModules.has(row.module) && sameNameAndKind(subject.symbolId, row.symbolId))
			.map((row) => row.symbolId);
	}

	private unresolvedAfter(after: string | null, limit: number): Subject[] {
		const rows = this.db
			.prepare(
				`SELECT s.* FROM knowledge_subjects s LEFT JOIN symbols y ON y.symbolId = s.currentSymbolId
				 WHERE s.state = 'bound' AND y.symbolId IS NULL AND (? IS NULL OR s.subjectId > ?)
				 ORDER BY s.subjectId LIMIT ?`,
			)
			.all(after, after, limit);
		return rows.map((row) => rowToSubject(row as Record<string, unknown>));
	}

	/** Strictly after the key on the pass's own order, so subjects sharing a date advance past it. */
	private orphanedAfter(after: { orphanedAt: number; subjectId: string } | null, limit: number): Subject[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM knowledge_subjects WHERE state = 'orphaned'
				 AND (? IS NULL OR orphanedAt > ? OR (orphanedAt = ? AND subjectId > ?))
				 ORDER BY orphanedAt, subjectId LIMIT ?`,
			)
			.all(
				after?.orphanedAt ?? null,
				after?.orphanedAt ?? null,
				after?.orphanedAt ?? null,
				after?.subjectId ?? null,
				limit,
			);
		return rows.map((row) => rowToSubject(row as Record<string, unknown>));
	}
}
