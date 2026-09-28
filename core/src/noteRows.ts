// Note rows: the notes table, its links and pending proposals, read and written by subject. Rows
// only; what a note means and whether a write stands lives in the note ledger.

import type { DatabaseSync } from "node:sqlite";

////////////////////////////////
//  Interfaces & Types

/** A note row at its subject's current address, with the subject's current digest. */
export interface NoteRow {
	subjectId: string;
	symbolId: string;
	recordedAs: string;
	revision: number;
	text: string;
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

/** A note's own columns, as every insert writes them. */
export type NoteColumns = Omit<NoteRow, "subjectId" | "symbolId" | "lastDigest">;

export interface NoteLinkRow {
	written: string;
	/** A subject id, or `module:<path>`. */
	target: string;
	targetDigest: string | null;
}

export interface NoteProposalRow {
	text: string;
	baseRevision: number;
	proposedBy: string | null;
	proposedAt: number;
}

/** A target that names a whole module rather than a subject. */
export const MODULE_TARGET = "module:";

////////////////////////////////
//  Functions & Helpers

/** The only insert into the notes table. `replace` overwrites a standing row. */
export function insertNote(db: DatabaseSync, subjectId: string, note: NoteColumns, replace: boolean): void {
	db.prepare(
		`INSERT ${replace ? "OR REPLACE " : ""}INTO symbol_notes (subjectId, recordedAs, revision, text, author,
		 authoredAt, editedBy, editedAt, confirmedBy, confirmedAt, sourceDigest, doubtBy, doubtReason, doubtAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		subjectId,
		note.recordedAs,
		note.revision,
		note.text,
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
		return this.linksOf(subjectId, false);
	}

	proposalLinks(subjectId: string): NoteLinkRow[] {
		return this.linksOf(subjectId, true);
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
	save(subjectId: string, note: NoteColumns, links: readonly NoteLinkRow[]): void {
		insertNote(this.db, subjectId, note, true);
		this.replaceLinks(subjectId, links, false);
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
		this.replaceLinks(subjectId, links, false);
		this.recordKnowledgeWrite(true);
	}

	doubt(subjectId: string, by: string | null, reason: string, at: number): void {
		this.db
			.prepare("UPDATE symbol_notes SET doubtBy = ?, doubtReason = ?, doubtAt = ? WHERE subjectId = ?")
			.run(by, reason, at, subjectId);
		this.recordKnowledgeWrite(true);
	}

	propose(subjectId: string, proposal: NoteProposalRow, links: readonly NoteLinkRow[]): void {
		this.replaceLinks(subjectId, links, true);
		this.db
			.prepare(
				`INSERT OR REPLACE INTO symbol_note_proposals (subjectId, baseRevision, text, proposedBy, proposedAt)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(subjectId, proposal.baseRevision, proposal.text, proposal.proposedBy, proposal.proposedAt);
		this.recordKnowledgeWrite(true);
	}

	dropProposal(subjectId: string): void {
		const dropped = this.db.prepare("DELETE FROM symbol_note_proposals WHERE subjectId = ?").run(subjectId);
		this.replaceLinks(subjectId, [], true);
		this.recordKnowledgeWrite(dropped.changes > 0);
	}

	/** Notes whose refs name `target`, newest edit first. */
	backlinks(
		target: string,
		limit: number,
	): { notes: Array<{ subjectId: string; symbolId: string; text: string }>; total: number } {
		const rows = this.db
			.prepare(
				`SELECT n.subjectId, n.symbolId, n.text FROM notes_addressed n
				 WHERE n.subjectId IN (SELECT subjectId FROM symbol_note_links WHERE target = ? AND proposed = 0)
				 ORDER BY n.editedAt DESC`,
			)
			.all(target) as Array<{ subjectId: string; symbolId: string; text: string }>;
		return { notes: rows.slice(0, limit), total: rows.length };
	}

	private linksOf(subjectId: string, proposed: boolean): NoteLinkRow[] {
		return this.db
			.prepare(
				`SELECT written, target, targetDigest FROM symbol_note_links
				 WHERE subjectId = ? AND proposed = ? ORDER BY rowid`,
			)
			.all(subjectId, proposed ? 1 : 0) as unknown as NoteLinkRow[];
	}

	/** Replaces the note's links, or the proposal's. */
	private replaceLinks(subjectId: string, links: readonly NoteLinkRow[], proposed: boolean): void {
		const flag = proposed ? 1 : 0;
		this.db.prepare("DELETE FROM symbol_note_links WHERE subjectId = ? AND proposed = ?").run(subjectId, flag);
		const insert = this.db.prepare(
			`INSERT OR IGNORE INTO symbol_note_links (subjectId, proposed, written, target, targetDigest)
			 VALUES (?, ?, ?, ?, ?)`,
		);
		for (const link of links) insert.run(subjectId, flag, link.written, link.target, link.targetDigest);
	}
}
