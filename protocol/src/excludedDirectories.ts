// The directories a provider never indexes beneath, read alike by its walk and by core.

import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

////////////////////////////////
//  Schemas

/** Directory or file names. One `*` in a name stands for any run of characters. */
const NamesSchema = z.array(z.string().min(1));

export const ExcludedDirectoriesSchema = z.object({
	/** Names no source lives beneath, at any depth, such as `.git` or `__pycache__`. */
	anywhere: NamesSchema.readonly().optional(),
	/**
	 * Output names, skipped directly under the workspace root or directly beside one of the
	 * group's `markers`. Elsewhere a directory so named is source, such as a package called `build`.
	 */
	beside: z
		.array(z.object({ names: NamesSchema.min(1).readonly(), markers: NamesSchema.readonly().optional() }))
		.readonly()
		.optional(),
});

export type ExcludedDirectories = z.output<typeof ExcludedDirectoriesSchema>;

////////////////////////////////
//  Functions & Helpers

/** Whether `name` matches `pattern`, whose one `*` stands for any run of characters. */
export function nameMatches(pattern: string, name: string): boolean {
	const star = pattern.indexOf("*");
	if (star === -1) return pattern === name;
	const head = pattern.slice(0, star);
	const tail = pattern.slice(star + 1);
	return name.length >= head.length + tail.length && name.startsWith(head) && name.endsWith(tail);
}

/**
 * Whether a directory named `name` is never entered. `atRoot` when it sits directly under the
 * workspace root. `siblings` names what sits beside it, read only for an output name below the root.
 */
export function excludesDirectory(
	excluded: ExcludedDirectories,
	name: string,
	atRoot: boolean,
	siblings: () => readonly string[],
): boolean {
	if (excluded.anywhere?.some((pattern) => nameMatches(pattern, name)) === true) return true;
	for (const group of excluded.beside ?? []) {
		if (!group.names.some((pattern) => nameMatches(pattern, name))) continue;
		if (atRoot) return true;
		const markers = group.markers ?? [];
		if (markers.length > 0 && siblings().some((sibling) => markers.some((marker) => nameMatches(marker, sibling))))
			return true;
	}
	return false;
}

/** What each directory under `root` holds, each listed once. Unreadable lists as empty. */
export function directoryEntries(root: string): (directory: string) => readonly string[] {
	const listed = new Map<string, readonly string[]>();
	return (directory) => {
		let names = listed.get(directory);
		if (names === undefined) {
			try {
				names = readdirSync(path.join(root, directory), { encoding: "utf8" });
			} catch {
				names = [];
			}
			listed.set(directory, names);
		}
		return names;
	};
}

/**
 * Whether a workspace module lies beneath a directory `excluded` never enters. `entries` names what
 * a workspace directory holds, `""` being the root.
 */
export function underExcludedDirectory(
	module: string,
	excluded: ExcludedDirectories,
	entries: (directory: string) => readonly string[],
): boolean {
	const segments = module.split("/");
	for (let at = 0; at < segments.length - 1; at++) {
		const parent = segments.slice(0, at).join("/");
		if (excludesDirectory(excluded, segments[at] as string, at === 0, () => entries(parent))) return true;
	}
	return false;
}
