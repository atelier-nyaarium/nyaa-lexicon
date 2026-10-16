import type { ImportResolution, IndexCause, IndexDepth, IndexOutcome, ResolutionMode } from "@nyaa-lexicon/protocol";
import type { Clock, TimerHandle } from "./clock.js";
import type { FileScope } from "./fileScope.js";
import { importTarget } from "./imports.js";
import type { IndexCaches } from "./indexer.js";
import type { ProviderPort } from "./providerPort.js";
import { type IndexStore, resolutionKey, type SurfaceChange } from "./store.js";

/** Dependents one batch parses again itself; the rest wait for the background pump. */
export const REBIND_CAP = 64;

/** The first wait before asking again after a resolver fault left moves pending; it doubles to the cap. */
export const RESOLVE_RETRY_MS = 1_000;
const RESOLVE_RETRY_MAX_MS = 60_000;
/** Outcomes that leave a module's facts unread under the reading asked for. */
export const UNREAD: ReadonlySet<IndexCause | undefined> = new Set(["parseFailed", "providerDown", "fault"]);

/** Import targets both ways, so a write refreshes its own module's entries alone. */
interface ImporterIndex {
	generation: number;
	byTarget: Map<string, Set<string>>;
	targetsOf: Map<string, Set<string>>;
	/** Settles once the whole read that built it has; undefined only while it is being made. */
	ready: Promise<void> | undefined;
}

export type { ImporterIndex };

/** Each row's module under the key it was read by. */
function grouped<T extends { module: string }>(rows: readonly T[], keyOf: (row: T) => string): Map<string, string[]> {
	const by = new Map<string, string[]>();
	for (const row of rows) {
		const list = by.get(keyOf(row));
		if (list === undefined) by.set(keyOf(row), [row.module]);
		else list.push(row.module);
	}
	return by;
}

export interface RebindSchedulerContext {
	store: IndexStore;
	supervisor: ProviderPort;
	caches: IndexCaches;
	clock: Clock;
	epoch: string;
	resolve: (fromModule: string, specifier: string, mode: ResolutionMode | undefined) => Promise<ImportResolution>;
	importers: ImporterIndex | null;
	importsWritten: Set<string>;
	projected: Set<string>;
	resolvePending: Set<string>;
	resolveRetry: TimerHandle | null;
	resolveRetryMs: number;
	rebindQueued: boolean;
	depths: Map<string, IndexDepth>;
	scope: FileScope | null;
	alone<T>(work: () => Promise<T>): Promise<T>;
	ensurePumping(): void;
	queueRebinds(): void;
	settleProjections(): void;
	pendingMoves(modules: Iterable<string> | null): Map<string, SurfaceChange>;
	settle(moves: ReadonlyMap<string, SurfaceChange>, owed: readonly string[]): void;
	retryResolving(moved: Iterable<string>): void;
	holdRebind(module: string, outcome: IndexOutcome): void;
	processOf(providerId: string): string;
	rebindDependents(outcomes: readonly IndexOutcome[], shouldAbandon?: () => boolean): Promise<IndexOutcome[]>;
	oweDependents(
		moves: ReadonlyMap<string, SurfaceChange>,
		order: ReadonlyMap<string, number>,
		stale?: (module: string, change: SurfaceChange) => boolean,
	): Promise<void>;
	readAfter(
		module: string,
		moves: ReadonlyMap<string, SurfaceChange>,
		order: ReadonlyMap<string, number>,
		stale?: (module: string, change: SurfaceChange) => boolean,
	): boolean;
	dependentsOf(moves: ReadonlyMap<string, SurfaceChange>): Promise<{
		modules: string[];
		unbound: string[];
		complete: boolean;
	}>;
	importIndex(): Promise<{ importersOf: (target: string) => ReadonlySet<string>; complete: boolean }>;
	readWhole(index: ImporterIndex): Promise<void>;
	readImports(
		index: ImporterIndex,
		module: string,
		occurrences: ReadonlyArray<{ specifier: string; resolutionMode?: ResolutionMode | undefined }>,
	): Promise<boolean>;
	rebindable(module: string): boolean;
	rebindOne(module: string): Promise<void>;
	parseAndStore(module: string, depth?: IndexDepth): Promise<IndexOutcome>;
	faultOutcome(module: string, error: unknown): IndexOutcome;
	currentScope(): Promise<FileScope>;
	currentScopeUnderGate(): Promise<FileScope>;
	indexOne(module: string, depth?: IndexDepth): Promise<IndexOutcome>;
}

/**
 * The moves still pending for `modules`, or for every module when null, with every module whose
 * exports a settlement moved since. Read, not taken: a road acknowledges them only with the debt it
 * owes for them, so a stop in between loses neither.
 */
export function pendingMoves(
	this: RebindSchedulerContext,
	modules: Iterable<string> | null,
): Map<string, SurfaceChange> {
	this.settleProjections();
	const asked = modules === null ? null : [...modules, ...this.projected];
	this.projected.clear();
	return this.store.surfaceMovesOf(asked);
}

/** Recomputes the export projections writes owe, so a route read or a rebind sees what they moved. */
export function settleProjections(this: RebindSchedulerContext): void {
	for (const module of this.store.settleProjections()) this.projected.add(module);
}

/** Writes the debt and acknowledges the moves it answers in one transaction, then starts the pump. */
export function settle(
	this: RebindSchedulerContext,
	moves: ReadonlyMap<string, SurfaceChange>,
	owed: readonly string[],
): void {
	this.store.settleMoves(moves, owed);
	if (owed.length > 0) this.queueRebinds();
}

export function queueRebinds(this: RebindSchedulerContext): void {
	this.rebindQueued = true;
	this.ensurePumping();
}

/**
 * Keeps moves a resolver fault left unanswered pending, and arms one retry: a run then asks again.
 * Each retry that finds them still pending waits twice as long, to a cap, so a provider that stays
 * down is not asked in a loop.
 */
export function retryResolving(this: RebindSchedulerContext, moved: Iterable<string>): void {
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
export function holdRebind(this: RebindSchedulerContext, module: string, outcome: IndexOutcome): void {
	const route = this.supervisor.route(module);
	if (!route.owned) return;
	const reason = outcome.cause === "parseFailed" ? "refusal" : "outage";
	this.store.blockRebind(module, route.providerId, reason, this.processOf(route.providerId));
}

/** This daemon and the provider process answering now, so a restart of either reads as new. */
export function processOf(this: RebindSchedulerContext, providerId: string): string {
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
export async function rebindDependents(
	this: RebindSchedulerContext,
	outcomes: readonly IndexOutcome[],
	shouldAbandon?: () => boolean,
): Promise<IndexOutcome[]> {
	const rebound: IndexOutcome[] = [];
	const order = new Map<string, number>();
	// Where each module the batch wrote stands in its order of writes.
	for (const [at, outcome] of outcomes.entries()) if (outcome.action !== "skipped") order.set(outcome.module, at);
	const answered = new Map<string, SurfaceChange>();
	const owed: string[] = [];
	let budget = REBIND_CAP;
	// A move stays pending until the run settles, so a module parsed again would report it again.
	const asked = new Map<string, string>();
	const unasked = (found: ReadonlyMap<string, SurfaceChange>) => {
		const left = new Map([...found].filter(([module, change]) => asked.get(module) !== JSON.stringify(change)));
		for (const [module, change] of left) asked.set(module, JSON.stringify(change));
		return left;
	};
	let moves = unasked(this.pendingMoves(outcomes.map((outcome) => outcome.module)));
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
		moves = unasked(this.pendingMoves(hop));
	}
	this.settle(answered, owed);
	return rebound;
}

/**
 * Leaves to the pump every module binding against these moves, but for one written after the last
 * of them, which read them already. A move `stale` does not name counts as before everything. A
 * resolver fault leaves the moves pending for a later run.
 */
export async function oweDependents(
	this: RebindSchedulerContext,
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
export function readAfter(
	this: RebindSchedulerContext,
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
 * fault left an importer unread. A module is never its own dependent, and only that: one whose
 * projection moved with another's still reads that other's surface.
 */
export async function dependentsOf(
	this: RebindSchedulerContext,
	moves: ReadonlyMap<string, SurfaceChange>,
): Promise<{ modules: string[]; unbound: string[]; complete: boolean }> {
	if (moves.size === 0) return { modules: [], unbound: [], complete: true };
	const { importersOf, complete } = await this.importIndex();
	const changes = [...moves.values()];
	// The import index answers where specifiers land now; a module that went, or that a specifier
	// stopped landing on, is still named by the import written against it.
	const landedOn = grouped(this.store.importersLandedOn([...moves.keys()]), (row) => row.target);
	// A scope it joined or left is read by every import landing on that scope.
	const scopeReaders = grouped(
		this.store.importersOfScopes(changes.flatMap((change) => change.scopes)),
		(row) => row.scope,
	);
	const unboundUsers = grouped(
		this.store.modulesWithUnbound(changes.flatMap((change) => [...change.gained, ...change.lost])),
		(row) => row.name,
	);
	const importers = new Set<string>();
	const unbound = new Set<string>();
	for (const [moved, change] of moves) {
		const reached = new Set([
			...importersOf(moved),
			...(landedOn.get(moved) ?? []),
			...change.scopes.flatMap((scope) => scopeReaders.get(scope) ?? []),
			...change.boundInto,
		]);
		reached.delete(moved);
		for (const module of reached) importers.add(module);
		for (const name of [...change.gained, ...change.lost])
			for (const module of unboundUsers.get(name) ?? []) if (module !== moved) unbound.add(module);
	}
	return {
		modules: [...importers].sort(),
		unbound: [...unbound].filter((module) => !importers.has(module)).sort(),
		complete,
	};
}

/**
 * Who imports a module, by where specifiers land now. The index is read whole once per resolution
 * generation, then each written module's own rows alone, so a run of writes costs their imports,
 * not the workspace's each time. A module whose resolution faulted is read again next time.
 */
export async function importIndex(
	this: RebindSchedulerContext,
): Promise<{ importersOf: (target: string) => ReadonlySet<string>; complete: boolean }> {
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
		if (!(await this.readImports(index, module, this.store.importsIn(module)))) unread.push(module);
	}
	for (const module of unread) this.importsWritten.add(module);
	const read = index;
	// Resolutions turned over, or another road replaced the index, while this read ran: what it
	// found answers an older generation.
	const current = this.importers === index && this.caches.resolutions.stats().generation === generation;
	return {
		importersOf: (target) => read.byTarget.get(target) ?? new Set(),
		complete: unread.length === 0 && current,
	};
}

/** Reads every module's import rows into a fresh index; one the resolver faulted on is read again. */
export async function readWhole(this: RebindSchedulerContext, index: ImporterIndex): Promise<void> {
	// Cleared before the read: a module written while it runs is read again next time.
	this.importsWritten.clear();
	const specifiers = new Map<string, Array<{ specifier: string; resolutionMode?: ResolutionMode }>>();
	for (const { module, ...occurrence } of this.store.importEdges()) {
		const listed = specifiers.get(module);
		if (listed === undefined) specifiers.set(module, [occurrence]);
		else listed.push(occurrence);
	}
	for (const [module, listed] of specifiers) {
		if (!(await this.readImports(index, module, listed))) this.importsWritten.add(module);
	}
}

/**
 * Replaces one module's entries with where its specifiers land now, through the cached resolver.
 * A resolver fault is no answer, so the module keeps what it held and answers false.
 */
export async function readImports(
	this: RebindSchedulerContext,
	index: ImporterIndex,
	module: string,
	occurrences: ReadonlyArray<{ specifier: string; resolutionMode?: ResolutionMode | undefined }>,
): Promise<boolean> {
	const targets = new Set<string>();
	const distinct = new Map(
		occurrences.map((each) => [resolutionKey(each.specifier, each.resolutionMode), each] as const),
	);
	for (const { specifier, resolutionMode } of distinct.values()) {
		let landed: ImportResolution;
		try {
			landed = await this.resolve(module, specifier, resolutionMode);
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
export function rebindable(this: RebindSchedulerContext, module: string): boolean {
	const depth = this.store.depthOf(module);
	return depth !== null && depth !== "outline" && this.store.parseFailureOf(module) === null;
}

/** One owed module; a failure holds it for its provider or its own file. */
export async function rebindOne(this: RebindSchedulerContext, module: string): Promise<void> {
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
			// A restarted daemon's pump can run before any scan computed the scope.
			if (this.scope === null) {
				await this.currentScopeUnderGate();
			}
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
