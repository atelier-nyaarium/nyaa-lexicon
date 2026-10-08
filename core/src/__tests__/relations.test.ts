import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	composeSymbolId,
	type Declaration,
	type NoteAuthor,
	type Reference,
	type Relation,
} from "@nyaa-lexicon/protocol";
import { CoChangeIndex, type Commit } from "../history";
import * as refusal from "../refusals";
import { RelationLedger } from "../relations";
import { startRelationWork } from "../relationWork";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore, SCHEMA_VERSION } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { type FakeClock, fakeClock } from "./fakeClock";

////////////////////////////////
//  Helpers

let dir: string;
let file: string;
let store: IndexStore;
let clock: FakeClock;
let ledger: RelationLedger;

const PERSON: NoteAuthor = { kind: "person" };
const AGENT: NoteAuthor = { kind: "agent", model: "gpt-6-luna", via: "test", run: null };

const FORMAT = "src/format.ts";
const TABLE = "src/table.ts";
const SUMMARY = "src/summary.ts";
const REPORT = "src/report.ts";
const PARSE = "src/config/parse.ts";
const CLOCK = "src/clock.ts";

const idOf = (name: string, module: string) =>
	composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] });

const BYTES = idOf("formatBytes", FORMAT);
const DURATION = idOf("formatDuration", FORMAT);
const RATE = idOf("formatRate", FORMAT);
const ROW = idOf("renderRow", TABLE);
const LINE = idOf("summaryLine", SUMMARY);
const PRINT = idOf("printReport", REPORT);
const PARSE_DURATION = idOf("parseDuration", PARSE);

const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

function declared(name: string, module: string, line: number, signature?: string): Declaration {
	return {
		symbolId: idOf(name, module),
		kind: "function",
		name,
		range: at(line),
		selectionRange: at(line),
		visibility: "public",
		exported: true,
		...(signature === undefined ? {} : { signature }),
	};
}

function call(target: string, from: string, line: number): Reference {
	return {
		name: target.split(" ").at(-1) ?? target,
		range: at(line),
		role: "call",
		binding: { status: "bound", symbolId: target, provenance: "bound" },
		fromId: from,
	};
}

function plant(module: string, declarations: Declaration[], references: Reference[] = []): void {
	store.replaceFile({
		module,
		contentHash: `${module}:${JSON.stringify(declarations)}:${references.length}`,
		declarations,
		references,
		depth: "full",
		content: "code",
	});
}

function plantFormat(extra: Declaration[] = []): void {
	plant(FORMAT, [
		declared("formatBytes", FORMAT, 0, "(bytes: number): string"),
		declared("formatDuration", FORMAT, 1, "(ms: number): string"),
		declared("formatRate", FORMAT, 2, "(perSecond: number): string"),
		...extra,
	]);
}

function plantWorkspace(): void {
	plantFormat();
	plant(TABLE, [declared("renderRow", TABLE, 0)], [call(BYTES, ROW, 1), call(RATE, ROW, 2)]);
	plant(SUMMARY, [declared("summaryLine", SUMMARY, 0)], [call(BYTES, LINE, 1), call(DURATION, LINE, 2)]);
	plant(REPORT, [declared("printReport", REPORT, 0)], [call(RATE, PRINT, 1)]);
	plant(PARSE, [declared("parseDuration", PARSE, 0, "(text: string): number")]);
	plant(CLOCK, [declared("elapsedSince", CLOCK, 0, "(start: number): number")]);
}

function commit(...files: string[]): Commit {
	return {
		hash: files.join("+"),
		at: 0,
		message: "",
		changes: files.map((p) => ({ path: p, added: 1, deleted: 0 })),
	};
}

const HISTORY = new CoChangeIndex([commit(FORMAT, TABLE), commit(FORMAT, SUMMARY), commit(FORMAT, TABLE, SUMMARY)]);

function find(relations: readonly Relation[], symbolId: string): Relation | undefined {
	return relations.find((relation) => relation.symbolId === symbolId);
}

function reopen(): void {
	store = IndexStore.open(file, undefined, undefined, clock).store;
	ledger = new RelationLedger(store, clock);
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-relations-"));
	file = path.join(dir, "index.sqlite");
	clock = fakeClock();
	reopen();
	plantWorkspace();
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("computed relations", () => {
	it("ranks what the same callers use, with the evidence for each", () => {
		const { relations, unavailable } = ledger.relationsOf(BYTES, HISTORY);
		expect(unavailable).toEqual([]);
		expect(find(relations, DURATION)).toMatchObject({
			kind: "usedTogether",
			health: "current",
			evidence: { holders: 1, words: ["format"], sameModule: true },
			stated: null,
		});
		// A second caller of its own thins what the shared one says.
		const rate = find(relations, RATE);
		expect(rate?.kind).toBe("sameFile");
		expect(rate?.parts.callers).toBeLessThan(find(relations, DURATION)?.parts.callers ?? 0);
	});

	it("reads history as evidence, and says when there is none rather than scoring it zero", () => {
		const withHistory = ledger.relationsOf(ROW, HISTORY).relations;
		expect(find(withHistory, BYTES)).toMatchObject({ kind: "changedTogether", evidence: { commits: 2 } });

		const without = ledger.relationsOf(BYTES, null);
		expect(without.unavailable).toEqual(["history"]);
		const rate = find(without.relations, RATE);
		expect(rate?.parts.cochange).toBeNull();
		expect(rate?.score).toBeGreaterThan(find(ledger.relationsOf(BYTES, HISTORY).relations, RATE)?.score ?? 1);
	});

	it("names a pair resting on one item of evidence, whatever it scores", () => {
		const { relation } = ledger.between(DURATION, PARSE_DURATION, HISTORY);
		expect(relation).toMatchObject({ kind: "namedAlike", health: "insufficientEvidence" });
		expect(relation?.evidence.words).toEqual(["duration"]);
		expect(ledger.between(DURATION, DURATION, HISTORY)).toEqual({
			relation: null,
			reason: refusal.relationToItself(DURATION),
		});
	});

	it("keeps each kind to its limit and says so", () => {
		const capped = ledger.relationsOf(BYTES, HISTORY, { limit: 1 });
		const kinds = capped.relations.map((relation) => relation.kind);
		expect(new Set(kinds).size).toBe(kinds.length);
		expect(capped.truncated).toBe(true);
		expect(
			ledger
				.relationsOf(BYTES, HISTORY, { kinds: ["namedAlike"] })
				.relations.every((r) => r.kind === "namedAlike"),
		).toBe(true);
	});
});

describe("stated relations", () => {
	const state = (author: NoteAuthor, expectedRevision: number, why = "both read durations") =>
		ledger.write({ symbolId: DURATION, otherId: PARSE_DURATION, action: "state", why, expectedRevision, author });

	it("an agent proposes, a person confirms, and an agent's later word changes nothing", () => {
		expect(state(AGENT, 0)).toMatchObject({
			outcome: "proposed",
			relation: { stated: { provenance: "agent", status: "proposed", revision: 1 } },
		});
		const judged = ledger.write({
			symbolId: PARSE_DURATION,
			otherId: DURATION,
			action: "confirm",
			expectedRevision: 1,
			author: PERSON,
		});
		expect(judged).toMatchObject({ outcome: "saved", relation: { stated: { status: "confirmed", revision: 2 } } });
		expect(state(AGENT, 2, "they parse")).toMatchObject({
			outcome: "kept",
			relation: { stated: { why: "both read durations" } },
		});
		// A confirmed relation shows from both ends, even below the floor.
		expect(find(ledger.relationsOf(PARSE_DURATION, HISTORY).relations, DURATION)?.stated?.status).toBe("confirmed");
	});

	it("lets an agent revise its own proposal, and a person's word replace it", () => {
		state(AGENT, 0);
		expect(state(AGENT, 1, "they share a unit")).toMatchObject({
			outcome: "proposed",
			relation: { stated: { why: "they share a unit", revision: 2 } },
		});
		expect(state(PERSON, 2, "both speak milliseconds")).toMatchObject({
			outcome: "saved",
			relation: { stated: { provenance: "person", status: "confirmed", why: "both speak milliseconds" } },
		});
	});

	it("confirming a doubted relation clears the doubt", () => {
		const pair = { symbolId: BYTES, otherId: RATE, author: PERSON };
		ledger.write({ ...pair, action: "doubt", reason: "only a file", expectedRevision: 0 });
		expect(ledger.write({ ...pair, action: "confirm", expectedRevision: 1 })).toMatchObject({
			outcome: "saved",
			relation: { stated: { status: "confirmed", reason: null, revision: 2 } },
		});
		expect(find(ledger.relationsOf(BYTES, HISTORY).relations, RATE)?.stated?.status).toBe("confirmed");
	});

	it("leaves a doubted relation out until asked for; removing it brings the computed one back", () => {
		const doubted = ledger.write({
			symbolId: BYTES,
			otherId: RATE,
			action: "doubt",
			reason: "they only share a file",
			expectedRevision: 0,
			author: PERSON,
		});
		expect(doubted).toMatchObject({
			outcome: "saved",
			relation: { stated: { provenance: "computed", status: "doubted" } },
		});
		expect(find(ledger.relationsOf(BYTES, HISTORY).relations, RATE)).toBeUndefined();
		expect(find(ledger.relationsOf(BYTES, HISTORY, { withDoubted: true }).relations, RATE)?.stated?.reason).toBe(
			"they only share a file",
		);

		ledger.write({ symbolId: RATE, otherId: BYTES, action: "remove", expectedRevision: 1, author: PERSON });
		expect(find(ledger.relationsOf(BYTES, HISTORY).relations, RATE)).toMatchObject({ stated: null });
	});

	it("leaves judging to a person, refuses a stale revision with what stands, and wants a why", () => {
		expect(
			ledger.write({ symbolId: BYTES, otherId: RATE, action: "confirm", expectedRevision: 0, author: AGENT }),
		).toEqual({
			outcome: "refused",
			reason: refusal.relationNeedsPerson("confirm"),
		});
		state(PERSON, 0);
		expect(state(PERSON, 0)).toMatchObject({
			outcome: "refused",
			reason: refusal.relationRevisionMoved(0, 1),
			current: { stated: { revision: 1 } },
		});
		expect(
			ledger.write({
				symbolId: BYTES,
				otherId: RATE,
				action: "state",
				why: "  ",
				expectedRevision: 0,
				author: PERSON,
			}),
		).toEqual({ outcome: "refused", reason: refusal.relationNeedsWhy() });
	});

	it("keeps a relation whose other end is gone, as orphaned", () => {
		state(PERSON, 0);
		plant(PARSE, []);
		expect(find(ledger.relationsOf(DURATION, HISTORY).relations, PARSE_DURATION)).toMatchObject({
			health: "orphaned",
			kind: "stated",
			stated: { status: "confirmed" },
		});
		expect(find(ledger.relationsOf(DURATION, HISTORY).relations, PARSE_DURATION)?.symbol).toBeUndefined();
	});

	it("carries a stated relation across a store rebuild, both ends placed", () => {
		state(PERSON, 0);
		const before = find(ledger.relationsOf(DURATION, HISTORY).relations, PARSE_DURATION)?.stated;
		store.close();
		const db = new DatabaseSync(file);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
		db.close();
		reopen();
		plantWorkspace();
		expect(find(ledger.relationsOf(DURATION, HISTORY).relations, PARSE_DURATION)?.stated).toEqual(before);
	});
});

describe("feedback", () => {
	it("lifts a relation an intent's predictions were accepted through, bounded and fading", () => {
		const base = find(ledger.relationsOf(BYTES, HISTORY).relations, RATE)?.score ?? 0;
		for (let i = 0; i < 5; i++) ledger.feedback([{ symbolId: RATE, otherId: BYTES }], "adopt", "accepted");
		const lifted = find(ledger.relationsOf(BYTES, HISTORY, { intent: "adopt" }).relations, RATE);
		expect(lifted?.score).toBeCloseTo(Math.min(1, base * 2));
		expect(lifted?.feedback?.accepted).toBe(5);
		expect(find(ledger.relationsOf(BYTES, HISTORY, { intent: "fix" }).relations, RATE)?.score).toBeCloseTo(base);

		clock.advance(30 * 24 * 60 * 60 * 1000);
		expect(
			find(ledger.relationsOf(BYTES, HISTORY, { intent: "adopt" }).relations, RATE)?.feedback?.accepted,
		).toBeCloseTo(2.5);
	});

	it("sinks a rejected relation no lower than half, and records nothing for a symbol the index lacks", () => {
		const base = find(ledger.relationsOf(BYTES, HISTORY).relations, RATE)?.score ?? 0;
		for (let i = 0; i < 9; i++) ledger.feedback([{ symbolId: BYTES, otherId: RATE }], "adopt", "rejected");
		expect(find(ledger.relationsOf(BYTES, HISTORY, { intent: "adopt" }).relations, RATE)?.score ?? 0).toBeCloseTo(
			base / 2,
		);
		expect(ledger.feedback([{ symbolId: BYTES, otherId: idOf("ghost", FORMAT) }], "adopt", "accepted")).toEqual({
			recorded: 0,
		});
	});
});

describe("discovery", () => {
	const SPEED = idOf("formatSpeed", FORMAT);
	const ELAPSED = idOf("elapsedSince", CLOCK);

	it("seeds an existing workspace quietly; a reshaped export queues and a body edit does not", () => {
		expect(ledger.seedExports()).toBe(true);
		expect(ledger.nextQueued()).toBeNull();

		plant(FORMAT, [
			{ ...declared("formatBytes", FORMAT, 0, "(bytes: number): string"), range: at(5) },
			declared("formatDuration", FORMAT, 1, "(ms: number): string"),
			declared("formatRate", FORMAT, 2, "(perSecond: number, unit: string): string"),
		]);
		expect(ledger.notice([FORMAT], [])).toBe(1);
		expect(ledger.nextQueued()).toEqual({ symbolId: RATE, module: FORMAT });
	});

	it("queues a burst of new exports over several batches rather than losing what passed the cap", () => {
		ledger.seedExports();
		const burst = Array.from({ length: 25 }, (_, line) => declared(`formatUnit${line}`, FORMAT, line + 3));
		plantFormat(burst);
		const queued = () => {
			let count = 0;
			for (let next = ledger.nextQueued(); next !== null; next = ledger.nextQueued()) {
				ledger.settleQueued(next.symbolId, next.module, null);
				count++;
			}
			return count;
		};
		ledger.notice([FORMAT], []);
		expect(queued()).toBe(20);
		ledger.notice([FORMAT], []);
		expect(queued()).toBe(5);
		ledger.notice([FORMAT], []);
		expect(queued()).toBe(0);
	});

	it("drops an export's suggestions when the export goes", () => {
		ledger.seedExports();
		plantFormat([declared("formatSpeed", FORMAT, 3, "(bytesPerSecond: number): string")]);
		ledger.notice([FORMAT], []);
		ledger.settleQueued(SPEED, FORMAT, ledger.discover(SPEED, HISTORY));
		expect(ledger.candidatesForModule(TABLE, 5).candidates).toHaveLength(1);

		plantFormat();
		ledger.notice([FORMAT], []);
		expect(ledger.candidatesForModule(TABLE, 5).candidates).toEqual([]);
	});

	it("suggests a new export to the modules using what relates to it, until they use it", () => {
		ledger.seedExports();
		plantFormat([declared("formatSpeed", FORMAT, 3, "(bytesPerSecond: number): string")]);
		ledger.notice([FORMAT], []);
		const queued = ledger.nextQueued();
		expect(queued).toEqual({ symbolId: SPEED, module: FORMAT });
		ledger.settleQueued(SPEED, FORMAT, ledger.discover(SPEED, HISTORY));

		const suggested = ledger.candidatesForModule(TABLE, 5).candidates;
		expect(suggested.map((each) => each.export.symbolId)).toEqual([SPEED]);
		expect(suggested[0]?.via.map((each) => each.symbolId)).toEqual(expect.arrayContaining([BYTES]));
		expect(ledger.candidatesForModule(FORMAT, 5).candidates).toEqual([]);

		plant(TABLE, [declared("renderRow", TABLE, 0)], [call(BYTES, ROW, 1), call(SPEED, ROW, 2)]);
		expect(ledger.candidatesForModule(TABLE, 5).candidates).toEqual([]);
	});

	it("opens a gap for a new export nothing relates to, which a model's answer closes with proposals", () => {
		ledger.seedExports();
		plant(CLOCK, [
			declared("elapsedSince", CLOCK, 0, "(start: number): number"),
			declared("monotonicNow", CLOCK, 1, "(): number"),
		]);
		ledger.notice([CLOCK], []);
		const NOW = idOf("monotonicNow", CLOCK);
		ledger.settleQueued(NOW, CLOCK, ledger.discover(NOW, HISTORY));
		expect(ledger.gaps(5, HISTORY)).toMatchObject({ gaps: [{ symbol: { symbolId: NOW } }], total: 1 });

		expect(ledger.answerGap(NOW, [{ symbolId: ELAPSED, why: "both read the clock" }], AGENT)).toEqual({
			proposed: 1,
			kept: 0,
			refused: [],
		});
		expect(ledger.gaps(5, HISTORY).total).toBe(0);
		expect(find(ledger.relationsOf(NOW, HISTORY).relations, ELAPSED)?.stated).toMatchObject({
			provenance: "model",
			status: "proposed",
		});
	});
});

describe("background discovery", () => {
	const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

	it("seeds once ready, then discovers a batch's new export in a slice", async () => {
		const service = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
			clock,
		);
		const work = startRelationWork({ service, clock });
		await work.ready();
		expect(service.relations.nextQueued()).toBeNull();

		plantFormat([declared("formatSpeed", FORMAT, 3, "(bytesPerSecond: number): string")]);
		work.applied([{ module: FORMAT, action: "indexed" }]);
		const suggested = () =>
			service.relations.candidatesForModule(TABLE, 5).candidates.map((each) => each.export.name);
		for (let turn = 0; turn < 20 && suggested().length === 0; turn++) {
			await settle();
			clock.advance(1_000);
		}
		expect(suggested()).toEqual(["formatSpeed"]);
		work.stop();
		await work.idle();
	});

	it("defers a slice while an index write holds the gate, then runs it", async () => {
		const service = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
			clock,
		);
		const work = startRelationWork({ service, clock });
		await work.ready();
		plantFormat([declared("formatSpeed", FORMAT, 3, "(bytesPerSecond: number): string")]);
		work.applied([{ module: FORMAT, action: "indexed" }]);
		for (let turn = 0; turn < 5 && service.relations.nextQueued() === null; turn++) await settle();

		let release = () => {};
		const writing = service.gate.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
		const suggested = () => service.relations.candidatesForModule(TABLE, 5).candidates.length;
		for (let turn = 0; turn < 10; turn++) {
			await settle();
			clock.advance(1_000);
		}
		expect(suggested()).toBe(0);

		release();
		await writing;
		for (let turn = 0; turn < 20 && suggested() === 0; turn++) {
			await settle();
			clock.advance(1_000);
		}
		expect(suggested()).toBe(1);
		work.stop();
	});
});
