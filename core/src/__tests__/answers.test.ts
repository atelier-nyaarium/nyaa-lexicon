import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSymbolIdResult } from "@nyaa-lexicon/protocol";
import type { AttachedComment } from "../commentAttach";
import { createDispatch } from "../dispatch";
import * as refusal from "../refusals";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let service: LexiconService;

const SYMBOL = "lexicon reference a.ref Cart#";
const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

/** One class with a literal inside it, which gives two facts to cite and one to leave out. */
/** What the daemon does for one recall: the read, then the demand it found, counted. */
function ask(symbolId: string, question: Parameters<LexiconService["recallAnswer"]>[1]) {
	const recalled = service.recallAnswer(symbolId, question);
	const demand = service.demandOf(symbolId, question, recalled);
	if (demand !== null) service.recordDemand(demand);
	return recalled;
}

function plant(): string[] {
	store.replaceFile(
		"a.ref",
		"h1",
		[
			{
				symbolId: SYMBOL,
				kind: "class",
				name: "Cart",
				range: at(0),
				selectionRange: at(0),
				visibility: "public",
			},
		],
		[],
		[],
		[{ kind: "string", value: "cart.updated", range: at(1), containerId: SYMBOL }],
	);
	return store.declarationsIn("a.ref").map((d) => d.factId);
}

function plantWithComment(): string {
	store.replaceFile(
		"a.ref",
		"h1",
		[
			{
				symbolId: SYMBOL,
				kind: "class",
				name: "Cart",
				range: at(0),
				selectionRange: at(0),
				visibility: "public",
			},
		],
		[],
		[],
		[],
		"full",
		[
			{
				range: at(1),
				raw: "// Retains checkout state.",
				normalized: "Retains checkout state.",
				form: "leading",
				placement: "above",
				anchorId: SYMBOL,
			} satisfies AttachedComment,
		],
	);
	return store.commentsAnchoredTo(SYMBOL)[0]?.factId as string;
}

const HEADING = "lexicon markdown guide.md Principles/";

/** A heading and the prose under it, which is the document's answer to what a comment is for code. */
function plantWithDocRegion(): string {
	store.replaceFile(
		"guide.md",
		"h1",
		[
			{
				symbolId: HEADING,
				kind: "heading",
				name: "Principles",
				range: at(0),
				selectionRange: at(0),
				visibility: "public",
			},
		],
		[],
		[],
		[],
		"full",
		[],
		[{ range: at(1), text: "No band-aids. Weigh the long-run cost.", fenced: false, anchorId: HEADING }],
	);
	return store.docsAnchoredTo(HEADING)[0]?.factId as string;
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-answers-"));
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

const reasonOf = (outcome: { recorded: boolean; reason?: string }) => (outcome.recorded ? "" : outcome.reason);

/** Reason and action, both pinned. */
describe("every refusal is a named constructor", () => {
	it("needsProse: refuses blank prose and records nothing", async () => {
		const [declaration] = plant();
		const outcome = await service.recordAnswer(SYMBOL, "describe", "   ", [declaration as string]);
		expect(reasonOf(outcome)).toBe(refusal.needsProse());
		expect(service.recallAnswer(SYMBOL, "describe")).toBeNull();
	});

	it("proseTooLong: refuses past the limit, naming it and the length", async () => {
		const [declaration] = plant();
		const prose = "x".repeat(4001);
		const outcome = await service.recordAnswer(SYMBOL, "describe", prose, [declaration as string]);
		expect(reasonOf(outcome)).toBe(refusal.proseTooLong(4000, 4001));
		expect(service.recallAnswer(SYMBOL, "describe")).toBeNull();
	});

	it("noDoubtStands: refuses to clear a doubt that is not there, and keeps the answer", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);
		const outcome = await service.recordAnswer(SYMBOL, "describe", "A cart.", [declaration as string], {
			resolvesDoubt: "lexfact doubt a.ref 0000000000000000",
		});
		expect(reasonOf(outcome)).toBe(refusal.noDoubtStands("describe", SYMBOL));
		expect(service.recallAnswer(SYMBOL, "describe")?.answer.prose).toBe("A shopping cart.");
	});

	it("wrongDoubtId: refuses a token naming the wrong doubt, and the doubt stands", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);
		service.invalidateAnswer(SYMBOL, "checkout rewrite", "describe");
		const outcome = await service.recordAnswer(SYMBOL, "describe", "A cart.", [declaration as string], {
			resolvesDoubt: "lexfact doubt a.ref 0000000000000000",
		});
		expect(reasonOf(outcome)).toBe(refusal.wrongDoubtId());
		expect(service.recallAnswer(SYMBOL, "describe")?.answer.doubt?.reason).toBe("checkout rewrite");
	});

	it("replacesSoundAnswer: refuses a blind replacement, naming what it dropped", async () => {
		const [declaration] = plant();
		const literal = store.literalsContainedBy(SYMBOL, 1)[0]?.factId as string;
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string, literal]);
		const outcome = await service.recordAnswer(SYMBOL, "describe", "A cart.", [declaration as string]);
		expect(reasonOf(outcome)).toBe(refusal.replacesSoundAnswer());
		expect(outcome.recorded === false && outcome.uncovered).toEqual([literal]);
		expect(service.recallAnswer(SYMBOL, "describe")?.answer.prose).toBe("A shopping cart.");
	});

	it("doubtNeedsReason: refuses a blank reason and sets no doubt", async () => {
		const [declaration] = plant();
		const recorded = await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);
		expect(recorded.recorded).toBe(true);
		expect(service.invalidateAnswer(SYMBOL, " ", "describe").refused).toBe(refusal.doubtNeedsReason());
		expect(service.recallAnswer(SYMBOL, "describe")?.answer.doubt).toBeUndefined();
	});

	it("nothingToDoubt: refuses where nothing is recorded and opens no gap", () => {
		plant();
		expect(service.invalidateAnswer(SYMBOL, "drifted").refused).toBe(refusal.nothingToDoubt(SYMBOL));
		expect(store.askCount(SYMBOL, "describe")).toBe(0);
	});

	it("noAnswerToReaffirm: refuses where nothing is recorded and records nothing", async () => {
		plant();
		const outcome = await service.reaffirmAnswer(SYMBOL, "describe");
		expect(reasonOf(outcome)).toBe(refusal.noAnswerToReaffirm("describe", SYMBOL));
		expect(service.recallAnswer(SYMBOL, "describe")).toBeNull();
	});

	it("citationsNoLongerResolve: names the count and the stale ids", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);
		// The declaration moves down a line: still indexed, its fact id re-minted.
		store.replaceFile(
			"a.ref",
			"h2",
			[
				{
					symbolId: SYMBOL,
					kind: "class",
					name: "Cart",
					range: at(3),
					selectionRange: at(3),
					visibility: "public",
				},
			],
			[],
			[],
			[],
		);
		const outcome = await service.reaffirmAnswer(SYMBOL, "describe");
		expect(reasonOf(outcome)).toBe(refusal.citationsNoLongerResolve(1));
		expect(outcome.recorded === false && outcome.unresolved).toEqual([declaration as string]);
	});

	it("clearingRequiresCiting: refuses a re-affirmation that names no doubt, and the doubt stands", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);
		service.invalidateAnswer(SYMBOL, "checkout rewrite", "describe");
		const outcome = await service.reaffirmAnswer(SYMBOL, "describe");
		expect(reasonOf(outcome)).toBe(refusal.clearingRequiresCiting());
		expect(service.recallAnswer(SYMBOL, "describe")?.answer.doubt?.reason).toBe("checkout rewrite");
	});

	it("citesNothing: refuses an uncited answer and records nothing", async () => {
		plant();
		const outcome = await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", []);
		expect(reasonOf(outcome)).toBe(refusal.citesNothing());
		expect(service.recallAnswer(SYMBOL, "describe")).toBeNull();
	});

	it("malformedCitations: refuses a bare digest, naming it as the malformed one", async () => {
		plant();
		const outcome = await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", ["0000000000000000"]);
		expect(reasonOf(outcome)).toBe(refusal.malformedCitations(1));
		expect(outcome.recorded === false && outcome.unresolved).toEqual(["0000000000000000"]);
	});

	it("unresolvedCitations: refuses an id that resolves to nothing, naming it", async () => {
		plant();
		const ghost = "lexfact declaration a.ref 0000000000000000";
		const outcome = await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [ghost]);
		expect(reasonOf(outcome)).toBe(refusal.unresolvedCitations(1));
		expect(outcome.recorded === false && outcome.unresolved).toEqual([ghost]);
	});

	it("citesOnlyNeighbours: refuses an answer grounded elsewhere and records nothing", async () => {
		plant();
		store.replaceFile(
			"b.ref",
			"h1",
			[
				{
					symbolId: "lexicon reference b.ref send#",
					kind: "function",
					name: "send",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
				},
			],
			[],
		);
		const elsewhere = store.declarationsIn("b.ref")[0]?.factId as string;
		const outcome = await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [elsewhere]);
		expect(reasonOf(outcome)).toBe(refusal.citesOnlyNeighbours(SYMBOL));
		expect(service.recallAnswer(SYMBOL, "describe")).toBeNull();
	});

	it("factIdAsSubject: names the mix-up when a fact id sits in the subject slot", async () => {
		const [declaration] = plant();
		const outcome = await service.recordAnswer(declaration as string, "describe", "A cart.", [
			declaration as string,
		]);
		expect(reasonOf(outcome)).toBe(refusal.factIdAsSubject(declaration as string));
		expect(service.recallAnswer(declaration as string, "describe")).toBeNull();
	});

	it("unmintedId: lists what the module holds for an id it never minted", async () => {
		const [declaration] = plant();
		const unminted = "lexicon reference a.ref Cart";
		const outcome = await service.recordAnswer(unminted, "describe", "A cart.", [declaration as string]);
		expect(reasonOf(outcome)).toBe(refusal.unmintedId(unminted, "a.ref", [`\`${SYMBOL}\``], 0));
		expect(service.recallAnswer(unminted, "describe")).toBeNull();
	});

	it("unknownModule: names the module that is not indexed either", async () => {
		const [declaration] = plant();
		const gone = "lexicon reference gone.ref Cart#";
		const outcome = await service.recordAnswer(gone, "describe", "A cart.", [declaration as string]);
		expect(reasonOf(outcome)).toBe(refusal.unknownModule(gone, "gone.ref"));
		expect(service.recallAnswer(gone, "describe")).toBeNull();
	});

	it("unparsableId: names the grammar's failure for a spelling with no module to read", async () => {
		const [declaration] = plant();
		const junk = "lexicon";
		const parsed = parseSymbolIdResult(junk);
		const failure = parsed.ok ? "" : parsed.failure.message;
		const outcome = await service.recordAnswer(junk, "describe", "A cart.", [declaration as string]);
		expect(reasonOf(outcome)).toBe(refusal.unparsableId(junk, failure));
		expect(service.recallAnswer(junk, "describe")).toBeNull();
	});

	// Routing is proven above; the text itself is pinned here, independently of the constructor.
	it("pins the four reworded sentences to the plan's text", () => {
		expect<string>(refusal.needsProse()).toBe(
			"an answer needs prose. Send the sentence or two the cited facts establish in `prose`",
		);
		expect<string>(refusal.nothingToReaffirm()).toBe(
			"this answer is already sound: every citation resolves and no doubt stands. Re-affirming changes nothing. To replace its prose call `record_answer`; to doubt it call `invalidate_answer`",
		);
		expect<string>(refusal.nothingToDoubt("X")).toBe(
			"nothing is recorded about X, so there is no answer to doubt. Doubting an unwritten answer asks for one, and `record_answer` writes it",
		);
		expect<string>(refusal.noDoubtStands("why", "X")).toBe(
			"no doubt stands on the why answer about X, so omit `resolvesDoubt`. To raise one, call `invalidate_answer`",
		);
	});

	// The remedies differ, so the two sentences must stay tellable apart.
	it("keeps a bare digest and a dead id on different remedies", () => {
		expect(refusal.malformedCitations(1)).toMatch(/not a fact id|digest alone/);
		expect(refusal.malformedCitations(1)).not.toMatch(/re-derived/);
		expect(refusal.unresolvedCitations(1)).toMatch(/re-derived|invented/);
	});
});

/**
 * The layer's one rule, enforced by the store rather than asked for in a prompt.
 *
 * Nothing here calls a model. The core hands over facts, takes back prose and the ids it was drawn
 * from, and refuses what it cannot verify. That is what makes "never ask the model cold" a property
 * of the system instead of an instruction somebody can ignore.
 */
describe("writing an answer down", () => {
	it("records prose with the facts it was drawn from", async () => {
		const [declaration] = plant();
		const outcome = await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string], {
			model: "test",
		});

		expect(outcome.recorded).toBe(true);
		expect(service.recallAnswer(SYMBOL, "describe")?.answer.prose).toBe("A shopping cart.");
	});

	it("records an answer citing an attached comment", async () => {
		const comment = plantWithComment();

		const outcome = await service.recordAnswer(SYMBOL, "why", "Retains checkout state.", [comment]);

		expect(outcome.recorded).toBe(true);
	});

	// A module can hold hundreds of declarations, and the first eight in store order are rarely the
	// one meant. The name the author typed is in the bad id, so declarations carrying it lead.
	it("leads the shortlist with the declaration whose name the bad id carries", async () => {
		const TOTAL = "lexicon reference a.ref Total#";
		store.replaceFile(
			"a.ref",
			"h2",
			[
				{
					symbolId: SYMBOL,
					kind: "class",
					name: "Cart",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
				},
				{
					symbolId: TOTAL,
					kind: "class",
					name: "Total",
					range: at(1),
					selectionRange: at(1),
					visibility: "public",
				},
			],
			[],
			[],
			[],
		);

		const outcome = await service.recordAnswer("lexicon reference a.ref Total", "describe", "A total.", []);

		expect(outcome.recorded).toBe(false);
		const reason = !outcome.recorded ? outcome.reason : "";
		expect(reason.indexOf(TOTAL)).toBeGreaterThan(-1);
		expect(reason.indexOf(TOTAL)).toBeLessThan(reason.indexOf(SYMBOL));
	});

	// The other two writers refuse the same way, or a wrong id is handed from one to the next.
	it("refuses a fact id as the subject of a re-affirmation, naming the mix-up", async () => {
		const [declaration] = plant();

		const outcome = await service.reaffirmAnswer(declaration as string, "describe");

		expect(outcome.recorded).toBe(false);
		expect(!outcome.recorded && outcome.reason).toContain("is a fact id, not a symbol id");
	});

	// Doubting an unwritten answer records demand for one. Against an id nothing was minted under,
	// that demand would name a dead id forever, which is how ghost rows lead the gap list.
	it("refuses to doubt a symbol the index never held, and records no demand for it", async () => {
		plant();
		const ghost = "lexicon reference a.ref Ghost#";

		const outcome = service.invalidateAnswer(ghost, "looks wrong", "describe");

		expect(outcome.refused).toContain("is not in the index");
		expect(service.knowledgeGaps().rows.map((row) => row.symbolId)).not.toContain(ghost);
	});

	// Prose under a heading is evidence about that heading, the way a comment is evidence about the
	// symbol it documents. An answer about a section could otherwise cite nothing at all.
	it("records an answer citing the prose under a heading", async () => {
		const region = plantWithDocRegion();

		const facts = await service.factsFor(HEADING);
		const outcome = await service.recordAnswer(HEADING, "why", "Workarounds cost more later.", [region]);

		expect(facts?.facts.map((fact) => fact.kind)).toContain("doc");
		expect(outcome.recorded).toBe(true);
	});

	it("refuses empty prose, and prose longer than an answer is meant to be", async () => {
		const [declaration] = plant();
		const cite = [declaration as string];

		expect(await service.recordAnswer(SYMBOL, "describe", "   ", cite)).toMatchObject({ recorded: false });
		expect(await service.recordAnswer(SYMBOL, "describe", "x".repeat(5000), cite)).toMatchObject({
			recorded: false,
		});
	});

	it("replaces rather than accumulating, since one symbol has one current answer per question", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "First.", [declaration as string]);
		await service.recordAnswer(SYMBOL, "describe", "Second.", [declaration as string]);

		expect(service.recallAnswer(SYMBOL, "describe")?.answer.prose).toBe("Second.");
		expect(service.recallAnswers(SYMBOL)).toHaveLength(1);
	});

	it("keeps answers to different questions about one symbol apart", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "What it is.", [declaration as string]);
		await service.recordAnswer(SYMBOL, "contract", "What callers may assume.", [declaration as string]);

		expect(
			service
				.recallAnswers(SYMBOL)
				.map((r) => r.answer.question)
				.sort(),
		).toEqual(["contract", "describe"]);
	});
});

/**
 * Invalidation as a lookup rather than a judgement.
 *
 * This is the mechanical path `docs/knowledge-layer.md` puts first, and the reason a fact id is a
 * digest of its contents rather than a row number: noticing costs a comparison and no model call.
 */
describe("noticing that an answer's ground moved", () => {
	it("reports nothing stale while every cited fact still holds", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);

		expect(service.recallAnswer(SYMBOL, "describe")?.stale).toEqual([]);
	});

	it("names the cited facts that no longer resolve once the code changed", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);

		store.replaceFile(
			"a.ref",
			"h2",
			[
				{
					symbolId: SYMBOL,
					kind: "class",
					name: "Cart",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
					signature: "class Cart implements Basket",
				},
			],
			[],
		);

		const recalled = service.recallAnswer(SYMBOL, "describe");
		if (declaration === undefined) throw new Error("declaration citation missing");
		expect(recalled?.stale).toEqual([declaration]);
		// The prose is still returned. A stale answer is worth reading next to the reason it is
		// stale, and withholding it would leave a caller with nothing at all.
		expect(recalled?.answer.prose).toBe("A shopping cart.");
	});

	it("answers null for a question nobody has answered, rather than empty prose", () => {
		plant();
		expect(service.recallAnswer(SYMBOL, "describe")).toBeNull();
	});
});

/**
 * Answers are the one thing here a re-index cannot regenerate.
 *
 * Facts are derivable from source, so a rebuild is a re-index. Prose written by people and models
 * is not, and a schema bump or provider change was silently deleting it. Citations keep working
 * across the rebuild because a fact id is a digest of content: unchanged code mints identical ids.
 */
describe("the knowledge base surviving a rebuild", () => {
	it("keeps answers and their demand ledger when the indexer fingerprint changes", async () => {
		const file = path.join(dir, "survive.sqlite");
		const first = IndexStore.open(file, "fingerprint-a");
		const built = new LexiconService(
			first.store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		first.store.replaceFile(
			"a.ref",
			"h1",
			[
				{
					symbolId: SYMBOL,
					kind: "class",
					name: "Cart",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
				},
			],
			[],
		);
		const cited = first.store.declarationsIn("a.ref")[0]?.factId as string;
		await built.recordAnswer(SYMBOL, "describe", "A shopping cart.", [cited]);
		built.recallAnswer("lexicon reference a.ref Cart#", "why");
		first.store.close();

		const second = IndexStore.open(file, "fingerprint-b");
		expect(second.rebuilt).toBe(true);

		const survivor = new LexiconService(
			second.store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		const recalled = survivor.recallAnswer(SYMBOL, "describe");
		expect(recalled?.answer.prose).toBe("A shopping cart.");
		// The FACTS are gone until a re-index, so the answer honestly reports stale right now.
		expect(recalled?.stale).toEqual([cited]);

		// Re-indexing the unchanged file mints the identical fact id, and the citation heals.
		second.store.replaceFile(
			"a.ref",
			"h1",
			[
				{
					symbolId: SYMBOL,
					kind: "class",
					name: "Cart",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
				},
			],
			[],
		);
		expect(survivor.recallAnswer(SYMBOL, "describe")?.stale).toEqual([]);
		second.store.close();
	});
});

/**
 * The thinness grade: the engine detecting the lazy answer, not just the ungrounded one.
 */
describe("grading a thin answer", () => {
	it("marks an answer citing only the subject's declaration, and says so at record time", async () => {
		const [declaration] = plant();
		const outcome = await service.recordAnswer(SYMBOL, "describe", "A cart class.", [declaration as string]);

		expect(outcome.recorded && outcome.answer.thin).toBe(true);
		expect(service.recallAnswer(SYMBOL, "describe")?.answer.thin).toBe(true);
	});

	it("does not mark an answer that reaches a literal, a reference or a child answer", async () => {
		const facts = plant();
		const literal = facts.find(() => true);
		const literalFact = store.literalsWithValue("cart.updated", 5)[0]?.factId as string;
		const outcome = await service.recordAnswer(SYMBOL, "describe", "Announces cart.updated.", [
			literal as string,
			literalFact,
		]);

		expect(outcome.recorded && outcome.answer.thin).toBe(false);
	});
});

/**
 * Answers are facts one layer up: an answer has a citable id, so a parent's description can lean
 * on a child's and doubt travels upward through the same resolution that catches an edited file.
 */
describe("answers citing answers", () => {
	const CHILD = "lexicon reference b.ref send#";

	function plantChild(): string {
		store.replaceFile(
			"b.ref",
			"h1",
			[
				{
					symbolId: CHILD,
					kind: "function",
					name: "send",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
				},
			],
			[],
		);
		return store.declarationsIn("b.ref")[0]?.factId as string;
	}

	it("lets a parent's answer cite a child's answer as one of its inputs", async () => {
		const [cartFact] = plant();
		const childFact = plantChild();

		const child = await service.recordAnswer(CHILD, "describe", "Sends one frame.", [childFact]);
		const childAnswerId = child.recorded ? child.answer.factId : "";

		const parent = await service.recordAnswer(SYMBOL, "describe", "Retries around send.", [
			cartFact as string,
			childAnswerId,
		]);

		expect(parent.recorded).toBe(true);
		expect(service.recallAnswer(SYMBOL, "describe")?.stale).toEqual([]);
	});

	// The cascade. The child's answer still RESOLVES, so it is not in `stale`; what it says is in
	// doubt, so leaning on it is too. The two lists call for different remedies.
	it("marks a parent shaky when the child's own ground moved, without calling the child dead", async () => {
		const [cartFact] = plant();
		const childFact = plantChild();
		const child = await service.recordAnswer(CHILD, "describe", "Sends one frame.", [childFact]);
		const childAnswerId = child.recorded ? child.answer.factId : "";
		await service.recordAnswer(SYMBOL, "describe", "Retries around send.", [cartFact as string, childAnswerId]);

		// The child's cited declaration changes underneath it.
		store.replaceFile(
			"b.ref",
			"h2",
			[
				{
					symbolId: CHILD,
					kind: "function",
					name: "send",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
					signature: "(frame: Frame) => Promise<void>",
				},
			],
			[],
		);

		const recalled = service.recallAnswer(SYMBOL, "describe");
		expect(recalled?.stale).toEqual([]);
		expect(recalled?.inheritedStale).toEqual([childAnswerId]);
	});

	it("retires the old answer id when an answer is re-recorded, going stale in its dependents", async () => {
		const [cartFact] = plant();
		const childFact = plantChild();
		const child = await service.recordAnswer(CHILD, "describe", "Sends one frame.", [childFact]);
		const childAnswerId = child.recorded ? child.answer.factId : "";
		await service.recordAnswer(SYMBOL, "describe", "Retries around send.", [cartFact as string, childAnswerId]);

		await service.recordAnswer(CHILD, "describe", "Sends one frame, buffering under pressure.", [childFact]);

		expect(service.recallAnswer(SYMBOL, "describe")?.stale).toEqual([childAnswerId]);
	});
});

/**
 * The ledger half: demand for missing knowledge is measured, never guessed.
 */
describe("the gap ledger", () => {
	it("counts each ask that found nothing", () => {
		plant();
		ask(SYMBOL, "describe");
		ask(SYMBOL, "describe");

		const gaps = service.knowledgeGaps();
		expect(gaps.rows).toHaveLength(1);
		expect(gaps.rows[0]).toMatchObject({ symbolId: SYMBOL, askCount: 2, why: "missing" });
	});

	it("counts nothing on the read itself, and counts through the daemon as the daemon's own write", async () => {
		plant();
		service.recallAnswer(SYMBOL, "describe");
		expect(service.knowledgeGaps().rows).toEqual([]);

		const dispatch = createDispatch(service);
		await dispatch("recallAnswer", { symbolId: SYMBOL, question: "describe" });
		await dispatch("recallAnswer", { symbolId: SYMBOL, question: "describe" });

		expect(service.knowledgeGaps().rows[0]).toMatchObject({ symbolId: SYMBOL, askCount: 2, why: "missing" });
	});

	// A typo asked about forever would otherwise sit in the queue looking like demand.
	it("does not open a gap for a symbol the index does not hold", () => {
		plant();
		ask("lexicon reference a.ref Ghost#", "describe");

		expect(service.knowledgeGaps().rows).toEqual([]);
	});

	it("closes the gap the moment an answer lands", async () => {
		const [cartFact] = plant();
		ask(SYMBOL, "describe");
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [cartFact as string]);

		expect(service.knowledgeGaps().rows).toEqual([]);
	});

	it("reopens as stale when the answer's ground moves, and lists it before the missing", async () => {
		const [cartFact] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [cartFact as string]);

		store.replaceFile(
			"a.ref",
			"h2",
			[
				{
					symbolId: SYMBOL,
					kind: "class",
					name: "Cart",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
					signature: "class Cart implements Basket",
				},
			],
			[],
		);
		ask(SYMBOL, "describe");

		expect(service.knowledgeGaps().rows[0]).toMatchObject({ symbolId: SYMBOL, why: "stale" });
	});

	// The ledger measures demand, and an answer that went unhealthy since anyone last asked has no
	// row in it. A healer once got the seeded fallback six times in a row while overview knew the
	// truth, because the recheck list only listened to asks.
	it("surfaces an answer gone stale with no recorded demand at all", async () => {
		const [cartFact] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [cartFact as string]);
		store.replaceFile(
			"a.ref",
			"h2",
			[
				{
					symbolId: SYMBOL,
					kind: "class",
					name: "Cart",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
					signature: "class Cart implements Basket",
				},
			],
			[],
		);

		// Deliberately no recall between the ground moving and the ask for gaps.
		expect(service.knowledgeGaps().rows[0]).toMatchObject({ symbolId: SYMBOL, why: "stale" });
	});

	it("surfaces a doubted answer even when nothing ever landed in the ledger", async () => {
		const [cartFact] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [cartFact as string]);
		// Straight onto the row, bypassing invalidateAnswer's own gap write, so the ledger stays empty.
		store.setDoubt(SYMBOL, "describe", {
			factId: "lexfact doubt a.ref 0000000000000000",
			reason: "drifted",
			at: 1,
		});

		expect(service.knowledgeGaps().rows[0]).toMatchObject({ symbolId: SYMBOL, why: "doubted" });
	});
});

/**
 * The tree, leaves first, because a parent's description gets to lean on its children's and the
 * leaves are usually the cheap ones.
 */
describe("the gap tree under a root", () => {
	const IDS = {
		top: "lexicon reference t.ref top#",
		mid: "lexicon reference t.ref mid#",
		leaf: "lexicon reference t.ref leaf#",
	};

	/** top uses mid, mid uses leaf, and mid also calls something outside the index. */
	function plantTree() {
		store.replaceFile(
			"t.ref",
			"h1",
			Object.entries(IDS).map(([name, symbolId]) => ({
				symbolId,
				kind: "function" as const,
				name,
				range: at(0),
				selectionRange: at(0),
				visibility: "public" as const,
			})),
			[
				{
					name: "mid",
					range: at(1),
					role: "call" as const,
					fromId: IDS.top,
					binding: { status: "bound", symbolId: IDS.mid, provenance: "bound" } as const,
				},
				{
					name: "leaf",
					range: at(2),
					role: "call" as const,
					fromId: IDS.mid,
					binding: { status: "bound", symbolId: IDS.leaf, provenance: "bound" } as const,
				},
				{
					name: "outside",
					range: at(3),
					role: "call" as const,
					fromId: IDS.mid,
					binding: {
						status: "bound",
						symbolId: "lexicon reference gone.ref outside#",
						provenance: "bound",
					} as const,
				},
			],
		);
	}

	it("orders leaves before the things that use them", () => {
		plantTree();
		const gaps = service.knowledgeGaps(IDS.top);

		expect(gaps.rows.map((row) => row.name)).toEqual(["leaf", "mid", "top"]);
	});

	it("counts a dependency outside the index rather than listing the unanswerable", () => {
		plantTree();
		expect(service.knowledgeGaps(IDS.top).external).toBe(1);
	});

	it("drops an answered symbol out of the tree, which is what makes a drain resumable", async () => {
		plantTree();
		const leafFact = store.declarationsIn("t.ref").find((d) => d.name === "leaf")?.factId as string;
		await service.recordAnswer(IDS.leaf, "describe", "The bottom.", [leafFact]);

		expect(service.knowledgeGaps(IDS.top).rows.map((row) => row.name)).toEqual(["mid", "top"]);
	});

	it("survives a cycle, flattening it where it occurs rather than recursing forever", () => {
		const a = "lexicon reference c.ref a#";
		const b = "lexicon reference c.ref b#";
		store.replaceFile(
			"c.ref",
			"h1",
			[
				{ symbolId: a, kind: "function", name: "a", range: at(0), selectionRange: at(0), visibility: "public" },
				{ symbolId: b, kind: "function", name: "b", range: at(1), selectionRange: at(1), visibility: "public" },
			],
			[
				{
					name: "b",
					range: at(2),
					role: "call",
					fromId: a,
					binding: { status: "bound", symbolId: b, provenance: "bound" },
				},
				{
					name: "a",
					range: at(3),
					role: "call",
					fromId: b,
					binding: { status: "bound", symbolId: a, provenance: "bound" },
				},
			],
		);

		expect(
			service
				.knowledgeGaps(a)
				.rows.map((row) => row.name)
				.sort(),
		).toEqual(["a", "b"]);
	});
});

/**
 * Declared invalidation: the middle state between fresh and rewritten.
 *
 * Mechanical staleness cannot see semantic drift, so someone who changed what a symbol MEANS flags
 * the recorded prose instead. The flag must survive a writer who never saw it, or a parallel lane
 * erases a warning by accident, which is the race that shaped this design.
 */
describe("the gaps in one file", () => {
	const IDS = {
		cart: "lexicon reference m.ref Cart#",
		line: "lexicon reference m.ref Line#",
		other: "lexicon reference n.ref Other#",
	};

	/** Two declarations in one file, one in another, and the other file's symbol using Cart. */
	function plantFiles() {
		const declare = (symbolId: string, name: string) => ({
			symbolId,
			kind: "class" as const,
			name,
			range: at(0),
			selectionRange: at(0),
			visibility: "public" as const,
		});
		// Line first on purpose: only fan-in puts Cart ahead of it.
		store.replaceFile("m.ref", "h1", [declare(IDS.line, "Line"), declare(IDS.cart, "Cart")], []);
		store.replaceFile(
			"n.ref",
			"h2",
			[declare(IDS.other, "Other")],
			[
				{
					name: "Cart",
					range: at(1),
					role: "call" as const,
					fromId: IDS.other,
					binding: { status: "bound", symbolId: IDS.cart, provenance: "bound" } as const,
				},
			],
		);
	}

	// The question is "what is unanswered HERE", so nobody needs to have asked first.
	it("lists the file's own declarations without answers, most used first, and nothing from elsewhere", () => {
		plantFiles();
		const gaps = service.knowledgeGaps(undefined, "describe", 60, "m.ref");

		expect(gaps.rows.map((row) => row.name)).toEqual(["Cart", "Line"]);
		expect(gaps.rows.map((row) => row.askCount)).toEqual([0, 0]);
		expect(gaps.scope).toEqual({ module: "m.ref", declarations: 2 });
	});

	it("counts the demand per row and the total past the limit", () => {
		plantFiles();
		ask(IDS.line, "describe");
		ask(IDS.line, "describe");
		const gaps = service.knowledgeGaps(undefined, "describe", 1, "m.ref");

		expect(gaps.rows.map((row) => [row.name, row.askCount])).toEqual([["Cart", 0]]);
		expect(gaps.total).toBe(2);
		expect(service.knowledgeGaps(undefined, "describe", 60, "m.ref").rows[1]?.askCount).toBe(2);
	});

	it("drops an answered declaration and leads with one whose answer went stale", async () => {
		plantFiles();
		const facts = store.declarationsIn("m.ref");
		const cartFact = facts.find((d) => d.name === "Cart")?.factId as string;
		const lineFact = facts.find((d) => d.name === "Line")?.factId as string;
		await service.recordAnswer(IDS.cart, "describe", "Holds lines.", [cartFact]);
		await service.recordAnswer(IDS.line, "describe", "One row.", [lineFact]);
		expect(service.knowledgeGaps(undefined, "describe", 60, "m.ref").rows).toEqual([]);

		// Line's fact id changes with its declaration, so its citation no longer resolves.
		store.replaceFile(
			"m.ref",
			"h3",
			[
				{
					symbolId: IDS.cart,
					kind: "class",
					name: "Cart",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
				},
				{
					symbolId: IDS.line,
					kind: "class",
					name: "Line",
					range: at(5),
					selectionRange: at(5),
					visibility: "private",
				},
			],
			[],
		);

		expect(
			service.knowledgeGaps(undefined, "describe", 60, "m.ref").rows.map((row) => [row.name, row.why]),
		).toEqual([["Line", "stale"]]);
	});

	// A file the index does not hold must not read as clean.
	it("says a file with no indexed declarations is unindexed rather than clean", () => {
		plantFiles();
		const gaps = service.knowledgeGaps(undefined, "describe", 60, "nowhere.ref");

		expect(gaps.rows).toEqual([]);
		expect(gaps.scope).toEqual({ module: "nowhere.ref", declarations: 0 });
	});

	it("ignores the file when a root is given, since the tree is the scope then", () => {
		plantFiles();
		const gaps = service.knowledgeGaps(IDS.other, "describe", 60, "m.ref");

		expect(gaps.scope).toBeUndefined();
		expect(gaps.rows.map((row) => row.name)).toEqual(["Cart", "Other"]);
	});
});

describe("declared doubt", () => {
	it("shows on recall with the reason and the id that clears it, without retiring the answer", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);

		const outcome = service.invalidateAnswer(SYMBOL, "purpose changed in the checkout rewrite", "describe", "me");
		expect(outcome.doubted).toHaveLength(1);

		const recalled = service.recallAnswer(SYMBOL, "describe");
		expect(recalled?.answer.doubt?.reason).toBe("purpose changed in the checkout rewrite");
		expect(recalled?.answer.doubt?.factId).toBe(outcome.doubted[0]?.doubt.factId);
		expect(recalled?.stale).toEqual([]);
	});

	it("cascades into an answer citing the doubted one, as its own list with its own remedy", async () => {
		const [cartFact] = plant();
		store.replaceFile(
			"b.ref",
			"h1",
			[
				{
					symbolId: "lexicon reference b.ref send#",
					kind: "function",
					name: "send",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
				},
			],
			[],
		);
		const childFact = store.declarationsIn("b.ref")[0]?.factId as string;
		const child = await service.recordAnswer("lexicon reference b.ref send#", "describe", "Sends one frame.", [
			childFact,
		]);
		const childAnswerId = child.recorded ? child.answer.factId : "";
		await service.recordAnswer(SYMBOL, "describe", "Retries around send.", [cartFact as string, childAnswerId]);

		service.invalidateAnswer("lexicon reference b.ref send#", "send now batches", "describe");

		const recalled = service.recallAnswer(SYMBOL, "describe");
		expect(recalled?.stale).toEqual([]);
		expect(recalled?.inheritedStale).toEqual([]);
		expect(recalled?.doubtedUpstream).toEqual([childAnswerId]);
	});

	it("rides forward over a re-record that never cited it", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);
		service.invalidateAnswer(SYMBOL, "checkout rewrite", "describe");

		const outcome = await service.recordAnswer(SYMBOL, "describe", "A cart, rewritten blind.", [
			declaration as string,
		]);
		expect(outcome.recorded && outcome.doubtCarried?.reason).toBe("checkout rewrite");
		expect(service.recallAnswer(SYMBOL, "describe")?.answer.doubt?.reason).toBe("checkout rewrite");
	});

	it("clears when the writer cites the doubt id, which only a recall shows", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);
		service.invalidateAnswer(SYMBOL, "checkout rewrite", "describe");

		const token = service.recallAnswer(SYMBOL, "describe")?.answer.doubt?.factId as string;
		const outcome = await service.recordAnswer(
			SYMBOL,
			"describe",
			"A cart holding checkout state.",
			[declaration as string],
			{ resolvesDoubt: token },
		);

		expect(outcome.recorded).toBe(true);
		expect(service.recallAnswer(SYMBOL, "describe")?.answer.doubt).toBeUndefined();
	});

	it("re-enters the gap ledger as recheck demand, named doubted rather than stale", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);
		service.invalidateAnswer(SYMBOL, "checkout rewrite", "describe");

		expect(service.knowledgeGaps().rows[0]).toMatchObject({ symbolId: SYMBOL, why: "doubted" });
		// Tree mode surfaces it too: an answered node re-enters the tree while its answer is doubted.
		expect(service.knowledgeGaps(SYMBOL).rows[0]).toMatchObject({ symbolId: SYMBOL, why: "doubted" });
	});

	it("survives a rebuild alongside the answer it rides on", async () => {
		const file = path.join(dir, "doubt-survive.sqlite");
		const first = IndexStore.open(file, "fingerprint-a");
		const built = new LexiconService(
			first.store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		first.store.replaceFile(
			"a.ref",
			"h1",
			[
				{
					symbolId: SYMBOL,
					kind: "class",
					name: "Cart",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
				},
			],
			[],
		);
		const cited = first.store.declarationsIn("a.ref")[0]?.factId as string;
		await built.recordAnswer(SYMBOL, "describe", "A shopping cart.", [cited]);
		built.invalidateAnswer(SYMBOL, "checkout rewrite", "describe");
		first.store.close();

		const second = IndexStore.open(file, "fingerprint-b");
		expect(second.rebuilt).toBe(true);
		const survivor = new LexiconService(
			second.store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		expect(survivor.recallAnswer(SYMBOL, "describe")?.answer.doubt?.reason).toBe("checkout rewrite");
		second.store.close();
	});
});

/**
 * Re-affirm: healing an answer's ground without re-authoring its prose.
 *
 * The flow the 139 provider-upgrade staled answers were waiting for: recall names the dead ids,
 * symbol_facts has the current ones, and one call re-grounds the same words.
 */
describe("re-affirming an answer", () => {
	it("re-grounds the same prose on current citations in one call", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);

		store.replaceFile(
			"a.ref",
			"h2",
			[
				{
					symbolId: SYMBOL,
					kind: "class",
					name: "Cart",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
					signature: "class Cart implements Basket",
				},
			],
			[],
		);
		if (declaration === undefined) throw new Error("declaration citation missing");
		expect(service.recallAnswer(SYMBOL, "describe")?.stale).toEqual([declaration]);

		const current = store.declarationsIn("a.ref")[0]?.factId as string;
		const outcome = await service.reaffirmAnswer(SYMBOL, "describe", { citations: [current] });

		expect(outcome.recorded).toBe(true);
		const healed = service.recallAnswer(SYMBOL, "describe");
		expect(healed?.answer.prose).toBe("A shopping cart.");
		expect(healed?.stale).toEqual([]);
	});

	it("clears a doubt while keeping the answer's id, so nothing citing it goes stale", async () => {
		const [declaration] = plant();
		const recorded = await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);
		const originalId = recorded.recorded ? recorded.answer.factId : "";
		service.invalidateAnswer(SYMBOL, "checkout rewrite", "describe");
		const token = service.recallAnswer(SYMBOL, "describe")?.answer.doubt?.factId as string;

		const outcome = await service.reaffirmAnswer(SYMBOL, "describe", { resolvesDoubt: token });

		expect(outcome.recorded).toBe(true);
		expect(outcome.recorded && outcome.answer.factId).toBe(originalId);
		expect(service.recallAnswer(SYMBOL, "describe")?.answer.doubt).toBeUndefined();
	});

	it("says when there is nothing to re-affirm rather than pretending to work", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);

		const outcome = await service.reaffirmAnswer(SYMBOL, "describe");
		expect(outcome.recorded).toBe(false);
		expect(outcome.recorded === false && outcome.reason).toBe(refusal.nothingToReaffirm());
	});

	it("retires the answer id on re-grounding, so parents heal the same way, leaves first", async () => {
		const [cartFact] = plant();
		store.replaceFile(
			"b.ref",
			"h1",
			[
				{
					symbolId: "lexicon reference b.ref send#",
					kind: "function",
					name: "send",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
				},
			],
			[],
		);
		const childFact = store.declarationsIn("b.ref")[0]?.factId as string;
		const child = await service.recordAnswer("lexicon reference b.ref send#", "describe", "Sends one frame.", [
			childFact,
		]);
		const oldChildAnswerId = child.recorded ? child.answer.factId : "";
		await service.recordAnswer(SYMBOL, "describe", "Retries around send.", [cartFact as string, oldChildAnswerId]);

		// The child's ground moves, then heals by re-affirmation onto the current fact.
		store.replaceFile(
			"b.ref",
			"h2",
			[
				{
					symbolId: "lexicon reference b.ref send#",
					kind: "function",
					name: "send",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
					signature: "(frame: Frame) => void",
				},
			],
			[],
		);
		const currentChildFact = store.declarationsIn("b.ref")[0]?.factId as string;
		const healed = await service.reaffirmAnswer("lexicon reference b.ref send#", "describe", {
			citations: [currentChildFact],
		});
		const newChildAnswerId = healed.recorded ? healed.answer.factId : "";
		expect(newChildAnswerId).not.toBe(oldChildAnswerId);

		// The parent now points at the retired child answer, and heals with the same one call.
		expect(service.recallAnswer(SYMBOL, "describe")?.stale).toEqual([oldChildAnswerId]);
		const parentHealed = await service.reaffirmAnswer(SYMBOL, "describe", {
			citations: [cartFact as string, newChildAnswerId],
		});
		expect(parentHealed.recorded).toBe(true);
		expect(service.recallAnswer(SYMBOL, "describe")?.stale).toEqual([]);
	});
});

/**
 * The adjudicated-supersede gate: replacing an answer that is wrong while every cited input still
 * holds is a judgement call, so the challenger covers the incumbent's facts or explains what it
 * drops. A stale or doubted incumbent is already invited to be rewritten, so the gate stands down.
 */
describe("the adjudicated supersede gate", () => {
	it("accepts a challenger that explains the omission", async () => {
		const [declaration] = plant();
		const literal = store.literalsContainedBy(SYMBOL, 10)[0]?.factId as string;
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string, literal]);

		const outcome = await service.recordAnswer(
			SYMBOL,
			"describe",
			"Actually a wishlist.",
			[declaration as string],
			{
				omitting: "the event literal is emitted by a neighbour, not this class",
			},
		);
		expect(outcome.recorded).toBe(true);
	});

	it("accepts a challenger that covers the incumbent's facts", async () => {
		const [declaration] = plant();
		const literal = store.literalsContainedBy(SYMBOL, 10)[0]?.factId as string;
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);

		const outcome = await service.recordAnswer(SYMBOL, "describe", "A cart that emits cart.updated.", [
			declaration as string,
			literal,
		]);
		expect(outcome.recorded).toBe(true);
	});

	it("stands down for a stale incumbent, which is already invited to be rewritten", async () => {
		const [declaration] = plant();
		await service.recordAnswer(SYMBOL, "describe", "A shopping cart.", [declaration as string]);
		store.replaceFile(
			"a.ref",
			"h2",
			[
				{
					symbolId: SYMBOL,
					kind: "class",
					name: "Cart",
					range: at(0),
					selectionRange: at(0),
					visibility: "public",
					signature: "class Cart implements Basket",
				},
			],
			[],
		);
		const current = store.declarationsIn("a.ref")[0]?.factId as string;

		const outcome = await service.recordAnswer(SYMBOL, "describe", "A cart implementing Basket.", [current]);
		expect(outcome.recorded).toBe(true);
	});
});
