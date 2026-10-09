import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModuleAdmission } from "@nyaa-lexicon/protocol";
import { Database } from "../database";
import type { MethodRequest } from "../providerPort";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { BATCH_MS, BatchFailed, IndexStore, type ReplaceFileInput } from "../store";
import { type FakeClock, fakeClock } from "./fakeClock";
import { fakeSupervisor, parseFake } from "./fakeProvider";
import { gitInit } from "./gitFixture";
import { failingCommit, fillDisk } from "./storeFailures";

////////////////////////////////
//  Helpers

let root: string;
let file: string;
let store: IndexStore;
const opened: IndexStore[] = [];

const MODULES = Array.from({ length: 10 }, (_, index) => `f${String(index).padStart(2, "0")}.fake`);

const classOf = (module: string) => `F${module.slice(1, 3)}`;

function put(module: string, body = ""): void {
	writeFileSync(path.join(root, module), `export class ${classOf(module)} {${body}}\n`);
}

/** What each service's provider was told of its parses, in order. */
let verdicts: Array<{ providerId: string; verdict: ModuleAdmission }>;

/** The last verdict the provider was told for `module`. */
const told = (module: string) =>
	verdicts.filter(({ verdict }) => verdict.module === module).at(-1)?.verdict.outcome.status;

/** A service whose provider calls `during` before answering each parse, numbered from one. */
function service(during: (parse: number, request: MethodRequest<"parseFile">) => void = () => {}): LexiconService {
	let parses = 0;
	const provider = fakeSupervisor({
		admissions: verdicts,
		answers: {
			parseFile: (request) => {
				during(++parses, request);
				return parseFake(request);
			},
		},
	});
	return new LexiconService(store, provider, sourceReader(root), root);
}

/** What another connection reads: only what has committed. */
function committed(from = file): Map<string, string> {
	const db = Database.open(from, { readOnly: true });
	try {
		const rows = db.prepare("SELECT module, contentHash FROM files ORDER BY module").all() as Array<{
			module: string;
			contentHash: string;
		}>;
		return new Map(rows.map((row) => [row.module, row.contentHash]));
	} finally {
		db.close();
	}
}

/** The files a crash at this instant leaves: the database and its log, with no shared-memory index. */
function crashImage(): string {
	const copy = path.join(mkdtempSync(path.join(tmpdir(), "lexicon-crash-")), "index.sqlite");
	copyFileSync(file, copy);
	if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`);
	return copy;
}

/** Reopens the store on a test clock, so the test moves its batch timer. */
function onFakeClock(): FakeClock {
	const clock = fakeClock();
	store.close();
	store = IndexStore.open(file, undefined, undefined, clock).store;
	return clock;
}

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } };

/** A module's facts: imports of `targets`, each resolved, and `bulk` declarations wide enough to fill pages. */
function facts(module: string, targets: string[] = [], bulk = 0): ReplaceFileInput {
	return {
		module,
		contentHash: module,
		declarations: Array.from({ length: bulk }, (_, at) => ({
			symbolId: `lexicon fake ${module} S${at}.`,
			kind: "constant" as const,
			name: `S${at}`,
			range: RANGE,
			selectionRange: RANGE,
			visibility: "public" as const,
			signature: "x".repeat(400),
		})),
		references: [],
		imports: targets.map((target, order) => ({
			specifier: target,
			edges: [
				{
					kind: "sideEffect" as const,
					span: RANGE,
					bindsLocally: false,
					certainty: { status: "known" as const },
					order,
					loads: "static" as const,
					elided: false,
				},
			],
		})),
		resolutions: new Map(
			targets.map((target) => [
				target,
				{ status: "resolved" as const, landing: { kind: "module" as const, module: target } },
			]),
		),
	};
}

const settled = (work: Promise<unknown>) =>
	work.then(
		() => "returned",
		() => "threw",
	);

beforeEach(async () => {
	verdicts = [];
	root = mkdtempSync(path.join(tmpdir(), "lexicon-batched-"));
	mkdirSync(path.join(root, "store"));
	file = path.join(root, "store", "index.sqlite");
	await gitInit(root);
	for (const module of MODULES) put(module);
	store = IndexStore.open(file).store;
});

afterEach(() => {
	for (const each of opened.splice(0)) each.close();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("an index pass's writes", () => {
	it("commit in batches rather than per file, and all of them by the pass's end", async () => {
		let midway = -1;
		await service((parse) => {
			if (parse === 6) midway = committed().size;
		}).indexWorkspace();

		expect({ midway, after: committed().size }).toEqual({ midway: 0, after: MODULES.length });
	});

	it("leave a crash the last committed batch and every note and refactor blob written, which the next scan completes", async () => {
		const note = `lexicon fake f00.fake ${classOf("f00.fake")}#`;
		let svc: LexiconService | null = null;
		let image = "";
		svc = service((parse) => {
			if (parse === 4) svc?.writeNote({ symbolId: note, text: "Written mid-pass.", expectedRevision: 0 });
			if (parse === 6) store.putBlob("snapshot", new Uint8Array([1, 2, 3]));
			if (parse === 7) image = crashImage();
		});
		await svc.indexWorkspace();

		const crashed = IndexStore.open(image).store;
		opened.push(crashed);
		const survived = {
			files: crashed.indexedFiles(),
			note: crashed.notes.byAddress(note)?.text,
			blob: crashed.blob("snapshot") !== null,
		};
		const repaired = new LexiconService(crashed, fakeSupervisor(), sourceReader(root), root);
		await repaired.indexWorkspace();

		expect({
			survived,
			repaired: crashed.indexedFiles(),
			note: crashed.notes.byAddress(note)?.text,
		}).toEqual({
			survived: {
				files: ["f00.fake", "f01.fake", "f02.fake", "f03.fake", "f04.fake"],
				note: "Written mid-pass.",
				blob: true,
			},
			repaired: MODULES,
			note: "Written mid-pass.",
		});
	});

	it("leave an abandoned batch whole files, committed, which the next scan completes", async () => {
		let parses = 0;
		let counting = false;
		const svc = service(() => {
			if (counting) parses++;
		});
		await svc.indexWorkspace();
		const before = committed();
		for (const module of MODULES) put(module, " edited ");

		counting = true;
		await svc.applyBatch(
			MODULES.map((module) => ({ kind: "changed" as const, module, contentHash: null })),
			() => parses >= 3,
		);
		const abandoned = committed();
		const edited = [...abandoned].filter(([module, hash]) => hash !== before.get(module)).length;
		await svc.indexWorkspace();
		const after = committed();

		expect({
			edited,
			kept: abandoned.size,
			completed: [...after].filter(([module, hash]) => hash !== before.get(module)).length,
		}).toEqual({ edited: 3, kept: MODULES.length, completed: MODULES.length });
	});

	it("roll back a batch whose commit fails, so the next pass writes it again", async () => {
		const commit = failingCommit(store);
		const svc = service((parse) => {
			if (parse === 6) commit.arm();
		});

		const first = await settled(svc.indexWorkspace());
		const lost = committed().size;
		await svc.indexWorkspace();

		expect({ first, lost, repaired: committed().size }).toEqual({
			first: "threw",
			lost: 0,
			repaired: MODULES.length,
		});
	});

	it("tell the provider a parse was admitted only once its batch commits", async () => {
		onFakeClock();
		let midway = "unset";
		await service((parse) => {
			if (parse === 4) midway = told("f00.fake") ?? "nothing yet";
		}).indexWorkspace();

		expect({ midway, after: told("f00.fake") }).toEqual({ midway: "nothing yet", after: "admitted" });
	});

	it("refuse an index write that outlives its pass", async () => {
		let late: Promise<unknown> = Promise.resolve();
		await store.pass(async () => {
			late = (async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				store.replaceFile(facts("late.fake"));
			})();
		});

		expect(await settled(late)).toBe("threw");
	});

	it("commit at each pass's end, though another pass is still running", async () => {
		let endOther = () => {};
		const other = store.pass(
			() =>
				new Promise<void>((resolve) => {
					endOther = resolve;
				}),
		);
		await store.pass(async () => {
			store.replaceFile(facts("a.fake"));
		});
		const atEnd = [...committed().keys()];
		endOther();
		await other;

		expect(atEnd).toEqual(["a.fake"]);
	});

	it("fail when a batch is lost only for the passes running then, and one starting after writes", async () => {
		await service().indexWorkspace();
		const before = committed();
		let endLong = () => {};
		const long = settled(
			store.pass(
				() =>
					new Promise<void>((resolve) => {
						endLong = resolve;
					}),
			),
		);
		put("f00.fake", " edited ");
		put("f01.fake", " edited ");
		const svc = service();
		failingCommit(store).arm();
		const lost = await settled(svc.applyBatch([{ kind: "changed", module: "f00.fake", contentHash: null }]));
		const later = await settled(svc.applyBatch([{ kind: "changed", module: "f01.fake", contentHash: null }]));
		const landed = committed().get("f01.fake") !== before.get("f01.fake");
		endLong();

		expect({ lost, later, landed, long: await long }).toEqual({
			lost: "threw",
			later: "returned",
			landed: true,
			long: "threw",
		});
	});
});

describe("an open batch's timer", () => {
	it("commits the batch a second after it opened, though no write follows", async () => {
		const clock = onFakeClock();
		const seen: number[] = [];
		await service((parse) => {
			if (parse !== 4) return;
			seen.push(committed().size);
			clock.advance(BATCH_MS);
			seen.push(committed().size);
		}).indexWorkspace();

		expect(seen).toEqual([0, 3]);
	});

	it("falling due inside a write, commits once that write ends", async () => {
		const clock = onFakeClock();
		const internals = store as unknown as { db: Database; transactionDepth: number };
		const prepare = internals.db.prepare.bind(internals.db);
		let due = false;
		internals.db.prepare = (sql) => {
			if (due && internals.transactionDepth > 0) {
				due = false;
				clock.advance(BATCH_MS);
			}
			return prepare(sql);
		};
		let afterWrite = -1;
		const outcomes = await service((parse) => {
			if (parse === 3) due = true;
			if (parse === 4) afterWrite = committed().size;
		}).indexWorkspace();

		expect({
			afterWrite,
			indexed: outcomes.filter((outcome) => outcome.action === "indexed").length,
			committed: committed().size,
		}).toEqual({ afterWrite: 3, indexed: MODULES.length, committed: MODULES.length });
	});

	it("failing to commit, ends the pass at its next write, blames no file, and lets no later batch land ahead", async () => {
		const clock = onFakeClock();
		const commit = failingCommit(store);
		let timerFailed = false;
		let parses = 0;
		const svc = service((parse) => {
			parses = parse;
			if (parse !== 4) return;
			commit.arm();
			clock.advance(BATCH_MS);
			timerFailed = !commit.armed();
		});

		const first = await settled(svc.indexWorkspace());
		const stopped = {
			parses,
			kept: committed().size,
			failures: store.parseFailures(),
			told: ["f00.fake", "f03.fake"].map(told),
		};
		await svc.indexWorkspace();

		expect({ timerFailed, first, stopped, repaired: committed().size }).toEqual({
			timerFailed: true,
			first: "threw",
			stopped: { parses: 4, kept: 0, failures: [], told: ["refused", "refused"] },
			repaired: MODULES.length,
		});
	});

	it("failing to commit, records no refusal a parse after it would have", async () => {
		const clock = onFakeClock();
		const commit = failingCommit(store);
		const provider = fakeSupervisor({
			answers: {
				parseFile: (request) => {
					if (request.module !== "f03.fake") return parseFake(request);
					commit.arm();
					clock.advance(BATCH_MS);
					return { ...parseFake(request), diagnostics: [{ severity: "error" as const, message: "broken" }] };
				},
			},
		});
		const pass = await settled(new LexiconService(store, provider, sourceReader(root), root).indexWorkspace());

		expect({ pass, failures: store.parseFailures() }).toEqual({ pass: "threw", failures: [] });
	});
});

describe("a write that fails", () => {
	const reason = (error: unknown) =>
		error instanceof BatchFailed ? "refused" : (error as Error).message.includes("full") ? "disk" : "other";

	it("on a full disk inside a pass, throws the disk's error, loses the batch, refuses the pass's later writes, and leaves the store writable", async () => {
		store.replaceFile(facts("kept.fake"));
		const free = fillDisk(store);
		const errors: string[] = [];
		const pass = await store
			.pass(async () => {
				for (let at = 0; at < 40 && errors.length < 2; at++) {
					try {
						store.replaceFile(facts(`big${at}.fake`, [], 40));
					} catch (error) {
						errors.push(reason(error));
					}
				}
			})
			.then(() => "returned", reason);
		free();
		const speculated = store.readOverlaid([], () => true);
		store.replaceFile(facts("after.fake"));

		expect({
			errors,
			pass,
			held: store.indexedFiles().sort(),
			committed: [...committed().keys()],
			speculated,
		}).toEqual({
			errors: ["disk", "refused"],
			pass: "refused",
			held: ["after.fake", "kept.fake"],
			committed: ["after.fake", "kept.fake"],
			speculated: true,
		});
	});

	it("on a full disk outside a pass, throws the disk's error and keeps what landed before it", () => {
		const free = fillDisk(store);
		let error = "";
		const landed: string[] = [];
		for (let at = 0; at < 40 && error === ""; at++) {
			try {
				store.replaceFile(facts(`big${at}.fake`, [], 40));
				landed.push(`big${at}.fake`);
			} catch (thrown) {
				error = reason(thrown);
			}
		}
		free();

		expect({ error, committed: [...committed().keys()], speculated: store.readOverlaid([], () => true) }).toEqual({
			error: "disk",
			committed: landed.sort(),
			speculated: true,
		});
	});

	it("that is the store failing, loses the batch even where SQLite kept it to the statement", async () => {
		const db = (store as unknown as { db: Database }).db;
		const prepare = db.prepare.bind(db);
		let failing = false;
		db.prepare = (sql) => {
			const statement = prepare(sql);
			if (!failing || !/^\s*INSERT/i.test(sql)) return statement;
			failing = false;
			return new Proxy(statement, {
				get: (target, key) => {
					if (key === "run") {
						return () => {
							throw Object.assign(new Error("database or disk is full"), { errcode: 13 });
						};
					}
					const value: unknown = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		};
		const pass = await store
			.pass(async () => {
				store.replaceFile(facts("before.fake"));
				failing = true;
				try {
					store.replaceFile(facts("full.fake"));
				} catch {
					// The store's failure, thrown to the write that met it.
				}
			})
			.then(() => "returned", reason);

		expect({ pass, committed: [...committed().keys()] }).toEqual({ pass: "refused", committed: [] });
	});

	it("that SQLite refuses by itself, rolls back alone and the pass goes on", async () => {
		const refused = facts("refused.fake", [], 1);
		const pass = await settled(
			store.pass(async () => {
				store.replaceFile(facts("before.fake"));
				try {
					store.replaceFile({
						...refused,
						declarations: refused.declarations.map((each) => ({ ...each, contains: "nothing" as never })),
					});
				} catch {
					// The CHECK on `contains` refused it.
				}
				store.replaceFile(facts("after.fake"));
			}),
		);

		expect({ pass, committed: [...committed().keys()] }).toEqual({
			pass: "returned",
			committed: ["after.fake", "before.fake"],
		});
	});
});

describe("the facts generation", () => {
	it("read before a lost batch is never read again for other facts, so no cache serves the lost ones", async () => {
		const clock = onFakeClock();
		const svc = service();
		const cycles = async () => (await svc.moduleCycles({ includeUnread: true })).map((cycle) => cycle.modules);
		const commit = failingCommit(store);
		let during: string[][] = [];
		const pass = await settled(
			store.pass(async () => {
				store.replaceFile(facts("a.fake", ["b.fake"]));
				store.replaceFile(facts("b.fake", ["a.fake"]));
				during = await cycles();
				commit.arm();
				clock.advance(BATCH_MS);
			}),
		);
		store.replaceFile(facts("c.fake"));
		store.replaceFile(facts("d.fake"));

		expect({ during, pass, after: await cycles() }).toEqual({
			during: [["a.fake", "b.fake"]],
			pass: "threw",
			after: [],
		});
	});

	it("holds across a rollback that took back no generation, so a pinned plan still holds", () => {
		store.replaceFile(facts("a.fake"));
		const before = store.factsGeneration();

		expect(() =>
			store.noteWrite(() => {
				throw new Error("expected revision 3, found 4");
			}),
		).toThrow();
		expect(store.factsGeneration()).toBe(before);
	});

	it("read inside a speculation is its own, and one read before it still holds after it", () => {
		store.replaceFile(facts("a.fake"));
		const before = store.factsGeneration();
		const inside = store.readOverlaid([facts("b.fake")], () => store.factsGeneration());
		const after = store.factsGeneration();
		store.replaceFile(facts("b.fake"));

		expect({ held: after === before, own: inside !== store.factsGeneration() }).toEqual({ held: true, own: true });
	});
});

describe("a knowledge write", () => {
	it("refuses outside a store transaction, and inside an index write unless it is a resolution", () => {
		const address = `lexicon fake f00.fake ${classOf("f00.fake")}#`;
		const indexWrite = (store as unknown as { indexWrite: <T>(work: () => T) => T }).indexWrite.bind(store);

		expect(() => store.subjects.mint(address, 1)).toThrow();
		expect(() => indexWrite(() => store.subjects.mint(address, 1))).toThrow();
		expect(store.noteWrite(() => store.subjects.mint(address, 1)).symbolId).toBe(address);
	});
});

describe("another process's lock", () => {
	const DATABASE = new URL("../database.ts", import.meta.url).pathname;

	/** Runs `code` in another process, with `Database` and the store's `file` in scope. */
	const elsewhere = (code: string) =>
		Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { Database } from ${JSON.stringify(DATABASE)};\nconst file = ${JSON.stringify(file)};\n${code}`,
			],
			{ stdout: "pipe" },
		);

	it("waits on an open batch until it commits, rather than failing at once", async () => {
		let said = "";
		await store.pass(async () => {
			store.replaceFile(facts("held.fake"));
			const other = elsewhere(
				`try { const db = Database.open(file); db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); console.log("acquired"); } catch (error) { console.log(error.message); }`,
			);
			said = (await new Response(other.stdout).text()).trim();
		});

		expect(said).toBe("acquired");
	});

	it("makes a write wait it out, rather than fail at once", async () => {
		const holder = elsewhere(
			`const db = Database.open(file); db.exec("BEGIN IMMEDIATE"); console.log("held"); await Bun.sleep(300); db.exec("ROLLBACK");`,
		);
		await holder.stdout.getReader().read();
		store.replaceFile(facts("late.fake"));
		await holder.exited;

		expect(store.indexedFiles()).toContain("late.fake");
	});
});
