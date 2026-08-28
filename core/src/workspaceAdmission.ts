// Whether a directory may be registered as a project at all, and whether one may hold a store.
//
// Not gated on git: plenty of real projects are not repositories. Only roots that are never one
// project are refused. Every entrypoint routes through here.

import { lstatSync, mkdirSync, type Stats } from "node:fs";
import path from "node:path";
import { currentHost, type PlatformEnv } from "@nyaa-lexicon/client";

////////////////////////////////
//  Interfaces & Types

/** Refusal carries the reason, since a caller has to tell the user what to do instead. */
export type Admission = { admitted: true } | { admitted: false; reason: string };

/** Who is asking, injected so a foreign owner is testable without one. */
export interface DirectoryOwner {
	platform: NodeJS.Platform;
	/** Null where the platform has no uid, and ownership is then not judged. */
	uid: number | null;
}

////////////////////////////////
//  Constants

/** Group- or world-writable: anyone else could swap the index or the lock under the daemon. */
const SHARED_WRITE_BITS = 0o022;

////////////////////////////////
//  Functions & Helpers

export function currentOwner(): DirectoryOwner {
	return { platform: process.platform, uid: process.getuid?.() ?? null };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a directory of the caller's choosing may hold a store. Absent, it is created for the
 * owner alone; present, it must already be the owner's alone. Permissions are never widened, and
 * never narrowed either: a directory the caller shares on purpose is refused, not repaired.
 */
export function admitStateDir(dir: string, owner: DirectoryOwner = currentOwner()): Admission {
	if (!path.isAbsolute(dir)) {
		return { admitted: false, reason: `${dir} is not an absolute path; a state directory is given in full` };
	}

	let found: Stats;
	try {
		found = lstatSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { admitted: false, reason: `${dir} cannot be inspected: ${describe(error)}` };
		}
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (creation) {
			return { admitted: false, reason: `${dir} could not be created: ${describe(creation)}` };
		}
		// Judged again after creating: a recursive mkdir reports success over a link somebody placed
		// between the two calls, so what is there now is what is admitted, never what was asked for.
		try {
			found = lstatSync(dir);
		} catch (again) {
			return { admitted: false, reason: `${dir} cannot be inspected: ${describe(again)}` };
		}
	}

	// A link is refused whatever it points at: the store would live where the link says, and the
	// link can be repointed later without touching the store.
	if (found.isSymbolicLink())
		return { admitted: false, reason: `${dir} is a symbolic link; give the directory itself` };
	if (!found.isDirectory()) return { admitted: false, reason: `${dir} is not a directory` };
	// Windows reports no meaningful mode or uid, so neither is judged there.
	if (owner.platform === "win32") return { admitted: true };
	if (owner.uid !== null && found.uid !== owner.uid) {
		return { admitted: false, reason: `${dir} is owned by uid ${found.uid}, not by this user (uid ${owner.uid})` };
	}
	if ((found.mode & SHARED_WRITE_BITS) !== 0) {
		return { admitted: false, reason: `${dir} is writable by its group or by everyone; make it 0700 to use it` };
	}
	return { admitted: true };
}

////////////////////////////////
//  Workspaces

/** Whether this root is a project, or something every project merely lives inside. */
export function admitWorkspace(workspaceRoot: string, host: PlatformEnv = currentHost()): Admission {
	const root = path.resolve(workspaceRoot);

	if (root === path.parse(root).root) {
		return { admitted: false, reason: `${root} is the filesystem root, which is never one project` };
	}

	if (root === path.resolve(host.home)) {
		return {
			admitted: false,
			reason: `${root} is your home directory, which is never one project. Register the project you mean instead.`,
		};
	}

	return { admitted: true };
}
