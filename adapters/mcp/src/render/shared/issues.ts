import { code } from "./markdown.js";
import type { RefactorIssue } from "./types.js";

/** One renderer for issues, used by status and by a refused commit so they cannot drift apart. */
export function renderIssues(issues: RefactorIssue[]): string[] {
	if (issues.length === 0) return [];

	const lines = [
		`## Issues
`,
	];
	for (const issue of issues) {
		const where =
			issue.module === undefined ? "" : ` (${code(`${issue.module}${issue.line ? `:${issue.line}` : ""}`)})`;
		const step = issue.stepNo === undefined ? "" : ` [step ${issue.stepNo}]`;
		lines.push(`- **${issue.kind}:**${step} ${issue.detail}${where}`);
	}
	return lines;
}
