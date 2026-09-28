// Note rows: the notes table, its links and pending proposals, read and written by subject. Rows
// only; what a note means and whether a write stands lives in the note ledger.

import type { DatabaseSync } from "node:sqlite";
import type { NoteField } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export interface NoteFieldValues {
	summary: string | null;
	description: string | null;
	why: string | null;
	gotchas: string | null;
}

/** A note row at its subject's current address, with the subject's current digest. */
export interface NoteRow extends NoteFieldValues {
	subjectId: string;
	symbolId: string;
	recordedAs: string;
	revision: number;
	author: string | null;
	authoredAt: number;
	editedBy: string | null;
	editedAt: number;
	confirmedBy: string | null;
	confirmedAt: number | null;
	sourceDigest: string | null;
	doubtBy: string | null;
	doubtReason: string | null;
	doubtAt: number | null;
	/** The subject's digest now; null before a full parse. */
	lastDigest: string | null;
}

export interface NoteLinkRow {
	field: NoteField;
	written: string;
	/** A subject id, or `module:<path>`. */
	target: string;
	targetDigest: string | null;
}

export interface NoteProposalRow extends NoteFieldValues {
	baseRevision: number;
	proposedBy: string | null;
	proposedAt: number;
}

/** A target that names a whole module rather than a subject. */
export const MODULE_TARGET = "module:";

/** Marks a pending proposal's links, which share the table with the note's own. */
const PROPOSED = "proposal:";

/** A describe answer that restates the declaration. */
const RESTATED = /^(A|An|The) .* (declared|declaration)\b/i;

const SUMMARY_SEED_MAX = 300;

////////////////////////////////
//  Functions & Helpers

/**
 * In the caller's transaction. Each describe answer not restating its declaration seeds a note
 * where none stands: one line as the summary, more as the description. Self-reported authors
 * on answers are cleared, since nothing attested them.
 */
export function seedNotesFromAnswers(db: DatabaseSync): number {
	const rows = db
		.prepare(
			`SELECT a.subjectId, a.recordedAs, a.prose, a.createdAt, s.lastDigest
			 FROM answers a JOIN subjects_addressed s ON s.subjectId = a.subjectId
			 WHERE a.question = 'describe' AND NOT EXISTS (SELECT 1 FROM symbol_notes n WHERE n.subjectId = a.subjectId)`,
		)
		.all() as Array<{
		subjectId: string;
		recordedAs: string;
		prose: string;
		createdAt: number;
		lastDigest: string | null;
	}>;
	const insert = db.prepare(
		`INSERT INTO symbol_notes (subjectId, recordedAs, revision, summary, description, authoredAt, editedAt, sourceDigest)
		 VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
	);
	let seeded = 0;
	for (const row of rows) {
		const prose = row.prose.trim();
		if (prose === "" || RESTATED.test(prose)) continue;
		const oneLine = !prose.includes("\n") && prose.length <= SUMMARY_SEED_MAX;
		insert.run(
			row.subjectId,
			row.recordedAs,
			oneLine ? prose : null,
			oneLine ? null : prose,
			row.createdAt,
			row.createdAt,
			row.lastDigest,
		);
		seeded++;
	}
	db.exec("UPDATE answers SET model = NULL, doubtBy = NULL WHERE model IS NOT NULL OR doubtBy IS NOT NULL");
	return seeded;
}

////////////////////////////////
//  Class

export class NoteRows {
	constructor(
		private readonly db: DatabaseSync,
		private readonly recordKnowledgeWrite: (changed: boolean) => void,
	) {}

	byAddress(symbolId: string): NoteRow | null {
		const row = this.db.prepare("SELECT * FROM notes_addressed WHERE symbolId = ?").get(symbolId);
		return row === undefined ? null : (row as unknown as NoteRow);
	}

	links(subjectId: string): NoteLinkRow[] {
		return this.db
			.prepare(
				`SELECT field, written, target, targetDigest FROM symbol_note_links
				 WHERE subjectId = ? AND field NOT LIKE '${PROPOSED}%' ORDER BY rowid`,
			)
			.all(subjectId) as unknown as NoteLinkRow[];
	}

	/** The pending proposal's links, by the field they sit in. */
	proposalLinks(subjectId: string): NoteLinkRow[] {
		const rows = this.db
			.prepare(
				`SELECT field, written, target, targetDigest FROM symbol_note_links
				 WHERE subjectId = ? AND field LIKE '${PROPOSED}%' ORDER BY rowid`,
			)
			.all(subjectId) as unknown as NoteLinkRow[];
		return rows.map((row) => ({ ...row, field: row.field.slice(PROPOSED.length) as NoteField }));
	}

	proposal(subjectId: string): NoteProposalRow | null {
		const row = this.db.prepare("SELECT * FROM symbol_note_proposals WHERE subjectId = ?").get(subjectId);
		return row === undefined ? null : (row as unknown as NoteProposalRow);
	}

	/** The subject's current digest, for a target or the note's own subject. */
	digestOf(subjectId: string): string | null {
		const row = this.db.prepare("SELECT lastDigest FROM subjects_addressed WHERE subjectId = ?").get(subjectId) as
			| { lastDigest: string | null }
			| undefined;
		return row?.lastDigest ?? null;
	}

	/** A target subject's current address and state; null when it is gone. */
	subjectAt(subjectId: string): { symbolId: string; state: "bound" | "orphaned" } | null {
		const row = this.db
			.prepare("SELECT symbolId, state FROM subjects_addressed WHERE subjectId = ?")
			.get(subjectId) as { symbolId: string; state: "bound" | "orphaned" } | undefined;
		return row ?? null;
	}

	/** Replaces the note and its links whole. */
	save(
		subjectId: string,
		note: Omit<NoteRow, "subjectId" | "symbolId" | "lastDigest">,
		links: readonly NoteLinkRow[],
	): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO symbol_notes (subjectId, recordedAs, revision, summary, description, why, gotchas,
				 author, authoredAt, editedBy, editedAt, confirmedBy, confirmedAt, sourceDigest, doubtBy, doubtReason, doubtAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				subjectId,
				note.recordedAs,
				note.revision,
				note.summary,
				note.description,
				note.why,
				note.gotchas,
				note.author,
				note.authoredAt,
				note.editedBy,
				note.editedAt,
				note.confirmedBy,
				note.confirmedAt,
				note.sourceDigest,
				note.doubtBy,
				note.doubtReason,
				note.doubtAt,
			);
		this.replaceLinks(subjectId, links);
		this.recordKnowledgeWrite(true);
	}

	/** The note, its links and any proposal, gone. */
	remove(subjectId: string): void {
		const note = this.db.prepare("DELETE FROM symbol_notes WHERE subjectId = ?").run(subjectId);
		this.db.prepare("DELETE FROM symbol_note_links WHERE subjectId = ?").run(subjectId);
		this.db.prepare("DELETE FROM symbol_note_proposals WHERE subjectId = ?").run(subjectId);
		this.recordKnowledgeWrite(note.changes > 0);
	}

	/** Confirmation re-reads every digest, so what moved before it no longer shows. */
	confirm(
		subjectId: string,
		by: string | null,
		at: number,
		sourceDigest: string | null,
		links: readonly NoteLinkRow[],
	): void {
		this.db
			.prepare(
				`UPDATE symbol_notes SET confirmedBy = ?, confirmedAt = ?, sourceDigest = ?,
				 doubtBy = NULL, doubtReason = NULL, doubtAt = NULL WHERE subjectId = ?`,
			)
			.run(by, at, sourceDigest, subjectId);
		this.replaceLinks(subjectId, links);
		this.recordKnowledgeWrite(true);
	}

	doubt(subjectId: string, by: string | null, reason: string, at: number): void {
		this.db
			.prepare("UPDATE symbol_notes SET doubtBy = ?, doubtReason = ?, doubtAt = ? WHERE subjectId = ?")
			.run(by, reason, at, subjectId);
		this.recordKnowledgeWrite(true);
	}

	propose(subjectId: string, proposal: NoteProposalRow, links: readonly NoteLinkRow[]): void {
		this.replaceLinks(
			subjectId,
			links.map((link) => ({ ...link, field: `${PROPOSED}${link.field}` as NoteField })),
			PROPOSED,
		);
		this.db
			.prepare(
				`INSERT OR REPLACE INTO symbol_note_proposals (subjectId, baseRevision, summary, description, why, gotchas,
				 proposedBy, proposedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				subjectId,
				proposal.baseRevision,
				proposal.summary,
				proposal.description,
				proposal.why,
				proposal.gotchas,
				proposal.proposedBy,
				proposal.proposedAt,
			);
		this.recordKnowledgeWrite(true);
	}

	dropProposal(subjectId: string): void {
		const dropped = this.db.prepare("DELETE FROM symbol_note_proposals WHERE subjectId = ?").run(subjectId);
		this.replaceLinks(subjectId, [], PROPOSED);
		this.recordKnowledgeWrite(dropped.changes > 0);
	}

	/** Notes whose refs name `target`, newest edit first, with the fields that name it. */
	backlinks(
		target: string,
		limit: number,
	): { notes: Array<{ symbolId: string; summary: string | null; fields: NoteField[] }>; total: number } {
		const rows = this.db
			.prepare(
				`SELECT n.symbolId, n.summary, group_concat(DISTINCT l.field) AS fields
				 FROM symbol_note_links l JOIN notes_addressed n ON n.subjectId = l.subjectId
				 WHERE l.target = ? AND l.field NOT LIKE '${PROPOSED}%'
				 GROUP BY n.subjectId ORDER BY n.editedAt DESC`,
			)
			.all(target) as Array<{ symbolId: string; summary: string | null; fields: string }>;
		return {
			notes: rows.slice(0, limit).map((row) => ({
				symbolId: row.symbolId,
				summary: row.summary,
				fields: row.fields.split(",") as NoteField[],
			})),
			total: rows.length,
		};
	}

	/** Replaces the note's links, or with `PROPOSED` the proposal's. */
	private replaceLinks(subjectId: string, links: readonly NoteLinkRow[], kind: "" | typeof PROPOSED = ""): void {
		this.db
			.prepare(
				`DELETE FROM symbol_note_links WHERE subjectId = ? AND field ${kind === "" ? "NOT " : ""}LIKE '${PROPOSED}%'`,
			)
			.run(subjectId);
		const insert = this.db.prepare(
			"INSERT OR IGNORE INTO symbol_note_links (subjectId, field, written, target, targetDigest) VALUES (?, ?, ?, ?, ?)",
		);
		for (const link of links) insert.run(subjectId, link.field, link.written, link.target, link.targetDigest);
	}
}
