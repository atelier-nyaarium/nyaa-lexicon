import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeModulePath, type ProjectModel } from "@nyaa-lexicon/protocol";
import type { GDScriptProject } from "./module.js";
import { discoverProjectCore } from "./projectCore.js";

//////// Functions

export function discoverProject(workspaceRoot: string): ProjectModel {
	return discoverGDScriptProject(workspaceRoot).model;
}

export function discoverGDScriptProject(workspaceRoot: string): { model: ProjectModel; project: GDScriptProject } {
	const root = path.resolve(workspaceRoot);
	const { projectDirectories, ...discovered } = discoverProjectCore(root, normalizeModulePath);
	const model = discovered as ProjectModel;
	const scopes = projectDirectories.map((directory) => ({
		directory,
		autoloads: autoloadsIn(path.resolve(root, ...directory.split("/").filter(Boolean)), root),
	}));
	const configFiles = projectDirectories.map((scope) => (scope === "" ? "project.godot" : `${scope}/project.godot`));
	configFiles.sort();
	return { model: { ...model, configFiles }, project: { scopes } };
}

function autoloadsIn(projectRoot: string, workspaceRoot: string): Readonly<Record<string, string>> {
	const autoloads: Record<string, string> = {};
	let lines: string[];
	try {
		lines = readFileSync(path.join(projectRoot, "project.godot"), "utf8").split(/\r?\n/u);
	} catch {
		return autoloads;
	}
	let inAutoloads = false;
	for (const line of lines) {
		const trimmed = line.trim();
		const section = /^\[([^\]]+)\]$/u.exec(trimmed);
		if (section !== null) {
			inAutoloads = section[1] === "autoload";
			continue;
		}
		if (!inAutoloads) continue;
		const entry = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"\*?(res:\/\/[^"\\]+)"/u.exec(trimmed);
		if (entry === null) continue;
		const absolute = path.resolve(projectRoot, ...(entry[2] as string).slice("res://".length).split("/"));
		const relative = path.relative(workspaceRoot, absolute);
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
		autoloads[entry[1] as string] = relative.split(path.sep).join("/");
	}
	return autoloads;
}
