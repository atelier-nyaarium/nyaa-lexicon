// Turning answers into what an agent reads.
//
// Pure, because output formatting deserves direct tests.

import type {
	CommentsResult,
	ContentCounts,
	ContentTotals,
	Count,
	DescribeResult,
	DocsResult,
	FileNotes,
	LiteralsResult,
	MovePlan,
	RefactorIssue,
	ReferencesResult,
	RenamePlan,
	SymbolSource,
	SymbolSummary,
	TransactionStatus,
} from "@nyaa-lexicon/core";
import type {
	EntryHow,
	FileRole,
	InsertOutcome,
	KnowledgeSweep,
	MoveOutcome,
	Note,
	NoteAuthor,
	NoteBacklinks,
	NoteOutcome,
	RefactorCommitResult,
	RefactorStartResult,
	RenameStepOutcome,
	ReplaceOutcome,
	RouteState,
	TypeInfo,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Functions & Helpers

/**
 * A COMPLETE Markdown code span, delimiters included, so no caller writes its own.
 *
 * CommonMark gives a backslash no meaning inside a code span and closes the span on the first
 * backtick run matching the opening one, so the fence has to come from the content. A caller that
 * wrapped this in backticks of its own would reopen exactly that.
 */
export function code(value: string): string {
	// CommonMark has no empty code span, and a line ending inside one becomes a space.
	if (value === "") return "";
	const flat = value.replace(/\r\n|\r|\n/g, " ");
	const longest = [...flat.matchAll(/`+/g)].reduce((run, match) => Math.max(run, match[0].length), 0);
	// One space is stripped from each end only when both ends carry one and the content is not all spaces.
	const padded =
		!/^ +$/.test(flat) &&
		(flat.startsWith("`") || flat.endsWith("`") || (flat.startsWith(" ") && flat.endsWith(" ")));
	const fence = "`".repeat(longest + 1);
	const pad = padded ? " " : "";
	return `${fence}${pad}${flat}${pad}${fence}`;
}

function line(summary: SymbolSummary): string {
	// Three states, not two. A language with no notion of module export renders its visibility
	// without implying the answer was no.
	const exported = summary.exported === true ? "" : ` (${summary.visibility})`;
	const signature = summary.signature === undefined ? "" : `: ${code(summary.signature)}`;
	return `**${summary.kind}** ${code(summary.name)}${exported}${signature}`;
}

function symbolBullet(summary: SymbolSummary): string {
	return `- ${line(summary)}`;
}

/**
 * Describe is a summary, and documentation is normalized to one line, so the cut is by sentence.
 *
 * Every cut is MARKED. A section of six bulleted rules summarized to its first sentence, with nothing
 * saying so, reads as the whole section rather than as a preview of it.
 */
function summarize(text: string, limit = 200): string {
	const full = text.trimEnd();
	const sentence = full.indexOf(". ");
	if (sentence > 0 && sentence < limit) return marked(full.slice(0, sentence + 1), full);
	if (full.length <= limit) return full;
	const boundary = full.lastIndexOf(" ", limit);
	return marked(full.slice(0, boundary > 0 ? boundary : limit).trimEnd(), full);
}

/** The ellipsis only where something was actually dropped. */
function marked(cut: string, full: string): string {
	return cut.length < full.length ? `${cut} ...` : cut;
}

function renderGroupedModules(title: string, groups: Iterable<readonly [string, readonly string[]]>): string {
	const sections = [`# ${title}`];
	for (const [module, rows] of groups) sections.push(`## ${code(module)}\n\n${rows.join("\n")}`);
	return sections.join("\n\n");
}

function appendHierarchy(lines: string[], result: DescribeResult["hierarchy"]): void {
	lines.push(`
## Type hierarchy
`);
	const hasRelationships =
		result.supertypes.length > 0 ||
		result.subtypes.length > 0 ||
		result.ancestors.length > 0 ||
		result.unboundSupertypes.length > 0;
	if (!hasRelationships) {
		lines.push(`No supertypes or subtypes in the index.`);
		return;
	}

	const list = (label: string, entries: SymbolSummary[]) => {
		if (entries.length === 0) return;
		lines.push(`### ${label}
`);
		for (const entry of entries) lines.push(`- ${line(entry)}  ${code(entry.module)}`);
	};
	list(`Extends`, result.supertypes);
	list(`Extended by`, result.subtypes);

	const indirect = result.ancestors.filter(
		(ancestor) => !result.supertypes.some((direct) => direct.symbolId === ancestor.symbolId),
	);
	if (indirect.length > 0) {
		lines.push(`
### Further up

- ${indirect.map((ancestor) => code(ancestor.name)).join(" <- ")}`);
	}
	if (result.unboundSupertypes.length > 0) {
		lines.push(`### Outside the index
`);
		for (const name of result.unboundSupertypes) lines.push(`- ${code(name)}`);
	}
}

function appendDependencies(lines: string[], summary: DescribeResult["graph"]): void {
	const via = summary.viaMembers === undefined ? "" : ` across the symbol and its ${summary.viaMembers} members`;
	lines.push(`
## Dependencies

- Uses: ${summary.fanOut} distinct symbol${summary.fanOut === 1 ? "" : "s"}${via}`);
	if (summary.cycle) {
		lines.push(`
### Cycle
`);
		for (const member of summary.cycle.slice(0, 10)) lines.push(`- ${code(member)}`);
		if (summary.cycle.length > 10)
			lines.push(`
> ${summary.cycle.length - 10} more cycle members not shown.`);
	}
	lines.push(`
> Counts use resolved indexed bindings.`);
}

/** Where a hazard's read or call sits, as a 1-based line an agent can open. */
function siteOf(site: { module: string; range: { start: { line: number } }; name: string }): string {
	return `${code(`${site.module}:${site.range.start.line + 1}`)} ${code(site.name)}`;
}

function appendLoadCycle(lines: string[], loadCycle: NonNullable<DescribeResult["loadCycle"]>): void {
	lines.push(`
## Load cycle

Modules: ${loadCycle.modules.map(code).join(", ")}`);
	if (loadCycle.verdict === "pending") {
		lines.push(`
> The cycle's load-order judgment is still running. Describe this symbol again for its answer.`);
		return;
	}
	lines.push("");
	for (const hazard of loadCycle.hazards) {
		lines.push(
			`- Loading ${code(hazard.entry)} first (${hazard.order.map(code).join(" -> ")}), ${siteOf(hazard.reader)} reads ${code(hazard.target.name)} (${hazard.target.kind}) in ${code(hazard.target.module)} before it is initialized.`,
		);
		if (hazard.calls.length > 0) lines.push(`  - Through ${hazard.calls.map(siteOf).join(" -> ")}`);
	}
}

const ENTRY_HOW: Record<EntryHow, string> = {
	main: "the runtime calls its main",
	guardedMain: "runs under a run-as-program guard",
	topLevel: "runs statements on load",
};

function roleText(role: FileRole): string {
	if (role.kind === "library") return "library (no recognized entry pattern)";
	if (role.kind === "unknown") return `unknown (${role.reason})`;
	return `entry point: ${ENTRY_HOW[role.how]}${role.how === "main" ? `, ${code(role.symbolId)}` : ""}`;
}

/** One symbol as its complete surface. */
export function renderDescribe(result: DescribeResult): string {
	// The line span makes "read the body" a range read of exactly those lines, never a file read.
	const location =
		result.symbol.lines === undefined
			? code(result.symbol.module)
			: code(`${result.symbol.module}:${result.symbol.lines.start + 1}-${result.symbol.lines.end + 1}`);
	// A signature block for a heading would be a code fence around a section title, which reads as
	// code that does not exist.
	const signature =
		result.symbol.kind === "heading"
			? []
			: ["```ts", result.symbol.signature ?? `${result.symbol.kind} ${result.symbol.name}`, "```", ""];
	const lines = [
		`# ${result.symbol.kind} ${result.symbol.name}`,
		"",
		...signature,
		`**Module:** ${location}`,
		`**ID:** ${code(result.symbol.symbolId)}`,
	];
	if (result.moduleRole !== undefined) lines.push(`**File role:** ${roleText(result.moduleRole)}`);

	if (result.prose !== undefined && result.prose.length > 0) {
		lines.push(`
## Prose
`);
		for (const region of result.prose) {
			const where = region.fenced ? ` (in a code block)` : "";
			lines.push(`- Line ${region.line + 1}${where}: ${summarize(region.text)}`);
		}
		if (result.moreProse !== undefined) {
			lines.push(`
> ${result.moreProse} more not shown. Call \`search_docs\` with this module.`);
		}
	}

	if (result.symbol.docComment) {
		lines.push(`
## Documentation

${summarize(result.symbol.docComment)}`);
	}

	if (result.members.length > 0) {
		lines.push(`
## Members
`);
		for (const member of result.members) lines.push(symbolBullet(member));
	}

	// What someone wrote about it that is not its documentation, which is otherwise only reachable
	// by opening the file.
	if (result.comments !== undefined && result.comments.length > 0) {
		lines.push(`
## Comments
`);
		for (const comment of result.comments) {
			lines.push(`- Line ${comment.line + 1} (${comment.form}): ${summarize(comment.text)}`);
		}
		if (result.moreComments !== undefined) {
			lines.push(`
> ${result.moreComments} more not shown. Call \`find_comments\` with this module.`);
		}
	}

	// Nothing calls, extends or depends on a section, so zero here would read as a checked fact
	// rather than a question that does not apply.
	if (result.symbol.kind === "heading") {
		lines.push(`
## Usage

A section is document structure, so nothing calls, extends or uses it.`);
		return lines.join("\n");
	}

	lines.push(`
## Usage

Used in ${result.referenceCount} place${result.referenceCount === 1 ? "" : "s"}.`);
	if (result.referenceCount > 0) lines.push(`Call \`find_references\` for the list.`);
	appendHierarchy(lines, result.hierarchy);
	appendDependencies(lines, result.graph);
	if (result.loadCycle !== undefined) appendLoadCycle(lines, result.loadCycle);
	return lines.join("\n");
}

/** Uses of a symbol, grouped by file so the shape of the usage is visible at a glance. */
export function renderReferences(result: ReferencesResult): string {
	if (result.total === 0) return `# References\n\nNo references found.`;

	const byModule = new Map<string, string[]>();
	for (const reference of result.references) {
		const rows = byModule.get(reference.module) ?? [];
		rows.push(`- Line ${reference.startLine + 1}: ${reference.role}`);
		byModule.set(reference.module, rows);
	}

	const body = renderGroupedModules(`${result.total} reference${result.total === 1 ? "" : "s"}`, byModule);
	return result.truncated
		? `${body}\n\n> ${result.total - result.references.length} more reference${result.total - result.references.length === 1 ? "" : "s"} not shown. Raise \`limit\`.`
		: body;
}

/**
 * A type, with how it was arrived at.
 *
 * The three statuses are rendered as three different sentences rather than one with a footnote,
 * because "the checker says number" and "nobody has implemented this" are not the same answer and
 * a caller that cannot tell them apart will treat the second as the first.
 */
export function renderType(name: string, type: TypeInfo): string {
	const lines: string[] = [
		`# ${code(name)}

## Type
`,
	];
	if (type.status === "known") {
		const from = type.provenance === "declared" ? `declared in source` : `established by ${type.provenance}`;
		lines.push(`\`\`\`ts
${type.display}
\`\`\`

## Provenance

- Known: ${from}`);
		return lines.join("\n");
	}
	if (type.status === "inferred") {
		lines.push(`\`\`\`ts
${type.display}
\`\`\`

## Provenance

- Inferred from: ${type.basis}`);
		return lines.join("\n");
	}
	lines.push(`Unknown: ${type.reason}${type.detail ? `: ${type.detail}` : ""}`);
	return lines.join("\n");
}

/** What a rename would touch, and what the index cannot promise about it. */
export function renderRenamePlan(plan: RenamePlan): string {
	if (plan.blockers.length > 0) {
		const lines = [
			`# Rename blocked

Cannot rename ${code(plan.oldName || plan.symbolId)}.

## Blockers
`,
		];
		for (const blocker of plan.blockers) {
			lines.push(`- **${blocker.kind}:** ${blocker.detail}`);
			for (const site of blocker.sites ?? []) lines.push(`  - ${code(`${site.module}:${site.line}`)}`);
		}
		return lines.join("\n");
	}

	// Owner calls are counted in the headline and shown per file, because a plan that says "2
	// occurrences" and then rewrites four places is a plan a reader stops trusting. They are not
	// occurrences of the name, so they are named separately rather than folded into the same number.
	const calls = plan.files.reduce((total, file) => total + (file.ownerCalls?.length ?? 0), 0);
	const touches = `${plan.occurrences} occurrence${plan.occurrences === 1 ? "" : "s"}`;
	const withCalls = calls === 0 ? touches : `${touches} and ${calls} call${calls === 1 ? "" : "s"} that name it`;

	const lines = [
		`# Rename ${plan.oldName} to ${plan.newName}

Touches ${withCalls} in ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}.

## Files
`,
	];
	for (const file of plan.files) {
		const here = file.ownerCalls?.length ?? 0;
		const kept = file.sites.filter((site) => site.keep === true).length;
		lines.push(
			`- ${code(file.module)}: ${file.sites.length} occurrence${file.sites.length === 1 ? "" : "s"}${kept === 0 ? "" : `, ${kept} kept`}${here === 0 ? "" : ` plus ${here} call${here === 1 ? "" : "s"}`}`,
		);
	}

	const exports = plan.routes.edges.filter((edge) => edge.fact === "export" && edge.form !== "direct");
	if (exports.length > 0) {
		lines.push(`
## Routes
`);
	}
	for (const edge of exports) {
		if (edge.fact !== "export") continue;
		const stop = edge.stoppable === true ? `, stop ${code(edge.id)}` : "";
		lines.push(`- ${code(edge.from)}: ${edge.form} export, ${ROUTE_STATES[edge.state]}${stop}`);
	}

	const { comments, strings, incomplete } = plan.mentions;
	if (comments + strings > 0 || incomplete === true) {
		const unread = incomplete === true ? " Some files have no comment or string facts." : "";
		lines.push(
			`
${code(plan.oldName)} also appears in ${comments} comment${comments === 1 ? "" : "s"} and ${strings} string${strings === 1 ? "" : "s"}, which a rename never edits.${unread}`,
		);
	}

	// Never omitted when empty in a way a reader could mistake for silence: the absence of this
	// section is itself the claim that the index saw everything.
	if (plan.warnings.length === 0) {
		lines.push(`
Every occurrence is a bound edge.`);
		return lines.join("\n");
	}

	lines.push(`
## Warnings

This set may not be complete.
`);
	for (const warning of plan.warnings) {
		lines.push(`- **${warning.kind}:** ${warning.detail}`);
		for (const site of warning.sites ?? []) lines.push(`  - ${code(`${site.module}:${site.line}`)}`);
	}
	return lines.join("\n");
}

/** What a rename does at one route edge, as a preview says it. */
const ROUTE_STATES: Record<RouteState, string> = {
	renamed: "renamed",
	fixed: "name fixed by an alias",
	stopped: "kept by its stop",
	unknown: "not proved",
};

/** What a move would touch. */
export function renderMovePlan(plan: MovePlan): string {
	if (!plan.ok) return `# Move refused\n\n${plan.reason}`;

	// What the closure uses from inside itself moves with it and needs no import.
	const needed = plan.dependencies.filter((dependency) => dependency.origin.kind !== "insideClosure");
	const moved = plan.removal.end.line - plan.removal.start.line + 1;
	const lines = [
		`# Move ${plan.name} from ${code(plan.fromModule)} to ${code(plan.toModule)}

## Files

- ${code(plan.fromModule)}: lines ${plan.removal.start.line + 1} to ${plan.removal.end.line + 1} removed${plan.usedAtSource ? ", and an import back added, since something here still uses it" : ""}
- ${code(plan.toModule)}: ${moved} line${moved === 1 ? "" : "s"} inserted${plan.exportsAtTarget ? " and exported" : ""}${needed.length === 0 ? "" : ", plus the imports below"}`,
	];
	for (const module of plan.referencing) lines.push(`- ${code(module)}: import specifier re-pointed`);
	if (plan.closure.length > 1) {
		lines.push(`
Moves ${plan.closure.length} symbols: the declaration and what it contains.`);
	}

	if (needed.length === 0) {
		lines.push(`
The moved text depends on nothing outside itself.`);
		return lines.join("\n");
	}
	lines.push(`
## Dependencies

Names the moved text uses, and where each would be imported from.`);
	for (const dependency of needed) {
		const origin = dependency.origin;
		switch (origin.kind) {
			case "sourceModule":
				lines.push(
					`- ${code(dependency.name)}: stays in ${code(plan.fromModule)}${origin.exported === false ? ", and is not exported, which blocks the move" : ""}`,
				);
				break;
			case "workspaceModule":
				lines.push(`- ${code(dependency.name)}: from ${code(origin.module)}`);
				break;
			case "external":
				lines.push(`- ${code(dependency.name)}: from ${code(origin.via.specifier)}, outside the workspace`);
				break;
			case "unresolved":
				lines.push(`- ${code(dependency.name)}: unresolved (${origin.reason}), so the provider decides`);
				break;
		}
	}
	return lines.join("\n");
}

/** Count for a heading. */
function countLabel(count: Count, noun: string, plural = `${noun}s`): string {
	return `${count.kind === "atLeast" ? "at least " : ""}${count.count} ${count.count === 1 ? noun : plural}`;
}

/** What was cut, from the count. */
function pagingNotes(
	count: Count,
	shown: number,
	noun: string,
	plural = `${noun}s`,
	raise = `Raise \`limit\`.`,
): string {
	const notes: string[] = [];
	if (count.kind === "exact") {
		const more = count.count - shown;
		if (more > 0) notes.push(`\n\n> ${more} more ${more === 1 ? noun : plural} not shown. ${raise}`);
	} else {
		if (count.reason !== "scanCapped")
			notes.push(`\n\n> More ${plural} exist than the ${shown} shown, uncounted. ${raise}`);
		if (count.reason !== "pageCapped") {
			notes.push(
				`\n\n> The scan stopped before the end of the index, so matches beyond it were never looked at.`,
			);
		}
	}
	return notes.join("");
}

export function renderComments(result: CommentsResult): string {
	if (result.count.count === 0) {
		return `# Comments\n\nNo comment matched.\n\n> Searches normalized prose, so markers and line wrapping are not matched.${pagingNotes(result.count, 0, "comment")}`;
	}

	const byModule = new Map<string, string[]>();
	for (const comment of result.comments) {
		const rows = byModule.get(comment.module) ?? [];
		// The anchor is the hop from prose back to structure, which is the whole reason a comment is
		// a fact rather than a grep hit.
		const about =
			comment.anchor === null
				? `${comment.form} (module)`
				: `${comment.form} ${code(comment.anchor.name)} (${comment.anchor.kind})`;
		rows.push(
			`- Line ${comment.range.start.line + 1}: ${about}\n  ${code(comment.factId)}\n${indent(comment.raw)}`,
		);
		byModule.set(comment.module, rows);
	}

	const body = renderGroupedModules(countLabel(result.count, "comment"), byModule);
	return body + pagingNotes(result.count, result.comments.length, "comment");
}

export function renderDocs(result: DocsResult): string {
	if (result.count.count === 0) {
		return `# Documentation\n\nNo documentation matched.\n\n> Searches normalized text, so line wrapping is not matched.${pagingNotes(result.count, 0, "region")}`;
	}

	const byModule = new Map<string, string[]>();
	for (const region of result.docs) {
		const rows = byModule.get(region.module) ?? [];
		// The heading path is the hop from prose back to structure, and the whole reason this answers
		// differently from a comment search.
		const under = region.headingPath.length === 0 ? "(no heading)" : region.headingPath.join(" > ");
		const where = region.fenced ? `${under}  [in a code block]` : under;
		const location =
			region.hit === undefined
				? `Line ${region.range.start.line + 1}`
				: `Line ${region.hit.line + 1}:${region.hit.character + 1}`;
		rows.push(`- ${location}: ${where}\n  ${code(region.factId)}\n${indent(region.raw)}`);
		byModule.set(region.module, rows);
	}

	const body = renderGroupedModules(countLabel(result.count, "region"), byModule);
	return body + pagingNotes(result.count, result.docs.length, "region");
}

/** Quoted so a comment's own markers cannot be read as this document's markup. */
function indent(raw: string): string {
	return raw
		.split("\n")
		.map((line) => `      ${line}`)
		.join("\n");
}

/** Literal hits, grouped by file. */
export function renderLiterals(result: LiteralsResult): string {
	if (result.count.count === 0) {
		return `# Literals\n\nNo literal matched.\n\n> Searches decoded values, not source text.${pagingNotes(result.count, 0, "literal")}`;
	}

	const byModule = new Map<string, string[]>();
	for (const literal of result.literals) {
		const rows = byModule.get(literal.module) ?? [];
		const shown = literal.value.length > 60 ? `${literal.value.slice(0, 60)}...` : literal.value;
		// The containing declaration is the hop from text to structure, and it matters most where
		// names are mangled: the literal is then the only readable thing pointing at its symbol. The
		// module prefix is dropped because the row already sits under its module header.
		const container =
			literal.containerName === undefined
				? literal.containerId === null
					? ""
					: `  in ${code(literal.containerId.split(" ").slice(3).join(" "))}`
				: `  in ${literal.containerKind ?? "declaration"} ${code(literal.containerName)}`;
		rows.push(`- Line ${literal.range.start.line + 1}: **${literal.kind}** ${JSON.stringify(shown)}${container}`);
		byModule.set(literal.module, rows);
	}

	const body = renderGroupedModules(countLabel(result.count, "literal"), byModule);
	return body + pagingNotes(result.count, result.literals.length, "literal");
}

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

/** Who, as the harness attested it. */
function authorName(author: NoteAuthor | null): string {
	if (author === null) return "unattributed";
	switch (author.kind) {
		case "person":
			return "a person";
		case "agent":
			return author.model ?? "an agent";
		case "client":
			return author.version === null ? author.name : `${author.name} ${author.version}`;
	}
}

/** Revision and who touched it, one line. */
function provenance(note: Note): string {
	const edited = note.revision > 1 ? `, last edited by ${authorName(note.editedBy)}` : "";
	const confirmed = note.confirmedAt === null ? "" : `, confirmed by ${authorName(note.confirmedBy)}`;
	return `Revision ${note.revision}, written by ${authorName(note.author)}${edited}${confirmed}.`;
}

/** What moved since the revision was written, one bullet each. */
function noteAdvisories(note: Note): string[] {
	const found: string[] = [];
	if (note.sourceChanged) found.push(`- **Source changed; review:** the symbol changed since this revision.`);
	for (const link of note.links.filter((entry) => entry.state === "broken")) {
		found.push(`- **Broken ref:** ${code(link.written)} names nothing now.`);
	}
	const changed = note.links.filter((entry) => entry.state === "changed");
	if (changed.length > 0) {
		found.push(
			`- **Changed refs:** ${changed.map((link) => code(link.current)).join(", ")} changed since this revision.`,
		);
	}
	if (note.doubt !== null) {
		found.push(`- **Doubted** by ${authorName(note.doubt.by)}: ${note.doubt.reason}`);
	}
	if (note.proposal !== null) {
		found.push(`- **Proposal pending:** a replacement from ${authorName(note.proposal.by)} waits on a person.`);
	}
	return found;
}

/** A whole note, or where none stands. */
export function renderNote(symbolId: string, note: Note | null): string {
	if (note === null) return `# Note on ${code(symbolId)}\n\nNo note stands. \`write_note\` writes one.`;

	const lines = [
		`
# Note on ${code(symbolId)}

${provenance(note)}

${note.text}
		`.trim(),
	];
	const advisories = noteAdvisories(note);
	if (advisories.length > 0)
		lines.push(`
## Advisories

${advisories.join("\n")}`);
	return lines.join("\n");
}

/** The note's summary and advisories, for a describe. */
export function renderNoteLine(note: Note | null): string {
	if (note === null) return `## Note\n\nNo note stands.`;

	const more = note.summary === null || note.text.slice(note.restAt).trim() !== "";
	const lead = `${note.summary ?? "No summary."}${more ? " `read_note` shows the rest." : ""}`;
	const lines = [`## Note`, "", lead, "", provenance(note)];
	const advisories = noteAdvisories(note);
	if (advisories.length > 0) lines.push("", ...advisories);
	return lines.join("\n");
}

/** What a write or a doubt did. */
export function renderNoteOutcome(symbolId: string, outcome: NoteOutcome, action: "write" | "doubt"): string {
	if (outcome.outcome === "refused") {
		const reason = /[.!?]$/.test(outcome.reason) ? outcome.reason : `${outcome.reason}.`;
		const lines = [`# ${action === "doubt" ? "Doubt not recorded" : "Note not saved"}`, "", reason];
		const refs = outcome.refs ?? [];
		if (refs.length > 0) lines.push("");
		for (const problem of refs) {
			const candidates =
				problem.candidates.length === 0
					? ""
					: ` Candidates: ${problem.candidates.map((candidate) => code(candidate)).join(", ")}.`;
			lines.push(`- ${code(problem.ref)} at offset ${problem.at}: ${problem.problem}.${candidates}`);
		}
		if (outcome.current !== undefined && outcome.current !== null) {
			lines.push("", `**Current revision:** ${outcome.current.revision}`);
		}
		return lines.join("\n");
	}
	if (outcome.outcome === "proposed") {
		return `# Proposal saved\n\n**Symbol:** ${code(symbolId)}\n\nA person wrote or confirmed revision ${outcome.note.revision}, so this waits for them.`;
	}
	if (outcome.note === null) return `# No note stands\n\n**Symbol:** ${code(symbolId)}\n\nThe text was empty.`;
	if (action === "doubt") {
		return `# Doubt recorded\n\n**Symbol:** ${code(symbolId)}\n\nOn revision ${outcome.note.revision}. The next save or confirm clears it.`;
	}
	return `# Note saved\n\n**Symbol:** ${code(symbolId)}\n\nRevision ${outcome.note.revision}.`;
}

/** Notes whose refs name a symbol or file. */
export function renderNoteBacklinks(target: string, result: NoteBacklinks): string {
	if (result.notes.length === 0) return `# Notes naming ${code(target)}\n\nNo note names it.`;

	const lines = [`# Notes naming ${code(target)}`, ""];
	for (const entry of result.notes) {
		const summary = entry.summary === null ? "" : `: ${entry.summary}`;
		lines.push(`- ${code(entry.symbolId)}${summary}`);
	}
	if (result.total > result.notes.length)
		lines.push(`
> ${result.total - result.notes.length} more not shown. Raise \`limit\`.`);
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

/**
 * The shape of a whole repository.
 *
 * The scope line is the load-bearing one: an index built by walking a disk and one built from what
 * git tracks are different claims, and a reader who cannot tell them apart will read the first as
 * the second.
 */
export function renderOverview(result: {
	files: number;
	symbols: number;
	references: number;
	imports: number;
	literals: number;
	content?: ContentTotals;
	modules: number;
	scope: string;
	index: {
		state: string;
		done: number;
		total: number;
		failures?: number;
		stored?: number;
		fullFiles?: number;
		outlineFiles?: number;
	};
	scan?: {
		tracked: number;
		claimed: number;
		unclaimed: number;
		generated: number;
		denied: number;
		knowledgeSweep?: KnowledgeSweep;
	};
	parseFailures?: Array<{ module: string; reason: string }>;
	notes?: { noted: number; unknown: number };
	largest: Array<{ module: string; symbols: number }>;
	largestData?: Array<{ module: string; symbols: number; content: "data" | "document" }>;
	entryPoints?: Array<{ module: string; how: EntryHow; symbolId?: string | undefined }> | undefined;
	moreEntryPoints?: number | undefined;
}): string {
	const lines = [
		`# Workspace overview

## Workspace

${code(result.scope)}

## Index
`,
	];

	// Show progress for counted states.
	const counted = ["warming", "indexing", "upgrading"].includes(result.index.state);
	const stateNote =
		result.index.state === "unstarted"
			? `serving stored facts; nothing rescanned this run`
			: `${result.index.state}${counted ? ` (${result.index.done} of ${result.index.total})` : ""}`;
	lines.push(`- State: ${stateNote}`);

	const outline = result.index.outlineFiles ?? 0;
	if (outline > 0) {
		lines.push(`- Depth: ${result.index.fullFiles ?? 0} modules at final depth, ${outline} outline only`);
		lines.push(`  - reference and literal counts are lower bounds until the upgrade finishes`);
	}

	const failures = result.index.failures ?? 0;
	if (failures > 0) {
		lines.push(`- Files failed to parse: ${failures}; any facts indexed before the failure were kept`);
	}

	// Notes, never verdicts.
	const noted = result.notes?.noted ?? 0;
	const unknown = result.notes?.unknown ?? 0;
	if (noted > 0) lines.push(`- Files with provider notes: ${noted}; \`outline_module\` shows them`);
	if (unknown > 0) lines.push(`- Files read before notes were kept: ${unknown}; known after their next read`);

	// Scan parts sum to total.
	if (result.scan !== undefined) {
		const { tracked, claimed, unclaimed, generated, denied } = result.scan;
		lines.push(`- Last scan: ${tracked} files seen`);
		lines.push(`  - ${claimed} claimed by providers`);
		lines.push(`  - ${unclaimed} claimed by no provider`);
		if (generated > 0) lines.push(`  - ${generated} generated`);
		if (denied > 0) lines.push(`  - ${denied} outside scope`);
		const sweep = result.scan.knowledgeSweep;
		if (sweep !== undefined) {
			const early = sweep.stoppedEarly ? "; stopped at its cap, resuming next pass" : "";
			lines.push(
				`  - Last knowledge sweep: ${sweep.examined} subjects examined, ${sweep.rebound} rebound, ${sweep.orphaned} orphaned, ${sweep.deleted} deleted${early}`,
			);
		}
	}

	// Keep every path; group only repeated reasons.
	const named = result.parseFailures ?? [];
	if (named.length > 0) {
		const byReason = new Map<string, string[]>();
		for (const failure of named) {
			const modules = byReason.get(failure.reason) ?? [];
			modules.push(failure.module);
			byReason.set(failure.reason, modules);
		}
		const ranked = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);

		lines.push(`
## Failed to parse
`);
		for (const [reason, modules] of ranked) {
			lines.push(`- ${reason}${modules.length === 1 ? "" : ` (${modules.length} files)`}`);
			for (const module of modules) lines.push(`  - ${code(module)}`);
		}
	}

	lines.push(`
## Counts

| Files | Symbols | References | Imports | Literals | Modules |
| ---: | ---: | ---: | ---: | ---: | ---: |
| ${result.files} | ${result.symbols} | ${result.references} | ${result.imports} | ${result.literals} | ${result.modules} |`);

	// Named where the number is, because "symbols" reads as callable code and a fixture's keys are not.
	if (result.content !== undefined) {
		const { files, symbols } = result.content;
		if (files.data + files.document > 0) {
			lines.push(`
> Files: ${contentClasses(files, "")}. Symbols: ${contentClasses(symbols, "in ")}.
`);
		}
		if (files.text > 0)
			lines.push(`
> ${files.text} files read as plain text.`);
		if (files.unknown > 0) {
			lines.push(
				"",
				`> ${files.unknown} file${files.unknown === 1 ? " was" : "s were"} read before their content class was recorded; the next scan records it without re-reading them.`,
			);
		}
		if (symbols.data > symbols.code) {
			lines.push(`
> Data files carry more symbols than code. A \`deny\` list in \`lexicon.json\` at the workspace root keeps fixture directories out of the index.
`);
		}
	}

	// Self-contained: the depth line is absent once nothing is outline, so pointing at it would
	// reference a line that is not on the page.
	const external = (result.index.stored ?? result.files) - result.files;
	if (external > 0) {
		lines.push(`
> Counts cover workspace files. The index holds ${external} external surface module${external === 1 ? "" : "s"} besides, ${result.index.stored} in total.
`);
	}

	if (result.entryPoints !== undefined || result.moreEntryPoints !== undefined) {
		const entries = result.entryPoints ?? [];
		lines.push(`
## Entry points
`);
		if (entries.length === 0 && result.moreEntryPoints === undefined) lines.push("No recognized entry points.");
		for (const entry of entries) {
			const main = entry.symbolId === undefined ? "" : `, ${code(entry.symbolId)}`;
			lines.push(`- ${code(entry.module)}: ${ENTRY_HOW[entry.how]}${main}`);
		}
		if (result.moreEntryPoints !== undefined) {
			lines.push(`
> ${result.moreEntryPoints} more not shown.`);
		}
	}

	lines.push(`
## Largest modules
`);
	for (const module of result.largest) lines.push(`- ${code(module.module)}: ${module.symbols} symbols`);

	const data = result.largestData ?? [];
	if (data.length > 0) {
		lines.push(`
## Largest data and document files
`);
		for (const row of data) lines.push(`- ${code(row.module)}: ${row.symbols} symbols (${row.content})`);
	}
	return lines.join("\n");
}

/** "100 code, 40 data, 3 documents", leaving out a class with nothing in it. */
function contentClasses(counts: ContentCounts, prefix: string): string {
	const parts = [`${counts.code} ${prefix}code`];
	if (counts.data > 0) parts.push(`${counts.data} ${prefix}data`);
	if (counts.document > 0) parts.push(`${counts.document} ${prefix}document${counts.document === 1 ? "" : "s"}`);
	if (counts.text > 0) parts.push(`${counts.text} ${prefix}plain text`);
	return parts.join(", ");
}

/** Import sites, grouped by the file doing the importing. */
export function renderImports(result: {
	imports: Array<{
		module: string;
		specifier: string;
		name?: string | undefined;
	}>;
	count: Count;
}): string {
	if (result.count.count === 0) return `# Imports\n\nNo imports matched.${pagingNotes(result.count, 0, "import")}`;

	const byModule = new Map<string, Set<string>>();
	for (const statement of result.imports) {
		const specifiers = byModule.get(statement.module) ?? new Set();
		// The name is shown when there is one. Its absence means the statement binds the module
		// rather than an export, which is a real import and not a missing field.
		const named = statement.name === undefined ? "" : `  { ${statement.name} }`;
		specifiers.add(`${statement.specifier}${named}`);
		byModule.set(statement.module, specifiers);
	}

	const rows = new Map<string, string[]>();
	for (const [module, specifiers] of byModule) {
		rows.set(
			module,
			Array.from(specifiers, (specifier) => `- ${code(specifier)}`),
		);
	}
	const body = renderGroupedModules(
		`${byModule.size} file${byModule.size === 1 ? "" : "s"}, ${countLabel(result.count, "import entry", "import entries")}`,
		rows,
	);
	return body + pagingNotes(result.count, result.imports.length, "import entry", "import entries");
}

/** The most-referenced symbols, which is where reading pays off most. */
export function renderMostReferenced(
	rows: Array<{
		symbolId: string;
		count: number;
		declaration: SymbolSummary | null;
	}>,
): string {
	if (rows.length === 0) return `# Most referenced\n\nNothing is referenced yet.`;

	const lines = [
		`# Most referenced

| Symbol | References |
| --- | ---: |`,
	];
	for (const row of rows) {
		const where = row.declaration
			? `${line(row.declaration)} in ${code(row.declaration.module)}`
			: code(row.symbolId);
		lines.push(`| ${where} | ${row.count} |`);
	}
	lines.push(`
> Counts are bounded by what binding resolved.`);
	return lines.join("\n");
}

/** Symbols found by a name search, grouped by file. Where browsing starts. */
export function renderSymbolSearch(result: {
	text?: string | undefined;
	regex?: string | undefined;
	symbols: SymbolSummary[];
	count: Count;
}): string {
	const query = result.regex === undefined ? JSON.stringify(result.text) : `regex ${JSON.stringify(result.regex)}`;
	if (result.count.count === 0) return `# Symbol search\n\nNo symbol name matches ${query}.`;

	const byModule = new Map<string, string[]>();
	for (const symbol of result.symbols) {
		const rows = byModule.get(symbol.module) ?? [];
		// The id rides along because it is the address every other tool takes. Without it a search
		// hit has to be looked up again before it can be read, replaced or renamed.
		rows.push(symbolBullet(symbol), `  ID: ${code(symbol.symbolId)}`);
		byModule.set(symbol.module, rows);
	}

	const body = renderGroupedModules(`${countLabel(result.count, "symbol")} matching ${query}`, byModule);
	const raise = `Raise \`limit\` or narrow by kind or module.`;
	return body + pagingNotes(result.count, result.symbols.length, "symbol", "symbols", raise);
}

/** A file's notes, or why unknown. */
function renderFileNotes(notes: FileNotes | undefined): string[] {
	if (notes === undefined || (notes.known && notes.notes.length === 0)) return [];
	if (!notes.known) {
		return notes.reason === "indexedBeforeNotes"
			? ["", `> Provider notes unknown: indexed before notes were kept. Known after its next read.`]
			: [];
	}
	const lines = [
		`
## Provider notes
`,
	];
	for (const note of notes.notes) {
		const where = note.range === undefined ? "" : `Line ${note.range.start.line + 1}: `;
		lines.push(`- ${where}${note.severity}: ${note.message}`);
	}
	return lines;
}

/** Everything one file declares, nested by container. The "open the file" answer. */
export function renderOutline(module: string, declarations: SymbolSummary[], notes?: FileNotes): string {
	if (declarations.length === 0) {
		return [`# ${code(module)}`, "", `No indexed declarations.`, ...renderFileNotes(notes)].join("\n");
	}

	const children = new Map<string, typeof declarations>();
	const roots: typeof declarations = [];
	for (const declaration of declarations) {
		const parent = declaration.containerId;
		if (parent === undefined || !declarations.some((d) => d.symbolId === parent)) {
			roots.push(declaration);
			continue;
		}
		const list = children.get(parent) ?? [];
		list.push(declaration);
		children.set(parent, list);
	}

	const lines = [
		`# ${code(module)}

## ${declarations.length} declarations
`,
	];
	const walk = (nodes: typeof declarations, depth: number) => {
		for (const node of nodes) {
			const refs = node.referenceCount === undefined ? "" : ` refs=${node.referenceCount}`;
			lines.push(`${"  ".repeat(depth)}- ${line(node)}${refs}`);
			walk(children.get(node.symbolId) ?? [], depth + 1);
		}
	};
	walk(roots, 0);
	lines.push(...renderFileNotes(notes));
	return lines.join("\n");
}

////////////////////////////////
//  Refactor

/** Fenced, since the whole point is text a caller edits and hands back verbatim. */
export function renderSymbolSource(source: SymbolSource): string {
	if (!source.found) {
		return source.stale === true
			? `# Symbol source\n\n${source.reason}. Ask again once it has been re-indexed.`
			: `# Symbol source\n\n${source.reason}`;
	}

	const { start, end } = source.range;
	return [
		`# ${code(source.name)}`,
		"",
		`${source.kind} in ${code(source.module)}, lines ${start.line + 1} to ${end.line + 1}.`,
		...(source.spanHash === undefined ? [] : [`Span hash: ${code(source.spanHash)}`]),
		"",
		"```",
		source.text,
		"```",
	].join("\n");
}

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

/**
 * The operating rules, returned at start rather than documented elsewhere.
 *
 * Tracking is honour-based: nothing can stop an agent editing a file behind the transaction's
 * back, so the one moment it is certain to read this is the moment it opens one.
 */
export function renderRefactorStart(outcome: RefactorStartResult): string {
	if (!outcome.started) {
		return [
			`# Refactor already open`,
			"",
			`Transaction ${code(outcome.id)} is already open on this workspace. One transaction at a time.`,
			"",
			`Call \`refactor_status\` to see it, then continue it, \`refactor_commit\` it, or \`refactor_revert\` it.`,
		].join("\n");
	}

	return [
		`# Refactor ${code(outcome.id)} open`,
		"",
		`## Before you edit anything by hand`,
		"",
		`Call \`refactor_track\` on the file FIRST. Only tracked files and files a refactor tool touched`,
		`can be put back. An untracked edit is invisible to undo and survives revert.`,
		"",
		`## How it unwinds`,
		"",
		`- \`refactor_undo\` removes the newest step. It refuses if that step's files changed since,`,
		`  rather than overwriting whatever changed them.`,
		`- \`refactor_revert\` returns every tracked file to how this transaction found it, discarding`,
		`  manual edits made since.`,
		`- \`refactor_commit\` keeps what is on disk and ends the transaction. Nothing is undoable after.`,
		`  It refuses while issues are outstanding; pass \`force\` to accept them deliberately.`,
		"",
		`## While it is open`,
		"",
		`Re-fetch addresses after every step. Ranges move, so a symbolId or range read before a step`,
		`may not describe the same text after it.`,
		"",
		`Any session may operate this transaction. There is no owner token, so \`refactor_status\` is`,
		`how you find out what someone else already did.`,
	].join("\n");
}

export function renderRefactorStatus(status: TransactionStatus): string {
	if (!status.open) {
		return `# Refactor status\n\nNo transaction is open. Call \`refactor_start\` to begin one.`;
	}

	// Optional on the wire, so an absent one is a malformed peer rather than a closed transaction.
	const lines = [`# Refactor ${code(status.id ?? "unknown")}`];

	if (status.steps.length === 0)
		lines.push(`
No steps yet.`);
	else {
		lines.push(`
## Steps
`);
		for (const step of status.steps) {
			const files = step.modules.length === 0 ? `no files` : step.modules.map((m) => code(m)).join(", ");
			lines.push(`${step.stepNo}. **${step.kind}** (${step.phase}): ${files}`);
		}
	}

	if (status.tracked.length > 0) {
		lines.push(`
## Tracked

${status.tracked.map((module) => `- ${code(module)}`).join("\n")}`);
	}
	if (status.drifted.length > 0) {
		lines.push(`
## Changed on disk

${status.drifted
	.map(
		({ module, contentHash }) =>
			`- ${code(module)} (content hash: ${contentHash === null ? "unavailable" : code(contentHash)})`,
	)
	.join("\n")}`);
	}
	if (status.edited.length > 0) {
		lines.push(`
## Editor writes recorded

${status.edited.map((module) => `- ${code(module)}`).join("\n")}`);
	}

	const issues = renderIssues(status.issues);
	if (issues.length > 0) lines.push("", ...issues);
	else if (status.steps.length > 0)
		lines.push(`
No outstanding issues. \`refactor_commit\` would succeed.`);

	return lines.join("\n");
}

/**
 * A replacement, with what it broke.
 *
 * A step with issues is still applied and still says so. Refusing would leave the caller with no
 * way to make a change whose fallout it intends to fix in the next step.
 */
export function renderReplaceOutcome(outcome: ReplaceOutcome): string {
	if (!outcome.replaced) {
		return `# Not replaced\n\n${outcome.reason ?? `the replacement could not be applied`}`;
	}

	const lines = [
		`# Replaced in ${code(outcome.module ?? "unknown")}
`,
	];
	if (outcome.issues.length === 0) {
		lines.push(`Nothing else stopped resolving. \`refactor_commit\` would succeed.`);
		return lines.join("\n");
	}

	lines.push(
		`Applied, but it introduced ${outcome.issues.length} issue${outcome.issues.length === 1 ? "" : "s"}.`,
		`Fix them in a later step, \`refactor_undo\` this one, or commit with force.`,
		"",
		...renderIssues(outcome.issues),
	);
	return lines.join("\n");
}

/** An insert, with what it warned about. `alreadyInserted` is the retry answer, not a failure. */
export function renderInsertOutcome(outcome: InsertOutcome): string {
	if (outcome.alreadyInserted === true) {
		return `# Already inserted\n\nThe exact text already sits at that spot in ${code(outcome.module ?? "unknown")}; nothing was written.`;
	}
	if (!outcome.inserted) {
		return `# Not inserted\n\n${outcome.reason ?? `the insert could not be applied`}`;
	}

	const lines = [
		`# Inserted into ${code(outcome.module ?? "unknown")}
`,
	];
	for (const symbolId of outcome.symbolIds ?? []) lines.push(`- ID: ${code(symbolId)}`);
	if ((outcome.symbolIds ?? []).length > 0) lines.push("");

	if (outcome.issues.length === 0) {
		lines.push(`Everything the new text names resolves. \`refactor_commit\` would succeed.`);
		return lines.join("\n");
	}
	lines.push(
		`Applied, with ${outcome.issues.length} warning${outcome.issues.length === 1 ? "" : "s"} to judge:`,
		"",
		...renderIssues(outcome.issues),
	);
	return lines.join("\n");
}

/** A move step. A blocked site stops the whole move, so a refusal names what could not be written. */
export function renderMoveOutcome(toModule: string, outcome: MoveOutcome): string {
	if (!outcome.moved) {
		const lines = [
			`# Not moved

${outcome.reason ?? `the move could not be carried out`}`,
		];
		if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
		return lines.join("\n");
	}

	const modules = outcome.modules ?? [];
	const lines = [
		`# Moved to ${code(toModule)}

${modules.length} file${modules.length === 1 ? "" : "s"} written: ${modules.map((m) => code(m)).join(", ")}`,
	];
	if (outcome.order !== undefined && outcome.order.length > 1) {
		lines.push(`
Moved in order, one step each: ${outcome.order.map((name) => code(name)).join(", ")}`);
	}
	if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
	return lines.join("\n");
}

/** A rename step, with what the index could not promise. */
export function renderRenameStep(newName: string, outcome: RenameStepOutcome): string {
	if (!outcome.renamed) {
		const lines = [
			`# Not renamed

${outcome.reason ?? `the rename could not be carried out`}`,
		];
		if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
		return lines.join("\n");
	}

	const modules = outcome.modules ?? [];
	const lines = [
		`# Renamed to ${newName}

${modules.length} file${modules.length === 1 ? "" : "s"} reindexed: ${modules.map((m) => code(m)).join(", ")}`,
	];

	if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
	return lines.join("\n");
}

export function renderRefactorCommit(outcome: RefactorCommitResult): string {
	if (outcome.committed) {
		const note = outcome.issues.length > 0 ? ` ${outcome.issues.length} issue(s) were accepted by force.` : "";
		return `# Committed\n\nThe transaction is closed and nothing is undoable now.${note}`;
	}

	return [
		`# Not committed`,
		"",
		outcome.reason ?? `the transaction could not be committed`,
		"",
		...renderIssues(outcome.issues),
	].join("\n");
}

/**
 * Several same-named symbols, so a caller can pick before spending a describe on each.
 *
 * Ambiguity is shown rather than resolved: choosing one silently is how an agent ends up
 * confidently reading about the wrong symbol.
 */
export function renderCandidates(name: string, candidates: SymbolSummary[]): string {
	if (candidates.length === 0) return `# Symbol lookup\n\nNo symbol named ${code(name)} is indexed.`;
	if (candidates.length === 1) return "";

	// The id per row is the whole point: telling a caller to pass a symbolId while showing none left
	// eight identical minified methods with no way to be told apart short of guessing ids blind.
	const lines = [`# ${candidates.length} symbols named ${code(name)}`];
	for (const candidate of candidates) {
		lines.push(`
## ${code(candidate.module)}

- ${line(candidate)}
  ID: ${code(candidate.symbolId)}`);
	}
	lines.push(`
Pass one of the IDs above to pick one.`);
	return lines.join("\n");
}
