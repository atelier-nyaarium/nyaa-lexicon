import type ts from "typescript";
import type { TypeScriptAnalyzer } from "../analyzer.js";
import type { TypeScriptProject } from "../module.js";
import type { JudgeHost } from "./session.js";

export interface PreparedLoadCycleContext {
	readonly analyzer: TypeScriptAnalyzer;
	readonly programs: ReadonlyMap<string, ts.Program>;
	readonly host: JudgeHost;
	readonly settings: Array<{ project: string; fingerprint: string }>;
	readonly fingerprint: string;
	readonly expires: number;
}

const RETAIN_MS = 60_000;
const RETAINED = 8;

export function retainPreview(
	project: TypeScriptProject,
	token: string,
	context: Omit<PreparedLoadCycleContext, "expires">,
	now: number,
): void {
	expirePreviews(project, now);
	releasePreview(project, token);
	project.previews.set(token, { ...context, expires: now + RETAIN_MS });
	while (project.previews.size > RETAINED) {
		const oldest = project.previews.keys().next().value;
		if (oldest === undefined) break;
		releasePreview(project, oldest);
	}
}

export function preparedPreview(
	project: TypeScriptProject,
	token: string,
	now: number,
): PreparedLoadCycleContext | undefined {
	expirePreviews(project, now);
	return project.previews.get(token);
}

export function releasePreview(project: TypeScriptProject | undefined, token: string): void {
	const context = project?.previews.get(token);
	if (context === undefined) return;
	context.analyzer.dispose();
	project?.previews.delete(token);
	if (project !== undefined)
		for (const [partial, session] of project.judgments)
			if (session.preview === token) project.judgments.delete(partial);
}

export function expirePreviews(project: TypeScriptProject, now: number): void {
	for (const [token, { expires }] of project.previews) {
		if (expires > now) continue;
		releasePreview(project, token);
	}
}
