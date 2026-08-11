// Whether a directory may be indexed at all, since the root is whatever a session launched in.
//
// Not gated on git: plenty of real projects are not repositories. Only roots that are never one
// project are refused. Every entrypoint routes through here.

import path from "node:path";
import { currentHost, type PlatformEnv } from "./paths.js";

////////////////////////////////
//  Interfaces & Types

/** Refusal carries the reason, since a caller has to tell the user what to do instead. */
export type Admission = { admitted: true } | { admitted: false; reason: string };

export interface AdmissionContext {
	/** `fallback` means nobody named a workspace and the process's own directory was used. */
	chosenBy?: "explicit" | "fallback";
	/** Where lexicon's own code is running from. */
	installedAt?: string;
}

////////////////////////////////
//  Functions & Helpers

/** Whether one path is at or inside another. */
function within(inner: string, outer: string): boolean {
	const relative = path.relative(outer, inner);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Whether this root is a project, or something every project merely lives inside. */
export function admitWorkspace(
	workspaceRoot: string,
	host: PlatformEnv = currentHost(),
	context: AdmissionContext = {},
): Admission {
	const root = path.resolve(workspaceRoot);

	if (root === path.parse(root).root) {
		return { admitted: false, reason: `${root} is the filesystem root, which is never one project` };
	}

	if (root === path.resolve(host.home)) {
		return {
			admitted: false,
			reason: `${root} is your home directory, which is never one project. Start in the directory you mean to ask about.`,
		};
	}

	// Falling back to the process's own directory means indexing the plugin, which answers about the
	// wrong project while looking healthy.
	if (context.chosenBy === "fallback" && context.installedAt !== undefined && within(context.installedAt, root)) {
		return {
			admitted: false,
			reason: `${root} is where lexicon itself is installed, and no workspace was named. Set LEXICON_WORKSPACE to the project you want indexed.`,
		};
	}

	return { admitted: true };
}
