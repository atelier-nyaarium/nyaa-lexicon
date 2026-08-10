import { existsSync, readdirSync } from "node:fs";
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
}

type NormalizeModulePath = (raw: string) => string;

//////// Constants

const IGNORED_DIRECTORIES = new Set([".git", ".godot"]);

//////// Functions

function filesUnder(root: string, directory: string, files: string[], normalize: NormalizeModulePath): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
			filesUnder(root, path.join(directory, entry.name), files, normalize);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".gd")) continue;
		const relative = path.relative(root, path.join(directory, entry.name));
		files.push(normalize(relative));
	}
}

export function discoverProjectCore(workspaceRoot: string, normalize: NormalizeModulePath): ProjectModelFact {
	const root = path.resolve(workspaceRoot);
	const files: string[] = [];
	const hasProjectFile = existsSync(path.join(root, "project.godot"));
	filesUnder(root, root, files, normalize);
	files.sort();

	return {
		files,
		externalRoots: [],
		configFiles: hasProjectFile ? ["project.godot"] : [],
		diagnostics: hasProjectFile
			? []
			: [
					{
						severity: "warning",
						message: "project.godot was not found at the workspace root",
						path: "project.godot",
					},
				],
	};
}
