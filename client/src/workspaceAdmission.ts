import path from "node:path";
import type { PlatformEnv } from "./paths.js";

export type WorkspaceAdmission = { admitted: true } | { admitted: false; reason: string };

export function classifyWorkspaceRoot(workspaceRoot: string, host: Pick<PlatformEnv, "home">): WorkspaceAdmission {
	const root = path.resolve(workspaceRoot);
	if (root === path.parse(root).root)
		return { admitted: false, reason: `${root} is the filesystem root, which is never one project` };
	if (root === path.resolve(host.home))
		return {
			admitted: false,
			reason: `${root} is your home directory, which is never one project. Register the project you mean instead.`,
		};
	return { admitted: true };
}
