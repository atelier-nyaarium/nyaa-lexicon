// Owns a script's file role: whether the engine runs it on its own.

import type { FileRole } from "@nyaa-lexicon/protocol";
import type { GDScriptProject, GDScriptValue } from "./module.js";

//////// Constants

/** Bases a script run with `godot -s` extends. */
const COMMAND_LINE_BASES = new Set(["SceneTree", "MainLoop"]);

//////// Functions

/** The main scene's root, an autoload, or a `godot -s` script. */
export function scriptRole(module: string, value: GDScriptValue, project: GDScriptProject): FileRole {
	const script = value.declarations.find(
		(declaration) => declaration.kind === "class" && declaration.containerId === undefined,
	);
	if (script === undefined || !module.endsWith(".gd")) return { kind: "library" };
	const started = project.scopes.some((scope) => scope.entries.includes(module));
	const commandLine = value.base !== undefined && COMMAND_LINE_BASES.has(value.base);
	return started || commandLine ? { kind: "entry", how: "main", symbolId: script.symbolId } : { kind: "library" };
}
