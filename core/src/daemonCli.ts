// The daemon as a runnable program.
//
//   node dist/daemon.js <workspace>
//
// Indexes once at start, then serves until stopped. The index is a real file rather than memory,
// so a restart re-uses what it already knows.

import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { startDaemon } from "./daemon.js";
import { createDispatch } from "./dispatch.js";
import { indexerFingerprint } from "./fingerprint.js";
import { DEFAULT_LINGER_MS, lingerWhileEmpty } from "./lifetime.js";
import { startLiveIndex } from "./liveIndex.js";
import { currentHost, workspacePaths } from "./paths.js";
import { describeStart, lexiconRoot, startProviders } from "./providers.js";
import { LexiconService } from "./service.js";
import { DaemonStartingError } from "./socketTransport.js";
import { IndexStore } from "./store.js";
import { ProviderSupervisor } from "./supervisor.js";
import { TransactionManager } from "./transactions.js";
import { admitWorkspace } from "./workspaceAdmission.js";
import { WorkspaceGate } from "./workspaceGate.js";

////////////////////////////////
//  Constants

/** Headroom over the slowest provider start. Published to clients rather than mirrored by them. */
const STARTUP_ALLOWANCE_MS = 90_000;

/** Re-offered while the first scan runs. The client's ceiling ends the wait; the scan finishes anyway. */
const FIRST_SCAN_PATIENCE_MS = 30_000;

////////////////////////////////
//  Main

async function main(argv: string[]): Promise<void> {
	const [workspace] = argv;
	if (workspace === undefined) {
		console.error("usage: daemon <workspace>");
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

	// The state dir is the one directory this process owns. A cwd inside the project pins it: on
	// Windows the folder cannot be renamed or deleted while a live process sits in it.
	process.chdir(paths.dir);

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
		console.log(`not starting: ${outcome.reason}`);
		return;
	}
	const daemon = outcome.daemon;
	console.log(`listening on 127.0.0.1:${daemon.lock.port} for ${root}`);
	console.log(`lock ${paths.lockFile}`);

	const { store, rebuilt, reason } = IndexStore.open(paths.index, indexerFingerprint(lexiconRoot()), root);
	if (rebuilt) console.log(`${reason ?? "the index could not be trusted"}; rebuilt from empty`);

	const supervisor = new ProviderSupervisor();
	startingSince = Date.now();
	waitingFor = "the language providers to start";
	const providers = await startProviders(supervisor, root);
	console.log(`providers:\n${describeStart(providers)}`);

	const service = new LexiconService(
		store,
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
	const transactions = new TransactionManager(store, root);

	// Before the handler is published, so nothing can ask about a workspace still holding a
	// half-applied step. The lock is already claimed, so no other daemon is writing here.
	const recovered = await gate.exclusive(async () => {
		const outcome = transactions.recover();
		// Restoring puts back text the index does not describe, so the facts for those files are of
		// a version that no longer exists. Reindexed here rather than left to the warm scan, which
		// is opt-in and may never run.
		for (const module of outcome.restored) await service.indexFile(module);
		return outcome;
	});
	if (recovered.recovered) {
		console.log(`recovered refactor ${recovered.transactionId}: restored ${recovered.restored.length} file(s)`);
		if (recovered.conflicts.length > 0) {
			console.log(`left alone, changed by someone else: ${recovered.conflicts.join(", ")}`);
		}
	}

	const dispatch = createDispatch(service, { gate, transactions });

	// Warming is opt-in, and the opt-in is having indexed here before. A directory nobody meant to
	// index costs nothing until something asks about it.
	let scan: Promise<void> | null = null;
	let live: { stop: () => void } | null = null;
	// Content means an earlier run scanned it, so only an empty store makes a caller wait.
	let everScanned = store.totals().files > 0;
	function warm(): void {
		scan ??= (async () => {
			const started = Date.now();
			const outcomes = await service.indexWorkspace();
			const indexed = outcomes.filter((o) => o.action === "indexed");
			const failures = outcomes.filter((o) => o.failure !== undefined);
			const symbols = indexed.reduce((total, o) => total + (o.declarations ?? 0), 0);
			console.log(`scope: ${service.scopeReport()}`);
			console.log(`indexed ${indexed.length} files, ${symbols} symbols, ${Date.now() - started}ms`);
			if (failures.length > 0)
				console.log(`index failures: ${failures.map((o) => `${o.module}: ${o.failure}`).join(", ")}`);
			everScanned = true;

			// Watching starts with warming: a watcher over an unasked-for workspace would index it
			// on the next file change anyway.
			live = startLiveIndex({
				service,
				workspaceRoot: root,
				gate,
				onApplied: (applied) => {
					const touched = applied.filter((o) => o.action !== "skipped");
					const failures = applied.filter((o) => o.failure !== undefined);
					if (touched.length > 0) console.log(`reindexed ${touched.map((o) => o.module).join(", ")}`);
					if (failures.length > 0)
						console.log(`reindex failures: ${failures.map((o) => `${o.module}: ${o.failure}`).join(", ")}`);
				},
				onError: (error) => console.log(`reindex failed: ${error instanceof Error ? error.message : error}`),
			});
		})();
	}

	// `shutdown` is a daemon method rather than a service one, so it is answered here instead of in
	// the service's table. It answers BEFORE stopping, or the caller reads its own success as a
	// dropped connection.
	async function handle(method: string, params: unknown): Promise<unknown> {
		if (method === "shutdown") {
			setTimeout(() => void shutdown("asked to shut down"), 0).unref?.();
			return { stopping: true };
		}
		// Asking about the workspace IS the request to index it.
		warm();

		// A first scan makes the caller wait: "no such symbol" from an empty store reads as settled.
		// A rescan does not, since there is a real index to answer from meanwhile.
		if (!everScanned) {
			const status = service.indexStatus();
			throw new DaemonStartingError(
				`the first index is still building (${status.done} of ${status.total})`,
				FIRST_SCAN_PATIENCE_MS,
				"the first index",
			);
		}
		return dispatch(method, params);
	}

	// Answering BEFORE the first scan, on purpose. Publishing the lock only once indexing finished
	// meant a client could not find the daemon for the length of a full scan, so every session paid
	// that scan in its own process instead. An early answer is drawn from a partial index, which is
	// why the index reports its state rather than letting a caller assume it.
	daemon.setHandle(handle);

	if (store.totals().files > 0) warm();
	else console.log("cold: nothing indexed here before, so nothing is scanned until something asks");

	// One way out, whatever asked for it: the signal, the RPC, and the linger all land here, so
	// there is no second teardown order to keep in step with this one. The lock goes first, since
	// removing it is what stops a client connecting to a dead port.
	let stopping = false;
	async function shutdown(why: string): Promise<void> {
		if (stopping) return;
		stopping = true;
		console.log(`stopping: ${why}`);
		linger.cancel();
		await daemon.stop();
		live?.stop();
		supervisor.stopAll();
		store.close();
		process.exit(0);
	}

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => void shutdown(signal));
	}

	const linger = lingerWhileEmpty({
		afterMs: DEFAULT_LINGER_MS,
		stop: () => void shutdown(`no clients for ${DEFAULT_LINGER_MS / 60_000} minutes`),
	});
	// Wired only now that everything it tears down exists. Starting armed rather than waiting for
	// a first disconnect: a daemon nobody ever connects to must not sit forever either.
	observe = linger.observe;
	linger.observe(daemon.connections());
}

if (import.meta.main) await main(process.argv.slice(2));
