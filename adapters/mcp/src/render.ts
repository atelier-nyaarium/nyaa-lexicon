// Turning answers into what an agent reads.
//
// Pure, because output formatting deserves direct tests.

import type {
	DescribeResult,
	InvalidateOutcome,
	KnowledgeGaps,
	LiteralsResult,
	RecalledAnswer,
	RecordOutcome,
	ReferencesResult,
	RenameOutcome,
	RenamePlan,
	SymbolSummary,
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

function questionTitle(question: string): string {
	return question.slice(0, 1).toUpperCase() + question.slice(1);
}

/** Recorded knowledge, or a short invitation to write it. */
export function renderKnowledge(recalled: RecalledAnswer | null, question = "knowledge"): string {
	if (recalled === null)
		return `## ${questionTitle(question)}\n\nNo answer recorded. Call \`record_answer\` to save one.`;

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
			`**SHAKY:** Leans on ${recalled.inheritedStale.length} answer${recalled.inheritedStale.length === 1 ? "" : "s"} whose citations changed. Re-affirm those first.`,
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
		lines.push("", "## Unresolved citations", "");
		for (const factId of outcome.unresolved ?? []) lines.push(`- \`${factId}\``);
	}
	if (outcome.uncovered !== undefined && outcome.uncovered.length > 0) {
		lines.push("", "## Uncovered citations", "", "Citations from the existing answer:");
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

	lines.push(
		"",
		"## Next step",
		"",
		"For each row, call `symbol_facts`, then `record_answer` with the fact IDs. Work leaves first.",
	);
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

	const headings: Record<string, string> = {
		declaration: "Declaration",
		reference: "References",
		import: "Imports",
		literal: "Literals",
	};
	for (const kind of ["declaration", "reference", "import", "literal"]) {
		const group = factsByKind.get(kind) ?? [];
		if (group.length === 0) continue;
		lines.push("", `## ${headings[kind]}`, "");
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
