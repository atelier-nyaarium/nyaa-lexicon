import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database, type Statements } from "../database";
import { runInWorker, type Statement } from "../statementWorker";
import { IndexStore } from "../store";
import { type InstallPoint, stagingOf } from "../storePurge";
import { BUILD_MAJOR } from "../version";
import { writePlain } from "./admissions";
import { knowledgeIn, knowledgeOf, NOTE, populate } from "./knowledgeFixture";
import { everywhere, fold, foreignLog, shownBy, where } from "./storeBytes";

/** Rebuilds replace the file from a sibling database. */

////////////////////////////////
//  Helpers

const FACT = "DROPPEDFACT-7c1e90a4b2";

const KNOWLEDGE = { note: NOTE, transactions: ["t1"], blob: "export function add() {}\n" };

let root: string;
let file: string;
const opened: IndexStore[] = [];

/** Opens a store with install observer. */
function open(compatibility: string, reached?: (point: InstallPoint) => void): ReturnType<typeof IndexStore.open> {
	const each = IndexStore.open(file, compatibility, undefined, undefined, reached === undefined ? {} : { reached });
	opened.push(each.store);
	return each;
}

/** Creates a closed major 1 fixture. */
function written(): void {
	const first = open("1");
	populate(first.store, FACT);
	opened.splice(opened.indexOf(first.store), 1);
	first.store.close();
	fold(file);
}

/** Stops installation at a chosen point. */
const crashAt =
	(stop: InstallPoint) =>
	(point: InstallPoint): void => {
		if (point === stop) throw new Error(`crashed at ${stop}`);
	};

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-store-rebuild-"));
	file = path.join(root, "index.sqlite");
});

afterEach(() => {
	for (const each of opened.splice(0)) each.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a rebuild under a moved major", () => {
	it("keeps the notes and the open refactor, and leaves the dropped fact in no file", () => {
		written();
		const inode = statSync(file).ino;
		expect(everywhere(file, FACT), "the fact must sit in the file before the rebuild").toEqual([file]);

		const { store, rebuilt } = open("2");

		expect({
			rebuilt,
			knowledge: knowledgeOf(store),
			fact: everywhere(file, FACT),
			// A knowledge hit proves search works.
			carried: where(file, NOTE) !== "gone",
			replaced: statSync(file).ino !== inode,
			staged: existsSync(stagingOf(file)),
		}).toEqual({ rebuilt: true, knowledge: KNOWLEDGE, fact: [], carried: true, replaced: true, staged: false });
	});
});

describe("a crash while the new file replaces the old", () => {
	const AFTER: Record<InstallPoint, { staged: boolean; compat: string }> = {
		built: { staged: true, compat: "1" },
		logGone: { staged: true, compat: "1" },
		renamed: { staged: false, compat: "2" },
	};

	for (const [point, expected] of Object.entries(AFTER) as Array<[InstallPoint, (typeof AFTER)[InstallPoint]]>) {
		it(`reopens a whole store after a crash at ${point}`, () => {
			written();
			expect(() => open("2", crashAt(point))).toThrow(`crashed at ${point}`);
			const left = { staged: existsSync(stagingOf(file)), ...knowledgeIn(file) };

			const { store, rebuilt } = open("2");

			expect({
				left,
				rebuilt,
				knowledge: knowledgeOf(store),
				staged: existsSync(stagingOf(file)),
				fact: everywhere(file, FACT),
			}).toEqual({
				left: { staged: expected.staged, compat: expected.compat, notes: [NOTE], transactions: ["t1"] },
				rebuilt: point !== "renamed",
				knowledge: KNOWLEDGE,
				staged: false,
				fact: [],
			});
		});
	}

	for (const [when, major, rebuilds] of [
		["nothing rebuilds", "1", false],
		["the next rebuild starts", "2", true],
	] as const) {
		it(`deletes a half-built file and its log and journal at the next open, when ${when}`, () => {
			written();
			const staged = stagingOf(file);
			const half = new DatabaseSync(staged);
			half.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			half.close();
			const sidecars = [`${staged}-wal`, `${staged}-journal`];
			for (const each of sidecars) writeFileSync(each, FACT);

			const { store, rebuilt } = open(major);

			expect({
				rebuilt,
				knowledge: knowledgeOf(store),
				left: [staged, ...sidecars].filter((each) => existsSync(each)),
			}).toEqual({ rebuilt: rebuilds, knowledge: KNOWLEDGE, left: [] });
		});
	}

	it("reads a store missing the knowledge as empty (the control)", () => {
		const blank = path.join(root, "blank.sqlite");
		IndexStore.open(blank).store.close();

		expect(knowledgeIn(blank)).toEqual({ compat: null, notes: [], transactions: [] });
	});

	it("folds the old log into the file before deleting it", () => {
		const first = open("1");
		populate(first.store, FACT);
		// Preserve committed WAL frames at close.
		const holder = Database.open(file, { readOnly: true });
		opened.splice(opened.indexOf(first.store), 1);
		first.store.close();
		const unfolded = path.join(root, "unfolded.sqlite");
		copyFileSync(file, unfolded);

		expect(() => open("2", crashAt("logGone"))).toThrow("crashed at logGone");
		const left = { log: existsSync(`${file}-wal`), ...knowledgeIn(file) };
		holder.close();
		const without = (() => {
			try {
				return knowledgeIn(unfolded).notes;
			} catch {
				return null;
			}
		})();

		expect(left).toEqual({ log: false, compat: "1", notes: [NOTE], transactions: ["t1"] });
		expect(without, "the file alone, as a deleted log would leave it, lacks the note").not.toEqual([NOTE]);
	});
});

describe("a file another connection is reading", () => {
	it("is not replaced while the reader holds its log, and is once the reader leaves", () => {
		written();
		const reader = Database.open(file, { readOnly: true });
		reader.exec("BEGIN");
		reader.prepare("SELECT COUNT(*) FROM files").get();
		// Reader snapshot retains the later commit.
		const writer = open("1");
		writePlain(writer.store, { module: "src/b.ts", contentHash: "h2", declarations: [], references: [] });
		opened.splice(opened.indexOf(writer.store), 1);
		writer.store.close();

		const refused = (() => {
			try {
				open("2");
				return "opened";
			} catch (error) {
				return (error as Error).message;
			}
		})();
		const whole = knowledgeIn(file);
		reader.exec("COMMIT");
		reader.close();
		const { store, rebuilt } = open("2");

		expect({
			refused: refused.includes("held by another connection"),
			whole,
			rebuilt,
			knowledge: knowledgeOf(store),
		}).toEqual({
			refused: true,
			whole: { compat: "1", notes: [NOTE], transactions: ["t1"] },
			rebuilt: true,
			knowledge: KNOWLEDGE,
		});
	});
});

describe("a log left beside the old file", () => {
	it("never attaches to the new file", () => {
		written();
		const planted = foreignLog(root);
		// Keep WAL alive after writer close.
		const holder = Database.open(file, { readOnly: true });
		const plant = (point: InstallPoint): void => {
			if (point !== "built") return;
			rmSync(`${file}-wal`, { force: true });
			writeFileSync(`${file}-wal`, planted);
		};

		const { store } = open("2", plant);
		holder.close();

		expect({ knowledge: knowledgeOf(store), shown: shownBy(file).tables.includes("foreign_marker") }).toEqual({
			knowledge: KNOWLEDGE,
			shown: false,
		});
	});

	it("attaches to a file it is left beside when nothing removes it (the control)", () => {
		const bare = path.join(root, "bare.sqlite");
		const made = new DatabaseSync(bare);
		made.exec("PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT, value TEXT)");
		made.close();
		writeFileSync(`${bare}-wal`, foreignLog(root));

		expect(shownBy(bare).tables).toContain("foreign_marker");
	});
});

describe("the first open of a rebuilt store", () => {
	it("runs no VACUUM, in the open or ahead of it, where a store due for one runs it (the control)", async () => {
		written();
		let rewrites = 0;
		const counting = (db: Statements): void => {
			rewrites++;
			db.exec("VACUUM");
		};
		const handed: Statement[] = [];
		const run = async (statement: Statement): Promise<void> => {
			handed.push(statement);
			await runInWorker(statement);
		};

		const ahead = await IndexStore.scrubAhead(file, "2", undefined, { run });
		const rebuilt = IndexStore.open(file, "2", undefined, undefined, { vacuum: counting });
		rebuilt.store.close();
		const reopened = IndexStore.open(file, "2", undefined, undefined, { vacuum: counting });
		reopened.store.close();
		const afterwards = await IndexStore.scrubAhead(file, "2", undefined, { run });
		const quiet = {
			ahead,
			rebuilt: rebuilt.rebuilt,
			scrub: [rebuilt.scrub, reopened.scrub],
			rewrites,
			afterwards,
			handed: handed.length,
		};

		const due = await IndexStore.scrubAhead(file, "2", undefined, { run, major: BUILD_MAJOR + 1 });

		expect({ quiet, due: due?.status, handed: handed.length }).toEqual({
			quiet: {
				ahead: null,
				rebuilt: true,
				scrub: [undefined, undefined],
				rewrites: 0,
				afterwards: null,
				handed: 0,
			},
			due: "done",
			handed: 1,
		});
	});
});
