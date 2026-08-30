import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDispatch } from "../dispatch";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { type FakeClock, fakeClock } from "./fakeClock";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let service: LexiconService;
let clock: FakeClock;

const CART = "lexicon reference a.ref Cart#";
const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-clock-"));
	clock = fakeClock(1_700_000_000_000);
	store = IndexStore.open(path.join(dir, "index.sqlite"), undefined, undefined, clock).store;
	service = new LexiconService(
		store,
		new ProviderSupervisor(clock),
		fromText(() => null),
		dir,
		clock,
	);
	store.replaceFile(
		"a.ref",
		"h1",
		[{ symbolId: CART, kind: "class", name: "Cart", range: at(0), selectionRange: at(0), visibility: "public" }],
		[],
	);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("one clock through the daemon's composition", () => {
	it("stamps the answer, its subject, its doubt and its demand from the one clock", async () => {
		const cited = store.declaration(CART)?.factId as string;
		const recorded = clock.now();
		await service.recordAnswer(CART, "describe", "Holds items.", [cited]);
		expect(service.recallAnswer(CART, "describe")?.answer.createdAt).toBe(recorded);
		expect(store.subjects.forAddress(CART)?.boundAt).toBe(recorded);

		clock.advance(60_000);
		const doubted = clock.now();
		service.invalidateAnswer(CART, "checkout was rewritten", "describe", "test");
		const doubt = service.recallAnswer(CART, "describe")?.answer.doubt;
		expect(doubt?.at).toBe(doubted);
		// The doubt itself asked for a fresh describe, stamped when it was raised.
		expect(store.liveGaps(10).map((gap) => [gap.question, gap.lastAsked])).toEqual([["describe", doubted]]);

		clock.advance(60_000);
		const reaffirmed = clock.now();
		const outcome = await service.reaffirmAnswer(CART, "describe", { resolvesDoubt: doubt?.factId as string });
		expect(outcome.recorded).toBe(true);
		expect(service.recallAnswer(CART, "describe")?.answer).toMatchObject({ createdAt: reaffirmed });
		expect(service.recallAnswer(CART, "describe")?.answer.doubt).toBeUndefined();

		clock.advance(60_000);
		const asked = clock.now();
		const dispatch = createDispatch(service);
		await dispatch("recallAnswer", { symbolId: CART, question: "why" });
		expect(store.liveGaps(10).map((gap) => [gap.question, gap.lastAsked])).toEqual([["why", asked]]);
	});
});
