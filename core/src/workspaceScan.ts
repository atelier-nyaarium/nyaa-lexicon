import type { IndexDepth, IndexOutcome, IndexStatus } from "@nyaa-lexicon/protocol";
import type { GeneratedVerdict } from "./fileScope.js";
import type { IndexCaches } from "./indexer.js";
import type { MethodResponse, ProviderPort } from "./providerPort.js";
import type { IndexStore, SurfaceChange } from "./store.js";

type ScanWalk = {
	indexExisting: boolean;
	previousDepths?: ReadonlyMap<string, IndexDepth>;
	floor?: "full" | "outline";
	step: <T>(work: () => Promise<T>) => Promise<T>;
	reached?: (module: string) => Promise<void>;
};

type Coverage =
	| { state: "idle" }
	| { state: "discovering" }
	| { state: "outlining"; pending: Set<string>; attempting: Set<string> }
	| { state: "covered" }
	| { state: "failed"; reason: string };

export interface WorkspaceScanContext {
	store: IndexStore;
	supervisor: ProviderPort;
	caches: IndexCaches;
	newInPass: Set<string>;
	status: Pick<IndexStatus, "state" | "done" | "total">;
	coverage: Coverage;
	discovered: Map<string, Set<string>>;
	configFiles: Map<string, Set<string>>;
	restated: Set<string>;
	roots: Set<string>;
	depths: Map<string, IndexDepth>;
	generated: Map<string, GeneratedVerdict>;
	alone<T>(work: () => Promise<T>): Promise<T>;
	pass<T>(work: () => Promise<T>): Promise<T>;
	discoveryScope(): Promise<string[] | undefined>;
	discover(providerId: string, scope: string[] | undefined): Promise<MethodResponse<"discoverProject">>;
	rootModules(): Promise<Set<string>>;
	scanDepth(module: string, floor: "full" | "outline"): IndexDepth;
	writeScanSummary(outlined?: boolean): void;
	fileStat(module: string): string | null;
	indexOne(module: string, depth?: IndexDepth, skipIfCurrent?: boolean): Promise<IndexOutcome>;
	faultOutcome(module: string, error: unknown): IndexOutcome;
	noteReached(module: string, firstStats: Map<string, string | null>): Promise<void>;
	followImports(seen: Set<string>, walk: ScanWalk): Promise<IndexOutcome[]>;
	prune(seen: Set<string>): IndexOutcome[];
	sweepAfterPrune(reachable: Set<string>): void;
	readAllUnder(providerId: string, outcomes: readonly IndexOutcome[], also?: ReadonlySet<string>): boolean;
	pendingMoves(modules: Iterable<string> | null): Map<string, SurfaceChange>;
	oweDependents(
		moves: ReadonlyMap<string, SurfaceChange>,
		order: ReadonlyMap<string, number>,
		stale?: (module: string, change: SurfaceChange) => boolean,
	): Promise<void>;
	settle(moves: ReadonlyMap<string, SurfaceChange>, owed: readonly string[]): void;
	queueRebinds(): void;
	scanWorkspace(
		floor: "full" | "outline",
		onProgress?: (done: number, total: number) => void,
	): Promise<IndexOutcome[]>;
}

export async function runWorkspaceScan(
	this: WorkspaceScanContext,
	floor: "full" | "outline",
	onProgress?: (done: number, total: number) => void,
): Promise<IndexOutcome[]> {
	this.store.beginProjectIndexing();
	const outcomes = await this.pass(() => this.scanWorkspace(floor, onProgress));
	if (!outcomes.some((outcome) => outcome.cause === "providerDown")) this.store.markProjectIndexed();
	return outcomes;
}

export async function scanWorkspace(
	this: WorkspaceScanContext,
	floor: "full" | "outline",
	onProgress?: (done: number, total: number) => void,
): Promise<IndexOutcome[]> {
	if (floor === "outline") this.coverage = { state: "discovering" };
	this.status = { state: "discovering", done: 0, total: 0 };
	try {
		this.newInPass = new Set();
		// Kept until each provider states its project again, so an excluded file it named stays
		// claimed meanwhile. One no longer running names nothing.
		const running = new Set(this.supervisor.running().map((claims) => claims.providerId));
		for (const providerId of this.discovered.keys())
			if (!running.has(providerId)) this.discovered.delete(providerId);
		this.configFiles = new Map();
		// The workspace is being re-learned, so nothing a previous pass was told still vouches
		// for itself. Once, rather than per file: a scan reads what is already on disk.
		this.caches.resolutions.invalidate();
		const fingerprints = new Map<string, string>();
		const scope = await this.discoveryScope();
		for (const provider of this.supervisor.running()) {
			const project = await this.discover(provider.providerId, scope);
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
		// Read before the sweep clears it.
		const newInPass = new Set(this.newInPass);
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
		for (const [at, outcome] of outcomes.entries()) if (outcome.action !== "skipped") order.set(outcome.module, at);
		// A provider reads from disk a module it holds no parse of, so only a module that held a surface
		// before this pass, or whose file changed after the scan first looked at it, since a provider may
		// have read it for an earlier dependent, can have left a module this scan wrote earlier reading a
		// stale one. A projection that moved only because the pass wrote its sources after it is neither.
		const stale = (module: string, change: SurfaceChange) =>
			(change.heldBefore && !newInPass.has(module)) ||
			(firstStats.has(module) && this.fileStat(module) !== firstStats.get(module));
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
