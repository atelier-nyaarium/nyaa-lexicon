// Turning answers into what an agent reads.
//
// Pure, because output formatting deserves direct tests.

import {
	type DescribeResult,
	type GraphSummary,
	INLINE_GAP_THRESHOLD,
	type InvalidateOutcome,
	type KnowledgeGaps,
	type LiteralsResult,
	type RecalledAnswer,
	type RecordOutcome,
	type ReferencesResult,
	type RenameOutcome,
	type RenamePlan,
	type SymbolSummary,
} from "@nyaa-lexicon/core";
import type { TypeInfo } from "@nyaa-lexicon/protocol";

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

function renderGroupedModules(title: string, groups: Iterable<readonly [string, readonly string[]]>): string {
	const sections = [`# ${title}`];
	for (const [module, rows] of groups) sections.push(`## \`${module}\`\n\n${rows.join("\n")}`);
	return sections.join("\n\n");
}

/** One symbol as its complete surface. */
export function renderDescribe(result: DescribeResult): string {
	// The line span makes "read the body" a range read of exactly those lines, never a file read.
	const location =
		result.symbol.lines === undefined
			? `\`${result.symbol.module}\``
			: `\`${result.symbol.module}:${result.symbol.lines.start + 1}-${result.symbol.lines.end + 1}\``;
	const lines = [
		`# ${result.symbol.kind} ${result.symbol.name}`,
		"",
		"```ts",
		result.symbol.signature ?? `${result.symbol.kind} ${result.symbol.name}`,
		"```",
		"",
		`**Module:** ${location}`,
		`**ID:** \`${result.symbol.symbolId}\``,
	];

	if (result.symbol.docComment) {
		lines.push("", "## Documentation", "", result.symbol.docComment.split("\n")[0] ?? result.symbol.docComment);
	}

	if (result.members.length > 0) {
		lines.push("", "## Members", "");
		for (const member of result.members) lines.push(symbolBullet(member));
	}

	// A count rather than the list: the caller decides whether that is worth its own call.
	lines.push("", "## Usage", "", `Used in ${result.referenceCount} place${result.referenceCount === 1 ? "" : "s"}.`);
	if (result.referenceCount > 0) lines.push("Call `find_references` for the list.");
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
 * Blockers are printed before the file list and warnings after it. A caller that stops reading at
 * the first line still learns it cannot proceed, and one that reads to the end still learns where
 * the answer runs out.
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
export function renderLiterals(result: LiteralsResult): string {
	if (result.total === 0) {
		return "# Literals\n\nNo literal matched.\n\n> Searches decoded values, not source text.";
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
	if (result.scanIncomplete) {
		body += "\n\n> The scan stopped before the end of the index, so matches beyond it were not looked at.";
	}
	return body;
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

/**
 * Both directions of a type hierarchy at once.
 *
 * Unresolved bases get their own line rather than being dropped, so a class extending an engine or
 * library type does not read as extending nothing.
 */
export function renderHierarchy(result: {
	symbolId: string;
	supertypes: Array<{ name: string; kind: string; module: string }>;
	subtypes: Array<{ name: string; kind: string; module: string }>;
	ancestors: Array<{ name: string; module: string }>;
	unboundSupertypes: string[];
}): string {
	const lines: string[] = ["# Type hierarchy", "", `**Symbol:** \`${result.symbolId}\``];
	const list = (label: string, entries: Array<{ name: string; kind: string; module: string }>) => {
		if (entries.length === 0) return;
		lines.push("", `## ${label}`, "");
		for (const entry of entries) lines.push(`- **${entry.kind}** \`${entry.name}\`  \`${entry.module}\``);
	};

	list("Extends", result.supertypes);
	list("Extended by", result.subtypes);

	// Only when it adds something the direct list did not already say.
	const indirect = result.ancestors.filter(
		(ancestor) => !result.supertypes.some((direct) => direct.name === ancestor.name),
	);
	if (indirect.length > 0) {
		lines.push("", "## Further up", "", `- ${indirect.map((ancestor) => `\`${ancestor.name}\``).join(" <- ")}`);
	}

	if (
		result.supertypes.length === 0 &&
		result.subtypes.length === 0 &&
		indirect.length === 0 &&
		result.unboundSupertypes.length === 0
	) {
		return `# Type hierarchy\n\n\`${result.symbolId}\` has no supertypes or subtypes in the index.`;
	}
	if (result.unboundSupertypes.length > 0) {
		lines.push("", "## Outside the index", "");
		for (const name of result.unboundSupertypes) lines.push(`- \`${name}\``);
	}
	return lines.join("\n");
}

/** Churn and age for one file. Age is omitted when the window ran out rather than shown as a floor. */
export function renderFileHistory(result: {
	module: string;
	commits: number;
	linesAdded: number;
	linesDeleted: number;
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
	return lines.join("\n");
}

/** Recorded knowledge, or a short invitation to write it. */
export function renderKnowledge(recalled: RecalledAnswer | null): string {
	if (recalled === null) {
		return "## Knowledge\n\nNone recorded. Call `record_answer` to save what you conclude.";
	}

	const grade = recalled.answer.thin ? " THIN" : "";
	const lines = ["## Knowledge", "", `### ${recalled.answer.question}${grade}`, "", recalled.answer.prose];
	if (recalled.answer.doubt !== undefined) {
		const by = recalled.answer.doubt.by === undefined ? "" : ` (${recalled.answer.doubt.by})`;
		lines.push(
			"",
			"#### Doubt",
			"",
			`- ${recalled.answer.doubt.reason}${by}`,
			`- Clear with \`record_answer\` or \`reaffirm_answer\`, citing resolvesDoubt \`${recalled.answer.doubt.factId}\``,
		);
	}
	if (recalled.stale.length > 0) {
		lines.push(
			"",
			`- **STALE:** ${recalled.stale.length} cited fact${recalled.stale.length === 1 ? "" : "s"} changed since this was written. Re-check against \`symbol_facts\`, then call \`reaffirm_answer\` with current citations, or \`record_answer\` to rewrite.`,
		);
	}
	if (recalled.inheritedStale.length > 0) {
		lines.push(
			"",
			`- **SHAKY:** Leans on ${recalled.inheritedStale.length} answer${recalled.inheritedStale.length === 1 ? "" : "s"} whose own ground moved. Re-affirm those first.`,
		);
	}
	if (recalled.doubtedUpstream.length > 0) {
		lines.push(
			"",
			`- **SHAKY:** Leans on ${recalled.doubtedUpstream.length} answer${recalled.doubtedUpstream.length === 1 ? "" : "s"} someone has doubted. Recall those, read the doubt, and address it first.`,
		);
	}
	return lines.join("\n");
}

export function renderRecordOutcome(outcome: RecordOutcome): string {
	if (outcome.recorded) {
		// The grade goes to the WRITER at the moment of writing, which is the one moment a better
		// answer costs nothing extra: the facts are already in front of them.
		const thin = outcome.answer.thin
			? "Marked THIN: nothing cited reaches beyond the declaration, so this reads as a paraphrase of the signature. Citing a reference, a literal or a child answer would ground it in something a reader cannot already see."
			: undefined;
		// A carried doubt is stated to the one writer who can still address it, at the one moment the
		// context to address it is already loaded.
		const carried = outcome.doubtCarried === undefined ? undefined : outcome.doubtCarried;
		const lines = ["# Answer recorded", "", `**ID:** \`${outcome.answer.factId}\``];
		if (thin !== undefined) lines.push("", `> ${thin}`);
		if (carried !== undefined) {
			lines.push(
				"",
				"## Doubt carried forward",
				"",
				`- ${carried.reason}`,
				`- If your rewrite addresses it, record again citing resolvesDoubt \`${carried.factId}\``,
			);
		}
		return lines.join("\n");
	}
	const lines = ["# Answer not recorded", "", outcome.reason];
	if ((outcome.unresolved ?? []).length > 0) {
		lines.push("", "## Unresolved citations", "");
		for (const factId of outcome.unresolved ?? []) lines.push(`- \`${factId}\``);
	}
	if (outcome.uncovered !== undefined && outcome.uncovered.length > 0) {
		lines.push("", "## Uncovered citations", "", "The incumbent's still-live citations this write does not cover:");
		for (const factId of outcome.uncovered) lines.push(`- \`${factId}\``);
	}
	return lines.join("\n");
}

/** What declaring a doubt did, question by question, with the id the eventual clearer must cite. */
export function renderInvalidateOutcome(outcome: InvalidateOutcome): string {
	if (outcome.refused !== undefined) return `# Nothing doubted\n\n${outcome.refused}.`;

	const lines: string[] = ["# Answers doubted", "", `**Symbol:** \`${outcome.symbolId}\``];
	for (const entry of outcome.doubted) {
		lines.push(
			"",
			`## ${entry.question}`,
			"",
			"- Readers now see the doubt, and answers leaning on this one show **SHAKY**.",
			`- Clear by citing \`${entry.doubt.factId}\``,
		);
	}
	if (outcome.noAnswer.length > 0) {
		lines.push(
			"",
			"## No answer",
			"",
			`No ${outcome.noAnswer.join(", ")} answer exists to doubt; counted as gap demand instead.`,
		);
	}
	return lines.join("\n");
}

/**
 * The gap list, wearing one of two proses.
 *
 * Below the threshold the ask is imperative, because a working agent can close a short list without
 * losing its task. At or past it, the honest advice is a background agent, and the prose carries a
 * ready task description so accepting costs the user one sentence. The threshold is the seam
 * between "do it now" and "this is a project", and both proses say which side they are on.
 */
export function renderKnowledgeGaps(gaps: KnowledgeGaps, root: string | undefined): string {
	const where = root === undefined ? "this workspace" : root;
	if (gaps.total === 0) {
		const externals =
			gaps.external > 0 ? ` ${gaps.external} dependencies are outside the index and cannot be answered.` : "";
		return `# Knowledge gaps\n\nNo knowledge gaps under \`${where}\`.${externals}`;
	}

	const lines: string[] = [];
	const scope =
		gaps.seeded === true
			? "worth writing first, ranked by fan-in"
			: root === undefined
				? "in this workspace, by demand"
				: `under ${where}, leaves first`;
	// The question is named in the headline, because gaps are PER QUESTION: a symbol whose `relate`
	// was just written still legitimately appears in the `describe` list, and without the label that
	// reads as the filter failing rather than as a different question being open.
	lines.push(`# ${gaps.total} ${gaps.question} gap${gaps.total === 1 ? "" : "s"} ${scope}`);
	if (gaps.seeded === true) {
		lines.push(
			"",
			"> Nobody has asked anything yet, so these are the most-referenced unanswered symbols rather than measured demand.",
		);
	}

	for (const row of gaps.rows) {
		// The descriptor tail rather than the bare name, because in a minified module half the tree
		// is parameters named $ and v, and a row that cannot be turned back into a symbol_facts call
		// is a to-do list nobody can act on. The tail plus the module reconstructs the full id.
		const tail = row.symbolId.split(" ").slice(3).join(" ");
		const name =
			row.name === undefined ? `\`${row.symbolId}\`` : `**${row.kind}** \`${tail}\` in \`${row.module}\``;
		const asked = row.askCount > 0 ? `; asked ${row.askCount}x` : "";
		const mark = row.why === "stale" ? "; **STALE**" : row.why === "doubted" ? "; **DOUBTED**" : "";
		// The ledger and the health sweep span every question class, so a row for a different
		// question than the headline says which one, or it reads as the filter failing.
		const which = row.question === gaps.question ? "" : ` (${row.question})`;
		lines.push(`- ${name}${mark}${which}${asked}; fan-in ${row.fanIn}`);
	}
	if (gaps.total > gaps.rows.length) lines.push("", `> ${gaps.total - gaps.rows.length} more gaps not shown.`);
	// The reconstruction rule shown by example rather than described, so a row becomes a
	// symbol_facts call without anyone knowing the id grammar. The example came from the store, so
	// nothing here spells a scheme by hand, which the grammar residue test would rightly refuse.
	const first = gaps.rows[0];
	if (first !== undefined) lines.push("", `**Full ID example:** \`${first.symbolId}\``);
	if (gaps.truncated) lines.push("", "> The dependency walk hit its cap, so the total above is a floor.");
	if (gaps.staleScanSkipped === true) {
		lines.push(
			"",
			"> The knowledge base is too large to health-check every answer here: doubted ones are still listed, but an answer gone stale since anyone last asked will only surface on recall.",
		);
	}
	if (gaps.external > 0) {
		lines.push("", `> ${gaps.external} dependencies are outside the index: nothing citable exists for them.`);
	}

	if (gaps.total < INLINE_GAP_THRESHOLD) {
		// A subagent when one exists, because the loop's round trips otherwise sit in the asker's
		// context verbatim; the answers land in the store either way, which is where they are read.
		lines.push(
			"",
			"## Next step",
			"",
			"Close these in order, leaves first: `symbol_facts`, then `record_answer` citing those ids. A subagent can run the loop; the answers land in the store either way.",
		);
	} else {
		lines.push(
			"",
			"## Next step",
			"",
			`${gaps.total} is too many to absorb mid-task. With your user's agreement, hand one background agent this loop:`,
			"",
			`> Until \`knowledge_gaps\`${root === undefined ? "" : ` (root ${where})`} returns empty: take the first row, \`symbol_facts\`, then \`record_answer\` citing those ids. Leaves first, so later answers can cite earlier ones.`,
		);
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

/**
 * The facts behind an answer, grouped by kind.
 *
 * Ids are printed in full rather than abbreviated, since the whole point is that one can be pasted
 * back to check whether it still holds.
 */
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

	for (const kind of ["declaration", "reference", "import", "literal", "answer"]) {
		const group = result.facts.filter((fact) => fact.kind === kind);
		if (group.length === 0) continue;
		lines.push("", `## ${kind} (${group.length})`, "");
		for (const fact of group) lines.push(`- ${fact.summary}\n  ID: \`${fact.factId}\``);
	}

	if (result.truncated.length > 0) {
		lines.push("", `> Capped: ${result.truncated.join(", ")}. Raise limit to see the rest.`);
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
	modules: number;
	scope: string;
	index: { state: string; done: number; total: number; failures?: number };
	largest: Array<{ module: string; symbols: number }>;
	knowledge?: { answers: number; stale?: number; doubted?: number };
}): string {
	const lines = [
		"# Workspace overview",
		"",
		"## Workspace",
		"",
		`\`${result.scope}\``,
		"",
		"## Index",
		"",
		`- State: ${result.index.state}${result.index.state === "ready" ? "" : ` (${result.index.done} of ${result.index.total})`}`,
	];
	const failures = result.index.failures ?? 0;
	if (failures > 0) lines.push(`- Files failed: ${failures}; prior facts were kept`);

	lines.push(
		"",
		"## Counts",
		"",
		"| Files | Symbols | References | Imports | Literals | Modules |",
		"| ---: | ---: | ---: | ---: | ---: | ---: |",
		`| ${result.files} | ${result.symbols} | ${result.references} | ${result.imports} | ${result.literals} | ${result.modules} |`,
	);

	// The front door mentions the knowledge layer, because an agent arriving with an ordinary task
	// has no reason to call a tool it has never heard of. One line each way: coverage when it
	// exists, and an honest "none yet" with the pointer when it does not.
	if (result.knowledge !== undefined) {
		if (result.knowledge.answers === 0) {
			lines.push("", "## Knowledge", "", "None recorded yet. `knowledge_gaps` lists what is worth writing.");
		} else {
			// Absent means the staleness scan was skipped at this size, which is a different claim
			// from zero stale, and the wording keeps the two apart.
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
export function renderHubs(
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
		rows.push(symbolBullet(symbol));
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

/** Where a symbol sits in the graph, with the caveat that makes the numbers readable. */
export function renderGraph(name: string, summary: GraphSummary): string {
	const via = summary.viaMembers === undefined ? "" : ` (across it and its ${summary.viaMembers} members)`;
	const lines = [
		`# Graph: \`${name}\``,
		"",
		"## Fan-in/out",
		"",
		`- Used by: ${summary.fanIn} place${summary.fanIn === 1 ? "" : "s"}`,
		`- Uses: ${summary.fanOut} distinct symbol${summary.fanOut === 1 ? "" : "s"}${via}`,
	];

	if (summary.cycle) {
		lines.push("", `## Cycle (${summary.cycle.length})`, "");
		for (const member of summary.cycle.slice(0, 10)) lines.push(`- \`${member}\``);
		if (summary.cycle.length > 10) lines.push("", `> ${summary.cycle.length - 10} more cycle members not shown.`);
	}

	lines.push("", "> Counts are bounded by what binding resolved.");
	return lines.join("\n");
}

/** What a rename did, or what stopped it. A refusal still shows the plan it would have run. */
export function renderRenameOutcome(outcome: RenameOutcome): string {
	if (!outcome.renamed) {
		const lines = ["# Rename not applied", "", `**Reason:** ${outcome.reason}`];
		for (const blocker of outcome.plan.blockers) {
			lines.push("", `## ${blocker.kind}`, "", blocker.detail);
			for (const site of blocker.sites ?? []) lines.push(`- \`${site.module}:${site.line}\``);
		}
		lines.push("", "> Nothing was written.");
		return lines.join("\n");
	}

	const lines = [
		"# Rename applied",
		"",
		`\`${outcome.plan.oldName}\` -> \`${outcome.plan.newName}\``,
		"",
		"## Files",
		"",
	];
	for (const module of outcome.modules) lines.push(`- \`${module}\``);
	// Carried through to the successful case on purpose: a rename can be complete over everything
	// the index sees and still have missed something outside it, and that stays true after writing.
	if (outcome.plan.warnings.length > 0) {
		lines.push("", "## Warnings", "");
		for (const warning of outcome.plan.warnings) lines.push(`- **${warning.kind}:** ${warning.detail}`);
	}
	return lines.join("\n");
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
