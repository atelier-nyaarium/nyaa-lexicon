// Every failure a session raises is one of these three, so a consumer matches a class, never a
// message.
//
// A daemon's own words travel inside DaemonError; the other two are the client's own verdicts,
// reached before any daemon is asked.

import { GATE_BUSY_CODE } from "@nyaa-lexicon/protocol";
import type { DaemonRef } from "./daemonRef.js";

////////////////////////////////
//  Errors

/** No install to spawn from: no record, or a root that no longer holds one. */
export class NotInstalled extends Error {
	readonly root: string | undefined;

	constructor(message: string, root?: string) {
		super(message);
		this.name = "NotInstalled";
		this.root = root;
	}
}

/** The two protocol versions cannot meet: this client's, and the install's or the daemon's. */
export class Incompatible extends Error {
	constructor(
		message: string,
		readonly client: string,
		readonly installed: string,
	) {
		super(message);
		this.name = "Incompatible";
	}
}

/** Two Lexicon versions that cannot talk, worded for the person who reloads one of them. */
export function mismatchText(ours: string, theirs: { label: string; version: string }, fix: string): string {
	return `Current version in this window: protocol ${ours}\n${theirs.label}: protocol ${theirs.version}\n${fix}`;
}

/** A daemon answered a request's `exclude` without applying it. */
export function unfiltered(method: string, client: string, daemon: string): Incompatible {
	return new Incompatible(
		`the daemon answered ${method} without applying \`exclude\`; it speaks protocol ${daemon}. Update the Lexicon install so a daemon that filters replaces it.`,
		client,
		daemon,
	);
}

export interface DaemonErrorDetails {
	/** The wait that expired. */
	waitingFor?: string | undefined;
	/** Wire codes are open; this field retains recognized values only. */
	code?: string | undefined;
	/** Daemon that answered, for targeted shutdown. */
	from?: DaemonRef | undefined;
	/** `notRunning` over a lock a dead daemon left: it crashed rather than stopped. */
	stale?: boolean | undefined;
	/** `notRunning` over a live daemon older than the install, which a start replaces. */
	older?: boolean | undefined;
}

/**
 * Daemon failures.
 * `notRunning` means attach found no usable daemon; `requestTimeout` means the live socket did not answer.
 */
export class DaemonError extends Error {
	override readonly cause:
		| "unknownMethod"
		| "refusedModule"
		| "spawnFailed"
		| "connectionLost"
		| "requestTimeout"
		| "closed"
		| "notRunning"
		| "daemon";
	readonly waitingFor: string | undefined;
	/** `busy`: a bounded read never ran. */
	readonly code: "stopping" | "busy" | undefined;
	readonly from: DaemonRef | undefined;
	readonly stale: boolean;
	readonly older: boolean;

	constructor(message: string, cause: DaemonError["cause"] = "daemon", details: DaemonErrorDetails = {}) {
		super(message);
		this.name = "DaemonError";
		this.cause = cause;
		this.waitingFor = details.waitingFor;
		this.code = details.code === "stopping" || details.code === GATE_BUSY_CODE ? details.code : undefined;
		this.from = details.from;
		this.stale = details.stale === true;
		this.older = details.older === true;
	}
}
