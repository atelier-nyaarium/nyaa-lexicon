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
import { IndexStore } from "./store.js";
import { ProviderSupervisor } from "./supervisor.js";

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
	const paths = workspacePaths(host, root);
	mkdirSync(paths.dir, { recursive: true });

	// The state dir is the one directory this process owns. A cwd inside the project pins it: on
	// Windows the folder cannot be renamed or deleted while a live process sits in it.
	process.chdir(paths.dir);

	// Claiming BEFORE the store opens is what resolves two sessions starting a daemon at once: the
	// loser exits here, having never touched SQLite, and both clients connect to whoever won.
	// `observe` is deferred because the linger needs the daemon it will stop.
	let observe: (connections: number) => void = () => {};
	const outcome = await startDaemon({ workspaceRoot: root, onConnections: (n) => observe(n) });
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

	const dispatch = createDispatch(service);

	// `shutdown` is a daemon method rather than a service one, so it is answered here instead of in
	// the service's table. It answers BEFORE stopping, or the caller reads its own success as a
	// dropped connection.
	async function handle(method: string, params: unknown): Promise<unknown> {
		if (method !== "shutdown") return dispatch(method, params);
		setTimeout(() => void shutdown("asked to shut down"), 0).unref?.();
		return { stopping: true };
	}

	// Answering BEFORE the first scan, on purpose. Publishing the lock only once indexing finished
	// meant a client could not find the daemon for the length of a full scan, so every session paid
	// that scan in its own process instead. An early answer is drawn from a partial index, which is
	// why the index reports its state rather than letting a caller assume it.
	daemon.setHandle(handle);

	const started = Date.now();
	const outcomes = await service.indexWorkspace();
	const indexed = outcomes.filter((o) => o.action === "indexed");
	const symbols = indexed.reduce((total, o) => total + (o.declarations ?? 0), 0);
	console.log(`scope: ${service.scopeReport()}`);
	console.log(`indexed ${indexed.length} files, ${symbols} symbols, ${Date.now() - started}ms`);

	const live = startLiveIndex({
		service,
		workspaceRoot: root,
		onApplied: (outcomes) => {
			const touched = outcomes.filter((o) => o.action !== "skipped");
			if (touched.length > 0) console.log(`reindexed ${touched.map((o) => o.module).join(", ")}`);
		},
		onError: (error) => console.log(`reindex failed: ${error instanceof Error ? error.message : error}`),
	});

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
		live.stop();
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
