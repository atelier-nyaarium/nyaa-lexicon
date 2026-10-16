// WAL frames retain deleted bytes until checkpoint truncation.
// Metadata preserves purge debt across crashes.
// Rewrites scrub freed pages once per major.
// Rebuilds replace stores through a staged file.

import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	openSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Clock, TimerHandle } from "./clock.js";
import { Database, type Statements } from "./database.js";
import type { SecretAdmission } from "./secretPolicy.js";
import { runInWorker, type StatementRunner } from "./statementWorker.js";
import { BUILD_MAJOR } from "./version.js";

////////////////////////////////
//  Interfaces & Types

export interface PurgeState {
	pending: boolean;
	/** Start of pending purge. */
	since: number | null;
	/** Truncation attempts. */
	attempts: number;
}

/** Null admission means the row is plain. */
export interface HeldAdmission {
	stamp: string | null;
	admittedAs: string | null;
}

export type InstallPoint = "built" | "logGone" | "renamed";

/** Scrub and file-install hooks. */
export interface ScrubOptions {
	/** Major recorded after rewriting. */
	major?: number;
	/** Available bytes on the target volume. */
	freeBytes?: (target: string) => number;
	/** SQLite's temporary rewrite directory, if known. */
	tempDirectory?: () => string | null;
	/** Rewrites the open store in place. */
	vacuum?: (db: Statements) => void;
	/** Rewrites in a worker. */
	run?: StatementRunner;
	/** Called when a rewrite starts. */
	starting?: (bytes: number) => void;
	/** False defers the rewrite. */
	inline?: boolean;
	/** Throws to simulate a crash at an install point. */
	reached?: (point: InstallPoint) => void;
}

/** Outcome of a due scrub. */
export type ScrubReport =
	| { status: "done"; major: number; ms: number }
	| { status: "deferred"; major: number; reason: string };

////////////////////////////////
//  Constants

/** Whether the WAL may hold deleted bytes. */
const PENDING_KEY = "securePurgePending";

/** Highest rewritten major. */
const SCRUBBED_KEY = "scrubbedMajor";

/** SQLite sidecars removed with their file. */
const SIDECARS = ["-wal", "-shm", "-journal"];

/** Retryable SQLite errors. */
const DEFERRABLE = new Set([5, 6, 13]);

/** Delay between idle retries. */
export const PURGE_RETRY_MS = 500;

////////////////////////////////
//  Functions & Helpers

/** Commits purge debt with its delete. */
function armPurge(db: Statements): void {
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(PENDING_KEY, "1");
}

/** Plain rows owe truncation when their stamp changes or policy guards them. */
export function owesTruncate(held: HeldAdmission, next: Pick<SecretAdmission, "stamp" | "as">): boolean {
	return (held.admittedAs ?? "plain") === "plain" && (held.stamp !== next.stamp || next.as !== "plain");
}

function recordScrubbed(db: Statements, major: number): void {
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(SCRUBBED_KEY, String(major));
}

/** Records zeroed pages at the scrubbed major. */
export function markNew(db: Statements, options: ScrubOptions = {}): void {
	recordScrubbed(db, options.major ?? BUILD_MAJOR);
}

/** Last scrubbed major, or null. */
function scrubbedMajor(db: Statements): number | null {
	const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SCRUBBED_KEY) as { value: string } | undefined;
	return row !== undefined && /^\d+$/.test(row.value) ? Number(row.value) : null;
}

const vacuum = (db: Statements): void => db.exec("VACUUM");

/** Whether metadata requires rewriting. */
function scrubDue(file: string, major: number): boolean {
	if (!existsSync(file)) return false;
	let db: Database;
	try {
		db = Database.open(file, { readOnly: true });
	} catch {
		return false;
	}
	try {
		const held = scrubbedMajor(db);
		return held === null || held < major;
	} catch {
		// Missing metadata means the store needs building.
		return false;
	} finally {
		db.close();
	}
}

/** Available target space, or unbounded when unknown. */
function freeBytesAt(target: string): number {
	try {
		const { bavail, bsize } = statfsSync(target);
		return bavail * bsize;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/**
 * Chooses SQLite's first writable temp directory, ending at the working directory.
 */
export function sqliteTempDirectory(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
	if (platform === "win32") return tmpdir();
	for (const candidate of [env["SQLITE_TMPDIR"], env["TMPDIR"], "/var/tmp", "/usr/tmp", "/tmp", "."]) {
		if (candidate === undefined) continue;
		try {
			if (!statSync(candidate).isDirectory()) continue;
			accessSync(candidate, constants.R_OK | constants.W_OK | constants.X_OK);
			return path.resolve(candidate);
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

/** Whether paths share a volume. */
function sharedVolume(a: string, b: string): boolean {
	try {
		return statSync(a).dev === statSync(b).dev;
	} catch {
		return false;
	}
}

/** File size, or zero when absent. */
function sizeOf(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

/** Store file and WAL sizes. */
function storeBytes(file: string): number {
	return sizeOf(file) + sizeOf(`${file}-wal`);
}

export const megabytes = (bytes: number): string => `${Math.floor(bytes / 2 ** 20)} MB`;

/** Whether a rewrite failure can be retried. */
function deferrable(error: unknown): boolean {
	const code = (error as { errcode?: unknown } | null)?.errcode;
	return typeof code === "number" && DEFERRABLE.has(code & 0xff);
}

/** Why rewriting must wait, or null. */
function shortOf(file: string, options: ScrubOptions): string | null {
	const size = storeBytes(file);
	const freeBytes = options.freeBytes ?? freeBytesAt;
	const free = freeBytes(file);
	if (free < size) return `${megabytes(free)} free, and the store holds ${megabytes(size)}`;
	const temp = (options.tempDirectory ?? sqliteTempDirectory)();
	if (temp === null) return null;
	// A rewrite may need two store-sized copies on one volume.
	const need = sharedVolume(file, temp) ? size * 2 : size;
	const room = freeBytes(temp);
	return room < need ? `${megabytes(room)} free in ${temp}, and the rewrite needs ${megabytes(need)}` : null;
}

const deferredReport = (major: number, reason: string): ScrubReport => ({ status: "deferred", major, reason });

/** Stages a store beside its target. */
export const stagingOf = (file: string): string => `${file}.seeding`;

/** Removes the stage and SQLite sidecars. */
export function clearStaging(file: string): void {
	const staged = stagingOf(file);
	for (const each of [staged, ...SIDECARS.map((sidecar) => `${staged}${sidecar}`)]) rmSync(each, { force: true });
}

/** Truncates the WAL; false while readers hold frames. */
function emptied(db: Statements): boolean {
	try {
		const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number };
		return row.busy === 0 && row.log <= 0;
	} catch {
		return false;
	}
}

/** Syncs deletions before a rename. */
function syncDirectory(directory: string): void {
	try {
		const handle = openSync(directory, "r");
		try {
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
	} catch {
		// Some platforms sync directory changes on their own.
	}
}

/**
 * Truncate WAL before rename; otherwise it attaches to the replacement.
 * Close held after truncation. Rename leaves a complete old or new store.
 */
export function installStaged(file: string, held: Database | null, options: ScrubOptions = {}): void {
	options.reached?.("built");
	if (held !== null) {
		if (!emptied(held)) throw new Error(`${file} is held by another connection and could not be replaced`);
		held.close();
	}
	for (const sidecar of SIDECARS) rmSync(`${file}${sidecar}`, { force: true });
	syncDirectory(path.dirname(file));
	options.reached?.("logGone");
	renameSync(stagingOf(file), file);
	options.reached?.("renamed");
}

////////////////////////////////
//  Class

export class StorePurge {
	private pending: boolean;
	private since: number | null;
	private attempts = 0;
	private retry: TimerHandle | null = null;
	private closed = false;

	/** True during writes, when checkpoints cannot run. */
	constructor(
		private readonly db: Database,
		private readonly clock: Clock,
		private readonly writing: () => boolean,
	) {
		this.pending = db.prepare("SELECT 1 FROM meta WHERE key = ?").get(PENDING_KEY) !== undefined;
		this.since = this.pending ? clock.now() : null;
	}

	/** Arms purge debt in the open transaction. */
	arm(): void {
		armPurge(this.db);
		this.pending = true;
		this.since ??= this.clock.now();
	}

	/**
	 * Clears purge debt only after truncation. `wait: false` skips reader waits; retries run while idle.
	 */
	settle(wait: boolean): void {
		if (!this.pending || this.closed) return;
		if (this.writing()) {
			this.retryLater();
			return;
		}
		this.attempts++;
		if (wait ? this.truncated() : this.db.unwaited(() => this.truncated())) this.clear();
		else this.retryLater();
	}

	state(): PurgeState {
		return { pending: this.pending, since: this.since, attempts: this.attempts };
	}

	/**
	 * Rewrites freed pages once per major; null when current. Records the marker after rewriting.
	 * Defers for space or locks, and blocks this thread while it runs.
	 */
	scrub(file: string, options: ScrubOptions = {}): ScrubReport | null {
		if (options.inline === false) return null;
		const major = options.major ?? BUILD_MAJOR;
		const held = scrubbedMajor(this.db);
		if (held !== null && held >= major) return null;
		const short = shortOf(file, options);
		if (short !== null) return deferredReport(major, short);
		const started = this.clock.now();
		try {
			(options.vacuum ?? vacuum)(this.db);
		} catch (error) {
			if (!deferrable(error)) throw error;
			return deferredReport(major, error instanceof Error ? error.message : String(error));
		}
		return this.finishScrub(major, started);
	}

	/**
	 * Rewrites in a worker; records debt and marker after close. Null when current.
	 */
	static async scrubAhead(file: string, clock: Clock, options: ScrubOptions = {}): Promise<ScrubReport | null> {
		const major = options.major ?? BUILD_MAJOR;
		if (!scrubDue(file, major)) return null;
		const short = shortOf(file, options);
		if (short !== null) return deferredReport(major, short);
		const started = clock.now();
		options.starting?.(storeBytes(file));
		try {
			await (options.run ?? runInWorker)({ file, sql: "VACUUM" });
		} catch (error) {
			if (!deferrable(error)) throw error;
			return deferredReport(major, error instanceof Error ? error.message : String(error));
		}
		const db = Database.open(file);
		const purge = new StorePurge(db, clock, () => false);
		try {
			return purge.finishScrub(major, started);
		} finally {
			purge.close();
			db.close();
		}
	}

	/** Stops retries; pending debt waits for next open. */
	close(): void {
		this.closed = true;
		this.cancelRetry();
	}

	/** Pays WAL debt, then records the major. */
	private finishScrub(major: number, started: number): ScrubReport {
		this.arm();
		this.settle(true);
		const ms = this.clock.now() - started;
		recordScrubbed(this.db, major);
		return { status: "done", major, ms };
	}

	/** True when the log is empty and debt is cleared. */
	private truncated(): boolean {
		if (!emptied(this.db)) return false;
		try {
			this.db.prepare("DELETE FROM meta WHERE key = ?").run(PENDING_KEY);
			return true;
		} catch {
			return false;
		}
	}

	private clear(): void {
		this.pending = false;
		this.since = null;
		this.attempts = 0;
		this.cancelRetry();
	}

	private retryLater(): void {
		if (this.retry !== null) return;
		this.retry = this.clock.setTimer(() => {
			this.retry = null;
			this.settle(false);
		}, PURGE_RETRY_MS);
	}

	private cancelRetry(): void {
		if (this.retry === null) return;
		this.clock.clearTimer(this.retry);
		this.retry = null;
	}
}
