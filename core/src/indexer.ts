// Getting facts in, and the only module that changes what the index holds.
//
// Two writers race and the loser leaves a plausible-looking index, so a residue test holds this as
// the only one. Reaches wide on purpose: indexing IS reading files and asking providers.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type {
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
	ModuleStatus,
} from "@nyaa-lexicon/protocol";
import { defined, hashContent } from "@nyaa-lexicon/protocol";
import type { Clock, TimerHandle } from "./clock.js";
import { attachComments } from "./commentAttach.js";
import { FactAdmissionError } from "./factAdmission.js";
import {
	type FileScope,
	fileScopeFor,
	type GeneratedVerdict,
	generatedVerdicts,
	gitIgnored,
	includedFiles,
} from "./fileScope.js";
import { importTarget } from "./imports.js";
import type { FileEvent } from "./invalidation.js";
import { decideInvalidation, UNCHANGED_REASON } from "./invalidation.js";
import { type ModuleClaim, moduleDeclarations, statusOf } from "./moduleDeclarations.js";
import { patternDigests } from "./patternDigest.js";
import type { MethodResponse, ProviderPort } from "./providerPort.js";
import type { ResultCache } from "./resultCache.js";
import {
	insideWorkspace,
	OUTSIDE_WORKSPACE_REASON,
	readHead,
	type SourceReader,
	unreadableReason,
} from "./sourceRead.js";
import type { FileNote, IndexStore, SurfaceChange } from "./store.js";
import type { ModulePresence, SweepReport } from "./subjects.js";
import { ProviderUnavailableError } from "./supervisor.js";
import type { WatchScope } from "./watcher.js";
import type { WorkspaceGate } from "./workspaceGate.js";

export type { IndexOutcome, IndexStatus } from "@nyaa-lexicon/protocol";

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

/** Of overlapping works, the one a status names first: each holds or waits out those after it. */
const ACTIVITY_ORDER: ReadonlyArray<IndexActivity["kind"]> = ["refactor", "batch", "scan", "rebind", "upgrade"];

/** The depth a pass ends at: an outline floor is a first read the pump carries to full. */
function settledDepth(depth: IndexDepth | undefined): IndexDepth | undefined {
	return depth === "outline" ? "full" : depth;
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

/** Dependents one batch parses again itself; the rest wait for the background pump. */
export const REBIND_CAP = 64;

/** The first wait before asking again after a resolver fault left moves pending; it doubles to the cap. */
export const RESOLVE_RETRY_MS = 1_000;

const RESOLVE_RETRY_MAX_MS = 60_000;

/**
 * Two questions with two lifetimes, so one turnover rule cannot serve both.
 *
 * A stored answer is drawn from facts and dies the moment any fact moves. Where a specifier LANDS
 * is not drawn from facts: it survives every edit to a file's body, and only moves when the set of
 * modules changes or a provider's config does. Keeping them in one cache made the second question
 * as expensive as the first, which is a whole workspace of provider round trips on every batch.
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

/** Import targets both ways, so a write refreshes its own module's entries alone. */
interface ImporterIndex {
	generation: number;
	byTarget: Map<string, Set<string>>;
	targetsOf: Map<string, Set<string>>;
	/** Settles once the whole read that built it has; undefined only while it is being made. */
	ready: Promise<void> | undefined;
}

/** Outcomes that leave a module's facts unread under the reading asked for. */
const UNREAD: ReadonlySet<IndexCause | undefined> = new Set(["parseFailed", "providerDown", "fault"]);

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
		private readonly resolve: (fromModule: string, specifier: string) => Promise<ImportResolution>,
		private readonly clock: Clock,
		/** The service's one gate. Every road this indexer drives itself takes it, one file at a time. */
		private readonly gate: WorkspaceGate,
	) {
		// A route asked before the first scan still sees the workspace, from whatever admission last
		// completed: evidenceFrom is synchronous, and admission now asks git asynchronously.
		supervisor.evidenceFrom(() => this.lastAdmitted?.reachable ?? []);
		supervisor.headFrom((module) => readHead(this.workspaceRoot, module));
		// A provider process starting again may answer what its predecessor failed or refused.
		supervisor.respawnedFrom(() => this.queueRebinds());
	}

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
	/** For the synchronous evidence callback alone: as fresh as the last admission, which every create or delete renews. */
	private lastAdmitted: Admitted | null = null;
	/** Each provider's discovered files, replaced whole whenever it states its project again. */
	private discovered = new Map<string, Set<string>>();
	private roots = new Set<string>();
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
	/** Debt was owed since the pump last started through it; a run tries each owed module once. */
	private rebindQueued = false;
	private rebindCursor: string | null = null;
	/** Moved modules whose importers a resolver fault left unread; the next run asks again. */
	private readonly resolvePending = new Set<string>();
	/** The armed retry for `resolvePending`, and the wait the next one takes. */
	private resolveRetry: TimerHandle | null = null;
	private resolveRetryMs = RESOLVE_RETRY_MS;
	/** Who imports each module, by where each import landed, for one resolution generation. */
	private importers: ImporterIndex | null = null;
	/** Modules whose import rows were written since the index last read them. */
	private readonly importsWritten = new Set<string>();

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

	/**
	 * Asks git for the scope. Only a first computation, with no prior scope to fall back on, records
	 * the failure the way a failed warmup pass does, so a request refuses with the reason instead of
	 * a caller meeting a bare rejection. A later refresh failing keeps serving the scope already held;
	 * its caller's own error handling logs it, and the next batch or warm retries. Never caches a
	 * rejection: the field this writes to stays untouched on failure, so the next call retries.
	 */
	private async computeScope(): Promise<FileScope> {
		try {
			return await fileScopeFor(this.workspaceRoot, undefined, this.clock);
		} catch (error) {
			if (this.scope === null) {
				this.coverage = { state: "failed", reason: error instanceof Error ? error.message : String(error) };
			}
			throw error;
		}
	}

	/** Refreshed at the start of every scan. Public for the resolver's surface globs. */
	async currentScope(): Promise<FileScope> {
		this.scope ??= await this.computeScope();
		return this.scope;
	}

	/**
	 * The scope as a synchronous road may read it: already computed by an earlier `currentScope()`
	 * or a scan, never git asked fresh. Every caller here runs only after that has happened.
	 */
	private scopeOrThrow(): FileScope {
		if (this.scope === null) throw new ScopeNotComputedError();
		return this.scope;
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
			admits: (module) => {
				const scope = this.scopeOrThrow();
				if (scope.allows(module) || this.store.contentHashOf(module) !== null) return true;
				return this.configFiles.has(module) && !scope.denies(module);
			},
			ignored: (modules) => gitIgnored(this.workspaceRoot, modules, this.clock),
		};
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
		if (this.lastAdmitted === null) await this.admitted();
		else await this.currentScope();
		const claim = this.claimOf(module);
		if (!claim.claimed) return this.unadmitted(module, claim.unclaimedReason);

		const read = this.readSource(module);
		if (read.kind === "outside") return this.unadmitted(module, OUTSIDE_WORKSPACE_REASON);
		if (read.kind === "missing") {
			return this.outcome(module, "missing", undefined, this.forgetFile(module));
		}
		if (read.kind !== "text") {
			// Whatever it held before is not this file; the failure says why it holds nothing now.
			const forgotten = this.forgetFile(module);
			const failure = unreadableReason(read);
			this.store.recordFailure(module, failure);
			this.upgradeFailed.add(module);
			return this.outcome(module, read.kind, failure, forgotten);
		}
		const text = read.text;
		// Read, so it exists: evidence for a shared claim that no scan has seen.
		this.supervisor.observeModule(module);

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
		const readHash = hashContent(text);

		// Preserve deeper facts when owner matches or is unrecorded, and the project reads files as it did.
		const writer = this.store.writerOf(module);
		if (
			skipIfCurrent &&
			!this.restated.has(parser.providerId) &&
			this.store.contentHashOf(module) === readHash &&
			(writer ?? parser.providerId) === parser.providerId
		) {
			const held = this.store.depthOf(module);
			const satisfied = held === "full" || held === "surface" || held === depth;
			if (satisfied) {
				// Final facts outrank a failure row.
				if (held !== "outline") this.store.clearFailure(module);
				// A row from before content was recorded learns it without a parse.
				this.store.recordContent(module, parser.content);
				return this.outcome(module, "current");
			}
		}

		let facts: MethodResponse<"parseFile">;
		try {
			facts = await this.supervisor.askProvider(parser.providerId, "parseFile", {
				module,
				contentHash: readHash,
				text,
				...(depth === "full" ? {} : { depth }),
			});
		} catch (error) {
			const failure = error instanceof Error ? error.message : String(error);
			if (error instanceof ProviderUnavailableError) {
				// An outage, not a refusal: the index keeps what it had and nobody is there to tell.
				this.providerFailures.set(module, failure);
				return this.outcome(module, "providerDown", failure);
			}
			return this.refuseParse(answered, module, readHash, failure);
		}
		const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		if (errors.length > 0) {
			// An answer, not a throw: the file is the reason, and a caller reindexing a restored file
			// must not fail on it. Recorded here so every caller's failure reaches coverage.
			return this.refuseParse(answered, module, readHash, errors.map((d) => d.message).join("; "));
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
		// Where a re-export lands is what its importers bind through, so it is part of the surface; where
		// any import landed names this module once that target goes.
		const importTargets = await this.importTargets(module, facts.imports);
		try {
			this.store.replaceFile({
				module,
				contentHash: readHash,
				declarations: facts.declarations,
				references: facts.references,
				imports: facts.imports,
				// Shallow parses store no comments or literals.
				literals: storedDepth === "full" ? facts.literals : [],
				depth: storedDepth,
				comments:
					storedDepth === "full"
						? attachComments(facts.declarations, facts.comments ?? [], text, facts.blankLines)
						: [],
				docs: facts.docs ?? [],
				notes,
				content: parser.content,
				provider: parser.providerId,
				// A shallow parse reports no comments, so only a full one can say what a digest covers; the
				// supervisor drops a comments field from a provider that never declared the tier.
				digests:
					storedDepth === "full"
						? patternDigests(facts.declarations, facts.comments, facts.literals, text)
						: [],
				generated: generatedVerdict,
				role: facts.role,
				importTargets,
			});
		} catch (error) {
			// An answer the store refuses is the provider's answer for THIS file, so it is the file's failure.
			if (error instanceof FactAdmissionError) {
				return this.refuseParse(
					answered,
					module,
					readHash,
					`the provider's answer was refused: ${error.message}`,
				);
			}
			// Any other store failure committed nothing either, and the provider is holding this parse.
			// Answered rather than rethrown, so the fault is recorded before the provider is told.
			const outcome = this.faultOutcome(module, error);
			this.publish(answered, {
				module,
				contentHash: readHash,
				outcome: { status: "refused", reason: indexerFault(error) },
			});
			return outcome;
		}
		// Committed, so the provider is told what the index holds rather than what it is about to.
		this.publish(answered, { module, contentHash: readHash, outcome: { status: "admitted" } });
		this.importsWritten.add(module);
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
			const landed = await this.resolve(module, statement.specifier).catch(() => null);
			const target = landed === null ? null : importTarget(landed);
			if (target !== null && !stats.has(target.module)) stats.set(target.module, this.fileStat(target.module));
		}
	}

	/** Where each of a write's imports lands, when the resolver can say. */
	private async importTargets(module: string, imports: readonly Import[]): Promise<Map<string, string>> {
		const targets = new Map<string, string>();
		for (const statement of imports) {
			if (targets.has(statement.specifier)) continue;
			const landed = await this.resolve(module, statement.specifier).catch(() => null);
			const target = landed === null ? null : importTarget(landed);
			if (target !== null) targets.set(statement.specifier, target.module);
		}
		return targets;
	}

	/**
	 * The index takes none of this parse and keeps the file's previous facts.
	 *
	 * Recorded before it is published, so a provider is never told a verdict the index has not
	 * taken. The provider is told because the refusal happens after it answered: its own cross-file
	 * state holds the facts this just declined, and nothing else would ever say so.
	 */
	private refuseParse(answered: Parser, module: string, contentHash: string, failure: string): IndexOutcome {
		this.store.recordFailure(module, failure);
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
		return this.during(this.scanning(), () => this.scanWorkspace("full", onProgress));
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
		return this.during(this.scanning(), () => this.scanWorkspace("outline", onProgress));
	}

	private async scanWorkspace(
		floor: "full" | "outline",
		onProgress?: (done: number, total: number) => void,
	): Promise<IndexOutcome[]> {
		if (floor === "outline") this.coverage = { state: "discovering" };
		this.status = { state: "discovering", done: 0, total: 0 };
		try {
			this.newInPass = new Set();
			this.discovered = new Map();
			this.configFiles = new Map();
			// The workspace is being re-learned, so nothing a previous pass was told still vouches
			// for itself. Once, rather than per file: a scan reads what is already on disk.
			this.caches.resolutions.invalidate();
			const fingerprints = new Map<string, string>();
			for (const provider of this.supervisor.running()) {
				const project = await this.discover(provider.providerId);
				if (project.fingerprint !== undefined) fingerprints.set(provider.providerId, project.fingerprint);
			}
			this.restated = new Set(
				[...fingerprints]
					.filter(([providerId, fingerprint]) => fingerprint !== this.store.projectFingerprint(providerId))
					.map(([providerId]) => providerId),
			);

			// One hold: the summary must not describe a root set another road has already moved past.
			const pending = await this.alone(async () => {
				this.roots = await this.rootModules();
				this.depths = new Map([...this.roots].map((module) => [module, this.scanDepth(module, floor)]));
				// Roots with no row at any depth; a failed root has none and is attempted again here.
				const missing = new Set([...this.roots].filter((module) => this.store.depthOf(module) === null));
				// A completed mark survives a rescan only while nothing is missing.
				this.writeScanSummary(missing.size === 0 && this.store.readScanSummary()?.outlined === true);
				return missing;
			});
			// Each file as the scan first looked at it, so a change during the scan is seen at its end: a
			// root as the scan began, an imported module once a module importing it was parsed.
			const firstStats = new Map([...this.roots].map((module) => [module, this.fileStat(module)]));
			if (floor === "outline") {
				this.coverage =
					pending.size === 0 ? { state: "covered" } : { state: "outlining", pending, attempting: new Set() };
			}
			const modules = [...this.roots];

			const outcomes: IndexOutcome[] = [];
			const seen = new Set<string>();
			const scanning = floor === "outline" ? "warming" : "indexing";
			this.status = { state: scanning, done: 0, total: modules.length };
			for (const [done, module] of modules.entries()) {
				if (floor === "outline" && this.coverage.state === "outlining") {
					this.coverage.pending.delete(module);
					this.coverage.attempting.add(module);
				}
				const outcome = await this.alone(async () => {
					try {
						return await this.indexOne(module, undefined, floor === "outline");
					} catch (error) {
						return this.faultOutcome(module, error);
					}
				});
				if (floor === "outline" && this.coverage.state === "outlining") this.coverage.attempting.delete(module);
				await this.noteReached(module, firstStats);
				outcomes.push(outcome);
				if (outcome.action === "forgotten") this.roots.delete(module);
				else seen.add(module);
				this.status = { state: scanning, done: done + 1, total: modules.length };
				onProgress?.(done + 1, modules.length);
			}

			outcomes.push(
				...(await this.followImports(seen, {
					indexExisting: true,
					floor,
					step: (work) => this.alone(work),
					reached: (module) => this.noteReached(module, firstStats),
				})),
			);
			// An outage is a file value, not a workspace refusal, but the summary cannot claim a full outline.
			const outaged = outcomes.some((outcome) => outcome.cause === "providerDown");
			// One hold: nothing may read an index half pruned of what this pass no longer reaches.
			outcomes.push(
				...(await this.alone(async () => {
					this.store.syncGenerated(this.generated);
					const pruned = this.prune(seen);
					this.sweepAfterPrune(seen);
					this.writeScanSummary(!outaged);
					// Recorded only where every module was admitted under it; an outage, a refusal or a
					// fault leaves the old one, so the next scan restates again.
					for (const [providerId, fingerprint] of fingerprints) {
						if (!this.readAllUnder(providerId, outcomes)) continue;
						this.store.recordProjectFingerprint(providerId, fingerprint);
						this.restated.delete(providerId);
					}
					return pruned;
				})),
			);
			// A module whose bytes moved while nothing watched leaves its unchanged dependents stale, and
			// so does a move a stopped daemon never answered. Read whole, inside a hold.
			const moves = await this.alone(async () => this.pendingMoves(null));
			const order = new Map<string, number>();
			for (const [at, outcome] of outcomes.entries())
				if (outcome.action !== "skipped") order.set(outcome.module, at);
			// A provider reads from disk a module it holds no parse of, so only a module that held a surface
			// before, or whose file changed after the scan first looked at it, since a provider may have read
			// it for an earlier dependent, can have left a module this scan wrote earlier reading a stale one.
			const stale = (module: string, change: SurfaceChange) =>
				change.heldBefore || (firstStats.has(module) && this.fileStat(module) !== firstStats.get(module));
			const unwritten = this.store.indexedFiles().some((module) => !order.has(module));
			if (unwritten || [...moves].some(([module, change]) => stale(module, change)))
				await this.oweDependents(moves, order, stale);
			else this.settle(moves, []);
			// Debt a stopped daemon left owed is the pump's to pay.
			if (this.store.owedRebindAfter(null) !== null) this.queueRebinds();
			this.status = { state: "ready", done: outcomes.length, total: outcomes.length };
			this.coverage = { state: "covered" };
			return outcomes;
		} catch (error) {
			if (floor === "outline")
				this.coverage = { state: "failed", reason: error instanceof Error ? error.message : String(error) };
			throw error;
		}
	}

	/** Asks one provider for its project, noting its files and the config it consults. */
	private async discover(providerId: string): Promise<MethodResponse<"discoverProject">> {
		const project = await this.supervisor.askProvider(providerId, "discoverProject", {
			workspaceRoot: this.workspaceRoot,
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
	): Promise<Array<{ providerId: string; fingerprint: string; written: string[] }>> {
		const providers = new Set(modules.flatMap((module) => [...(this.configFiles.get(module) ?? [])]));
		const owed: Array<{ providerId: string; fingerprint: string; written: string[] }> = [];
		for (const providerId of providers) {
			const project = await this.discover(providerId);
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
		const owed = modules.filter((module) => {
			const depth = this.store.depthOf(module);
			return depth === "outline";
		});
		if (owed.length === 0) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			this.orders.push({ modules: owed, resolve, reject });
			this.ensurePumping();
		});
	}

	/** Drains the outline backlog, yielding between files. */
	upgradeRemaining(): Promise<void> {
		this.upgradeWanted = true;
		this.ensurePumping();
		return this.pumping ?? Promise.resolve();
	}

	private ensurePumping(): void {
		if (this.pumping !== null) return;
		const run = this.pump().finally(() => {
			this.pumping = null;
			// Restart if work arrived before completion.
			if (this.orders.length > 0 || this.unasked.size > 0 || this.rebindQueued || this.upgradeWanted)
				this.ensurePumping();
		});
		// Whoever awaits the run hears its fault; a run nobody awaits must not surface as unhandled.
		run.catch(() => {});
		this.pumping = run;
	}

	/**
	 * The one background parse loop. Orders first, then who binds against what single-file roads
	 * wrote, then owed rebinds, then the store's outline backlog, one file per turn.
	 *
	 * A fault no parse caught, such as a store closed under the run, ends it and rejects it, and
	 * nothing restarts it: what is owed stays in the store for the next start.
	 */
	private async pump(): Promise<void> {
		try {
			this.startRun();
			await this.pumpTurns();
		} catch (error) {
			this.upgradeWanted = false;
			this.unasked.clear();
			this.rebindQueued = false;
			for (const order of this.orders.splice(0)) order.reject(error);
			throw error;
		}
	}

	/** Each run tries every payable debt once; a provider or daemon that restarted since a parse failed is asked again. */
	private startRun(): void {
		this.rebindCursor = null;
		this.rebindQueued = false;
		const restarted = this.store
			.blockedRebinds()
			.filter((debt) => debt.blockedIn !== this.processOf(debt.blockedBy))
			.map((debt) => debt.module);
		if (restarted.length > 0) this.store.unblockRebinds(restarted);
		for (const module of this.resolvePending) this.unasked.add(module);
		this.resolvePending.clear();
	}

	private async pumpTurns(): Promise<void> {
		while (true) {
			const order = this.orders.shift();
			if (order !== undefined) {
				try {
					for (const module of order.modules) {
						// Cheap skip before the hold; `upgradeOne` re-reads it inside.
						if (this.store.depthOf(module) !== "outline") continue;
						await this.during({ kind: "upgrade" }, () => this.upgradeOne(module));
					}
					order.resolve();
				} catch (error) {
					order.reject(error);
				}
				continue;
			}

			if (await this.during({ kind: "rebind" }, () => this.rebindStep())) continue;

			if (!this.upgradeWanted) return;
			const backlog = this.store.outlineModules().filter((module) => !this.upgradeFailed.has(module));
			const next = backlog[0];
			if (next === undefined) {
				this.upgradeWanted = false;
				this.status = { state: "ready", done: this.status.total, total: this.status.total };
				return;
			}
			this.status = {
				state: "upgrading",
				done: Math.max(0, this.status.total - backlog.length),
				total: Math.max(this.status.total, backlog.length),
			};
			await this.during(
				{ kind: "upgrade", counts: () => ({ done: this.status.done, total: this.status.total }) },
				() => this.upgradeOne(next),
			);
		}
	}

	/** One turn of rebind work: who binds against single-file writes, else one owed module. False when idle. */
	private async rebindStep(): Promise<boolean> {
		if (this.unasked.size > 0) {
			// Read inside a hold, so the road that wrote them has let go of every module it wrote.
			const { written, moves } = await this.alone(async () => {
				const modules = [...this.unasked];
				this.unasked.clear();
				return { written: modules, moves: this.pendingMoves(modules) };
			});
			// In the order that road wrote them.
			await this.oweDependents(moves, new Map(written.map((module, at) => [module, at])));
			return true;
		}
		const owed = this.store.owedRebindAfter(this.rebindCursor);
		if (owed === null) return false;
		this.rebindCursor = owed;
		await this.rebindOne(owed);
		return true;
	}

	/** Attempts one outline module without discarding stored facts on failure. */
	private async upgradeOne(module: string): Promise<void> {
		await this.alone(async () => {
			// Read inside the hold: a batch waiting on it may have upgraded or forgotten the module,
			// and the backlog was listed before this road's turn came around.
			if (this.store.depthOf(module) !== "outline") return;
			this.depths.set(module, "full");
			try {
				const outcome = await this.indexOne(module, "full");
				// A row skipped for scope or ownership stays outline in the store, so it must leave the
				// backlog or the pump spins on it forever.
				if (outcome.action === "skipped") this.upgradeFailed.add(module);
			} catch (error) {
				this.faultOutcome(module, error);
			}
		});
		// An outline may hold fewer declarations than the full parse that replaced it.
		await this.oweDependents(this.pendingMoves([module]), new Map([[module, 0]]));
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
		if (this.scopeOrThrow().denies(module)) return this.unadmitted(module, "denied by scope");
		return this.parseAndStore(module, depth, skipIfCurrent);
	}

	/** A module nothing may index keeps no facts. */
	private unadmitted(module: string, reason: string): IndexOutcome {
		const held = this.store.contentHashOf(module) !== null || this.store.parseFailureOf(module) !== null;
		return this.outcome(module, "unclaimed", reason, held && this.forgetFile(module));
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

	private faultOutcome(module: string, error: unknown): IndexOutcome {
		const failure = error instanceof Error ? error.message : String(error);
		// Recorded under its own wording, so the file shows among the failures without being blamed.
		this.store.recordFailure(module, indexerFault(error));
		this.upgradeFailed.add(module);
		return this.outcome(module, "fault", failure);
	}

	/** Whether anything will index a module: the scope's word, then the routing's. */
	claimOf(module: string): ModuleClaim {
		if (this.scopeOrThrow().denies(module)) return { claimed: false, unclaimedReason: "denied by scope" };
		const route = this.supervisor.route(module);
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
					const landed = await this.resolve(module, statement.specifier).catch(() => null);
					const target = landed === null ? null : importTarget(landed);
					if (target === null || this.scopeOrThrow().denies(target.module)) continue;
					const depth = this.scopeOrThrow().surface(target.module)
						? "surface"
						: floor === "outline" && target.depth === "full"
							? "outline"
							: target.depth;
					const prior = this.depths.get(target.module);
					if (seen.has(target.module) && !(prior === "surface" && depth === "full")) continue;
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
					settledDepth(previousDepths.get(module)) === settledDepth(this.depths.get(module))
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
			outcomes.push(this.outcome(module, "unclaimed", "no longer a root or reachable", this.forgetFile(module)));
		}
		// A failure row for a file that was never stored has no files row to sweep it away with.
		for (const { module } of this.store.parseFailures()) {
			if (!reachable.has(module) && this.store.contentHashOf(module) === null) this.store.clearFailure(module);
		}
		return outcomes;
	}

	/** Every module the scope admits, owned by a provider or not. Rebuilds the scope from git each time. */
	private async admitted(extra: Iterable<string> = [], gone: Iterable<string> = []): Promise<Admitted> {
		this.scope = await this.computeScope();
		const named = includedFiles(this.workspaceRoot, this.scope.include);
		const namedSet = new Set(named);
		const goneSet = new Set(gone);
		const discovered = [...this.discovered.values()].flatMap((files) => [...files]);
		const everything = [...new Set([...(this.scope.known ?? []), ...discovered, ...named, ...extra])].filter(
			(module) => !goneSet.has(module),
		);
		const candidates = everything.filter((module) => this.scope?.allows(module) ?? true);
		this.generated = await generatedVerdicts(this.workspaceRoot, candidates, this.clock);
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

	private async rootModules(extra: Iterable<string> = [], gone: Iterable<string> = []): Promise<Set<string>> {
		const { everything, candidates, reachable } = await this.admitted(extra, gone);
		// Evidence before ownership: a shared claim is decided by what the scope admits.
		this.supervisor.observeWorkspace(reachable);
		const roots = new Set(reachable.filter((module) => this.supervisor.route(module).owned));
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
			dropped = this.store.forgetFile(module) || dropped;
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

	private forgetFile(module: string): boolean {
		const removed = this.store.forgetFile(module);
		this.importsWritten.add(module);
		// Told regardless: a provider may still hold the file.
		this.supervisor.forget(module);
		this.caches.facts.invalidate();
		return removed;
	}

	/**
	 * The moves still pending for `modules`, or for every module when null. Read, not taken: a road
	 * acknowledges them only with the debt it owes for them, so a stop in between loses neither.
	 */
	private pendingMoves(modules: Iterable<string> | null): Map<string, SurfaceChange> {
		return this.store.surfaceMovesOf(modules === null ? null : [...modules]);
	}

	/** Writes the debt and acknowledges the moves it answers in one transaction, then starts the pump. */
	private settle(moves: ReadonlyMap<string, SurfaceChange>, owed: readonly string[]): void {
		this.store.settleMoves(moves, owed);
		if (owed.length > 0) this.queueRebinds();
	}

	private queueRebinds(): void {
		this.rebindQueued = true;
		this.ensurePumping();
	}

	/**
	 * Keeps moves a resolver fault left unanswered pending, and arms one retry: a run then asks again.
	 * Each retry that finds them still pending waits twice as long, to a cap, so a provider that stays
	 * down is not asked in a loop.
	 */
	private retryResolving(moved: Iterable<string>): void {
		for (const module of moved) this.resolvePending.add(module);
		if (this.resolveRetry !== null) return;
		const wait = this.resolveRetryMs;
		this.resolveRetryMs = Math.min(wait * 2, RESOLVE_RETRY_MAX_MS);
		this.resolveRetry = this.clock.setTimer(() => {
			this.resolveRetry = null;
			// Queued rather than only started, so a run already going starts another after it.
			this.queueRebinds();
		}, wait);
	}

	/**
	 * Holds a failed rebind back: an outage until its provider answers again, a refusal until its own
	 * file parses; either until the daemon or the provider restarts.
	 */
	private holdRebind(module: string, outcome: IndexOutcome): void {
		const route = this.supervisor.route(module);
		if (!route.owned) return;
		const reason = outcome.cause === "parseFailed" ? "refusal" : "outage";
		this.store.blockRebind(module, route.providerId, reason, this.processOf(route.providerId));
	}

	/** This daemon and the provider process answering now, so a restart of either reads as new. */
	private processOf(providerId: string): string {
		return `${this.epoch}:${this.supervisor.incarnationOf(providerId) ?? "none"}`;
	}

	/**
	 * Parses again the modules that bind against a surface this batch moved, so their references see
	 * it without an edit of their own. One hop, and a further one only from a dependent whose own
	 * surface moved. Past `REBIND_CAP` parses, the rest wait for the pump, as does every module with
	 * only an unresolved use of a moved name, so a common name never holds the gate.
	 *
	 * Caller-held, inside `applyBatch`.
	 */
	private async rebindDependents(
		outcomes: readonly IndexOutcome[],
		shouldAbandon?: () => boolean,
	): Promise<IndexOutcome[]> {
		const rebound: IndexOutcome[] = [];
		// Where each module the batch wrote stands in its order of writes.
		const order = new Map<string, number>();
		for (const [at, outcome] of outcomes.entries()) if (outcome.action !== "skipped") order.set(outcome.module, at);
		const answered = new Map<string, SurfaceChange>();
		const owed: string[] = [];
		let budget = REBIND_CAP;
		let moves = this.pendingMoves(outcomes.map((outcome) => outcome.module));
		while (moves.size > 0) {
			const { modules, unbound, complete } = await this.dependentsOf(moves);
			if (complete) for (const [module, change] of moves) answered.set(module, change);
			else this.retryResolving(moves.keys());
			for (const module of unbound) {
				if (!this.readAfter(module, moves, order) && this.rebindable(module)) owed.push(module);
			}
			const hop: string[] = [];
			for (const module of modules) {
				if (this.readAfter(module, moves, order) || !this.rebindable(module)) continue;
				if (budget === 0 || shouldAbandon?.() === true) {
					owed.push(module);
					continue;
				}
				budget--;
				let outcome: IndexOutcome;
				try {
					outcome = await this.parseAndStore(module, this.store.depthOf(module) ?? undefined);
				} catch (error) {
					outcome = this.faultOutcome(module, error);
				}
				order.set(module, outcomes.length + rebound.length);
				rebound.push(outcome);
				// Owed until a parse is admitted: an outage or a refusal waits, never dropped.
				if (UNREAD.has(outcome.cause)) this.holdRebind(module, outcome);
				hop.push(module);
			}
			moves = this.pendingMoves(hop);
		}
		this.settle(answered, owed);
		return rebound;
	}

	/**
	 * Leaves to the pump every module binding against these moves, but for one written after the last
	 * of them, which read them already. A move `stale` does not name counts as before everything. A
	 * resolver fault leaves the moves pending for a later run.
	 */
	private async oweDependents(
		moves: ReadonlyMap<string, SurfaceChange>,
		order: ReadonlyMap<string, number>,
		stale: (module: string, change: SurfaceChange) => boolean = () => true,
	): Promise<void> {
		const { modules, unbound, complete } = await this.dependentsOf(moves);
		const owed = [...modules, ...unbound].filter(
			(module) => !this.readAfter(module, moves, order, stale) && this.rebindable(module),
		);
		if (!complete) this.retryResolving(moves.keys());
		else if (this.resolvePending.size === 0) this.resolveRetryMs = RESOLVE_RETRY_MS;
		this.settle(complete ? moves : new Map(), owed);
	}

	/**
	 * Whether a module was written after every move here, so it bound against each of them. A move no
	 * road here wrote, or one that could have left no stale parse behind, came first.
	 */
	private readAfter(
		module: string,
		moves: ReadonlyMap<string, SurfaceChange>,
		order: ReadonlyMap<string, number>,
		stale: (module: string, change: SurfaceChange) => boolean = () => true,
	): boolean {
		const written = order.get(module);
		if (written === undefined) return false;
		return [...moves].every(([moved, change]) => written > (stale(moved, change) ? (order.get(moved) ?? -1) : -1));
	}

	/**
	 * Who binds against these moved surfaces: modules importing one, now or when they were written,
	 * and modules bound into what one held. `unbound` holds the rest with an unresolved use of a name
	 * one gained or lost, which only may bind now. Each in module order. Incomplete when a resolver
	 * fault left an importer unread.
	 */
	private async dependentsOf(
		moves: ReadonlyMap<string, SurfaceChange>,
	): Promise<{ modules: string[]; unbound: string[]; complete: boolean }> {
		if (moves.size === 0) return { modules: [], unbound: [], complete: true };
		const { importers, complete } = await this.importersOf(moves.keys());
		// The import index answers where specifiers land now; a module that went, or that a specifier
		// stopped landing on, is still named by the import written against it.
		for (const module of this.store.importersLandedOn([...moves.keys()])) importers.add(module);
		const names = new Set<string>();
		for (const change of moves.values()) {
			for (const module of change.boundInto) importers.add(module);
			for (const name of [...change.gained, ...change.lost]) names.add(name);
		}
		const unbound = this.store
			.modulesWithUnbound([...names])
			.filter((module) => !moves.has(module) && !importers.has(module));
		return { modules: [...importers].filter((module) => !moves.has(module)).sort(), unbound, complete };
	}

	/**
	 * Modules importing any of `targets`. The index is read whole once per resolution generation,
	 * then each written module's own rows alone, so a run of writes costs their imports, not the
	 * workspace's each time. A module whose resolution faulted is read again next time.
	 */
	private async importersOf(targets: Iterable<string>): Promise<{ importers: Set<string>; complete: boolean }> {
		const generation = this.caches.resolutions.stats().generation;
		let index = this.importers;
		if (index?.generation !== generation) {
			const building: ImporterIndex = { generation, byTarget: new Map(), targetsOf: new Map(), ready: undefined };
			building.ready = this.readWhole(building);
			index = building;
			this.importers = building;
		}
		// Another road's build of this generation is read only once it is whole.
		await index.ready;
		const unread: string[] = [];
		for (const module of [...this.importsWritten]) {
			this.importsWritten.delete(module);
			const listed = this.store.importsIn(module).map((statement) => statement.specifier);
			if (!(await this.readImports(index, module, listed))) unread.push(module);
		}
		for (const module of unread) this.importsWritten.add(module);
		const importers = new Set<string>();
		for (const target of targets) for (const module of index.byTarget.get(target) ?? []) importers.add(module);
		// Resolutions turned over, or another road replaced the index, while this read ran: what it
		// found answers an older generation.
		const current = this.importers === index && this.caches.resolutions.stats().generation === generation;
		return { importers, complete: unread.length === 0 && current };
	}

	/** Reads every module's import rows into a fresh index; one the resolver faulted on is read again. */
	private async readWhole(index: ImporterIndex): Promise<void> {
		// Cleared before the read: a module written while it runs is read again next time.
		this.importsWritten.clear();
		const specifiers = new Map<string, string[]>();
		for (const { module, specifier } of this.store.importEdges()) {
			const listed = specifiers.get(module);
			if (listed === undefined) specifiers.set(module, [specifier]);
			else listed.push(specifier);
		}
		for (const [module, listed] of specifiers) {
			if (!(await this.readImports(index, module, listed))) this.importsWritten.add(module);
		}
	}

	/**
	 * Replaces one module's entries with where its specifiers land now, through the cached resolver.
	 * A resolver fault is no answer, so the module keeps what it held and answers false.
	 */
	private async readImports(index: ImporterIndex, module: string, specifiers: readonly string[]): Promise<boolean> {
		const targets = new Set<string>();
		for (const specifier of new Set(specifiers)) {
			let landed: ImportResolution;
			try {
				landed = await this.resolve(module, specifier);
			} catch {
				return false;
			}
			const target = importTarget(landed);
			if (target !== null) targets.add(target.module);
		}
		for (const target of index.targetsOf.get(module) ?? []) index.byTarget.get(target)?.delete(module);
		index.targetsOf.set(module, targets);
		for (const target of targets) {
			const importers = index.byTarget.get(target);
			if (importers === undefined) index.byTarget.set(target, new Set([module]));
			else importers.add(module);
		}
		return true;
	}

	/**
	 * Whether a module is worth parsing again for its bindings. An outline holds no references to
	 * rebind, and a refused parse is about the file's own bytes.
	 */
	private rebindable(module: string): boolean {
		const depth = this.store.depthOf(module);
		return depth !== null && depth !== "outline" && this.store.parseFailureOf(module) === null;
	}

	/** One owed module; a failure holds it for its provider or its own file. */
	private async rebindOne(module: string): Promise<void> {
		await this.alone(async () => {
			const depth = this.store.depthOf(module);
			// Nothing held has nothing to rebind.
			if (depth === null) {
				this.store.clearRebind(module);
				return;
			}
			// An outline pays its debt with the full parse it owes anyway.
			if (depth === "outline") this.depths.set(module, "full");
			let outcome: IndexOutcome;
			try {
				outcome = await this.indexOne(module, depth === "outline" ? "full" : depth);
			} catch (error) {
				outcome = this.faultOutcome(module, error);
			}
			if (UNREAD.has(outcome.cause)) this.holdRebind(module, outcome);
			// Gone or no longer owned: nothing left for a later run to pay.
			else if (outcome.action !== "indexed") this.store.clearRebind(module);
		});
		// A dependent whose own surface moved owes its dependents one more hop.
		await this.oweDependents(this.pendingMoves([module]), new Map([[module, 0]]));
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
		return {
			...this.status,
			stored: this.store.totals().files,
			failures: this.store.parseFailureCount(),
			failed: this.store.parseFailures(NAMED_FAILURES),
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
		return statusOf(module, this.claimOf(module), this.readSource(module), this.store);
	}

	/** Why the index may read a module: discovered by scope, or reached by import. Narrower than a claim. */
	async admittedModules(modules: string[]): Promise<AdmittedModule[]> {
		const scope = await this.currentScope();
		return modules.map((module) => ({ module, admitted: this.admissionIn(scope, module) }));
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
			readSource: this.readSource,
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
	async applyBatch(events: FileEvent[], shouldAbandon?: () => boolean): Promise<IndexOutcome[]> {
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
			const decisions = events.map((event) =>
				decideInvalidation(event, {
					route: (module) => this.supervisor.route(module),
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
			if (unchanged.length === decisions.length) {
				return decisions.map((decision) => this.outcome(decision.module, "current", UNCHANGED_REASON));
			}
			this.newInPass = new Set();
			const outcomes: IndexOutcome[] = [];
			const previousRoots = this.roots;
			const previousDepths = this.depths;
			const changed = events.filter((event) => event.kind === "changed").map((event) => event.module);
			const deleted = events.filter((event) => event.kind === "deleted").map((event) => event.module);
			for (const files of this.discovered.values()) for (const module of deleted) files.delete(module);
			// Asked of the config files as providers named them before this batch: a restated project
			// may stop naming the very file that restated it.
			const touchedConfig = decisions.some((decision) => this.configFiles.has(decision.module));
			// A provider whose config the batch touched states its project, and its files, before
			// anything is read under it or the roots are counted.
			const restated = await this.restatements(decisions.map((decision) => decision.module));
			const roots = await this.rootModules(changed, deleted);
			this.roots = roots;
			this.depths = new Map([...roots].map((module) => [module, this.rootDepth(module)]));
			// A provider resolves against the files on DISK, not against what this index holds, so only a
			// file arriving or leaving, or a config restating the rules, moves where a specifier lands.
			// Editing a body moves none of them, which is the ordinary batch. Asked of the roots the scope
			// just decided, so a write the workspace does not admit retires nothing.
			const moved =
				touchedConfig ||
				restated.length > 0 ||
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
					outcomes.push(
						this.outcome(decision.module, "missing", undefined, this.forgetFile(decision.module)),
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
}
