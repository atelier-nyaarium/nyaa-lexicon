// Owns the provider processes: spawning, routing, and one queue each.
//
// A caller asks a question about a module and gets an answer. It never learns which process
// served it, whether that process had just restarted, or that providers cannot be spoken to
// concurrently.

import { type ChildProcess, spawn } from "node:child_process";
import { Writable } from "node:stream";
import {
	defined,
	EVENT_SCHEMAS,
	type FileFacts,
	isCompatibleProtocol,
	METHOD_SCHEMAS,
	type ModuleAdmission,
	type NOTIFICATION_SCHEMAS,
	PROTOCOL_VERSION,
	type ProviderEvent,
	type ProviderMethod,
	type ProviderNotification,
	type ProviderStatus,
	type ProviderTiers,
	type ProviderWords,
} from "@nyaa-lexicon/protocol";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { z } from "zod";
import { type Clock, systemClock } from "./clock.js";
import { withTimeout } from "./deadline.js";
import { settleDeclaredTiers } from "./declaredTiers.js";
import { denyGlobs, readScopeConfig } from "./fileScope.js";
import type { MethodResponse, ProviderPort } from "./providerPort.js";
import { RequestQueue } from "./requestQueue.js";
import {
	type HeadReader,
	type ProviderClaims,
	type Route,
	type RoutingContext,
	routeModule,
	routingContextOf,
} from "./routing.js";
import { Timings, textSizes } from "./timings.js";

////////////////////////////////
//  Interfaces & Types

export interface ProviderSpec {
	/** Argv of the provider process. */
	command: string[];
	/** Cap on one request, so a wedged provider fails its caller rather than the daemon. */
	timeoutMs?: number;
	/** Signals it has a handler for. Any other is refused, since the default action is death. */
	handles?: NodeJS.Signals[];
}

/** A death nobody ordered. A deliberate stop is never reported. */
export interface ProviderExit {
	providerId: string;
	pid: number | null;
	code: number | null;
	signal: string | null;
}

/** A provider's phase, written by the supervisor and by the provider's own `providerPhase`. */
interface PhaseState {
	phase: ProviderStatus["phase"];
	/** The name the provider last gave with a phase. */
	label?: string;
	/** When it last said it is initializing. */
	initializingSince?: number;
	/** When it last left initializing, so a request the warmup held gets a whole budget after. */
	warmedAt?: number;
}

interface RunningProvider {
	claims: ProviderClaims;
	tiers: ProviderTiers;
	words: ProviderWords;
	child: ChildProcess;
	connection: MessageConnection;
	queue: RequestQueue;
	/** Shared with the process's notification handler, which updates it in place. */
	status: PhaseState;
	spec: ProviderSpec;
	workspaceRoot: string;
	/** This PROCESS, not this provider: a restart under the same id mints a new one. */
	incarnation: number;
	/** Unexpected deaths so far. At the cap the provider stays dead rather than crash-looping. */
	deaths: number;
	/** Set by stop(), so a deliberate teardown is never mistaken for a crash to respawn from. */
	stopping: boolean;
}

/** Spawned, not yet registered. */
type StartingProcess = Pick<RunningProvider, "child" | "connection" | "queue" | "status">;

/** A provider outage is not a file parse failure. */
export class ProviderUnavailableError extends Error {}

////////////////////////////////
//  Constants

const DEFAULT_TIMEOUT_MS = 30_000;

/** Unexpected deaths one provider gets before it stays dead. */
const MAX_RESPAWNS = 3;

const RESPAWN_DELAY_MS = 500;

/** How long a provider may stay initializing before its held requests read it as wedged. */
export const INITIALIZING_CEILING_MS = 10 * 60_000;

////////////////////////////////
//  Functions & Helpers

/** A provider learns the scope's deny globs at every start, so none of its own reads reach them. */
function initializeParams(workspaceRoot: string): {
	workspaceRoot: string;
	protocolVersion: string;
	deny: string[];
} {
	return { workspaceRoot, protocolVersion: PROTOCOL_VERSION, deny: denyGlobs(readScopeConfig(workspaceRoot)) };
}

/** An answered initialize makes a starting provider ready, unless it already said it is warming. */
function answeredInitialize(status: PhaseState): void {
	if (status.phase === "starting") status.phase = "ready";
}

/** A signal death has no code, and "code null" hides which signal it was. */
function describeExit(code: number | null, signal: string | null): string {
	return signal !== null ? `died on ${signal}` : `exited with code ${code}`;
}

/** Writes to a dead child succeed silently: vscode-jsonrpc rethrows a failed write into a promise
 * nobody holds, an unhandled rejection the daemon dies of. The pipe's `error` event says so instead. */
export function absorbingWrites(stdin: Writable): Writable {
	stdin.on("error", () => {});
	return new Writable({
		write(chunk, encoding, callback) {
			try {
				stdin.write(chunk, encoding, () => callback());
			} catch {
				callback();
			}
		},
		final(callback) {
			stdin.end(() => callback());
		},
	});
}

////////////////////////////////
//  Class

export class ProviderSupervisor implements ProviderPort {
	constructor(
		private readonly clock: Clock = systemClock,
		private readonly timings: Timings = new Timings(clock),
	) {}

	private readonly providers = new Map<string, RunningProvider>();
	/** Minted per spawn, so a verdict for a dead process never reaches its replacement. */
	private incarnations = 1;
	/** What stopAll would otherwise miss. */
	private readonly starting = new Set<StartingProcess>();
	private readonly exitListeners: Array<(exit: ProviderExit) => void> = [];
	private routing: RoutingContext | undefined;
	private evidence: (() => Iterable<string>) | undefined;

	/** Told about every unexpected death. The supervisor learns nothing about the listener. */
	observeExits(listener: (exit: ProviderExit) => void): void {
		this.exitListeners.push(listener);
	}

	private announceExit(exit: ProviderExit): void {
		for (const listener of this.exitListeners) {
			try {
				listener(exit);
			} catch (error) {
				// A listener's failure is not the provider's.
				console.log(`exit listener failed: ${error instanceof Error ? error.message : error}`);
			}
		}
	}

	/**
	 * Starts a provider and records what it claims.
	 *
	 * The version handshake happens here rather than at first use, so an incompatible provider is
	 * refused while there is still a caller to tell, instead of failing an unrelated query later.
	 */
	async start(spec: ProviderSpec, workspaceRoot: string): Promise<ProviderClaims> {
		const running = this.spawnProcess(spec, workspaceRoot);
		this.starting.add(running);
		const timeout = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		// Nothing is written until the process exists: a request sent to a child whose spawn failed
		// (missing binary, vanished cwd) lands on a destroyed pipe, and with no 'error' listener the
		// failure is an uncaught crash of the whole daemon rather than of this one provider.
		try {
			await withTimeout(
				this.clock,
				new Promise<void>((resolve, reject) => {
					running.child.once("spawn", resolve);
					running.child.once("error", (error) =>
						reject(new Error(`provider failed to start: ${error.message}`)),
					);
				}),
				timeout,
				"spawn",
			);
		} catch (error) {
			this.abandon(running);
			throw error;
		}

		let info: unknown;
		try {
			info = await withTimeout(
				this.clock,
				running.connection.sendRequest("initialize", initializeParams(workspaceRoot)),
				timeout,
				"initialize",
				() => this.warmingGrace(running, timeout, "initialize"),
			);
		} catch (error) {
			// A child that answered nothing must not outlive its failed handshake as a zombie.
			this.abandon(running);
			throw error;
		}

		// Parsing is inside the guard too: a provider from another protocol answers a SHAPE this
		// one rejects, and an unreaped child then outlives the daemon that could not use it.
		let parsed: z.infer<(typeof METHOD_SCHEMAS)["initialize"]["response"]>;
		try {
			parsed = METHOD_SCHEMAS.initialize.response.parse(info);
			if (!isCompatibleProtocol(parsed.protocolVersion)) {
				throw new Error(
					`provider ${parsed.providerId} speaks ${parsed.protocolVersion}, we speak ${PROTOCOL_VERSION}`,
				);
			}
		} catch (error) {
			this.abandon(running);
			throw error;
		}

		// A stopAll meanwhile owns the teardown.
		if (!this.starting.delete(running)) throw new Error("supervisor stopped during start");

		const claims: ProviderClaims = {
			providerId: parsed.providerId,
			language: parsed.language,
			extensions: parsed.extensions,
			...defined({
				filenames: parsed.filenames,
				sharedExtensions: parsed.sharedExtensions,
				shebangs: parsed.shebangs,
				excludedDirectories: parsed.excludedDirectories,
				fallback: parsed.fallback,
				content: parsed.content,
			}),
		};

		// A second start under the same id must reap the incumbent, not orphan it behind the map.
		const incumbent = this.providers.get(claims.providerId);
		if (incumbent !== undefined) {
			incumbent.stopping = true;
			this.stopProcess(incumbent);
		}

		const entry: RunningProvider = {
			...running,
			claims,
			tiers: parsed.tiers,
			words: parsed.words,
			spec,
			workspaceRoot,
			incarnation: this.incarnations++,
			deaths: 0,
			stopping: false,
		};
		answeredInitialize(entry.status);
		this.providers.set(claims.providerId, entry);
		this.watchForExit(entry);
		return claims;
	}

	/** The serving process id, for a caller that must kill or inspect the real child. */
	pidOf(providerId: string): number | null {
		return this.providers.get(providerId)?.child.pid ?? null;
	}

	/**
	 * Through the child handle, which cannot reach a reused pid, and only for a signal the process
	 * declared it survives. False means not sent.
	 */
	signal(pid: number, signal: NodeJS.Signals): boolean {
		for (const provider of this.providers.values()) {
			if (provider.child.pid !== pid) continue;
			if (!(provider.spec.handles ?? []).includes(signal)) return false;
			return provider.child.kill(signal);
		}
		return false;
	}

	/** Respawn on an unexpected death, up to the cap. The claims keep routing so failures classify. */
	private watchForExit(entry: RunningProvider): void {
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			const current = this.providers.get(entry.claims.providerId);
			if (current === undefined || current.child !== entry.child || current.stopping) return;
			this.announceExit({ providerId: entry.claims.providerId, pid: entry.child.pid ?? null, code, signal });
			current.deaths += 1;
			if (current.deaths > MAX_RESPAWNS) {
				current.status.phase = "down";
				console.log(`provider ${entry.claims.providerId} died ${current.deaths} times; staying dead`);
				return;
			}
			current.status.phase = "restarting";
			console.log(
				`provider ${entry.claims.providerId} ${describeExit(code, signal)}; respawning (${current.deaths} of ${MAX_RESPAWNS})`,
			);
			this.clock.setTimer(() => void this.respawn(current), RESPAWN_DELAY_MS);
		};
		// A death inside the handshake await has already fired 'exit'; catching up here means the
		// watcher can never miss it. A signal death leaves exitCode null and signalCode set.
		if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
			onExit(entry.child.exitCode, entry.child.signalCode);
		} else entry.child.once("exit", onExit);
	}

	/**
	 * More time for a request whose budget ran out. A warming provider holds every request behind
	 * its warmup, so the budget waits it out and starts over once it is ready. Past the ceiling the
	 * provider is wedged: killed, so it respawns as any death does.
	 */
	private warmingGrace(
		provider: Pick<RunningProvider, "status" | "child">,
		budget: number,
		what: string,
	): number | Error | null {
		const now = this.clock.now();
		const { status } = provider;
		if (status.phase === "initializing") {
			const warming = now - (status.initializingSince ?? now);
			if (warming < INITIALIZING_CEILING_MS) return Math.min(budget, INITIALIZING_CEILING_MS - warming);
			provider.child.kill("SIGKILL");
			return new ProviderUnavailableError(`${what}: provider initializing for over ${INITIALIZING_CEILING_MS}ms`);
		}
		const warmed = status.warmedAt === undefined ? budget : now - status.warmedAt;
		return warmed < budget ? budget - warmed : null;
	}

	/** A respawn abandoned by teardown must never publish a child a stopped daemon cannot reap. */
	private stillWanted(previous: RunningProvider): boolean {
		return this.providers.get(previous.claims.providerId) === previous && !previous.stopping;
	}

	private async respawn(previous: RunningProvider): Promise<void> {
		if (!this.stillWanted(previous)) return;
		let running: StartingProcess | undefined;
		let words: ProviderWords;
		try {
			running = this.spawnProcess(previous.spec, previous.workspaceRoot);
			this.starting.add(running);
			// The registered entry answers for the provider until the new process does.
			previous.status.phase = "starting";
			const timeout = previous.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const spawned = running;
			const info = await withTimeout(
				this.clock,
				spawned.connection.sendRequest("initialize", initializeParams(previous.workspaceRoot)),
				timeout,
				"initialize",
				() => this.warmingGrace(spawned, timeout, "initialize"),
			);
			words = METHOD_SCHEMAS.initialize.response.parse(info).words;
		} catch (error) {
			// The half-started child is reaped, and the failed attempt costs a death so retries
			// stay bounded by the same cap as crashes.
			if (running !== undefined) {
				const { child } = running;
				// Died, as opposed to stalled and reaped by us.
				if (child.exitCode !== null || child.signalCode !== null) {
					this.announceExit({
						providerId: previous.claims.providerId,
						pid: child.pid ?? null,
						code: child.exitCode,
						signal: child.signalCode,
					});
				}
				this.abandon(running);
			}
			console.log(
				`provider ${previous.claims.providerId} respawn failed: ${error instanceof Error ? error.message : error}`,
			);
			previous.deaths += 1;
			if (this.stillWanted(previous) && previous.deaths <= MAX_RESPAWNS) {
				previous.status.phase = "restarting";
				this.clock.setTimer(() => void this.respawn(previous), RESPAWN_DELAY_MS);
			} else previous.status.phase = "down";
			return;
		}
		// Re-checked across the handshake await: a stop that landed meanwhile owns the teardown.
		if (!this.starting.delete(running)) return;
		if (!this.stillWanted(previous)) {
			this.stopProcess(running);
			return;
		}
		const entry: RunningProvider = { ...previous, ...running, words, incarnation: this.incarnations++ };
		answeredInitialize(entry.status);
		this.providers.set(previous.claims.providerId, entry);
		this.watchForExit(entry);
		console.log(`provider ${previous.claims.providerId} respawned`);
		this.respawned?.(previous.claims.providerId);
	}

	private spawnProcess(spec: ProviderSpec, workspaceRoot: string): StartingProcess {
		const [bin, ...args] = spec.command as [string, ...string[]];
		// cwd stated rather than inherited: the daemon's own cwd is its state dir, not the project.
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], cwd: workspaceRoot, windowsHide: true });
		if (!child.stdin || !child.stdout) throw new Error("provider process has no stdio pipes");

		const connection = createMessageConnection(
			new StreamMessageReader(child.stdout),
			new StreamMessageWriter(absorbingWrites(child.stdin)),
		);
		const status: PhaseState = { phase: "starting" };
		// Told unasked; a shape this core cannot read is ignored.
		connection.onNotification("providerPhase" satisfies ProviderEvent, (params: unknown) => {
			const told = EVENT_SCHEMAS.providerPhase.safeParse(params);
			if (!told.success) return;
			const warming = status.phase === "initializing";
			if (told.data.phase === "initializing" && !warming) status.initializingSince = this.clock.now();
			if (told.data.phase === "ready" && warming) status.warmedAt = this.clock.now();
			status.phase = told.data.phase;
			if (told.data.label !== undefined) status.label = told.data.label;
		});
		connection.listen();

		const queue = new RequestQueue();
		// The queue fails queued and in-flight callers alike, typed.
		const die = (error: ProviderUnavailableError) => queue.close(error);
		child.on("exit", (code, signal) => die(new ProviderUnavailableError(`provider ${describeExit(code, signal)}`)));
		// A broken pipe fails the request now, typed, rather than at its timeout.
		child.stdin.on("error", (error) => die(new ProviderUnavailableError(`provider pipe: ${error.message}`)));
		// The spawn gate in start() consumes the pre-spawn 'error'; this one covers anything the
		// process emits after it, so it can never again be an uncaught crash of the daemon.
		child.on("error", (error) => die(new ProviderUnavailableError(`provider errored: ${error.message}`)));

		return { child, connection, queue, status };
	}

	////////////////////////////////
	//  Asking

	/** Where evidence comes from when a route is asked before any scan observed it. */
	evidenceFrom(modules: () => Iterable<string>): void {
		this.evidence = modules;
	}

	private head: HeadReader | undefined;

	/** Where a module's first line comes from, for a shebang claim. */
	headFrom(read: HeadReader): void {
		this.head = read;
	}

	private respawned: ((providerId: string) => void) | undefined;

	/** Who hears that a provider's process started again under the same id. */
	respawnedFrom(listener: (providerId: string) => void): void {
		this.respawned = listener;
	}

	/** Records the workspace extensions used by shared claims. */
	observeWorkspace(modules: Iterable<string>): void {
		this.routing = routingContextOf(modules, this.head);
	}

	/** Adds one module to that evidence, for a file indexed outside a scan. */
	observeModule(module: string): void {
		this.routingContext().observe(module);
	}

	/** What a module's owner is, or why it has none. */
	route(module: string): Route {
		return routeModule(
			module,
			[...this.providers.values()].map((p) => p.claims),
			this.routingContext(),
		);
	}

	private routingContext(): RoutingContext {
		this.routing ??= routingContextOf(this.evidence?.() ?? [], this.head);
		return this.routing;
	}

	/** Whether a provider declared a tier, so a bulk pass can skip what it would refuse. */
	declares(providerId: string, tier: keyof ProviderTiers): boolean {
		return this.providers.get(providerId)?.tiers[tier] === true;
	}

	/** The vocabulary a provider announced at initialize; undefined when it is not running. */
	words(providerId: string): ProviderWords | undefined {
		const provider = this.providers.get(providerId);
		if (provider === undefined) return undefined;
		// A crashed or respawning provider still holds its last entry, dead child included, so
		// serving its words would answer for a process that is not currently running.
		// Accepted: for one event-loop turn between the OS death and node's exit event, this still
		// answers the dead words; nothing in userland can see the death any earlier than that.
		if (provider.child.exitCode !== null || provider.child.signalCode !== null) return undefined;
		return provider.words;
	}

	/**
	 * Asks the provider that owns `module`.
	 *
	 * An unowned or contested module throws rather than picking one: the caller is asking about a
	 * file nobody, or nobody unambiguously, is responsible for, and a plausible answer would be
	 * worse than none.
	 */
	async ask<K extends ProviderMethod>(module: string, method: K, params: unknown): Promise<MethodResponse<K>> {
		const route = this.route(module);
		if (!route.owned) {
			const detail = route.reason === "contested" ? `claimed by ${route.providerIds.join(", ")}` : "unclaimed";
			throw new Error(`no provider owns ${module}: ${detail}`);
		}
		return this.askProvider(route.providerId, method, params);
	}

	/** Asks a named provider directly, for a call that is not about one module. */
	async askProvider<K extends ProviderMethod>(
		providerId: string,
		method: K,
		params: unknown,
	): Promise<MethodResponse<K>> {
		const provider = this.providers.get(providerId);
		if (!provider) throw new Error(`provider ${providerId} is not running`);
		const timeout = provider.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		// Its work alone: the queue's wait is the provider's other callers.
		const stage = `${providerId}.${method}`;
		return provider.queue.run(() =>
			this.timings.time(stage, textSizes(params), async () => {
				let raw: unknown;
				try {
					// A death mid-request fails this caller through the queue, typed.
					raw = await withTimeout(
						this.clock,
						provider.connection.sendRequest(method, params),
						timeout,
						method,
						() => this.warmingGrace(provider, timeout, method),
					);
				} catch (error) {
					// A transport write error can beat the exit event; a dead child retypes it so the
					// failure never reads as the file's.
					if (
						!(error instanceof ProviderUnavailableError) &&
						(provider.child.exitCode !== null || provider.child.killed)
					) {
						throw new ProviderUnavailableError(error instanceof Error ? error.message : String(error));
					}
					throw error;
				}
				// Validated here so a malformed answer fails at the provider that produced it, rather
				// than as a confusing shape error somewhere downstream.
				const parsed = METHOD_SCHEMAS[method].response.parse(raw) as MethodResponse<K>;
				const facts = method === "parseFile" || method === "probeFile";
				if (facts && typeof parsed === "object" && parsed !== null) {
					settleDeclaredTiers(provider.tiers, parsed as Partial<FileFacts>);
				}
				return parsed;
			}),
		);
	}

	/**
	 * Every provider, not only the route's owner: a module that stopped being owned may still be
	 * held by the provider that owned it. Queued, so it lands after a parse already asked.
	 */
	forget(module: string): void {
		const params: z.infer<(typeof NOTIFICATION_SCHEMAS)["forgetModule"]> = { module };
		for (const provider of this.providers.values()) {
			provider.queue
				.run(() => provider.connection.sendNotification("forgetModule" satisfies ProviderNotification, params))
				// Dead providers forget everything.
				.catch(() => {});
		}
	}

	/** Queued behind that provider's work, so a parse it already answered lands first. */
	release(module: string, providerId: string): void {
		const provider = this.providers.get(providerId);
		if (provider === undefined) return;
		const params: z.infer<(typeof NOTIFICATION_SCHEMAS)["releaseModule"]> = { module };
		provider.queue
			.run(() => provider.connection.sendNotification("releaseModule" satisfies ProviderNotification, params))
			// A dead provider held nothing to release.
			.catch(() => {});
	}

	indexRoots(providerId: string, roots: string[]): void {
		const provider = this.providers.get(providerId);
		if (provider === undefined) return;
		const params: z.infer<(typeof NOTIFICATION_SCHEMAS)["indexRoots"]> = { roots };
		provider.queue
			.run(() => provider.connection.sendNotification("indexRoots" satisfies ProviderNotification, params))
			.catch(() => {});
	}

	/** Only the process that issued the token holds its state. */
	releaseJudgment(providerId: string, incarnation: number, partial: string): void {
		const provider = this.providers.get(providerId);
		if (provider === undefined || provider.incarnation !== incarnation) return;
		const params: z.infer<(typeof NOTIFICATION_SCHEMAS)["releaseLoadCycle"]> = { partial };
		provider.queue
			.run(() => provider.connection.sendNotification("releaseLoadCycle" satisfies ProviderNotification, params))
			// A dead provider holds no judgment.
			.catch(() => {});
	}

	/** Which process answers for this provider now; null when none does. */
	incarnationOf(providerId: string): number | null {
		return this.providers.get(providerId)?.incarnation ?? null;
	}

	/**
	 * The process that ANSWERED alone, unlike a forget, which every provider hears.
	 *
	 * Named by the caller rather than routed again here, since ownership can move between the parse
	 * and the verdict. The incarnation is the second half of that identity: a provider that died and
	 * restarted under the same id holds a fresh ledger, and a verdict for the dead process would
	 * settle a staging that was never its own.
	 */
	admission(providerId: string, incarnation: number | null, verdict: ModuleAdmission): void {
		const provider = this.providers.get(providerId);
		if (provider === undefined || provider.incarnation !== incarnation) return;
		provider.queue
			.run(() => provider.connection.sendNotification("moduleAdmission" satisfies ProviderNotification, verdict))
			// A dead provider keeps nothing to correct.
			.catch(() => {});
	}

	////////////////////////////////
	//  Lifecycle

	private stopProcess(running: { child: ChildProcess; connection: MessageConnection; queue: RequestQueue }): void {
		running.queue.close(new ProviderUnavailableError("provider stopped"));
		running.connection.dispose();
		// EOF first, the same signal an abnormal daemon death sends, so both paths exercise it.
		running.child.stdin?.end();
		running.child.kill();
	}

	private abandon(running: StartingProcess): void {
		this.starting.delete(running);
		this.stopProcess(running);
	}

	stop(providerId: string): void {
		const provider = this.providers.get(providerId);
		if (!provider) return;
		provider.stopping = true;
		this.stopProcess(provider);
		this.providers.delete(providerId);
	}

	stopAll(): void {
		for (const running of [...this.starting]) this.abandon(running);
		for (const providerId of [...this.providers.keys()]) this.stop(providerId);
	}

	running(): ProviderClaims[] {
		return [...this.providers.values()].map((p) => p.claims);
	}

	providerStatuses(): ProviderStatus[] {
		return [...this.providers.values()].map((provider) => {
			const queued = provider.queue.stats();
			return {
				id: provider.claims.providerId,
				language: provider.claims.language,
				phase: provider.status.phase,
				...defined({ label: provider.status.label }),
				pending: queued.pending + (queued.running ? 1 : 0),
			};
		});
	}
}
