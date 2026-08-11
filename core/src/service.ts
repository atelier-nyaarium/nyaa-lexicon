// Where the pieces meet: a question in, an answer from the index, and providers consulted only
// when the index cannot answer.
//
// This is the layer both adapters talk to. Neither of them knows there is a store, a supervisor,
// or a provider process.

import { createHash } from "node:crypto";
import {
	answerFactId,
	type Binding,
	doubtFactId,
	type FactKind,
	type ImportResolution,
	isParameterSymbol,
	ownerOf,
	type Range,
	type RenameSite,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import {
	type Answer,
	checkCitations,
	type Doubt,
	MAX_PROSE,
	type QuestionClass,
	type RecalledAnswer,
	type RecordOutcome,
} from "./answers.js";
import { type FileEdits, writeAll } from "./applyEdits.js";
import { describeScope, type FileScope, fileScopeFor, includedFiles } from "./fileScope.js";
import { findCycles } from "./graph.js";
import { coChangesFor, commitsMentioning, DEFAULT_MENTION_LIMIT, fileHistoryFor, readHistory } from "./history.js";
import { decideInvalidation, type FileEvent } from "./invalidation.js";
import { ResultCache } from "./resultCache.js";
import type {
	IndexStore,
	StoredDeclaration,
	StoredFact,
	StoredImport,
	StoredLiteral,
	StoredReference,
} from "./store.js";
import type { ProviderSupervisor } from "./supervisor.js";

////////////////////////////////
//  Interfaces & Types

/** How a fact was obtained, carried on every answer so a consumer can weigh it. */
export type AnswerTier = "bound" | "nameMatched" | "unknown";

export interface SymbolSummary {
	symbolId: string;
	name: string;
	kind: string;
	module: string;
	/** Absent when the provider's language has no answer, which is not the same as false. */
	exported?: boolean;
	visibility: string;
	signature?: string;
	docComment?: string;
	/** Where the body lives, 0-based source lines. The pointer that makes reading it a range read. */
	lines?: { start: number; end: number };
}

export interface DescribeResult {
	symbol: SymbolSummary;
	/** Direct members, the compression tier: a class as its surface rather than its body. */
	members: SymbolSummary[];
	/** How many places use it, so a caller decides whether to ask for the list. */
	referenceCount: number;
	tier: AnswerTier;
}

export interface ReferencesResult {
	symbolId: string;
	/** Capped, because an agent pays for every row and a hub symbol has thousands. */
	references: StoredReference[];
	total: number;
	truncated: boolean;
	tier: AnswerTier;
}

export interface IndexOutcome {
	module: string;
	action: "indexed" | "forgotten" | "skipped";
	reason?: string;
	declarations?: number;
}

/**
 * How complete the index is. `unstarted` and `ready` both answer instantly and mean opposite things.
 *
 * `state`, `done` and `total` describe THIS PROCESS's scan. `stored` describes the index on disk,
 * which outlives any one process. The two are separate because they answer different questions, and
 * a consumer that has only the first will call a fully populated index empty every time a daemon
 * restarts.
 */
export interface IndexStatus {
	state: "unstarted" | "discovering" | "indexing" | "ready";
	done: number;
	total: number;
	/** Files the index already holds, from this scan or any earlier one. */
	stored: number;
}

/** Occurrences of one symbol in one file, which is the unit a provider is asked to rewrite. */
export interface RenameFile {
	module: string;
	sites: RenameSite[];
	/** Calls in this file to the declaration owning the renamed symbol. Absent for an unowned one. */
	ownerCalls?: Range[];
}

/**
 * Two kinds of bad news, kept apart because they call for different decisions.
 *
 * A blocker is something we KNOW would break: the symbol is not indexed, or a provider refuses.
 * A warning is somewhere we cannot see far enough to promise: an occurrence spelled the same that
 * never bound, or a symbol exported past the edge of the index. Folding the second into the first
 * would refuse most real renames; folding the first into the second would ship broken code.
 */
export interface RenameConcern {
	kind: string;
	detail: string;
	/** Where it was found, when the concern is about specific occurrences. */
	sites?: Array<{ module: string; line: number }>;
}

export interface RenamePlan {
	symbolId: string;
	oldName: string;
	newName: string;
	files: RenameFile[];
	/** Total occurrences to rewrite, the declaration's own name included. */
	occurrences: number;
	blockers: RenameConcern[];
	warnings: RenameConcern[];
}

/** How a literal search was expressed. Carried back so an answer says what it answered. */
export interface LiteralQuery {
	value?: string | undefined;
	pattern?: string | undefined;
	kind?: string | undefined;
	min?: number | undefined;
	max?: number | undefined;
}

export interface LiteralsResult {
	query: LiteralQuery;
	literals: StoredLiteral[];
	total: number;
	truncated: boolean;
	/** Set when a pattern search stopped reading before the end of the table. */
	scanIncomplete?: boolean;
}

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

/**
 * Immediate supertypes and subtypes, which is the shape LSP's typeHierarchy asks for.
 *
 * Read entirely out of `extends` and `implements` reference rows the providers already emit, so
 * this needed no new provider method: the dual inverted index means one direction is
 * `referencesFrom` and the other is `referencesTo` on the same table.
 */
export interface TypeHierarchy {
	symbolId: string;
	supertypes: SymbolSummary[];
	subtypes: SymbolSummary[];
	/** Supertypes reached transitively, nearest first, bounded and cycle-guarded. */
	ancestors: SymbolSummary[];
	/** Unresolved heritage names, so an engine base class is visibly absent rather than missing. */
	unboundSupertypes: string[];
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

/** What a walk found beneath one answer. Mutated in place so a cycle reads the partial result. */
interface ShakyResult {
	stale: boolean;
	doubted: boolean;
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

/** One end of a call relationship, with every span where that call is written. */
export interface CallHierarchyEdge {
	symbol: SymbolSummary;
	ranges: Range[];
}

export interface CallHierarchy {
	symbolId: string;
	incoming: CallHierarchyEdge[];
	outgoing: CallHierarchyEdge[];
}

export interface GraphSummary {
	symbolId: string;
	/** Distinct symbols this one uses, its members included. */
	fanOut: number;
	/** Places that use it. */
	fanIn: number;
	/** How many members contributed, so a container's number is readable as one. */
	viaMembers?: number;
	/** Present only when this symbol sits in a cycle. */
	cycle?: string[];
}

/** The plan rides along either way, so a refusal can say what it would have done. */
export type RenameOutcome =
	| { renamed: true; plan: RenamePlan; modules: string[] }
	| { renamed: false; plan: RenamePlan; reason: string };

////////////////////////////////
//  Constants

/** Default page for a reference list. A hub symbol would otherwise flood a caller's context. */
export const DEFAULT_REFERENCE_LIMIT = 50;

/** Page for a literal search. Literals outnumber symbols by a lot, so this is the tighter cap. */
export const DEFAULT_LITERAL_LIMIT = 50;

/** Per kind, not overall, so a symbol with a thousand references does not crowd out its literals. */
export const DEFAULT_FACT_LIMIT = 40;

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

/**
 * Below this many gaps, the invitation is to close them NOW, in a subagent where one is available,
 * since the asker presumably needs these answers to proceed. At or above it, the honest advice is a
 * background agent and moving on. The seam is wall-clock: at one to two answers a minute, this many
 * is about the longest a working task should block on knowledge it is waiting to lean on.
 */
export const INLINE_GAP_THRESHOLD = 20;

/**
 * How many literals a pattern search will read before giving up.
 *
 * SQLite has no REGEXP here, so a pattern is matched in application code and the read is what
 * costs. Stopping is fine; stopping SILENTLY is not, which is why the result carries a flag saying
 * the scan did not finish.
 */
export const PATTERN_SCAN_LIMIT = 20_000;

/** Import closure is a fixpoint; this only stops a pathological graph from walking forever. */
const MAX_CLOSURE_PASSES = 10;

/** Resolving by module reads every import, since the index stores specifiers unresolved. */
const ALL_IMPORTS_SCAN = 20_000;

////////////////////////////////
//  Functions & Helpers

function hashOf(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function detailOf(detail: string | undefined): string {
	return detail === undefined ? "" : `: ${detail}`;
}

/** One place that decides what "more than a page" means, so no caller reports a cap as a total. */
function page(query: LiteralQuery, found: StoredLiteral[], limit: number): LiteralsResult {
	return {
		query,
		literals: found.slice(0, limit),
		total: found.length,
		truncated: found.length > limit,
	};
}

function toSummary(declaration: StoredDeclaration): SymbolSummary {
	return {
		symbolId: declaration.symbolId,
		name: declaration.name,
		kind: declaration.kind,
		module: declaration.module,
		visibility: declaration.visibility,
		...(declaration.exported === undefined ? {} : { exported: declaration.exported }),
		...(declaration.signature === undefined ? {} : { signature: declaration.signature }),
		...(declaration.docComment === undefined ? {} : { docComment: declaration.docComment }),
		...(declaration.range === undefined
			? {}
			: { lines: { start: declaration.range.start.line, end: declaration.range.end.line } }),
	};
}

////////////////////////////////
//  Class

export class LexiconService {
	constructor(
		private readonly store: IndexStore,
		private readonly supervisor: ProviderSupervisor,
		private readonly readFile: (module: string) => string | null,
		private readonly workspaceRoot = ".",
	) {}

	/** This process's scan only. `stored` is read from the index when the status is asked for. */
	private status: Omit<IndexStatus, "stored"> = { state: "unstarted", done: 0, total: 0 };
	private scope: FileScope | null = null;
	private readonly cache = new ResultCache();

	/** Hit and miss counts, so a claim that the cache helps is checkable rather than asserted. */
	cacheStats() {
		return this.cache.stats();
	}

	////////////////////////////////
	//  Indexing

	/**
	 * Ask the owning provider about a file and replace what the index holds for it.
	 *
	 * Skips rather than throws when nobody owns the file, since a workspace is full of files no
	 * provider claims and each one is not an error.
	 */
	async indexFile(module: string, contentHash: string): Promise<IndexOutcome> {
		const route = this.supervisor.route(module);
		if (!route.owned) {
			const reason = route.reason === "contested" ? `claimed by ${route.providerIds.join(", ")}` : "unclaimed";
			return { module, action: "skipped", reason };
		}

		const text = this.readFile(module);
		if (text === null) {
			this.store.forgetFile(module);
			return { module, action: "forgotten", reason: "file is gone" };
		}

		const facts = await this.supervisor.ask(module, "parseFile", { module, contentHash, text });
		this.store.replaceFile(
			module,
			contentHash,
			facts.declarations,
			facts.references,
			facts.imports,
			facts.literals,
		);
		// Every stored answer was drawn from facts that just moved, so all of them are unreachable.
		this.cache.invalidate();
		return { module, action: "indexed", declarations: facts.declarations.length };
	}

	/**
	 * Index every file the running providers claim.
	 *
	 * Sequential rather than parallel: each provider serializes on its own queue anyway, so
	 * flooding it would only trade a readable progress order for the same wall clock.
	 */
	async indexWorkspace(onProgress?: (done: number, total: number) => void): Promise<IndexOutcome[]> {
		this.status = { state: "discovering", done: 0, total: 0 };
		const discovered: string[] = [];
		for (const provider of this.supervisor.running()) {
			const project = await this.supervisor.askProvider(provider.providerId, "discoverProject", {
				workspaceRoot: this.workspaceRoot,
			});
			discovered.push(...project.files);
		}

		this.scope = fileScopeFor(this.workspaceRoot);
		// Explicit includes are ADDED, not merely permitted. A provider's own discovery decides what
		// exists, and a tsconfig's file list is exactly what omits the build output somebody is
		// pointing at, so allowing a path without adding it would not be a way of naming it.
		const named = includedFiles(this.workspaceRoot, this.scope.include);
		const modules = [
			...new Set([...discovered.filter((module) => this.scope?.allows(module) ?? true), ...named]),
		].filter((module) => this.supervisor.route(module).owned);

		const outcomes: IndexOutcome[] = [];
		this.status = { state: "indexing", done: 0, total: modules.length };
		for (const [done, module] of modules.entries()) {
			outcomes.push(await this.indexOne(module));
			this.status = { state: "indexing", done: done + 1, total: modules.length };
			onProgress?.(done + 1, modules.length);
		}

		outcomes.push(...(await this.followImports(new Set(modules))));
		this.status = { state: "ready", done: outcomes.length, total: outcomes.length };
		return outcomes;
	}

	/** How the file set was decided, so a caller never confuses 350 files with 136,000. */
	scopeReport(): string {
		return this.scope === null ? "not yet scoped" : describeScope(this.scope);
	}

	private async indexOne(module: string): Promise<IndexOutcome> {
		const text = this.readFile(module);
		// A file the project lists but cannot be read is skipped, not fatal: a generated or
		// gitignored entry disappearing mid-scan is ordinary.
		return text === null
			? { module, action: "skipped", reason: "unreadable" }
			: this.indexFile(module, hashOf(text));
	}

	/**
	 * Index whatever the indexed files import, even where discovery was not allowed to look.
	 *
	 * The reachability half of the scoping rule. A generated file you import is part of your
	 * program however your VCS feels about it, while a secrets file nobody imports never becomes
	 * reachable, which is why this is safe in a way that simply un-ignoring a directory is not.
	 *
	 * Only workspace-RESOLVED specifiers are followed. An external one would drag a package tree in
	 * behind it, so the closure is bounded by construction rather than by a limit.
	 */
	private async followImports(seen: Set<string>): Promise<IndexOutcome[]> {
		const outcomes: IndexOutcome[] = [];

		for (let pass = 0; pass < MAX_CLOSURE_PASSES; pass++) {
			const found: string[] = [];
			for (const module of [...seen]) {
				for (const statement of this.store.importsIn(module)) {
					const landed = await this.resolveImport(module, statement.specifier).catch(() => null);
					if (landed?.status !== "resolved" || seen.has(landed.module)) continue;
					seen.add(landed.module);
					found.push(landed.module);
				}
			}
			if (found.length === 0) break;
			for (const module of found) outcomes.push(await this.indexOne(module));
		}
		return outcomes;
	}

	/**
	 * How much of the workspace the index actually holds.
	 *
	 * Serving before the first scan finishes is deliberate: waiting means every session pays the
	 * whole scan before its first answer. The cost is that an early answer is drawn from a partial
	 * index, so the state is reported rather than assumed, and a caller can tell a real "no
	 * references" from "not read yet".
	 */
	indexStatus(): IndexStatus {
		// Read from the store rather than counted as we go, because the index survives the process
		// that built it and a fresh daemon over a warm index has scanned nothing while holding
		// everything.
		return { ...this.status, stored: this.store.totals().files };
	}

	/** Applies a watcher batch, one decision per file. */
	async applyBatch(events: FileEvent[]): Promise<IndexOutcome[]> {
		const outcomes: IndexOutcome[] = [];

		for (const event of events) {
			const decision = decideInvalidation(event, {
				route: (module) => this.supervisor.route(module),
				indexedHash: (module) => this.store.contentHashOf(module),
			});

			if (decision.action === "forget") {
				this.store.forgetFile(decision.module);
				outcomes.push({ module: decision.module, action: "forgotten" });
				continue;
			}
			if (decision.action === "ignore") {
				outcomes.push({ module: decision.module, action: "skipped", reason: decision.reason });
				continue;
			}
			outcomes.push(await this.indexFile(decision.module, decision.contentHash));
		}

		return outcomes;
	}

	////////////////////////////////
	//  Answering

	/** Symbols matching a name, so a caller holding a name rather than an id can start. */
	findByName(name: string, module?: string): SymbolSummary[] {
		const matches =
			module === undefined
				? this.store.declarationsNamed(name)
				: this.store.declarationsIn(module).filter((d) => d.name === name);
		return matches.map(toSummary);
	}

	/**
	 * What a symbol is, plus its surface and how used it is.
	 *
	 * The member list is the compression tier: a four-hundred-line class answers as its signature
	 * surface, which is the thing that beats reading the file.
	 */
	describe(symbolId: string): DescribeResult | null {
		const declaration = this.store.declaration(symbolId);
		if (!declaration) return null;

		const members = this.store
			.declarationsIn(declaration.module)
			.filter((d) => d.containerId === symbolId)
			.map(toSummary);

		return {
			symbol: toSummary(declaration),
			members,
			referenceCount: this.store.referencesTo(symbolId).length,
			tier: "bound",
		};
	}

	/** One declaration with its ranges, which `describe` deliberately does not carry. */
	declarationOf(symbolId: string): StoredDeclaration | null {
		return this.store.declaration(symbolId);
	}

	/** Everything declared in one file, in source order. What an editor outline is built from. */
	declarationsIn(module: string): StoredDeclaration[] {
		return this.store.declarationsIn(module);
	}

	/** The same, as summaries plus the container, which is what renders an outline. */
	outline(module: string): Array<SymbolSummary & { containerId?: string }> {
		return this.store.declarationsIn(module).map((declaration) => ({
			...toSummary(declaration),
			...(declaration.containerId === undefined ? {} : { containerId: declaration.containerId }),
		}));
	}

	/** Symbols whose name contains this text. The entry point when you cannot spell it yet. */
	searchSymbols(
		text: string,
		options: { kind?: string | undefined; module?: string | undefined; limit?: number | undefined } = {},
	) {
		const found = this.store.searchSymbols(text, {
			...(options.kind === undefined ? {} : { kind: options.kind }),
			...(options.module === undefined ? {} : { module: options.module }),
			limit: (options.limit ?? DEFAULT_REFERENCE_LIMIT) + 1,
		});
		const limit = options.limit ?? DEFAULT_REFERENCE_LIMIT;
		return {
			text,
			symbols: found.slice(0, limit).map(toSummary),
			total: found.length,
			truncated: found.length > limit,
		};
	}

	/**
	 * Which files import a specifier, or which import a particular module.
	 *
	 * Reads the imports table rather than the literals tier, which is what makes it uniform. A
	 * TypeScript specifier IS a string in source and a Python one is not, so any answer built on
	 * literal search works in one language and silently returns nothing in the other.
	 */
	async findImports(query: {
		specifier?: string | undefined;
		module?: string | undefined;
		limit?: number | undefined;
	}) {
		const limit = query.limit ?? DEFAULT_REFERENCE_LIMIT;

		if (query.specifier !== undefined) {
			const found = this.store.importsMatching(query.specifier, limit + 1);
			return { query, imports: found.slice(0, limit), total: found.length, truncated: found.length > limit };
		}
		if (query.module === undefined) throw new Error("give a specifier or a module");

		// By resolved module, which needs the provider: the index stores specifiers unresolved
		// because resolving all of them at index time costs a round trip per import.
		const target = query.module;
		const matched: StoredImport[] = [];
		for (const statement of this.store.importsMatching("", ALL_IMPORTS_SCAN)) {
			const landed = await this.resolveImport(statement.module, statement.specifier).catch(() => null);
			if (landed?.status === "resolved" && landed.module === target) matched.push(statement);
			if (matched.length > limit) break;
		}
		return { query, imports: matched.slice(0, limit), total: matched.length, truncated: matched.length > limit };
	}

	/** Files, symbols and the biggest modules. The first question about a repository you do not know. */
	overview(topModules = 15) {
		const modules = this.store.moduleSummary();

		// Knowledge coverage belongs in the first answer a fresh agent reads. The layer was
		// discoverable only through describe's inline line, so an agent arriving with an ordinary
		// task never learned it existed: overview is the front door, and the front door said nothing.
		//
		// Staleness is exact only while the knowledge base is small. It costs a citation resolve per
		// answer, and the front door is the most-called tool, so past the cap it is honestly SKIPPED
		// rather than sampled: a number that silently covered part of the base would read as the
		// whole. Stale entries still surface individually on recall and in knowledge_gaps.
		const counts = this.store.answerCounts();
		let stale: number | undefined;
		if (counts.total <= STALE_SCAN_CAP) {
			stale = 0;
			for (const answer of this.store.allAnswers()) {
				if (this.resolveFacts(answer.citations).missing.length > 0) stale++;
			}
		}
		// A COUNT query, so unlike staleness it stays cheap at any size and is never skipped.
		const doubted = this.store.doubtedCount();

		return {
			...this.store.totals(),
			scope: this.scopeReport(),
			index: this.indexStatus(),
			modules: modules.length,
			largest: modules.slice(0, topModules),
			knowledge: {
				answers: counts.total,
				...(stale === undefined ? {} : { stale }),
				...(doubted === 0 ? {} : { doubted }),
			},
		};
	}

	/** Who uses a symbol. Capped, and the caller is told when it was. */
	findReferences(symbolId: string, limit = DEFAULT_REFERENCE_LIMIT): ReferencesResult {
		const all = this.store.referencesTo(symbolId);
		return {
			symbolId,
			references: all.slice(0, limit),
			total: all.length,
			truncated: all.length > limit,
			tier: "bound",
		};
	}

	////////////////////////////////
	//  Literals

	/**
	 * Find literal values: an exact one, a pattern, or a numeric range.
	 *
	 * This is the tier that makes text searchable as facts. A name inside a string is not a
	 * reference and never was, so it appears in no other table: a rename could leave `__all__`
	 * stale and a GDScript signal reached by `connect("name")` was invisible entirely.
	 *
	 * An exact value and a numeric range are indexed reads. A pattern is not, because SQLite has no
	 * REGEXP here, so it reads a bounded page and says when it stopped early.
	 */
	findLiterals(query: LiteralQuery, limit = DEFAULT_LITERAL_LIMIT): LiteralsResult {
		if (query.value !== undefined) {
			const found = this.store.literalsWithValue(query.value, limit + 1);
			return page(query, found, limit);
		}

		if (query.min !== undefined || query.max !== undefined) {
			const low = query.min ?? Number.NEGATIVE_INFINITY;
			const high = query.max ?? Number.POSITIVE_INFINITY;
			return page(query, this.store.literalsInRange(low, high, limit + 1), limit);
		}

		if (query.pattern !== undefined) {
			let expression: RegExp;
			try {
				expression = new RegExp(query.pattern);
			} catch (error) {
				throw new Error(
					`pattern is not a valid regular expression: ${error instanceof Error ? error.message : error}`,
				);
			}

			const scanned = this.store.literalsOfKind(query.kind ?? "string", PATTERN_SCAN_LIMIT);
			const matched = scanned.filter((literal) => expression.test(literal.value));
			const result = page(query, matched, limit);
			// A truncated scan and a truncated page are different truncations, and a caller that
			// cannot tell them apart reads "50 results" as "50 exist".
			return scanned.length >= PATTERN_SCAN_LIMIT ? { ...result, scanIncomplete: true } : result;
		}

		// The refusal shows the shapes, because naming the parameters alone was measured to fail: a
		// caller trying `text:` read the naming sentence and still never found `value`.
		throw new Error(
			'give a value, a pattern, or a numeric range, e.g. { value: "cycleCheckpoint" } or { pattern: "^cycle" } or { min: 0, max: 100 }',
		);
	}

	/** Values written in more than one file, which is the strongest textual signal of a relationship. */
	sharedLiterals(minimumFiles = 2, limit = DEFAULT_LITERAL_LIMIT) {
		return this.store.sharedLiterals(minimumFiles, limit);
	}

	////////////////////////////////
	//  Graph

	/**
	 * Fan-in, fan-out, and whether this symbol sits in a cycle.
	 *
	 * Every number here is bounded by what binding reached, so it is a fact about the INDEX rather
	 * than about the code. A caller told otherwise would read a low fan-in as "barely used" when it
	 * may only mean "barely resolved".
	 */
	graphOf(symbolId: string): GraphSummary {
		const cycle = findCycles(this.store.allEdges()).find((found) => found.members.includes(symbolId));

		// Members counted too, because a reference inside a method belongs to the METHOD. Asking a
		// class for its own fan-out returned zero however much it used, since nothing is written
		// directly in a class body, and a reader takes zero as "depends on nothing".
		const declaration = this.store.declaration(symbolId);
		const members = declaration
			? this.store.declarationsIn(declaration.module).filter((d) => d.containerId === symbolId)
			: [];
		const uses = new Set<string>();
		for (const owner of [symbolId, ...members.map((m) => m.symbolId)]) {
			for (const reference of this.store.referencesFrom(owner)) {
				if (reference.targetId !== null) uses.add(reference.targetId);
			}
		}

		return {
			symbolId,
			fanOut: uses.size,
			fanIn: this.store.referencesTo(symbolId).length,
			...(members.length === 0 ? {} : { viaMembers: members.length }),
			...(cycle === undefined ? {} : { cycle: cycle.members }),
		};
	}

	/** Every cycle in the workspace, largest first. */
	cycles(limit = 20) {
		return findCycles(this.store.allEdges())
			.sort((a, b) => b.members.length - a.members.length)
			.slice(0, limit);
	}

	////////////////////////////////
	//  History

	/**
	 * Files that change alongside this one, from git.
	 *
	 * The only fact class here drawn from neither the parser nor the filesystem, and the one the
	 * knowledge-layer doc calls the strongest non-graph signal. It finds relationships no edge can:
	 * a residue test that enforces an invariant by grep, twins held in sync by a fixture, two
	 * constants that must never diverge. None of those is a reference, and all of them get fixed in
	 * the same commit.
	 *
	 * Cached, since reading a thousand commits costs a subprocess and the answer only moves when
	 * the repository does.
	 */
	async coChangedWith(module: string, limit = 20) {
		return this.cache.through(`coChange ${module} ${limit}`, async () => {
			const commits = await readHistory(this.workspaceRoot);
			const { partners, report } = coChangesFor(module, commits);
			return { module, partners: partners.slice(0, limit), total: partners.length, ...report };
		});
	}

	/**
	 * Churn and age for one file, from the same commits co-change reads.
	 *
	 * Cached alongside co-change and keyed separately, since a caller usually wants one or the other.
	 */
	async fileHistory(module: string) {
		return this.cache.through(`fileHistory ${module}`, async () =>
			fileHistoryFor(module, await readHistory(this.workspaceRoot)),
		);
	}

	/**
	 * Commits whose message names this symbol.
	 *
	 * The one tier-1 fact that carries RATIONALE rather than structure. Every other class says what
	 * the code is or who touches it; a commit message is the only place someone wrote down why.
	 */
	async commitsMentioning(name: string, limit = DEFAULT_MENTION_LIMIT) {
		return this.cache.through(`mentions ${name} ${limit}`, async () => {
			const commits = await readHistory(this.workspaceRoot);
			const mentions = commitsMentioning(name, commits, limit);
			return { name, mentions, commits: commits.length };
		});
	}

	////////////////////////////////
	//  Type hierarchy

	/**
	 * What this type extends and what extends it.
	 *
	 * Built from `extends` and `implements` reference rows rather than from a new provider method,
	 * because those rows already exist in every provider and the reference index is dual: the two
	 * directions are the same table read through two indexes.
	 *
	 * An unresolved heritage name is REPORTED rather than dropped. `extends Node2D` in GDScript names
	 * an engine class that is genuinely outside the workspace, and a hierarchy that silently omitted
	 * it would read as "this extends nothing".
	 */
	typeHierarchy(symbolId: string, maxDepth = 16): TypeHierarchy {
		const isHeritage = (role: string) => role === "extends" || role === "implements";

		const supertypeIdsOf = (id: string) =>
			this.store
				.referencesFrom(id)
				.filter((reference) => isHeritage(reference.role))
				.map((reference) => reference.targetId)
				.filter((target): target is string => target !== null);

		const summariesOf = (ids: string[]) =>
			[...new Set(ids)]
				.map((id) => this.store.declaration(id))
				.filter((found): found is StoredDeclaration => found !== null)
				.map(toSummary);

		const supertypes = summariesOf(supertypeIdsOf(symbolId));
		const subtypes = summariesOf(
			this.store
				.referencesTo(symbolId)
				.filter((reference) => isHeritage(reference.role) && reference.fromId !== null)
				.map((reference) => reference.fromId as string),
		);

		// Guarded rather than trusted: a cyclic hierarchy does not compile in any of these languages,
		// but the index holds what a provider reported, which is not the same as what compiles.
		const seen = new Set<string>([symbolId]);
		const ancestors: string[] = [];
		let frontier = supertypeIdsOf(symbolId);
		for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
			const next: string[] = [];
			for (const id of frontier) {
				if (seen.has(id)) continue;
				seen.add(id);
				ancestors.push(id);
				next.push(...supertypeIdsOf(id));
			}
			frontier = next;
		}

		const unboundSupertypes = this.store
			.referencesFrom(symbolId)
			.filter((reference) => isHeritage(reference.role) && reference.targetId === null)
			.map((reference) => reference.name);
		// referencesFrom already drops unbound rows, so the unresolved ones come from the file's own
		// reference list instead.
		const declaration = this.store.declaration(symbolId);
		const unresolved =
			declaration === null
				? []
				: this.store
						.referencesIn(declaration.module)
						.filter(
							(reference) =>
								isHeritage(reference.role) &&
								reference.fromId === symbolId &&
								reference.targetId === null,
						)
						.map((reference) => reference.name);

		return {
			symbolId,
			supertypes,
			subtypes,
			ancestors: summariesOf(ancestors),
			unboundSupertypes: [...new Set([...unboundSupertypes, ...unresolved])],
		};
	}

	/**
	 * Who calls this, and what it calls, with the exact spans of each call.
	 *
	 * The same rows as the type hierarchy read through the `call` role instead of the heritage ones.
	 * Grouped by the symbol at the other end, because an editor draws one row per caller however many
	 * times that caller calls it, and the individual spans are what it highlights inside that row.
	 */
	callHierarchy(symbolId: string): CallHierarchy {
		const group = (
			rows: StoredReference[],
			endOf: (reference: StoredReference) => string | null,
		): CallHierarchyEdge[] => {
			const byPeer = new Map<string, Range[]>();
			for (const reference of rows) {
				if (reference.role !== "call") continue;
				const peer = endOf(reference);
				if (peer === null) continue;
				const ranges = byPeer.get(peer) ?? [];
				ranges.push({
					start: { line: reference.startLine, character: reference.startCharacter },
					end: { line: reference.endLine, character: reference.endCharacter },
				});
				byPeer.set(peer, ranges);
			}

			const edges: CallHierarchyEdge[] = [];
			for (const [peer, ranges] of byPeer) {
				const declaration = this.store.declaration(peer);
				if (declaration !== null) edges.push({ symbol: toSummary(declaration), ranges });
			}
			return edges;
		};

		return {
			symbolId,
			incoming: group(this.store.referencesTo(symbolId), (reference) => reference.fromId),
			outgoing: group(this.store.referencesFrom(symbolId), (reference) => reference.targetId),
		};
	}

	////////////////////////////////
	//  Facts and citations

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

		for (const site of await this.importSitesFor(declaration.module, declaration.name)) {
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

	////////////////////////////////
	//  The knowledge layer

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
			// is the doc's "pre-warm only high fan-in hubs" made queryable.
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

	/** The most-referenced symbols, which is hub rank. */
	hubs(limit = 20): Array<{ symbolId: string; count: number; declaration: SymbolSummary | null }> {
		return this.store.mostReferenced(limit).map((row) => {
			const declaration = this.store.declaration(row.symbolId);
			return { ...row, declaration: declaration === null ? null : toSummary(declaration) };
		});
	}

	/**
	 * Where a specifier lands. Asked of the provider, since the index does not hold specifiers.
	 *
	 * Cached because it is the one hot question here: it costs a provider round trip, a rename asks
	 * it once per same-named import, and the re-export walk asks the same handful repeatedly.
	 */
	async resolveImport(fromModule: string, specifier: string): Promise<ImportResolution> {
		return this.cache.through(`resolveImport ${fromModule} ${specifier}`, () =>
			this.supervisor.ask(fromModule, "resolveImport", { fromModule, specifier }),
		);
	}

	/** A reference's binding, for a caller holding a position rather than an id. */
	async bind(module: string, name: string, range: { start: { line: number; character: number } }): Promise<Binding> {
		return this.supervisor.ask(module, "bind", {
			module,
			name,
			range: { start: range.start, end: range.start },
		});
	}

	/**
	 * What renaming a symbol would touch, and what stands in the way. Reads only.
	 *
	 * The whole reason this is separate from applying: a rename is honest only over a set that is
	 * provably closed, and closedness is a question the index can answer without editing anything.
	 * The occurrences come from bound edges alone, because a name match is a guess and a guess is
	 * acceptable in a reading tool and disqualifying in a writing one.
	 */
	async prepareRename(symbolId: string, newName: string): Promise<RenamePlan> {
		const declaration = this.store.declaration(symbolId);
		if (!declaration) {
			return {
				symbolId,
				oldName: "",
				newName,
				files: [],
				occurrences: 0,
				blockers: [{ kind: "NotIndexed", detail: `${symbolId} is not in the index` }],
				warnings: [],
			};
		}

		const oldName = declaration.name;
		const byModule = new Map<string, RenameSite[]>();
		// The declaration's own name is a site like any other, and forgetting it renames every use
		// to point at a definition that still has the old name.
		byModule.set(declaration.module, [{ range: declaration.selectionRange }]);

		for (const reference of this.store.referencesTo(symbolId)) {
			const sites = byModule.get(reference.module) ?? [];
			sites.push({
				range: {
					start: { line: reference.startLine, character: reference.startCharacter },
					end: { line: reference.endLine, character: reference.endCharacter },
				},
				role: reference.role,
			});
			byModule.set(reference.module, sites);
		}

		for (const site of await this.importSitesFor(declaration.module, oldName)) {
			const sites = byModule.get(site.module) ?? [];
			sites.push({ range: site.range, role: "import" });
			byModule.set(site.module, sites);
		}

		// Renaming an owned symbol reaches its owner's CALLERS: a Python keyword argument names the
		// parameter at a site that spells the function's name, so nothing searching for the old name
		// can find it. Gathered here because who calls what is the index's question, not a provider's.
		const ownerCalls = this.ownerCallsFor(symbolId);
		// A file holding only owner calls still has to be visited, so it needs an entry even with no
		// occurrence of the old name in it.
		for (const module of ownerCalls.keys()) if (!byModule.has(module)) byModule.set(module, []);

		// Absent and empty mean different things, and the difference is the whole contract here.
		// EMPTY says the core gathered the owner's calls and none are in this file, which is the
		// normal case for the declaring file. ABSENT says nothing was gathered, so a provider still
		// has to refuse. Attaching the field only where calls happen to live conflates the two, and a
		// parameter declared in a file that never calls its own function would refuse forever.
		const owned = isParameterSymbol(symbolId);
		const files = [...byModule.entries()].map(([module, sites]) => ({
			module,
			sites,
			...(owned ? { ownerCalls: ownerCalls.get(module) ?? [] } : {}),
		}));
		const blockers =
			newName === oldName
				? [{ kind: "SameName", detail: `already named ${oldName}` }]
				: this.renameCollisions(symbolId, newName, new Set(byModule.keys()));

		return {
			symbolId,
			oldName,
			newName,
			files,
			occurrences: files.reduce((total, file) => total + file.sites.length, 0),
			blockers,
			warnings: [...this.renameWarnings(declaration, oldName, symbolId), ...this.ownerCallConcerns(symbolId)],
		};
	}

	/**
	 * Bound calls to the declaration that owns this symbol, grouped by file.
	 *
	 * Empty for anything that owns itself, which is nearly every rename. For a parameter it is the
	 * set of call sites whose named arguments have to move with it, and the id grammar alone says
	 * which declaration that is, so no language knowledge enters here.
	 */
	private ownerCallsFor(symbolId: string): Map<string, Range[]> {
		const byModule = new Map<string, Range[]>();
		if (!isParameterSymbol(symbolId)) return byModule;

		const owner = ownerOf(symbolId);
		if (owner === null) return byModule;

		for (const reference of this.store.referencesTo(owner)) {
			if (reference.role !== "call") continue;
			const ranges = byModule.get(reference.module) ?? [];
			ranges.push({
				start: { line: reference.startLine, character: reference.startCharacter },
				end: { line: reference.endLine, character: reference.endCharacter },
			});
			byModule.set(reference.module, ranges);
		}
		return byModule;
	}

	/**
	 * What a rename of an owned symbol cannot see.
	 *
	 * A call that never bound may still pass the argument being renamed, and nothing here can tell a
	 * genuinely different function from one binding could not follow. Reported rather than guessed,
	 * which is the same rule the same-spelling warning already follows.
	 */
	private ownerCallConcerns(symbolId: string): RenameConcern[] {
		if (!isParameterSymbol(symbolId)) return [];

		const owner = ownerOf(symbolId);
		const declaration = owner === null ? null : this.store.declaration(owner);
		if (declaration === null) {
			return [
				{
					kind: "OwnerNotIndexed",
					detail: "the declaration this belongs to is not indexed, so its call sites cannot be found",
				},
			];
		}

		const unbound = this.store.referencesSpelled(declaration.name, declaration.symbolId);
		if (unbound.length === 0) return [];
		return [
			{
				kind: "OwnerCallsUnresolved",
				detail: `${unbound.length} occurrence${unbound.length === 1 ? "" : "s"} of ${declaration.name} did not bind to it. If any is a call passing this argument by name, it will not be rewritten`,
				sites: unbound.slice(0, 20).map((r) => ({ module: r.module, line: r.startLine + 1 })),
			},
		];
	}

	/**
	 * Places the new name already means something, in a file this rename would rewrite.
	 *
	 * Without this a rename produces a file where one spelling means two things, which still parses
	 * often enough to be committed. Checked against the files being REWRITTEN rather than the whole
	 * workspace, because another module owning the name is normal and only a collision inside a file
	 * we are editing is a collision.
	 *
	 * A blocker rather than a warning: this is something known to break, not somewhere we cannot see
	 * far enough. Each one names the conflicting site and both ways out, since a refusal that does
	 * not say what to do next just moves the search to the caller.
	 */
	private renameCollisions(symbolId: string, newName: string, touched: Set<string>): RenameConcern[] {
		const declared = this.store
			.declarationsNamed(newName)
			.filter((other) => other.symbolId !== symbolId && touched.has(other.module));

		const bound = this.store.importsBinding(newName).filter((entry) => touched.has(entry.module));

		const concerns: RenameConcern[] = [];
		if (declared.length > 0) {
			concerns.push({
				kind: "NameTaken",
				detail: `${newName} is already declared in ${declared.length === 1 ? "a file" : `${declared.length} files`} this rename rewrites. Rename that declaration first, or pick another name.`,
				sites: declared.map((other) => ({ module: other.module, line: other.selectionRange.start.line })),
			});
		}
		if (bound.length > 0) {
			concerns.push({
				kind: "NameImported",
				detail: `${newName} is already imported in ${bound.length === 1 ? "a file" : `${bound.length} files`} this rename rewrites, so the rewritten uses would bind to that import instead. Rename or alias that import first, or pick another name.`,
				sites: bound.map((entry) => ({ module: entry.module, line: entry.range?.start.line ?? 0 })),
			});
		}
		return concerns;
	}

	/**
	 * Import statements that write this name AND whose specifier lands on the declaring module.
	 *
	 * Only the alias's source half is a site. `import { foo as bar }` renames `foo` and leaves every
	 * use of `bar` alone, so rewriting the local span here would break the file it was meant to fix.
	 *
	 * Specifiers are resolved here rather than at index time. Resolving all of them while indexing
	 * costs a provider round trip per import across the whole workspace, to answer a question only
	 * the handful sharing a name with a rename target ever ask.
	 */
	private async importSitesFor(
		declaringModule: string,
		name: string,
	): Promise<Array<{ module: string; range: Range; factId: string }>> {
		const statements = this.store.importsNamed(name);
		const resolve = this.resolutionCache();
		const exposing = await this.modulesExposing(declaringModule, statements, resolve);

		const found: Array<{ module: string; range: Range; factId: string }> = [];
		for (const statement of statements) {
			// A row without a span names no export, so there is nothing here for a rename to rewrite.
			// The row exists for the import GRAPH, which is a different question.
			if (statement.range === undefined) continue;
			const landed = await resolve(statement.module, statement.specifier);
			if (landed !== null && exposing.has(landed))
				found.push({ module: statement.module, range: statement.range, factId: statement.factId });
		}
		return found;
	}

	/**
	 * Perform a rename, or explain why it did not happen. Nothing is written unless all of it can be.
	 *
	 * The plan's blockers stop it before a provider is asked anything. Then every file's edits are
	 * gathered, and a single blocked site anywhere aborts the whole operation: a blocked site means
	 * an occurrence that SHOULD change and cannot, so applying the rest would leave the codebase in
	 * a state that no longer builds, which is worse than not starting.
	 */
	async renameSymbol(symbolId: string, newName: string): Promise<RenameOutcome> {
		const plan = await this.prepareRename(symbolId, newName);
		if (plan.blockers.length > 0) return { renamed: false, plan, reason: plan.blockers[0]?.detail ?? "blocked" };

		const files: FileEdits[] = [];
		const blocked: RenameConcern[] = [];

		for (const file of plan.files) {
			const text = this.readFile(file.module);
			if (text === null) return { renamed: false, plan, reason: `${file.module} could not be read` };

			const answer = await this.supervisor.ask(file.module, "renameEdits", {
				module: file.module,
				text,
				oldName: plan.oldName,
				newName,
				sites: file.sites,
				...(file.ownerCalls === undefined ? {} : { ownerCalls: file.ownerCalls }),
			});

			if (answer.status === "refused") {
				return { renamed: false, plan, reason: `${file.module}: ${answer.reason}${detailOf(answer.detail)}` };
			}
			for (const site of answer.blocked) {
				blocked.push({
					kind: site.reason,
					detail: `${file.module}: ${site.detail ?? "cannot be rewritten safely"}`,
					sites: [{ module: file.module, line: site.range.start.line + 1 }],
				});
			}
			if (answer.edits.length > 0) files.push({ module: file.module, edits: answer.edits });
		}

		if (blocked.length > 0) {
			return {
				renamed: false,
				plan: { ...plan, blockers: blocked },
				reason: "some occurrences cannot be rewritten",
			};
		}

		const written = writeAll(this.workspaceRoot, files, this.readFile);
		if (!written.applied) {
			return { renamed: false, plan, reason: `${written.module ?? "a file"}: ${written.reason}` };
		}

		// Re-indexed immediately, since every edited file's facts are now wrong and a rename is
		// usually followed by another question about the same symbols.
		for (const module of written.modules) {
			const text = this.readFile(module);
			if (text !== null) await this.indexFile(module, hashOf(text));
		}
		return { renamed: true, plan, modules: written.modules };
	}

	/** One provider round trip per distinct specifier, since the re-export walk revisits them. */
	private resolutionCache(): (fromModule: string, specifier: string) => Promise<string | null> {
		const seen = new Map<string, Promise<string | null>>();

		return (fromModule, specifier) => {
			// Escaped, never raw: a raw NUL makes the whole file binary to git and invisible to grep.
			const key = `${fromModule}\0${specifier}`;
			let answer = seen.get(key);
			if (answer === undefined) {
				answer = this.resolveImport(fromModule, specifier)
					.then((r) => (r.status === "resolved" ? r.module : null))
					.catch(() => null);
				seen.set(key, answer);
			}
			return answer;
		};
	}

	/**
	 * Every module through which this name can be reached, the declaring one included.
	 *
	 * A barrel is the normal case, not an exotic one: `import { X } from "@scope/pkg"` resolves to
	 * the package entry, while X is declared in some file that entry re-exports. Demanding the two
	 * be the same module made every such import invisible to a rename, which was found by asking
	 * this tool about its own `ProviderHandlers` and getting 9 of 12 occurrences.
	 *
	 * A fixpoint rather than one hop, because barrels chain. Bounded by the number of re-export
	 * rows, so a cycle of barrels terminates instead of walking forever.
	 */
	private async modulesExposing(
		declaringModule: string,
		statements: StoredImport[],
		resolve: (fromModule: string, specifier: string) => Promise<string | null>,
	): Promise<Set<string>> {
		const exposing = new Set([declaringModule]);
		const reExports = statements.filter((statement) => statement.reExport);

		for (let pass = 0; pass <= reExports.length; pass++) {
			let grew = false;
			for (const statement of reExports) {
				if (exposing.has(statement.module)) continue;
				const landed = await resolve(statement.module, statement.specifier);
				if (landed !== null && exposing.has(landed)) {
					exposing.add(statement.module);
					grew = true;
				}
			}
			if (!grew) break;
		}
		return exposing;
	}

	/**
	 * Where the index cannot see far enough to promise a rename is complete.
	 *
	 * Both of these are uncertainty rather than failure, so they are stated and the caller decides.
	 * Refusing on either would refuse most real renames; hiding them would claim a completeness the
	 * index does not have.
	 */
	private renameWarnings(declaration: StoredDeclaration, oldName: string, symbolId: string): RenameConcern[] {
		const warnings: RenameConcern[] = [];

		const unbound = this.store.referencesSpelled(oldName, symbolId);
		if (unbound.length > 0) {
			warnings.push({
				kind: "SameSpellingUnbound",
				detail: `${unbound.length} occurrence${unbound.length === 1 ? "" : "s"} of ${oldName} did not bind to this symbol; some may be uses of it that binding could not follow`,
				sites: unbound.slice(0, 20).map((r) => ({ module: r.module, line: r.startLine + 1 })),
			});
		}

		if (declaration.exported === true) {
			warnings.push({
				kind: "ExportedBeyondIndex",
				detail: `${oldName} is exported, so anything outside this workspace that uses it is not visible here`,
			});
		}

		return warnings;
	}

	/**
	 * A symbol's type, asked of the provider that owns its file.
	 *
	 * The index holds a rendered signature but not a type, and the two answer different questions:
	 * a signature is how the declaration was written, a type is what the checker concluded.
	 */
	async typeOf(symbolId: string): Promise<TypeInfo> {
		const declaration = this.store.declaration(symbolId);
		if (!declaration) {
			return { status: "unknown", reason: "NotIndexed", detail: `${symbolId} is not in the index` };
		}
		return this.supervisor.ask(declaration.module, "typeOf", { symbolId });
	}
}
