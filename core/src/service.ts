// Composition root. Owns the wiring, delegates the rest.
//
// Each owner is handed a narrow port rather than the supervisor, and a residue test holds it there.
// The methods below are pass-throughs on purpose.

import {
	type Binding,
	type CacheStats,
	type CoChangedWithResult,
	type CommitsMentioningResult,
	type Cycle,
	type FileHistory,
	type ImportResolution,
	type MostReferencedResult,
	type OverviewResult,
	parseSymbolId,
	type SharedLiteralsResult,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import { writeAll } from "./applyEdits.js";
import { type Clock, systemClock } from "./clock.js";
import { describeScope, type FileScope, isExternalModule } from "./fileScope.js";
import { coChangesFor, commitsMentioning, DEFAULT_MENTION_LIMIT, fileHistoryFor, readHistory } from "./history.js";
import { ImportResolver } from "./imports.js";
import { WorkspaceIndexer } from "./indexer.js";
import {
	type CallHierarchy,
	type CommentQuery,
	type CommentsResult,
	DEFAULT_COMMENT_LIMIT,
	DEFAULT_LITERAL_LIMIT,
	DEFAULT_REFERENCE_LIMIT,
	type DescribeResult,
	type DocQuery,
	type DocsResult,
	IndexReadModel,
	type LiteralQuery,
	type LiteralsResult,
	type ReferencesResult,
	type SymbolSummary,
	type TypeHierarchy,
} from "./indexReads.js";
import { KnowledgeLedger } from "./knowledge.js";
import type { ProviderPort } from "./providerPort.js";
import { liveProbe, type ProviderProbe } from "./providerProbe.js";
import { RefactorPlanner, type RenamePlan } from "./refactorPlanner.js";
import type { UnknownType } from "./refusalSlots.js";
import { diagnoseSubject, type Refusal, type SubjectDiagnosis, subjectRefused, writeFailed } from "./refusals.js";
import { ResultCache } from "./resultCache.js";
import { type SourceReader, textOf } from "./sourceRead.js";
import { SourceWorkspace, type SymbolSource } from "./sourceWorkspace.js";
import type { IndexStore, StoredComment, StoredDeclaration } from "./store.js";

////////////////////////////////
//  Constants

/** How long a tree-first answer waits on its priority parse before serving outline facts. */
const ENSURE_TREE_BUDGET_MS = 60_000;

/** A reporting cap, not a correctness one. Says so in the output when it bites. */
const COMMENT_COUNT_SCAN = 200_000;

////////////////////////////////
//  Interfaces & Types

/** The plan rides along either way, so a refusal can say what it would have done. */
export type RenameOutcome =
	| { renamed: true; plan: RenamePlan; modules: string[] }
	| { renamed: false; plan: RenamePlan; reason: Refusal };

////////////////////////////////
////////////////////////////////
//  Class

export class LexiconService {
	constructor(
		private readonly store: IndexStore,
		private readonly supervisor: ProviderPort,
		readSource: SourceReader,
		private readonly workspaceRoot = ".",
		private readonly clock: Clock = systemClock,
	) {
		// The indexer wants the reason a file is unreadable; everything else wants text or nothing.
		this.readFile = (module) => textOf(readSource(module));
		const readFile = this.readFile;
		this.reads = new IndexReadModel(store);
		// Caching and surface globs are workspace decisions, so they are answered here.
		this.imports = new ImportResolver(store, (fromModule, specifier) => {
			const surfaceGlobs = this.currentScope().bundles;
			const configKey = surfaceGlobs.join("\u0000");
			return this.cache.through(`resolveImport ${fromModule} ${specifier} ${configKey}`, () =>
				this.supervisor.ask(fromModule, "resolveImport", {
					fromModule,
					specifier,
					...(surfaceGlobs.length === 0 ? {} : { surfaceGlobs }),
				}),
			);
		});
		this.knowledge = new KnowledgeLedger(store, this.imports, this.clock);
		// An arrow, not the resolver itself: its own port reads the scope back off this indexer.
		this.indexer = new WorkspaceIndexer(
			store,
			supervisor,
			readSource,
			workspaceRoot,
			this.cache,
			(from, specifier) => this.imports.resolveImport(from, specifier),
			this.clock,
		);
		this.source = new SourceWorkspace(store, readFile, workspaceRoot);
		this.probe = liveProbe(supervisor, readFile);
		this.planner = new RefactorPlanner(store, this.imports, this.source, this.probe, readFile);
	}

	private readonly cache = new ResultCache();

	private readonly readFile: (module: string) => string | null;

	/** The only writer of the index. */
	readonly indexer: WorkspaceIndexer;

	/** The text on disk, which the index is checked against. */
	readonly source: SourceWorkspace;

	/** Less than the supervisor offers, on purpose. */
	readonly probe: ProviderProbe;

	/** Plans only. renameSymbol below is what writes. */
	readonly planner: RefactorPlanner;

	/** Public so a read-only caller can take this and reach nothing else. */
	readonly reads: IndexReadModel;

	readonly imports: ImportResolver;

	readonly knowledge: KnowledgeLedger;

	/** Hit and miss counts, so a claim that the cache helps is checkable rather than asserted. */
	cacheStats(): CacheStats {
		return this.cache.stats();
	}

	////////////////////////////////
	//  Indexing, answered by WorkspaceIndexer

	indexFile(...args: Parameters<WorkspaceIndexer["indexFile"]>): ReturnType<WorkspaceIndexer["indexFile"]> {
		return this.indexer.indexFile(...args);
	}

	indexWorkspace(
		...args: Parameters<WorkspaceIndexer["indexWorkspace"]>
	): ReturnType<WorkspaceIndexer["indexWorkspace"]> {
		return this.indexer.indexWorkspace(...args);
	}

	applyBatch(...args: Parameters<WorkspaceIndexer["applyBatch"]>): ReturnType<WorkspaceIndexer["applyBatch"]> {
		return this.indexer.applyBatch(...args);
	}

	/** The timer's sweep: nothing new to the pass, presence as of the last prune. */
	sweepKnowledge(): ReturnType<WorkspaceIndexer["sweepKnowledge"]> {
		return this.indexer.sweepKnowledge();
	}

	indexStatus(concerning?: string): ReturnType<WorkspaceIndexer["indexStatus"]> {
		return this.indexer.indexStatus(concerning);
	}

	moduleStatus(module: string): ReturnType<WorkspaceIndexer["moduleStatus"]> {
		return this.indexer.moduleStatus(module);
	}

	moduleDeclarations(module: string): ReturnType<WorkspaceIndexer["moduleDeclarations"]> {
		return this.indexer.moduleDeclarations(module);
	}

	warmHold(): string | null {
		return this.indexer.warmHold();
	}

	warmFailure(): string | null {
		return this.indexer.warmFailure();
	}

	warmupWorkspace(
		...args: Parameters<WorkspaceIndexer["warmupWorkspace"]>
	): ReturnType<WorkspaceIndexer["warmupWorkspace"]> {
		return this.indexer.warmupWorkspace(...args);
	}

	upgradeRemaining(): Promise<void> {
		return this.indexer.upgradeRemaining();
	}

	/** Upgrades a symbol's module and direct imports before graph queries. */
	async ensureTreeFor(symbolId: string): Promise<void> {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null) return;
		await this.ensureTreeForModule(parsed.module);
	}

	async ensureTreeForModule(module: string): Promise<void> {
		if (this.store.depthTotals().outline === 0) return;
		let handle: ReturnType<Clock["setTimer"]> | null = null;
		const budget = new Promise<void>((resolve) => {
			handle = this.clock.setTimer(resolve, ENSURE_TREE_BUDGET_MS);
		});
		const work = (async () => {
			const closure = new Set([module]);
			for (const statement of this.store.importsIn(module)) {
				if (closure.size > 32) break;
				const landed = await this.resolveImport(module, statement.specifier).catch(() => null);
				if (landed !== null && landed.status === "resolved") closure.add(landed.module);
			}
			await this.indexer.requestFull([...closure]).catch(() => {});
		})();
		try {
			await Promise.race([work, budget]);
		} finally {
			if (handle !== null) this.clock.clearTimer(handle);
		}
	}

	////////////////////////////////
	//  Source text, answered by SourceWorkspace

	symbolSource(...args: Parameters<SourceWorkspace["symbolSource"]>): SymbolSource {
		return this.source.symbolSource(...args);
	}

	currentHashOf(module: string): string | null {
		return this.source.currentHashOf(module);
	}

	staleModules(modules: string[]): string[] {
		return this.source.staleModules(modules);
	}

	rebaseIntoModule(
		...args: Parameters<RefactorPlanner["rebaseIntoModule"]>
	): ReturnType<RefactorPlanner["rebaseIntoModule"]> {
		return this.planner.rebaseIntoModule(...args);
	}

	writeModule(module: string, text: string): void {
		this.source.writeModule(module, text);
	}

	////////////////////////////////
	//  Refactor plans, answered by RefactorPlanner

	planReplacement(
		...args: Parameters<RefactorPlanner["planReplacement"]>
	): ReturnType<RefactorPlanner["planReplacement"]> {
		return this.planner.planReplacement(...args);
	}

	planMove(...args: Parameters<RefactorPlanner["planMove"]>): ReturnType<RefactorPlanner["planMove"]> {
		return this.planner.planMove(...args);
	}

	planInsert(...args: Parameters<RefactorPlanner["planInsert"]>): ReturnType<RefactorPlanner["planInsert"]> {
		return this.planner.planInsert(...args);
	}

	prepareRename(...args: Parameters<RefactorPlanner["prepareRename"]>): ReturnType<RefactorPlanner["prepareRename"]> {
		return this.planner.prepareRename(...args);
	}

	renameEdits(...args: Parameters<RefactorPlanner["renameEdits"]>): ReturnType<RefactorPlanner["renameEdits"]> {
		return this.planner.renameEdits(...args);
	}

	moveEdits(...args: Parameters<RefactorPlanner["moveEdits"]>): ReturnType<RefactorPlanner["moveEdits"]> {
		return this.planner.moveEdits(...args);
	}

	renameIdMap(...args: Parameters<RefactorPlanner["renameIdMap"]>): ReturnType<RefactorPlanner["renameIdMap"]> {
		return this.planner.renameIdMap(...args);
	}

	modulesBoundTo(
		...args: Parameters<RefactorPlanner["modulesBoundTo"]>
	): ReturnType<RefactorPlanner["modulesBoundTo"]> {
		return this.planner.modulesBoundTo(...args);
	}

	checkMoveLanded(
		...args: Parameters<RefactorPlanner["checkMoveLanded"]>
	): ReturnType<RefactorPlanner["checkMoveLanded"]> {
		return this.planner.checkMoveLanded(...args);
	}

	dependenciesOf(
		...args: Parameters<RefactorPlanner["dependenciesOf"]>
	): ReturnType<RefactorPlanner["dependenciesOf"]> {
		return this.planner.dependenciesOf(...args);
	}

	impactOf(...args: Parameters<RefactorPlanner["impactOf"]>): ReturnType<RefactorPlanner["impactOf"]> {
		return this.planner.impactOf(...args);
	}

	private currentScope(): FileScope {
		return this.indexer.currentScope();
	}

	////////////////////////////////
	//  Index reads, answered by IndexReadModel

	findByName(name: string, module?: string): SymbolSummary[] {
		return this.reads.findByName(name, module);
	}

	describe(symbolId: string): DescribeResult | null {
		return this.reads.describe(symbolId);
	}

	declarationOf(symbolId: string): StoredDeclaration | null {
		return this.reads.declarationOf(symbolId);
	}

	declarationsIn(module: string): StoredDeclaration[] {
		return this.reads.declarationsIn(module);
	}

	/** Everything written about one symbol, in source order. */
	commentsFor(symbolId: string): StoredComment[] {
		return this.reads.commentsFor(symbolId);
	}

	outline(module: string): SymbolSummary[] {
		return this.reads.outline(module);
	}

	fileNotes(module: string): ReturnType<IndexReadModel["fileNotes"]> {
		return this.reads.fileNotes(module);
	}

	searchSymbols(...args: Parameters<IndexReadModel["searchSymbols"]>): ReturnType<IndexReadModel["searchSymbols"]> {
		return this.reads.searchSymbols(...args);
	}

	findReferences(symbolId: string, limit = DEFAULT_REFERENCE_LIMIT, within?: string): ReferencesResult {
		return this.reads.findReferences(symbolId, limit, within);
	}

	findLiterals(query: LiteralQuery, limit = DEFAULT_LITERAL_LIMIT): LiteralsResult {
		return this.reads.findLiterals(query, limit);
	}

	sharedLiterals(minimumFiles = 2, limit = DEFAULT_LITERAL_LIMIT): SharedLiteralsResult {
		return this.reads.sharedLiterals(minimumFiles, limit);
	}

	findDocs(query: DocQuery, limit = DEFAULT_COMMENT_LIMIT): DocsResult {
		return this.reads.findDocs(query, limit);
	}

	findComments(query: CommentQuery, limit = DEFAULT_COMMENT_LIMIT): CommentsResult {
		return this.reads.findComments(query, limit);
	}

	cycles(limit = 20): Cycle[] {
		return this.reads.cycles(limit);
	}

	typeHierarchy(symbolId: string, maxDepth = 16): TypeHierarchy {
		return this.reads.typeHierarchy(symbolId, maxDepth);
	}

	callHierarchy(symbolId: string): CallHierarchy {
		return this.reads.callHierarchy(symbolId);
	}

	mostReferenced(limit = 20): MostReferencedResult {
		return this.reads.mostReferenced(limit);
	}

	////////////////////////////////
	//  Imports, answered by ImportResolver

	resolveImport(fromModule: string, specifier: string): Promise<ImportResolution> {
		return this.imports.resolveImport(fromModule, specifier);
	}

	findImports(...args: Parameters<ImportResolver["findImports"]>): ReturnType<ImportResolver["findImports"]> {
		return this.imports.findImports(...args);
	}

	////////////////////////////////
	//  Knowledge, answered by KnowledgeLedger

	factsFor(...args: Parameters<KnowledgeLedger["factsFor"]>): ReturnType<KnowledgeLedger["factsFor"]> {
		return this.knowledge.factsFor(...args);
	}

	resolveFacts(...args: Parameters<KnowledgeLedger["resolveFacts"]>): ReturnType<KnowledgeLedger["resolveFacts"]> {
		return this.knowledge.resolveFacts(...args);
	}

	recordAnswer(...args: Parameters<KnowledgeLedger["recordAnswer"]>): ReturnType<KnowledgeLedger["recordAnswer"]> {
		return this.knowledge.recordAnswer(...args);
	}

	invalidateAnswer(
		...args: Parameters<KnowledgeLedger["invalidateAnswer"]>
	): ReturnType<KnowledgeLedger["invalidateAnswer"]> {
		return this.knowledge.invalidateAnswer(...args);
	}

	reaffirmAnswer(
		...args: Parameters<KnowledgeLedger["reaffirmAnswer"]>
	): ReturnType<KnowledgeLedger["reaffirmAnswer"]> {
		return this.knowledge.reaffirmAnswer(...args);
	}

	recallAnswer(...args: Parameters<KnowledgeLedger["recallAnswer"]>): ReturnType<KnowledgeLedger["recallAnswer"]> {
		return this.knowledge.recallAnswer(...args);
	}

	/** Why an id names no declaration, as every tool answers it. */
	diagnoseSubject(symbolId: string): SubjectDiagnosis {
		return diagnoseSubject(symbolId, this.store);
	}

	demandOf(...args: Parameters<KnowledgeLedger["demandOf"]>): ReturnType<KnowledgeLedger["demandOf"]> {
		return this.knowledge.demandOf(...args);
	}

	recordDemand(...args: Parameters<KnowledgeLedger["recordDemand"]>): ReturnType<KnowledgeLedger["recordDemand"]> {
		return this.knowledge.recordDemand(...args);
	}

	recallAnswers(...args: Parameters<KnowledgeLedger["recallAnswers"]>): ReturnType<KnowledgeLedger["recallAnswers"]> {
		return this.knowledge.recallAnswers(...args);
	}

	knowledgeGaps(...args: Parameters<KnowledgeLedger["knowledgeGaps"]>): ReturnType<KnowledgeLedger["knowledgeGaps"]> {
		return this.knowledge.knowledgeGaps(...args);
	}

	////////////////////////////////
	//  Indexing

	/** How the file set was decided, so a caller never confuses 350 files with 136,000. */
	scopeReport(): string {
		return describeScope(this.indexer.currentScope());
	}

	/** Totals per attachment form, so a verifying run can see the tier landed rather than assume it. */
	commentCounts(): string {
		const all = this.reads.commentsToScan(COMMENT_COUNT_SCAN);
		if (all.length === 0) return "none";
		const capped = all.length >= COMMENT_COUNT_SCAN ? ` (counted the first ${COMMENT_COUNT_SCAN})` : "";
		const byForm = new Map<string, number>();
		for (const comment of all) byForm.set(comment.form, (byForm.get(comment.form) ?? 0) + 1);
		const anchored = all.filter((comment) => comment.anchorId !== null).length;
		const forms = [...byForm].sort((left, right) => right[1] - left[1]).map(([form, n]) => `${form} ${n}`);
		return `${all.length} (${forms.join(", ")}), ${anchored} anchored to a symbol${capped}`;
	}

	////////////////////////////////
	//  Answering

	/** Files, symbols and the biggest modules. The first question about a repository you do not know. */
	overview(topModules = 15, topData = 5): OverviewResult {
		const includeModule = (module: string) => !isExternalModule(this.workspaceRoot, module);
		const modules = this.store.moduleSummary().filter(({ module }) => includeModule(module));
		const totals = this.store.totalsForModules(includeModule);
		const content = this.store.contentTotals(includeModule);

		// Only code and unclassed modules rank; prose classes are counted separately.
		const code = modules.filter((row) => row.content === "code" || row.content === null);
		const data = modules.filter(
			(row): row is typeof row & { content: "data" | "document" } =>
				row.content === "data" || row.content === "document",
		);

		// Knowledge coverage belongs in the first answer a fresh agent reads. The layer was
		// discoverable only through describe's inline line, so an agent arriving with an ordinary
		// task never learned it existed: overview is the front door, and the front door said nothing.
		//
		// Staleness is exact only while the knowledge base is small. It costs a citation resolve per
		// answer, and the front door is the most-called tool, so past the cap it is honestly SKIPPED
		// rather than sampled: a number that silently covered part of the base would read as the
		// whole. Stale entries still surface individually on recall and in knowledge_gaps.
		const counts = this.store.answerCounts();
		const stale = this.knowledge.staleAnswerCount();
		// A COUNT query, so unlike staleness it stays cheap at any size and is never skipped.
		const doubted = this.store.doubtedCount();

		const scan = this.store.readScanSummary();
		// A document's headings are symbols and belong in the total, but a reader taking that total
		// for callable code reads it wrong the moment one is indexed, so the split rides alongside.
		const byKind = this.store.symbolsByKind();
		return {
			...totals,
			content,
			symbolsByKind: byKind,
			scope: this.scopeReport(),
			index: this.indexStatus(),
			...(scan === null ? {} : { scan }),
			parseFailures: this.store.parseFailures(),
			notes: this.store.noteTotals(),
			modules: modules.length,
			largest: code.slice(0, topModules).map(({ module, symbols }) => ({ module, symbols })),
			largestData: data
				.slice(0, topData)
				.map(({ module, symbols, content: kind }) => ({ module, symbols, content: kind })),
			knowledge: {
				answers: counts.total,
				...(stale === undefined ? {} : { stale }),
				...(doubted === 0 ? {} : { doubted }),
			},
		};
	}

	////////////////////////////////
	//  Literals

	////////////////////////////////
	//  Graph

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
	async coChangedWith(module: string, limit = 20): Promise<CoChangedWithResult> {
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
	async fileHistory(module: string): Promise<FileHistory> {
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
	async commitsMentioning(name: string, limit = DEFAULT_MENTION_LIMIT): Promise<CommitsMentioningResult> {
		return this.cache.through(`mentions ${name} ${limit}`, async () => {
			const commits = await readHistory(this.workspaceRoot);
			const mentions = commitsMentioning(name, commits, limit);
			return { name, mentions, commits: commits.length };
		});
	}

	////////////////////////////////
	//  Type hierarchy

	////////////////////////////////
	//  Facts and citations

	////////////////////////////////
	//  The knowledge layer

	/** A reference's binding, for a caller holding a position rather than an id. */
	async bind(module: string, name: string, range: { start: { line: number; character: number } }): Promise<Binding> {
		return this.supervisor.ask(module, "bind", {
			module,
			name,
			range: { start: range.start, end: range.start },
		});
	}

	/**
	 * Perform a rename, or explain why it did not happen. Nothing is written unless all of it can be.
	 */
	async renameSymbol(symbolId: string, newName: string): Promise<RenameOutcome> {
		const planned = await this.renameEdits(symbolId, newName);
		if (!planned.ok) return { renamed: false, plan: planned.plan, reason: planned.reason };
		const { plan, files } = planned;

		const written = writeAll(this.workspaceRoot, files, this.readFile);
		if (!written.applied) {
			return { renamed: false, plan, reason: writeFailed(written.module, written.reason) };
		}

		// Re-indexed immediately, since every edited file's facts are now wrong and a rename is
		// usually followed by another question about the same symbols.
		for (const module of written.modules) {
			if (this.readFile(module) !== null) await this.indexFile(module);
		}
		return { renamed: true, plan, modules: written.modules };
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
			const unknown: UnknownType = {
				status: "unknown",
				reason: "NotIndexed",
				detail: subjectRefused(symbolId, this.store),
			};
			return unknown;
		}
		const providerFailure = this.indexer.providerFailureOf(declaration.module);
		if (providerFailure !== null)
			return { status: "unknown", reason: "ProviderUnavailable", detail: providerFailure };
		return this.supervisor.ask(declaration.module, "typeOf", { symbolId });
	}
}
