// Turning answers into what an agent reads.
//
// Pure, because output formatting deserves direct tests.

import type {
	CommentsResult,
	DescribeResult,
	DocsResult,
	InvalidateOutcome,
	KnowledgeGaps,
	LiteralsResult,
	RecalledAnswer,
	RecordOutcome,
	RefactorIssue,
	ReferencesResult,
	RenamePlan,
	SymbolSource,
	SymbolSummary,
	TransactionStatus,
} from "@nyaa-lexicon/core";
import { FACT_KINDS, type FactKind, type TypeInfo } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Functions & Helpers

function line(summary: SymbolSummary): string {
	// Three states, not two. A language with no notion of module export renders its visibility
	// without implying the answer was no.
	const exported = summary.exported === true ? "" : ` (${summary.visibility})`;
	const signature = summary.signature === undefined ? "" : `: \`${summary.signature}\``;
	return `**${summary.kind}** \`${summary.name}\`${exported}${signature}`;
}

function symbolBullet(summary: SymbolSummary): string {
	return `- ${line(summary)}`;
}

/** Describe is a summary, and documentation is normalized to one line, so the cut is by sentence. */
function summarize(text: string, limit = 200): string {
	const sentence = text.indexOf(". ");
	if (sentence > 0 && sentence < limit) return text.slice(0, sentence + 1);
	if (text.length <= limit) return text;
	const boundary = text.lastIndexOf(" ", limit);
	return `${text.slice(0, boundary > 0 ? boundary : limit).trimEnd()} ...`;
}

function renderGroupedModules(title: string, groups: Iterable<readonly [string, readonly string[]]>): string {
	const sections = [`# ${title}`];
	for (const [module, rows] of groups) sections.push(`## \`${module}\`\n\n${rows.join("\n")}`);
	return sections.join("\n\n");
}

function appendHierarchy(lines: string[], result: DescribeResult["hierarchy"]): void {
	lines.push("", "## Type hierarchy", "");
	const hasRelationships =
		result.supertypes.length > 0 ||
		result.subtypes.length > 0 ||
		result.ancestors.length > 0 ||
		result.unboundSupertypes.length > 0;
	if (!hasRelationships) {
		lines.push("No supertypes or subtypes in the index.");
		return;
	}

	const list = (label: string, entries: SymbolSummary[]) => {
		if (entries.length === 0) return;
		lines.push(`### ${label}`, "");
		for (const entry of entries) lines.push(`- ${line(entry)}  \`${entry.module}\``);
	};
	list("Extends", result.supertypes);
	list("Extended by", result.subtypes);

	const indirect = result.ancestors.filter(
		(ancestor) => !result.supertypes.some((direct) => direct.symbolId === ancestor.symbolId),
	);
	if (indirect.length > 0) {
		lines.push("### Further up", "", `- ${indirect.map((ancestor) => `\`${ancestor.name}\``).join(" <- ")}`);
	}
	if (result.unboundSupertypes.length > 0) {
		lines.push("### Outside the index", "");
		for (const name of result.unboundSupertypes) lines.push(`- \`${name}\``);
	}
}

function appendDependencies(lines: string[], summary: DescribeResult["graph"]): void {
	const via = summary.viaMembers === undefined ? "" : ` across the symbol and its ${summary.viaMembers} members`;
	lines.push(
		"",
		"## Dependencies",
		"",
		`- Uses: ${summary.fanOut} distinct symbol${summary.fanOut === 1 ? "" : "s"}${via}`,
	);
	if (summary.cycle) {
		lines.push("", "### Cycle", "");
		for (const member of summary.cycle.slice(0, 10)) lines.push(`- \`${member}\``);
		if (summary.cycle.length > 10) lines.push("", `> ${summary.cycle.length - 10} more cycle members not shown.`);
	}
	lines.push("", "> Counts use resolved indexed bindings.");
}

/** One symbol as its complete surface. */
export function renderDescribe(result: DescribeResult): string {
	// The line span makes "read the body" a range read of exactly those lines, never a file read.
	const location =
		result.symbol.lines === undefined
			? `\`${result.symbol.module}\``
			: `\`${result.symbol.module}:${result.symbol.lines.start + 1}-${result.symbol.lines.end + 1}\``;
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
		`**ID:** \`${result.symbol.symbolId}\``,
	];

	if (result.prose !== undefined && result.prose.length > 0) {
		lines.push("", "## Prose", "");
		for (const region of result.prose) {
			const where = region.fenced ? ` (in a code block)` : "";
			lines.push(`- Line ${region.line + 1}${where}: ${summarize(region.text)}`);
		}
		if (result.moreProse !== undefined) {
			lines.push("", `> ${result.moreProse} more not shown. Call \`search_docs\` with this module.`);
		}
	}

	if (result.symbol.docComment) {
		lines.push("", "## Documentation", "", summarize(result.symbol.docComment));
	}

	if (result.members.length > 0) {
		lines.push("", "## Members", "");
		for (const member of result.members) lines.push(symbolBullet(member));
	}

	// What someone wrote about it that is not its documentation, which is otherwise only reachable
	// by opening the file.
	if (result.comments !== undefined && result.comments.length > 0) {
		lines.push("", "## Notes", "");
		for (const comment of result.comments) {
			lines.push(`- Line ${comment.line + 1} (${comment.form}): ${summarize(comment.text)}`);
		}
		if (result.moreComments !== undefined) {
			lines.push("", `> ${result.moreComments} more not shown. Call \`find_comments\` with this module.`);
		}
	}

	lines.push("", "## Usage", "", `Used in ${result.referenceCount} place${result.referenceCount === 1 ? "" : "s"}.`);
	if (result.referenceCount > 0) lines.push("Call `find_references` for the list.");
	appendHierarchy(lines, result.hierarchy);
	appendDependencies(lines, result.graph);
	return lines.join("\n");
}

/** Uses of a symbol, grouped by file so the shape of the usage is visible at a glance. */
export function renderReferences(result: ReferencesResult): string {
	if (result.total === 0) return "# References\n\nNo references found.";

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
	const lines: string[] = [`# \`${name}\``, "", "## Type", ""];
	if (type.status === "known") {
		lines.push("```ts", type.display, "```", "", "## Provenance", "");
		const from = type.provenance === "declared" ? "declared in source" : `established by ${type.provenance}`;
		lines.push(`- Known: ${from}`);
		return lines.join("\n");
	}
	if (type.status === "inferred") {
		lines.push("```ts", type.display, "```", "", "## Provenance", "");
		lines.push(`- Inferred from: ${type.basis}`);
		return lines.join("\n");
	}
	lines.push(`Unknown: ${type.reason}${type.detail ? `: ${type.detail}` : ""}`);
	return lines.join("\n");
}

/**
 * What a rename would touch, and what the index cannot promise about it.
 *
 * Kept for the editor's prepareRename, which asks whether a rename is offerable before the user
 * types a new name. No MCP tool renders it: there, a rename is a transaction step and its answer
 * is the step's outcome.
 */
export function renderRenamePlan(plan: RenamePlan): string {
	if (plan.blockers.length > 0) {
		const lines = [
			`# Rename blocked`,
			"",
			`Cannot rename \`${plan.oldName || plan.symbolId}\`.`,
			"",
			"## Blockers",
			"",
		];
		for (const blocker of plan.blockers) lines.push(`- **${blocker.kind}:** ${blocker.detail}`);
		return lines.join("\n");
	}

	// Owner calls are counted in the headline and shown per file, because a plan that says "2
	// occurrences" and then rewrites four places is a plan a reader stops trusting. They are not
	// occurrences of the name, so they are named separately rather than folded into the same number.
	const calls = plan.files.reduce((total, file) => total + (file.ownerCalls?.length ?? 0), 0);
	const touches = `${plan.occurrences} occurrence${plan.occurrences === 1 ? "" : "s"}`;
	const withCalls = calls === 0 ? touches : `${touches} and ${calls} call${calls === 1 ? "" : "s"} that name it`;

	const lines = [
		`# Rename ${plan.oldName} to ${plan.newName}`,
		"",
		`Touches ${withCalls} in ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}.`,
		"",
		"## Files",
		"",
	];
	for (const file of plan.files) {
		const here = file.ownerCalls?.length ?? 0;
		lines.push(
			`- \`${file.module}\`: ${file.sites.length} occurrence${file.sites.length === 1 ? "" : "s"}${here === 0 ? "" : ` plus ${here} call${here === 1 ? "" : "s"}`}`,
		);
	}

	// Never omitted when empty in a way a reader could mistake for silence: the absence of this
	// section is itself the claim that the index saw everything.
	if (plan.warnings.length === 0) {
		lines.push("", "Every occurrence is a bound edge.");
		return lines.join("\n");
	}

	lines.push("", "## Warnings", "", "This set may not be complete.");
	for (const warning of plan.warnings) {
		lines.push(`- **${warning.kind}:** ${warning.detail}`);
		for (const site of warning.sites ?? []) lines.push(`  - \`${site.module}:${site.line}\``);
	}
	return lines.join("\n");
}

/**
 * Literal hits, grouped by file.
 *
 * Two truncations are reported separately because they mean different things: a full page means
 * more matched than were shown, while an incomplete scan means the search itself stopped early and
 * matches beyond it were never looked at.
 */
/**
 * The sentence a stopped scan owes its caller.
 *
 * Needed most where it is easiest to forget: an empty result. "Nothing matched" and "nothing
 * matched in the part I read" are different answers, and only one of them is an absence.
 */
function incompleteNote(scanIncomplete: boolean | undefined): string {
	return scanIncomplete
		? "\n\n> The scan stopped before the end of the index, so matches beyond it were never looked at."
		: "";
}

export function renderComments(result: CommentsResult): string {
	if (result.total === 0) {
		return `# Comments\n\nNo comment matched.\n\n> Searches normalized prose, so markers and line wrapping are not matched.${incompleteNote(result.scanIncomplete)}`;
	}

	const byModule = new Map<string, string[]>();
	for (const comment of result.comments) {
		const rows = byModule.get(comment.module) ?? [];
		// The anchor is the hop from prose back to structure, which is the whole reason a comment is
		// a fact rather than a grep hit.
		const about =
			comment.anchor === null
				? `${comment.form} (module)`
				: `${comment.form} \`${comment.anchor.name}\` (${comment.anchor.kind})`;
		rows.push(`- Line ${comment.range.start.line + 1}: ${about}\n  \`${comment.factId}\`\n${indent(comment.raw)}`);
		byModule.set(comment.module, rows);
	}

	let body = renderGroupedModules(`${result.total} comment${result.total === 1 ? "" : "s"}`, byModule);
	if (result.truncated) {
		const more = result.total - result.comments.length;
		body += `\n\n> ${more} more comment${more === 1 ? "" : "s"} not shown. Raise \`limit\`.`;
	}
	return body + incompleteNote(result.scanIncomplete);
}

export function renderDocs(result: DocsResult): string {
	if (result.total === 0) {
		return `# Documentation\n\nNo prose matched.\n\n> Searches normalized prose, so line wrapping is not matched.${incompleteNote(result.scanIncomplete)}`;
	}

	const byModule = new Map<string, string[]>();
	for (const region of result.docs) {
		const rows = byModule.get(region.module) ?? [];
		// The heading path is the hop from prose back to structure, and the whole reason this answers
		// differently from a comment search.
		const under = region.headingPath.length === 0 ? "(no heading)" : region.headingPath.join(" > ");
		const where = region.fenced ? `${under}  [in a code block]` : under;
		rows.push(`- Line ${region.range.start.line + 1}: ${where}\n  \`${region.factId}\`\n${indent(region.raw)}`);
		byModule.set(region.module, rows);
	}

	let body = renderGroupedModules(`${result.total} region${result.total === 1 ? "" : "s"}`, byModule);
	if (result.truncated) {
		const more = result.total - result.docs.length;
		body += `\n\n> ${more} more region${more === 1 ? "" : "s"} not shown. Raise \`limit\`.`;
	}
	return body + incompleteNote(result.scanIncomplete);
}

/** Quoted so a comment's own markers cannot be read as this document's markup. */
function indent(raw: string): string {
	return raw
		.split("\n")
		.map((line) => `      ${line}`)
		.join("\n");
}

export function renderLiterals(result: LiteralsResult): string {
	if (result.total === 0) {
		return `# Literals\n\nNo literal matched.\n\n> Searches decoded values, not source text.${incompleteNote(result.scanIncomplete)}`;
	}

	const byModule = new Map<string, string[]>();
	for (const literal of result.literals) {
		const rows = byModule.get(literal.module) ?? [];
		const shown = literal.value.length > 60 ? `${literal.value.slice(0, 60)}...` : literal.value;
		// The containing declaration is the hop from text to structure, and it matters most where
		// names are mangled: the literal is then the only readable thing pointing at its symbol. The
		// module prefix is dropped because the row already sits under its module header.
		const container =
			literal.containerId === null ? "" : `  in \`${literal.containerId.split(" ").slice(3).join(" ")}\``;
		rows.push(`- Line ${literal.range.start.line + 1}: **${literal.kind}** ${JSON.stringify(shown)}${container}`);
		byModule.set(literal.module, rows);
	}

	let body = renderGroupedModules(`${result.total} literal${result.total === 1 ? "" : "s"}`, byModule);
	if (result.truncated) {
		const more = result.total - result.literals.length;
		body += `\n\n> ${more} more literal${more === 1 ? "" : "s"} not shown. Raise \`limit\`.`;
	}
	return body + incompleteNote(result.scanIncomplete);
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
		return `# Co-change\n\nNothing has changed alongside \`${result.module}\` in the last ${result.commits} commits.`;
	}

	const lines = [
		`# Changed alongside \`${result.module}\``,
		"",
		"| Module | Together | Share |",
		"| --- | ---: | ---: |",
	];
	for (const partner of result.partners) {
		const share = Math.round((partner.together / Math.max(partner.outOf, 1)) * 100);
		lines.push(`| \`${partner.module}\` | ${partner.together} / ${partner.outOf} | ${share}% |`);
	}

	if (result.total > result.partners.length)
		lines.push("", `> ${result.total - result.partners.length} more partners not shown.`);
	lines.push("", `Read from ${result.commits} commits.`);
	// Named rather than silent: a sweep touching hundreds of files pairs every one of them with
	// every other, so dropping those is what keeps the signal meaningful, and a reader deserves to
	// know a filter ran at all.
	if (result.skippedWideCommits > 0) {
		lines.push(
			"",
			`> ${result.skippedWideCommits} commits touching over ${result.widthLimit} files were ignored as sweeps.`,
		);
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
	if (result.commits === 0) return `# \`${result.module}\`\n\nNo commits in the history window.`;

	const ago = (at: number) => {
		const days = Math.round((Date.now() / 1000 - at) / 86_400);
		if (days === 0) return "today";
		return `${days} day${days === 1 ? "" : "s"} ago`;
	};

	const commits = `${result.commits} commit${result.commits === 1 ? "" : "s"}`;
	const lines = [
		`# \`${result.module}\``,
		"",
		"## History",
		"",
		`- Commits: ${commits}`,
		`- Lines: +${result.linesAdded} / -${result.linesDeleted}`,
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
		lines.push("", "## Recent commits", "", "| When | Commit | Lines | Subject |", "| --- | --- | ---: | --- |");
		for (const commit of result.recent) {
			const subject = commit.subject.replaceAll("|", "\\|");
			lines.push(
				`| ${ago(commit.at)} | \`${commit.hash.slice(0, 7)}\` | +${commit.added} / -${commit.deleted} | ${subject} |`,
			);
		}
		if (result.commits > result.recent.length) {
			lines.push("", `> ${result.commits - result.recent.length} older commits not shown.`);
		}
	}
	return lines.join("\n");
}

function questionTitle(question: string): string {
	return question.slice(0, 1).toUpperCase() + question.slice(1);
}

/** Recorded knowledge, or a short invitation to write it. */
export function renderKnowledge(recalled: RecalledAnswer | null, question = "knowledge"): string {
	if (recalled === null)
		return `## ${questionTitle(question)}\n\nNo answer recorded. Call \`symbol_facts\` for the current supporting facts.`;

	const lines = [
		`## ${questionTitle(recalled.answer.question)}`,
		"",
		recalled.answer.prose,
		"",
		`\`${recalled.answer.factId}\``,
	];
	if (recalled.answer.thin) lines.push("", "**THIN:** Only the declaration was cited.");
	const status: string[] = [];
	if (recalled.answer.doubt !== undefined) {
		const by = recalled.answer.doubt.by === undefined ? "" : ` (${recalled.answer.doubt.by})`;
		lines.push(
			"",
			"#### Doubt",
			"",
			`${recalled.answer.doubt.reason}${by}`,
			"",
			`\`${recalled.answer.doubt.factId}\``,
			"",
			"Clear with `record_answer` or `reaffirm_answer`, citing this doubt ID as `resolvesDoubt`.",
		);
	}
	if (recalled.stale.length > 0) {
		status.push(
			`**STALE:** ${recalled.stale.length} cited fact${recalled.stale.length === 1 ? "" : "s"} changed. Re-check \`symbol_facts\`, then call \`reaffirm_answer\` or \`record_answer\`.`,
		);
	}
	if (recalled.inheritedStale.length > 0) {
		status.push(
			`**SHAKY:** Leans on ${recalled.inheritedStale.length} answer${recalled.inheritedStale.length === 1 ? "" : "s"} whose supporting facts changed. Re-affirm those first.`,
		);
	}
	if (recalled.doubtedUpstream.length > 0) {
		status.push(
			`**SHAKY:** Leans on ${recalled.doubtedUpstream.length} answer${recalled.doubtedUpstream.length === 1 ? "" : "s"} someone has doubted. Address those first.`,
		);
	}
	if (status.length > 0) lines.push("", "### Status", "", status.join("\n"));
	return lines.join("\n");
}

export function renderRecordOutcome(outcome: RecordOutcome): string {
	if (outcome.recorded) {
		const carried = outcome.doubtCarried === undefined ? undefined : outcome.doubtCarried;
		const lines = ["# Answer recorded", "", `\`${outcome.answer.factId}\``];
		if (outcome.answer.thin) lines.push("", "**THIN:** Only the declaration was cited.");
		if (carried !== undefined) {
			lines.push(
				"",
				"## Doubt",
				"",
				carried.reason,
				"",
				`\`${carried.factId}\``,
				"",
				"Cite this ID as `resolvesDoubt` to clear the doubt.",
			);
		}
		return lines.join("\n");
	}
	const lines = ["# Answer not recorded", "", outcome.reason];
	if ((outcome.unresolved ?? []).length > 0) {
		lines.push("", "## Unresolved fact IDs", "");
		for (const factId of outcome.unresolved ?? []) lines.push(`- \`${factId}\``);
	}
	if (outcome.uncovered !== undefined && outcome.uncovered.length > 0) {
		lines.push("", "## Uncovered fact IDs", "", "Fact IDs from the existing answer:");
		for (const factId of outcome.uncovered) lines.push(`- \`${factId}\``);
	}
	return lines.join("\n");
}

/** What declaring a doubt did, question by question, with the id the eventual clearer must cite. */
export function renderInvalidateOutcome(outcome: InvalidateOutcome): string {
	if (outcome.refused !== undefined) return `# Doubt not recorded\n\n${outcome.refused}.`;

	const title = outcome.doubted.length > 0 ? "# Doubt recorded" : "# Gap recorded";
	const lines: string[] = [title, "", `**Symbol:** \`${outcome.symbolId}\``];
	for (const entry of outcome.doubted) {
		const by = entry.doubt.by === undefined ? "" : ` (${entry.doubt.by})`;
		lines.push(
			"",
			`## ${questionTitle(entry.question)}`,
			"",
			`${entry.doubt.reason}${by}`,
			"",
			`\`${entry.doubt.factId}\``,
			"",
			"Clear with `record_answer` or `reaffirm_answer`, citing this doubt ID as `resolvesDoubt`.",
		);
	}
	if (outcome.noAnswer.length > 0) {
		lines.push(
			"",
			"## No answer",
			"",
			`No ${outcome.noAnswer.join(", ")} answer exists. The request was added to \`knowledge_gaps\`.`,
		);
	}
	return lines.join("\n");
}

export function renderKnowledgeGaps(gaps: KnowledgeGaps, root: string | undefined): string {
	const where = root === undefined ? "this workspace" : root;
	if (gaps.total === 0) {
		const lines = [`# Knowledge gaps`, "", `No ${gaps.question} gaps under \`${where}\`.`];
		if (gaps.external > 0)
			lines.push("", `> ${gaps.external} dependencies are outside the index and cannot be answered.`);
		return lines.join("\n");
	}

	const lines: string[] = ["# Knowledge gaps", ""];
	const scope =
		gaps.seeded === true
			? `the most-referenced unanswered ${gaps.question} answers`
			: root === undefined
				? `${gaps.question} gaps in this workspace, ranked by demand`
				: `${gaps.question} gaps under ${where}, leaves first`;
	lines.push(`${gaps.total} ${scope}.`);
	if (gaps.seeded === true) {
		lines.push("", "> No demand is recorded yet, so these are candidates rather than measured gaps.");
	}

	lines.push("", "| Symbol | Module | State | Asked | Fan-in |", "| --- | --- | --- | ---: | ---: |");
	for (const row of gaps.rows) {
		const tail = row.symbolId.split(" ").slice(3).join(" ");
		const symbol = row.name === undefined ? `\`${tail}\`` : `**${row.kind ?? "symbol"}** \`${tail}\``;
		const state = row.why === "stale" ? "**STALE**" : row.why === "doubted" ? "**DOUBTED**" : "MISSING";
		const question = row.question === gaps.question ? "" : ` (${row.question})`;
		lines.push(
			`| ${symbol}${question} | \`${row.module ?? "unknown"}\` | ${state} | ${row.askCount || "-"} | ${row.fanIn} |`,
		);
	}
	if (gaps.total > gaps.rows.length) lines.push("", `> ${gaps.total - gaps.rows.length} more gaps not shown.`);
	const first = gaps.rows[0];
	if (first !== undefined) lines.push("", `**Full ID example:** \`${first.symbolId}\``);
	if (gaps.truncated) lines.push("", "> The dependency walk hit its cap, so the total above is a floor.");
	if (gaps.staleScanSkipped === true) {
		lines.push("", "> The index skipped its full staleness scan. Stale answers surface when recalled.");
	}
	if (gaps.external > 0) {
		lines.push("", `> ${gaps.external} dependencies are outside the index: nothing citable exists for them.`);
	}

	lines.push("", "## Next step", "", "For each row, call `symbol_facts`.");
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
		return `# Symbol history\n\nNo commit message in the last ${result.commits} commits names \`${result.name}\`.`;
	}

	const lines = [
		`# Commits naming \`${result.name}\``,
		"",
		"## Matches",
		"",
		"| Commit | When | Files | Subject |",
		"| --- | --- | ---: | --- |",
	];
	for (const mention of result.mentions) {
		const days = Math.round((Date.now() / 1000 - mention.at) / 86_400);
		const when = days === 0 ? "today" : `${days}d ago`;
		const files = `${mention.files} file${mention.files === 1 ? "" : "s"}`;
		lines.push(`| \`${mention.hash.slice(0, 7)}\` | ${when} | ${files} | ${mention.subject} |`);
	}
	lines.push("", `Read from ${result.commits} commits.`);
	return lines.join("\n");
}

/** The facts behind an answer, grouped by kind. */
export function renderFacts(result: {
	symbolId: string;
	facts: Array<{
		factId: string;
		kind: string;
		module: string;
		summary: string;
	}>;
	truncated: string[];
}): string {
	const lines = [`# Facts about \`${result.symbolId}\``];
	const factsByKind = new Map<string, typeof result.facts>();
	for (const fact of result.facts) {
		const group = factsByKind.get(fact.kind) ?? [];
		group.push(fact);
		factsByKind.set(fact.kind, group);
	}

	const answers = factsByKind.get("answer") ?? [];
	const descriptions = answers.filter((fact) => fact.summary.startsWith("describe: "));
	if (descriptions.length > 0) {
		lines.push("", "## Description", "");
		for (const fact of descriptions) lines.push(fact.summary.slice("describe: ".length), "", `\`${fact.factId}\``);
	}

	// Keyed by FactKind, so a new kind fails the type check here rather than going unrendered.
	// Null means the kind is not a grouped citation: answers render above and below, doubts never.
	const headings: Record<FactKind, string | null> = {
		declaration: "Declaration",
		reference: "References",
		import: "Imports",
		literal: "Literals",
		comment: "Comments",
		doc: "Documentation",
		answer: null,
		doubt: null,
	};
	for (const kind of FACT_KINDS) {
		const heading = headings[kind];
		const group = factsByKind.get(kind) ?? [];
		if (heading === null || group.length === 0) continue;
		lines.push("", `## ${heading}`, "");
		for (const fact of group) lines.push(`- ${fact.summary}`, `  \`${fact.factId}\``);
	}

	const otherAnswers = answers.filter((fact) => !fact.summary.startsWith("describe: "));
	if (otherAnswers.length > 0) {
		lines.push("", "## Recorded answers", "");
		for (const fact of otherAnswers) {
			const separator = fact.summary.indexOf(": ");
			const question = separator < 0 ? "Answer" : questionTitle(fact.summary.slice(0, separator));
			const prose = separator < 0 ? fact.summary : fact.summary.slice(separator + 2);
			lines.push(`### ${question}`, "", prose, "", `\`${fact.factId}\``);
		}
	}

	if (result.truncated.length > 0) {
		lines.push("", `> More ${result.truncated.join(" and ")} facts are not shown. Raise \`limit\`.`);
	}
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
	/** The symbol total split by kind, so one number cannot stand for two things. */
	symbolsByKind?: Record<string, number>;
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
	scan?: { tracked: number; claimed: number; unclaimed: number; generated: number; denied: number };
	parseFailures?: Array<{ module: string; reason: string }>;
	largest: Array<{ module: string; symbols: number }>;
	knowledge?: { answers: number; stale?: number; doubted?: number };
}): string {
	const lines = ["# Workspace overview", "", "## Workspace", "", `\`${result.scope}\``, "", "## Index", ""];

	// Show progress for counted states.
	const counted = ["warming", "indexing", "upgrading"].includes(result.index.state);
	const stateNote =
		result.index.state === "unstarted"
			? "serving stored facts; nothing rescanned this run"
			: `${result.index.state}${counted ? ` (${result.index.done} of ${result.index.total})` : ""}`;
	lines.push(`- State: ${stateNote}`);

	const outline = result.index.outlineFiles ?? 0;
	if (outline > 0) {
		lines.push(`- Depth: ${result.index.fullFiles ?? 0} modules at final depth, ${outline} outline only`);
		lines.push("  - reference and literal counts are lower bounds until the upgrade finishes");
	}

	const failures = result.index.failures ?? 0;
	if (failures > 0) {
		lines.push(`- Files failed to parse: ${failures}; any facts indexed before the failure were kept`);
	}

	// Scan parts sum to total.
	if (result.scan !== undefined) {
		const { tracked, claimed, unclaimed, generated, denied } = result.scan;
		lines.push(`- Last scan: ${tracked} files seen`);
		lines.push(`  - ${claimed} claimed by providers`);
		lines.push(`  - ${unclaimed} of no provider's language`);
		if (generated > 0) lines.push(`  - ${generated} generated`);
		if (denied > 0) lines.push(`  - ${denied} outside scope`);
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

		lines.push("", "## Failed to parse", "");
		for (const [reason, modules] of ranked) {
			lines.push(`- ${reason}${modules.length === 1 ? "" : ` (${modules.length} files)`}`);
			for (const module of modules) lines.push(`  - \`${module}\``);
		}
	}

	lines.push(
		"",
		"## Counts",
		"",
		"| Files | Symbols | References | Imports | Literals | Modules |",
		"| ---: | ---: | ---: | ---: | ---: | ---: |",
		`| ${result.files} | ${result.symbols} | ${result.references} | ${result.imports} | ${result.literals} | ${result.modules} |`,
	);

	// Named where the number is, because "symbols" reads as callable code and a section is not.
	// Headings only: a document's frontmatter keys are `property`, which code uses too, so they are
	// counted here as code and cannot be separated by kind.
	const headings = result.symbolsByKind?.["heading"] ?? 0;
	if (headings > 0) {
		lines.push("", `> ${headings} of those symbols are document sections rather than code.`);
	}

	// Self-contained: the depth line is absent once nothing is outline, so pointing at it would
	// reference a line that is not on the page.
	const external = (result.index.stored ?? result.files) - result.files;
	if (external > 0) {
		lines.push(
			"",
			`> Counts cover workspace files. The index holds ${external} external surface module${external === 1 ? "" : "s"} besides, ${result.index.stored} in total.`,
		);
	}

	if (result.knowledge !== undefined) {
		if (result.knowledge.answers === 0) {
			lines.push("", "## Knowledge", "", "None recorded yet. `knowledge_gaps` lists what is worth writing.");
		} else {
			// Absent means staleness was skipped.
			const stale =
				result.knowledge.stale === undefined
					? ", staleness not scanned at this size"
					: result.knowledge.stale > 0
						? `, ${result.knowledge.stale} stale`
						: "";
			const doubted =
				result.knowledge.doubted === undefined || result.knowledge.doubted === 0
					? ""
					: `, ${result.knowledge.doubted} doubted`;
			lines.push(
				"",
				"## Knowledge",
				"",
				`${result.knowledge.answers} recorded answer${result.knowledge.answers === 1 ? "" : "s"}${stale}${doubted}. \`knowledge_gaps\` lists what is missing.`,
			);
		}
	}

	lines.push("", "## Largest modules", "");
	for (const module of result.largest) lines.push(`- \`${module.module}\`: ${module.symbols} symbols`);
	return lines.join("\n");
}

/** Import sites, grouped by the file doing the importing. */
export function renderImports(result: {
	imports: Array<{
		module: string;
		specifier: string;
		name?: string;
		reExport: boolean;
	}>;
	total: number;
	truncated: boolean;
	scanIncomplete?: boolean;
}): string {
	if (result.total === 0) {
		return result.scanIncomplete
			? "# Imports\n\nNo imports matched in the scanned portion.\n\n> The import scan stopped before the end of the index."
			: "# Imports\n\nNo imports matched.";
	}

	const byModule = new Map<string, Set<string>>();
	for (const statement of result.imports) {
		const specifiers = byModule.get(statement.module) ?? new Set();
		// The name is shown when there is one. Its absence means the statement binds the module
		// rather than an export, which is a real import and not a missing field.
		const named = statement.name === undefined ? "" : `  { ${statement.name} }`;
		specifiers.add(`${statement.specifier}${named}${statement.reExport ? "  (re-export)" : ""}`);
		byModule.set(statement.module, specifiers);
	}

	const rows = new Map<string, string[]>();
	for (const [module, specifiers] of byModule) {
		rows.set(
			module,
			Array.from(specifiers, (specifier) => `- \`${specifier}\``),
		);
	}
	const body = renderGroupedModules(
		`${byModule.size} file${byModule.size === 1 ? "" : "s"}, ${result.total} import entries`,
		rows,
	);
	let rendered = result.truncated ? `${body}\n\n> More imports not shown. Raise \`limit\`.` : body;
	if (result.scanIncomplete) rendered += "\n\n> The import scan stopped before the end of the index.";
	return rendered;
}

/** The most-referenced symbols, which is where reading pays off most. */
export function renderMostReferenced(
	rows: Array<{
		symbolId: string;
		count: number;
		declaration: SymbolSummary | null;
	}>,
): string {
	if (rows.length === 0) return "# Most referenced\n\nNothing is referenced yet.";

	const lines = ["# Most referenced", "", "| Symbol | References |", "| --- | ---: |"];
	for (const row of rows) {
		const where = row.declaration
			? `${line(row.declaration)} in \`${row.declaration.module}\``
			: `\`${row.symbolId}\``;
		lines.push(`| ${where} | ${row.count} |`);
	}
	lines.push("", "> Counts are bounded by what binding resolved.");
	return lines.join("\n");
}

/** Symbols found by a name search, grouped by file. Where browsing starts. */
export function renderSymbolSearch(result: {
	text: string | undefined;
	regex?: string;
	symbols: SymbolSummary[];
	total: number;
	truncated: boolean;
}): string {
	const query = result.regex === undefined ? JSON.stringify(result.text) : `regex ${JSON.stringify(result.regex)}`;
	if (result.total === 0) return `# Symbol search\n\nNo symbol name matches ${query}.`;

	const byModule = new Map<string, string[]>();
	for (const symbol of result.symbols) {
		const rows = byModule.get(symbol.module) ?? [];
		// The id rides along because it is the address every other tool takes. Without it a search
		// hit has to be looked up again before it can be read, replaced or renamed.
		rows.push(symbolBullet(symbol), `  ID: \`${symbol.symbolId}\``);
		byModule.set(symbol.module, rows);
	}

	const body = renderGroupedModules(
		`${result.total} symbol${result.total === 1 ? "" : "s"} matching ${query}`,
		byModule,
	);
	return result.truncated
		? `${body}\n\n> More symbols not shown. Raise \`limit\` or narrow by kind or module.`
		: body;
}

/** Everything one file declares, nested by container. The "open the file" answer. */
export function renderOutline(module: string, declarations: Array<SymbolSummary & { containerId?: string }>): string {
	if (declarations.length === 0) return `# \`${module}\`\n\nNo indexed declarations.`;

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

	const lines = [`# \`${module}\``, "", `## ${declarations.length} declarations`, ""];
	const walk = (nodes: typeof declarations, depth: number) => {
		for (const node of nodes) {
			lines.push(`${"  ".repeat(depth)}- ${line(node)}`);
			walk(children.get(node.symbolId) ?? [], depth + 1);
		}
	};
	walk(roots, 0);
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
		`# \`${source.name}\``,
		"",
		`${source.kind} in \`${source.module}\`, lines ${start.line + 1} to ${end.line + 1}.`,
		"",
		"```",
		source.text,
		"```",
	].join("\n");
}

/** One renderer for issues, used by status and by a refused commit so they cannot drift apart. */
export function renderIssues(issues: RefactorIssue[]): string[] {
	if (issues.length === 0) return [];

	const lines = ["## Issues", ""];
	for (const issue of issues) {
		const where = issue.module === undefined ? "" : ` (\`${issue.module}\`${issue.line ? `:${issue.line}` : ""})`;
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
export function renderRefactorStart(outcome: { started: boolean; id: string; reason?: string }): string {
	if (!outcome.started) {
		return [
			"# Refactor already open",
			"",
			`Transaction \`${outcome.id}\` is already open on this workspace. One transaction at a time.`,
			"",
			"Call `refactor_status` to see it, then continue it, `refactor_commit` it, or `refactor_revert` it.",
		].join("\n");
	}

	return [
		`# Refactor \`${outcome.id}\` open`,
		"",
		"## Before you edit anything by hand",
		"",
		"Call `refactor_track` on the file FIRST. Only tracked files and files a refactor tool touched",
		"can be put back. An untracked edit is invisible to undo and survives revert.",
		"",
		"## How it unwinds",
		"",
		"- `refactor_undo` removes the newest step. It refuses if that step's files changed since,",
		"  rather than overwriting whatever changed them.",
		"- `refactor_revert` returns every tracked file to how this transaction found it, discarding",
		"  manual edits made since.",
		"- `refactor_commit` keeps what is on disk and ends the transaction. Nothing is undoable after.",
		"  It refuses while issues are outstanding; pass `force` to accept them deliberately.",
		"",
		"## While it is open",
		"",
		"Re-fetch addresses after every step. Ranges move, so a symbolId or range read before a step",
		"may not describe the same text after it.",
		"",
		"Any session may operate this transaction. There is no owner token, so `refactor_status` is",
		"how you find out what someone else already did.",
	].join("\n");
}

export function renderRefactorStatus(status: TransactionStatus): string {
	if (!status.open) {
		return "# Refactor status\n\nNo transaction is open. Call `refactor_start` to begin one.";
	}

	const lines = [`# Refactor \`${status.id}\``, ""];

	if (status.steps.length === 0) lines.push("No steps yet.");
	else {
		lines.push("## Steps", "");
		for (const step of status.steps) {
			const files = step.modules.length === 0 ? "no files" : step.modules.map((m) => `\`${m}\``).join(", ");
			lines.push(`${step.stepNo}. **${step.kind}** (${step.phase}): ${files}`);
		}
	}

	if (status.tracked.length > 0) {
		lines.push("", "## Tracked", "", status.tracked.map((module) => `- \`${module}\``).join("\n"));
	}

	const issues = renderIssues(status.issues);
	if (issues.length > 0) lines.push("", ...issues);
	else if (status.steps.length > 0) lines.push("", "No outstanding issues. `refactor_commit` would succeed.");

	return lines.join("\n");
}

/**
 * A replacement, with what it broke.
 *
 * A step with issues is still applied and still says so. Refusing would leave the caller with no
 * way to make a change whose fallout it intends to fix in the next step.
 */
export function renderReplaceOutcome(outcome: {
	replaced: boolean;
	module?: string;
	issues: RefactorIssue[];
	reason?: string;
}): string {
	if (!outcome.replaced) {
		return `# Not replaced\n\n${outcome.reason ?? "the replacement could not be applied"}`;
	}

	const lines = [`# Replaced in \`${outcome.module}\``, ""];
	if (outcome.issues.length === 0) {
		lines.push("Nothing else stopped resolving. `refactor_commit` would succeed.");
		return lines.join("\n");
	}

	lines.push(
		`Applied, but it introduced ${outcome.issues.length} issue${outcome.issues.length === 1 ? "" : "s"}.`,
		"Fix them in a later step, `refactor_undo` this one, or commit with force.",
		"",
		...renderIssues(outcome.issues),
	);
	return lines.join("\n");
}

/** An insert, with what it warned about. `alreadyInserted` is the retry answer, not a failure. */
export function renderInsertOutcome(outcome: {
	inserted: boolean;
	alreadyInserted?: boolean;
	module?: string;
	symbolIds?: string[];
	issues: RefactorIssue[];
	reason?: string;
}): string {
	if (outcome.alreadyInserted === true) {
		return `# Already inserted\n\nThe exact text already sits at that spot in \`${outcome.module}\`; nothing was written.`;
	}
	if (!outcome.inserted) {
		return `# Not inserted\n\n${outcome.reason ?? "the insert could not be applied"}`;
	}

	const lines = [`# Inserted into \`${outcome.module}\``, ""];
	for (const symbolId of outcome.symbolIds ?? []) lines.push(`- ID: \`${symbolId}\``);
	if ((outcome.symbolIds ?? []).length > 0) lines.push("");

	if (outcome.issues.length === 0) {
		lines.push("Everything the new text names resolves. `refactor_commit` would succeed.");
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
export function renderMoveOutcome(
	toModule: string,
	outcome: {
		moved: boolean;
		modules?: string[];
		migrated?: { answers: number; gaps: number };
		issues: RefactorIssue[];
		reason?: string;
	},
): string {
	if (!outcome.moved) {
		const lines = ["# Not moved", "", outcome.reason ?? "the move could not be carried out"];
		if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
		return lines.join("\n");
	}

	const modules = outcome.modules ?? [];
	const lines = [
		`# Moved to \`${toModule}\``,
		"",
		`${modules.length} file${modules.length === 1 ? "" : "s"} written: ${modules.map((m) => `\`${m}\``).join(", ")}`,
	];
	if (outcome.migrated && outcome.migrated.answers + outcome.migrated.gaps > 0) {
		lines.push("", `Carried across ${outcome.migrated.answers} answer(s) and ${outcome.migrated.gaps} gap(s).`);
	}
	if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
	return lines.join("\n");
}

/** A rename step, including what it carried across and what the index could not promise. */
export function renderRenameStep(
	newName: string,
	outcome: {
		renamed: boolean;
		modules?: string[];
		migrated?: { answers: number; gaps: number };
		issues: RefactorIssue[];
		reason?: string;
	},
): string {
	if (!outcome.renamed) {
		const lines = ["# Not renamed", "", outcome.reason ?? "the rename could not be carried out"];
		if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
		return lines.join("\n");
	}

	const modules = outcome.modules ?? [];
	const lines = [
		`# Renamed to ${newName}`,
		"",
		`${modules.length} file${modules.length === 1 ? "" : "s"} reindexed: ${modules.map((m) => `\`${m}\``).join(", ")}`,
	];

	// Worth saying: the prose written about a symbol is the one thing a re-index cannot rebuild.
	if (outcome.migrated && outcome.migrated.answers + outcome.migrated.gaps > 0) {
		lines.push("", `Carried across ${outcome.migrated.answers} answer(s) and ${outcome.migrated.gaps} gap(s).`);
	}

	if (outcome.issues.length > 0) lines.push("", ...renderIssues(outcome.issues));
	return lines.join("\n");
}

export function renderRefactorCommit(outcome: {
	committed: boolean;
	issues: RefactorIssue[];
	reason?: string;
}): string {
	if (outcome.committed) {
		const note = outcome.issues.length > 0 ? ` ${outcome.issues.length} issue(s) were accepted by force.` : "";
		return `# Committed\n\nThe transaction is closed and nothing is undoable now.${note}`;
	}

	return [
		"# Not committed",
		"",
		outcome.reason ?? "the transaction could not be committed",
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
	if (candidates.length === 0) return `# Symbol lookup\n\nNo symbol named \`${name}\` is indexed.`;
	if (candidates.length === 1) return "";

	// The id per row is the whole point: telling a caller to pass a symbolId while showing none left
	// eight identical minified methods with no way to be told apart short of guessing ids blind.
	const lines = [`# ${candidates.length} symbols named \`${name}\``];
	for (const candidate of candidates) {
		lines.push("", `## \`${candidate.module}\``, "", `- ${line(candidate)}`, `  ID: \`${candidate.symbolId}\``);
	}
	lines.push("", "Pass one of the IDs above to pick one.");
	return lines.join("\n");
}
