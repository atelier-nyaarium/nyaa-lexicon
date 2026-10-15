import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ExcludedDirectories } from "./excludedDirectories.js";
import { excludesDirectory } from "./excludedDirectories.js";
import type { ReadPolicy } from "./readPolicy.js";
import { workspaceFile, workspaceModule } from "./workspacePath.js";

export type IncludeKind = "quoted" | "angle";

export interface IncludeSearchList {
	includerDirectory: boolean;
	quote: readonly string[];
	user: readonly string[];
	system: readonly string[];
	after: readonly string[];
}

export type FoundInclude = { module: string } | { outside: true };

export function discoverCompileDatabases(root: string): string[] {
	const builds = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("build"))
		.map((entry) => entry.name)
		.sort();
	return [
		path.join(root, "compile_commands.json"),
		...builds.map((build) => path.join(root, build, "compile_commands.json")),
	].filter((file) => existsSync(file) && statSync(file).isFile());
}

export function discoverIncludeDirectories(root: string, excluded: ExcludedDirectories, policy: ReadPolicy): string[] {
	const found: string[] = [];
	const pending = [root];
	for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		const names = entries.map((entry) => entry.name);
		for (const entry of entries) {
			if (!entry.isDirectory() || excludesDirectory(excluded, entry.name, directory === root, () => names))
				continue;
			const child = path.join(directory, entry.name);
			if (!policy.readable(child)) continue;
			if (entry.name === "include") found.push(child);
			pending.push(child);
		}
	}
	return found.sort();
}

export function includeSearchDirectories(
	root: string,
	fallback: readonly string[],
	search: IncludeSearchList | undefined,
	includer: string,
	kind: IncludeKind,
): string[] {
	const directory = path.dirname(path.join(root, includer));
	if (search === undefined) return kind === "quoted" ? [directory, ...fallback] : [...fallback];
	const listed = [...(kind === "quoted" ? search.quote : []), ...search.user, ...search.system, ...search.after];
	return kind === "quoted" && search.includerDirectory ? [directory, ...listed] : listed;
}

export function forcedIncludeDirectories(directory: string, search: IncludeSearchList | undefined): string[] {
	return search === undefined
		? [directory]
		: [directory, ...search.quote, ...search.user, ...search.system, ...search.after];
}

export function findWorkspaceInclude(
	root: string,
	policy: ReadPolicy,
	directories: readonly string[],
	name: string,
): FoundInclude | undefined {
	for (const directory of directories) {
		const candidate = path.resolve(directory, name);
		if (!policy.readable(candidate)) continue;
		const module = workspaceModule(root, candidate);
		const absolute = module === null ? candidate : workspaceFile(root, module);
		if (absolute === null || !existsSync(absolute) || !statSync(absolute).isFile()) continue;
		return module === null ? { outside: true } : { module };
	}
	return undefined;
}
