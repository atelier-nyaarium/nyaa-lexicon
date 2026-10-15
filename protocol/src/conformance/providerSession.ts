import { type ChildProcess, spawn } from "node:child_process";
import { createMessageConnection, ErrorCodes, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import type { z } from "zod";
import { METHOD_SCHEMAS, type ProviderMethod, type ProviderNotification, type ProviderTiers } from "../methods.js";

type MethodResponse<K extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[K]["response"]>;

/** Machine or process, never answer. */
class Stall extends Error {
	constructor(
		readonly why: "timeout" | "exit",
		message: string,
	) {
		super(message);
	}
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bounded = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Stall("timeout", `${what} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([work, bounded]).finally(() => clearTimeout(timer));
}

////////////////////////////////
//  Class

/** Owns the child process and the connection, so a caller sees requests and not a transport. */
class ProviderSession {
	/** Set at death. */
	private gone: string | null = null;
	/** Calls in flight, failed at death. Never raced against a promise that outlives the call. */
	private readonly inFlight = new Set<(stall: Stall) => void>();

	private constructor(
		private readonly child: ChildProcess,
		private readonly connection: ReturnType<typeof createMessageConnection>,
		private readonly timeoutMs: number,
	) {
		const die = (how: string) => {
			this.gone ??= how;
			const stall = new Stall("exit", `provider process ${how}`);
			for (const reject of this.inFlight) reject(stall);
			this.inFlight.clear();
		};
		child.once("exit", (code, signal) => die(`exited (${signal === null ? `code ${code}` : signal})`));
		child.once("error", (error) => die(`failed to start (${error.message})`));
		connection.onClose(() => die("closed its connection"));
	}

	static open(command: string[], timeoutMs: number): ProviderSession {
		const [bin, ...args] = command as [string, ...string[]];
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"] });
		if (!child.stdin || !child.stdout) throw new Error("provider process has no stdio pipes");
		const connection = createMessageConnection(
			new StreamMessageReader(child.stdout),
			new StreamMessageWriter(child.stdin),
		);
		connection.listen();
		return new ProviderSession(child, connection, timeoutMs);
	}

	/**
	 * Validates the response against the method table, so a malformed answer fails here rather
	 * than as a confusing mismatch inside a check.
	 *
	 * The cast is the one place the table's guarantee outruns what the compiler can prove for a
	 * generic key: `parse` really did produce this method's response shape, or it threw.
	 */
	async call<K extends ProviderMethod>(method: K, params: unknown): Promise<MethodResponse<K>> {
		if (this.gone !== null) throw new Stall("exit", `provider process ${this.gone} before ${method}`);
		let raw: unknown;
		try {
			const answer = new Promise<unknown>((resolve, reject) => {
				this.inFlight.add(reject);
				this.connection
					.sendRequest(method, params)
					.then(resolve, reject)
					.finally(() => this.inFlight.delete(reject));
			});
			raw = await withTimeout(answer, this.timeoutMs, method);
		} catch (error) {
			if (error instanceof Stall) {
				throw error.why === "exit" ? new Stall("exit", `${error.message} during ${method}`) : error;
			}
			if ((error as { code?: number }).code === ErrorCodes.PendingResponseRejected) {
				throw new Stall("exit", `provider process ${this.gone ?? "dropped the connection"} during ${method}`);
			}
			throw error;
		}
		return METHOD_SCHEMAS[method].response.parse(raw) as MethodResponse<K>;
	}

	/**
	 * Told, not asked. Awaiting the write is what orders it before the next request, since a
	 * provider that never declared the notification answers nothing to wait on.
	 */
	async notify(notification: ProviderNotification, params: unknown): Promise<void> {
		if (this.gone !== null) throw new Stall("exit", `provider process ${this.gone} before ${notification}`);
		await withTimeout(this.connection.sendNotification(notification, params), this.timeoutMs, notification);
	}

	/** Resolves once the process is gone, so a retry never overlaps it. */
	async close(): Promise<void> {
		this.connection.dispose();
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.child.kill();
		// SIGTERM ignored; SIGKILL is not.
		const grace = setTimeout(() => this.child.kill("SIGKILL"), 2000);
		await exited;
		clearTimeout(grace);
	}
}

export type { MethodResponse, ProviderTiers };
export { ProviderSession, Stall };
