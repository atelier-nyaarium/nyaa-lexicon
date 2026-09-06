// Turns filesystem noise into the events `invalidation.ts` decides on.
//
// Everything interesting is in that pure decision. This half only debounces, hashes, and converts
// an absolute path into a workspace-relative module.

import { type FSWatcher, watch } from "node:fs";
import { hashContent, workspaceModule } from "@nyaa-lexicon/protocol";
import { type Clock, systemClock, type TimerHandle } from "./clock.js";
import type { FileEvent } from "./invalidation.js";
import { readSource } from "./sourceRead.js";

////////////////////////////////
//  Interfaces & Types

/** What may be read: the scope as it stands, then git for the rest, once per burst. */
export interface WatchScope {
	/** True for a module the scope admits or the index holds. Read without asking git. */
	admits: (module: string) => boolean;
	/** Which of the rest git ignores. Null when git cannot say, and every one is then read. */
	ignored: (modules: string[]) => Set<string> | null;
}

export interface WatchOptions {
	workspaceRoot: string;
	/** Called with a coalesced batch once the burst settles. */
	onBatch: (events: FileEvent[]) => void;
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

/** The paths of a burst that may be read, in arrival order: git is asked once, for what the scope does not hold. */
export function admitted(modules: string[], scope: WatchScope | undefined): string[] {
	if (scope === undefined) return modules;
	const unknown = modules.filter((module) => !scope.admits(module));
	const ignored = unknown.length === 0 ? new Set<string>() : scope.ignored(unknown);
	if (ignored === null) return modules;
	return modules.filter((module) => !ignored.has(module));
}

/** The protocol's, re-exported: the index and a consumer's own read must hash alike. */
export { hashContent };

/**
 * Read a file into an event, or report it deleted.
 *
 * A file that vanished between the notification and the read is a delete, not an error: that race
 * is the ordinary case during a branch switch, and treating it as failure would stop the batch.
 */
export function readEvent(workspaceRoot: string, module: string): FileEvent {
	const read = readSource(workspaceRoot, module);
	if (read.kind === "missing") return { kind: "deleted", module };
	// Unhashable as text; the indexer reads it and says why.
	return { kind: "changed", module, contentHash: read.kind === "text" ? hashContent(read.text) : null };
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

	// Paths only. A file is read once per burst, at flush, after the scope has spoken.
	const pending = new Set<string>();
	let timer: TimerHandle | null = null;
	let deadline: TimerHandle | null = null;
	let stopped = false;

	function disarm(): void {
		if (timer !== null) clock.clearTimer(timer);
		if (deadline !== null) clock.clearTimer(deadline);
		timer = null;
		deadline = null;
	}

	function flush(): void {
		disarm();
		const modules = [...pending];
		pending.clear();
		const batch = admitted(modules, options.scope).map((module) => readEvent(options.workspaceRoot, module));
		if (batch.length > 0) options.onBatch(batch);
	}

	function record(module: string): void {
		if (stopped || isIgnored(module, ignore)) return;
		pending.add(module);
		if (timer !== null) clock.clearTimer(timer);
		timer = clock.setTimer(flush, debounceMs);
		deadline ??= clock.setTimer(flush, maxWaitMs);
	}

	const watcher: FSWatcher = watch(options.workspaceRoot, { recursive: true }, (_event, filename) => {
		if (filename === null) return;
		record(filename.toString().replace(/\\/g, "/"));
	});

	return {
		inject: record,
		stop: () => {
			stopped = true;
			disarm();
			watcher.close();
		},
	};
}
