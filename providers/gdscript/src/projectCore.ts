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
}

type NormalizeModulePath = (raw: string) => string;

//////// Constants

const IGNORED_DIRECTORIES = new Set([".git", ".godot"]);

//////// Functions

function filesUnder(
	root: string,
	directory: string,
	files: string[],
	projectDirectories: string[],
	normalize: NormalizeModulePath,
): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
			filesUnder(root, path.join(directory, entry.name), files, projectDirectories, normalize);
			continue;
		}
		if (!entry.isFile()) continue;
		if (entry.name === "project.godot") {
			const relative = path.relative(root, directory);
			projectDirectories.push(relative === "" ? "" : relative.split(path.sep).join("/"));
		}
		if (!entry.name.endsWith(".gd")) continue;
		const relative = path.relative(root, path.join(directory, entry.name));
		files.push(normalize(relative));
	}
}

export function discoverProjectCore(workspaceRoot: string, normalize: NormalizeModulePath): ProjectModelFact {
	const root = path.resolve(workspaceRoot);
	const files: string[] = [];
	const projectDirectories: string[] = [];
	filesUnder(root, root, files, projectDirectories, normalize);
	files.sort();
	projectDirectories.sort();

	return {
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
