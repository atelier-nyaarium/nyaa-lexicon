import { DatabaseSync } from "node:sqlite";
import type { IndexStore } from "../store";
import { writePlain } from "./admissions";
import { testPolicy } from "./testPolicy";

/** Seeded knowledge survives rebuilds. */
export const SYMBOL = "lexicon reference a.ref Cart#";
export const NOTE = "Holds a cart per shopper.";

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
const BLOB = new TextEncoder().encode("export function add() {}\n");
const BLOB_IMAGE = (() => {
	const result = testPolicy(".").admitBytes("src/a.ts", BLOB);
	if (result.kind !== "admitted") throw new Error("expected a plain fixture image");
	return result.value;
})();

/** Seeds facts, knowledge, and blob. */
export function populate(store: IndexStore, fact: string, note = NOTE): void {
	store.putBlob(BLOB_IMAGE);
	writePlain(store, {
		module: "src/a.ts",
		contentHash: "h1",
		declarations: [],
		references: [],
		docs: [{ range: RANGE, text: fact, fenced: false }],
	});
	store.noteWrite(() => {
		const placed = store.subjects.placeRow({ subjectId: null, recordedAs: SYMBOL, at: 1 });
		if (!placed.placed) throw new Error("the note's subject was not placed");
		store.notes.save(
			placed.subjectId,
			{
				recordedAs: SYMBOL,
				revision: 1,
				text: note,
				author: null,
				authoredAt: 1,
				editedBy: null,
				editedAt: 1,
				sourceDigest: null,
			},
			[],
		);
	});
	store.journalWrite((db) => {
		db.prepare("INSERT INTO refactor_transactions (id, state, startedAt) VALUES (?, ?, ?)").run("t1", "open", 1);
		db.prepare(
			"INSERT INTO refactor_steps (transactionId, stepNo, kind, phase, createdAt) VALUES (?, ?, ?, ?, ?)",
		).run("t1", 1, "replace", "written", 1);
		db.prepare(
			`INSERT INTO refactor_images (transactionId, scope, stepNo, module, existedBefore, beforeHash)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run("t1", "step", 1, "src/a.ts", 1, BLOB_IMAGE.hash);
	});
}

/** Reads open-store knowledge. */
export function knowledgeOf(store: IndexStore): { note: string | null; transactions: string[]; blob: string | null } {
	const blob = store.heldImage("src/a.ts", BLOB_IMAGE.hash)?.bytes ?? null;
	return {
		note: store.notes.byAddress(SYMBOL)?.text ?? null,
		transactions: store.journalRead((db) =>
			(db.prepare("SELECT id FROM refactor_transactions ORDER BY id").all() as Array<{ id: string }>).map(
				(row) => row.id,
			),
		),
		blob: blob === null ? null : new TextDecoder().decode(blob),
	};
}

/** Reads persisted knowledge and version. */
export function knowledgeIn(target: string): { compat: string | null; notes: string[]; transactions: string[] } {
	const db = new DatabaseSync(target);
	try {
		const rows = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
		return {
			compat:
				rows<{ value: string }>("SELECT value FROM meta WHERE key = 'storeCompatibility'")[0]?.value ?? null,
			notes: rows<{ text: string }>("SELECT text FROM symbol_notes ORDER BY text").map((row) => row.text),
			transactions: rows<{ id: string }>("SELECT id FROM refactor_transactions ORDER BY id").map((row) => row.id),
		};
	} finally {
		db.close();
	}
}
