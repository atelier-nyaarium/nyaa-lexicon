import { normalizeModulePath, type ProjectModel } from "@nyaa-lexicon/protocol";
import { discoverProjectCore } from "./projectCore.js";

//////// Functions

export function discoverProject(workspaceRoot: string): ProjectModel {
	return discoverProjectCore(workspaceRoot, normalizeModulePath) as ProjectModel;
}
