// The store lock: who holds a store, and the one claim every holder makes.
//
// A daemon claims before it opens the store and a delete claims before it removes one, so the two
// cannot overlap: whichever links first holds the file, and the other reads a live holder.

import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { processIdentity } from "@nyaa-lexicon/client";
import { type DaemonLock, type LockRole, parseDaemonLock } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** Whether a lock's holder is alive as itself. Injected, since asking is a syscall. */
export type HolderAlive = (holder: { pid: number; pidStart?: string | undefined }) => boolean;

/** `stolenRole` names the dead holder's role only when the claim had to steal one, so a caller
 * knows whether it just inherited a delete a dead process left unfinished. */
export type ClaimOutcome = { claimed: true; stolenRole?: LockRole } | { claimed: false; holder: DaemonLock };

////////////////////////////////
//  Constants

const TOKEN_BYTES = 24;
const CLAIM_ATTEMPTS = 4;

////////////////////////////////
//  Functions & Helpers

/** The lock parsed if it resolves, or null when absent, unreadable, or not a lock at all. */
export function readLock(lockFile: string): DaemonLock | null {
	let raw: string;
	try {
		raw = readFileSync(lockFile, "utf8");
	} catch {
		return null;
	}
	return parseDaemonLock(raw);
}

export function mintToken(): string {
	return randomBytes(TOKEN_BYTES).toString("hex");
}

/** This process as a holder: its pid, and its birth where the platform says. */
export function holderIdentity(): { pid: number; pidStart?: string } {
	const identity = processIdentity(process.pid);
	if (identity === null) return { pid: process.pid };
	return { pid: process.pid, pidStart: identity.startTicks };
}

/** Linked from a fully-written staging file, since a `wx` write has a create-then-fill gap where a
 * reader sees half a JSON and steals a live daemon's lock. A stale lock is stolen by rename. */
export function claimLock(lockFile: string, lock: DaemonLock, isAlive: HolderAlive): ClaimOutcome {
	const staging = `${lockFile}.${process.pid}.claim`;
	const stage = () => {
		mkdirSync(path.dirname(lockFile), { recursive: true });
		writeFileSync(staging, JSON.stringify(lock, null, 2));
	};
	stage();

	// The last stolen holder's role, carried into a later success.
	let stolenRole: LockRole | undefined;

	try {
		for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
			try {
				linkSync(staging, lockFile);
				return stolenRole === undefined ? { claimed: true } : { claimed: true, stolenRole };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// A delete moved the directory aside, staging file included: nothing here is a resume.
				if (code === "ENOENT") {
					stolenRole = undefined;
					stage();
					continue;
				}
				if (code !== "EEXIST") throw error;
			}

			const holder = readLock(lockFile);
			if (holder !== null && isAlive(holder)) return { claimed: false, holder };
			// Unreadable reads as "daemon": with no role to trust, resuming nothing is the safe default.
			stolenRole = holder?.role ?? "daemon";

			const grave = `${lockFile}.${process.pid}.stale`;
			try {
				renameSync(lockFile, grave);
				rmSync(grave, { force: true });
			} catch {
				// Another contender stole it first; loop and contend on the link.
			}
		}
	} finally {
		rmSync(staging, { force: true });
	}

	// Losing every round means live contention each time; whoever kept winning holds the file now.
	const holder = readLock(lockFile);
	if (holder !== null) return { claimed: false, holder };
	throw new Error(`could not claim ${lockFile} after ${CLAIM_ATTEMPTS} attempts`);
}

/** Only while the file still carries `token`: a successor's claim is never taken out with ours. */
export function releaseLock(lockFile: string, token: string): void {
	if (readLock(lockFile)?.token === token) rmSync(lockFile, { force: true });
}
