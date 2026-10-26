// Getting facts in, and the only module that changes what the index holds.
//
// Two writers race and the loser leaves a plausible-looking index, so a residue test holds this as
// the only one. Reaches wide on purpose: indexing IS reading files and asking providers.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type {
	AdmissionCause,
	AdmittedModule,
	Import,
	ImportResolution,
	IndexActivity,
	IndexCause,
	IndexDepth,
	IndexOutcome,
	IndexStatus,
	ModuleAdmission,
	ModuleDeclarations,
	ModuleSecretModeAnswer,
	ModuleSecretModeValue,
	ModuleStatus,
	ModuleView,
	Range,
	ResolutionMode,
} from "@nyaa-lexicon/protocol";
import {
	coordinatesOf,
	DEFAULT_EXCLUDED_DIRECTORIES,
	defined,
	normalizeModulePath,
	resolveContained,
} from "@nyaa-lexicon/protocol";
import { directoryEntries, underExcludedDirectory } from "@nyaa-lexicon/protocol/excludedDirectories";
import type { Clock, TimerHandle } from "./clock.js";
import { attachComments } from "./commentAttach.js";
import { FactAdmissionError } from "./factAdmission.js";
import {
	type FileScope,
	type GeneratedVerdict,
	generatedVerdicts,
	gitIgnored,
	includedFiles,
	type SourceInventory,
	searchFiles,
} from "./fileScope.js";
import { importTarget } from "./imports.js";
import {
	ensurePumping as coordinateEnsurePumping,
	payOwed as coordinatePayOwed,
	pump as coordinatePump,
	pumpTurns as coordinatePumpTurns,
	rebindStep as coordinateRebindStep,
	recover as coordinateRecover,
	recoverLater as coordinateRecoverLater,
	requestFull as coordinateRequestFull,
	startRun as coordinateStartRun,
	upgradeOne as coordinateUpgradeOne,
	upgradeRemaining as coordinateUpgradeRemaining,
	type IndexPumpContext,
} from "./indexPump.js";
import type { FileEvent } from "./invalidation.js";
import { decideInvalidation, UNCHANGED_REASON } from "./invalidation.js";
import { type ModuleClaim, moduleDeclarations, statusOf } from "./moduleDeclarations.js";
import { patternDigests } from "./patternDigest.js";
import type { EvidenceKind } from "./policyEvidence.js";
import type { MethodResponse, ProviderPort } from "./providerPort.js";
import {
	type ImporterIndex,
	RESOLVE_RETRY_MS,
	type RebindSchedulerContext,
	dependentsOf as scheduleDependentsOf,
	holdRebind as scheduleHoldRebind,
	importIndex as scheduleImportIndex,
	oweDependents as scheduleOweDependents,
	pendingMoves as schedulePendingMoves,
	processOf as scheduleProcessOf,
	queueRebinds as scheduleQueueRebinds,
	readAfter as scheduleReadAfter,
	readImports as scheduleReadImports,
	readWhole as scheduleReadWhole,
	rebindable as scheduleRebindable,
	rebindDependents as scheduleRebindDependents,
	rebindOne as scheduleRebindOne,
	retryResolving as scheduleRetryResolving,
	settle as scheduleSettle,
	settleProjections as scheduleSettleProjections,
	UNREAD,
} from "./rebindScheduler.js";
import type { ResultCache } from "./resultCache.js";
import type { Route } from "./routing.js";
import type {
	AdmittedAs,
	ModuleVerdict,
	PolicyAffected,
	PolicyChange,
	ProviderVerdict,
	ReaderVerdict,
	SecretAdmission,
	SecretPolicy,
	UnparsedVerdict,
} from "./secretPolicy.js";
import {
	DENIED_BY_SCOPE_REASON,
	hashOfView,
	insideWorkspace,
	MAX_SOURCE_BYTES,
	OUTSIDE_WORKSPACE_REASON,
	readHead,
	type SealedRead,
	type SealedText,
	type SourceReader,
	sourceReadBytes,
	unreadableReason,
} from "./sourceRead.js";
import { BatchFailed, type FileNote, type IndexStore, resolutionKey, type SurfaceChange } from "./store.js";
import type { ModulePresence, SweepReport } from "./subjects.js";
import { ProviderUnavailableError } from "./supervisor.js";
import type { WatchScope } from "./watcher.js";
import type { WorkspaceGate } from "./workspaceGate.js";
import {
	scanWorkspace as coordinateScanWorkspace,
	runWorkspaceScan as coordinateWorkspaceScan,
	type WorkspaceScanContext,
} from "./workspaceScan.js";

export type { IndexOutcome, IndexStatus } from "@nyaa-lexicon/protocol";
export { REBIND_CAP, RESOLVE_RETRY_MS, UNREAD } from "./rebindScheduler.js";

////////////////////////////////
//  Interfaces & Types

/** Parts sum to `tracked`. */
export interface ScanBreakdown {
	tracked: number;
	claimed: number;
	unclaimed: number;
	generated: number;
	denied: number;
}

type WarmCoverage =
	| { state: "idle" }
	| { state: "discovering" }
	| { state: "outlining"; pending: Set<string>; attempting: Set<string> }
	| { state: "covered" }
	| { state: "failed"; reason: string };

function scopeWithObserved(scope: FileScope, observed: ReadonlySet<string>): FileScope {
	const admitted = new Set([...observed].filter((module) => scope.admitsEvent(module)));
	const known = scope.known === null ? null : new Set([...scope.known, ...admitted]);
	return {
		...scope,
		known,
		allows: (module) => scope.allows(module) || admitted.has(module),
	};
}

function mergeAffected(current: PolicyAffected | null, next: PolicyAffected): PolicyAffected {
	if (current === "all" || next === "all") return "all";
	if (current === null) return next;
	return {
		modules: new Set([...current.modules, ...next.modules]),
		prefixes: [...new Set([...current.prefixes, ...next.prefixes])].sort(),
	};
}

/** The indexer's own failure, in one wording, so the record and the verdict read alike. */
function indexerFault(error: unknown): string {
	return `the indexer failed on this file: ${error instanceof Error ? error.message : String(error)}`;
}

/** A piece of work a status answer names while it runs. Counts are read when asked. */
export interface Doing {
	kind: IndexActivity["kind"];
	label?: string;
	counts?: () => { done: number; total: number };
}

/** How many parses beyond its own files a batch makes before a status names them. */
const REPARSES_NAMED = 10;

/** Why a provider hears a parse refused that the index wrote, then lost with its batch. */
const LOST_BATCH_REASON = "the index lost the batch holding this parse; it is parsed again";

/** Why a claimed module under its provider's declared excluded directories is not indexed. */
const EXCLUDED_DIRECTORY_REASON = "under a directory its provider excludes";

/** Of overlapping works, the one a status names first: each holds or waits out those after it. */
const ACTIVITY_ORDER: ReadonlyArray<IndexActivity["kind"]> = ["refactor", "batch", "scan", "rebind", "upgrade"];
const MAX_MODULE_SECRET_MODE_TEXT_BYTES = 8 * 1024 * 1024;

export interface ModuleSecretModeInput {
	module: string;
	text?: string | undefined;
}

export type ModuleSecretModeRequest = string | ModuleSecretModeInput;

/** The depth a pass ends at: an outline floor is a first read the pump carries to full. */
function settledDepth(depth: IndexDepth | undefined): IndexDepth | undefined {
	return depth === "outline" ? "full" : depth;
}

function secretModeOf(as: AdmittedAs): ModuleSecretModeValue {
	switch (as) {
		case "plain":
			return "plain";
		case "keys":
		case "masked":
		case "withheld":
			return "redact";
		case "omit":
			return "omit";
	}
}

/** A synchronous scope read reached before any admission ever ran. A caller ordering bug, not a user's. */
export class ScopeNotComputedError extends Error {
	constructor() {
		super("the workspace scope has not been computed yet; call currentScope() before reading it synchronously");
	}
}

/** How many failed files an answer names; `overview` lists every one. */
export const NAMED_FAILURES = 3;

/** Subjects one sweep examines across both passes; a capped sweep resumes from its cursor. */
export const ORPHAN_SWEEP_CAP = 200;

/**
 * Two questions with two lifetimes: a cached query result dies the moment any fact moves; where a
 * specifier lands survives body edits, and moves only when the module set or a provider's config does.
 */
export interface IndexCaches {
	facts: ResultCache;
	resolutions: ResultCache;
}

/** The process that answered a parse: its id, and which spawn of it. */
interface Parser {
	providerId: string;
	incarnation: number | null;
}

/** The scope's verdict on the tracked set, each a subset of the one before. */
interface Admitted {
	everything: string[];
	candidates: string[];
	reachable: string[];
}

/**
 * How one file's read, parse and commit is held.
 *
 * `alone` for a road this indexer drives itself, identity for one a caller already holds the gate
 * for. Named at every reachable call site, so a new road has to answer the question.
 */
type Step = <T>(work: () => Promise<T>) => Promise<T>;

/** Already exclusive: the caller took the gate around a unit larger than one file. */
const held: Step = (work) => work();

/** What `followImports` needs beyond the frontier, so no positional default decides the gate. */
interface ImportWalk {
	/** False skips a reached module whose stored facts already sit at the depth this walk wants. */
	indexExisting: boolean;
	previousDepths?: ReadonlyMap<string, IndexDepth>;
	floor?: "full" | "outline";
	step: Step;
	/** Runs after each module the walk parses, before the next parse. */
	reached?: (module: string) => Promise<void>;
}

////////////////////////////////
//  Class

/** Owns what a scan accumulates: discovered files, roots, depths, progress. */
export class WorkspaceIndexer {
	constructor(
		private readonly store: IndexStore,
		private readonly supervisor: ProviderPort,
		private readonly readSource: SourceReader,
		private readonly workspaceRoot: string,
		private readonly caches: IndexCaches,
		/** Resolution belongs to the import resolver; the indexer only follows where it points. */
		private readonly resolve: (
			fromModule: string,
			specifier: string,
			mode: ResolutionMode | undefined,
		) => Promise<ImportResolution>,
		private readonly clock: Clock,
		/** The service's one gate. Every road this indexer drives itself takes it, one file at a time. */
		private readonly gate: WorkspaceGate,
		private readonly secretPolicy: SecretPolicy,
	) {
		// A route asked before the first scan still sees the workspace, from whatever admission last
		// completed: evidenceFrom is synchronous, and admission now asks git asynchronously.
		supervisor.evidenceFrom(() => this.lastAdmitted?.reachable ?? []);
		supervisor.headFrom((module) => readHead(this.workspaceRoot, module));
		// A provider process starting again may answer what its predecessor failed or refused.
		supervisor.respawnedFrom(() => this.queueRebinds());
		supervisor.policyInvalidatedFrom((_providerId, modules) => this.queueProviderInvalidations(modules));
		this.entries = directoryEntries(workspaceRoot);
		// Collaborators share a live view; this class retains ownership of the state.
		this.workspaceScanContext = this.createWorkspaceScanContext();
		this.pumpContext = this.createPumpContext();
		this.rebindContext = this.createRebindContext();
	}

	private createWorkspaceScanContext(): WorkspaceScanContext {
		const owner = this;
		return {
			get store() {
				return owner.store;
			},
			get supervisor() {
				return owner.supervisor;
			},
			get caches() {
				return owner.caches;
			},
			get newInPass() {
				return owner.newInPass;
			},
			set newInPass(value) {
				owner.newInPass = value;
			},
			get status() {
				return owner.status;
			},
			set status(value) {
				owner.status = value;
			},
			get coverage() {
				return owner.coverage;
			},
			set coverage(value) {
				owner.coverage = value;
			},
			get discovered() {
				return owner.discovered;
			},
			get configFiles() {
				return owner.configFiles;
			},
			set configFiles(value) {
				owner.configFiles = value;
			},
			get restated() {
				return owner.restated;
			},
			set restated(value) {
				owner.restated = value;
			},
			get roots() {
				return owner.roots;
			},
			set roots(value) {
				owner.roots = value;
			},
			get depths() {
				return owner.depths;
			},
			set depths(value) {
				owner.depths = value;
			},
			get generated() {
				return owner.generated;
			},
			alone: (work) => owner.alone(work),
			pass: (work) => owner.pass(work),
			discoveryScope: () => owner.discoveryScope(),
			discover: (providerId, scope) => owner.discover(providerId, scope),
			rootModules: () => owner.rootModules(),
			scanDepth: (module, floor) => owner.scanDepth(module, floor),
			writeScanSummary: (outlined) => owner.writeScanSummary(outlined),
			fileStat: (module) => owner.fileStat(module),
			indexOne: owner.indexOne.bind(owner),
			faultOutcome: (module, error) => owner.faultOutcome(module, error),
			noteReached: (module, firstStats) => owner.noteReached(module, firstStats),
			followImports: (seen, walk) => owner.followImports(seen, walk),
			prune: (seen) => owner.prune(seen),
			sweepAfterPrune: (reachable) => owner.sweepAfterPrune(reachable),
			readAllUnder: (providerId, outcomes, also) => owner.readAllUnder(providerId, outcomes, also),
			pendingMoves: (modules) => owner.pendingMoves(modules),
			oweDependents: (moves, order, stale) => owner.oweDependents(moves, order, stale),
			settle: (moves, owed) => owner.settle(moves, owed),
			queueRebinds: () => owner.queueRebinds(),
			scanWorkspace: (floor, onProgress) => owner.scanWorkspace(floor, onProgress),
		};
	}

	private createPumpContext(): IndexPumpContext {
		const owner = this;
		return {
			get store() {
				return owner.store;
			},
			get clock() {
				return owner.clock;
			},
			get orders() {
				return owner.orders;
			},
			get pumping() {
				return owner.pumping;
			},
			set pumping(value) {
				owner.pumping = value;
			},
			get upgradeWanted() {
				return owner.upgradeWanted;
			},
			set upgradeWanted(value) {
				owner.upgradeWanted = value;
			},
			get unasked() {
				return owner.unasked;
			},
			get rebindQueued() {
				return owner.rebindQueued;
			},
			set rebindQueued(value) {
				owner.rebindQueued = value;
			},
			get recovering() {
				return owner.recovering;
			},
			set recovering(value) {
				owner.recovering = value;
			},
			get recovery() {
				return owner.recovery;
			},
			set recovery(value) {
				owner.recovery = value;
			},
			get losses() {
				return owner.losses;
			},
			set losses(value) {
				owner.losses = value;
			},
			get upgradeFailed() {
				return owner.upgradeFailed;
			},
			get rebindCursor() {
				return owner.rebindCursor;
			},
			set rebindCursor(value) {
				owner.rebindCursor = value;
			},
			get resolvePending() {
				return owner.resolvePending;
			},
			get depths() {
				return owner.depths;
			},
			get scope() {
				return owner.scope;
			},
			get status() {
				return owner.status;
			},
			set status(value) {
				owner.status = value;
			},
			ensurePumping: () => owner.ensurePumping(),
			pump: () => owner.pump(),
			pass: (work) => owner.pass(work),
			startRun: () => owner.startRun(),
			pumpTurns: () => owner.pumpTurns(),
			recoverLater: () => owner.recoverLater(),
			recover: () => owner.recover(),
			during: (doing, work) => owner.during(doing, work),
			upgradeOne: (module) => owner.upgradeOne(module),
			rebindStep: () => owner.rebindStep(),
			processOf: (providerId) => owner.processOf(providerId),
			alone: (work) => owner.alone(work),
			pendingMoves: (modules) => owner.pendingMoves(modules),
			oweDependents: (moves, order) => owner.oweDependents(moves, order),
			rebindOne: (module) => owner.rebindOne(module),
			queueRebinds: () => owner.queueRebinds(),
			currentScope: () => owner.currentScope(),
			currentScopeUnderGate: () => owner.currentScopeUnderGate(),
			indexOne: owner.indexOne.bind(owner),
			faultOutcome: (module, error) => owner.faultOutcome(module, error),
			holdRebind: (module, outcome) => owner.holdRebind(module, outcome),
		};
	}

	private createRebindContext(): RebindSchedulerContext {
		const owner = this;
		return {
			get store() {
				return owner.store;
			},
			get supervisor() {
				return owner.supervisor;
			},
			get caches() {
				return owner.caches;
			},
			get clock() {
				return owner.clock;
			},
			get epoch() {
				return owner.epoch;
			},
			resolve: (fromModule, specifier, mode) => owner.resolve(fromModule, specifier, mode),
			get importers() {
				return owner.importers;
			},
			set importers(value) {
				owner.importers = value;
			},
			get importsWritten() {
				return owner.importsWritten;
			},
			get projected() {
				return owner.projected;
			},
			get resolvePending() {
				return owner.resolvePending;
			},
			get resolveRetry() {
				return owner.resolveRetry;
			},
			set resolveRetry(value) {
				owner.resolveRetry = value;
			},
			get resolveRetryMs() {
				return owner.resolveRetryMs;
			},
			set resolveRetryMs(value) {
				owner.resolveRetryMs = value;
			},
			get rebindQueued() {
				return owner.rebindQueued;
			},
			set rebindQueued(value) {
				owner.rebindQueued = value;
			},
			get depths() {
				return owner.depths;
			},
			get scope() {
				return owner.scope;
			},
			alone: (work) => owner.alone(work),
			ensurePumping: () => owner.ensurePumping(),
			queueRebinds: () => owner.queueRebinds(),
			settleProjections: () => owner.settleProjections(),
			pendingMoves: (modules) => owner.pendingMoves(modules),
			settle: (moves, owed) => owner.settle(moves, owed),
			retryResolving: (moved) => owner.retryResolving(moved),
			holdRebind: (module, outcome) => owner.holdRebind(module, outcome),
			processOf: (providerId) => owner.processOf(providerId),
			rebindDependents: (outcomes, shouldAbandon) => owner.rebindDependents(outcomes, shouldAbandon),
			oweDependents: (moves, order, stale) => owner.oweDependents(moves, order, stale),
			readAfter: (module, moves, order, stale) => owner.readAfter(module, moves, order, stale),
			dependentsOf: (moves) => owner.dependentsOf(moves),
			importIndex: () => owner.importIndex(),
			readWhole: (index) => owner.readWhole(index),
			readImports: (index, module, occurrences) => owner.readImports(index, module, occurrences),
			rebindable: (module) => owner.rebindable(module),
			rebindOne: (module) => owner.rebindOne(module),
			parseAndStore: (module, depth) => owner.parseAndStore(module, depth),
			faultOutcome: (module, error) => owner.faultOutcome(module, error),
			currentScope: () => owner.currentScope(),
			currentScopeUnderGate: () => owner.currentScopeUnderGate(),
			indexOne: owner.indexOne.bind(owner),
		};
	}

	/** What a workspace directory holds, for a marker beside an output directory. Renewed by each admission. */
	private entries: (directory: string) => readonly string[];
	private includeCache: { key: string; files: string[] } | null = null;

	/** What the last prune kept; null until one has run, and the timer's sweep judges nothing before that. */
	private reachable: Set<string> | null = null;
	/** Modules first indexed in the pass in progress: the only rebind targets. */
	private newInPass = new Set<string>();
	private lastSweep: SweepReport | null = null;

	/** Scan progress is process-local; stored counts come from the database. */
	private status: Pick<IndexStatus, "state" | "done" | "total"> = { state: "unstarted", done: 0, total: 0 };
	/** Keeps a restarted daemon's generations apart from this one's. */
	private readonly epoch = randomUUID();
	private scope: FileScope | null = null;
	private baseScope: FileScope | null = null;
	private readonly observedModules = new Set<string>();
	private policyPending = true;
	private pendingAffected: PolicyAffected | null = "all";
	private installedPolicyRevision: string | null = null;
	/** For the synchronous evidence callback alone: as fresh as the last admission, which every create or delete renews. */
	private lastAdmitted: Admitted | null = null;
	/** Each provider's discovered files, replaced whole whenever it states its project again. */
	private discovered = new Map<string, Set<string>>();
	private roots = new Set<string>();
	private readonly sentRoots = new Map<string, { incarnation: number | null; key: string }>();
	private depths = new Map<string, IndexDepth>();

	/** Counts sum to `tracked`. */
	private breakdown: ScanBreakdown | null = null;
	/** Git's word per admitted module, refreshed with the scope. */
	private generated = new Map<string, GeneratedVerdict>();
	/** Each config file a provider said it consults, with who consults it. */
	private configFiles = new Map<string, Set<string>>();
	/** Providers whose project fingerprint moved since their stored facts were parsed. */
	private restated = new Set<string>();
	private coverage: WarmCoverage = { state: "idle" };

	/** Full-parse orders run between background files. */
	private orders: Array<{ modules: string[]; resolve: () => void; reject: (error: unknown) => void }> = [];
	private pumping: Promise<void> | null = null;
	private upgradeWanted = false;
	/** What is running now, for a status answer. */
	private readonly doing = new Set<Doing>();

	/** Modules a single-file road wrote, whose dependents the pump asks after once that road lets go. */
	private readonly unasked = new Set<string>();
	/** Modules whose exports a settlement moved, joined to the next moves a road reads. */
	private readonly projected = new Set<string>();
	/** Debt was owed since the pump last started through it; a run tries each owed module once. */
	private rebindQueued = false;
	private rebindCursor: string | null = null;
	/** Moved modules whose importers a resolver fault left unread; the next run asks again. */
	private readonly resolvePending = new Set<string>();
	/** The armed retry for `resolvePending`, and the wait the next one takes. */
	private resolveRetry: TimerHandle | null = null;
	private resolveRetryMs = RESOLVE_RETRY_MS;
	/** Set when a batch was lost: the pump reads again what the committed store still owes. */
	private recovering = false;
	/** The armed wait before that recovery, and the losses in a row that set its length. */
	private recovery: TimerHandle | null = null;
	private losses = 0;
	/** Who imports each module, by where each import landed, for one resolution generation. */
	private importers: ImporterIndex | null = null;
	/** Modules whose import rows were written since the index last read them. */
	private readonly importsWritten = new Set<string>();
	private readonly providerInvalidations = new Set<string>();
	private providerInvalidationsQueued = false;
	private readonly workspaceScanContext: WorkspaceScanContext;
	private readonly pumpContext: IndexPumpContext;
	private readonly rebindContext: RebindSchedulerContext;

	/**
	 * One step of a self-driven road, alone.
	 *
	 * The read, the parse and the commit are one hold, because a parse of bytes read before another
	 * road committed newer ones regresses the file when it lands. Per step rather than per road: a
	 * scan or an upgrade holding the gate for its whole walk starves every reader for minutes.
	 *
	 * Never reached from inside a hold. The gate is not re-entrant, so that deadlocks;
	 * `index-gate-residue.test.ts` refuses a caller that would.
	 */
	private alone<T>(work: () => Promise<T>): Promise<T> {
		return this.gate.exclusive(work);
	}

	/** Scope for surface glob resolution. */
	async currentScope(): Promise<FileScope> {
		if (this.scope === null) await this.gate.exclusive(() => this.currentScopeUnderGate());
		return this.scopeOrThrow();
	}

	/** Computes missing scope under the workspace gate. */
	async currentScopeUnderGate(): Promise<FileScope> {
		if (this.scope === null) {
			try {
				await this.secretPolicy.refresh({ kind: "startup" });
			} catch (error) {
				this.coverage = { state: "failed", reason: error instanceof Error ? error.message : String(error) };
				throw error;
			}
		}
		return this.scopeOrThrow();
	}

	async auditPolicy(): Promise<void> {
		await this.alone(async () => {
			const previousRevision = this.secretPolicy.current.revision;
			const change = await this.secretPolicy.refresh({ kind: "audit" });
			const affected =
				change.affected === "all" || change.affected.modules.size > 0 || change.affected.prefixes.length > 0;
			if (previousRevision !== change.revision || affected) console.log("secret policy evidence drift");
			this.reconcilePolicy();
		});
	}

	installScope(scope: FileScope, change?: PolicyChange): void {
		this.baseScope = scope;
		const previousRevision = this.installedPolicyRevision;
		this.scope = scopeWithObserved(scope, this.observedModules);
		this.installedPolicyRevision = this.secretPolicy.current.revision;
		this.entries = directoryEntries(this.workspaceRoot);
		if (change !== undefined) {
			this.pendingAffected = mergeAffected(this.pendingAffected, change.affected);
			this.policyPending = true;
			this.invalidateGenerated(change.affected);
			if (change.affected === "all" || change.admissionMoved) this.includeCache = null;
		} else if (previousRevision !== this.installedPolicyRevision) {
			this.pendingAffected = mergeAffected(this.pendingAffected, "all");
			this.policyPending = true;
			this.generated.clear();
		}
	}

	private invalidateGenerated(affected: PolicyAffected): void {
		if (affected === "all") {
			this.generated.clear();
			return;
		}
		const matches = (module: string) =>
			affected.modules.has(module) ||
			affected.prefixes.some((prefix) => prefix === "" || module.startsWith(`${prefix}/`));
		for (const module of this.generated.keys()) if (matches(module)) this.generated.delete(module);
	}

	private invalidateGeneratedAttributes(module: string): void {
		if (module.split("/").at(-1) !== ".gitattributes") return;
		const prefix = module.slice(0, Math.max(0, module.lastIndexOf("/")));
		for (const path of this.generated.keys())
			if (prefix === "" || path === prefix || path.startsWith(`${prefix}/`)) this.generated.delete(path);
	}

	private observeEvents(events: readonly FileEvent[]): void {
		const scope = this.baseScope;
		if (scope === null || scope.mode !== "git") return;
		let moved = false;
		for (const event of events) {
			if (event.kind === "deleted") {
				moved = this.observedModules.delete(event.module) || moved;
			} else if (
				this.store.contentHashOf(event.module) === null &&
				!scope.allows(event.module) &&
				scope.admitsEvent(event.module)
			) {
				const size = this.observedModules.size;
				this.observedModules.add(event.module);
				moved = this.observedModules.size !== size || moved;
			}
		}
		if (moved) this.installScope(scope);
	}

	reconcilePolicy(): string[] {
		if (!this.policyPending || this.pendingAffected === null) return [];
		const affected = this.pendingAffected;
		this.pendingAffected = null;
		this.policyPending = false;
		const stale = new Set(
			this.store
				.policyStampsOf(
					affected === "all" ? [] : [...affected.modules],
					affected === "all" ? [""] : [...affected.prefixes],
				)
				.filter(({ module, stamp }) => stamp !== this.secretPolicy.current.answer(module).stamp)
				.map(({ module }) => module),
		);
		for (const module of stale) this.forgetFile(module, this.secretPolicy.current.admission(module));
		const change = this.secretPolicy.lastChange;
		if (change !== null) this.secretPolicy.policyChanged(change);
		this.store.whenCommitted((committed) => {
			if (committed) return;
			this.pendingAffected = mergeAffected(this.pendingAffected, affected);
			this.policyPending = true;
		});
		return [...stale];
	}

	/**
	 * The scope as a synchronous road may read it: already computed by an earlier `currentScope()`
	 * or a scan, never git asked fresh. Every caller here runs only after that has happened.
	 */
	private scopeOrThrow(): FileScope {
		if (this.scope === null) throw new ScopeNotComputedError();
		return this.scope;
	}

	/** Whether the index reads secret keys itself. */
	private readsItself(module: string): boolean {
		const answer = this.secretPolicy.current.answer(module);
		return answer.kind === "wholeRedact" || (answer.kind === "omit" && answer.by === "secret");
	}

	/**
	 * What the watcher may read unasked: admitted by the scope as it stands, held by the index, or a
	 * config file a provider consults. A config under an ignored directory still states the rules.
	 *
	 * Synchronous over a scope already computed: the caller starts the live index before the warm
	 * pass has run, so nothing here may lazily ask git for the first time.
	 */
	watchScope(): WatchScope {
		return {
			subscriptions: () => this.secretPolicy.evidence.subscriptions(),
			onSubscriptionsChanged: (listener) => {
				return this.secretPolicy.evidence.onSubscriptionsChanged(listener);
			},
			watchesModule: (module) =>
				this.secretPolicy.evidence.inputsFor({ module }).length > 0 || this.secretPolicy.discovers(module),
			admits: (module) => {
				if (
					this.secretPolicy.evidence.current() !== null &&
					this.secretPolicy.evidence.inputsFor({ module }).length > 0
				)
					return true;
				const scope = this.scopeOrThrow();
				if (scope.denies(module)) return false;
				if (scope.allows(module) || this.store.contentHashOf(module) !== null) return true;
				const answer = this.secretPolicy.current.answer(module);
				if (answer.kind === "wholeRedact" || (answer.kind === "omit" && answer.by === "secret")) return true;
				return this.configFiles.has(module) && !scope.denies(module);
			},
			ignored: (modules) => gitIgnored(this.workspaceRoot, modules, this.clock),
		};
	}

	/** Hash of policy-visible text. */
	hashOfRead(read: SealedText): string {
		return this.secretPolicy.current.view(read).hash;
	}

	/**
	 * Ask the owning provider about a file and replace what the index holds for it.
	 *
	 * Skips rather than throws when nobody owns the file, since a workspace is full of files no
	 * provider claims and each one is not an error.
	 *
	 * Deliberately takes no caller-claimed hash: this reads the file itself and hashes that read,
	 * so facts are never filed under the hash of a different version.
	 *
	 * Caller-held: a refactor step, a restore, a recovery or the daemon's own request reaches this,
	 * and each already holds the gate across a unit larger than this file. None of them asks who
	 * binds against what it wrote, so the pump does once the caller lets go.
	 */
	async indexFile(module: string, depth: IndexDepth = "full", skipIfCurrent = false): Promise<IndexOutcome> {
		const outcome = await this.parseAndStore(module, depth, skipIfCurrent);
		const scope = this.baseScope;
		if (outcome.cause === "missing") {
			if (this.observedModules.delete(module) && scope !== null) this.installScope(scope);
		} else if (
			scope?.mode === "git" &&
			// Imports stay imported.
			this.admissionIn(this.scopeOrThrow(), module) === null &&
			scope.admitsEvent(module) &&
			this.store.contentHashOf(module) !== null &&
			(await gitIgnored(this.workspaceRoot, [module], this.clock))?.has(module) === false
		) {
			this.observedModules.add(module);
			this.installScope(scope);
		}
		this.unasked.add(module);
		this.ensurePumping();
		return outcome;
	}

	/** `indexFile` for a road that asks after its own writes. */
	private async parseAndStore(
		module: string,
		depth: IndexDepth = "full",
		skipIfCurrent = false,
	): Promise<IndexOutcome> {
		// Self-sufficient: recovery, and a standalone call on a fresh service, both reach here before
		// any scan has run. The synchronous scope reads below (claimOf, rootDepth's default) must not
		// be the first to ask for it, and a shared claim's routing needs the evidence callback seeded
		// once, or it reads as nothing until a real scan runs.
		if (this.lastAdmitted === null) {
			await this.currentScopeUnderGate();
			await this.admitted();
		} else await this.currentScope();
		const policyForgotten = this.reconcilePolicy();
		const scope = this.scopeOrThrow();
		if (scope.denies(module))
			return this.unadmitted(module, DENIED_BY_SCOPE_REASON, policyForgotten.includes(module));
		const claim = this.claimOf(module);
		if (!claim.claimed) return this.unadmitted(module, claim.unclaimedReason);

		const read = this.readSource(module);
		if (read.kind === "outside") return this.unadmitted(module, OUTSIDE_WORKSPACE_REASON);
		const verdict = this.secretPolicy.current.verdict(read);
		if (read.kind === "missing") {
			return this.outcome(module, "missing", undefined, this.forgetFile(module, verdict.admission));
		}
		try {
			if (verdict.guarded) this.providerFailures.delete(module);
			// Directly read modules join provider routing evidence.
			if (read.kind === "text") this.supervisor.observeModule(module);
			switch (verdict.route) {
				case "none":
					return this.withhold(module, read, verdict);
				case "omit":
					return this.storeOmitted(module, verdict, skipIfCurrent);
				case "reader":
					return this.storeKeys(module, verdict, skipIfCurrent);
				case "provider":
					return await this.parseProvided(module, verdict, depth, skipIfCurrent);
				default:
					return verdict satisfies never;
			}
		} catch (error) {
			// Guarded faults use verdicts; plain faults propagate.
			if (!verdict.guarded || error instanceof BatchFailed) throw error;
			return this.faulted(module, error, verdict);
		}
	}

	/** No parse: non-text or fully hidden. */
	private withhold(module: string, read: SealedRead, verdict: UnparsedVerdict): IndexOutcome {
		this.forgetFile(module, verdict.admission);
		const unreadable = read.kind === "binary" || read.kind === "tooLarge" ? read : null;
		const failure = verdict.failure(unreadable === null ? null : unreadableReason(unreadable));
		this.store.recordFailure(module, failure, verdict.admission);
		this.upgradeFailed.add(module);
		return this.outcome(module, unreadable === null ? "parseFailed" : unreadable.kind, failure);
	}

	/** The index reads keys; providers do not. */
	private storeKeys(module: string, verdict: ReaderVerdict, skipIfCurrent: boolean): IndexOutcome {
		const admission = verdict.admission;
		const unchanged =
			skipIfCurrent &&
			this.store.contentHashOf(module) === verdict.hash &&
			this.store.policyStampOf(module) === admission.stamp &&
			this.store.depthOf(module) === "full";
		if (unchanged) return this.outcome(module, "current");
		this.forgetFile(module, admission);
		const declarations = [...verdict.declarations];
		const fresh = this.store.depthOf(module) === null;
		try {
			this.store.replaceFile({
				module,
				contentHash: verdict.hash,
				admission,
				declarations,
				references: [],
				imports: [],
				literals: [],
				depth: "full",
				comments: [],
				docs: [],
				notes: [],
				content: "data",
			});
		} catch (error) {
			const lost = this.store.lostBatch();
			if (lost !== null) throw lost;
			return this.faulted(module, error, verdict);
		}
		this.importsWritten.add(module);
		this.settleProjections();
		this.caches.facts.invalidate();
		this.upgradeFailed.delete(module);
		if (fresh) this.newInPass.add(module);
		return { module, action: "indexed", declarations: declarations.length };
	}

	private storeOmitted(
		module: string,
		verdict: Extract<ModuleVerdict, { readonly route: "omit" }>,
		skipIfCurrent: boolean,
	): IndexOutcome {
		const admission = verdict.admission;
		const unchanged =
			skipIfCurrent &&
			this.store.contentHashOf(module) === verdict.hash &&
			this.store.policyStampOf(module) === admission.stamp &&
			this.store.depthOf(module) === "full";
		if (unchanged) return this.outcome(module, "current");
		this.forgetFile(module, admission);
		const fresh = this.store.depthOf(module) === null;
		try {
			this.store.replaceFile({
				module,
				contentHash: verdict.hash,
				admission,
				declarations: [],
				references: [],
				imports: [],
				literals: [],
				depth: "full",
				comments: [],
				docs: [],
				notes: [],
				content: "data",
			});
		} catch (error) {
			const lost = this.store.lostBatch();
			if (lost !== null) throw lost;
			return this.faulted(module, error, verdict);
		}
		this.importsWritten.add(module);
		this.settleProjections();
		this.caches.facts.invalidate();
		this.upgradeFailed.delete(module);
		if (fresh) this.newInPass.add(module);
		return { module, action: "indexed", declarations: 0 };
	}

	/** Providers parse full text; facts are filtered after. */
	private async parseProvided(
		module: string,
		verdict: ProviderVerdict,
		depth: IndexDepth,
		skipIfCurrent: boolean,
	): Promise<IndexOutcome> {
		const admission = verdict.admission;
		const readHash = verdict.hash;
		// One resolution for the parse and its verdict. Routing moves on the evidence above, and a
		// verdict reaching a provider that did not answer settles nothing while the one that did
		// keeps the parse.
		const parser = this.supervisor.route(module);
		if (!parser.owned) return this.unadmitted(module, "unclaimed");
		// Read before the parse: a provider that dies and restarts under this id holds a fresh ledger,
		// and the verdict for the parse below belongs to the process that answered it.
		const answered: Parser = {
			providerId: parser.providerId,
			incarnation: this.supervisor.incarnationOf(parser.providerId),
		};

		// Of the text actually read, never the caller's. A watcher hashes at event time and this
		// reads later, so trusting the argument would store facts from one version of a file under
		// the hash of another, and every staleness check downstream would compare the wrong pair.
		// Preserve deeper facts when owner matches or is unrecorded, and the project reads files as it did.
		const writer = this.store.writerOf(module);
		if (
			skipIfCurrent &&
			!this.restated.has(parser.providerId) &&
			this.store.contentHashOf(module) === readHash &&
			this.store.policyStampOf(module) === admission.stamp &&
			(writer ?? parser.providerId) === parser.providerId
		) {
			const held = this.store.depthOf(module);
			const satisfied = held === "full" || held === "surface" || held === depth;
			if (satisfied) {
				// Final facts outrank a failure row.
				if (held !== "outline") this.store.clearFailure(module, admission);
				// A row from before content was recorded learns it without a parse.
				this.store.recordContent(module, parser.content);
				return this.outcome(module, "current");
			}
		}
		if (verdict.guarded) {
			this.forgetFile(module, admission);
		}
		let facts: MethodResponse<"parseFile">;
		try {
			facts = await this.supervisor.askProvider(parser.providerId, "parseFile", {
				module,
				contentHash: readHash,
				text: verdict.input,
				...(depth === "full" ? {} : { depth }),
			});
		} catch (error) {
			if (error instanceof ProviderUnavailableError) {
				const failure = verdict.failure(error);
				if (verdict.guarded) this.store.recordFailure(module, failure, admission);
				this.providerFailures.set(module, failure);
				return this.outcome(module, "providerDown", failure);
			}
			return this.refuseParse(answered, module, readHash, verdict, error);
		}
		facts = verdict.facts(facts);
		const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		if (errors.length > 0) {
			// An answer, not a throw: the file is the reason, and a caller reindexing a restored file
			// must not fail on it. Recorded here so every caller's failure reaches coverage.
			return this.refuseParse(answered, module, readHash, verdict, errors.map((d) => d.message).join("; "));
		}
		// Below error, kept with the facts.
		const notes: FileNote[] = facts.diagnostics.flatMap((diagnostic) =>
			diagnostic.severity === "error"
				? []
				: [
						{
							severity: diagnostic.severity,
							message: diagnostic.message,
							...defined({ range: diagnostic.range, path: diagnostic.path }),
						},
					],
		);
		// An absent depth means full facts, except surface remains a permission ceiling.
		const storedDepth = facts.depth ?? (depth === "surface" ? "surface" : "full");
		// No depth before the write and facts after it: new to the pass, root or reached alike.
		const fresh = this.store.depthOf(module) === null;
		// Attachment happens here rather than in the store, because "nothing between these two" is a
		// question only the source text answers, and this is the last place holding it.
		const generatedVerdict = await this.verdictFor(module);
		// Where each specifier lands: what its edges bind to, and what a forward reads through.
		const resolutions = await this.resolutions(module, facts.imports);
		try {
			this.store.replaceFile({
				module,
				...(facts.runtime === undefined ? {} : { runtime: facts.runtime }),
				contentHash: readHash,
				admission,
				declarations: facts.declarations,
				references: facts.references,
				imports: facts.imports,
				// Shallow parses store no comments or literals.
				literals: storedDepth === "full" ? facts.literals : [],
				depth: storedDepth,
				comments:
					storedDepth === "full"
						? attachComments(facts.declarations, facts.comments ?? [], verdict.input, facts.blankLines)
						: [],
				docs: facts.docs ?? [],
				notes,
				content: parser.content,
				provider: parser.providerId,
				// A shallow parse reports no comments, so only a full one can say what a digest covers; the
				// supervisor drops a comments field from a provider that never declared the tier.
				digests:
					storedDepth === "full"
						? patternDigests(facts.declarations, facts.comments, facts.literals, verdict.allowed)
						: [],
				generated: generatedVerdict,
				role: facts.role,
				resolutions,
				exports: facts.exports,
				allList: facts.allList,
				scopeContributions: facts.scopeContributions,
			});
		} catch (error) {
			// An answer the store refuses is the provider's answer for THIS file, so it is the file's failure.
			if (error instanceof FactAdmissionError) {
				return this.refuseParse(
					answered,
					module,
					readHash,
					verdict,
					`the provider's answer was refused: ${error.message}`,
				);
			}
			// Any other store failure committed nothing either, and the provider is holding this parse.
			// Answered rather than rethrown, so the fault is recorded before the provider is told; a lost
			// batch records none and ends the pass once the provider is told.
			const lost = this.store.lostBatch();
			const outcome = lost === null ? this.faulted(module, error, verdict) : undefined;
			this.publish(answered, {
				module,
				contentHash: readHash,
				outcome: { status: "refused", reason: verdict.failure(indexerFault(error)) },
			});
			if (outcome === undefined) throw lost;
			return outcome;
		}
		// Told once the batch holding the write commits, or refused if that batch is lost, so the provider
		// believes only what the index committed.
		this.store.whenCommitted((committed) =>
			this.publish(answered, {
				module,
				contentHash: readHash,
				outcome: committed ? { status: "admitted" } : { status: "refused", reason: LOST_BATCH_REASON },
			}),
		);
		this.importsWritten.add(module);
		this.settleProjections();
		// The provider answers again, so what its outage held back is tried again.
		if (this.store.unblockOutages(parser.providerId) > 0) this.queueRebinds();
		if (fresh) this.newInPass.add(module);
		// A success re-admits the module to the background backlog.
		this.upgradeFailed.delete(module);
		// Every stored answer was drawn from facts that just moved, so all of them are unreachable.
		this.caches.facts.invalidate();
		return { module, action: "indexed", declarations: facts.declarations.length };
	}

	/** A file's modification time and size, to tell whether it changed between two looks; null when unreadable. */
	private fileStat(module: string): string | null {
		try {
			const stats = statSync(insideWorkspace(this.workspaceRoot, module));
			return `${stats.mtimeMs}:${stats.size}`;
		} catch {
			return null;
		}
	}

	/** Stats each module `module` imports that `stats` has not looked at, before a later parse can read it. */
	private async noteReached(module: string, stats: Map<string, string | null>): Promise<void> {
		for (const statement of this.store.importsIn(module)) {
			const landed = await this.resolve(module, statement.specifier, statement.resolutionMode).catch(() => null);
			const target = landed === null ? null : importTarget(landed);
			if (target !== null && !stats.has(target.module)) stats.set(target.module, this.fileStat(target.module));
		}
	}

	/** Where each of a write's specifiers lands per mode, resolved once each; null when the resolver cannot say. */
	private async resolutions(
		module: string,
		imports: readonly Import[],
	): Promise<Map<string, ImportResolution | null>> {
		const resolved = new Map<string, ImportResolution | null>();
		for (const statement of imports) {
			for (const { resolutionMode } of statement.edges) {
				const key = resolutionKey(statement.specifier, resolutionMode);
				if (resolved.has(key)) continue;
				resolved.set(key, await this.resolve(module, statement.specifier, resolutionMode).catch(() => null));
			}
		}
		return resolved;
	}

	/**
	 * Plain-file refusal preserves previous facts.
	 *
	 * Recorded before it is published, so a provider is never told a verdict the index has not
	 * taken. The provider is told because the refusal happens after it answered: its own cross-file
	 * state holds the facts this just declined, and nothing else would ever say so.
	 */
	private refuseParse(
		answered: Parser,
		module: string,
		contentHash: string,
		verdict: ModuleVerdict,
		error: unknown,
	): IndexOutcome {
		if (verdict.guarded) this.forgetFile(module, verdict.admission);
		const failure = verdict.failure(error);
		this.store.recordFailure(module, failure, verdict.admission);
		this.upgradeFailed.add(module);
		this.publish(answered, { module, contentHash, outcome: { status: "refused", reason: failure } });
		return this.outcome(module, "parseFailed", failure);
	}

	/** Tells the process that answered. Called only after the index has written the verdict. */
	private publish(answered: Parser, verdict: ModuleAdmission): void {
		this.supervisor.admission(answered.providerId, answered.incarnation, verdict);
	}

	/**
	 * Index every file the running providers claim.
	 *
	 * Sequential rather than parallel: each provider serializes on its own queue anyway, so
	 * flooding it would only trade a readable progress order for the same wall clock.
	 */
	async indexWorkspace(onProgress?: (done: number, total: number) => void): Promise<IndexOutcome[]> {
		return this.during(this.scanning(), () => this.runWorkspaceScan("full", onProgress));
	}

	/** Runs `work` as `doing`, which a status answer names while it runs. */
	async during<T>(doing: Doing, work: () => Promise<T>): Promise<T> {
		this.doing.add(doing);
		try {
			return await work();
		} finally {
			this.doing.delete(doing);
		}
	}

	/** A scan counts as its status does. */
	private scanning(): Doing {
		return { kind: "scan", counts: () => ({ done: this.status.done, total: this.status.total }) };
	}

	/** The work a status answer names, or null when idle. */
	private activity(): IndexActivity | null {
		let named: Doing | undefined;
		for (const doing of this.doing) {
			if (named === undefined || ACTIVITY_ORDER.indexOf(doing.kind) < ACTIVITY_ORDER.indexOf(named.kind))
				named = doing;
		}
		if (named === undefined) return null;
		return { kind: named.kind, ...named.counts?.(), ...defined({ label: named.label }) };
	}

	/** A warm was asked for: `discovering` from now, not once its scope is computed. */
	markDiscovering(): void {
		if (this.status.state === "unstarted") this.status = { state: "discovering", done: 0, total: 0 };
	}

	/** Stores declarations and imports before full facts. */
	async warmupWorkspace(onProgress?: (done: number, total: number) => void): Promise<IndexOutcome[]> {
		this.coverage = { state: "discovering" };
		return this.during(this.scanning(), () => this.runWorkspaceScan("outline", onProgress));
	}

	private async runWorkspaceScan(
		floor: "full" | "outline",
		onProgress?: (done: number, total: number) => void,
	): Promise<IndexOutcome[]> {
		this.generated.clear();
		await this.alone(async () => {
			try {
				await this.secretPolicy.refresh({ kind: "startup" });
			} catch (error) {
				this.coverage = { state: "failed", reason: error instanceof Error ? error.message : String(error) };
				throw error;
			}
		});
		return coordinateWorkspaceScan.call(this.workspaceScanContext, floor, onProgress);
	}

	private async scanWorkspace(
		floor: "full" | "outline",
		onProgress?: (done: number, total: number) => void,
	): Promise<IndexOutcome[]> {
		return coordinateScanWorkspace.call(this.workspaceScanContext, floor, onProgress);
	}

	/** What git admits, so no provider walks what the scope ignores; a walk scope has no list to give. */
	private async discoveryScope(): Promise<string[] | undefined> {
		const { candidates } = await this.admitted();
		return this.scopeOrThrow().mode === "git" ? candidates : undefined;
	}

	/** Asks one provider for its project, noting its files and the config it consults. */
	private async discover(
		providerId: string,
		scope: string[] | undefined,
	): Promise<MethodResponse<"discoverProject">> {
		const project = await this.supervisor.askProvider(providerId, "discoverProject", {
			workspaceRoot: this.workspaceRoot,
			...(scope === undefined ? {} : { scope }),
		});
		// Replaced, not added to: a file the project no longer names leaves the roots with it.
		this.discovered.set(providerId, new Set(project.files));
		for (const [module, owners] of this.configFiles) {
			owners.delete(providerId);
			if (owners.size === 0) this.configFiles.delete(module);
		}
		// The provider names them, so core learns which files state the rules without telling
		// one language from another.
		for (const module of project.configFiles) {
			const owners = this.configFiles.get(module) ?? new Set<string>();
			owners.add(providerId);
			this.configFiles.set(module, owners);
		}
		return project;
	}

	/**
	 * Rediscovers each provider whose config a batch touched. A moved fingerprint owes a parse of
	 * every module that provider wrote, since its bytes did not change but their reading did.
	 */
	private async restatements(
		modules: readonly string[],
		refreshAll = false,
	): Promise<Array<{ providerId: string; fingerprint: string; written: string[] }>> {
		const providers = new Set(modules.flatMap((module) => [...(this.configFiles.get(module) ?? [])]));
		if (refreshAll) for (const provider of this.supervisor.running()) providers.add(provider.providerId);
		const owed: Array<{ providerId: string; fingerprint: string; written: string[] }> = [];
		const scope = providers.size === 0 ? undefined : await this.discoveryScope();
		for (const providerId of providers) {
			const project = await this.discover(providerId, scope);
			const fingerprint = project.fingerprint;
			if (fingerprint === undefined || fingerprint === this.store.projectFingerprint(providerId)) continue;
			const written = [...this.store.writers()]
				.filter(([, writer]) => writer === providerId)
				.map(([module]) => module);
			owed.push({ providerId, fingerprint, written });
		}
		return owed;
	}

	/**
	 * Whether every module a provider reads, and every module in `also`, took an admitted parse or
	 * held what it had among these outcomes. An outage, a refusal or a fault did neither.
	 */
	private readAllUnder(
		providerId: string,
		outcomes: readonly IndexOutcome[],
		also: ReadonlySet<string> = new Set(),
	): boolean {
		return !outcomes.some((outcome) => {
			if (!UNREAD.has(outcome.cause)) return false;
			const route = this.supervisor.route(outcome.module);
			return also.has(outcome.module) || (route.owned && route.providerId === providerId);
		});
	}

	/** Queues full parses ahead of the background upgrade. */
	requestFull(modules: string[]): Promise<void> {
		return coordinateRequestFull.call(this.pumpContext, modules);
	}

	/** Starts paying owed parses, as after a restart that left some. */
	payOwed(): void {
		coordinatePayOwed.call(this.pumpContext);
	}

	/** Drains the outline backlog, yielding between files. */
	upgradeRemaining(): Promise<void> {
		return coordinateUpgradeRemaining.call(this.pumpContext);
	}

	private ensurePumping(): void {
		coordinateEnsurePumping.call(this.pumpContext);
	}

	private async pump(): Promise<void> {
		return coordinatePump.call(this.pumpContext);
	}

	/** An index pass; a lost batch arms the recovery that reads again what the committed store owes. */
	private async pass<T>(work: () => Promise<T>): Promise<T> {
		try {
			const result = await this.store.pass(work);
			this.losses = 0;
			return result;
		} catch (error) {
			if (error instanceof BatchFailed) this.recoverLater();
			throw error;
		}
	}

	private recoverLater(): void {
		coordinateRecoverLater.call(this.pumpContext);
	}

	private async recover(): Promise<void> {
		return coordinateRecover.call(this.pumpContext);
	}

	private startRun(): void {
		coordinateStartRun.call(this.pumpContext);
	}

	private async pumpTurns(): Promise<void> {
		return coordinatePumpTurns.call(this.pumpContext);
	}

	private async rebindStep(): Promise<boolean> {
		return coordinateRebindStep.call(this.pumpContext);
	}

	private async upgradeOne(module: string): Promise<void> {
		return coordinateUpgradeOne.call(this.pumpContext, module);
	}

	/** The mark is carried forward unless a caller says otherwise. */
	private writeScanSummary(outlined = this.store.readScanSummary()?.outlined === true): void {
		if (this.breakdown === null) return;
		const knowledgeSweep = this.lastSweep ?? this.store.readScanSummary()?.knowledgeSweep;
		this.store.writeScanSummary({
			...this.breakdown,
			outlined,
			...defined({ knowledgeSweep }),
		});
	}

	/** After prune, which has just decided presence: the pass's new modules are the rebind targets. */
	private sweepAfterPrune(reachable: Set<string>): void {
		this.reachable = reachable;
		this.runSweep(this.newInPass);
		this.newInPass = new Set();
	}

	/** The timer's sweep: nothing is new, and presence is what the last prune decided. */
	sweepKnowledge(): SweepReport {
		return this.runSweep(new Set());
	}

	private runSweep(newModules: ReadonlySet<string>): SweepReport {
		const reachable = this.reachable;
		// No prune yet means no presence to judge by; an absent module would read as gone.
		if (reachable === null) {
			return { examined: 0, rebound: 0, orphaned: 0, deleted: 0, ambiguous: 0, stoppedEarly: false };
		}
		const presence = (module: string): ModulePresence =>
			!reachable.has(module)
				? "absent"
				: this.store.parseFailureOf(module) !== null
					? "presentFailing"
					: "presentParsing";
		const report = this.store.sweepSubjects(ORPHAN_SWEEP_CAP, { presence, newModules }, this.clock.now());
		this.lastSweep = report;
		this.writeScanSummary();
		return report;
	}

	private async indexOne(
		module: string,
		depth = this.depths.get(module) ?? this.rootDepth(module),
		skipIfCurrent = false,
	): Promise<IndexOutcome> {
		if (this.scopeOrThrow().denies(module)) return this.unadmitted(module, DENIED_BY_SCOPE_REASON);
		return this.parseAndStore(module, depth, skipIfCurrent);
	}

	/** A module nothing may index keeps no facts. */
	private unadmitted(module: string, reason: string, reconciled = false): IndexOutcome {
		const held = this.store.contentHashOf(module) !== null || this.store.parseFailureOf(module) !== null;
		const forgot = held && this.forgetFile(module, this.secretPolicy.current.admission(module));
		return this.outcome(module, "unclaimed", reason, forgot || reconciled);
	}

	/** Exclude failures from the retryable background backlog. */
	private upgradeFailed = new Set<string>();
	private providerFailures = new Map<string, string>();

	providerFailureOf(module: string): string | null {
		return this.providerFailures.get(module) ?? null;
	}

	/** The one place an outcome's action and reason are chosen for its cause. */
	private outcome(module: string, cause: IndexCause, detail?: string, forgot = false): IndexOutcome {
		switch (cause) {
			case "missing":
				return { module, action: forgot ? "forgotten" : "skipped", cause, reason: "file is gone" };
			case "current":
				return { module, action: "skipped", cause, reason: detail ?? "already indexed at this depth" };
			case "binary":
			case "tooLarge":
			case "parseFailed":
				return { module, action: "skipped", cause, reason: "parse failed", failure: detail };
			case "providerDown":
				return { module, action: "skipped", cause, reason: "provider unavailable", failure: detail };
			case "fault":
				return { module, action: "skipped", cause, reason: "the indexer failed on this file", failure: detail };
			case "unclaimed":
				return { module, action: forgot ? "forgotten" : "skipped", cause, reason: detail ?? "unclaimed" };
		}
	}

	/** Unclassified faults follow module policy. */
	private faultOutcome(module: string, error: unknown): IndexOutcome {
		return this.faulted(module, error, this.secretPolicy.current.verdict(module));
	}

	private faulted(module: string, error: unknown, verdict: ModuleVerdict): IndexOutcome {
		if (verdict.guarded) this.forgetFile(module, verdict.admission);
		// Recorded under its own wording, so the file shows among the failures without being blamed. An
		// index write, so after a lost batch it refuses and the pass ends: a loss is no file's fault.
		this.store.recordFailure(module, verdict.failure(indexerFault(error)), verdict.admission);
		this.upgradeFailed.add(module);
		return this.outcome(module, "fault", verdict.failure(error));
	}

	/** Whether anything will index a module: the scope's word, then the routing's, then its owner's exclusions. */
	claimOf(module: string): ModuleClaim {
		const scope = this.scopeOrThrow();
		const answer = this.secretPolicy.current.answer(module);
		if (scope.denies(module)) return { claimed: false, unclaimedReason: DENIED_BY_SCOPE_REASON };
		if (answer.kind === "wholeRedact" || (answer.kind === "omit" && answer.by === "secret")) {
			return underExcludedDirectory(module, DEFAULT_EXCLUDED_DIRECTORIES, this.entries)
				? { claimed: false, unclaimedReason: EXCLUDED_DIRECTORY_REASON }
				: { claimed: true };
		}
		const route = this.supervisor.route(module);
		// The one check: roots, followed imports and every explicit index road all ask here.
		if (this.excludedByOwner(module, route)) return { claimed: false, unclaimedReason: EXCLUDED_DIRECTORY_REASON };
		if (route.owned) return { claimed: true, provider: route.providerId };
		return {
			claimed: false,
			unclaimedReason: route.reason === "contested" ? `claimed by ${route.providerIds.join(", ")}` : "unclaimed",
		};
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
	private async followImports(seen: Set<string>, walk: ImportWalk): Promise<IndexOutcome[]> {
		const { indexExisting, step, reached, previousDepths = new Map(), floor = "full" } = walk;
		const outcomes: IndexOutcome[] = [];
		// Each round walks only what the last one indexed. A module already walked had its imports
		// read then, and nothing in this loop rewrites them, so re-walking the whole set every round
		// asks the same questions again once per round.
		let frontier = [...seen];

		while (frontier.length > 0) {
			const found: string[] = [];
			for (const module of frontier) {
				for (const statement of this.store.importsIn(module)) {
					const landed = await this.resolve(module, statement.specifier, statement.resolutionMode).catch(
						() => null,
					);
					const target = landed === null ? null : importTarget(landed);
					if (target === null || this.scopeOrThrow().denies(target.module)) continue;
					const depth = this.scopeOrThrow().surface(target.module)
						? "surface"
						: floor === "outline" && target.depth === "full"
							? "outline"
							: target.depth;
					const prior = this.depths.get(target.module);
					if (seen.has(target.module) && !(prior === "surface" && depth === "full")) continue;
					// An unclaimed target stays unseen, so the prune that follows forgets any row it holds.
					if (!this.claimOf(target.module).claimed) continue;
					seen.add(target.module);
					this.depths.set(target.module, depth);
					found.push(target.module);
				}
			}
			if (found.length === 0) break;
			await this.rememberVerdicts(found);
			for (const module of found) {
				if (
					!indexExisting &&
					this.store.contentHashOf(module) !== null &&
					settledDepth(previousDepths.get(module)) === settledDepth(this.depths.get(module)) &&
					this.store.policyStampOf(module) === this.secretPolicy.current.answer(module).stamp
				)
					continue;
				outcomes.push(
					await step(async () => {
						try {
							// Same restart guard as the root loop: an unchanged imported file holding
							// full facts must not be demoted by an outline-floor rescan.
							return await this.indexOne(module, undefined, floor === "outline");
						} catch (error) {
							return this.faultOutcome(module, error);
						}
					}),
				);
				await reached?.(module);
			}
			// What this round indexed, including what it skipped as current: their imports are what
			// the next round has not read yet.
			frontier = found;
		}
		return outcomes;
	}

	private prune(reachable: Set<string>): IndexOutcome[] {
		const outcomes: IndexOutcome[] = [];
		for (const module of this.store.indexedFiles()) {
			if (reachable.has(module)) continue;
			const admission = this.secretPolicy.current.admission(module);
			outcomes.push(
				this.outcome(module, "unclaimed", "no longer a root or reachable", this.forgetFile(module, admission)),
			);
		}
		// A failure row for a file that was never stored has no files row to sweep it away with.
		for (const { module } of this.store.parseFailures()) {
			if (!reachable.has(module) && this.store.contentHashOf(module) === null)
				this.store.clearFailure(module, this.secretPolicy.current.admission(module));
		}
		return outcomes;
	}

	/** Includes providerless modules. */
	private async admitted(
		extra: Iterable<string> = [],
		gone: Iterable<string> = [],
		preparedScope?: FileScope,
	): Promise<Admitted> {
		if (preparedScope === undefined) {
			if (this.scope === null) throw new ScopeNotComputedError();
		} else {
			this.installScope(preparedScope);
		}
		const scope = this.scopeOrThrow();
		const named = this.includedIn(scope);
		const namedSet = new Set(named);
		const goneSet = new Set(gone);
		const discovered = [...this.discovered.values()].flatMap((files) => [...files]);
		const everything = [
			...new Set([
				...(scope.known ?? []),
				...(this.secretPolicy.evidence.current()?.collected.ignoredSecrets ?? []),
				...discovered,
				...named,
				...extra,
			]),
		].filter((module) => !goneSet.has(module));
		const candidates = everything.filter((module) => scope.allows(module));
		const missing = candidates.filter((module) => !this.generated.has(module));
		for (const [module, verdict] of await generatedVerdicts(this.workspaceRoot, missing, this.clock))
			this.generated.set(module, verdict);
		const reachable = candidates.filter(
			(module) => namedSet.has(module) || this.generated.get(module)?.status !== "yes",
		);
		const result: Admitted = { everything, candidates, reachable };
		// The one snapshot the synchronous evidence callback may read; nothing else reads it.
		this.lastAdmitted = result;
		return result;
	}

	/** One git call for what a round reached past admission, so an import closure never asks per file. */
	private async rememberVerdicts(modules: string[]): Promise<void> {
		const missing = modules.filter((module) => !this.generated.has(module));
		if (missing.length === 0) return;
		for (const [module, verdict] of await generatedVerdicts(this.workspaceRoot, missing, this.clock))
			this.generated.set(module, verdict);
	}

	/** Admission's verdict, or git asked for a module written outside any pass. */
	private async verdictFor(module: string): Promise<GeneratedVerdict> {
		await this.rememberVerdicts([module]);
		return this.generated.get(module) as GeneratedVerdict;
	}

	private async rootModules(
		extra: Iterable<string> = [],
		gone: Iterable<string> = [],
		preparedScope?: FileScope,
	): Promise<Set<string>> {
		const { everything, candidates, reachable } = await this.admitted(extra, gone, preparedScope);
		this.reconcilePolicy();
		// Evidence before ownership: a shared claim is decided by what the scope admits.
		this.supervisor.observeWorkspace(reachable);
		const roots = new Set(reachable.filter((module) => this.claimOf(module).claimed));
		const byProvider = new Map<string, string[]>();
		for (const module of roots) {
			const claim = this.claimOf(module);
			if (!claim.claimed || claim.provider === undefined) continue;
			const providerId = claim.provider;
			const owned = byProvider.get(providerId) ?? [];
			owned.push(module);
			byProvider.set(providerId, owned);
		}
		for (const { providerId } of this.supervisor.running()) {
			const owned = (byProvider.get(providerId) ?? []).sort();
			const incarnation = this.supervisor.incarnationOf(providerId);
			const key = JSON.stringify(owned);
			const previous = this.sentRoots.get(providerId);
			if (previous?.incarnation === incarnation && previous.key === key) continue;
			this.supervisor.indexRoots(providerId, owned);
			this.sentRoots.set(providerId, { incarnation, key });
		}
		this.dropMovedOwners();

		// Hold all sets here.
		this.breakdown = {
			tracked: everything.length,
			claimed: roots.size,
			unclaimed: reachable.length - roots.size,
			generated: candidates.length - reachable.length,
			denied: everything.length - candidates.length,
		};
		return roots;
	}

	/** Under a directory its owner declared excluded, which only the owner's own discovery overrides. */
	private excludedByOwner(module: string, route: Route): boolean {
		if (!route.owned) return false;
		const named = this.discovered.get(route.providerId);
		if (named?.has(module) === true) return false;
		const owner = this.supervisor.running().find((claims) => claims.providerId === route.providerId);
		const excluded = owner?.excludedDirectories;
		if (excluded === undefined || !underExcludedDirectory(module, excluded, this.entries)) return false;
		// Before that provider's first discovery here, a held row may be a file it names.
		return named !== undefined || this.store.depthOf(module) === null;
	}

	/**
	 * Drop rows owned by a different provider, and tell the one that wrote them, which would
	 * otherwise keep answering from a copy only the new owner is sent.
	 */
	private dropMovedOwners(): void {
		let dropped = false;
		for (const [module, writer] of this.store.writers()) {
			const route = this.supervisor.route(module);
			if (!route.owned || route.providerId === writer) continue;
			// Keep dependency reads available.
			dropped = this.store.forgetFile(module, this.secretPolicy.current.admission(module)) || dropped;
			this.importsWritten.add(module);
			this.supervisor.release(module, writer);
		}
		if (dropped) this.caches.facts.invalidate();
	}

	private rootDepth(module: string): IndexDepth {
		return this.scopeOrThrow().surface(module) ? "surface" : "full";
	}

	/** Surface is a ceiling, not a starting depth. */
	private scanDepth(module: string, floor: "full" | "outline"): IndexDepth {
		const ceiling = this.rootDepth(module);
		return ceiling === "surface" ? "surface" : floor;
	}

	private forgetFile(module: string, admission: SecretAdmission): boolean {
		const removed = this.store.forgetFile(module, admission);
		this.settleProjections();
		this.importsWritten.add(module);
		// Told regardless: a provider may still hold the file.
		this.supervisor.forget(module);
		this.caches.facts.invalidate();
		// A specifier that landed on it may land elsewhere now.
		if (removed) this.caches.resolutions.invalidate();
		return removed;
	}

	private pendingMoves(modules: Iterable<string> | null): Map<string, SurfaceChange> {
		return schedulePendingMoves.call(this.rebindContext, modules);
	}

	private settleProjections(): void {
		scheduleSettleProjections.call(this.rebindContext);
	}

	private settle(moves: ReadonlyMap<string, SurfaceChange>, owed: readonly string[]): void {
		scheduleSettle.call(this.rebindContext, moves, owed);
	}

	private queueRebinds(): void {
		scheduleQueueRebinds.call(this.rebindContext);
	}

	private queueProviderInvalidations(modules: readonly string[]): void {
		for (const module of modules) this.providerInvalidations.add(module);
		if (this.providerInvalidationsQueued || this.providerInvalidations.size === 0) return;
		this.providerInvalidationsQueued = true;
		void this.gate
			.exclusive(async () => {
				const changed = [...this.providerInvalidations].sort();
				this.providerInvalidations.clear();
				const index = await this.importIndex();
				const importers = new Set<string>();
				if (index.complete) {
					for (const module of changed)
						for (const importer of index.importersOf(module)) importers.add(importer);
				} else {
					for (const module of this.store.indexedFiles()) importers.add(module);
				}
				for (const module of [...importers].sort()) await this.indexFile(module);
			})
			.catch(() => {})
			.finally(() => {
				this.providerInvalidationsQueued = false;
				if (this.providerInvalidations.size > 0) this.queueProviderInvalidations([]);
			});
	}

	private retryResolving(moved: Iterable<string>): void {
		scheduleRetryResolving.call(this.rebindContext, moved);
	}

	private holdRebind(module: string, outcome: IndexOutcome): void {
		scheduleHoldRebind.call(this.rebindContext, module, outcome);
	}

	private processOf(providerId: string): string {
		return scheduleProcessOf.call(this.rebindContext, providerId);
	}

	private async rebindDependents(
		outcomes: readonly IndexOutcome[],
		shouldAbandon?: () => boolean,
	): Promise<IndexOutcome[]> {
		return scheduleRebindDependents.call(this.rebindContext, outcomes, shouldAbandon);
	}

	private async oweDependents(
		moves: ReadonlyMap<string, SurfaceChange>,
		order: ReadonlyMap<string, number>,
		stale: (module: string, change: SurfaceChange) => boolean = () => true,
	): Promise<void> {
		return scheduleOweDependents.call(this.rebindContext, moves, order, stale);
	}

	private readAfter(
		module: string,
		moves: ReadonlyMap<string, SurfaceChange>,
		order: ReadonlyMap<string, number>,
		stale: (module: string, change: SurfaceChange) => boolean = () => true,
	): boolean {
		return scheduleReadAfter.call(this.rebindContext, module, moves, order, stale);
	}

	private async dependentsOf(
		moves: ReadonlyMap<string, SurfaceChange>,
	): Promise<{ modules: string[]; unbound: string[]; complete: boolean }> {
		return scheduleDependentsOf.call(this.rebindContext, moves);
	}

	private async importIndex(): Promise<{ importersOf: (target: string) => ReadonlySet<string>; complete: boolean }> {
		return scheduleImportIndex.call(this.rebindContext);
	}

	private async readWhole(index: ImporterIndex): Promise<void> {
		return scheduleReadWhole.call(this.rebindContext, index);
	}

	private async readImports(
		index: ImporterIndex,
		module: string,
		occurrences: ReadonlyArray<{ specifier: string; resolutionMode?: ResolutionMode | undefined }>,
	): Promise<boolean> {
		return scheduleReadImports.call(this.rebindContext, index, module, occurrences);
	}

	private rebindable(module: string): boolean {
		return scheduleRebindable.call(this.rebindContext, module);
	}

	private async rebindOne(module: string): Promise<void> {
		return scheduleRebindOne.call(this.rebindContext, module);
	}

	/**
	 * How much of the workspace the index actually holds.
	 *
	 * Store-derived coverage is separate from process scan progress, so a restart can distinguish a
	 * complete store from a partial one.
	 */
	indexStatus(concerning?: string): IndexStatus {
		// Store-derived counts survive restarts.
		const depths = this.store.depthTotals();
		const concerned = concerning === undefined ? null : this.store.parseFailureOf(concerning);
		const indexed = this.store.projectIndexed();
		const scanning = ["discovering", "warming", "indexing", "upgrading"].includes(this.status.state);
		return {
			...this.status,
			...(indexed === undefined || (!indexed && scanning) ? {} : { indexed }),
			stored: this.store.totals().files,
			failures: this.store.parseFailureCount(),
			failed: this.store.parseFailures(NAMED_FAILURES),
			...(this.secretPolicy.notes.length === 0 ? {} : { scopeNotes: [...this.secretPolicy.notes] }),
			...(concerned === null ? {} : { concerning: concerned }),
			fullFiles: depths.full + depths.surface,
			outlineFiles: depths.outline,
			// Fact and knowledge writes advance generation.
			generation: `${this.epoch}.${this.caches.facts.stats().generation}.${this.store.knowledgeGeneration()}`,
			providers: this.supervisor.providerStatuses(),
			activity: this.activity(),
		};
	}

	/** What `indexFile` would find, decided in its order, without asking a provider or writing. */
	moduleStatus(module: string): ModuleStatus {
		const denied = this.scopeOrThrow().denies(module);
		return statusOf(module, this.claimOf(module), denied ? null : this.readSource(module), this.store);
	}

	/** Reports indexed, withheld, or unindexed targets. */
	noteModuleState(module: string): "indexed" | "withheld" | "unindexed" {
		const answer = this.secretPolicy.current.answer(module);
		const denied = this.scope?.denies(module) === true || (answer.kind === "omit" && answer.by === "deny");
		if (denied) return this.moduleExists(module) ? "withheld" : "unindexed";

		const depth = this.store.depthOf(module);
		if (answer.kind === "plain") return depth === null ? "unindexed" : "indexed";
		if (answer.kind === "omit" && answer.by === "secret")
			return depth !== null && this.moduleExists(module) ? "indexed" : "unindexed";

		const read = this.readSource(module);
		if (read.kind === "missing" || read.kind === "outside") return "unindexed";
		const verdict = this.secretPolicy.current.verdict(read);
		if (verdict.guarded && verdict.route === "none") return "withheld";
		return depth === null ? "unindexed" : "indexed";
	}

	private moduleExists(module: string): boolean {
		try {
			const contained = resolveContained(this.workspaceRoot, module);
			return contained.kind === "file" && statSync(contained.path).isFile();
		} catch {
			return false;
		}
	}

	/** Files the scope's explicit includes name, cached until the includes or admission move. */
	private includedIn(scope: FileScope): string[] {
		const key = JSON.stringify(scope.include);
		if (this.includeCache?.key !== key)
			this.includeCache = { key, files: includedFiles(this.workspaceRoot, scope.include) };
		return this.includeCache.files;
	}

	async searchModules(scopePath?: string): Promise<SourceInventory> {
		const scope = await this.currentScope();
		const discovered = [...this.discovered.values()].flatMap((files) => [...files]);
		const walked = scope.mode === "walk" ? searchFiles(this.workspaceRoot, scope, scopePath) : null;
		const modules = [
			...new Set([
				...(scope.known ?? this.secretPolicy.evidence.current()?.collected.modules ?? []),
				...(walked?.modules ?? []),
				...this.includedIn(scope),
				...discovered,
				...this.store.indexedFiles(),
			]),
		]
			.filter(
				(module) =>
					(scopePath === undefined ||
						scopePath === "." ||
						module === scopePath ||
						module.startsWith(`${scopePath}/`)) &&
					!scope.denies(module) &&
					(scope.allows(module) || this.reachable?.has(module) === true) &&
					resolveContained(this.workspaceRoot, module).kind === "file",
			)
			.sort();
		return { modules, incomplete: walked?.incomplete ?? false };
	}

	/** Why the index may read a module: discovered by scope, or reached by import. Narrower than a claim. */
	async admittedModules(modules: string[]): Promise<AdmittedModule[]> {
		const scope = await this.currentScope();
		let candidates: Set<string> | undefined;
		const answers: AdmittedModule[] = modules.map((requested) => {
			const module = normalizeModulePath(requested);
			const contained = resolveContained(this.workspaceRoot, module);
			if (contained.kind !== "file") return { module, admitted: null };
			const folder = statSync(contained.path, { throwIfNoEntry: false })?.isDirectory() === true;
			let admitted = folder ? null : this.admissionIn(scope, module);
			let cause = scope.cause(module, folder);
			if (folder) {
				candidates ??= new Set([...(scope.known ?? []), ...(this.reachable ?? []), ...this.includedIn(scope)]);
				const omitted = new Set<AdmissionCause>();
				for (const candidate of candidates) {
					if (!candidate.startsWith(`${module}/`)) continue;
					const admission = this.admissionIn(scope, candidate);
					if (admission === "discovered") {
						admitted = admission;
						break;
					}
					if (admission === "imported") admitted = admission;
					if (admission === null) omitted.add(scope.cause(candidate));
				}
				if (cause === "unlisted" && omitted.size === 1) cause = [...omitted][0] as AdmissionCause;
				if (scope.mode === "walk" && cause === "unlisted" && scope.allows(module)) admitted = "discovered";
			}
			return { module, admitted, ...(admitted === null ? { cause } : {}) };
		});
		const unlisted = answers.filter((answer) => answer.cause === "unlisted").map((answer) => answer.module);
		if (scope.mode === "git" && unlisted.length > 0) {
			const ignored = await gitIgnored(this.workspaceRoot, unlisted, this.clock);
			for (const answer of answers)
				if (answer.cause === "unlisted" && ignored?.has(answer.module) === true) answer.cause = "ignored";
		}
		return answers;
	}

	async moduleView(module: string, range?: Range, text?: string): Promise<ModuleView> {
		const scope = await this.currentScope();
		if (scope.denies(module) || resolveContained(this.workspaceRoot, module).kind === "outside")
			return { kind: "withheld" };
		const read = text === undefined ? this.readSource(module) : sourceReadBytes(module, Buffer.from(text, "utf8"));
		if (read.kind !== "text") return { kind: read.kind === "outside" ? "withheld" : read.kind };
		const current = this.secretPolicy.current;
		const view = current.view(read, true);
		if (view.kind === "refused") return { kind: current.admission(read).as === "omit" ? "omit" : "withheld" };
		const shown =
			view.kind === "masked"
				? view.display(range)
				: range === undefined
					? view.text
					: coordinatesOf(view.text).sliceRange(range);
		return shown == null ? { kind: "invalidRange" } : { kind: view.kind, text: shown };
	}

	async moduleSecretModes(modules: ModuleSecretModeRequest[]): Promise<ModuleSecretModeAnswer[]> {
		await this.currentScope();
		const current = this.secretPolicy.current;
		const inputs = modules.map((input) => (typeof input === "string" ? { module: input } : input));
		const entries = inputs.map((input) => ({
			...input,
			textBytes: input.text === undefined ? 0 : Buffer.byteLength(input.text, "utf8"),
		}));
		const requestTooLarge =
			entries.reduce((total, entry) => total + entry.textBytes, 0) > MAX_MODULE_SECRET_MODE_TEXT_BYTES;
		return entries.map(({ module, text, textBytes }) => {
			const answer = current.answer(module);
			if (text === undefined) {
				if (answer.kind !== "matchers") return { module, mode: secretModeOf(current.admission(module).as) };
				const read = this.readSource(module);
				const admission = read.kind === "text" ? current.admission(read) : current.admission(module);
				return { module, mode: secretModeOf(admission.as) };
			}
			if (textBytes > MAX_SOURCE_BYTES || requestTooLarge)
				return {
					module,
					mode: answer.kind === "matchers" ? "redact" : secretModeOf(current.admission(module).as),
				};
			const read = sourceReadBytes(module, Buffer.from(text, "utf8"));
			return { module, mode: secretModeOf(current.admission(read).as) };
		});
	}

	private admissionIn(scope: FileScope, module: string): AdmittedModule["admitted"] {
		if (scope.denies(module)) return null;
		if (scope.allows(module)) return "discovered";
		// Roots already pass `allows`; anything else here came from an import.
		return this.reachable?.has(module) === true ? "imported" : null;
	}

	/** Status, both hashes and the rows from one read: `moduleDeclarations.ts` owns the snapshot. */
	moduleDeclarations(module: string): ModuleDeclarations {
		return moduleDeclarations(module, {
			claimOf: (m) => this.claimOf(m),
			denies: (m) => this.scopeOrThrow().denies(m),
			readSource: this.readSource,
			hashOfRead: (read) => this.hashOfRead(read),
			store: this.store,
		});
	}

	/** Why a request must wait, or null. The one readiness decision; `indexStatus` is diagnostics. */
	warmHold(): string | null {
		// Every synchronous scope read sits behind this gate.
		if (this.scope === null) return "computing the workspace scope";
		if (this.coverage.state === "discovering") {
			if (this.store.readScanSummary()?.outlined === true) return null;
			return "discovering the workspace";
		}
		if (this.coverage.state !== "outlining") return null;
		const unread = this.coverage.pending.size + this.coverage.attempting.size;
		if (unread === 0) return null;
		return `warming the index (${this.status.done} of ${this.status.total} files outlined, ${unread} not yet read)`;
	}

	/** The reason an outline pass threw, which no retry clears. */
	warmFailure(): string | null {
		return this.coverage.state === "failed" ? this.coverage.reason : null;
	}

	/**
	 * Applies a watcher batch, one decision per file.
	 *
	 * Caller-held: the live index takes the gate around the whole batch, since a reindex landing
	 * between the files of one batch is what a batch exists to prevent.
	 *
	 * `shouldAbandon`, checked before each file, lets a daemon on its way out cut the batch short at
	 * a file boundary rather than holding the gate for its whole remainder: every file already
	 * indexed above stays fully written, and what is left is re-read by the next daemon's warm scan,
	 * since its stored hash no longer matches.
	 */
	applyBatch(
		events: FileEvent[],
		shouldAbandon?: () => boolean,
		evidence: readonly EvidenceKind[] = [],
	): Promise<IndexOutcome[]> {
		return this.pass(() => this.applyEvents(events, shouldAbandon, evidence));
	}

	private async applyEvents(
		events: FileEvent[],
		shouldAbandon?: () => boolean,
		suppliedEvidence: readonly EvidenceKind[] = [],
	): Promise<IndexOutcome[]> {
		let effectiveEvents = events;
		const progress = { done: 0, total: events.length };
		const doing: Doing = { kind: "batch", counts: () => progress };
		// Many parses beyond the batch's own files are named and counted, so a long hold reads as what it is.
		const reparsing = (count: number): boolean => {
			if (count < REPARSES_NAMED) return false;
			doing.label = "re-parsing modules";
			progress.done = 0;
			progress.total = count;
			return true;
		};
		this.doing.add(doing);
		try {
			// A batch under a running outline pass would race its loop over the same roots.
			if (this.coverage.state === "discovering" || this.coverage.state === "outlining") {
				throw new Error("live indexing cannot run under the warmup pass");
			}
			if (this.scope === null) {
				await this.currentScopeUnderGate();
				await this.admitted();
			}
			effectiveEvents = this.expandLinkEvents(events);
			progress.total = effectiveEvents.length;
			const evidenceKinds = new Set(suppliedEvidence);
			for (const event of effectiveEvents)
				for (const kind of this.secretPolicy.evidence.inputsFor(event)) evidenceKinds.add(kind);
			const configRefresh = evidenceKinds.has("config");
			const gitRefresh =
				evidenceKinds.has("repositories") || [...evidenceKinds].some((kind) => kind.startsWith("listing:"));
			let refreshedScope: FileScope | undefined;
			let resolutionPolicyChanged = false;
			let policyForgotten: string[] = [];
			for (const event of effectiveEvents)
				if (event.kind === "changed") this.invalidateGeneratedAttributes(event.module);
			const previousScope = this.scope;
			const previousRevision = this.secretPolicy.current.revision;
			const policyChange = await this.secretPolicy.refresh({
				kind: "events",
				modules: effectiveEvents.map((event) => event.module),
				changed: effectiveEvents
					.filter((event) => event.kind === "changed" && this.store.contentHashOf(event.module) === null)
					.map((event) => event.module),
				evidence: suppliedEvidence,
			});
			const refreshScope =
				policyChange.affected === "all" ||
				policyChange.affected.modules.size > 0 ||
				policyChange.affected.prefixes.length > 0 ||
				policyChange.admissionMoved;
			if (refreshScope) {
				refreshedScope = this.scopeOrThrow();
				resolutionPolicyChanged =
					previousScope === null ||
					JSON.stringify([previousRevision, previousScope.bundles]) !==
						JSON.stringify([this.secretPolicy.current.revision, refreshedScope.bundles]);
				policyForgotten = this.reconcilePolicy();
			}
			this.observeEvents(effectiveEvents);
			progress.total = effectiveEvents.length;
			const guardedEvents = effectiveEvents.map((event) => {
				if (event.kind !== "changed") return event;
				if (this.secretPolicy.current.answer(event.module).kind === "plain") return event;
				const read = this.readSource(event.module);
				if (this.secretPolicy.current.admission(read).as === "plain") return event;
				return { ...event, contentHash: hashOfView(this.secretPolicy.current.view(read)) };
			});
			const decisions = guardedEvents.map((event) =>
				decideInvalidation(event, {
					route: (module) => this.supervisor.route(module),
					readsItself: (module) => this.readsItself(module),
					indexedHash: (module) => this.store.contentHashOf(module),
				}),
			);
			// A module whose refusal holds its debt waits on its own event, and bytes restored to what the
			// index holds are one: the debt is paid by the pump, since the batch has nothing to parse.
			const unchanged = decisions.filter(
				(decision) => decision.action === "ignore" && decision.reason === UNCHANGED_REASON,
			);
			const restored = this.store.refusalBlocked(unchanged.map((decision) => decision.module));
			if (restored.length > 0) {
				this.store.unblockRebinds(restored);
				this.queueRebinds();
			}
			// Decided before admission: a save that changed nothing asks neither git nor a provider.
			if (unchanged.length === decisions.length && !refreshScope) {
				return decisions.map((decision) => this.outcome(decision.module, "current", UNCHANGED_REASON));
			}
			this.newInPass = new Set();
			const outcomes: IndexOutcome[] = [];
			const previousRoots = this.roots;
			const previousDepths = this.depths;
			const changed = effectiveEvents.filter((event) => event.kind === "changed").map((event) => event.module);
			const newFiles = changed.filter((module) => this.store.contentHashOf(module) === null);
			const deleted = effectiveEvents.filter((event) => event.kind === "deleted").map((event) => event.module);
			for (const files of this.discovered.values()) for (const module of deleted) files.delete(module);
			// Asked of the config files as providers named them before this batch: a restated project
			// may stop naming the very file that restated it.
			// A provider whose config the batch touched states its project, and its files, before
			// anything is read under it or the roots are counted.
			const restated = await this.restatements(
				decisions.map((decision) => decision.module),
				configRefresh,
			);
			const roots = await this.rootModules(newFiles, deleted, refreshedScope);
			this.roots = roots;
			this.depths = new Map([...roots].map((module) => [module, this.rootDepth(module)]));
			for (const module of policyForgotten) {
				if (previousRoots.has(module) && !roots.has(module))
					outcomes.push(this.outcome(module, "unclaimed", "no longer a root or reachable", true));
			}
			// A provider resolves against the files on DISK, not against what this index holds, so only a
			// file arriving or leaving, or a config restating the rules, moves where a specifier lands.
			// Editing a body moves none of them, which is the ordinary batch. Asked of the roots the scope
			// just decided, so a write the workspace does not admit retires nothing.
			const rootsChanged =
				[...previousRoots].some((module) => !roots.has(module)) ||
				[...roots].some((module) => !previousRoots.has(module));
			const moved =
				(resolutionPolicyChanged && refreshScope) ||
				restated.length > 0 ||
				rootsChanged ||
				decisions.some(
					(decision) =>
						decision.action === "forget" ||
						this.configFiles.has(decision.module) ||
						(roots.has(decision.module) && this.store.contentHashOf(decision.module) === null),
				);
			if (moved) this.caches.resolutions.invalidate();
			// Persisted here too, or a watcher batch leaves overview describing the previous scan.
			this.writeScanSummary();
			const attempted = new Set<string>();
			// Only roots new to this batch owe an attempt; an earlier root with no row already failed one.
			const pending = new Set(
				[...roots].filter((module) => !previousRoots.has(module) && this.store.depthOf(module) === null),
			);

			let abandoned = false;
			for (const [decided, decision] of decisions.entries()) {
				progress.done = decided;
				if (shouldAbandon?.() === true) {
					abandoned = true;
					break;
				}
				if (decision.action === "forget") {
					pending.delete(decision.module);
					const admission = this.secretPolicy.current.admission(decision.module);
					outcomes.push(
						this.outcome(
							decision.module,
							"missing",
							undefined,
							this.forgetFile(decision.module, admission),
						),
					);
					continue;
				}
				if (decision.action === "ignore") {
					pending.delete(decision.module);
					const cause = decision.reason === UNCHANGED_REASON ? "current" : "unclaimed";
					outcomes.push(this.outcome(decision.module, cause, decision.reason));
					continue;
				}
				if (!roots.has(decision.module) && this.store.contentHashOf(decision.module) === null) {
					pending.delete(decision.module);
					outcomes.push(this.outcome(decision.module, "unclaimed", "outside roots and reachability"));
					continue;
				}
				attempted.add(decision.module);
				pending.delete(decision.module);
				try {
					const outcome = await this.parseAndStore(
						decision.module,
						this.depths.get(decision.module) ?? this.rootDepth(decision.module),
					);
					outcomes.push(outcome);
					if (outcome.action === "forgotten") roots.delete(decision.module);
				} catch (error) {
					outcomes.push(this.faultOutcome(decision.module, error));
				}
			}

			if (!abandoned) {
				progress.done = decisions.length;
				const reread = [...roots].filter((module) => {
					// A parse failure is about the file's own bytes, so only its own event can mean they moved.
					const refused = previousRoots.has(module) && this.store.parseFailureOf(module) !== null;
					// Preserve cached facts across git-only refreshes.
					if (gitRefresh && !configRefresh && this.store.contentHashOf(module) !== null) return false;
					const current =
						this.store.contentHashOf(module) !== null &&
						previousRoots.has(module) &&
						settledDepth(previousDepths.get(module)) === settledDepth(this.depths.get(module));
					return !attempted.has(module) && !refused && !current;
				});
				const counted = reparsing(reread.length);
				for (const module of reread) {
					if (shouldAbandon?.() === true) {
						abandoned = true;
						break;
					}
					try {
						pending.delete(module);
						const outcome = await this.indexOne(module);
						outcomes.push(outcome);
						if (outcome.action === "forgotten") roots.delete(module);
					} catch (error) {
						outcomes.push(this.faultOutcome(module, error));
					}
					if (counted) progress.done++;
				}
			}

			// Cut short at a file boundary: nothing further here runs against a batch that stopped
			// partway, and the abandoned roots stay pending for the next daemon's warm scan to pick up.
			if (abandoned) return outcomes;
			const restating = reparsing(
				new Set(restated.flatMap(({ written }) => written.filter((module) => !attempted.has(module)))).size,
			);
			for (const { providerId, fingerprint, written } of restated) {
				for (const module of written) {
					if (attempted.has(module)) continue;
					// Cut short at a file boundary, the project stays unrecorded, so the next warm scan restates the rest.
					if (shouldAbandon?.() === true) return outcomes;
					attempted.add(module);
					try {
						outcomes.push(await this.indexOne(module, this.store.depthOf(module) ?? undefined));
					} catch (error) {
						outcomes.push(this.faultOutcome(module, error));
					}
					if (restating) progress.done++;
				}
				// Recorded once every module it reads took a parse under it; otherwise the next warm scan
				// restates it again.
				if (this.readAllUnder(providerId, outcomes, new Set(written)))
					this.store.recordProjectFingerprint(providerId, fingerprint);
			}

			const seen = new Set(roots);
			outcomes.push(...(await this.followImports(seen, { indexExisting: false, previousDepths, step: held })));
			// A file the batch left unread takes the verdict its admission reached, a .gitattributes edit included.
			this.store.syncGenerated(this.generated);
			outcomes.push(...this.prune(seen));
			this.sweepAfterPrune(seen);
			outcomes.push(...(await this.rebindDependents(outcomes, shouldAbandon)));
			if (pending.size !== 0) throw new Error(`live indexing left ${pending.size} root(s) unattempted`);
			if (this.coverage.state !== "failed") this.coverage = { state: "covered" };
			// A module created or deleted by this batch renews the evidence snapshot with what the batch
			// actually settled on, not the admission taken before its per-file forgets and import closure ran.
			if (this.lastAdmitted !== null) {
				const created = [...seen].some((module) => !previousRoots.has(module));
				const removed = [...previousRoots].some((module) => !seen.has(module));
				if (created || removed) this.lastAdmitted = { ...this.lastAdmitted, reachable: [...seen] };
			}
			return outcomes;
		} finally {
			this.doing.delete(doing);
		}
	}

	private expandLinkEvents(events: readonly FileEvent[]): FileEvent[] {
		const observed = new Set(events.map((event) => event.module));
		const aliases = new Map<string, FileEvent>();
		for (const event of events)
			for (const module of this.secretPolicy.evidence.aliasesOf(event.module))
				if (!observed.has(module)) aliases.set(module, { kind: "changed", module, contentHash: null });
		return [...events, ...aliases.values()];
	}
}
