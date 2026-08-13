// Where the pieces meet: a question in, an answer from the index, and providers consulted only
// when the index cannot answer.
//
// This is the layer both adapters talk to. Neither of them knows there is a store, a supervisor,
// or a provider process.

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	answerFactId,
	applyEdits,
	type Binding,
	composeSymbolId,
	doubtFactId,
	type FactKind,
	type FileFacts,
	type ImportOrigin,
	type ImportResolution,
	type IndexDepth,
	isParameterSymbol,
	isWithin,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveImportSite,
	ownerOf,
	parseSymbolId,
	type Range,
	type RenameSite,
	rebaseSymbolId,
	type TypeInfo,
	type UnknownReason,
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
import {
	describeScope,
	type FileScope,
	fileScopeFor,
	generatedFiles,
	includedFiles,
	isExternalModule,
} from "./fileScope.js";
import { findCycles } from "./graph.js";
import { coChangesFor, commitsMentioning, DEFAULT_MENTION_LIMIT, fileHistoryFor, readHistory } from "./history.js";
import { decideInvalidation, type FileEvent } from "./invalidation.js";
import { ResultCache } from "./resultCache.js";
import { compileSearchRegex } from "./search.js";
import type {
	IndexStore,
	StoredDeclaration,
	StoredFact,
	StoredImport,
	StoredLiteral,
	StoredReference,
} from "./store.js";
import type { ProviderSupervisor } from "./supervisor.js";
import type { RefactorIssue } from "./transactions.js";

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
	graph: GraphSummary;
	hierarchy: TypeHierarchy;
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
	failure?: string;
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
	failures: number;
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
	regex?: string | undefined;
	kind?: string | undefined;
	min?: number | undefined;
	max?: number | undefined;
}

export interface LiteralsResult {
	query: LiteralQuery;
	literals: StoredLiteral[];
	total: number;
	truncated: boolean;
	/** Set when a regex search stopped reading before the end of the table. */
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

/**
 * One symbol's text as it stands on disk, with the range that text occupies.
 *
 * The range rides along because it is what a replacement overwrites: a caller that read the text
 * here and edited it needs to say WHERE it goes back, and re-deriving that would let the two
 * disagree.
 */
export type SymbolSource =
	| {
			found: true;
			module: string;
			name: string;
			kind: string;
			range: Range;
			text: string;
			/** Of the same read the text came from, so a later write can prove nothing moved. */
			contentHash: string;
	  }
	| { found: false; reason: string; stale?: boolean };

/**
 * A replacement worked out but not yet written.
 *
 * Carries the whole new file rather than an edit, because the splice was already checked against
 * the text it was cut from and re-deriving it at write time is how the two come to disagree.
 */
/** How many times one name in one role failed to bind, kept with the parts so nothing re-splits. */
interface UnboundTally {
	name: string;
	role: string;
	/** Why the provider could not bind it, so a report says more than "does not resolve". */
	reason: string;
	count: number;
}

export type ReplacementPlan =
	| {
			ok: true;
			module: string;
			text: string;
			range: Range;
			/** Of the text the splice was cut from, so the writer can prove nothing moved since. */
			baseHash: string;
			issues: RefactorIssue[];
	  }
	| { ok: false; reason: string };

/**
 * A move worked out but not yet written.
 *
 * The closure is the moved declaration plus everything declared inside it, which is what the id
 * migration and the dependency walk are both scoped to.
 */
export type MovePlan =
	| {
			ok: true;
			symbolId: string;
			name: string;
			fromModule: string;
			toModule: string;
			/** The declaration's own text, which is what gets inserted at the target. */
			text: string;
			removal: Range;
			closure: string[];
			dependencies: MoveDependency[];
			/** Modules importing the moved symbol, which need their specifier re-pointed. */
			referencing: string[];
			/** Whether anything left behind in the source module still uses it. */
			usedAtSource: boolean;
			baseHash: string;
	  }
	| { ok: false; reason: string };

/** Whole new contents per module, so the writer never re-derives an edit it did not check. */
export type MoveEditsOutcome =
	| { ok: true; files: Array<{ module: string; text: string }>; issues: RefactorIssue[] }
	| { ok: false; issues: RefactorIssue[]; reason: string };

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
 * How many literals a regex search will read before giving up.
 *
 * SQLite has no REGEXP here, so a regex is matched in application code and the read is what
 * costs. Stopping is fine; stopping SILENTLY is not, which is why the result carries a flag saying
 * the scan did not finish.
 */
export const REGEX_SCAN_LIMIT = 20_000;

/** Resolving or regex-searching imports reads at most this many rows. */
const IMPORT_SCAN_LIMIT = 20_000;

////////////////////////////////
//  Functions & Helpers

function hashOf(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function detailOf(detail: string | undefined): string {
	return detail === undefined ? "" : `: ${detail}`;
}

function sameRange(a: Range, b: Range): boolean {
	return (
		a.start.line === b.start.line &&
		a.start.character === b.start.character &&
		a.end.line === b.end.line &&
		a.end.character === b.end.character
	);
}

/**
 * Whether a name failing to bind means the code is broken, or merely outside the index.
 *
 * A standard library call answers ExternalDependency and a local answers NotIndexed, and both are
 * correct code. Reporting them would make every edit that calls a method look like breakage, which
 * is what a first run against a real file showed.
 */
/**
 * A stored provenance back to the reason it came from.
 *
 * An unbound reference stores its reason in the provenance column. Anything else there belongs to
 * a binding that succeeded, which has no reason, so the honest answer is that the index does not
 * hold the target.
 */
function unknownReasonOf(provenance: string): UnknownReason {
	return UNKNOWN_REASONS.includes(provenance as UnknownReason) ? (provenance as UnknownReason) : "NotIndexed";
}

const UNKNOWN_REASONS: UnknownReason[] = [
	"NotImplemented",
	"DynamicallyTyped",
	"ExternalDependency",
	"ParseError",
	"RecursionLimit",
	"Ambiguous",
	"RuntimeConstructed",
	"NotIndexed",
];

function isDangling(reason: string): boolean {
	return reason !== "ExternalDependency" && reason !== "NotIndexed" && reason !== "DynamicallyTyped";
}

/**
 * Counts by name and role, which is what survives an edit that moves every range below it.
 *
 * The parts ride along with the count so nothing has to split the key back apart, which is where a
 * delimiter would have to be chosen and where choosing wrong is invisible.
 */
function countUnbound(rows: Array<{ name: string; role: string; reason: string }>): Map<string, UnboundTally> {
	const counts = new Map<string, UnboundTally>();
	for (const row of rows) {
		// Keyed without the reason, so the same broken name reported under a different reason is
		// still recognized as the problem that was already there.
		const key = `${row.role}:${row.name}`;
		const tally = counts.get(key);
		if (tally) tally.count++;
		else counts.set(key, { name: row.name, role: row.role, reason: row.reason, count: 1 });
	}
	return counts;
}

/**
 * The text a range covers, in the same UTF-16 coordinates every edit uses.
 *
 * Null rather than a clamped slice when the range runs past the file: a range that no longer fits
 * describes text that moved, and returning the nearest thing would be a plausible wrong answer.
 */
function sliceRange(text: string, range: Range): string | null {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);

	const from = starts[range.start.line];
	const to = starts[range.end.line];
	if (from === undefined || to === undefined) return null;

	const start = from + range.start.character;
	const end = to + range.end.character;
	if (end > text.length || end < start) return null;

	return text.slice(start, end);
}

/** A package remains external even when it offers one safe module for surface indexing. */
function importTarget(resolution: ImportResolution): { module: string; depth: IndexDepth } | null {
	if (resolution.status === "resolved") {
		return { module: resolution.module, depth: resolution.depth ?? "full" };
	}
	if (resolution.status === "external" && resolution.surface !== undefined) {
		return { module: resolution.surface.module, depth: "surface" };
	}
	return null;
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
	private status: Omit<IndexStatus, "stored"> = { state: "unstarted", done: 0, total: 0, failures: 0 };
	private scope: FileScope | null = null;
	private discovered = new Set<string>();
	private roots = new Set<string>();
	private depths = new Map<string, IndexDepth>();
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
	 *
	 * Deliberately takes no caller-claimed hash: this reads the file itself and hashes that read,
	 * so facts are never filed under the hash of a different version.
	 */
	async indexFile(module: string, depth: IndexDepth = "full"): Promise<IndexOutcome> {
		if (this.currentScope().denies(module)) return { module, action: "skipped", reason: "denied by scope" };
		const route = this.supervisor.route(module);
		if (!route.owned) {
			const reason = route.reason === "contested" ? `claimed by ${route.providerIds.join(", ")}` : "unclaimed";
			return { module, action: "skipped", reason };
		}

		const text = this.readFile(module);
		if (text === null) {
			this.forgetFile(module);
			return { module, action: "forgotten", reason: "file is gone" };
		}

		// Of the text actually read, never the caller's. A watcher hashes at event time and this
		// reads later, so trusting the argument would store facts from one version of a file under
		// the hash of another, and every staleness check downstream would compare the wrong pair.
		const readHash = hashOf(text);

		const facts = await this.supervisor.ask(module, "parseFile", {
			module,
			contentHash: readHash,
			text,
			...(depth === "surface" ? { depth } : {}),
		});
		const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
		this.store.replaceFile(module, readHash, facts.declarations, facts.references, facts.imports, facts.literals);
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
		this.status = { state: "discovering", done: 0, total: 0, failures: 0 };
		this.discovered = new Set<string>();
		for (const provider of this.supervisor.running()) {
			const project = await this.supervisor.askProvider(provider.providerId, "discoverProject", {
				workspaceRoot: this.workspaceRoot,
			});
			for (const module of project.files) this.discovered.add(module);
		}

		this.roots = this.rootModules();
		this.depths = new Map([...this.roots].map((module) => [module, this.rootDepth(module)]));
		const modules = [...this.roots];

		const outcomes: IndexOutcome[] = [];
		const seen = new Set<string>();
		this.status = { state: "indexing", done: 0, total: modules.length, failures: 0 };
		for (const [done, module] of modules.entries()) {
			let outcome: IndexOutcome;
			try {
				outcome = await this.indexOne(module);
			} catch (error) {
				outcome = this.failedOutcome(module, error);
			}
			outcomes.push(outcome);
			if (outcome.action === "forgotten") this.roots.delete(module);
			else seen.add(module);
			this.status = { state: "indexing", done: done + 1, total: modules.length, failures: this.status.failures };
			onProgress?.(done + 1, modules.length);
		}

		outcomes.push(...(await this.followImports(seen)));
		outcomes.push(...this.prune(seen));
		this.status = { state: "ready", done: outcomes.length, total: outcomes.length, failures: this.status.failures };
		return outcomes;
	}

	/** How the file set was decided, so a caller never confuses 350 files with 136,000. */
	scopeReport(): string {
		return this.scope === null ? "not yet scoped" : describeScope(this.scope);
	}

	private async indexOne(
		module: string,
		depth = this.depths.get(module) ?? this.rootDepth(module),
	): Promise<IndexOutcome> {
		if (this.currentScope().denies(module)) return { module, action: "skipped", reason: "denied by scope" };
		const text = this.readFile(module);
		if (text !== null) return this.indexFile(module, depth);
		this.forgetFile(module);
		return { module, action: "forgotten", reason: "file is gone" };
	}

	private failedOutcome(module: string, error: unknown): IndexOutcome {
		const failure = error instanceof Error ? error.message : String(error);
		this.status = { ...this.status, failures: this.status.failures + 1 };
		return { module, action: "skipped", reason: "parse failed", failure };
	}

	/**
	 * Index whatever the indexed files import, even where discovery was not allowed to look.
	 *
	 * The reachability half of the scoping rule. A generated file you import is part of your
	 * program however your VCS feels about it, while a secrets file nobody imports never becomes
	 * reachable, which is why this is safe in a way that simply un-ignoring a directory is not.
	 *
	 * Workspace-resolved specifiers follow their implementation. An external one may contribute a
	 * bounded surface, never the package implementation tree.
	 */
	private async followImports(
		seen: Set<string>,
		indexExisting = true,
		previousDepths: ReadonlyMap<string, IndexDepth> = new Map(),
	): Promise<IndexOutcome[]> {
		const outcomes: IndexOutcome[] = [];

		while (true) {
			const found: string[] = [];
			for (const module of [...seen]) {
				for (const statement of this.store.importsIn(module)) {
					const landed = await this.resolveImport(module, statement.specifier).catch(() => null);
					const target = landed === null ? null : importTarget(landed);
					if (target === null || this.currentScope().denies(target.module)) continue;
					const depth = this.currentScope().surface(target.module) ? "surface" : target.depth;
					const prior = this.depths.get(target.module);
					if (seen.has(target.module) && !(prior === "surface" && depth === "full")) continue;
					seen.add(target.module);
					this.depths.set(target.module, depth);
					found.push(target.module);
				}
			}
			if (found.length === 0) break;
			for (const module of found) {
				if (
					!indexExisting &&
					this.store.contentHashOf(module) !== null &&
					previousDepths.get(module) === this.depths.get(module)
				)
					continue;
				try {
					outcomes.push(await this.indexOne(module));
				} catch (error) {
					outcomes.push(this.failedOutcome(module, error));
				}
			}
		}
		return outcomes;
	}

	private prune(reachable: Set<string>): IndexOutcome[] {
		const outcomes: IndexOutcome[] = [];
		for (const module of this.store.indexedFiles()) {
			if (reachable.has(module)) continue;
			this.forgetFile(module);
			outcomes.push({ module, action: "forgotten", reason: "no longer a root or reachable" });
		}
		return outcomes;
	}

	private rootModules(extra: Iterable<string> = []): Set<string> {
		this.scope = fileScopeFor(this.workspaceRoot);
		const named = includedFiles(this.workspaceRoot, this.scope.include);
		const namedSet = new Set(named);
		const candidates = [...new Set([...(this.scope.known ?? []), ...this.discovered, ...named, ...extra])].filter(
			(module) => this.scope?.allows(module) ?? true,
		);
		const generated = generatedFiles(this.workspaceRoot, candidates);
		return new Set(
			candidates
				.filter((module) => namedSet.has(module) || !generated.has(module))
				.filter((module) => this.supervisor.route(module).owned),
		);
	}

	private currentScope(): FileScope {
		this.scope ??= fileScopeFor(this.workspaceRoot);
		return this.scope;
	}

	private rootDepth(module: string): IndexDepth {
		return this.currentScope().surface(module) ? "surface" : "full";
	}

	private forgetFile(module: string): void {
		this.store.forgetFile(module);
		this.cache.invalidate();
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
		const previousRoots = this.roots;
		const previousDepths = this.depths;
		const changed = events.filter((event) => event.kind === "changed").map((event) => event.module);
		const roots = this.rootModules(changed);
		for (const event of events) {
			if (event.kind === "deleted") roots.delete(event.module);
		}
		this.roots = roots;
		this.depths = new Map([...roots].map((module) => [module, this.rootDepth(module)]));
		const attempted = new Set<string>();

		for (const event of events) {
			const decision = decideInvalidation(event, {
				route: (module) => this.supervisor.route(module),
				indexedHash: (module) => this.store.contentHashOf(module),
			});

			if (decision.action === "forget") {
				this.forgetFile(decision.module);
				outcomes.push({ module: decision.module, action: "forgotten" });
				continue;
			}
			if (decision.action === "ignore") {
				outcomes.push({ module: decision.module, action: "skipped", reason: decision.reason });
				continue;
			}
			if (!roots.has(decision.module) && this.store.contentHashOf(decision.module) === null) {
				outcomes.push({ module: decision.module, action: "skipped", reason: "outside roots and reachability" });
				continue;
			}
			attempted.add(decision.module);
			try {
				const outcome = await this.indexFile(
					decision.module,
					this.depths.get(decision.module) ?? this.rootDepth(decision.module),
				);
				outcomes.push(outcome);
				if (outcome.action === "forgotten") roots.delete(decision.module);
			} catch (error) {
				outcomes.push(this.failedOutcome(decision.module, error));
			}
		}

		for (const module of roots) {
			if (
				attempted.has(module) ||
				(this.store.contentHashOf(module) !== null &&
					previousRoots.has(module) &&
					previousDepths.get(module) === this.depths.get(module))
			)
				continue;
			try {
				const outcome = await this.indexOne(module);
				outcomes.push(outcome);
				if (outcome.action === "forgotten") roots.delete(module);
			} catch (error) {
				outcomes.push(this.failedOutcome(module, error));
			}
		}

		const seen = new Set(roots);
		outcomes.push(...(await this.followImports(seen, false, previousDepths)));
		outcomes.push(...this.prune(seen));
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
			graph: this.graphSummary(symbolId),
			hierarchy: this.typeHierarchy(symbolId),
			tier: "bound",
		};
	}

	/** One declaration with its ranges, which `describe` deliberately does not carry. */
	declarationOf(symbolId: string): StoredDeclaration | null {
		return this.store.declaration(symbolId);
	}

	/**
	 * The exact source text one address occupies, plus the range a replacement would overwrite.
	 *
	 * Read once and sliced from that same read, so the hash reported is the hash of the text
	 * returned. Hashing a second read would let a file change in between and hand back a slice that
	 * never existed at the hash it claims.
	 *
	 * A stale index refuses rather than slicing: the stored range describes text that has moved, so
	 * cutting at it produces something that looks like source and is not the symbol.
	 */
	symbolSource(address: { symbolId?: string | undefined; factId?: string | undefined }): SymbolSource {
		const located = this.locate(address);
		if ("problem" in located) return { found: false, reason: located.problem };

		const { module, range, name, kind } = located;
		const text = this.readFile(module);
		if (text === null) return { found: false, reason: `${module} is not on disk any more` };

		const stored = this.store.contentHashOf(module);
		if (stored !== null && stored !== hashOf(text)) {
			return {
				found: false,
				reason: `${module} changed since it was indexed, so its ranges are stale`,
				stale: true,
			};
		}

		const sliced = sliceRange(text, range);
		if (sliced === null) return { found: false, reason: `the stored range falls outside ${module}` };

		return { found: true, module, name, kind, range, text: sliced, contentHash: hashOf(text) };
	}

	/**
	 * What replacing one symbol's text would do, without writing anything.
	 *
	 * Everything expensive happens here and nothing touches disk, so a caller can hold the workspace
	 * gate for the write alone. The candidate is parsed by the owning provider, which is what turns
	 * "this text is different" into "these symbols moved and these references stopped binding".
	 */
	async planReplacement(
		address: { symbolId?: string | undefined; factId?: string | undefined },
		newText: string,
	): Promise<ReplacementPlan> {
		const source = this.symbolSource(address);
		if (!source.found) return { ok: false, reason: source.reason };

		const guard = this.replacementGuard(address, source);
		if (guard) return { ok: false, reason: guard };

		const before = this.readFile(source.module);
		if (before === null) return { ok: false, reason: `${source.module} is not on disk any more` };

		const spliced = applyEdits(before, [{ range: source.range, newText }]);
		if ("problem" in spliced) return { ok: false, reason: spliced.problem };

		const route = this.supervisor.route(source.module);
		if (!route.owned) return { ok: false, reason: `no provider owns ${source.module}` };

		const candidate = await this.supervisor.ask(source.module, "parseFile", {
			module: source.module,
			contentHash: hashOf(spliced.text),
			text: spliced.text,
		});

		const errors = candidate.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		if (errors.length > 0) {
			// Restored before returning: the provider now holds the rejected text, and a later
			// question would be answered from a version that was never written.
			await this.reparseFromDisk(source.module);
			return { ok: false, reason: `the replacement does not parse: ${errors.map((e) => e.message).join("; ")}` };
		}

		const renamed = this.renamedDeclaration(address, candidate, source);
		if (renamed) {
			await this.reparseFromDisk(source.module);
			return { ok: false, reason: renamed };
		}

		const issues = this.impactOf(source.module, candidate);

		// Silence from a provider that never claimed to report syntax errors is not approval. Said
		// out loud, because the alternative is a caller believing the candidate was checked.
		if (!this.supervisor.declares(route.providerId, "syntaxDiagnostics")) {
			issues.push({
				kind: "SyntaxUnchecked",
				detail: `the provider for ${source.module} does not report syntax errors, so the replacement was not checked`,
				module: source.module,
			});
		}

		await this.reparseFromDisk(source.module);

		return {
			ok: true,
			module: source.module,
			text: spliced.text,
			range: source.range,
			baseHash: hashOf(before),
			issues,
		};
	}

	/**
	 * What moving one declaration to another module would involve, without writing anything.
	 *
	 * The core works out WHICH modules are touched and WHAT the moved body depends on, both of
	 * which come out of the index. Rendering the text is the provider's, so this stops at handing
	 * each module a request.
	 */
	planMove(symbolId: string, toModule: string): MovePlan {
		const declaration = this.store.declaration(symbolId);
		if (!declaration) return { ok: false, reason: `${symbolId} is not in the index` };
		if (declaration.module === toModule) return { ok: false, reason: `${symbolId} is already in ${toModule}` };

		const source = this.symbolSource({ symbolId });
		if (!source.found) return { ok: false, reason: source.reason };

		const closure = this.store.symbolIdsIn(declaration.module).filter((candidate) => isWithin(candidate, symbolId));

		const dependencies = this.dependenciesOf(declaration.module, closure, symbolId);

		// Modules whose imports name the moved symbol, plus the source itself when something left
		// behind still uses it.
		const referencing = new Set(
			this.store
				.referencesTo(symbolId)
				.map((reference) => reference.module)
				.filter((module) => module !== declaration.module),
		);
		const usedAtSource = this.store
			.referencesTo(symbolId)
			.some((reference) => reference.module === declaration.module && !this.inRange(reference, source.range));

		return {
			ok: true,
			symbolId,
			name: declaration.name,
			fromModule: declaration.module,
			toModule,
			text: source.text,
			removal: source.range,
			closure,
			dependencies,
			referencing: [...referencing],
			usedAtSource,
			baseHash: source.contentHash,
		};
	}

	/**
	 * Asks every involved module's provider for its part of a move.
	 *
	 * One blocked site anywhere fails the whole move. A relocated declaration whose importers still
	 * point at the old module is code that does not build, which is worse than not starting.
	 */
	async moveEdits(plan: Extract<MovePlan, { ok: true }>): Promise<MoveEditsOutcome> {
		const requests = this.moveRequests(plan);
		const files: Array<{ module: string; text: string }> = [];
		const blocked: RefactorIssue[] = [];

		for (const request of requests) {
			const before = request.exists ? (this.readFile(request.module) ?? "") : "";
			const answer = await this.supervisor.ask(request.module, "moveEdits", { ...request, text: before });

			if (answer.status === "refused") {
				return {
					ok: false,
					issues: [],
					reason: `${request.module}: ${answer.reason}${detailOf(answer.detail)}`,
				};
			}
			for (const site of answer.blocked) {
				blocked.push({
					kind: site.reason,
					detail: `${request.module}: ${site.detail ?? "cannot be rewritten safely"}`,
					module: request.module,
				});
			}
			if (answer.edits.length === 0) continue;

			const applied = applyEdits(before, answer.edits);
			if ("problem" in applied) {
				return { ok: false, issues: [], reason: `${request.module}: ${applied.problem}` };
			}
			files.push({ module: request.module, text: applied.text });
		}

		if (blocked.length > 0) {
			return { ok: false, issues: blocked, reason: "some occurrences cannot be rewritten" };
		}
		return { ok: true, files, issues: [] };
	}

	/** One request per involved module, each describing only that module's part. */
	private moveRequests(plan: Extract<MovePlan, { ok: true }>): MoveEditsRequest[] {
		const shared = {
			symbolId: plan.symbolId,
			name: plan.name,
			fromModule: plan.fromModule,
			toModule: plan.toModule,
		};

		const requests: MoveEditsRequest[] = [
			{
				...shared,
				module: plan.fromModule,
				text: "",
				exists: true,
				role: { removal: plan.removal },
				importSites: [],
				// The source keeps needing the symbol when something left behind still calls it.
				dependencies: plan.usedAtSource
					? [
							{
								name: plan.name,
								origin: { kind: "workspaceModule", symbolId: plan.symbolId, module: plan.toModule },
							},
						]
					: [],
				sites: [],
			},
			{
				...shared,
				module: plan.toModule,
				text: "",
				exists: this.readFile(plan.toModule) !== null,
				role: { insertion: { text: plan.text } },
				importSites: [],
				dependencies: plan.dependencies,
				sites: [],
			},
		];

		for (const module of plan.referencing) {
			requests.push({
				...shared,
				module,
				text: "",
				exists: true,
				role: {},
				importSites: this.importSitesForMove(module, plan.name),
				dependencies: [],
				sites: [],
			});
		}

		return requests;
	}

	/** Import statements in one module naming the moved symbol, which must now address its target. */
	private importSitesForMove(module: string, name: string): MoveImportSite[] {
		const sites: MoveImportSite[] = [];
		for (const statement of this.store.importsIn(module)) {
			if (statement.name !== name && statement.local !== name) continue;
			if (statement.range === undefined) continue;
			sites.push({
				range: statement.range,
				specifier: statement.specifier,
				importKind: statement.name === undefined ? "namespace" : "named",
				...(statement.name === undefined ? {} : { importedName: statement.name }),
				...(statement.local === undefined ? {} : { localName: statement.local }),
				reExport: statement.reExport,
			});
		}
		return sites;
	}

	/**
	 * Whether the moved symbol is still reachable from everywhere that used it.
	 *
	 * Run after the reindex, because the question is about what the providers concluded rather than
	 * what the edits looked like. A specifier that is syntactically fine and points nowhere produces
	 * exactly this: an importer whose reference no longer binds.
	 */
	checkMoveLanded(name: string, modules: string[]): RefactorIssue[] {
		const issues: RefactorIssue[] = [];

		for (const module of modules) {
			for (const reference of this.store.referencesIn(module)) {
				if (reference.name !== name) continue;
				if (reference.targetId !== null) continue;
				if (!isDangling(reference.provenance)) continue;

				issues.push({
					kind: "UnresolvedAfterMove",
					detail: `${name} no longer resolves here: ${reference.provenance}`,
					module,
					line: reference.startLine + 1,
				});
			}
		}

		return issues;
	}

	/** Re-mints one id of a moved closure for its new module. */
	rebaseIntoModule(id: string, movedId: string, toModule: string): string | null {
		const parsed = parseSymbolId(movedId);
		if (parsed === null) return null;
		return rebaseSymbolId(id, movedId, composeSymbolId({ ...parsed, module: toModule }));
	}

	/** Whether a stored reference sits inside a range, which is how the moved body is bounded. */
	private inRange(reference: { startLine: number; startCharacter: number }, range: Range): boolean {
		if (reference.startLine < range.start.line || reference.startLine > range.end.line) return false;
		if (reference.startLine === range.start.line && reference.startCharacter < range.start.character) return false;
		if (reference.startLine === range.end.line && reference.startCharacter > range.end.character) return false;
		return true;
	}

	/**
	 * Every name the moved body uses, with what the index proved about where it comes from.
	 *
	 * Walked over the whole closure rather than over references owned by the moved symbol, because
	 * a moved class's body references belong to its METHODS and a top-level initializer may be
	 * owned by nothing at all.
	 */
	private dependenciesOf(module: string, closure: string[], symbolId: string): MoveDependency[] {
		const inside = new Set(closure);
		const source = this.symbolSource({ symbolId });
		if (!source.found) return [];

		const seen = new Set<string>();
		const dependencies: MoveDependency[] = [];

		for (const reference of this.store.referencesIn(module)) {
			if (!this.inRange(reference, source.range)) continue;
			if (seen.has(reference.name)) continue;
			seen.add(reference.name);

			const target = reference.targetId;
			if (target !== null && inside.has(target)) {
				dependencies.push({ name: reference.name, origin: { kind: "insideClosure", symbolId: target } });
				continue;
			}

			if (target !== null) {
				const declaration = this.store.declaration(target);
				if (declaration?.module === module) {
					dependencies.push({
						name: reference.name,
						origin: {
							kind: "sourceModule",
							symbolId: target,
							name: declaration.name,
							...(declaration.exported === undefined ? {} : { exported: declaration.exported }),
						},
					});
					continue;
				}
				if (declaration) {
					dependencies.push({
						name: reference.name,
						origin: { kind: "workspaceModule", symbolId: target, module: declaration.module },
					});
					continue;
				}
			}

			const via = this.importOriginFor(module, reference.name);
			if (via !== null) {
				dependencies.push({ name: reference.name, origin: { kind: "external", via } });
				continue;
			}

			dependencies.push({
				name: reference.name,
				origin: { kind: "unresolved", reason: unknownReasonOf(reference.provenance) },
			});
		}

		return dependencies;
	}

	/** The import statement that brought a name into a module, when one did. */
	private importOriginFor(module: string, name: string): ImportOrigin | null {
		for (const statement of this.store.importsIn(module)) {
			if (statement.name !== name && statement.local !== name) continue;
			return {
				specifier: statement.specifier,
				// A statement naming no export binds the module itself, which is a namespace import.
				importKind: statement.name === undefined ? "namespace" : "named",
				...(statement.name === undefined ? {} : { importedName: statement.name }),
				...(statement.local === undefined ? {} : { localName: statement.local }),
			};
		}
		return null;
	}

	/**
	 * Every id a rename re-mints, old to new.
	 *
	 * A member's id carries its container's descriptors, so renaming a class re-mints its methods
	 * and their parameters too. Migrating only the class itself would strand everything written
	 * about them under ids nothing resolves.
	 */
	renameIdMap(symbolId: string, newName: string): Map<string, string> {
		const declaration = this.store.declaration(symbolId);
		const map = new Map<string, string>();
		if (!declaration) return map;

		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.local !== undefined) return map;

		const last = parsed.descriptors.at(-1);
		if (last === undefined) return map;
		const renamed = composeSymbolId({
			...parsed,
			descriptors: [...parsed.descriptors.slice(0, -1), { ...last, name: newName }],
		});

		for (const candidate of this.store.symbolIdsIn(declaration.module)) {
			const rebased = rebaseSymbolId(candidate, symbolId, renamed);
			if (rebased !== null) map.set(candidate, rebased);
		}
		return map;
	}

	/**
	 * Modules whose stored facts name an id the rename re-mints, whether or not their text changes.
	 *
	 * A file calling a renamed class's METHOD contains no occurrence of the class name, so it gets
	 * no edit, yet its reference rows point at ids that are about to stop existing. Left alone it
	 * would keep answering with them.
	 */
	modulesBoundTo(ids: Iterable<string>): string[] {
		const modules = new Set<string>();
		for (const id of ids) {
			for (const reference of this.store.referencesTo(id)) modules.add(reference.module);
		}
		return [...modules];
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
	 * Modules whose text on disk is not what the index describes.
	 *
	 * Any rewrite planned from stored ranges is wrong for these: the ranges describe text that has
	 * moved. A rename against a stale module rewrites the occurrences it can still find and misses
	 * the ones that shifted, which produces a file where the import says one name and the call says
	 * another.
	 */
	staleModules(modules: Iterable<string>): string[] {
		const stale: string[] = [];
		for (const module of modules) {
			const indexed = this.store.contentHashOf(module);
			if (indexed === null) continue;
			if (this.currentHashOf(module) !== indexed) stale.push(module);
		}
		return stale;
	}

	/** The hash of a module's current text, for a writer proving nothing moved since it planned. */
	currentHashOf(module: string): string | null {
		const text = this.readFile(module);
		return text === null ? null : hashOf(text);
	}

	/**
	 * Writes one module's whole text, temp file then rename.
	 *
	 * The caller holds the workspace gate and has already journaled what was there, so this only
	 * has to make the replacement itself uninterruptible.
	 */
	writeModule(module: string, text: string): void {
		const full = path.join(this.workspaceRoot, module);
		const temporary = `${full}.lexicon-tmp`;
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(temporary, text);
		renameSync(temporary, full);
	}

	/** Puts the provider back on the text that is actually there, after parsing a candidate. */
	private async reparseFromDisk(module: string): Promise<void> {
		const text = this.readFile(module);
		if (text === null) return;
		await this.supervisor
			.ask(module, "parseFile", { module, contentHash: hashOf(text), text })
			.catch(() => undefined);
	}

	/** Reasons a replacement is refused before it is even parsed. */
	private replacementGuard(
		address: { symbolId?: string | undefined },
		source: Extract<SymbolSource, { found: true }>,
	): string | null {
		if (address.symbolId === undefined) return null;

		// Two declarations sharing an id means the store kept one and discarded the other, so the
		// address names something the index cannot tell apart.
		const sharing = this.store
			.declarationsIn(source.module)
			.filter((declaration) => declaration.symbolId === address.symbolId);
		if (sharing.length > 1) {
			return `${address.symbolId} names more than one declaration in ${source.module}, so it cannot be replaced safely`;
		}

		// One statement can declare several names, giving each the same span. Replacing that span
		// would rewrite siblings the caller never addressed.
		const overlapping = this.store.declarationsIn(source.module).filter((declaration) => {
			if (declaration.symbolId === address.symbolId) return false;
			if (isWithin(declaration.symbolId, address.symbolId as string)) return false;
			if (isWithin(address.symbolId as string, declaration.symbolId)) return false;
			return sameRange(declaration.range, source.range);
		});
		if (overlapping.length > 0) {
			const names = overlapping.map((declaration) => declaration.name).join(", ");
			return `${source.name} shares its span with ${names}, so replacing it would rewrite them too`;
		}

		return null;
	}

	/**
	 * A replacement that renames its own declaration, which replace must not carry out.
	 *
	 * The id embeds the name, so the old symbol simply disappears and a new one takes its place.
	 * Nothing would migrate the knowledge written about it or rewrite the callers, which is exactly
	 * what rename exists to do.
	 */
	private renamedDeclaration(
		address: { symbolId?: string | undefined },
		candidate: FileFacts,
		source: Extract<SymbolSource, { found: true }>,
	): string | null {
		if (address.symbolId === undefined) return null;
		if (candidate.declarations.some((declaration) => declaration.symbolId === address.symbolId)) return null;

		// The id is gone, which is either a rename or a deletion. Deleting is a real refactor and is
		// allowed; the orphan check reports what still points at it. A rename is refused, because
		// only rename rewrites the callers and carries the knowledge across.
		const before = new Set(this.store.declarationsIn(source.module).map((declaration) => declaration.symbolId));
		const old = this.store.declaration(address.symbolId);
		const replacement = candidate.declarations.find(
			(declaration) =>
				!before.has(declaration.symbolId) &&
				declaration.kind === old?.kind &&
				declaration.containerId === old?.containerId,
		);
		if (!replacement) return null;

		return `the replacement renames ${source.name} to ${replacement.name}, which replace cannot do. Keep the name, or use refactor_rename.`;
	}

	/**
	 * What the candidate breaks, minus what was already broken.
	 *
	 * Subtracted by (name, role, reason) rather than by fact id, because a fact id contains its
	 * range: any edit above an untouched problem would otherwise make it look newly introduced.
	 */
	private impactOf(module: string, candidate: FileFacts): RefactorIssue[] {
		const issues: RefactorIssue[] = [];

		const before = this.store.declarationsIn(module);
		const after = new Set(candidate.declarations.map((declaration) => declaration.symbolId));
		for (const declaration of before) {
			if (after.has(declaration.symbolId)) continue;
			const users = this.store.referencesTo(declaration.symbolId).filter((row) => row.module !== module);
			if (users.length === 0) continue;

			issues.push({
				kind: "OrphanedReference",
				detail: `${declaration.name} is gone but still used in ${[...new Set(users.map((u) => u.module))].join(", ")}`,
				module,
			});
		}

		const wasUnbound = countUnbound(
			this.store
				.referencesIn(module)
				.filter((row) => row.targetId === null && isDangling(row.provenance))
				.map((row) => ({ name: row.name, role: row.role, reason: row.provenance })),
		);
		const nowUnbound = countUnbound(
			candidate.references
				.filter((reference) => reference.binding.status === "unbound" && isDangling(reference.binding.reason))
				.map((reference) => ({
					name: reference.name,
					role: reference.role,
					reason: reference.binding.status === "unbound" ? reference.binding.reason : "",
				})),
		);

		for (const [key, tally] of nowUnbound) {
			if (tally.count <= (wasUnbound.get(key)?.count ?? 0)) continue;
			issues.push({
				kind: "UnboundReference",
				detail: `${tally.name} (${tally.role}) does not resolve: ${tally.reason}`,
				module,
			});
		}

		return issues;
	}

	/** One address, two spellings. A declaration is named by symbol id and a literal by fact id. */
	private locate(address: {
		symbolId?: string | undefined;
		factId?: string | undefined;
	}): { module: string; range: Range; name: string; kind: string } | { problem: string } {
		if (address.symbolId !== undefined) {
			const declaration = this.store.declaration(address.symbolId);
			if (!declaration) return { problem: `${address.symbolId} is not in the index` };
			return {
				module: declaration.module,
				range: declaration.range,
				name: declaration.name,
				kind: declaration.kind,
			};
		}

		if (address.factId !== undefined) {
			const fact = this.store.factById(address.factId);
			if (!fact) return { problem: `${address.factId} names nothing in the index any more` };
			if (fact.fact !== "literal") {
				return {
					problem: `${address.factId} names a ${fact.fact}, and only a literal is addressable by fact id`,
				};
			}
			return { module: fact.module, range: fact.range, name: fact.value, kind: `${fact.kind} literal` };
		}

		return { problem: "give either a symbolId or a literal's factId" };
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

	/** Search declared symbols by a name substring or regular expression. */
	searchSymbols(
		text: string | undefined,
		options: {
			regex?: string | undefined;
			kind?: string | undefined;
			module?: string | undefined;
			limit?: number | undefined;
		} = {},
	) {
		if ((text === undefined) === (options.regex === undefined)) {
			throw new Error(`Set exactly one of text or regex.`);
		}
		const found = this.store.searchSymbols(text, {
			...(options.regex === undefined ? {} : { regex: options.regex }),
			...(options.kind === undefined ? {} : { kind: options.kind }),
			...(options.module === undefined ? {} : { module: options.module }),
			limit: (options.limit ?? DEFAULT_REFERENCE_LIMIT) + 1,
		});
		const limit = options.limit ?? DEFAULT_REFERENCE_LIMIT;
		return {
			text,
			...(options.regex === undefined ? {} : { regex: options.regex }),
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
		specifierRegex?: string | undefined;
		module?: string | undefined;
		moduleRegex?: string | undefined;
		limit?: number | undefined;
	}) {
		const limit = query.limit ?? DEFAULT_REFERENCE_LIMIT;
		const targets = [query.specifier, query.specifierRegex, query.module, query.moduleRegex].filter(
			(value) => value !== undefined,
		).length;
		if (targets !== 1) throw new Error("Set exactly one import search target.");

		if (query.specifier !== undefined) {
			const found = this.store.importsMatching(query.specifier, limit + 1);
			return { query, imports: found.slice(0, limit), total: found.length, truncated: found.length > limit };
		}
		if (query.specifierRegex !== undefined) {
			const expression = compileSearchRegex(query.specifierRegex);
			const scanned = this.store.importsForScan(IMPORT_SCAN_LIMIT);
			const matched = scanned.filter((statement) => {
				expression.lastIndex = 0;
				return expression.test(statement.specifier);
			});
			const result = {
				query,
				imports: matched.slice(0, limit),
				total: matched.length,
				truncated: matched.length > limit,
			};
			return scanned.length >= IMPORT_SCAN_LIMIT ? { ...result, scanIncomplete: true } : result;
		}
		if (query.module !== undefined) {
			const target = query.module;
			const matched: StoredImport[] = [];
			for (const statement of this.store.importsForScan(IMPORT_SCAN_LIMIT)) {
				const landed = await this.resolveImport(statement.module, statement.specifier).catch(() => null);
				if (landed !== null && importTarget(landed)?.module === target) matched.push(statement);
				if (matched.length > limit) break;
			}
			return {
				query,
				imports: matched.slice(0, limit),
				total: matched.length,
				truncated: matched.length > limit,
			};
		}

		if (query.moduleRegex === undefined) throw new Error("Set exactly one import search target.");
		const expression = compileSearchRegex(query.moduleRegex);
		const scanned = this.store.importsForScan(IMPORT_SCAN_LIMIT);
		const matched: StoredImport[] = [];
		for (const statement of scanned) {
			const landed = await this.resolveImport(statement.module, statement.specifier).catch(() => null);
			if (landed !== null) {
				const module = importTarget(landed)?.module;
				if (module !== undefined) {
					expression.lastIndex = 0;
					if (expression.test(module)) matched.push(statement);
				}
			}
			if (matched.length > limit) break;
		}
		const result = {
			query,
			imports: matched.slice(0, limit),
			total: matched.length,
			truncated: matched.length > limit,
		};
		return scanned.length >= IMPORT_SCAN_LIMIT ? { ...result, scanIncomplete: true } : result;
	}

	/** Files, symbols and the biggest modules. The first question about a repository you do not know. */
	overview(topModules = 15) {
		const includeModule = (module: string) => !isExternalModule(this.workspaceRoot, module);
		const modules = this.store.moduleSummary().filter(({ module }) => includeModule(module));
		const totals = this.store.totalsForModules(includeModule);

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
			...totals,
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
	 * Find literal values: an exact one, a regex, or a numeric range.
	 *
	 * This is the tier that makes text searchable as facts. A name inside a string is not a
	 * reference and never was, so it appears in no other table: a rename could leave `__all__`
	 * stale and a GDScript signal reached by `connect("name")` was invisible entirely.
	 *
	 * An exact value and a numeric range are indexed reads. A regex is not, because SQLite has no
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

		if (query.regex !== undefined) {
			const expression = compileSearchRegex(query.regex);
			const scanned = this.store.literalsOfKind(query.kind ?? "string", REGEX_SCAN_LIMIT);
			const matched = scanned.filter((literal) => {
				expression.lastIndex = 0;
				return expression.test(literal.value);
			});
			const result = page(query, matched, limit);
			// A truncated scan and a truncated page are different truncations, and a caller that
			// cannot tell them apart reads "50 results" as "50 exist".
			return scanned.length >= REGEX_SCAN_LIMIT ? { ...result, scanIncomplete: true } : result;
		}

		// The refusal shows the shapes, because naming the parameters alone was measured to fail: a
		// caller trying `text:` read the naming sentence and still never found `value`.
		throw new Error(
			'give a value, a regex, or a numeric range, e.g. { value: "cycleCheckpoint" } or { regex: "/^cycle/" } or { min: 0, max: 100 }',
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
	private graphSummary(symbolId: string): GraphSummary {
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
	 * History for one file, from the same commits co-change reads.
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

	/** The most-referenced symbols, which is hub rank. */
	mostReferenced(limit = 20): Array<{ symbolId: string; count: number; declaration: SymbolSummary | null }> {
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
		const surfaceGlobs = this.currentScope().bundles;
		const configKey = surfaceGlobs.join("\u0000");
		return this.cache.through(`resolveImport ${fromModule} ${specifier} ${configKey}`, () =>
			this.supervisor.ask(fromModule, "resolveImport", {
				fromModule,
				specifier,
				...(surfaceGlobs.length === 0 ? {} : { surfaceGlobs }),
			}),
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
			if (this.readFile(module) !== null) await this.indexFile(module);
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
