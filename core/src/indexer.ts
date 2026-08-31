// Getting facts in, and the only module that changes what the index holds.
//
// Two writers race and the loser leaves a plausible-looking index, so a residue test holds this as
// the only one. Reaches wide on purpose: indexing IS reading files and asking providers.

import type {
	ImportResolution,
	IndexCause,
	IndexDepth,
	IndexOutcome,
	IndexStatus,
	ModuleDeclarations,
	ModuleStatus,
} from "@nyaa-lexicon/protocol";
import { hashContent } from "@nyaa-lexicon/protocol";
import type { Clock } from "./clock.js";
import { attachComments } from "./commentAttach.js";
import { FactAdmissionError } from "./factAdmission.js";
import { type FileScope, fileScopeFor, type GeneratedVerdict, generatedVerdicts, includedFiles } from "./fileScope.js";
import { importTarget } from "./imports.js";
import type { FileEvent } from "./invalidation.js";
import { decideInvalidation } from "./invalidation.js";
import { type ModuleClaim, moduleDeclarations, statusOf } from "./moduleDeclarations.js";
import { patternDigests } from "./patternDigest.js";
import type { MethodResponse, ProviderPort } from "./providerPort.js";
import type { ResultCache } from "./resultCache.js";
import { type SourceReader, unreadableReason } from "./sourceRead.js";
import type { FileNote, IndexStore } from "./store.js";
import type { ModulePresence, SweepReport } from "./subjects.js";
import { ProviderUnavailableError } from "./supervisor.js";

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

/** How many failed files an answer names; `overview` lists every one. */
export const NAMED_FAILURES = 3;

/** Subjects one sweep examines across both passes; a capped sweep resumes from its cursor. */
export const ORPHAN_SWEEP_CAP = 200;

/** The scope's verdict on the tracked set, each a subset of the one before. */
interface Admitted {
	everything: string[];
	candidates: string[];
	reachable: string[];
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
		private readonly cache: ResultCache,
		/** Resolution belongs to the import resolver; the indexer only follows where it points. */
		private readonly resolve: (fromModule: string, specifier: string) => Promise<ImportResolution>,
		private readonly clock: Clock,
	) {
		// A route asked before the first scan still sees the workspace.
		supervisor.evidenceFrom(() => this.admitted().reachable);
	}

	/** What the last prune kept; null until one has run, and the timer's sweep judges nothing before that. */
	private reachable: Set<string> | null = null;
	/** Modules first indexed in the pass in progress: the only rebind targets. */
	private newInPass = new Set<string>();
	private lastSweep: SweepReport | null = null;

	/** Scan progress is process-local; stored counts come from the database. */
	private status: Pick<IndexStatus, "state" | "done" | "total"> = { state: "unstarted", done: 0, total: 0 };
	private scope: FileScope | null = null;
	private discovered = new Set<string>();
	private roots = new Set<string>();
	private depths = new Map<string, IndexDepth>();

	/** Counts sum to `tracked`. */
	private breakdown: ScanBreakdown | null = null;
	/** Git's word per admitted module, refreshed with the scope. */
	private generated = new Map<string, GeneratedVerdict>();
	private coverage: WarmCoverage = { state: "idle" };

	/** Full-parse orders run between background files. */
	private orders: Array<{ modules: string[]; resolve: () => void; reject: (error: unknown) => void }> = [];
	private pumping: Promise<void> | null = null;
	private upgradeWanted = false;

	/** Refreshed at the start of every scan. Public for the resolver's surface globs. */
	currentScope(): FileScope {
		this.scope ??= fileScopeFor(this.workspaceRoot);
		return this.scope;
	}

	/**
	 * Ask the owning provider about a file and replace what the index holds for it.
	 *
	 * Skips rather than throws when nobody owns the file, since a workspace is full of files no
	 * provider claims and each one is not an error.
	 *
	 * Deliberately takes no caller-claimed hash: this reads the file itself and hashes that read,
	 * so facts are never filed under the hash of a different version.
	 */
	async indexFile(module: string, depth: IndexDepth = "full", skipIfCurrent = false): Promise<IndexOutcome> {
		const claim = this.claimOf(module);
		if (!claim.claimed) return this.outcome(module, "unclaimed", claim.unclaimedReason);
		// The claim above came from this route; the guard only narrows the type.
		const route = this.supervisor.route(module);
		if (!route.owned) return this.outcome(module, "unclaimed");

		const read = this.readSource(module);
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

		// Of the text actually read, never the caller's. A watcher hashes at event time and this
		// reads later, so trusting the argument would store facts from one version of a file under
		// the hash of another, and every staleness check downstream would compare the wrong pair.
		const readHash = hashContent(text);

		// Preserve deeper facts when the requested depth is cheaper.
		if (skipIfCurrent && this.store.contentHashOf(module) === readHash) {
			const held = this.store.depthOf(module);
			const satisfied = held === "full" || held === "surface" || held === depth;
			if (satisfied) {
				// Final facts outrank a failure row.
				if (held !== "outline") this.store.clearFailure(module);
				// A row from before content was recorded learns it without a parse.
				this.store.recordContent(module, route.content);
				return this.outcome(module, "current");
			}
		}

		let facts: MethodResponse<"parseFile">;
		try {
			facts = await this.supervisor.ask(module, "parseFile", {
				module,
				contentHash: readHash,
				text,
				...(depth === "full" ? {} : { depth }),
			});
		} catch (error) {
			const failure = error instanceof Error ? error.message : String(error);
			if (error instanceof ProviderUnavailableError) return this.outcome(module, "providerDown", failure);
			this.store.recordFailure(module, failure);
			this.upgradeFailed.add(module);
			return this.outcome(module, "parseFailed", failure);
		}
		const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		if (errors.length > 0) {
			// An answer, not a throw: the file is the reason, and a caller reindexing a restored file
			// must not fail on it. Recorded here so every caller's failure reaches coverage.
			const failure = errors.map((diagnostic) => diagnostic.message).join("; ");
			this.store.recordFailure(module, failure);
			this.upgradeFailed.add(module);
			return this.outcome(module, "parseFailed", failure);
		}
		// Below error, kept with the facts.
		const notes: FileNote[] = facts.diagnostics.flatMap((diagnostic) =>
			diagnostic.severity === "error"
				? []
				: [
						{
							severity: diagnostic.severity,
							message: diagnostic.message,
							...(diagnostic.range === undefined ? {} : { range: diagnostic.range }),
							...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
						},
					],
		);
		// An absent depth means full facts, except surface remains a permission ceiling.
		const storedDepth = facts.depth ?? (depth === "surface" ? "surface" : "full");
		// No depth before the write and facts after it: new to the pass, root or reached alike.
		const fresh = this.store.depthOf(module) === null;
		// Attachment happens here rather than in the store, because "nothing between these two" is a
		// question only the source text answers, and this is the last place holding it.
		try {
			this.store.replaceFile({
				module,
				contentHash: readHash,
				declarations: facts.declarations,
				references: facts.references,
				imports: facts.imports,
				literals: facts.literals,
				depth: storedDepth,
				comments: attachComments(facts.declarations, facts.comments ?? [], text),
				docs: facts.docs ?? [],
				notes,
				content: route.content,
				// A shallow parse reports no comments, so only a full one can say what a digest covers; the
				// supervisor drops a comments field from a provider that never declared the tier.
				digests: storedDepth === "full" ? patternDigests(facts.declarations, facts.comments, text) : [],
				generated: this.verdictFor(module),
			});
		} catch (error) {
			// An answer the store refuses is the provider's answer for THIS file, so it is the file's failure.
			if (!(error instanceof FactAdmissionError)) throw error;
			const failure = `the provider's answer was refused: ${error.message}`;
			this.store.recordFailure(module, failure);
			this.upgradeFailed.add(module);
			return this.outcome(module, "parseFailed", failure);
		}
		if (fresh) this.newInPass.add(module);
		// A success re-admits the module to the background backlog.
		this.upgradeFailed.delete(module);
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
		return this.scanWorkspace("full", onProgress);
	}

	/** Stores declarations and imports before full facts. */
	async warmupWorkspace(onProgress?: (done: number, total: number) => void): Promise<IndexOutcome[]> {
		return this.scanWorkspace("outline", onProgress);
	}

	private async scanWorkspace(
		floor: "full" | "outline",
		onProgress?: (done: number, total: number) => void,
	): Promise<IndexOutcome[]> {
		if (floor === "outline") this.coverage = { state: "discovering" };
		this.status = { state: "discovering", done: 0, total: 0 };
		try {
			this.newInPass = new Set();
			this.discovered = new Set<string>();
			for (const provider of this.supervisor.running()) {
				const project = await this.supervisor.askProvider(provider.providerId, "discoverProject", {
					workspaceRoot: this.workspaceRoot,
				});
				for (const module of project.files) this.discovered.add(module);
			}

			this.roots = this.rootModules();
			this.depths = new Map([...this.roots].map((module) => [module, this.scanDepth(module, floor)]));
			// Roots with no row at any depth; a failed root has none and is attempted again here.
			const pending = new Set([...this.roots].filter((module) => this.store.depthOf(module) === null));
			if (floor === "outline") {
				this.coverage =
					pending.size === 0 ? { state: "covered" } : { state: "outlining", pending, attempting: new Set() };
			}
			// A completed mark survives a rescan only while nothing is missing.
			this.writeScanSummary(pending.size === 0 && this.store.readScanSummary()?.outlined === true);
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
				let outcome: IndexOutcome;
				try {
					outcome = await this.indexOne(module, undefined, floor === "outline");
				} catch (error) {
					outcome = this.faultOutcome(module, error);
				}
				if (floor === "outline" && this.coverage.state === "outlining") this.coverage.attempting.delete(module);
				outcomes.push(outcome);
				if (outcome.action === "forgotten") this.roots.delete(module);
				else seen.add(module);
				this.status = { state: scanning, done: done + 1, total: modules.length };
				onProgress?.(done + 1, modules.length);
			}

			outcomes.push(...(await this.followImports(seen, true, new Map(), floor)));
			this.store.syncGenerated(this.generated);
			outcomes.push(...this.prune(seen));
			this.sweepAfterPrune(seen);
			this.status = { state: "ready", done: outcomes.length, total: outcomes.length };
			// A restart heals an outage, so the pass says so; a fault is per file, recorded, and does not.
			const outages = outcomes.filter((outcome) => outcome.cause === "providerDown");
			if (outages.length > 0) {
				// Files an outage left unread would hide behind every answer if this pass read as covered.
				const first = outages[0] as IndexOutcome;
				this.writeScanSummary(false);
				this.coverage = {
					state: "failed",
					reason: `${outages.length} file(s) unread because a provider was unavailable: ${first.failure ?? first.reason}`,
				};
				return outcomes;
			}
			// A full pass covers at least what an outline pass would.
			this.writeScanSummary(true);
			this.coverage = { state: "covered" };
			return outcomes;
		} catch (error) {
			if (floor === "outline")
				this.coverage = { state: "failed", reason: error instanceof Error ? error.message : String(error) };
			throw error;
		}
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
		this.pumping ??= this.pump().finally(() => {
			this.pumping = null;
			// Restart if work arrived before completion.
			if (this.orders.length > 0 || this.upgradeWanted) this.ensurePumping();
		});
	}

	/** The one full-parse loop. Orders first, then the store's outline backlog, one file per turn. */
	private async pump(): Promise<void> {
		while (true) {
			const order = this.orders.shift();
			if (order !== undefined) {
				try {
					for (const module of order.modules) {
						if (this.store.depthOf(module) !== "outline") continue;
						await this.upgradeOne(module);
					}
					order.resolve();
				} catch (error) {
					order.reject(error);
				}
				continue;
			}

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
			await this.upgradeOne(next);
		}
	}

	/** Attempts one outline module without discarding stored facts on failure. */
	private async upgradeOne(module: string): Promise<void> {
		this.depths.set(module, "full");
		try {
			const outcome = await this.indexOne(module, "full");
			// A row skipped for scope or ownership stays outline in the store, so it must leave the
			// backlog or the pump spins on it forever.
			if (outcome.action === "skipped") this.upgradeFailed.add(module);
		} catch (error) {
			this.faultOutcome(module, error);
		}
	}

	/** The mark is carried forward unless a caller says otherwise. */
	private writeScanSummary(outlined = this.store.readScanSummary()?.outlined === true): void {
		if (this.breakdown === null) return;
		const knowledgeSweep = this.lastSweep ?? this.store.readScanSummary()?.knowledgeSweep;
		this.store.writeScanSummary({
			...this.breakdown,
			outlined,
			...(knowledgeSweep === undefined ? {} : { knowledgeSweep }),
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
		if (this.currentScope().denies(module)) {
			return this.outcome(module, "unclaimed", "denied by scope");
		}
		return this.indexFile(module, depth, skipIfCurrent);
	}

	/** Exclude failures from the retryable background backlog. */
	private upgradeFailed = new Set<string>();

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
		this.store.recordFailure(module, `the indexer failed on this file: ${failure}`);
		this.upgradeFailed.add(module);
		return this.outcome(module, "fault", failure);
	}

	/** Whether anything will index a module: the scope's word, then the routing's. */
	claimOf(module: string): ModuleClaim {
		if (this.currentScope().denies(module)) return { claimed: false, unclaimedReason: "denied by scope" };
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
	private async followImports(
		seen: Set<string>,
		indexExisting = true,
		previousDepths: ReadonlyMap<string, IndexDepth> = new Map(),
		floor: "full" | "outline" = "full",
	): Promise<IndexOutcome[]> {
		const outcomes: IndexOutcome[] = [];

		while (true) {
			const found: string[] = [];
			for (const module of [...seen]) {
				for (const statement of this.store.importsIn(module)) {
					const landed = await this.resolve(module, statement.specifier).catch(() => null);
					const target = landed === null ? null : importTarget(landed);
					if (target === null || this.currentScope().denies(target.module)) continue;
					const depth = this.currentScope().surface(target.module)
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
			this.rememberVerdicts(found);
			for (const module of found) {
				if (
					!indexExisting &&
					this.store.contentHashOf(module) !== null &&
					previousDepths.get(module) === this.depths.get(module)
				)
					continue;
				try {
					// Same restart guard as the root loop: an unchanged imported file holding full
					// facts must not be demoted by an outline-floor rescan.
					outcomes.push(await this.indexOne(module, undefined, floor === "outline"));
				} catch (error) {
					outcomes.push(this.faultOutcome(module, error));
				}
			}
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

	/** Every module the scope admits, owned by a provider or not. */
	private admitted(extra: Iterable<string> = [], gone: Iterable<string> = []): Admitted {
		this.scope = fileScopeFor(this.workspaceRoot);
		const named = includedFiles(this.workspaceRoot, this.scope.include);
		const namedSet = new Set(named);
		const goneSet = new Set(gone);
		const everything = [...new Set([...(this.scope.known ?? []), ...this.discovered, ...named, ...extra])].filter(
			(module) => !goneSet.has(module),
		);
		const candidates = everything.filter((module) => this.scope?.allows(module) ?? true);
		this.generated = generatedVerdicts(this.workspaceRoot, candidates);
		const reachable = candidates.filter(
			(module) => namedSet.has(module) || this.generated.get(module)?.status !== "yes",
		);
		return { everything, candidates, reachable };
	}

	/** One git call for what a round reached past admission, so an import closure never asks per file. */
	private rememberVerdicts(modules: string[]): void {
		const missing = modules.filter((module) => !this.generated.has(module));
		if (missing.length === 0) return;
		for (const [module, verdict] of generatedVerdicts(this.workspaceRoot, missing))
			this.generated.set(module, verdict);
	}

	/** Admission's verdict, or git asked for a module written outside any pass. */
	private verdictFor(module: string): GeneratedVerdict {
		this.rememberVerdicts([module]);
		return this.generated.get(module) as GeneratedVerdict;
	}

	private rootModules(extra: Iterable<string> = [], gone: Iterable<string> = []): Set<string> {
		const { everything, candidates, reachable } = this.admitted(extra, gone);
		// Evidence before ownership: a shared claim is decided by what the scope admits.
		this.supervisor.observeWorkspace(reachable);
		const roots = new Set(reachable.filter((module) => this.supervisor.route(module).owned));

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

	private rootDepth(module: string): IndexDepth {
		return this.currentScope().surface(module) ? "surface" : "full";
	}

	/** Surface is a ceiling, not a starting depth. */
	private scanDepth(module: string, floor: "full" | "outline"): IndexDepth {
		const ceiling = this.rootDepth(module);
		return ceiling === "surface" ? "surface" : floor;
	}

	private forgetFile(module: string): boolean {
		const removed = this.store.forgetFile(module);
		this.cache.invalidate();
		return removed;
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
		};
	}

	/** What `indexFile` would find, decided in its order, without asking a provider or writing. */
	moduleStatus(module: string): ModuleStatus {
		return statusOf(module, this.claimOf(module), this.readSource(module), this.store);
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

	/** Applies a watcher batch, one decision per file. */
	async applyBatch(events: FileEvent[]): Promise<IndexOutcome[]> {
		// A batch under a running outline pass would race its loop over the same roots.
		if (this.coverage.state === "discovering" || this.coverage.state === "outlining") {
			throw new Error("live indexing cannot run under the warmup pass");
		}
		this.newInPass = new Set();
		const outcomes: IndexOutcome[] = [];
		const previousRoots = this.roots;
		const previousDepths = this.depths;
		const changed = events.filter((event) => event.kind === "changed").map((event) => event.module);
		const deleted = events.filter((event) => event.kind === "deleted").map((event) => event.module);
		for (const module of deleted) this.discovered.delete(module);
		const roots = this.rootModules(changed, deleted);
		this.roots = roots;
		this.depths = new Map([...roots].map((module) => [module, this.rootDepth(module)]));
		// Persisted here too, or a watcher batch leaves overview describing the previous scan.
		this.writeScanSummary();
		const attempted = new Set<string>();
		// Only roots new to this batch owe an attempt; an earlier root with no row already failed one.
		const pending = new Set(
			[...roots].filter((module) => !previousRoots.has(module) && this.store.depthOf(module) === null),
		);

		for (const event of events) {
			const decision = decideInvalidation(event, {
				route: (module) => this.supervisor.route(module),
				indexedHash: (module) => this.store.contentHashOf(module),
			});

			if (decision.action === "forget") {
				pending.delete(decision.module);
				outcomes.push(this.outcome(decision.module, "missing", undefined, this.forgetFile(decision.module)));
				continue;
			}
			if (decision.action === "ignore") {
				pending.delete(decision.module);
				const cause = decision.reason === "content is unchanged" ? "current" : "unclaimed";
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
				const outcome = await this.indexFile(
					decision.module,
					this.depths.get(decision.module) ?? this.rootDepth(decision.module),
				);
				outcomes.push(outcome);
				if (outcome.action === "forgotten") roots.delete(decision.module);
			} catch (error) {
				outcomes.push(this.faultOutcome(decision.module, error));
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
				pending.delete(module);
				const outcome = await this.indexOne(module);
				outcomes.push(outcome);
				if (outcome.action === "forgotten") roots.delete(module);
			} catch (error) {
				outcomes.push(this.faultOutcome(module, error));
			}
		}

		const seen = new Set(roots);
		outcomes.push(...(await this.followImports(seen, false, previousDepths)));
		// A file the batch left unread takes the verdict its admission reached, a .gitattributes edit included.
		this.store.syncGenerated(this.generated);
		outcomes.push(...this.prune(seen));
		this.sweepAfterPrune(seen);
		if (pending.size !== 0) throw new Error(`live indexing left ${pending.size} root(s) unattempted`);
		if (this.coverage.state !== "failed") this.coverage = { state: "covered" };
		return outcomes;
	}
}
