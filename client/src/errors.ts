// Every failure a session raises is one of these three, so a consumer matches a class, never a
// message.
//
// A daemon's own words travel inside DaemonError; the other two are the client's own verdicts,
// reached before any daemon is asked.

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

export interface DaemonErrorDetails {
	/** The wait that expired. */
	waitingFor?: string | undefined;
	/** Wire codes are open; this field retains recognized values only. */
	code?: string | undefined;
	/** Daemon that answered, for targeted shutdown. */
	from?: DaemonRef | undefined;
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
	readonly code: "stopping" | undefined;
	readonly from: DaemonRef | undefined;

	constructor(message: string, cause: DaemonError["cause"] = "daemon", details: DaemonErrorDetails = {}) {
		super(message);
		this.name = "DaemonError";
		this.cause = cause;
		this.waitingFor = details.waitingFor;
		this.code = details.code === "stopping" ? "stopping" : undefined;
		this.from = details.from;
	}
}
