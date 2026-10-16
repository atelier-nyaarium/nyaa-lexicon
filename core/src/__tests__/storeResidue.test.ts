import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { storePaths } from "@nyaa-lexicon/client";
import { SCHEMA_VERSION } from "@nyaa-lexicon/protocol";
import type { Clock } from "../clock";
import { Database, type Statements } from "../database";
import { seedIndex } from "../indexSeed";
import { runInWorker, type Statement } from "../statementWorker";
import { IndexStore } from "../store";
import type { ScrubOptions } from "../storePurge";
import { BUILD_MAJOR } from "../version";
import { admit, forgetPlain, writePlain } from "./admissions";
import { fakeClock } from "./fakeClock";
import { where } from "./storeBytes";
import { testPolicy } from "./testPolicy";

/** Deleted values leave no database or WAL residue. */

////////////////////////////////
//  Helpers

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };

let root: string;
let file: string;
let store: IndexStore;
const opened: IndexStore[] = [];

/** Scrub marker stored in the index. */
function marker(target = file): string | null {
	const reader = Database.open(target, { readOnly: true });
	try {
		const row = reader.prepare("SELECT value FROM meta WHERE key = 'scrubbedMajor'").get() as
			| { value: string }
			| undefined;
		return row?.value ?? null;
	} finally {
		reader.close();
	}
}

/** Checkpoints and clears the WAL. */
function fold(target = file): void {
	const admin = Database.open(target);
	try {
		admin.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
	} finally {
		admin.close();
	}
}

/** Confirms the value exists before deletion. */
function held(value: string, target = file): void {
	fold(target);
	expect(where(target, value), `${value} was never in the file`).toBe("db");
}

function open(target = file, scrub?: ScrubOptions, clock?: Clock): ReturnType<typeof IndexStore.open> {
	const each = IndexStore.open(target, undefined, undefined, clock, scrub);
	opened.push(each.store);
	return each;
}

/** Reopens the store file. */
function reopen(): { rebuilt: boolean } {
	opened.splice(opened.indexOf(store), 1);
	store.close();
	const next = open();
	store = next.store;
	return next;
}

function writeDoc(into: IndexStore, module: string, text: string): void {
	writePlain(into, {
		module,
		contentHash: `${module}:${text.length}:${text.slice(-6)}`,
		declarations: [],
		references: [],
		docs: [{ range: RANGE, text, fenced: false }],
		literals: [{ kind: "string", value: text, range: RANGE }],
	});
}

/** Reuses freed pages across plain modules. */
async function filler(tag: string, count = 200): Promise<void> {
	await store.pass(async () => {
		for (let index = 0; index < count; index++)
			writeDoc(store, `src/${tag}${index}.ts`, `plain filler ${tag} ${index} ${"x".repeat(index % 300)}`);
	});
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-store-residue-"));
	file = path.join(root, "index.sqlite");
	store = open().store;
});

afterEach(() => {
	for (const each of opened.splice(0)) each.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a deleted value in the store's own bytes", () => {
	const CASES: Array<[string, () => Promise<string[]>]> = [
		[
			"a plain version replaced, then the module purged as secret",
			async () => {
				const old = "OLDVALUE-a1b2c3d4e5";
				const current = "NEWVALUE-f6a7b8c9d0";
				await filler("a");
				writeDoc(store, ".env", `TOKEN=${old}\nOTHER=${"o".repeat(900)}`);
				await filler("b");
				held(old);
				writeDoc(store, ".env", `TOKEN=${current}`);
				await filler("c");
				held(current);
				store.forgetFile(".env", admit(".env", "keys", "stamp"));
				return [old, current];
			},
		],
		[
			"a previous parse replaced, then the current one purged",
			async () => {
				const previous = "PREVIOUSPARSE-4433221100";
				writeDoc(store, "k8s/secret.yaml", `data: ${previous} ${"p".repeat(2000)}`);
				held(previous);
				writeDoc(store, "k8s/secret.yaml", "data: CURRENT");
				fold();
				store.forgetFile("k8s/secret.yaml", admit("k8s/secret.yaml", "masked", "stamp"));
				return [previous];
			},
		],
		[
			"an index rebuild",
			async () => {
				const value = "REBUILDVALUE-1122334455";
				writeDoc(store, "credentials.json", value);
				await filler("r", 100);
				held(value);
				store.journalWrite((db) => db.exec("PRAGMA user_version = 1"));
				expect(reopen().rebuilt).toBe(true);
				return [value];
			},
		],
		[
			"a plain blob prune",
			async () => {
				const value = "BLOBVALUE-6677889900";
				const bytes = Buffer.from(`${value}${"b".repeat(3000)}`);
				const admitted = testPolicy(root, undefined, store).admitBytes("plain.bin", bytes);
				if (admitted.kind !== "admitted") throw new Error("expected a plain image");
				store.putBlob(admitted.value);
				held(value);
				store.pruneBlobs();
				return [value];
			},
		],
		[
			"a plain forget",
			async () => {
				const value = "PLAINFORGET-5566778899";
				writeDoc(store, "deploy/secret.yaml", value);
				held(value);
				forgetPlain(store, "deploy/secret.yaml");
				return [value];
			},
		],
		[
			"a secret forget on its own",
			async () => {
				const value = "CONTROLVALUE-0099887766";
				writeDoc(store, ".env.local", value);
				held(value);
				store.forgetFile(".env.local", admit(".env.local", "keys", "stamp"));
				return [value];
			},
		],
	];

	for (const [name, run] of CASES) {
		it(`is gone from the file and the log after ${name}`, async () => {
			const values = await run();
			fold();

			expect(values.map((value) => where(file, value))).toEqual(values.map(() => "gone"));
		});
	}

	it("is never carried into a store seeded from an older one, which keeps what it held", () => {
		const value = "SEEDEDVALUE-9988776655";
		const older = path.join(root, `index-${SCHEMA_VERSION - 1}.sqlite`);
		const legacy = IndexStore.open(older).store;
		writeDoc(legacy, ".env", `TOKEN=${value}`);
		legacy.journalWrite((db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`));
		legacy.close();
		fold(older);
		const seeded = storePaths(root).index;
		seedIndex(root);

		const reopened = open(seeded);
		fold(seeded);

		expect({
			rebuilt: reopened.rebuilt,
			seeded: where(seeded, value),
			older: where(older, value),
			scrub: reopened.scrub,
			marker: marker(seeded),
		}).toEqual({ rebuilt: false, seeded: "gone", older: "db", scrub: undefined, marker: String(BUILD_MAJOR) });
	});

	it("zeroes on every connection core opens", () => {
		const pragma = (db: Database) => db.prepare("PRAGMA secure_delete").get();
		const writable = Database.open(file);
		const readOnly = Database.open(file, { readOnly: true });
		try {
			expect([pragma(writable), pragma(readOnly)]).toEqual([{ secure_delete: 1 }, { secure_delete: 1 }]);
		} finally {
			writable.close();
			readOnly.close();
		}
	});
});

describe("the search itself", () => {
	for (const [setting, found] of [
		["OFF", "db"],
		["ON", "gone"],
	] as const) {
		it(`reports ${found} for a value deleted on a raw connection with secure_delete ${setting}`, () => {
			const value = "RAWVALUE-5544332211";
			const target = path.join(root, "raw.sqlite");
			const raw = new DatabaseSync(target);
			try {
				raw.exec(`PRAGMA journal_mode = WAL; PRAGMA secure_delete = ${setting}; CREATE TABLE raw (value TEXT)`);
				raw.prepare("INSERT INTO raw VALUES (?)").run(`${value}${"r".repeat(2000)}`);
				raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
				raw.exec("DELETE FROM raw");
				raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				raw.close();
			}

			expect(where(target, value)).toBe(found);
		});
	}
});

describe("a page freed by a writer that did not zero", () => {
	const OLD = "FREEDPAGE-8f2c61d90a";
	const CURRENT = String(BUILD_MAJOR);

	/** Seeds freed pages with a chosen marker and schema. */
	async function freed(marked: number | null, outdated = false): Promise<void> {
		writeDoc(store, "old/note.ts", `${OLD} ${"p".repeat(2000)}`);
		await filler("o", 50);
		opened.splice(opened.indexOf(store), 1);
		store.close();
		const raw = new DatabaseSync(file);
		try {
			raw.exec("PRAGMA secure_delete = OFF");
			raw.exec("DELETE FROM docs; DELETE FROM literals");
			if (marked === null) raw.exec("DELETE FROM meta WHERE key = 'scrubbedMajor'");
			else
				raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('scrubbedMajor', ?)").run(String(marked));
			if (outdated) raw.exec("PRAGMA user_version = 1");
			raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			raw.close();
		}
		expect(where(file, OLD), "the value must sit in a freed page before the open").toBe("db");
	}

	/** Reopens after closing a store. */
	function next(previous: IndexStore, scrub?: ScrubOptions, clock?: Clock): ReturnType<typeof IndexStore.open> {
		opened.splice(opened.indexOf(previous), 1);
		previous.close();
		return open(file, scrub, clock);
	}

	const failing = (errcode: number) => () => {
		throw Object.assign(new Error("simulated"), { errcode });
	};

	it("is gone from the file and the log after the first open under a major, which then serves writes", async () => {
		await freed(null);
		const { store: scrubbed, scrub } = open();
		writeDoc(scrubbed, "after.ts", "written after the rewrite");

		expect({ scrub: scrub?.status, value: where(file, OLD), marker: marker() }).toEqual({
			scrub: "done",
			value: "gone",
			marker: CURRENT,
		});
	});

	it("stays under a marker at the current major, which is what the rewrite removes", async () => {
		await freed(BUILD_MAJOR);
		const { scrub } = open();

		expect({ scrub, value: where(file, OLD) }).toEqual({ scrub: undefined, value: "db" });
	});

	it("is rewritten once per major: again under a higher one, never under a lower one", async () => {
		await freed(null);
		let rewrites = 0;
		const counting = (db: Statements) => {
			rewrites++;
			db.exec("VACUUM");
		};
		const counts: number[] = [];
		let current = open(file, { vacuum: counting });
		counts.push(rewrites);
		current = next(current.store, { vacuum: counting });
		counts.push(rewrites);
		current = next(current.store, { vacuum: counting, major: BUILD_MAJOR + 1 });
		counts.push(rewrites);
		current = next(current.store, { vacuum: counting });

		expect({ counts: [...counts, rewrites], marker: marker(), scrub: current.scrub }).toEqual({
			counts: [1, 1, 2, 2],
			marker: String(BUILD_MAJOR + 1),
			scrub: undefined,
		});
	});

	it("is not rewritten in a file the open made, which records the major at once", () => {
		const made = path.join(root, "made.sqlite");
		let rewrites = 0;
		const { scrub } = open(made, {
			vacuum: () => {
				rewrites++;
			},
		});

		expect({ rewrites, scrub, marker: marker(made) }).toEqual({ rewrites: 0, scrub: undefined, marker: CURRENT });
	});

	it("is not rewritten in a rebuilt file, which is new and records the major at once", async () => {
		await freed(BUILD_MAJOR, true);
		let rewrites = 0;
		const { rebuilt, scrub } = open(file, {
			vacuum: () => {
				rewrites++;
			},
		});

		expect({ rebuilt, rewrites, scrub, value: where(file, OLD), marker: marker() }).toEqual({
			rebuilt: true,
			rewrites: 0,
			scrub: undefined,
			value: "gone",
			marker: CURRENT,
		});
	});

	it("is deferred on a short disk, reported, and done by the next open with room", async () => {
		await freed(null);
		const probed: string[] = [];
		const short = open(file, {
			freeBytes: (target) => {
				probed.push(target);
				return 0;
			},
		});
		writeDoc(short.store, "while-deferred.ts", "the store serves writes");
		const deferred = { scrub: short.scrub?.status, found: where(file, OLD) !== "gone", marker: marker() };
		const retried = next(short.store);

		expect({ probed, deferred, retried: retried.scrub?.status, value: where(file, OLD), marker: marker() }).toEqual(
			{
				probed: [file],
				deferred: { scrub: "deferred", found: true, marker: null },
				retried: "done",
				value: "gone",
				marker: CURRENT,
			},
		);
	});

	it("is deferred, not fatal, when the rewrite finds the disk full or the file held", async () => {
		await freed(null);
		const full = open(file, { vacuum: failing(13) });
		const held = next(full.store, { vacuum: failing(5) });

		expect({ full: full.scrub?.status, held: held.scrub?.status, marker: marker() }).toEqual({
			full: "deferred",
			held: "deferred",
			marker: null,
		});
	});

	it("is repeated by the next open when the process dies between the rewrite and the marker", async () => {
		await freed(null);
		const killed = (db: Statements) => {
			db.exec("VACUUM");
			throw new Error("killed after the rewrite");
		};
		expect(() => open(file, { vacuum: killed })).toThrow("killed after the rewrite");
		const markedByTheDeadOpen = marker();
		let rewrites = 0;
		const { scrub } = open(file, {
			vacuum: (db) => {
				rewrites++;
				db.exec("VACUUM");
			},
		});

		expect({
			markedByTheDeadOpen,
			rewrites,
			scrub: scrub?.status,
			value: where(file, OLD),
			marker: marker(),
		}).toEqual({
			markedByTheDeadOpen: null,
			rewrites: 1,
			scrub: "done",
			value: "gone",
			marker: CURRENT,
		});
	});

	it("reports how long the rewrite took", async () => {
		await freed(null);
		const clock = fakeClock();
		const { scrub } = open(
			file,
			{
				vacuum: (db) => {
					db.exec("VACUUM");
					clock.advance(1_234);
				},
			},
			clock,
		);

		expect(scrub).toEqual({ status: "done", major: BUILD_MAJOR, ms: 1_234 });
	});

	describe("rewritten from a worker ahead of the open", () => {
		const ahead = (compatibility?: string, options: ScrubOptions = {}) =>
			IndexStore.scrubAhead(file, compatibility, undefined, options);

		/** Records worker input first. */
		function counting(): { handed: Statement[]; run: (statement: Statement) => Promise<void> } {
			const handed: Statement[] = [];
			return {
				handed,
				run: async (statement) => {
					handed.push(statement);
					await runInWorker(statement);
				},
			};
		}

		const roomFor = (temp: string, room: number, worker: ReturnType<typeof counting>): ScrubOptions => ({
			tempDirectory: () => temp,
			freeBytes: (target) => (target === temp ? room : Number.MAX_SAFE_INTEGER),
			run: worker.run,
		});

		function tempDirectory(): string {
			const temp = path.join(root, "temp");
			mkdirSync(temp);
			return temp;
		}

		it("is gone from the file and the log, announced once, before an open that finds the marker", async () => {
			await freed(null);
			const worker = counting();
			const announced: number[] = [];
			const report = await ahead(undefined, { run: worker.run, starting: (bytes) => announced.push(bytes) });
			const { store: served, scrub } = open();
			writeDoc(served, "after.ts", "written after the rewrite");

			expect({
				report: report?.status,
				handed: worker.handed.map(({ sql }) => sql),
				announced: announced.length,
				scrub,
				value: where(file, OLD),
				marker: marker(),
			}).toEqual({
				report: "done",
				handed: ["VACUUM"],
				announced: 1,
				scrub: undefined,
				value: "gone",
				marker: CURRENT,
			});
		});

		it("starts no worker and announces nothing under a marker at the current major", async () => {
			await freed(BUILD_MAJOR);
			const worker = counting();
			const announced: number[] = [];
			const report = await ahead(undefined, { run: worker.run, starting: (bytes) => announced.push(bytes) });

			expect({
				report,
				handed: worker.handed.length,
				announced: announced.length,
				value: where(file, OLD),
			}).toEqual({
				report: null,
				handed: 0,
				announced: 0,
				value: "db",
			});
		});

		it("is left to the open when the open rebuilds the file, which writes a new one that owes none", async () => {
			await freed(null, true);
			const worker = counting();
			const report = await ahead(undefined, { run: worker.run });
			let rewrites = 0;
			const { rebuilt, scrub } = open(file, {
				vacuum: () => {
					rewrites++;
				},
			});

			expect({
				report,
				handed: worker.handed.length,
				rebuilt,
				rewrites,
				scrub,
				value: where(file, OLD),
			}).toEqual({ report: null, handed: 0, rebuilt: true, rewrites: 0, scrub: undefined, value: "gone" });
		});

		it("is left to the open when a major has moved since the file was written, and run when it has not", async () => {
			await freed(null);
			const raw = new DatabaseSync(file);
			raw.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('storeCompatibility', '18')");
			raw.close();
			const moved = counting();
			const kept = counting();

			const left = await ahead("19", { run: moved.run });
			const run = await ahead("18", { run: kept.run });

			expect({ left, moved: moved.handed.length, run: run?.status, kept: kept.handed.length }).toEqual({
				left: null,
				moved: 0,
				run: "done",
				kept: 1,
			});
		});

		it("is deferred, before the worker starts, when SQLite's temp directory is short", async () => {
			await freed(null);
			const temp = tempDirectory();
			const worker = counting();
			const announced: number[] = [];
			const probed: string[] = [];
			const short: ScrubOptions = {
				...roomFor(temp, 0, worker),
				freeBytes: (target) => {
					probed.push(target);
					return target === temp ? 0 : Number.MAX_SAFE_INTEGER;
				},
				starting: (bytes) => announced.push(bytes),
			};
			const report = await ahead(undefined, short);
			let vacuumed = 0;
			const inline = open(file, { ...short, vacuum: () => void vacuumed++ });

			expect({
				report: report?.status,
				handed: worker.handed.length,
				announced: announced.length,
				probed: [...new Set(probed)],
				inline: inline.scrub?.status,
				vacuumed,
				value: where(file, OLD),
				marker: marker(),
			}).toEqual({
				report: "deferred",
				handed: 0,
				announced: 0,
				probed: [file, temp],
				inline: "deferred",
				vacuumed: 0,
				value: "db",
				marker: null,
			});
		});

		it("runs when the same directory has room (the control)", async () => {
			await freed(null);
			const temp = tempDirectory();
			const worker = counting();
			const report = await ahead(undefined, roomFor(temp, Number.MAX_SAFE_INTEGER, worker));

			expect({ report: report?.status, handed: worker.handed.length, value: where(file, OLD) }).toEqual({
				report: "done",
				handed: 1,
				value: "gone",
			});
		});

		it("asks one volume for the log's room and the copy's, and a separate volume for the copy's alone", async () => {
			await freed(null);
			const size = statSync(file).size + (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0);
			const temp = tempDirectory();
			const worker = counting();
			const tight = await ahead(undefined, roomFor(temp, size * 1.5, worker));
			const handedTight = worker.handed.length;
			const roomy = await ahead(undefined, roomFor(temp, size * 2.5, worker));

			expect({ tight: tight?.status, handedTight, roomy: roomy?.status, handed: worker.handed.length }).toEqual({
				tight: "deferred",
				handedTight: 0,
				roomy: "done",
				handed: 1,
			});
		});

		it.skipIf(!existsSync("/dev/shm"))("asks a separate volume for the copy's room alone", async () => {
			await freed(null);
			const size = statSync(file).size;
			const worker = counting();
			const report = await ahead(undefined, {
				...roomFor("/dev/shm", size * 1.5, worker),
				freeBytes: (target) => (target === "/dev/shm" ? size * 1.5 : Number.MAX_SAFE_INTEGER),
			});

			expect({ report: report?.status, handed: worker.handed.length }).toEqual({ report: "done", handed: 1 });
		});

		it("is deferred when the worker finds the file held, and left alone by the open that follows", async () => {
			await freed(null);
			const held = await ahead(undefined, { run: failing(5) });
			const left = open(file, { inline: false });
			const whileLeft = { scrub: left.scrub, value: where(file, OLD), marker: marker() };
			const retried = next(left.store);

			expect({ held: held?.status, whileLeft, retried: retried.scrub?.status, value: where(file, OLD) }).toEqual({
				held: "deferred",
				whileLeft: { scrub: undefined, value: "db", marker: null },
				retried: "done",
				value: "gone",
			});
		});

		it("is repeated by the next start when the process dies between the worker and the marker", async () => {
			await freed(null);
			const died = await ahead(undefined, {
				run: async (statement) => {
					await runInWorker(statement);
					throw new Error("killed after the rewrite");
				},
			}).catch((error: unknown) => (error as Error).message);
			const markedByTheDeadStart = marker();
			const again = counting();
			const retried = await ahead(undefined, { run: again.run });

			expect({
				died,
				markedByTheDeadStart,
				retried: retried?.status,
				handed: again.handed.length,
				marker: marker(),
			}).toEqual({
				died: "killed after the rewrite",
				markedByTheDeadStart: null,
				retried: "done",
				handed: 1,
				marker: CURRENT,
			});
		});
	});
});
