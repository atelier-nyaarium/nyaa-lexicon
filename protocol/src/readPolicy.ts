// What a provider may read of the workspace: nothing the index's scope denies.

import { realpathSync } from "node:fs";
import path from "node:path";
import { globToRegExp } from "./moduleExclusion.js";
import { workspaceModule } from "./workspacePath.js";

////////////////////////////////
//  Interfaces & Types

/** The deny globs `initialize` carries, as a provider applies them to its own reads. */
export interface ReadPolicy {
	/** Whether a workspace module may be read. */
	admits(module: string): boolean;
	/**
	 * Whether a file by path may be read: outside the workspace always, since no workspace glob names
	 * it; inside only when neither its name nor, through a link, its real path is denied.
	 */
	readable(fileName: string): boolean;
}

////////////////////////////////
//  Functions & Helpers

export function readPolicy(root: string, deny: readonly string[] = []): ReadPolicy {
	const denied = deny.map((glob) => globToRegExp(glob));
	const admits = (module: string): boolean => !denied.some((matcher) => matcher.test(module));
	const resolvedRoot = path.resolve(root);
	let realRoot: string | null | undefined;
	const deniedAt = (fileName: string, base: string): boolean => {
		const module = workspaceModule(base, fileName);
		return module !== null && !admits(module);
	};
	return {
		admits,
		readable(fileName) {
			if (denied.length === 0) return true;
			const absolute = path.resolve(resolvedRoot, fileName);
			if (deniedAt(absolute, resolvedRoot)) return false;
			let real: string;
			try {
				real = realpathSync(absolute);
				realRoot ??= realpathSync(resolvedRoot);
			} catch {
				// A missing file has nothing to read.
				return true;
			}
			return !deniedAt(real, realRoot);
		},
	};
}

/** Admits everything: a provider started with no scope to honour. */
export const OPEN_READ_POLICY: ReadPolicy = { admits: () => true, readable: () => true };
