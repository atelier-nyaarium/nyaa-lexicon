// The daemon as a runnable program.
//
//   node dist/daemon.js <workspace>
//
// Indexes once at start, then serves until stopped. The index is a real file rather than memory,
// so a restart re-uses what it already knows.
//
// It runs detached with stdio pointed at the workspace's daemon.log, so every line here is the
// only record of what happened.

import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { type RunningDaemon, startDaemon } from "./daemon.js";
import { type Collector, enableSelfReports, nodeReportSetup, startDiagnostics } from "./diagnostics.js";
import { createDispatch } from "./dispatch.js";
import { driftedTo } from "./drift.js";
import { daemonCommand, spawnDaemonProcess } from "./ensureDaemon.js";
import { storeCompatibilityKey } from "./fingerprint.js";
import { DEFAULT_LINGER_MS, lingerWhileEmpty } from "./lifetime.js";
import { startLiveIndex } from "./liveIndex.js";
import { currentHost, workspacePaths } from "./paths.js";
import { describeStart, lexiconRoot, startProviders } from "./providers.js";
import { LexiconService } from "./service.js";
import { DaemonStartingError } from "./socketTransport.js";
import { IndexStore } from "./store.js";
import { ProviderSupervisor } from "./supervisor.js";
import { TransactionManager } from "./transactions.js";
import { BUILD_VERSION } from "./version.js";
import { admitWorkspace } from "./workspaceAdmission.js";
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
	const startedAt = Date.now();
	// A successor is told to warm because its predecessor was warm; nobody should notice the swap.
	const warmRequested = argv.includes("--warm");
	const [workspace] = argv.filter((arg) => !arg.startsWith("--"));
	if (workspace === undefined) {
		console.error("usage: daemon <workspace> [--warm]");
		process.exit(2);
	}

	const root = path.resolve(workspace);
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

	const paths = workspacePaths(host, root);
	mkdirSync(paths.dir, { recursive: true });
	// Before anything allocates: a fatal error from here on leaves a report, not only a log line.
	const reportsOff = enableSelfReports(paths.reportsDir);
	if (reportsOff !== null) log(`crash reports off: ${reportsOff}`);
	const nodeReport = nodeReportSetup(paths.reportsDir);
	if (nodeReport.failure !== undefined) log(`provider crash reports off: ${nodeReport.failure}`);

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
		onConnections: (n) => observe(n),
		startingNote: () => ({
			retryInMs: Math.max(0, startingSince + STARTUP_ALLOWANCE_MS - Date.now()),
			waitingFor,
		}),
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
		const opened = IndexStore.open(paths.index, storeCompatibilityKey(lexiconRoot()), root);
		store = opened.store;
		if (opened.rebuilt) log(`${opened.reason ?? "the index could not be trusted"}; rebuilt from empty`);

		const spawned = new ProviderSupervisor();
		supervisor = spawned;
		// Held until the collector exists, so a death during startup is still an incident.
		const earlyExits: Parameters<Collector["recordExit"]>[0][] = [];
		spawned.observeExits((exit) => (collector === null ? earlyExits.push(exit) : collector.recordExit(exit)));
		startingSince = Date.now();
		waitingFor = "the language providers to start";
		const providers = await startProviders(spawned, root, { node: nodeReport });
		log(`providers:\n${describeStart(providers)}`);

		const openStore = store;
		const service = new LexiconService(
			openStore,
			supervisor,
			(module) => {
				try {
					return readFileSync(path.join(root, module), "utf8");
				} catch {
					return null;
				}
			},
			root,
		);

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
			signal: (pid, signal) => spawned.signal(pid, signal),
			onError: (message) => log(message),
		});
		for (const exit of earlyExits.splice(0)) collector.recordExit(exit);
		log(`diagnostics ${paths.diagnosticsFile}`);

		// Warming is opt-in, and the opt-in is having indexed here before. A directory nobody meant to
		// index costs nothing until something asks about it.
		let scan: Promise<void> | null = null;
		// Content means an earlier run scanned it, so only an empty store makes a caller wait.
		let everScanned = openStore.totals().files > 0;
		function warm(): void {
			scan ??= (async () => {
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
				everScanned = true;

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
					onApplied: (applied) => {
						const touched = applied.filter((o) => o.action !== "skipped");
						const failures = applied.filter((o) => o.failure !== undefined);
						if (touched.length > 0) log(`reindexed ${touched.map((o) => o.module).join(", ")}`);
						if (failures.length > 0)
							log(`reindex failures: ${failures.map((o) => `${o.module}: ${o.failure}`).join(", ")}`);
					},
					onError: (error) => log(`reindex failed: ${error instanceof Error ? error.message : error}`),
				});
			})();
		}

		// The owner's rule for staying current: notice a newer build only between answered requests,
		// serve the call in hand, and never leave a mutation or an open refactor series behind.
		const stampAtStart = daemon.lock.bundleStamp ?? null;
		let lastDriftAsk = 0;
		async function handOverIfDrifted(): Promise<void> {
			const target = driftedTo({
				workspaceRoot: root,
				root: lexiconRoot(),
				version: BUILD_VERSION,
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
					// Lock released above, so the successor's claim cannot lose to a corpse.
					const command = daemonCommand(root, target.root);
					if (command === null) log(`no runnable bundle under ${target.root}; the next client starts one`);
					else spawnDaemonProcess([...command, "--warm"], paths.logFile);
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

			// The first answer requires declarations and imports; full facts may remain pending.
			if (!everScanned) {
				const status = service.indexStatus();
				throw new DaemonStartingError(
					`warming the index (${status.done} of ${status.total} files outlined)`,
					FIRST_SCAN_PATIENCE_MS,
					"the warmup pass",
				);
			}
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
