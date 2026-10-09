import type { Database } from "../database";
import type { IndexStore } from "../store";

/** Once armed, the store's next COMMIT fails, as a full disk fails it. */
export function failingCommit(store: IndexStore): { arm(): void; armed(): boolean } {
	const db = (store as unknown as { db: Database }).db;
	const exec = db.exec.bind(db);
	let failing = false;
	db.exec = (sql) => {
		if (failing && sql === "COMMIT") {
			failing = false;
			throw new Error("disk full");
		}
		exec(sql);
	};
	return {
		arm: () => {
			failing = true;
		},
		armed: () => failing,
	};
}

/** The store's next BEGIN IMMEDIATE fails, as another process holding the lock past the wait makes it. */
export function busyAtBegin(store: IndexStore): void {
	const db = (store as unknown as { db: Database }).db;
	const exec = db.exec.bind(db);
	let busy = true;
	db.exec = (sql) => {
		if (busy && sql === "BEGIN IMMEDIATE") {
			busy = false;
			throw Object.assign(new Error("database is locked"), { errcode: 5 });
		}
		exec(sql);
	};
}

/** Caps the store's file a few pages past its size, so a later write fails as a full disk does; returns the release. */
export function fillDisk(store: IndexStore): () => void {
	const db = (store as unknown as { db: Database }).db;
	const { page_count } = db.prepare("PRAGMA page_count").get() as { page_count: number };
	db.exec(`PRAGMA max_page_count = ${page_count + 8}`);
	return () => db.exec("PRAGMA max_page_count = 1073741823");
}
