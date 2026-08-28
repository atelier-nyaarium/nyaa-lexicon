// Every failure a session raises is one of these three, so a consumer matches a class, never a
// message.
//
// A daemon's own words travel inside DaemonError; the other two are the client's own verdicts,
// reached before any daemon is asked.

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

/** The daemon refused, failed, or could not be reached; `waitingFor` names a wait that ran out. */
export class DaemonError extends Error {
	readonly waitingFor: string | undefined;

	constructor(message: string, waitingFor?: string) {
		super(message);
		this.name = "DaemonError";
		this.waitingFor = waitingFor;
	}
}
