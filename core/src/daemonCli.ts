// The daemon as a runnable program.
//
//   bun dist/daemon.js <workspace> [--warm] [--state-dir <dir>]
//
// Indexes once at start, then serves until stopped. The index is a real file rather than memory,
// so a restart re-uses what it already knows.
//
// It runs detached with stdio pointed at the workspace's daemon.log, so every line here is the
// only record of what happened.

import { mkdirSync, statSync } from "node:fs";
import {
	canonicalRoot,
	currentHost,
	DaemonStartingError,
	daemonCommand,
	refuseRuntime,
	spawnDaemonProcess,
	workspacePaths,
	writeInstallRecord,
} from "@nyaa-lexicon/client";
import { WARMUP_FAILED_PREFIX } from "@nyaa-lexicon/protocol";
import { systemClock } from "./clock.js";
import { type RunningDaemon, startDaemon } from "./daemon.js";
import { DAEMON_USAGE, parseDaemonArgs } from "./daemonArgs.js";
import { type Collector, makeReportsDir, startDiagnostics } from "./diagnostics.js";
import { createDispatch } from "./dispatch.js";
import { driftedTo } from "./drift.js";
import { storeCompatibilityKey } from "./fingerprint.js";
import { DEFAULT_LINGER_MS, lingerWhileEmpty } from "./lifetime.js";
import { startLiveIndex } from "./liveIndex.js";
import { ownSource } from "./ownSource.js";
import { describeStart, lexiconRoot, startProviders } from "./providers.js";
import { LexiconService } from "./service.js";
import { sourceReader } from "./sourceRead.js";
import { IndexStore } from "./store.js";
import { ProviderSupervisor } from "./supervisor.js";
import { TransactionManager } from "./transactions.js";
import { BUILD_VERSION } from "./version.js";
import { admitStateDir, admitWorkspace } from "./workspaceAdmission.js";
import { WorkspaceGate } from "./workspaceGate.js";

////////////////////////////////
//  Constants

/** Headroom over the slowest provider start. Published to clients rather than mirrored by them. */
const STARTUP_ALLOWANCE_MS = 90_000;

/** Re-offered while the first scan runs. The client's ceiling ends the wait; the scan finishes anyway. */
const FIRST_SCAN_PATIENCE_MS = 30_000;

/** How long shutdown waits for in-flight answers. Past it, the journal is the safety net. */
const SETTLE_LIMIT_MS = 30_000;

/** Drift is asked at most this often, one stat and at most one readdir per ask. */
const DRIFT_CHECK_EVERY_MS = 30_000;

////////////////////////////////
//  Functions & Helpers

/** Whether a request may be answered: a retryable hold while roots are unread, a plain error after a failed pass. */
export function warmRefusal(
	service: Pick<LexiconService, "warmHold" | "warmFailure">,
): DaemonStartingError | Error | null {
	const failure = service.warmFailure();
	if (failure !== null) return new Error(`${WARMUP_FAILED_PREFIX} ${failure}; restart the daemon`);
	const hold = service.warmHold();
	return hold === null ? null : new DaemonStartingError(hold, FIRST_SCAN_PATIENCE_MS, "the warmup pass");
}

/** Timestamped per line, because stdout is a log file read long after the fact. */
function log(lines: string): void {
	const stamp = new Date().toISOString();
	for (const line of lines.split("\n")) console.log(`${stamp} ${line}`);
}

function describeError(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

////////////////////////////////
//  Main

async function main(argv: string[]): Promise<void> {
	const refused = refuseRuntime("the lexicon daemon");
	if (refused !== null) {
		process.stderr.write(`${refused}\n`);
		process.exit(1);
	}

	const startedAt = Date.now();
	const parsed = parseDaemonArgs(argv);
	if (!parsed.ok) {
		console.error(`${parsed.problem}\n${DAEMON_USAGE}`);
		process.exit(2);
	}
	// A successor is told to warm because its predecessor was warm; nobody should notice the swap.
	const { workspace, warm: warmRequested, stateDir } = parsed.args;

	const root = canonicalRoot(workspace);
	let isDirectory = false;
	try {
		isDirectory = statSync(root).isDirectory();
	} catch {
		// Absent resolves the same as not-a-directory below.
	}
	if (!isDirectory) {
		// Refused up front: a workspace that is not there would otherwise get as far as provider
		// spawns and fail as an obscure cwd error from inside one of them.
		console.error(`${root} is not a directory; nothing to serve`);
		process.exit(2);
	}

	const host = currentHost();

	// Before the state directory exists, so a refused root leaves nothing behind to clean up.
	const admission = admitWorkspace(root, host);
	if (!admission.admitted) {
		console.error(admission.reason);
		process.exit(3);
	}
	// A directory of the caller's choosing is judged before anything is written into it.
	const dirAdmission = stateDir === undefined ? admission : admitStateDir(stateDir);
	if (!dirAdmission.admitted) {
		console.error(dirAdmission.reason);
		process.exit(3);
	}

	// Where lexicon is, for a consumer's client to find. A daemon runs without an MCP, so it records
	// too; a failure costs nothing this process needs.
	try {
		writeInstallRecord(lexiconRoot());
	} catch (error) {
		log(`install record not written: ${error instanceof Error ? error.message : String(error)}`);
	}

	const paths = workspacePaths(host, root, stateDir);
	// The store holds an index of private code, so a default directory is as closed as a custom one.
	mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
	try {
		makeReportsDir(paths.reportsDir);
	} catch (error) {
		log(`reports directory not made: ${error instanceof Error ? error.message : String(error)}`);
	}
	// The state dir is the one directory this process owns. A cwd inside the project pins it: on
	// Windows the folder cannot be renamed or deleted while a live process sits in it.
	process.chdir(paths.dir);

	log(`daemon ${BUILD_VERSION} pid ${process.pid} starting for ${root}`);

	////////////////////////////////
	//  Teardown, before anything to tear down

	// Nullable because a failure or signal can land at ANY startup stage, and teardown must release
	// whatever exists by then, or the lock and providers outlive the process (issue #7).
	let daemon: RunningDaemon | null = null;
	let store: IndexStore | null = null;
	let supervisor: ProviderSupervisor | null = null;
	let transactions: TransactionManager | null = null;
	let live: { stop: () => void } | null = null;
	let linger: ReturnType<typeof lingerWhileEmpty> | null = null;
	let collector: Collector | null = null;

	// Requests being answered right now. What shutdown waits out and the linger refuses to orphan.
	let inFlight = 0;
	const settledWaiters: Array<() => void> = [];
	function settled(limitMs: number): Promise<void> {
		if (inFlight === 0) return Promise.resolve();
		return new Promise((resolve) => {
			const limit = setTimeout(resolve, limitMs);
			limit.unref?.();
			settledWaiters.push(() => {
				clearTimeout(limit);
				resolve();
			});
		});
	}

	// One way out, whatever asked for it: signals, the RPC, the linger, and a startup failure all
	// land here, so there is no second teardown order to keep in step with this one. The lock goes
	// first, since removing it is what stops a client connecting to a dead port.
	let stopping = false;
	async function shutdown(why: string, code = 0): Promise<void> {
		if (stopping) return;
		stopping = true;
		log(`stopping: ${why}`);
		// Every step runs and the exit always lands, or one throwing step would leave a zombie
		// daemon that ignores all further shutdowns.
		try {
			linger?.cancel();
			await settled(SETTLE_LIMIT_MS);
			if (inFlight > 0) log(`giving up on ${inFlight} request(s) still in flight after ${SETTLE_LIMIT_MS}ms`);
			if (transactions?.status().open) {
				log("a refactor transaction stays open in the journal; the next daemon recovers it");
			}
			await releaseEverything();
			log(`stopped (exit ${code})`);
		} finally {
			process.exit(code);
		}
	}

	async function releaseEverything(): Promise<void> {
		const steps: Array<[string, () => unknown]> = [
			["lock", () => daemon?.stop()],
			// While the providers are still alive to be measured.
			["diagnostics", () => collector?.stop()],
			["watcher", () => live?.stop()],
			["providers", () => supervisor?.stopAll()],
			["store", () => store?.close()],
		];
		for (const [name, step] of steps) {
			try {
				await step();
			} catch (error) {
				log(`teardown of the ${name} failed: ${describeError(error)}`);
			}
		}
	}

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => void shutdown(signal));
	}
	process.on("uncaughtException", (error) => {
		log(`uncaught exception: ${describeError(error)}`);
		void shutdown("uncaught exception", 1);
	});
	process.on("unhandledRejection", (reason) => {
		log(`unhandled rejection: ${describeError(reason)}`);
		void shutdown("unhandled rejection", 1);
	});

	////////////////////////////////
	//  Startup

	// Claiming BEFORE the store opens is what resolves two sessions starting a daemon at once: the
	// loser exits here, having never touched SQLite, and both clients connect to whoever won.
	// `observe` is deferred because the linger needs the daemon it will stop.
	let observe: (connections: number) => void = () => {};

	// What a request arriving before the handler is told, so no client is more impatient than this
	// process is slow.
	let startingSince = Date.now();
	let waitingFor = "opening the index";
	const outcome = await startDaemon({
		workspaceRoot: root,
		...(stateDir === undefined ? {} : { stateDir }),
		onConnections: (n) => observe(n),
		startingNote: () => ({
			retryInMs: Math.max(0, startingSince + STARTUP_ALLOWANCE_MS - Date.now()),
			waitingFor,
		}),
		// A lost lock means a successor.
		onLockLost: (reason) => void shutdown(reason),
	});
	if (!outcome.claimed) {
		log(`not starting: ${outcome.reason}`);
		return;
	}
	daemon = outcome.daemon;
	log(`listening on 127.0.0.1:${daemon.lock.port} for ${root}`);
	log(`lock ${paths.lockFile}`);

	// Everything below runs with the lock held, so failing without releasing it would leave every
	// future client reading a live pid that serves nothing.
	try {
		const source = ownSource();
		// One time source for the store's stamps, the service, the watcher debounce and the sweep timer.
		const clock = systemClock;
		const opened = IndexStore.open(paths.index, storeCompatibilityKey(source.root), root, clock);
		store = opened.store;
		if (opened.rebuilt) log(`${opened.reason ?? "the index could not be trusted"}; rebuilt from empty`);
		if (opened.unplaced !== undefined) {
			log(`${opened.unplaced} knowledge row(s) lost their subject and another holds their recorded address`);
		}

		const spawned = new ProviderSupervisor();
		supervisor = spawned;
		// Held until the collector exists, so a death during startup is still an incident.
		const earlyExits: Parameters<Collector["recordExit"]>[0][] = [];
		spawned.observeExits((exit) => (collector === null ? earlyExits.push(exit) : collector.recordExit(exit)));
		startingSince = Date.now();
		waitingFor = "the language providers to start";
		const providers = await startProviders(spawned, root);
		log(`providers:\n${describeStart(providers)}`);

		const openStore = store;
		const service = new LexiconService(openStore, supervisor, sourceReader(root), root, clock);

		const gate = new WorkspaceGate();
		transactions = new TransactionManager(openStore, root);
		const journal = transactions;

		// Before the handler is published, so nothing can ask about a workspace still holding a
		// half-applied step. The lock is already claimed, so no other daemon is writing here.
		const recovered = await gate.exclusive(async () => {
			const outcome = journal.recover();
			// Restoring puts back text the index does not describe, so the facts for those files are of
			// a version that no longer exists. Reindexed here rather than left to the warm scan, which
			// is opt-in and may never run.
			for (const module of outcome.restored) await service.indexFile(module);
			return outcome;
		});
		if (recovered.recovered) {
			log(`recovered refactor ${recovered.transactionId}: restored ${recovered.restored.length} file(s)`);
			if (recovered.conflicts.length > 0) {
				log(`left alone, changed by someone else: ${recovered.conflicts.join(", ")}`);
			}
		}

		const dispatch = createDispatch(service, { gate, transactions: journal });

		collector = startDiagnostics({
			file: paths.diagnosticsFile,
			reportsDir: paths.reportsDir,
			workspaceRoot: root,
			daemon: { pid: process.pid, version: BUILD_VERSION, startedAt },
			processes: () =>
				spawned.running().flatMap((claims) => {
					const pid = spawned.pidOf(claims.providerId);
					return pid === null ? [] : [{ role: `provider:${claims.providerId}`, pid }];
				}),
			context: () => {
				const status = service.indexStatus();
				return {
					index: { state: status.state, done: status.done, total: status.total },
					inFlight,
					connections: outcome.daemon.connections(),
				};
			},
			onError: (message) => log(message),
		});
		for (const exit of earlyExits.splice(0)) collector.recordExit(exit);
		log(`diagnostics ${paths.diagnosticsFile}`);

		// Warming is opt-in, and the opt-in is having indexed here before. A directory nobody meant to
		// index costs nothing until something asks about it.
		let scan: Promise<void> | null = null;
		function warm(): void {
			if (scan !== null) return;
			scan = (async () => {
				const started = Date.now();
				// The first pass stores declarations and imports for immediate answers.
				const outcomes = await service.warmupWorkspace();
				const indexed = outcomes.filter((o) => o.action === "indexed");
				const failures = outcomes.filter((o) => o.failure !== undefined);
				const symbols = indexed.reduce((total, o) => total + (o.declarations ?? 0), 0);
				log(`scope: ${service.scopeReport()}`);
				log(`warmed ${indexed.length} files, ${symbols} declarations, ${Date.now() - started}ms`);
				if (failures.length > 0)
					log(`index failures: ${failures.map((o) => `${o.module}: ${o.failure}`).join(", ")}`);
				void service.upgradeRemaining().then(
					() => {
						const status = service.indexStatus();
						log(`upgraded to full facts, ${Date.now() - started}ms total (${status.failures} failures)`);
					},
					(error) => log(`upgrade failed: ${error instanceof Error ? error.message : error}`),
				);

				// Watching starts with warming: a watcher over an unasked-for workspace would index it
				// on the next file change anyway.
				live = startLiveIndex({
					service,
					workspaceRoot: root,
					gate,
					clock,
					onSwept: (report) => {
						if (report.examined > 0)
							log(
								`knowledge sweep: ${report.examined} examined, ${report.rebound} rebound, ${report.orphaned} orphaned, ${report.deleted} deleted${report.stoppedEarly ? ", stopped at the cap" : ""}`,
							);
					},
					onApplied: (applied) => {
						const touched = applied.filter((o) => o.action !== "skipped");
						const failures = applied.filter((o) => o.failure !== undefined);
						if (touched.length > 0) log(`reindexed ${touched.map((o) => o.module).join(", ")}`);
						if (failures.length > 0)
							log(`reindex failures: ${failures.map((o) => `${o.module}: ${o.failure}`).join(", ")}`);
					},
					onError: (error) => log(`reindex failed: ${error instanceof Error ? error.message : error}`),
				});
			})().catch((error) => {
				log(`warmup failed: ${error instanceof Error ? error.message : error}`);
			});
		}

		// The owner's rule for staying current: notice a newer build only between answered requests,
		// serve the call in hand, and never leave a mutation or an open refactor series behind.
		const stampAtStart = daemon.lock.bundleStamp ?? null;
		let lastDriftAsk = 0;
		async function handOverIfDrifted(): Promise<void> {
			const target = driftedTo({
				workspaceRoot: root,
				root: source.root,
				version: source.buildVersion,
				stampAtStart,
			});
			if (target === null) return;
			// The whole teardown runs INSIDE the exclusive gate: a queued watcher batch acquiring it
			// between approval and teardown would mutate a store being closed. The gate is never
			// released; the process exit is what ends it.
			await gate.exclusive(async () => {
				if (stopping || inFlight > 0 || journal.status().open) return;
				stopping = true;
				log(`handing over: ${target.why}`);
				try {
					linger?.cancel();
					await releaseEverything();
					// Lock released above, so the successor's claim cannot lose to a corpse. It inherits the
					// store directory, or it would claim a different store and leave this one orphaned.
					const command = daemonCommand(target.root, root, stateDir);
					if (command.kind !== "command")
						log(`no runnable bundle under ${target.root}; the next client starts one`);
					else spawnDaemonProcess([...command.command, "--warm"], paths.logFile);
					log("stopped (exit 0) after handover");
				} finally {
					process.exit(0);
				}
			});
		}
		function considerHandover(): void {
			if (stopping || Date.now() - lastDriftAsk < DRIFT_CHECK_EVERY_MS) return;
			lastDriftAsk = Date.now();
			// After the answer is on the wire, never under it.
			setTimeout(() => void handOverIfDrifted(), 0).unref?.();
		}

		// `shutdown` is a daemon method rather than a service one, so it is answered here instead of
		// in the service's table. It answers BEFORE stopping, or the caller reads its own success as
		// a dropped connection.
		async function handle(method: string, params: unknown): Promise<unknown> {
			if (stopping) throw new Error("the daemon is stopping");
			if (method === "shutdown") {
				setTimeout(() => void shutdown("asked to shut down"), 0).unref?.();
				return { stopping: true };
			}
			// Asking about the workspace IS the request to index it.
			warm();

			// Retirement asks this of a daemon whose warmup may have failed; the journal, not the index, answers it.
			const refusal = method === "refactorStatus" ? null : warmRefusal(service);
			if (refusal !== null) throw refusal;
			// Counted so shutdown waits for the answer and the linger cannot fire under it.
			inFlight += 1;
			try {
				return await dispatch(method, params);
			} finally {
				inFlight -= 1;
				if (inFlight === 0) {
					for (const waiter of settledWaiters.splice(0)) waiter();
					considerHandover();
				}
			}
		}

		// Answering BEFORE the first scan, on purpose. Publishing the lock only once indexing
		// finished meant a client could not find the daemon for the length of a full scan, so every
		// session paid that scan in its own process instead. An early answer is drawn from a partial
		// index, which is why the index reports its state rather than letting a caller assume it.
		daemon.setHandle(handle);

		if (openStore.totals().files > 0 || warmRequested) warm();
		else log("cold: nothing indexed here before, so nothing is scanned until something asks");

		linger = lingerWhileEmpty({
			afterMs: DEFAULT_LINGER_MS,
			stop: () => void shutdown(`no clients for ${DEFAULT_LINGER_MS / 60_000} minutes`),
			// Issue #7: counting only connections stopped the daemon under a running rename the
			// moment its client timed out and disconnected.
			holdWhile: () => {
				if (inFlight > 0) return `${inFlight} request(s) in flight`;
				if (journal.status().open) return "a refactor transaction is open";
				return null;
			},
			onHeld: (reason) => log(`idle timer fired with ${reason}; staying up`),
		});
		// Wired only now that everything it tears down exists. Starting armed rather than waiting
		// for a first disconnect: a daemon nobody ever connects to must not sit forever either.
		observe = linger.observe;
		linger.observe(daemon.connections());
	} catch (error) {
		log(`startup failed: ${describeError(error)}`);
		await shutdown("startup failed", 1);
	}
}

if (import.meta.main) await main(process.argv.slice(2));
