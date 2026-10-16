import type { IndexDepth, IndexOutcome, IndexStatus } from "@nyaa-lexicon/protocol";
import type { Clock, TimerHandle } from "./clock.js";
import type { FileScope } from "./fileScope.js";
import type { Doing } from "./indexer.js";
import { BatchFailed, type IndexStore, lostRetryMs, type SurfaceChange } from "./store.js";

type Order = { modules: string[]; resolve: () => void; reject: (error: unknown) => void };

export interface IndexPumpContext {
	store: IndexStore;
	clock: Clock;
	orders: Order[];
	pumping: Promise<void> | null;
	upgradeWanted: boolean;
	unasked: Set<string>;
	rebindQueued: boolean;
	recovering: boolean;
	recovery: TimerHandle | null;
	losses: number;
	upgradeFailed: Set<string>;
	rebindCursor: string | null;
	resolvePending: Set<string>;
	depths: Map<string, IndexDepth>;
	scope: FileScope | null;
	status: Pick<IndexStatus, "state" | "done" | "total">;
	ensurePumping(): void;
	pump(): Promise<void>;
	pass<T>(work: () => Promise<T>): Promise<T>;
	startRun(): void;
	pumpTurns(): Promise<void>;
	recoverLater(): void;
	recover(): Promise<void>;
	during<T>(doing: Doing, work: () => Promise<T>): Promise<T>;
	upgradeOne(module: string): Promise<void>;
	rebindStep(): Promise<boolean>;
	processOf(providerId: string): string;
	alone<T>(work: () => Promise<T>): Promise<T>;
	pendingMoves(modules: Iterable<string> | null): Map<string, SurfaceChange>;
	oweDependents(moves: ReadonlyMap<string, SurfaceChange>, order: ReadonlyMap<string, number>): Promise<void>;
	rebindOne(module: string): Promise<void>;
	queueRebinds(): void;
	currentScope(): Promise<FileScope>;
	currentScopeUnderGate(): Promise<FileScope>;
	indexOne(module: string, depth?: IndexDepth, skipIfCurrent?: boolean): Promise<IndexOutcome>;
	faultOutcome(module: string, error: unknown): IndexOutcome;
	holdRebind(module: string, outcome: IndexOutcome): void;
}

export function requestFull(this: IndexPumpContext, modules: string[]): Promise<void> {
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

export function payOwed(this: IndexPumpContext): void {
	if (this.store.owedRebindAfter(null) !== null) this.queueRebinds();
}

export function upgradeRemaining(this: IndexPumpContext): Promise<void> {
	this.upgradeWanted = true;
	this.ensurePumping();
	return this.pumping ?? Promise.resolve();
}

export function ensurePumping(this: IndexPumpContext): void {
	if (this.pumping !== null) return;
	// The pump is its own pass, never part of the one that happened to start it.
	const run = this.store
		.detached(() => this.pump())
		.finally(() => {
			this.pumping = null;
			// Restart if work arrived before completion; background work waits out a lost batch's backoff.
			const background = this.unasked.size > 0 || this.rebindQueued || this.upgradeWanted || this.recovering;
			if (this.orders.length === 0 && (!background || this.recovery !== null)) return;
			this.ensurePumping();
			// Awaited, so a caller waiting on this run waits for the work it found still to do.
			return this.pumping;
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
 * nothing restarts it: what is owed stays in the store for the next start. A lost batch keeps what
 * the run still meant to do, for the recovery it arms.
 */
export async function pump(this: IndexPumpContext): Promise<void> {
	try {
		this.startRun();
		await this.pass(() => this.pumpTurns());
	} catch (error) {
		if (!(error instanceof BatchFailed)) {
			this.upgradeWanted = false;
			this.unasked.clear();
			this.rebindQueued = false;
			this.recovering = false;
		}
		for (const order of this.orders.splice(0)) order.reject(error);
		throw error;
	}
}

/** Arms one recovery, on a backoff that doubles with each loss in a row. */
export function recoverLater(this: IndexPumpContext): void {
	if (this.recovery !== null) return;
	this.recovery = this.clock.setTimer(
		() => {
			this.recovery = null;
			this.recovering = true;
			this.ensurePumping();
		},
		lostRetryMs(this.losses++),
	);
}

/**
 * The committed store is what a lost batch left. Every move it still holds owes its dependents
 * again, since a lost settlement or payment took the debt for them; owed rebinds and the outline
 * backlog are read from it each turn already. A module held back for a failure the store no
 * longer records is let back into the backlog.
 */
export async function recover(this: IndexPumpContext): Promise<void> {
	this.recovering = false;
	for (const module of this.upgradeFailed) {
		if (this.store.parseFailureOf(module) === null) this.upgradeFailed.delete(module);
	}
	const moves = await this.alone(async () => this.pendingMoves(null));
	await this.oweDependents(moves, new Map());
}

/** Each run tries every payable debt once; a provider or daemon that restarted since a parse failed is asked again. */
export function startRun(this: IndexPumpContext): void {
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

export async function pumpTurns(this: IndexPumpContext): Promise<void> {
	while (true) {
		if (this.recovering) {
			await this.during({ kind: "rebind" }, () => this.recover());
			continue;
		}
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
export async function rebindStep(this: IndexPumpContext): Promise<boolean> {
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
export async function upgradeOne(this: IndexPumpContext, module: string): Promise<void> {
	await this.alone(async () => {
		// Read inside the hold: a batch waiting on it may have upgraded or forgotten the module,
		// and the backlog was listed before this road's turn came around.
		if (this.store.depthOf(module) !== "outline") return;
		this.depths.set(module, "full");
		try {
			// A restarted daemon may be asked to upgrade before any scan computed the scope.
			if (this.scope === null) await this.currentScopeUnderGate();
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
