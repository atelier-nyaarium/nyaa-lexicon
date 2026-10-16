import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { storePaths } from "@nyaa-lexicon/client";
import { seedIndex } from "../indexSeed";
import type { Statement } from "../statementWorker";
import { IndexStore } from "../store";
import { type InstallPoint, stagingOf } from "../storePurge";
import { BUILD_MAJOR } from "../version";
import { knowledgeIn, knowledgeOf, NOTE, populate, SYMBOL } from "./knowledgeFixture";
import { fold, foreignLog, shownBy, where } from "./storeBytes";

////////////////////////////////
//  Helpers

const FACT = "SEEDFACT-3f9a1c77d0";

/** Note for an index name. */
const noteOf = (name: string): string => `${NOTE} ${name}`;

let dir: string;

/** Index fixture with a fact, note, and open refactor. */
function index(name: string, schema: number): string {
	const file = path.join(dir, name);
	const { store } = IndexStore.open(file);
	populate(store, `${FACT} ${name}`, noteOf(name));
	store.journalWrite((db) => db.exec(`PRAGMA user_version = ${schema}`));
	store.close();
	fold(file);
	return file;
}

/** Stops installation at a chosen point. */
const crashAt =
	(stop: InstallPoint) =>
	(point: InstallPoint): void => {
		if (point === stop) throw new Error(`crashed at ${stop}`);
	};

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-seed-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("seeding this schema's index", () => {
	it("creates it from the newest older index's knowledge, once, never a newer one's, and never its facts", () => {
		const legacy = index("index.sqlite", 0);
		const older = index("index-25.sqlite", 25);
		const newer = index("index-99.sqlite", 99);
		const bytes = [legacy, older, newer].map((file) => readFileSync(file));

		const first = seedIndex(dir);
		const second = seedIndex(dir);
		const target = storePaths(dir).index;
		const seeded = IndexStore.open(target);

		expect({
			first,
			second,
			rebuilt: seeded.rebuilt,
			knowledge: knowledgeOf(seeded.store),
			fact: where(target, FACT),
			// The other index retains the fact.
			older: where(older, FACT),
			kept: [legacy, older, newer].map((file, each) => readFileSync(file).equals(bytes[each] as Buffer)),
		}).toEqual({
			first: older,
			second: null,
			rebuilt: false,
			knowledge: { note: noteOf("index-25.sqlite"), transactions: ["t1"], blob: "export function add() {}\n" },
			fact: "gone",
			older: "db",
			kept: [true, true, true],
		});
		seeded.store.close();
	});

	it("skips an unreadable older index, and a failed creation leaves no target for the next start", () => {
		const oldest = index("index-24.sqlite", 24);
		writeFileSync(path.join(dir, "index-25.sqlite"), "not a database".repeat(100));
		chmodSync(dir, 0o555);
		const failed = (() => {
			try {
				seedIndex(dir);
				return "returned";
			} catch {
				return "threw";
			} finally {
				chmodSync(dir, 0o755);
			}
		})();
		const target = storePaths(dir).index;
		const left = { target: existsSync(target), staged: existsSync(stagingOf(target)) };
		const retried = seedIndex(dir);

		expect({ failed, left, retried }).toEqual({
			failed: "threw",
			left: { target: false, staged: false },
			retried: oldest,
		});
		expect(knowledgeIn(target).notes).toEqual([noteOf("index-24.sqlite")]);
	});

	// Legacy notes use address keys; no subjects, journals, or metadata.
	for (const [what, rows, text] of [
		[
			"a four-field note",
			["('lexicon reference a.ref Cart#', 'Holds carts.', 'Per shopper.', 1, 5, 5)"],
			"Holds carts.\n\nPer shopper.",
		],
		["no note (the control)", [], null],
	] as const) {
		it(`reads ${what} out of the oldest layout`, () => {
			const ancient = new DatabaseSync(path.join(dir, "index.sqlite"));
			ancient.exec(
				`CREATE TABLE symbol_notes (symbolId TEXT PRIMARY KEY, summary TEXT, description TEXT, revision INTEGER, authoredAt INTEGER, editedAt INTEGER)`,
			);
			for (const row of rows) ancient.exec(`INSERT INTO symbol_notes VALUES ${row}`);
			ancient.close();

			seedIndex(dir);
			const seeded = IndexStore.open(storePaths(dir).index);
			const note = seeded.store.notes.byAddress(SYMBOL)?.text ?? null;
			seeded.store.close();

			expect(note).toBe(text);
		});
	}

	it("does nothing in a directory with no older index", () => {
		index("index-99.sqlite", 99);

		expect({ seeded: seedIndex(dir), target: existsSync(storePaths(dir).index) }).toEqual({
			seeded: null,
			target: false,
		});
	});

	describe("a crash while the new index is put in place", () => {
		for (const [point, target] of [
			["built", false],
			["logGone", false],
			["renamed", true],
		] as const) {
			it(`leaves ${target ? "the whole index" : "no index"} after a crash at ${point}, and the next start finishes`, () => {
				const older = index("index-25.sqlite", 25);
				const created = storePaths(dir).index;
				const notes = [noteOf("index-25.sqlite")];
				expect(() => seedIndex(dir, { scrub: { reached: crashAt(point) } })).toThrow(`crashed at ${point}`);
				const left = {
					target: existsSync(created),
					staged: existsSync(stagingOf(created)),
					notes: target ? knowledgeIn(created).notes : [],
				};

				const retried = seedIndex(dir);

				expect({
					left,
					retried,
					staged: existsSync(stagingOf(created)),
					notes: knowledgeIn(created).notes,
				}).toEqual({
					left: { target, staged: !target, notes: target ? notes : [] },
					retried: target ? null : older,
					staged: false,
					notes,
				});
			});
		}
	});

	it("never attaches a log left where the index goes", () => {
		index("index-25.sqlite", 25);
		const target = storePaths(dir).index;
		writeFileSync(`${target}-wal`, foreignLog(dir));

		seedIndex(dir);

		expect(shownBy(target).tables).not.toContain("foreign_marker");
	});

	describe("the seeded index's first open", () => {
		it("rebuilds nothing and runs no VACUUM, where an index marked under an older major runs one (the control)", async () => {
			index("index-25.sqlite", 25);
			const target = storePaths(dir).index;
			let rewrites = 0;
			const vacuum = (db: { exec: (sql: string) => void }): void => {
				rewrites++;
				db.exec("VACUUM");
			};
			const handed: Statement[] = [];
			const run = async (statement: Statement): Promise<void> => {
				handed.push(statement);
			};

			seedIndex(dir, { compatibility: "7" });
			const ahead = await IndexStore.scrubAhead(target, "7", undefined, { run });
			const opened = IndexStore.open(target, "7", undefined, undefined, { vacuum });
			opened.store.close();
			const quiet = { ahead, rebuilt: opened.rebuilt, scrub: opened.scrub, rewrites, handed: handed.length };

			rmSync(target);
			seedIndex(dir, { compatibility: "7", scrub: { major: BUILD_MAJOR - 1 } });
			const due = IndexStore.open(target, "7", undefined, undefined, { vacuum });
			due.store.close();

			expect({ quiet, due: due.scrub?.status, rewrites }).toEqual({
				quiet: { ahead: null, rebuilt: false, scrub: undefined, rewrites: 0, handed: 0 },
				due: "done",
				rewrites: 1,
			});
		});
	});
});
