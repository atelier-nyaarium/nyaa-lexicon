// Turns filesystem noise into the events `invalidation.ts` decides on.
//
// Everything interesting is in that pure decision. This half only debounces, hashes, and converts
// an absolute path into a workspace-relative module.

import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { coalesce, type FileEvent } from "./invalidation.js";
import { readSource } from "./sourceRead.js";

////////////////////////////////
//  Interfaces & Types

export interface WatchOptions {
	workspaceRoot: string;
	/** Called with a coalesced batch once the burst settles. */
	onBatch: (events: FileEvent[]) => void;
	/** How long to wait for a burst to settle. A branch switch is one batch, not hundreds. */
	debounceMs?: number;
	/** Path segments never watched, matched exactly against any segment. */
	ignore?: string[];
}

export interface RunningWatcher {
	stop: () => void;
	/** Feeds an event as if the filesystem reported it. The seam the tests drive. */
	inject: (relative: string) => void;
}

////////////////////////////////
//  Constants

const DEFAULT_DEBOUNCE_MS = 50;

/** Directories whose churn is never the user's source, and which dwarf it in volume. */
const DEFAULT_IGNORE = ["node_modules", ".git", "dist", ".tsbuild", "target", "__pycache__"];

////////////////////////////////
//  Functions & Helpers

/** Same normalization the symbol id grammar uses, so a module means one thing everywhere. */
export function toModule(workspaceRoot: string, absolute: string): string | null {
	const relative = path.relative(workspaceRoot, absolute).replace(/\\/g, "/");
	// Outside the workspace: `relative` climbs out, and such a file has no module identity.
	return relative === "" || relative.startsWith("../") ? null : relative;
}

export function isIgnored(module: string, ignore: string[]): boolean {
	return module.split("/").some((segment) => ignore.includes(segment));
}

export function hashContent(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

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

	let pending: FileEvent[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	function flush(): void {
		const batch = coalesce(pending);
		pending = [];
		if (batch.length > 0) options.onBatch(batch);
	}

	function record(module: string): void {
		if (stopped || isIgnored(module, ignore)) return;
		pending.push(readEvent(options.workspaceRoot, module));
		clearTimeout(timer);
		timer = setTimeout(flush, debounceMs);
		timer.unref?.();
	}

	const watcher: FSWatcher = watch(options.workspaceRoot, { recursive: true }, (_event, filename) => {
		if (filename === null) return;
		record(filename.toString().replace(/\\/g, "/"));
	});

	return {
		inject: record,
		stop: () => {
			stopped = true;
			clearTimeout(timer);
			watcher.close();
		},
	};
}
