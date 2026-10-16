// Turns filesystem noise into the events `invalidation.ts` decides on.
//
// Everything interesting is in that pure decision. This half only debounces, hashes, and converts
// an absolute path into a workspace-relative module.

import { type FSWatcher, statSync, watch } from "node:fs";
import path from "node:path";
import { hashContent, workspaceModule } from "@nyaa-lexicon/protocol";
import { type Clock, systemClock, type TimerHandle } from "./clock.js";
import type { FileEvent } from "./invalidation.js";
import type { EvidenceKind, EvidenceSubscription } from "./policyEvidence.js";
import { readSource, type SealedText } from "./sourceRead.js";

////////////////////////////////
//  Interfaces & Types

/** What may be read: the scope as it stands, then git for the rest, once per burst. */
export interface WatchScope {
	subscriptions: () => readonly EvidenceSubscription[];
	onSubscriptionsChanged: (listener: () => void) => () => void;
	/** Whether an event matters despite an ignored segment. */
	watchesModule: (module: string) => boolean;
	/** True for a module the scope admits, the index holds, or a provider reads as config. No git. */
	admits: (module: string) => boolean;
	/** Which of the rest git ignores. Null when git cannot say, so none here are ignored yet. */
	ignored: (modules: string[]) => Promise<Set<string> | null>;
}

/** Hash of policy-visible text. */
export type EventHasher = (read: SealedText) => string;

/** A flush's outcome: what may be read now, and what a failed git call left unresolved. */
export interface Admission {
	admitted: string[];
	/** Dropped by a failed git call rather than genuinely ignored; worth asking again. */
	retry: string[];
}

export interface WatchOptions {
	workspaceRoot: string;
	/** Called with a coalesced batch once the burst settles. */
	onBatch: (files: FileEvent[], evidence: readonly EvidenceKind[]) => void;
	/** Hashes event text with the index's policy. */
	hash: EventHasher;
	/** How long to wait for a burst to settle. A branch switch is one batch, not hundreds. */
	debounceMs?: number;
	/** A burst that never settles is still delivered this long after its first event. */
	maxWaitMs?: number;
	/** Path segments never watched, matched exactly against any segment. */
	ignore?: string[];
	/** Asked before a path is read. Absent, every path the segment list allows is read. */
	scope?: WatchScope;
	/** Injected so a test decides when a burst has settled. */
	clock?: Clock;
}

export interface RunningWatcher {
	stop: () => void;
	/** Feeds an event as if the filesystem reported it. The seam the tests drive. */
	inject: (relative: string) => void;
}

////////////////////////////////
//  Constants

const DEFAULT_DEBOUNCE_MS = 50;

const DEFAULT_MAX_WAIT_MS = 1000;

/** Directories whose churn is never the user's source, and which dwarf it in volume. */
const DEFAULT_IGNORE = ["node_modules", ".git", "dist", ".tsbuild", "target", "__pycache__"];

////////////////////////////////
//  Functions & Helpers

/** The id grammar's own key (NFC, forward slashes); null outside the workspace or unrepresentable. */
export function toModule(workspaceRoot: string, absolute: string): string | null {
	return workspaceModule(workspaceRoot, absolute);
}

export function isIgnored(module: string, ignore: string[]): boolean {
	return module.split("/").some((segment) => ignore.includes(segment));
}

/**
 * The paths of a burst that may be read, in arrival order: git is asked once, for what the scope
 * does not hold.
 *
 * Synchronous whenever nothing needs asking: no scope, or the scope already knows every path. Only
 * a genuine git call returns a promise, so a burst that never touches git never yields.
 *
 * A failed git call leaves the previous verdicts standing rather than re-scoping: only what the
 * scope already admits is kept, and a module git could not say anything new about is answered as
 * `retry` rather than being granted admission by the failure; the caller keeps it for a later flush.
 */
export function admitted(modules: string[], scope: WatchScope | undefined): Admission | Promise<Admission> {
	if (scope === undefined) return { admitted: modules, retry: [] };
	const unknown = modules.filter((module) => !scope.admits(module));
	if (unknown.length === 0) return { admitted: modules, retry: [] };
	return scope.ignored(unknown).then((ignored) => {
		if (ignored === null) {
			return {
				admitted: modules.filter((module) => scope.admits(module)),
				retry: modules.filter((module) => !scope.admits(module)),
			};
		}
		return { admitted: modules.filter((module) => !ignored.has(module)), retry: [] };
	});
}

/** The protocol's, re-exported: the index and a consumer's own read must hash alike. */
export { hashContent };

/**
 * Read a file into an event, or report it deleted.
 *
 * A file that vanished between the notification and the read is a delete, not an error: that race
 * is the ordinary case during a branch switch, and treating it as failure would stop the batch.
 */
export function readEvent(workspaceRoot: string, module: string, hash: EventHasher): FileEvent {
	const read = readSource(workspaceRoot, module);
	if (read.kind === "missing") return { kind: "deleted", module };
	// Unhashable as text; the indexer reads it and says why.
	return { kind: "changed", module, contentHash: read.kind === "text" ? hash(read) : null };
}

////////////////////////////////
//  Watching

/**
 * Watch a workspace and deliver coalesced batches.
 *
 * Recursive watching is not available on every platform, so a failure to watch is reported by
 * throwing at start rather than by silently delivering nothing, which would look like a repo where
 * nobody edits anything.
 */
export function watchWorkspace(options: WatchOptions): RunningWatcher {
	const ignore = options.ignore ?? DEFAULT_IGNORE;
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	const clock = options.clock ?? systemClock;

	// Paths only. A file is read once per burst, at flush, after the scope has spoken. A module a
	// failed git call dropped rides back in here too, so the next flush, whatever triggers it, asks
	// for it again rather than losing it.
	const pending = new Set<string>();
	const pendingEvidence = new Set<EvidenceKind>();
	let timer: TimerHandle | null = null;
	let deadline: TimerHandle | null = null;
	let retryTimer: TimerHandle | null = null;
	const subscriptionWatchers = new Map<
		string,
		{ watcher: FSWatcher | null; fingerprint: string; expected: string; keys: readonly EvidenceKind[] }
	>();
	let stopped = false;

	function disarm(): void {
		if (timer !== null) clock.clearTimer(timer);
		if (deadline !== null) clock.clearTimer(deadline);
		if (retryTimer !== null) clock.clearTimer(retryTimer);
		timer = null;
		deadline = null;
		retryTimer = null;
	}

	function deliver(admittedModules: string[], evidence: readonly EvidenceKind[]): void {
		if (stopped) return;
		const files = admittedModules.map((module) => readEvent(options.workspaceRoot, module, options.hash));
		if (files.length > 0 || evidence.length > 0) options.onBatch(files, evidence);
	}

	function schedule(): void {
		if (timer !== null) clock.clearTimer(timer);
		timer = clock.setTimer(flush, debounceMs);
		deadline ??= clock.setTimer(flush, maxWaitMs);
	}

	/** Keeps a dropped module pending, and bounds how long it waits when no new event revives it. */
	function retry(modules: string[]): void {
		if (stopped || modules.length === 0) return;
		for (const module of modules) pending.add(module);
		retryTimer ??= clock.setTimer(flush, maxWaitMs);
	}

	// Git-backed flushes deliver in trigger order, even when admission checks settle out of order.
	let tail: Promise<void> = Promise.resolve();
	let queued = 0;

	function flush(): void {
		disarm();
		const modules = [...pending];
		const evidence = [...pendingEvidence];
		pending.clear();
		pendingEvidence.clear();
		if (modules.length === 0 && evidence.length === 0) return;
		const result = admitted(modules, options.scope);
		if (!(result instanceof Promise) && queued === 0) {
			retry(result.retry);
			deliver(result.admitted, evidence);
			return;
		}
		queued += 1;
		const settled = result instanceof Promise ? result : Promise.resolve(result);
		tail = tail
			.then(() => settled)
			.then(
				(admission) => {
					queued -= 1;
					retry(admission.retry);
					deliver(admission.admitted, evidence);
				},
				// The call itself rejected, not merely answered null: read the whole burst rather than drop it.
				() => {
					queued -= 1;
					deliver(modules, evidence);
				},
			);
	}

	function record(module: string): void {
		if (stopped || (isIgnored(module, ignore) && options.scope?.watchesModule(module) !== true)) return;
		pending.add(module);
		schedule();
	}

	function recordEvidence(keys: readonly EvidenceKind[]): void {
		if (stopped || keys.length === 0) return;
		for (const key of keys) pendingEvidence.add(key);
		schedule();
	}

	function fingerprint(file: string): string {
		try {
			const stat = statSync(file);
			return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
		} catch {
			return "missing";
		}
	}

	function reconcileSubscriptions(): void {
		const subscriptions = options.scope?.subscriptions() ?? [];
		const wanted = new Set(subscriptions.map(({ path: subscriptionPath }) => subscriptionPath));
		for (const [subscriptionPath, current] of subscriptionWatchers) {
			if (wanted.has(subscriptionPath)) continue;
			current.watcher?.close();
			subscriptionWatchers.delete(subscriptionPath);
		}
		for (const subscription of subscriptions) {
			if (stopped || !path.isAbsolute(subscription.path)) continue;
			const current = subscriptionWatchers.get(subscription.path);
			if (current !== undefined) {
				const observed = fingerprint(subscription.path);
				const moved =
					observed !== subscription.fingerprint &&
					(observed !== current.fingerprint || current.expected !== subscription.fingerprint);
				current.fingerprint = observed;
				current.expected = subscription.fingerprint;
				current.keys = subscription.keys;
				if (moved) recordEvidence(subscription.keys);
				continue;
			}
			const state = {
				watcher: null as FSWatcher | null,
				fingerprint: "",
				expected: subscription.fingerprint,
				keys: subscription.keys,
			};
			subscriptionWatchers.set(subscription.path, state);
			try {
				state.watcher = watch(path.dirname(subscription.path), (_event, filename) => {
					if (filename !== null && filename.toString() !== path.basename(subscription.path)) return;
					const active = subscriptionWatchers.get(subscription.path);
					if (active === undefined) return;
					const next = fingerprint(subscription.path);
					if (next === active.fingerprint) return;
					active.fingerprint = next;
					recordEvidence(active.keys);
				});
				state.watcher.on("error", () => {
					if (subscriptionWatchers.get(subscription.path) !== state) return;
					state.watcher?.close();
					state.watcher = null;
				});
			} catch {}
			const observed = fingerprint(subscription.path);
			state.fingerprint = observed;
			if (observed !== subscription.fingerprint) recordEvidence(subscription.keys);
		}
	}

	const watcher: FSWatcher = watch(options.workspaceRoot, { recursive: true }, (_event, filename) => {
		if (filename === null) return;
		record(filename.toString().replace(/\\/g, "/"));
	});
	const stopWatchingScope = options.scope?.onSubscriptionsChanged(reconcileSubscriptions);
	reconcileSubscriptions();

	return {
		inject: record,
		stop: () => {
			stopped = true;
			disarm();
			stopWatchingScope?.();
			for (const subscription of subscriptionWatchers.values()) subscription.watcher?.close();
			subscriptionWatchers.clear();
			watcher.close();
		},
	};
}
