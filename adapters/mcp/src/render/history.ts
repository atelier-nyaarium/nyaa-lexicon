import { code } from "./shared/markdown.js";

/**
 * Co-change partners, each as a proportion rather than a bare count.
 *
 * "8" means nothing on its own: 8 of 9 commits is a partner you must look at, and 8 of 200 is
 * noise. The denominator is what turns the number into a judgement a reader can make.
 */
export function renderCoChange(result: {
	module: string;
	partners: Array<{ module: string; together: number; outOf: number }>;
	total: number;
	commits: number;
	skippedWideCommits: number;
	widthLimit: number;
}): string {
	if (result.partners.length === 0) {
		return `# Co-change\n\nNothing has changed alongside ${code(result.module)} in the last ${result.commits} commits.`;
	}

	const lines = [
		`# Changed alongside ${code(result.module)}

| Module | Together | Share |
| --- | ---: | ---: |`,
	];
	for (const partner of result.partners) {
		const share = Math.round((partner.together / Math.max(partner.outOf, 1)) * 100);
		lines.push(`| ${code(partner.module)} | ${partner.together} / ${partner.outOf} | ${share}% |`);
	}

	if (result.total > result.partners.length)
		lines.push(`
> ${result.total - result.partners.length} more partners not shown.`);
	lines.push(`
Read from ${result.commits} commits.`);
	// Named rather than silent: a sweep touching hundreds of files pairs every one of them with
	// every other, so dropping those is what keeps the signal meaningful, and a reader deserves to
	// know a filter ran at all.
	if (result.skippedWideCommits > 0) {
		lines.push(`
> ${result.skippedWideCommits} commits touching over ${result.widthLimit} files were ignored as sweeps.
`);
	}
	return lines.join("\n");
}

/** Churn and age for one file. Age is omitted when the window ran out rather than shown as a floor. */
export function renderFileHistory(result: {
	module: string;
	commits: number;
	linesAdded: number;
	linesDeleted: number;
	recent: Array<{ hash: string; at: number; added: number; deleted: number; subject: string }>;
	firstSeen: number | null;
	lastTouched: number | null;
	truncated: boolean;
}): string {
	if (result.commits === 0) return `# ${code(result.module)}\n\nNo commits in the history window.`;

	const ago = (at: number) => {
		const days = Math.round((Date.now() / 1000 - at) / 86_400);
		if (days === 0) return `today`;
		return `${days} day${days === 1 ? "" : "s"} ago`;
	};

	const commits = `${result.commits} commit${result.commits === 1 ? "" : "s"}`;
	const lines = [
		`# ${code(result.module)}

## History

- Commits: ${commits}
- Lines: +${result.linesAdded} / -${result.linesDeleted}`,
	];
	if (result.lastTouched !== null) lines.push(`- Last touched: ${ago(result.lastTouched)}`);
	if (result.firstSeen !== null) {
		lines.push(
			result.truncated
				? `- First seen: ${ago(result.firstSeen)} (as far back as this read went)`
				: `- First seen: ${ago(result.firstSeen)}`,
		);
	}
	if (result.recent.length > 0) {
		lines.push(`
## Recent commits

| When | Commit | Lines | Subject |
| --- | --- | ---: | --- |`);
		for (const commit of result.recent) {
			const subject = commit.subject.replaceAll("|", "\\|");
			lines.push(
				`| ${ago(commit.at)} | ${code(commit.hash.slice(0, 7))} | +${commit.added} / -${commit.deleted} | ${subject} |`,
			);
		}
		if (result.commits > result.recent.length) {
			lines.push(`
> ${result.commits - result.recent.length} older commits not shown.`);
		}
	}
	return lines.join("\n");
}

/**
 * Commits naming a symbol.
 *
 * The file count rides on every row because a mention inside a 90-file sweep and one inside a
 * two-file commit are different evidence, and the subject alone does not say which it is.
 */
export function renderMentions(result: {
	name: string;
	mentions: Array<{ hash: string; at: number; subject: string; files: number }>;
	commits: number;
}): string {
	if (result.mentions.length === 0) {
		return `# Symbol history\n\nNo commit message in the last ${result.commits} commits names ${code(result.name)}.`;
	}

	const lines = [
		`# Commits naming ${code(result.name)}

## Matches

| Commit | When | Files | Subject |
| --- | --- | ---: | --- |`,
	];
	for (const mention of result.mentions) {
		const days = Math.round((Date.now() / 1000 - mention.at) / 86_400);
		const when = days === 0 ? "today" : `${days}d ago`;
		const files = `${mention.files} file${mention.files === 1 ? "" : "s"}`;
		lines.push(`| ${code(mention.hash.slice(0, 7))} | ${when} | ${files} | ${mention.subject} |`);
	}
	lines.push(`
Read from ${result.commits} commits.`);
	return lines.join("\n");
}
