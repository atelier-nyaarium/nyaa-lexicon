// Owns the provider processes: spawning, routing, and one queue each.
//
// A caller asks a question about a module and gets an answer. It never learns which process
// served it, whether that process had just restarted, or that providers cannot be spoken to
// concurrently.

import { type ChildProcess, spawn } from "node:child_process";
import {
	isCompatibleProtocol,
	METHOD_SCHEMAS,
	PROTOCOL_VERSION,
	type ProviderMethod,
	type ProviderTiers,
} from "@nyaa-lexicon/protocol";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { z } from "zod";
import { RequestQueue } from "./requestQueue.js";
import { type ProviderClaims, type Route, routeModule } from "./routing.js";

////////////////////////////////
//  Interfaces & Types

export interface ProviderSpec {
	/** Argv of the provider process. */
	command: string[];
	/** Cap on one request, so a wedged provider fails its caller rather than the daemon. */
	timeoutMs?: number;
}

type MethodResponse<K extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[K]["response"]>;

interface RunningProvider {
	claims: ProviderClaims;
	tiers: ProviderTiers;
	child: ChildProcess;
	connection: MessageConnection;
	queue: RequestQueue;
	/** Rejects when the process dies, so an IN-FLIGHT request fails typed, not by timing out. */
	closed: Promise<never>;
	spec: ProviderSpec;
	workspaceRoot: string;
	/** Unexpected deaths so far. At the cap the provider stays dead rather than crash-looping. */
	deaths: number;
	/** Set by stop(), so a deliberate teardown is never mistaken for a crash to respawn from. */
	stopping: boolean;
}

/** A provider outage is not a file parse failure. */
export class ProviderUnavailableError extends Error {}

////////////////////////////////
//  Constants

const DEFAULT_TIMEOUT_MS = 30_000;

/** Unexpected deaths one provider gets before it stays dead. */
const MAX_RESPAWNS = 3;

const RESPAWN_DELAY_MS = 500;

////////////////////////////////
//  Functions & Helpers

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const bounded = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([work, bounded]).finally(() => clearTimeout(timer));
}

////////////////////////////////
//  Class

export class ProviderSupervisor {
	private readonly providers = new Map<string, RunningProvider>();

	/**
	 * Starts a provider and records what it claims.
	 *
	 * The version handshake happens here rather than at first use, so an incompatible provider is
	 * refused while there is still a caller to tell, instead of failing an unrelated query later.
	 */
	async start(spec: ProviderSpec, workspaceRoot: string): Promise<ProviderClaims> {
		const running = this.spawnProcess(spec, workspaceRoot);
		const timeout = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		// Nothing is written until the process exists: a request sent to a child whose spawn failed
		// (missing binary, vanished cwd) lands on a destroyed pipe, and with no 'error' listener the
		// failure is an uncaught crash of the whole daemon rather than of this one provider.
		try {
			await withTimeout(
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
			this.stopProcess(running);
			throw error;
		}

		let info: unknown;
		try {
			info = await withTimeout(
				running.connection.sendRequest("initialize", { workspaceRoot, protocolVersion: PROTOCOL_VERSION }),
				timeout,
				"initialize",
			);
		} catch (error) {
			// A child that answered nothing must not outlive its failed handshake as a zombie.
			this.stopProcess(running);
			throw error;
		}
		const parsed = METHOD_SCHEMAS.initialize.response.parse(info);

		if (!isCompatibleProtocol(parsed.protocolVersion)) {
			this.stopProcess(running);
			throw new Error(
				`provider ${parsed.providerId} speaks ${parsed.protocolVersion}, we speak ${PROTOCOL_VERSION}`,
			);
		}

		const claims: ProviderClaims = {
			providerId: parsed.providerId,
			language: parsed.language,
			extensions: parsed.extensions,
			...(parsed.filenames === undefined ? {} : { filenames: parsed.filenames }),
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
			spec,
			workspaceRoot,
			deaths: 0,
			stopping: false,
		};
		this.providers.set(claims.providerId, entry);
		this.watchForExit(entry);
		return claims;
	}

	/** The serving process id, for a caller that must kill or inspect the real child. */
	pidOf(providerId: string): number | null {
		return this.providers.get(providerId)?.child.pid ?? null;
	}

	/** Respawn on an unexpected death, up to the cap. The claims keep routing so failures classify. */
	private watchForExit(entry: RunningProvider): void {
		const onExit = (code: number | null) => {
			const current = this.providers.get(entry.claims.providerId);
			if (current === undefined || current.child !== entry.child || current.stopping) return;
			current.deaths += 1;
			if (current.deaths > MAX_RESPAWNS) {
				console.log(`provider ${entry.claims.providerId} died ${current.deaths} times; staying dead`);
				return;
			}
			console.log(
				`provider ${entry.claims.providerId} exited with code ${code}; respawning (${current.deaths} of ${MAX_RESPAWNS})`,
			);
			setTimeout(() => void this.respawn(current), RESPAWN_DELAY_MS).unref?.();
		};
		// A death inside the handshake await has already fired 'exit'; catching up here means the
		// watcher can never miss it.
		if (entry.child.exitCode !== null) onExit(entry.child.exitCode);
		else entry.child.once("exit", onExit);
	}

	/** A respawn abandoned by teardown must never publish a child a stopped daemon cannot reap. */
	private stillWanted(previous: RunningProvider): boolean {
		return this.providers.get(previous.claims.providerId) === previous && !previous.stopping;
	}

	private async respawn(previous: RunningProvider): Promise<void> {
		if (!this.stillWanted(previous)) return;
		let running: Pick<RunningProvider, "child" | "connection" | "queue" | "closed"> | undefined;
		try {
			running = this.spawnProcess(previous.spec, previous.workspaceRoot);
			const timeout = previous.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const info = await withTimeout(
				running.connection.sendRequest("initialize", {
					workspaceRoot: previous.workspaceRoot,
					protocolVersion: PROTOCOL_VERSION,
				}),
				timeout,
				"initialize",
			);
			METHOD_SCHEMAS.initialize.response.parse(info);
		} catch (error) {
			// The half-started child is reaped, and the failed attempt costs a death so retries
			// stay bounded by the same cap as crashes.
			if (running !== undefined) this.stopProcess(running);
			console.log(
				`provider ${previous.claims.providerId} respawn failed: ${error instanceof Error ? error.message : error}`,
			);
			previous.deaths += 1;
			if (this.stillWanted(previous) && previous.deaths <= MAX_RESPAWNS) {
				setTimeout(() => void this.respawn(previous), RESPAWN_DELAY_MS).unref?.();
			}
			return;
		}
		// Re-checked across the handshake await: a stop that landed meanwhile owns the teardown.
		if (!this.stillWanted(previous)) {
			this.stopProcess(running);
			return;
		}
		const entry: RunningProvider = { ...previous, ...running };
		this.providers.set(previous.claims.providerId, entry);
		this.watchForExit(entry);
		console.log(`provider ${previous.claims.providerId} respawned`);
	}

	private spawnProcess(
		spec: ProviderSpec,
		workspaceRoot: string,
	): Pick<RunningProvider, "child" | "connection" | "queue" | "closed"> {
		const [bin, ...args] = spec.command as [string, ...string[]];
		// cwd stated rather than inherited: the daemon's own cwd is its state dir, not the project.
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], cwd: workspaceRoot });
		if (!child.stdin || !child.stdout) throw new Error("provider process has no stdio pipes");

		const connection = createMessageConnection(
			new StreamMessageReader(child.stdout),
			new StreamMessageWriter(child.stdin),
		);
		connection.listen();

		const queue = new RequestQueue();
		let closeNow: (error: Error) => void = () => {};
		const closed = new Promise<never>((_, reject) => {
			closeNow = reject;
		});
		// Raced by callers, so a settled race must never surface as an unhandled rejection here.
		closed.catch(() => {});
		const die = (error: ProviderUnavailableError) => {
			// Queue closure and the closed signal classify queued and in-flight work alike.
			queue.close(error);
			closeNow(error);
		};
		child.on("exit", (code) => die(new ProviderUnavailableError(`provider exited with code ${code}`)));
		// The spawn gate in start() consumes the pre-spawn 'error'; this one covers anything the
		// process emits after it, so it can never again be an uncaught crash of the daemon.
		child.on("error", (error) => die(new ProviderUnavailableError(`provider errored: ${error.message}`)));

		return { child, connection, queue, closed };
	}

	////////////////////////////////
	//  Asking

	/** What a module's owner is, or why it has none. */
	route(module: string): Route {
		return routeModule(
			module,
			[...this.providers.values()].map((p) => p.claims),
		);
	}

	/** Whether a provider declared a tier, so a bulk pass can skip what it would refuse. */
	declares(providerId: string, tier: keyof ProviderTiers): boolean {
		return this.providers.get(providerId)?.tiers[tier] === true;
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

		return provider.queue.run(async () => {
			let raw: unknown;
			try {
				// The closed race fails a request in flight at the moment of death, typed.
				raw = await Promise.race([
					withTimeout(provider.connection.sendRequest(method, params), timeout, method),
					provider.closed,
				]);
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
			return METHOD_SCHEMAS[method].response.parse(raw) as MethodResponse<K>;
		});
	}

	////////////////////////////////
	//  Lifecycle

	private stopProcess(running: { child: ChildProcess; connection: MessageConnection; queue: RequestQueue }): void {
		running.queue.close(new Error("provider stopped"));
		running.connection.dispose();
		// EOF first, the same signal an abnormal daemon death sends, so both paths exercise it.
		running.child.stdin?.end();
		running.child.kill();
	}

	stop(providerId: string): void {
		const provider = this.providers.get(providerId);
		if (!provider) return;
		provider.stopping = true;
		this.stopProcess(provider);
		this.providers.delete(providerId);
	}

	stopAll(): void {
		for (const providerId of [...this.providers.keys()]) this.stop(providerId);
	}

	running(): ProviderClaims[] {
		return [...this.providers.values()].map((p) => p.claims);
	}
}
