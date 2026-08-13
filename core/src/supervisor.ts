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
	spec: ProviderSpec;
}

////////////////////////////////
//  Constants

const DEFAULT_TIMEOUT_MS = 30_000;

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

		this.providers.set(claims.providerId, { ...running, claims, tiers: parsed.tiers, spec });
		return claims;
	}

	private spawnProcess(
		spec: ProviderSpec,
		workspaceRoot: string,
	): Omit<RunningProvider, "claims" | "tiers" | "spec"> {
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
		// A dead process must reject its waiters immediately. Leaving them pending makes every
		// caller wait out its own timeout in turn, which reads as the daemon being stuck.
		child.on("exit", (code) => queue.close(new Error(`provider exited with code ${code}`)));
		// The spawn gate in start() consumes the pre-spawn 'error'; this one covers anything the
		// process emits after it, so it can never again be an uncaught crash of the daemon.
		child.on("error", (error) => queue.close(new Error(`provider errored: ${error.message}`)));

		return { child, connection, queue };
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
			const raw = await withTimeout(provider.connection.sendRequest(method, params), timeout, method);
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
		running.child.kill();
	}

	stop(providerId: string): void {
		const provider = this.providers.get(providerId);
		if (!provider) return;
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
