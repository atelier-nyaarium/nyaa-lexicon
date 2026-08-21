// Getting facts in, and the only module that changes what the index holds.
//
// Two writers race and the loser leaves a plausible-looking index, so a residue test holds this as
// the only one. Reaches wide on purpose: indexing IS reading files and asking providers.

import type { ImportResolution, IndexDepth } from "@nyaa-lexicon/protocol";
import { attachComments } from "./commentAttach.js";
import { type FileScope, fileScopeFor, generatedFiles, includedFiles } from "./fileScope.js";
import { importTarget } from "./imports.js";
import type { FileEvent } from "./invalidation.js";
import { decideInvalidation } from "./invalidation.js";
import type { ResultCache } from "./resultCache.js";
import type { IndexStore } from "./store.js";
import { type ProviderSupervisor, ProviderUnavailableError } from "./supervisor.js";
import { hashContent } from "./watcher.js";

////////////////////////////////
//  Interfaces & Types

export interface IndexOutcome {
	module: string;
	action: "indexed" | "forgotten" | "skipped";
	reason?: string;
	failure?: string;
	declarations?: number;
}

/** Parts sum to `tracked`. */
export interface ScanBreakdown {
	tracked: number;
	claimed: number;
	unclaimed: number;
	generated: number;
	denied: number;
}

/**
 * How complete the index is. `unstarted` and `ready` both answer instantly and mean opposite things.
 *
 * `state`, `done` and `total` describe THIS PROCESS's scan. `stored` describes the index on disk,
 * which outlives any one process. The two are separate because they answer different questions, and
 * a consumer that has only the first will call a fully populated index empty every time a daemon
 * restarts.
 *
 * `warming` stores outlines; `upgrading` fills full facts. Failures come from persisted records.
 */
export interface IndexStatus {
	state: "unstarted" | "discovering" | "warming" | "indexing" | "upgrading" | "ready";
	done: number;
	total: number;
	failures: number;
	/** Files the index already holds, from this scan or any earlier one. */
	stored: number;
	/** Stored files not still owing a full pass. */
	fullFiles: number;
	/** Stored files still owing a full pass; reference counts are lower bounds while nonzero. */
	outlineFiles: number;
}

////////////////////////////////
//  Class

/** Owns what a scan accumulates: discovered files, roots, depths, progress. */
export class WorkspaceIndexer {
	constructor(
		private readonly store: IndexStore,
		private readonly supervisor: ProviderSupervisor,
		private readonly readFile: (module: string) => string | null,
		private readonly workspaceRoot: string,
		private readonly cache: ResultCache,
		/** Resolution belongs to the import resolver; the indexer only follows where it points. */
		private readonly resolve: (fromModule: string, specifier: string) => Promise<ImportResolution>,
	) {}

	/** Scan progress is process-local; stored counts come from the database. */
	private status: Pick<IndexStatus, "state" | "done" | "total"> = { state: "unstarted", done: 0, total: 0 };
	private scope: FileScope | null = null;
	private discovered = new Set<string>();
	private roots = new Set<string>();
	private depths = new Map<string, IndexDepth>();

	/** Counts sum to `tracked`. */
	private breakdown: ScanBreakdown | null = null;

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
		const readHash = hashContent(text);

		// Preserve deeper facts when the requested depth is cheaper.
		if (skipIfCurrent && this.store.contentHashOf(module) === readHash) {
			const held = this.store.depthOf(module);
			const satisfied = held === "full" || held === "surface" || held === depth;
			if (satisfied) return { module, action: "skipped", reason: "already indexed at this depth" };
		}

		const facts = await this.supervisor.ask(module, "parseFile", {
			module,
			contentHash: readHash,
			text,
			...(depth === "full" ? {} : { depth }),
		});
		const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		if (errors.length > 0) {
			// Recorded here so every caller's failure reaches coverage, not only the scan loops.
			const failure = errors.map((diagnostic) => diagnostic.message).join("; ");
			this.store.recordFailure(module, failure);
			throw new Error(failure);
		}
		// An absent depth means full facts, except surface remains a permission ceiling.
		const storedDepth = facts.depth ?? (depth === "surface" ? "surface" : "full");
		// Attachment happens here rather than in the store, because "nothing between these two" is a
		// question only the source text answers, and this is the last place holding it.
		this.store.replaceFile(
			module,
			readHash,
			facts.declarations,
			facts.references,
			facts.imports,
			facts.literals,
			storedDepth,
			attachComments(facts.declarations, facts.comments ?? [], text),
			facts.docs ?? [],
		);
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
		this.status = { state: "discovering", done: 0, total: 0 };
		this.discovered = new Set<string>();
		for (const provider of this.supervisor.running()) {
			const project = await this.supervisor.askProvider(provider.providerId, "discoverProject", {
				workspaceRoot: this.workspaceRoot,
			});
			for (const module of project.files) this.discovered.add(module);
		}

		this.roots = this.rootModules();
		this.depths = new Map([...this.roots].map((module) => [module, this.scanDepth(module, floor)]));
		this.writeScanSummary();
		const modules = [...this.roots];

		const outcomes: IndexOutcome[] = [];
		const seen = new Set<string>();
		const scanning = floor === "outline" ? "warming" : "indexing";
		this.status = { state: scanning, done: 0, total: modules.length };
		for (const [done, module] of modules.entries()) {
			let outcome: IndexOutcome;
			try {
				outcome = await this.indexOne(module, undefined, floor === "outline");
			} catch (error) {
				outcome = this.failedOutcome(module, error);
			}
			outcomes.push(outcome);
			if (outcome.action === "forgotten") this.roots.delete(module);
			else seen.add(module);
			this.status = { state: scanning, done: done + 1, total: modules.length };
			onProgress?.(done + 1, modules.length);
		}

		outcomes.push(...(await this.followImports(seen, true, new Map(), floor)));
		outcomes.push(...this.prune(seen));
		this.status = { state: "ready", done: outcomes.length, total: outcomes.length };
		return outcomes;
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
			this.failedOutcome(module, error);
		}
	}

	private writeScanSummary(): void {
		if (this.breakdown !== null) this.store.writeScanSummary(this.breakdown);
	}

	private async indexOne(
		module: string,
		depth = this.depths.get(module) ?? this.rootDepth(module),
		skipIfCurrent = false,
	): Promise<IndexOutcome> {
		if (this.currentScope().denies(module)) return { module, action: "skipped", reason: "denied by scope" };
		const text = this.readFile(module);
		if (text !== null) return this.indexFile(module, depth, skipIfCurrent);
		this.forgetFile(module);
		return { module, action: "forgotten", reason: "file is gone" };
	}

	/** Exclude failures from the retryable background backlog. */
	private upgradeFailed = new Set<string>();

	private failedOutcome(module: string, error: unknown): IndexOutcome {
		const failure = error instanceof Error ? error.message : String(error);
		this.upgradeFailed.add(module);
		// Provider outages do not blame files.
		if (error instanceof ProviderUnavailableError) {
			return { module, action: "skipped", reason: "provider unavailable", failure };
		}
		// Persist the failure for coverage reporting.
		this.store.recordFailure(module, failure);
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
		// A failure row for a file that was never stored has no files row to sweep it away with.
		for (const { module } of this.store.parseFailures()) {
			if (!reachable.has(module) && this.store.contentHashOf(module) === null) this.store.clearFailure(module);
		}
		return outcomes;
	}

	private rootModules(extra: Iterable<string> = []): Set<string> {
		this.scope = fileScopeFor(this.workspaceRoot);
		const named = includedFiles(this.workspaceRoot, this.scope.include);
		const namedSet = new Set(named);
		const everything = [...new Set([...(this.scope.known ?? []), ...this.discovered, ...named, ...extra])];
		const candidates = everything.filter((module) => this.scope?.allows(module) ?? true);
		const generated = generatedFiles(this.workspaceRoot, candidates);
		const reachable = candidates.filter((module) => namedSet.has(module) || !generated.has(module));
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
		// Store-derived counts survive restarts.
		const depths = this.store.depthTotals();
		return {
			...this.status,
			stored: this.store.totals().files,
			failures: this.store.parseFailures().length,
			fullFiles: depths.full + depths.surface,
			outlineFiles: depths.outline,
		};
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
		// Persisted here too, or a watcher batch leaves overview describing the previous scan.
		this.writeScanSummary();
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
}
