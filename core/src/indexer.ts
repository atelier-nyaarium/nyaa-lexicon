// Getting facts in, and the only module that changes what the index holds.
//
// Two writers race and the loser leaves a plausible-looking index, so a residue test holds this as
// the only one. Reaches wide on purpose: indexing IS reading files and asking providers.

import type { ImportResolution, IndexDepth } from "@nyaa-lexicon/protocol";
import { type FileScope, fileScopeFor, generatedFiles, includedFiles } from "./fileScope.js";
import { importTarget } from "./imports.js";
import type { FileEvent } from "./invalidation.js";
import { decideInvalidation } from "./invalidation.js";
import type { ResultCache } from "./resultCache.js";
import type { IndexStore } from "./store.js";
import type { ProviderSupervisor } from "./supervisor.js";
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

	/** This process's scan only. `stored` is read from the index when the status is asked for. */
	private status: Omit<IndexStatus, "stored"> = { state: "unstarted", done: 0, total: 0, failures: 0 };
	private scope: FileScope | null = null;
	private discovered = new Set<string>();
	private roots = new Set<string>();
	private depths = new Map<string, IndexDepth>();

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
		const readHash = hashContent(text);

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
					const landed = await this.resolve(module, statement.specifier).catch(() => null);
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
}
