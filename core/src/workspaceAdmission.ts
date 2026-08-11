// Whether a directory may be registered as a project at all.
//
// Not gated on git: plenty of real projects are not repositories. Only roots that are never one
// project are refused. Every entrypoint routes through here.

import path from "node:path";
import { currentHost, type PlatformEnv } from "./paths.js";

////////////////////////////////
//  Interfaces & Types

/** Refusal carries the reason, since a caller has to tell the user what to do instead. */
export type Admission = { admitted: true } | { admitted: false; reason: string };

////////////////////////////////
//  Functions & Helpers

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
