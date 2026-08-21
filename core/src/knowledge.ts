// Recorded knowledge, and the facts an answer may cite.
//
// One owner: every fact exists to be cited, and staleness is cited facts moving. Reads only, so
// recording an answer stays cheap enough to be a habit.

import { answerFactId, doubtFactId, type FactKind } from "@nyaa-lexicon/protocol";
import {
	type Answer,
	checkCitations,
	type Doubt,
	MAX_PROSE,
	type QuestionClass,
	type RecalledAnswer,
	type RecordOutcome,
} from "./answers.js";
import type { ImportResolver } from "./imports.js";
import type { IndexStore, StoredFact } from "./store.js";

////////////////////////////////
//  Constants

/** What a walk found beneath one answer. Mutated in place so a cycle reads the partial result. */
interface ShakyResult {
	stale: boolean;
	doubted: boolean;
}

/**
 * Above this many answers, overview stops computing exact staleness.
 *
 * The scan costs a citation resolve per answer on the most-called tool. Skipped rather than
 * sampled past the cap, and the render says so, because a partial number would read as the whole.
 */
const STALE_SCAN_CAP = 2000;

/** A page of gaps. The queue is ranked, so the top of it is where the value is anyway. */
export const DEFAULT_GAP_LIMIT = 60;

/**
 * Where the dependency walk stops. A hub's transitive fan-out can reach most of a workspace, and a
 * tree that large is a seeding pass, not a tree; the cap is reported so it never reads as the total.
 */
const GAP_TREE_CAP = 500;

////////////////////////////////
//  Interfaces & Types

/**
 * One fact, named so an answer can cite it and a later reader can resolve it.
 *
 * `summary` rides along because a citation nobody can read without a second lookup does not get
 * read. The id is the machine-checkable part and the summary is for whoever is looking at it.
 */
export interface CitedFact {
	factId: string;
	kind: FactKind;
	module: string;
	summary: string;
}

/**
 * Everything tier 1 knows about one symbol, as citable facts.
 *
 * The candidate generator `docs/knowledge-layer.md` puts in front of every question class. A
 * question class picks from this, writes a sentence, and lists the ids it used, so the cache key is
 * a hash of those ids and going stale is a lookup rather than a judgement.
 */
export interface FactSet {
	symbolId: string;
	facts: CitedFact[];
	/** Kinds that were cut off by a limit, so a thin answer is never mistaken for a complete one. */
	truncated: FactKind[];
}

/** One place knowledge is missing or doubtful, with enough context to decide whether to write it. */
export interface GapRow {
	symbolId: string;
	question: string;
	/** `stale` and `doubted` answers lead a global listing: the prose exists and needs rechecking. */
	why: "missing" | "stale" | "doubted";
	/** Asks that found nothing, the measured demand. Zero inside a tree nobody asked about yet. */
	askCount: number;
	fanIn: number;
	name?: string;
	kind?: string;
	module?: string;
}

/** What declaring a doubt did, per question, including the questions that had nothing to doubt. */
export interface InvalidateOutcome {
	symbolId: string;
	doubted: Array<{ question: QuestionClass; doubt: Doubt }>;
	/** Questions with no recorded answer: counted as gap demand rather than doubted. */
	noAnswer: QuestionClass[];
	/** Set when nothing was done at all, with the reason. */
	refused?: string;
}

export interface KnowledgeGaps {
	question: string;
	/** Leaves first in root mode, so answering in order lets each parent lean on its children. */
	rows: GapRow[];
	total: number;
	/** Dependencies outside the index, counted not listed: nothing citable exists for them. */
	external: number;
	truncated: boolean;
	/** Set when the ledger was empty and the rows are hub-ranked candidates, not measured demand. */
	seeded?: boolean;
	/**
	 * Set when the knowledge base is too large to resolve every answer's citations here. Doubted
	 * answers are still swept, since that is one indexed read; stale ones surface on recall.
	 */
	staleScanSkipped?: boolean;
}

/** Per kind, not overall, so a symbol with a thousand references does not crowd out its literals. */
export const DEFAULT_FACT_LIMIT = 40;

/**
 * Below this many gaps, the invitation is to close them NOW, in a subagent where one is available,
 * since the asker presumably needs these answers to proceed. At or above it, the honest advice is a
 * background agent and moving on. The seam is wall-clock: at one to two answers a minute, this many
 * is about the longest a working task should block on knowledge it is waiting to lean on.
 */
export const INLINE_GAP_THRESHOLD = 20;

////////////////////////////////
//  Class

/** Takes the resolver because a fact set includes the imports that brought a name in. */
export class KnowledgeLedger {
	constructor(
		private readonly store: IndexStore,
		private readonly imports: ImportResolver,
	) {}

	/**
	 * Answers standing on facts that moved, or undefined past the cap.
	 *
	 * Undefined rather than partial: a count covering part of the base reads as the whole.
	 */
	staleAnswerCount(): number | undefined {
		if (this.store.answerCounts().total > STALE_SCAN_CAP) return undefined;

		let stale = 0;
		for (const answer of this.store.allAnswers()) {
			if (this.resolveFacts(answer.citations).missing.length > 0) stale++;
		}
		return stale;
	}

	/** Moves recorded knowledge across a whole re-minted subtree, deepest ids included. */
	migrateKnowledge(map: Map<string, string>): { answers: number; gaps: number } {
		let answers = 0;
		let gaps = 0;
		for (const [from, to] of map) {
			const moved = this.store.migrateKnowledge(from, to);
			answers += moved.answers;
			gaps += moved.gaps;
		}
		return { answers, gaps };
	}

	/**
	 * Every tier-1 fact about one symbol, each with an id an answer can cite.
	 *
	 * Imports are included only when their specifier actually resolves to the declaring module, which
	 * costs a provider round trip per distinct specifier and is why this is async. Citing every
	 * same-named import would be cheap and would attach an answer to imports of a different symbol,
	 * which is worse than citing fewer facts.
	 */
	async factsFor(symbolId: string, limit = DEFAULT_FACT_LIMIT): Promise<FactSet | null> {
		const declaration = this.store.declaration(symbolId);
		if (declaration === null) return null;

		const facts: CitedFact[] = [];
		const truncated: FactKind[] = [];
		const add = (factId: string, kind: FactKind, module: string, summary: string) =>
			facts.push({ factId, kind, module, summary });

		// The span rides on the summary so "go read the body" is a range read, never a file read.
		const at =
			declaration.range === undefined
				? ""
				: ` at ${declaration.module}:${declaration.range.start.line + 1}-${declaration.range.end.line + 1}`;
		add(
			declaration.factId,
			"declaration",
			declaration.module,
			`${declaration.kind} ${declaration.name}${declaration.signature ? ` ${declaration.signature}` : ""}${at}`,
		);

		const references = this.store.referencesTo(symbolId);
		for (const reference of references.slice(0, limit)) {
			add(
				reference.factId,
				"reference",
				reference.module,
				`${reference.role} at ${reference.module}:${reference.startLine + 1}`,
			);
		}
		if (references.length > limit) truncated.push("reference");

		const literals = this.store.literalsContainedBy(symbolId, limit + 1);
		for (const literal of literals.slice(0, limit)) {
			add(literal.factId, "literal", literal.module, `${literal.kind} ${JSON.stringify(literal.value)}`);
		}
		if (literals.length > limit) truncated.push("literal");

		const comments = this.store.commentsAnchoredTo(symbolId);
		for (const comment of comments.slice(0, limit)) {
			const text = comment.normalized.length > 80 ? `${comment.normalized.slice(0, 80)}...` : comment.normalized;
			add(comment.factId, "comment", comment.module, `${comment.form} ${text}`);
		}
		if (comments.length > limit) truncated.push("comment");

		// Prose under a heading is evidence about that heading, exactly as a comment is evidence
		// about the symbol it documents. Without this an answer about a section could cite nothing.
		const docs = this.store.docsAnchoredTo(symbolId);
		for (const region of docs.slice(0, limit)) {
			const text = region.normalized.length > 80 ? `${region.normalized.slice(0, 80)}...` : region.normalized;
			add(region.factId, "doc", region.module, `${region.fenced ? "fenced " : ""}${text}`);
		}
		if (docs.length > limit) truncated.push("doc");

		for (const site of await this.imports.importSitesFor(declaration.module, declaration.name)) {
			add(site.factId, "import", site.module, `imported by ${site.module}`);
		}

		// The subject's own recorded answers, so a SECOND author can cite what a first one wrote.
		// Without this the answers-cite-answers cascade only worked inside one session's memory,
		// since an answer's id was returned once at record time and never listed again.
		for (const answer of this.store.answersFor(symbolId)) {
			const prose = answer.prose.length > 80 ? `${answer.prose.slice(0, 80)}...` : answer.prose;
			add(answer.factId, "answer", declaration.module, `${answer.question}: ${prose}`);
		}

		return { symbolId, facts, truncated };
	}

	/**
	 * Write down an answer, or refuse it and say why.
	 *
	 * The core does not generate this prose and must not: the consumer is already an AI agent that
	 * has just read the facts, so a second model call here would pay twice and bind this tool to a
	 * model. What the core owns is the part a model cannot be trusted with, which is checking that
	 * every claimed input exists and remembering the pairing.
	 *
	 * A fact id is a digest of its own contents, so refusing an unresolvable citation catches an
	 * invented id and a stale one with the same check.
	 */
	async recordAnswer(
		symbolId: string,
		question: QuestionClass,
		prose: string,
		citations: string[],
		options: { model?: string; resolvesDoubt?: string; omitting?: string } = {},
	): Promise<RecordOutcome> {
		const { model, resolvesDoubt, omitting } = options;
		if (this.store.declaration(symbolId) === null) {
			return { recorded: false, reason: `${symbolId} is not in the index` };
		}
		if (prose.trim() === "") return { recorded: false, reason: "an answer needs prose" };
		if (prose.length > MAX_PROSE) {
			return {
				recorded: false,
				reason: `an answer is at most ${MAX_PROSE} characters, and this is ${prose.length}`,
			};
		}

		const previous = this.store.answer(symbolId, question);

		// Clearing a doubt requires citing it, which proves the writer recalled and read the reason.
		// A wrong token is refused rather than ignored, because ignoring it would record an answer
		// whose writer believes a doubt was cleared when it was not.
		if (resolvesDoubt !== undefined) {
			if (previous?.doubt === undefined) {
				return { recorded: false, reason: `no doubt stands on the ${question} answer about ${symbolId}` };
			}
			if (previous.doubt.factId !== resolvesDoubt) {
				return {
					recorded: false,
					reason: "resolvesDoubt does not name the standing doubt. Recall the answer and cite the doubt id it shows",
				};
			}
		}

		const subject = await this.factsFor(symbolId);
		const subjectFacts = new Set((subject?.facts ?? []).map((fact) => fact.factId));
		const check = checkCitations(symbolId, citations, (factId) => this.store.factById(factId), subjectFacts);
		if (!check.ok) {
			return {
				recorded: false,
				reason: check.reason,
				...(check.unresolved ? { unresolved: check.unresolved } : {}),
			};
		}

		// The adjudicated-supersede gate, from `docs/knowledge-layer.md`: replacing an answer that is
		// wrong while EVERY cited input still holds is a judgement call, so the challenger must cover
		// the incumbent's facts or say what they are leaving out. A stale or doubted incumbent is
		// already invited to be rewritten, so the gate stands down for those.
		if (previous !== null && previous.doubt === undefined && previous.prose !== prose) {
			const allLive = previous.citations.every((factId) => this.store.factById(factId) !== null);
			if (allLive) {
				const uncovered = previous.citations.filter((factId) => !citations.includes(factId));
				if (uncovered.length > 0 && omitting === undefined) {
					return {
						recorded: false,
						reason: "this replaces an answer whose every cited input still holds. Cite the facts it cited too, or explain what you are dropping and why in `omitting`",
						uncovered,
					};
				}
			}
		}

		// Thin when nothing cited reaches beyond the subject's own declaration: structurally a
		// paraphrase of what a reader already sees. Graded rather than refused, since refusal would
		// teach citation padding while a visible mark invites a better answer.
		const thin = citations.every((factId) => {
			const fact = this.store.factById(factId);
			return fact !== null && fact.fact === "declaration" && fact.symbolId === symbolId;
		});

		// A doubt the writer did not cite rides forward onto the new answer. Erasing it would let a
		// parallel writer who never recalled the answer clear a warning they never saw.
		const carried = previous?.doubt !== undefined && resolvesDoubt === undefined ? previous.doubt : undefined;

		const answer: Answer = {
			symbolId,
			question,
			factId: answerFactId(symbolId, question, prose, citations),
			prose,
			citations,
			thin,
			createdAt: Date.now(),
			...(model === undefined ? {} : { model }),
			...(carried === undefined ? {} : { doubt: carried }),
		};
		this.store.saveAnswer(answer);
		// Saving closed the gap row, but a carried doubt is still open work, so the demand stays.
		if (carried !== undefined) this.store.recordGap(symbolId, question, Date.now());
		return {
			recorded: true,
			answer,
			...(carried === undefined ? {} : { doubtCarried: carried }),
		};
	}

	/**
	 * Declare distrust of a recorded answer without rewriting it.
	 *
	 * The declared-invalidation path from `docs/knowledge-layer.md`: mechanical staleness cannot see
	 * semantic drift, so an agent that just changed a function's purpose flags the recorded prose
	 * here. The doubt cascades to everything citing this answer through the recall walk, and each
	 * doubted slot re-enters the gap ledger as measured recheck demand.
	 */
	invalidateAnswer(symbolId: string, reason: string, question?: QuestionClass, by?: string): InvalidateOutcome {
		if (reason.trim() === "") {
			return {
				symbolId,
				doubted: [],
				noAnswer: [],
				refused: "a doubt needs a reason: it is what the next writer reads",
			};
		}
		const now = Date.now();
		const targets = question === undefined ? this.store.answersFor(symbolId).map((a) => a.question) : [question];
		if (targets.length === 0) {
			return { symbolId, doubted: [], noAnswer: [], refused: `nothing is recorded about ${symbolId} to doubt` };
		}

		const doubted: Array<{ question: QuestionClass; doubt: Doubt }> = [];
		const noAnswer: QuestionClass[] = [];
		for (const target of targets) {
			if (this.store.answer(symbolId, target) === null) {
				// Doubting an unwritten answer is demand for one, so it lands in the ledger instead.
				this.store.recordGap(symbolId, target, now);
				noAnswer.push(target);
				continue;
			}
			const doubt: Doubt = {
				factId: doubtFactId(symbolId, target, reason, now),
				reason,
				at: now,
				...(by === undefined ? {} : { by }),
			};
			this.store.setDoubt(symbolId, target, doubt);
			this.store.recordGap(symbolId, target, now);
			doubted.push({ question: target, doubt });
		}
		return { symbolId, doubted, noAnswer };
	}

	/**
	 * Vouch that an answer's prose still holds, healing its ground instead of rewriting it.
	 *
	 * With `citations`: re-record the SAME prose over current fact ids, which is the one-call heal
	 * for an answer whose citations were retired by a re-index. The new grounding mints a new answer
	 * id, so parents citing the old one go stale and heal the same way, leaves first.
	 *
	 * Without `citations`: nothing needed healing, so the only work left is clearing a doubt, and
	 * that requires citing the doubt's id.
	 */
	async reaffirmAnswer(
		symbolId: string,
		question: QuestionClass,
		options: { citations?: string[]; model?: string; resolvesDoubt?: string } = {},
	): Promise<RecordOutcome> {
		const existing = this.store.answer(symbolId, question);
		if (existing === null) {
			return {
				recorded: false,
				reason: `no ${question} answer is recorded about ${symbolId}. record_answer writes a new one`,
			};
		}

		if (options.citations !== undefined) {
			return this.recordAnswer(symbolId, question, existing.prose, options.citations, {
				...(options.model === undefined ? {} : { model: options.model }),
				...(options.resolvesDoubt === undefined ? {} : { resolvesDoubt: options.resolvesDoubt }),
			});
		}

		const stale = existing.citations.filter((factId) => this.store.factById(factId) === null);
		if (stale.length > 0) {
			return {
				recorded: false,
				reason: `${stale.length} citation${stale.length === 1 ? "" : "s"} no longer resolve${stale.length === 1 ? "s" : ""}. Check the prose against symbol_facts, then re-affirm again passing the replacement citations`,
				unresolved: stale,
			};
		}
		if (existing.doubt === undefined) {
			return { recorded: false, reason: "nothing to re-affirm: every citation resolves and no doubt stands" };
		}
		if (options.resolvesDoubt !== existing.doubt.factId) {
			return {
				recorded: false,
				reason: "clearing a doubt requires citing it. Recall the answer, read the doubt's reason, and pass its id as resolvesDoubt",
			};
		}

		const { doubt: _cleared, ...rest } = existing;
		// Same prose over the same citations is the same answer, so the id survives on purpose and
		// nothing citing it goes stale. Only the vouching is fresh.
		const affirmed: Answer = {
			...rest,
			createdAt: Date.now(),
			...(options.model === undefined ? {} : { model: options.model }),
		};
		this.store.saveAnswer(affirmed);
		return { recorded: true, answer: affirmed };
	}

	/**
	 * An answer and whether its ground has moved.
	 *
	 * `stale` is computed by resolving the citations rather than by any bookkeeping, so noticing is
	 * a lookup. This is the mechanical invalidation path `docs/knowledge-layer.md` puts first, and
	 * the whole reason a fact id is content rather than a row number.
	 *
	 * A miss and a stale hit both count a gap, since both are demand for writing work. A fresh hit
	 * counts nothing: the ledger measures what is missing, not what is popular.
	 */
	recallAnswer(symbolId: string, question: QuestionClass): RecalledAnswer | null {
		const answer = this.store.answer(symbolId, question);
		if (answer === null) {
			// Only symbols the index holds become gaps, or a typo would sit in the ledger forever.
			if (this.store.declaration(symbolId) !== null) this.store.recordGap(symbolId, question, Date.now());
			return null;
		}
		const recalled = this.staleness(answer);
		// A doubted answer counts a gap on every recall too: each reader who hits the warning is
		// renewed demand for someone to address it.
		if (
			recalled.stale.length > 0 ||
			recalled.inheritedStale.length > 0 ||
			recalled.doubtedUpstream.length > 0 ||
			recalled.answer.doubt !== undefined
		) {
			this.store.recordGap(symbolId, question, Date.now());
		}
		return recalled;
	}

	/** Every answer about one symbol, each with its own staleness. Counts no gaps: this is a survey. */
	recallAnswers(symbolId: string): RecalledAnswer[] {
		return this.store.answersFor(symbolId).map((answer) => this.staleness(answer));
	}

	/**
	 * Direct staleness plus the cascade through cited answers.
	 *
	 * An answer citing another answer inherits its doubt: the child still resolves, so it is not in
	 * `stale`, but what it says is in question, so leaning on it is too. Walked with a guard because
	 * answers may legally cite in cycles once `relate` lands.
	 */
	private staleness(answer: Answer): RecalledAnswer {
		const stale = this.resolveFacts(answer.citations).missing;

		const inheritedStale: string[] = [];
		const doubtedUpstream: string[] = [];
		// Seeded with the subject so a citation cycle back to it contributes nothing.
		const memo = new Map<string, ShakyResult>([[answer.factId, { stale: false, doubted: false }]]);
		for (const citation of answer.citations) {
			const fact = this.store.factById(citation);
			if (fact === null || fact.fact !== "answer") continue;
			const beneath = this.shaky(fact, memo);
			if (beneath.stale) inheritedStale.push(citation);
			if (beneath.doubted) doubtedUpstream.push(citation);
		}
		return { answer, stale, inheritedStale, doubtedUpstream };
	}

	/**
	 * Whether an answer's ground has moved or been doubted anywhere beneath it, however deep.
	 *
	 * Memoized on the RESULT rather than guarded by a visited set, because two siblings citing one
	 * shaky grandchild must both hear about it. The entry is registered before the walk, so a cycle
	 * reads a partial result and contributes nothing extra, which is what a cycle should add.
	 */
	private shaky(answer: Answer, memo: Map<string, ShakyResult>): ShakyResult {
		const known = memo.get(answer.factId);
		if (known !== undefined) return known;
		const result: ShakyResult = { stale: false, doubted: answer.doubt !== undefined };
		memo.set(answer.factId, result);
		for (const citation of answer.citations) {
			const fact = this.store.factById(citation);
			if (fact === null) {
				result.stale = true;
				continue;
			}
			if (fact.fact !== "answer") continue;
			const beneath = this.shaky(fact, memo);
			result.stale ||= beneath.stale;
			result.doubted ||= beneath.doubted;
		}
		return result;
	}

	/**
	 * Where knowledge is missing, ranked by where writing it would pay.
	 *
	 * Two modes because the two regimes want different orderings. WITHOUT a root: the workspace's
	 * gaps by measured demand, stale answers first since their context is half loaded already. WITH
	 * a root: the dependency tree beneath one symbol, LEAVES FIRST, because a parent's description
	 * gets to lean on its children's and the leaves are usually the cheap ones.
	 *
	 * Leaves-first is DFS post-order over the fan-out graph with a visited guard, which is reverse
	 * topological order with cycles flattened where they occur. External dependencies are counted
	 * rather than listed: a symbol outside the index has no facts to cite, so it cannot be answered.
	 */
	knowledgeGaps(root?: string, question: QuestionClass = "describe", limit = DEFAULT_GAP_LIMIT): KnowledgeGaps {
		if (root === undefined) {
			// A gap row with a recorded answer means the answer went stale or doubted after being
			// asked for again. Those lead the list: the prose exists and most are re-affirmations.
			const all = this.store.gaps(limit * 4);
			const recheck: GapRow[] = [];
			const missing: GapRow[] = [];
			const known = new Set<string>();
			for (const gap of all) {
				known.add(`${gap.symbolId}\0${gap.question}`);
				const answer = this.store.answer(gap.symbolId, gap.question);
				if (answer === null) {
					missing.push(this.gapRow(gap.symbolId, gap.question, gap.askCount, "missing"));
				} else {
					recheck.push(
						this.gapRow(
							gap.symbolId,
							gap.question,
							gap.askCount,
							answer.doubt === undefined ? "stale" : "doubted",
						),
					);
				}
			}

			// The ledger only measures demand, so an answer that went unhealthy since anyone last
			// asked has no row in it, and a list ranked purely by asks would silently omit exactly
			// the recheck work this mode exists to surface. A healer once had to read this file to
			// learn that. So unhealthy answers are swept directly: doubt is one indexed read and is
			// always included; staleness costs a resolve per answer, so it honors the same cap as
			// overview and is honestly reported as skipped past it rather than sampled.
			let staleScanSkipped = false;
			const counts = this.store.answerCounts();
			if (counts.total <= STALE_SCAN_CAP) {
				for (const answer of this.store.allAnswers()) {
					if (known.has(`${answer.symbolId}\0${answer.question}`)) continue;
					const why =
						answer.doubt !== undefined
							? "doubted"
							: answer.citations.some((factId) => this.store.factById(factId) === null)
								? "stale"
								: null;
					if (why === null) continue;
					recheck.push(this.gapRow(answer.symbolId, answer.question, 0, why));
				}
			} else {
				staleScanSkipped = true;
				for (const answer of this.store.doubtedAnswers()) {
					if (known.has(`${answer.symbolId}\0${answer.question}`)) continue;
					recheck.push(this.gapRow(answer.symbolId, answer.question, 0, "doubted"));
				}
			}

			const rows = [...recheck, ...missing];
			if (rows.length > 0) {
				return {
					question,
					rows: rows.slice(0, limit),
					total: rows.length,
					external: 0,
					truncated: false,
					...(staleScanSkipped ? { staleScanSkipped } : {}),
				};
			}

			// The cold-start fallback. An empty ledger means nobody has asked yet, not that nothing is
			// worth writing, and answering "no gaps" on a workspace with no knowledge at all would
			// read as completion. Fan-in is the only demand signal that exists before any asks, which
			// is the doc's "pre-warm only high fan-in symbols" made queryable.
			const seeded = this.store
				.mostReferenced(limit * 3)
				.filter((hub) => this.store.answer(hub.symbolId, question) === null)
				.filter((hub) => this.store.declaration(hub.symbolId) !== null)
				.slice(0, limit)
				.map((hub) => this.gapRow(hub.symbolId, question, 0, "missing"));
			return {
				question,
				rows: seeded,
				total: seeded.length,
				external: 0,
				truncated: false,
				seeded: true,
				...(staleScanSkipped ? { staleScanSkipped } : {}),
			};
		}

		// The tree: post-order walk of what the root uses, so children precede their parents.
		const ordered: string[] = [];
		const seen = new Set<string>();
		let external = 0;
		let truncated = false;

		const walk = (symbolId: string) => {
			if (seen.has(symbolId)) return;
			seen.add(symbolId);
			if (seen.size > GAP_TREE_CAP) {
				truncated = true;
				return;
			}
			for (const reference of this.store.referencesFrom(symbolId)) {
				const target = reference.targetId as string;
				if (this.store.declaration(target) === null) {
					external++;
					continue;
				}
				walk(target);
			}
			ordered.push(symbolId);
		};
		walk(root);

		// A tree node needs work when its answer is missing, doubted, or stale on its OWN citations.
		// Inherited shakiness is not counted here: the shaky child is its own row in the same list.
		const rows: GapRow[] = [];
		let total = 0;
		for (const symbolId of ordered) {
			const answer = this.store.answer(symbolId, question);
			let why: GapRow["why"] | null = null;
			if (answer === null) why = "missing";
			else if (answer.doubt !== undefined) why = "doubted";
			else if (answer.citations.some((factId) => this.store.factById(factId) === null)) why = "stale";
			if (why === null) continue;
			total++;
			if (rows.length < limit) {
				rows.push(this.gapRow(symbolId, question, this.store.askCount(symbolId, question), why));
			}
		}
		return { question, rows, total, external, truncated };
	}

	private gapRow(symbolId: string, question: string, askCount: number, why: GapRow["why"]): GapRow {
		const declaration = this.store.declaration(symbolId);
		return {
			symbolId,
			question,
			why,
			askCount,
			fanIn: this.store.referencesTo(symbolId).length,
			...(declaration === null
				? {}
				: { name: declaration.name, kind: declaration.kind, module: declaration.module }),
		};
	}

	/**
	 * Turn stored citations back into facts, naming the ones that resolve to nothing.
	 *
	 * The missing list IS the staleness answer. A fact id is a digest of the fact's own contents, so
	 * an id that fails to resolve is exactly a fact that changed or vanished, and the caller needs no
	 * second hash to compare against.
	 */
	resolveFacts(factIds: string[]): { resolved: StoredFact[]; missing: string[] } {
		const resolved: StoredFact[] = [];
		const missing: string[] = [];
		for (const factId of factIds) {
			const found = this.store.factById(factId);
			if (found === null) missing.push(factId);
			else resolved.push(found);
		}
		return { resolved, missing };
	}
}
