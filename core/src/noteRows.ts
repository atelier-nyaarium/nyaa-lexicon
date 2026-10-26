// Note rows: the notes table and its links, read and written by subject.

import type { Statements } from "./database.js";

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
	sourceDigest: string | null;
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

/** A target that names a whole module rather than a subject. */
export const MODULE_TARGET = "module:";

////////////////////////////////
//  Functions & Helpers

/** The only insert into the notes table. `replace` overwrites a standing row. */
export function insertNote(db: Statements, subjectId: string, note: NoteColumns, replace: boolean): void {
	db.prepare(
		`INSERT ${replace ? "OR REPLACE " : ""}INTO symbol_notes (subjectId, recordedAs, revision, text, author,
		 authoredAt, editedBy, editedAt, sourceDigest)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		subjectId,
		note.recordedAs,
		note.revision,
		note.text,
		note.author,
		note.authoredAt,
		note.editedBy,
		note.editedAt,
		note.sourceDigest,
	);
}

////////////////////////////////
//  Class

export class NoteRows {
	constructor(
		private readonly db: Statements,
		private readonly recordKnowledgeWrite: (changed: boolean) => void,
	) {}

	byAddress(symbolId: string): NoteRow | null {
		const row = this.db.prepare("SELECT * FROM notes_addressed WHERE symbolId = ?").get(symbolId);
		return row === undefined ? null : (row as unknown as NoteRow);
	}

	addresses(limit: number, modules: readonly string[]): string[] {
		return (
			this.db
				.prepare(
					`SELECT n.symbolId FROM notes_addressed n JOIN symbols s ON s.symbolId = n.symbolId
					 WHERE n.state = 'bound' AND s.module IN (SELECT value FROM json_each(?))
					 ORDER BY n.symbolId LIMIT ?`,
				)
				.all(JSON.stringify(modules), limit) as Array<{ symbolId: string }>
		).map((row) => row.symbolId);
	}

	links(subjectId: string): NoteLinkRow[] {
		return this.linksOf(subjectId);
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
		this.replaceLinks(subjectId, links);
		this.recordKnowledgeWrite(true);
	}

	/** The note and its links, gone. */
	remove(subjectId: string): void {
		const note = this.db.prepare("DELETE FROM symbol_notes WHERE subjectId = ?").run(subjectId);
		this.db.prepare("DELETE FROM symbol_note_links WHERE subjectId = ?").run(subjectId);
		this.recordKnowledgeWrite(note.changes > 0);
	}

	/** Notes whose refs name `target`, newest edit first. */
	backlinks(
		target: string,
		limit: number,
	): { notes: Array<{ subjectId: string; symbolId: string; text: string }>; total: number } {
		const rows = this.db
			.prepare(
				`SELECT n.subjectId, n.symbolId, n.text FROM notes_addressed n
				 WHERE n.subjectId IN (SELECT subjectId FROM symbol_note_links WHERE target = ?)
				 ORDER BY n.editedAt DESC`,
			)
			.all(target) as Array<{ subjectId: string; symbolId: string; text: string }>;
		return { notes: rows.slice(0, limit), total: rows.length };
	}

	private linksOf(subjectId: string): NoteLinkRow[] {
		return this.db
			.prepare(
				`SELECT written, target, targetDigest FROM symbol_note_links
				 WHERE subjectId = ? ORDER BY rowid`,
			)
			.all(subjectId) as unknown as NoteLinkRow[];
	}

	/** Replaces the note's links. */
	private replaceLinks(subjectId: string, links: readonly NoteLinkRow[]): void {
		this.db.prepare("DELETE FROM symbol_note_links WHERE subjectId = ?").run(subjectId);
		const insert = this.db.prepare(
			`INSERT OR IGNORE INTO symbol_note_links (subjectId, written, target, targetDigest)
			 VALUES (?, ?, ?, ?)`,
		);
		for (const link of links) insert.run(subjectId, link.written, link.target, link.targetDigest);
	}
}
