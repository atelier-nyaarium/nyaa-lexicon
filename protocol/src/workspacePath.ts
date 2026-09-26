// Normalize workspace modules and file paths, and the one containment check for reads and writes.

import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { normalizeModulePath } from "./symbolId.js";

////////////////////////////////
//  Interfaces & Types

/** Where a module sits once links are resolved. */
export type Contained = { kind: "file" | "absent"; path: string } | { kind: "outside" };

/**
 * How the module's own leaf is judged. `follow` for a read, which opens what its links reach.
 * `keep` for a no-follow read or a rename, which never pass through a leaf link.
 */
export type LeafMode = "follow" | "keep";

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

/**
 * A module's path when its real path stays under the real root, judged by the file itself when it
 * exists and by its nearest existing ancestor otherwise.
 *
 * `path` is what to open: the real file when a leaf is followed, the name itself when it is kept.
 */
export function resolveContained(root: string, module: string, leaf: LeafMode = "follow"): Contained {
	const file = workspaceFile(root, module);
	if (file === null) return { kind: "outside" };
	const realRoot = realOrNull(root);
	// A gone root holds nothing.
	if (realRoot === null) return { kind: "absent", path: file };
	if (leaf === "follow") {
		const real = realOrNull(file);
		if (real !== null) return under(realRoot, real) ? { kind: "file", path: real } : { kind: "outside" };
	}
	const parent = realpathSync(nearestExisting(path.dirname(file)));
	if (!under(realRoot, parent)) return { kind: "outside" };
	return { kind: leaf === "keep" && occupied(file) ? "file" : "absent", path: file };
}

function under(realRoot: string, real: string): boolean {
	return real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
}

function gone(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** Null for a path that is gone, a dangling link, or a link loop. */
function realOrNull(target: string): string | null {
	try {
		return realpathSync(target);
	} catch (error) {
		if (gone(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return null;
		throw error;
	}
}

/** Anything at the name, a dangling link included. */
function occupied(target: string): boolean {
	try {
		lstatSync(target);
		return true;
	} catch (error) {
		if (gone(error)) return false;
		throw error;
	}
}

/** The closest ancestor on disk, so a file in a directory not yet created is judged by its future parent. */
function nearestExisting(dir: string): string {
	let current = dir;
	while (!existsSync(current)) {
		const up = path.dirname(current);
		if (up === current) return current;
		current = up;
	}
	return current;
}
