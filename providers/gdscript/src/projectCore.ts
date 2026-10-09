import { readdirSync } from "node:fs";
import path from "node:path";

//////// Types

interface Diagnostic {
	severity: "error" | "warning" | "info";
	message: string;
	path?: string;
}

export interface ProjectModelFact {
	files: string[];
	externalRoots: string[];
	configFiles: string[];
	diagnostics: Diagnostic[];
	projectDirectories: string[];
	/** Scenes and `.uid` sidecars, which a `uid://` path may name. */
	resources: string[];
}

interface Found {
	files: string[];
	projectDirectories: string[];
	resources: string[];
}

type NormalizeModulePath = (raw: string) => string;

//////// Constants

export const EXCLUDED_DIRECTORIES = new Set([".git", ".godot"]);

//////// Functions

function underExcludedDirectory(module: string): boolean {
	return module
		.split("/")
		.slice(0, -1)
		.some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

function filesUnder(root: string, directory: string, found: Found, normalize: NormalizeModulePath): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
			filesUnder(root, path.join(directory, entry.name), found, normalize);
			continue;
		}
		if (!entry.isFile()) continue;
		if (entry.name === "project.godot") {
			const relative = path.relative(root, directory);
			found.projectDirectories.push(relative === "" ? "" : relative.split(path.sep).join("/"));
		}
		const relative = path.relative(root, path.join(directory, entry.name));
		if (entry.name.endsWith(".gd")) found.files.push(normalize(relative));
		else if (entry.name.endsWith(".uid") || entry.name.endsWith(".tscn"))
			found.resources.push(relative.split(path.sep).join("/"));
	}
}

export function discoverProjectCore(
	workspaceRoot: string,
	normalize: NormalizeModulePath,
	scope?: readonly string[],
): ProjectModelFact {
	const root = path.resolve(workspaceRoot);
	const found: Found = { files: [], projectDirectories: [], resources: [] };
	if (scope === undefined) filesUnder(root, root, found, normalize);
	else {
		for (const module of scope) {
			const absolute = path.resolve(root, module);
			if (!absolute.startsWith(`${root}${path.sep}`)) continue;
			// Skipped as the walk skips it, tracked or not.
			if (underExcludedDirectory(module)) continue;
			if (path.basename(module) === "project.godot") {
				const directory = path.posix.dirname(module);
				found.projectDirectories.push(directory === "." ? "" : directory);
			}
			if (module.endsWith(".gd")) found.files.push(normalize(module));
			else if (module.endsWith(".uid") || module.endsWith(".tscn")) found.resources.push(module);
		}
	}
	const { files, projectDirectories, resources } = found;
	files.sort();
	projectDirectories.sort();
	resources.sort();

	return {
		resources,
		files,
		externalRoots: [],
		configFiles: projectDirectories.includes("") ? ["project.godot"] : [],
		diagnostics: projectDirectories.includes("")
			? []
			: [
					{
						severity: "warning",
						message: "project.godot was not found at the workspace root",
						path: "project.godot",
					},
				],
		projectDirectories,
	};
}
