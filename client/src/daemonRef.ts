// Which daemon answered, so a caller can stop exactly that one and never its replacement.

import type { DaemonLock } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Refs

/** Held here only, so logging or serializing a ref never carries its token. */
const tokens = new WeakMap<DaemonRef, string>();

/** One daemon as a session met it. */
export class DaemonRef {
	readonly pid: number;
	readonly startedAt: number;

	constructor(lock: DaemonLock) {
		this.pid = lock.pid;
		this.startedAt = lock.startedAt;
		tokens.set(this, lock.token);
	}
}

/** Whether `lock` is still the daemon `ref` names. */
export function refersTo(ref: DaemonRef, lock: DaemonLock): boolean {
	return tokens.get(ref) === lock.token;
}
