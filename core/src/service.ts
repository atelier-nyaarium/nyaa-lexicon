// Composition root. Owns the wiring, delegates the rest.
//
// Each owner is handed a narrow port rather than the supervisor, and a residue test holds it there.
// The methods below are pass-throughs on purpose.

import {
	type Binding,
	type CacheStats,
	type CoChangedWithResult,
	type CommitsMentioningResult,
	type FileEdits,
	type FileHistory,
	type ImportEditsRequest,
	type ImportEditsResponse,
	type ImportResolution,
	type ModuleFactsResult,
	type MostReferencedResult,
	type OverviewResult,
	type ParseFactsResult,
	parseSymbolId,
	type ResolutionMode,
	type SharedLiteralsResult,
	type StoredImport,
	type SymbolAtReply,
	type SymbolEdges,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import { stageAll } from "./applyEdits.js";
import { ArrangePlanner } from "./arrangePlanner.js";
import { type Clock, systemClock } from "./clock.js";
import { withinBudget } from "./deadline.js";
import { describedOf, loadCycleOf } from "./describeLoadCycle.js";
import { bindsModule, type NamespaceTarget, namespaceTargetOf, sameTarget } from "./edges.js";
import { describeScope, type FileScope, isExternalModule, readScopeConfig } from "./fileScope.js";
import { runFix, runFixText } from "./fixOnWrite.js";
import {
	CoChangeIndex,
	type Commit,
	coChangesFor,
	commitsMentioning,
	DEFAULT_DEPTH,
	DEFAULT_MENTION_LIMIT,
	fileHistoryFor,
	presentIn,
	readHistory,
} from "./history.js";
import { ImportResolver } from "./imports.js";
import { type Doing, type IndexCaches, WorkspaceIndexer } from "./indexer.js";
import {
	type CallHierarchy,
	type CommentsResult,
	DEFAULT_REFERENCE_LIMIT,
	type DescribeResult,
	type DocsResult,
	IndexReadModel,
	type LiteralsResult,
	type ReferencesResult,
	type SymbolSummary,
	type TypeHierarchy,
} from "./indexReads.js";
import { LoadCycleRead } from "./loadCycles.js";
import { NoteLedger } from "./notes.js";
import { PaintReads } from "./paintFacts.js";
import type { ProviderPort } from "./providerPort.js";
import { liveProbe, type ProviderProbe } from "./providerProbe.js";
import { ReadContext } from "./readContext.js";
import { RefactorPlanner } from "./refactorPlanner.js";
import type { PlannedWrite } from "./refactorStep.js";
import type { UnknownType } from "./refusalSlots.js";
import { diagnoseSubject, type Refusal, type SubjectDiagnosis, subjectRefused, writeFailed } from "./refusals.js";
import { RelationDiscovery } from "./relationDiscovery.js";
import { RelationLedger } from "./relations.js";
import { holdsWord } from "./renameRoutes.js";
import { RESOLUTION_CAPACITY, ResultCache } from "./resultCache.js";
import type { SourceReader } from "./sourceRead.js";
import { SourceWorkspace, type SymbolSource } from "./sourceWorkspace.js";
import type { Gate } from "./stepRunners.js";
import { type IndexStore, resolutionKey, type StoredComment, type StoredDeclaration } from "./store.js";
import { WorkspaceGate } from "./workspaceGate.js";

////////////////////////////////
//  Constants

/** How long a tree-first answer waits on its priority parse before serving outline facts. */
const ENSURE_TREE_BUDGET_MS = 60_000;

/** How long an edges read waits on namespace imports resolving. */
const NAMESPACE_BUDGET_MS = 2_000;

/** A reporting cap, not a correctness one. Says so in the output when it bites. */
const COMMENT_COUNT_SCAN = 200_000;

/** Entry list reporting cap. */
const ENTRY_POINTS_SHOWN = 50;

/** History cache lifetime in milliseconds. */
const HISTORY_FRESH_MS = 5 * 60 * 1000;

////////////////////////////////
//  Interfaces & Types

////////////////////////////////
////////////////////////////////
//  Class

export class LexiconService {
	constructor(
		private readonly store: IndexStore,
		private readonly supervisor: ProviderPort,
		private readonly readSource: SourceReader,
		private readonly workspaceRoot = ".",
		private readonly clock: Clock = systemClock,
	) {
		this.gate = new WorkspaceGate(clock);
		this.reads = new IndexReadModel(store);
		this.loadCycles = new LoadCycleRead(store, supervisor, clock, this.gate);
		// Caching and surface globs are workspace decisions, so they are answered here.
		this.imports = new ImportResolver(store, async (fromModule, specifier, mode, fresh) => {
			const surfaceGlobs = (await this.currentScope()).bundles;
			const ask = () =>
				this.supervisor.ask(fromModule, "resolveImport", {
					fromModule,
					specifier,
					...(surfaceGlobs.length === 0 ? {} : { surfaceGlobs }),
					...(mode === undefined ? {} : { resolutionMode: mode }),
				});
			if (fresh === true) return ask();
			const configKey = surfaceGlobs.join("\u0000");
			return this.caches.resolutions.through(
				`resolveImport ${fromModule} ${resolutionKey(specifier, mode)} ${configKey}`,
				ask,
			);
		});
		this.notes = new NoteLedger(store, this.clock);
		this.relations = new RelationLedger(store, this.clock);
		this.discovery = new RelationDiscovery(store, this.clock);
		// An arrow, not the resolver itself: its own port reads the scope back off this indexer.
		this.indexer = new WorkspaceIndexer(
			store,
			supervisor,
			readSource,
			workspaceRoot,
			this.caches,
			(from, specifier, mode) => this.imports.resolveImport(from, specifier, mode),
			this.clock,
			this.gate,
		);
		this.source = new SourceWorkspace(store, readSource, workspaceRoot);
		this.probe = liveProbe(supervisor);
		this.planner = new RefactorPlanner(store, this.imports, this.source, this.probe);
		this.arranger = new ArrangePlanner(store, this.imports, this.source, this.probe, this.planner, (module, text) =>
			this.formatText(module, text),
		);
		this.paint = new PaintReads(store, this.probe, () => this.caches.facts.stats().generation);
	}

	private readonly caches: IndexCaches = {
		facts: new ResultCache(),
		resolutions: new ResultCache(RESOLUTION_CAPACITY),
	};

	/**
	 * The one gate over this workspace, built here so nothing can hand a second one in.
	 *
	 * The indexer's own roads take it per file; the dispatcher and the live index read it from
	 * here rather than being given one, since two gates order nothing.
	 */
	readonly gate: WorkspaceGate;

	/** The only writer of the index. */
	readonly indexer: WorkspaceIndexer;

	/** The text on disk, which the index is checked against. */
	readonly source: SourceWorkspace;

	/** Less than the supervisor offers, on purpose. */
	readonly probe: ProviderProbe;

	/** Plans; journaled steps write. */
	readonly planner: RefactorPlanner;

	/** Plans arrangements; a journaled step writes them. */
	readonly arranger: ArrangePlanner;

	/** Paint facts, stored or freshly parsed. */
	readonly paint: PaintReads;

	/** Public so a read-only caller can take this and reach nothing else. */
	readonly reads: IndexReadModel;

	readonly loadCycles: LoadCycleRead;

	readonly imports: ImportResolver;

	readonly notes: NoteLedger;

	readonly relations: RelationLedger;

	readonly discovery: RelationDiscovery;

	/** Cached history read shared by relation queries until it expires. */
	private history: { at: number; commits: Promise<Commit[]>; index: Promise<CoChangeIndex | null> } | null = null;

	/** Hit and miss counts, so a claim that the cache helps is checkable rather than asserted. */
	cacheStats(): CacheStats {
		return this.caches.facts.stats();
	}

	/** The other cache's own counts, for a test that asks whether a batch re-resolved anything. */
	resolutionStats(): CacheStats {
		return this.caches.resolutions.stats();
	}

	////////////////////////////////
	//  Indexing, answered by WorkspaceIndexer
	//
	//  Two classes, and a caller has to know which it is holding. `indexFile` and `applyBatch` are
	//  caller-held. The scan, the upgrade and the tree-first shortcut drive their own loops and take
	//  the gate per file, so calling one from inside a hold deadlocks.

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

	markDiscovering(): void {
		this.indexer.markDiscovering();
	}

	watchScope(): ReturnType<WorkspaceIndexer["watchScope"]> {
		return this.indexer.watchScope();
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

	admittedModules(modules: string[]): ReturnType<WorkspaceIndexer["admittedModules"]> {
		return this.indexer.admittedModules(modules);
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

	/** Owes each module a parse that outlives a crash, until one lands. */
	oweParses(modules: readonly string[]): void {
		this.store.oweRebinds(modules);
	}

	/** Starts paying owed parses. */
	payOwed(): void {
		this.indexer.payOwed();
	}

	/** Runs `work` as work a status answer names, such as a refactor step. */
	during<T>(doing: Doing, work: () => Promise<T>): Promise<T> {
		return this.indexer.during(doing, work);
	}

	/** Upgrades a symbol's module and direct imports before graph queries. */
	async ensureTreeFor(symbolId: string): Promise<void> {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null) return;
		await this.ensureTreeForModule(parsed.module);
	}

	async ensureTreeForModule(module: string): Promise<void> {
		if (this.store.depthTotals().outline === 0) return;
		const work = (async () => {
			const closure = new Set([module]);
			for (const statement of this.store.importsIn(module)) {
				if (closure.size > 32) break;
				const landed = await this.resolveImport(module, statement.specifier, statement.resolutionMode).catch(
					() => null,
				);
				if (landed?.status === "resolved" && landed.landing.kind === "module")
					closure.add(landed.landing.module);
			}
			await this.indexer.requestFull([...closure]).catch(() => {});
		})();
		await withinBudget(this.clock, work, ENSURE_TREE_BUDGET_MS);
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

	/** Modules owing a parse a failure holds back: each one read, and any other whose text spells `name`. */
	heldDebts(read: readonly string[], name: string): string[] {
		const asked = new Set(read);
		return this.store
			.blockedRebinds()
			.flatMap((debt) => {
				if (asked.has(debt.module)) return [debt.module];
				const text = this.source.currentText(debt.module);
				return text !== null && holdsWord(text, name) ? [debt.module] : [];
			})
			.sort();
	}

	factsMoved(...args: Parameters<RefactorPlanner["factsMoved"]>): ReturnType<RefactorPlanner["factsMoved"]> {
		return this.planner.factsMoved(...args);
	}

	rebaseIntoModule(
		...args: Parameters<RefactorPlanner["rebaseIntoModule"]>
	): ReturnType<RefactorPlanner["rebaseIntoModule"]> {
		return this.planner.rebaseIntoModule(...args);
	}

	/** False on base mismatch. */
	writeModule(module: string, text: string, base: string | null): boolean {
		return this.source.writeModule(module, text, base);
	}

	/** Runs `lexicon.json`'s `fix` on written modules; `failed` says how a run that did not exit cleanly went. */
	async fixWritten(modules: string[]): Promise<{ ran: boolean; failed: string | null }> {
		const argv = readScopeConfig(this.workspaceRoot).fix;
		if (argv === undefined || modules.length === 0) return { ran: false, failed: null };
		return { ran: true, failed: await runFix(this.workspaceRoot, argv, modules) };
	}

	/** Runs `lexicon.json`'s `fixText` on one file's text; null when it is not set. */
	async formatText(module: string, text: string): Promise<{ text: string } | { failed: string } | null> {
		const argv = readScopeConfig(this.workspaceRoot).fixText;
		return argv === undefined ? null : runFixText(this.workspaceRoot, argv, module, text);
	}

	////////////////////////////////
	//  Refactor plans, answered by RefactorPlanner

	/** One context, so a rename or move step's several planning reads share what it stamped. */
	newReadContext(): ReadContext {
		return new ReadContext(this.store);
	}

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

	planWholeReplacement(
		...args: Parameters<RefactorPlanner["planWholeReplacement"]>
	): ReturnType<RefactorPlanner["planWholeReplacement"]> {
		return this.planner.planWholeReplacement(...args);
	}

	prepareRename(...args: Parameters<RefactorPlanner["prepareRename"]>): ReturnType<RefactorPlanner["prepareRename"]> {
		return this.planner.prepareRename(...args);
	}

	renameEdits(...args: Parameters<RefactorPlanner["renameEdits"]>): ReturnType<RefactorPlanner["renameEdits"]> {
		return this.planner.renameEdits(...args);
	}

	planRenameEdits(
		...args: Parameters<RefactorPlanner["planRenameEdits"]>
	): ReturnType<RefactorPlanner["planRenameEdits"]> {
		return this.planner.planRenameEdits(...args);
	}

	landingsMoved(...args: Parameters<RefactorPlanner["landingsMoved"]>): ReturnType<RefactorPlanner["landingsMoved"]> {
		return this.planner.landingsMoved(...args);
	}

	moveEdits(...args: Parameters<RefactorPlanner["moveEdits"]>): ReturnType<RefactorPlanner["moveEdits"]> {
		return this.planner.moveEdits(...args);
	}

	planArrange(...args: Parameters<ArrangePlanner["plan"]>): ReturnType<ArrangePlanner["plan"]> {
		return this.arranger.plan(...args);
	}

	arrangedFiles(...args: Parameters<ArrangePlanner["files"]>): ReturnType<ArrangePlanner["files"]> {
		return this.arranger.files(...args);
	}

	notLanded(...args: Parameters<ArrangePlanner["notLanded"]>): ReturnType<ArrangePlanner["notLanded"]> {
		return this.arranger.notLanded(...args);
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

	/** Computes the scope if nothing has yet, so a caller that must precede the live index can await it. */
	currentScope(): Promise<FileScope> {
		return this.indexer.currentScope();
	}

	////////////////////////////////
	//  Paint, answered by PaintReads

	moduleFacts(module: string): ModuleFactsResult {
		return this.paint.moduleFacts(module);
	}

	parseFacts(module: string, text: string): Promise<ParseFactsResult> {
		return this.paint.parseFacts(module, text);
	}

	symbolAt(request: Parameters<PaintReads["symbolAt"]>[0]): Promise<SymbolAtReply> {
		return this.paint.symbolAt(request);
	}

	////////////////////////////////
	//  Imports, planned by the module's provider

	/** One import planned against `text`; nothing is written. A provider failure throws. Caller holds the read gate. */
	async previewImport(request: ImportEditsRequest): Promise<ImportEditsResponse> {
		const owner = this.probe.owner(request.module);
		if (!owner.owned) {
			return {
				status: "refused",
				reason: "NotImplemented",
				detail: `no provider owns the module: ${owner.reason}`,
			};
		}
		return await this.probe.importEdits(request.module, request);
	}

	////////////////////////////////
	//  Index reads, answered by IndexReadModel

	findByName(name: string, module?: string): SymbolSummary[] {
		return this.reads.findByName(name, module);
	}

	describe(symbolId: string): DescribeResult | null {
		return this.reads.describe(symbolId);
	}

	scopeSymbols(...args: Parameters<IndexReadModel["scopeSymbols"]>): ReturnType<IndexReadModel["scopeSymbols"]> {
		return this.reads.scopeSymbols(...args);
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

	findReferences(
		symbolId: string,
		limit = DEFAULT_REFERENCE_LIMIT,
		within?: string,
		module?: string,
	): ReferencesResult {
		return this.reads.findReferences(symbolId, limit, within, module);
	}

	usesFrom(...args: Parameters<IndexReadModel["usesFrom"]>): ReturnType<IndexReadModel["usesFrom"]> {
		return this.reads.usesFrom(...args);
	}

	findLiterals(...args: Parameters<IndexReadModel["findLiterals"]>): LiteralsResult {
		return this.reads.findLiterals(...args);
	}

	sharedLiterals(...args: Parameters<IndexReadModel["sharedLiterals"]>): SharedLiteralsResult {
		return this.reads.sharedLiterals(...args);
	}

	findDocs(...args: Parameters<IndexReadModel["findDocs"]>): DocsResult {
		return this.reads.findDocs(...args);
	}

	findComments(...args: Parameters<IndexReadModel["findComments"]>): CommentsResult {
		return this.reads.findComments(...args);
	}

	moduleCycles(...args: Parameters<LoadCycleRead["moduleCycles"]>): ReturnType<LoadCycleRead["moduleCycles"]> {
		return this.loadCycles.moduleCycles(...args);
	}

	moduleProblems(...args: Parameters<LoadCycleRead["moduleProblems"]>): ReturnType<LoadCycleRead["moduleProblems"]> {
		return this.loadCycles.moduleProblems(...args);
	}

	/** `described` with its part in a load-order cycle, when it plays one; `gate` is the asking request's. */
	async withLoadCycle(described: DescribeResult, gate: Gate): Promise<DescribeResult> {
		const symbol = await gate.read(() =>
			describedOf(described.symbol.symbolId, (symbolId) => this.reads.declarationOf(symbolId)),
		);
		if (symbol === null) return described;
		const loadCycle = await loadCycleOf(
			symbol,
			await this.loadCycles.componentOf(symbol.module, gate),
			() => this.loadCycles.moduleCycles({ module: symbol.module, limit: 1 }, gate),
			this.clock,
		);
		return loadCycle === undefined ? described : { ...described, loadCycle };
	}

	typeHierarchy(symbolId: string, maxDepth = 16): TypeHierarchy {
		return this.reads.typeHierarchy(symbolId, maxDepth);
	}

	callHierarchy(symbolId: string): CallHierarchy {
		return this.reads.callHierarchy(symbolId);
	}

	/** Resolve namespace imports through providers. */
	async symbolEdges(symbolId: string, limit?: number): Promise<SymbolEdges> {
		const declaration = this.store.declaration(symbolId);
		const byLocal = new Map<string, StoredImport[]>();
		for (const statement of declaration === null ? [] : this.store.importsIn(declaration.module)) {
			if (statement.local === undefined || !bindsModule(statement)) continue;
			byLocal.set(statement.local, [...(byLocal.get(statement.local) ?? []), statement]);
		}
		const namespaces = new Map<string, NamespaceTarget>();
		const work = Promise.all(
			[...byLocal].map(async ([local, statements]) => {
				const targets = await Promise.all(statements.map((statement) => this.namespaceTarget(statement)));
				// Imports that disagree name neither.
				const [first] = targets;
				if (first && targets.every((target) => target !== null && sameTarget(target, first))) {
					namespaces.set(local, first);
				}
			}),
		);
		// A slow provider leaves names unresolved.
		await withinBudget(this.clock, work, NAMESPACE_BUDGET_MS);
		return this.reads.symbolEdges(symbolId, new Map(namespaces), limit);
	}

	private async namespaceTarget(statement: StoredImport): Promise<NamespaceTarget | null> {
		return namespaceTargetOf(
			await this.resolveImport(statement.module, statement.specifier, statement.resolutionMode).catch(() => null),
		);
	}

	mostReferenced(limit = 20): MostReferencedResult {
		return this.reads.mostReferenced(limit);
	}

	////////////////////////////////
	//  Imports, answered by ImportResolver

	resolveImport(fromModule: string, specifier: string, mode?: ResolutionMode): Promise<ImportResolution> {
		return this.imports.resolveImport(fromModule, specifier, mode);
	}

	findImports(...args: Parameters<ImportResolver["findImports"]>): ReturnType<ImportResolver["findImports"]> {
		return this.imports.findImports(...args);
	}

	////////////////////////////////
	//  Subjects

	/** Why an id names no declaration, as every tool answers it. */
	diagnoseSubject(symbolId: string): SubjectDiagnosis {
		return diagnoseSubject(symbolId, this.store);
	}

	////////////////////////////////
	//  Notes, answered by NoteLedger

	readNote(...args: Parameters<NoteLedger["read"]>): ReturnType<NoteLedger["read"]> {
		return this.notes.read(...args);
	}

	writeNote(...args: Parameters<NoteLedger["write"]>): ReturnType<NoteLedger["write"]> {
		return this.notes.write(...args);
	}

	confirmNote(...args: Parameters<NoteLedger["confirm"]>): ReturnType<NoteLedger["confirm"]> {
		return this.notes.confirm(...args);
	}

	doubtNote(...args: Parameters<NoteLedger["doubt"]>): ReturnType<NoteLedger["doubt"]> {
		return this.notes.doubt(...args);
	}

	resolveNoteProposal(...args: Parameters<NoteLedger["resolveProposal"]>): ReturnType<NoteLedger["resolveProposal"]> {
		return this.notes.resolveProposal(...args);
	}

	noteBacklinks(...args: Parameters<NoteLedger["backlinks"]>): ReturnType<NoteLedger["backlinks"]> {
		return this.notes.backlinks(...args);
	}

	searchRefs(...args: Parameters<NoteLedger["searchRefs"]>): ReturnType<NoteLedger["searchRefs"]> {
		return this.notes.searchRefs(...args);
	}

	////////////////////////////////
	//  Indexing

	/** How the file set was decided, so a caller never confuses 350 files with 136,000. */
	async scopeReport(): Promise<string> {
		return describeScope(await this.indexer.currentScope());
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
	async overview(topModules = 15, topData = 5): Promise<OverviewResult> {
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

		const scan = this.store.readScanSummary();
		// A document's headings are symbols and belong in the total, but a reader taking that total
		// for callable code reads it wrong the moment one is indexed, so the split rides alongside.
		const byKind = this.store.symbolsByKind();
		const entries = this.store.entryPoints(includeModule, ENTRY_POINTS_SHOWN);
		return {
			...totals,
			content,
			symbolsByKind: byKind,
			scope: await this.scopeReport(),
			index: this.indexStatus(),
			...(scan === null ? {} : { scan }),
			parseFailures: this.store.parseFailures(),
			notes: this.store.noteTotals(),
			modules: modules.length,
			largest: code.slice(0, topModules).map(({ module, symbols }) => ({ module, symbols })),
			largestData: data
				.slice(0, topData)
				.map(({ module, symbols, content: kind }) => ({ module, symbols, content: kind })),
			...(entries === null ? {} : { entryPoints: entries.entries }),
			...(entries === null || entries.more === 0 ? {} : { moreEntryPoints: entries.more }),
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
		return this.caches.facts.through(`coChange ${module} ${limit}`, async () => {
			const commits = await readHistory(this.workspaceRoot, DEFAULT_DEPTH, this.clock);
			const { partners, report } = coChangesFor(module, commits, undefined, presentIn(this.workspaceRoot));
			return { module, partners: partners.slice(0, limit), total: partners.length, ...report };
		});
	}

	/** Co-change index, or null when the workspace has no readable history. */
	relationHistory(): Promise<CoChangeIndex | null> {
		return this.historyRead().index;
	}

	/** Distinct files touched by the newest commits, in encounter order. */
	async recentlyChanged(commits: number): Promise<string[]> {
		return CoChangeIndex.recentFiles(await this.historyRead().commits, commits);
	}

	private historyRead(): { commits: Promise<Commit[]>; index: Promise<CoChangeIndex | null> } {
		const now = this.clock.now();
		if (this.history === null || now - this.history.at > HISTORY_FRESH_MS) {
			const commits = readHistory(this.workspaceRoot, DEFAULT_DEPTH, this.clock);
			this.history = {
				at: now,
				commits,
				index: commits.then((read) => (read.length === 0 ? null : new CoChangeIndex(read))),
			};
		}
		return this.history;
	}

	/**
	 * History for one file, from the same commits co-change reads.
	 *
	 * Cached alongside co-change and keyed separately, since a caller usually wants one or the other.
	 */
	async fileHistory(module: string): Promise<FileHistory> {
		return this.caches.facts.through(`fileHistory ${module}`, async () =>
			fileHistoryFor(module, await readHistory(this.workspaceRoot, DEFAULT_DEPTH, this.clock)),
		);
	}

	/**
	 * Commits whose message names this symbol.
	 *
	 * The one tier-1 fact that carries RATIONALE rather than structure. Every other class says what
	 * the code is or who touches it; a commit message is the only place someone wrote down why.
	 */
	async commitsMentioning(name: string, limit = DEFAULT_MENTION_LIMIT): Promise<CommitsMentioningResult> {
		return this.caches.facts.through(`mentions ${name} ${limit}`, async () => {
			const commits = await readHistory(this.workspaceRoot, DEFAULT_DEPTH, this.clock);
			const mentions = commitsMentioning(name, commits, limit);
			return { name, mentions, commits: commits.length };
		});
	}

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

	/** Unwritten rename texts with edit bases. */
	renameWrites(files: FileEdits[]): { writes: PlannedWrite[] } | { reason: Refusal } {
		const staged = stageAll(files, this.readSource);
		if (!("staged" in staged)) return { reason: writeFailed(staged.module, staged.reason) };
		const bases = new Map(files.map((file) => [file.module, file.contentHash]));
		return { writes: staged.staged.map(({ module, text }) => ({ module, base: bases.get(module) ?? null, text })) };
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
