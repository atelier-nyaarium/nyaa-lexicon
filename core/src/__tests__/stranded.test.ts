import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let service: LexiconService;

const CART = "lexicon reference a.ref Cart#";
const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

function declaration(symbolId: string, name: string, line = 0) {
	return {
		symbolId,
		kind: "class" as const,
		name,
		range: at(line),
		selectionRange: at(line),
		visibility: "public" as const,
	};
}

function plant(module = "a.ref", symbolId = CART, name = "Cart"): void {
	store.replaceFile(module, "h1", [declaration(symbolId, name)], []);
}

async function record(symbolId: string, prose = "A shopping cart.", question: "describe" | "why" = "describe") {
	const cited = store.declaration(symbolId)?.factId as string;
	const outcome = await service.recordAnswer(symbolId, question, prose, [cited]);
	if (!outcome.recorded) throw new Error(outcome.reason);
	return outcome.answer;
}

/** The declaration leaves the index; the subject and its rows stay. */
function strand(module = "a.ref"): void {
	store.replaceFile(module, "h2", [], []);
}

function refused(outcome: { recorded: boolean; reason?: string }): string {
	if (outcome.recorded) throw new Error("expected a refusal");
	return outcome.reason ?? "";
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-stranded-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	service = new LexiconService(
		store,
		new ProviderSupervisor(),
		fromText(() => null),
		dir,
	);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a subject whose address stopped resolving", () => {
	it("is refused by every writer and named on recall, with the candidates elsewhere, and charges nothing", async () => {
		plant();
		const recorded = await record(CART);
		plant("b.ref", "lexicon reference b.ref Cart#");
		plant("c.ref", "lexicon reference c.ref Cart#");
		// Neither the same name as a term nor the same name in another language is a candidate.
		plant("d.ref", "lexicon reference d.ref Cart.");
		plant("e.ref", "lexicon other e.ref Cart#");
		strand();

		const reason = refused(await service.recordAnswer(CART, "why", "Again.", [recorded.factId]));
		expect(reason).toContain("no longer resolves");
		expect(reason).toContain("`lexicon reference b.ref Cart#`");
		expect(reason).toContain("`lexicon reference c.ref Cart#`");
		expect(reason).not.toContain("not in the index");
		const reaffirmed = refused(await service.reaffirmAnswer(CART, "describe"));
		expect(reaffirmed).toContain("no longer resolves");
		expect(reaffirmed).toContain("`lexicon reference b.ref Cart#`");

		const recalled = service.recallAnswer(CART, "describe");
		expect(recalled?.answer.prose).toBe("A shopping cart.");
		expect(recalled?.stranded).toEqual({
			since: null,
			exempt: false,
			evidence: "sameLocator",
			candidates: ["lexicon reference b.ref Cart#", "lexicon reference c.ref Cart#"],
		});
		// Demand is decided at the write: the guarded insert writes nothing at a dead address.
		const demand = service.demandOf(CART, "describe", recalled);
		expect(demand).toEqual({ symbolId: CART, question: "describe" });
		if (demand === null) throw new Error("expected demand");
		service.recordDemand(demand);
		expect(store.gaps(10)).toEqual([]);

		const doubted = service.invalidateAnswer(CART, "wrong now");
		expect(doubted.doubted.map((entry) => entry.question)).toEqual(["describe"]);
		expect(store.gaps(10)).toEqual([]);
		// Candidates are for a reader: the answer is still recalled where it was recorded, and nowhere else.
		expect(service.recallAnswer(CART, "describe")?.answer.doubt?.reason).toBe("wrong now");
		expect(service.recallAnswer("lexicon reference b.ref Cart#", "describe")).toBeNull();
	});

	it("leaves the queue: not as stale, and not as the demand recorded before the address vanished", async () => {
		plant();
		await record(CART);
		service.recordDemand({ symbolId: CART, question: "why" });
		strand();

		expect(service.knowledgeGaps().rows.map((row) => row.symbolId)).not.toContain(CART);
		expect(service.knowledgeGaps(undefined, "why").rows.map((row) => row.symbolId)).not.toContain(CART);
		expect(service.knowledgeGaps(CART).rows).toEqual([]);
		// The live surfaces are where every ranking reader looks; the rows themselves stay.
		expect(store.liveAnswers()).toEqual([]);
		expect(store.liveGaps(10)).toEqual([]);
		expect(store.liveAnswerCount()).toBe(0);
		expect(store.answersFor(CART)).toHaveLength(1);
		expect(store.gaps(10).map((gap) => gap.question)).toEqual(["why"]);
	});

	it("names the demand when only a gap stands at the dead address", async () => {
		plant();
		service.recordDemand({ symbolId: CART, question: "describe" });
		strand();

		const reason = refused(await service.recordAnswer(CART, "describe", "Late.", []));
		expect(reason).toContain(`the demand recorded against ${CART}`);
		expect(reason).toContain("nothing else in the index carries its name and kind");
	});

	it("waits on a parse failure instead of stranding, naming the failure's reason", async () => {
		plant();
		await record(CART);
		strand();
		store.recordFailure("a.ref", "unterminated string at line 3");

		const reason = refused(await service.recordAnswer(CART, "why", "Again.", []));
		expect(reason).toContain("present and not parsing (unterminated string at line 3)");
		const recalled = service.recallAnswer(CART, "describe");
		expect(recalled?.answer.prose).toBe("A shopping cart.");
		expect(recalled?.stranded).toMatchObject({ exempt: true, since: null });

		// An orphan under a failing module was judged before the module failed: it reads as stranded.
		const subject = store.subjects.forAddress(CART);
		store.subjects.orphan(subject?.subjectId as string, 20, "none");
		expect(refused(await service.recordAnswer(CART, "why", "Again.", []))).toContain("no longer resolves");
	});

	it("lists no candidates for a local and says why", async () => {
		const local = "lexicon reference a.ref local0";
		plant("a.ref", local, "x");
		await record(local, "A counter.");
		plant("b.ref", "lexicon reference b.ref local0", "x");
		strand();

		const reason = refused(await service.recordAnswer(local, "why", "Again.", []));
		expect(reason).toContain("a local has no candidates");
		expect(service.recallAnswer(local, "describe")?.stranded?.candidates).toEqual([]);
	});
});

describe("an address a subject vacated", () => {
	it("says moved, with the new address and the evidence, once its declaration is gone", async () => {
		plant();
		await record(CART);
		const moved = "lexicon reference b.ref Cart#";
		plant("b.ref", moved);
		store.subjects.rebind([{ from: CART, to: moved }], "journalMove", 9);
		strand();

		const reason = refused(await service.recordAnswer(CART, "describe", "Again.", []));
		expect(reason).toContain(`was rebound to ${moved} (journalMove)`);
		expect(service.recallAnswer(moved, "describe")?.answer.prose).toBe("A shopping cart.");

		const diagnosis = service.diagnoseSubject(CART);
		expect(diagnosis.kind === "moved" && diagnosis.forwardedTo).toBe(moved);
		expect<string>(diagnosis.reason).toBe(reason);
	});

	it("forwards only the last vacated address; two rebinds back reads as unminted", async () => {
		plant();
		await record(CART);
		const b = "lexicon reference b.ref Cart#";
		const c = "lexicon reference c.ref Cart#";
		plant("b.ref", b);
		store.subjects.rebind([{ from: CART, to: b }], "journalMove", 9);
		plant("c.ref", c);
		store.subjects.rebind([{ from: b, to: c }], "journalMove", 10);
		// The first module keeps another declaration, so its shortlist is what an unminted id shows.
		store.replaceFile("a.ref", "h2", [declaration("lexicon reference a.ref Other#", "Other")], []);
		strand("b.ref");

		expect(refused(await service.recordAnswer(b, "describe", "Again.", []))).toContain(`was rebound to ${c}`);
		const first = refused(await service.recordAnswer(CART, "describe", "Again.", []));
		expect(first).toContain("a.ref holds");
		expect(first).toContain("lexicon reference a.ref Other#");
		expect(first).not.toContain("was rebound");
	});
});
