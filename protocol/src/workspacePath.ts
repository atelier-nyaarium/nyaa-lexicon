// Normalize workspace modules and file paths.

import path from "node:path";
import { normalizeModulePath } from "./symbolId.js";

////////////////////////////////
//  Functions & Helpers

/** Map in-root files to module ids; reject the rest. */
export function workspaceModule(root: string, absolute: string): string | null {
	const relative = path.relative(root, absolute).split(path.sep).join("/");
	if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) return null;
	try {
		return normalizeModulePath(relative);
	} catch {
		return null;
	}
}

/** Resolve normalized module paths under root. */
export function workspaceFile(root: string, module: string): string | null {
	let canonical: string;
	try {
		canonical = normalizeModulePath(module);
	} catch {
		return null;
	}
	const absolute = path.resolve(root, ...canonical.split("/"));
	const relative = path.relative(root, absolute);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return absolute;
}
