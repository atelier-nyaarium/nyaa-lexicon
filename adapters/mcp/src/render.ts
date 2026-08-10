// Turning answers into what an agent reads.
//
// Pure, because this is where the token budget is actually spent and it deserves tests. The rule
// throughout: a summary plus a handle to go deeper, never one dump. An agent pays for every line
// and loses the thread long before a human would scroll past it.

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
//  Constants

/** Members shown before the rest become a count. A class surface, not a class listing. */
export const MEMBER_PREVIEW = 20;

////////////////////////////////
//  Functions & Helpers

function line(summary: SymbolSummary): string {
	// Three states, not two. A language with no notion of module export renders its visibility
	// without implying the answer was no.
	const exported = summary.exported === true ? "" : ` (${summary.visibility})`;
	return `${summary.kind} ${summary.name}${exported}${summary.signature ? `: ${summary.signature}` : ""}`;
}

/**
 * One symbol as its surface. The compression that makes this beat reading the file.
 *
 * `from` pages past the cap. Without it a 48-member class had 28 members no call could reach, so
 * the cap protected the token budget by making part of the answer permanently unavailable.
 */
export function renderDescribe(result: DescribeResult, from = 0): string {
	// The line span makes "read the body" a range read of exactly those lines, never a file read.
	const at =
		result.symbol.lines === undefined
			? ""
			: `, lines ${result.symbol.lines.start + 1}-${result.symbol.lines.end + 1}`;
	const lines = [`${line(result.symbol)}`, `  in ${result.symbol.module}${at}`, `  id ${result.symbol.symbolId}`];

	if (result.symbol.docComment) lines.push(`  doc ${result.symbol.docComment.split("\n")[0]}`);

	if (result.members.length > 0) {
		const shown = result.members.slice(from, from + MEMBER_PREVIEW);
		const upto = from + shown.length;
		lines.push(`  members ${from + 1} to ${upto} of ${result.members.length}:`);
		for (const member of shown) lines.push(`    ${line(member)}`);
		if (upto < result.members.length) {
			lines.push(`    ... ${result.members.length - upto} more; call again with from: ${upto}`);
		}
	}

	// A count rather than the list: the caller decides whether that is worth its own call.
	lines.push(`  used in ${result.referenceCount} place${result.referenceCount === 1 ? "" : "s"}`);
	if (result.referenceCount > 0) lines.push("  call find_references for the list");
	return lines.join("\n");
}

/** Uses of a symbol, grouped by file so the shape of the usage is visible at a glance. */
export function renderReferences(result: ReferencesResult): string {
	if (result.total === 0) return `No references found.\n\nThis is honest only as far as binding reaches.`;

	const byModule = new Map<string, string[]>();
	for (const reference of result.references) {
		const rows = byModule.get(reference.module) ?? [];
		rows.push(`    line ${reference.startLine + 1}  ${reference.role}`);
		byModule.set(reference.module, rows);
	}

	const lines = [`${result.total} reference${result.total === 1 ? "" : "s"}:`];
	for (const [module, rows] of byModule) {
		lines.push(`  ${module}`);
		lines.push(...rows);
	}

	if (result.truncated) {
		lines.push(`  ... ${result.total - result.references.length} more; raise limit to see them`);
	}
	return lines.join("\n");
}

/**
 * A type, with how it was arrived at.
 *
 * The three statuses are rendered as three different sentences rather than one with a footnote,
 * because "the checker says number" and "nobody has implemented this" are not the same answer and
 * a caller that cannot tell them apart will treat the second as the first.
 */
export function renderType(name: string, type: TypeInfo): string {
	if (type.status === "known") {
		const from = type.provenance === "declared" ? "declared in source" : `established by ${type.provenance}`;
		return `${name}: ${type.display}\n  ${from}`;
	}
	if (type.status === "inferred") return `${name}: ${type.display}\n  inferred from ${type.basis}`;
	return `${name}: unknown\n  ${type.reason}${type.detail ? `: ${type.detail}` : ""}`;
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
		const lines = [`Cannot rename ${plan.oldName || plan.symbolId}:`];
		for (const blocker of plan.blockers) lines.push(`  ${blocker.kind}: ${blocker.detail}`);
		return lines.join("\n");
	}

	// Owner calls are counted in the headline and shown per file, because a plan that says "2
	// occurrences" and then rewrites four places is a plan a reader stops trusting. They are not
	// occurrences of the name, so they are named separately rather than folded into the same number.
	const calls = plan.files.reduce((total, file) => total + (file.ownerCalls?.length ?? 0), 0);
	const touches = `${plan.occurrences} occurrence${plan.occurrences === 1 ? "" : "s"}`;
	const withCalls = calls === 0 ? touches : `${touches} and ${calls} call${calls === 1 ? "" : "s"} that name it`;

	const lines = [
		`Renaming ${plan.oldName} to ${plan.newName} touches ${withCalls} in ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}:`,
	];
	for (const file of plan.files) {
		const here = file.ownerCalls?.length ?? 0;
		lines.push(
			`  ${file.module}  ${file.sites.length}${here === 0 ? "" : ` plus ${here} call${here === 1 ? "" : "s"}`}`,
		);
	}

	// Never omitted when empty in a way a reader could mistake for silence: the absence of this
	// section is itself the claim that the index saw everything.
	if (plan.warnings.length === 0) {
		lines.push("Every occurrence is a bound edge, and nothing is spelled this way unbound.");
		return lines.join("\n");
	}

	lines.push("This set may not be complete:");
	for (const warning of plan.warnings) {
		lines.push(`  ${warning.kind}: ${warning.detail}`);
		for (const site of warning.sites ?? []) lines.push(`    ${site.module}:${site.line}`);
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
		return `No literal matched.\n\nThis searches decoded values, so it sees through quoting rather than matching source text.`;
	}

	const byModule = new Map<string, string[]>();
	for (const literal of result.literals) {
		const rows = byModule.get(literal.module) ?? [];
		const shown = literal.value.length > 60 ? `${literal.value.slice(0, 60)}...` : literal.value;
		// The containing declaration is the hop from text to structure, and it matters most where
		// names are mangled: the literal is then the only readable thing pointing at its symbol. The
		// module prefix is dropped because the row already sits under its module header.
		const container =
			literal.containerId === null ? "" : `  in ${literal.containerId.split(" ").slice(3).join(" ")}`;
		rows.push(`    line ${literal.range.start.line + 1}  ${literal.kind}  ${JSON.stringify(shown)}${container}`);
		byModule.set(literal.module, rows);
	}

	const lines = [`${result.total} literal${result.total === 1 ? "" : "s"}:`];
	for (const [module, rows] of byModule) {
		lines.push(`  ${module}`);
		lines.push(...rows);
	}

	if (result.truncated) lines.push(`  ... ${result.total - result.literals.length} more; raise limit to see them`);
	if (result.scanIncomplete) {
		lines.push("The scan stopped before the end of the index, so matches beyond it were not looked at.");
	}
	return lines.join("\n");
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
		return `Nothing has changed alongside ${result.module} in the last ${result.commits} commits.`;
	}

	const lines = [`Changed alongside ${result.module}:`];
	for (const partner of result.partners) {
		const share = Math.round((partner.together / Math.max(partner.outOf, 1)) * 100);
		lines.push(`  ${partner.together} of ${partner.outOf}  (${share}%)  ${partner.module}`);
	}

	if (result.total > result.partners.length) lines.push(`  ... ${result.total - result.partners.length} more`);
	lines.push(`Read from ${result.commits} commits.`);
	// Named rather than silent: a sweep touching hundreds of files pairs every one of them with
	// every other, so dropping those is what keeps the signal meaningful, and a reader deserves to
	// know a filter ran at all.
	if (result.skippedWideCommits > 0) {
		lines.push(
			`${result.skippedWideCommits} commits touching over ${result.widthLimit} files were ignored as sweeps.`,
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
	const lines: string[] = [];
	const list = (label: string, entries: Array<{ name: string; kind: string; module: string }>) => {
		if (entries.length === 0) return;
		lines.push(`${label}:`);
		for (const entry of entries) lines.push(`  ${entry.kind} ${entry.name}  ${entry.module}`);
	};

	list("Extends", result.supertypes);
	if (result.unboundSupertypes.length > 0) {
		lines.push(`Extends, outside the index: ${result.unboundSupertypes.join(", ")}`);
	}
	list("Extended by", result.subtypes);

	// Only when it adds something the direct list did not already say.
	const indirect = result.ancestors.filter(
		(ancestor) => !result.supertypes.some((direct) => direct.name === ancestor.name),
	);
	if (indirect.length > 0) {
		lines.push(`Further up: ${indirect.map((ancestor) => ancestor.name).join(" <- ")}`);
	}

	if (lines.length === 0) return `${result.symbolId} has no supertypes or subtypes in the index.`;
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
	if (result.commits === 0) return `${result.module} has no commits in the history window.`;

	const ago = (at: number) => {
		const days = Math.round((Date.now() / 1000 - at) / 86_400);
		if (days === 0) return "today";
		return `${days} day${days === 1 ? "" : "s"} ago`;
	};

	const commits = `${result.commits} commit${result.commits === 1 ? "" : "s"}`;
	const lines = [`${result.module}: ${commits}, +${result.linesAdded} -${result.linesDeleted} lines`];
	if (result.lastTouched !== null) lines.push(`Last touched ${ago(result.lastTouched)}.`);
	if (result.firstSeen !== null) {
		lines.push(
			result.truncated
				? `Already present ${ago(result.firstSeen)}, which is as far back as this read went.`
				: `First appeared ${ago(result.firstSeen)}.`,
		);
	}
	return lines.join("\n");
}

/**
 * The knowledge line under a describe: recorded prose, or one line of invitation.
 *
 * The invitation is ONE line on purpose. Repeated on every miss across a cold workspace it would
 * train agents to skim past it, so the full ask lives in knowledge_gaps and this only points there.
 */
export function renderKnowledge(recalled: RecalledAnswer | null): string {
	if (recalled === null) {
		return "  knowledge: none recorded. record_answer saves what you conclude, citing ids from symbol_facts; knowledge_gaps with this id maps what is unknown beneath it.";
	}

	const grade = recalled.answer.thin ? " THIN" : "";
	const lines = [`  knowledge (${recalled.answer.question}${grade}): ${recalled.answer.prose}`];
	if (recalled.answer.doubt !== undefined) {
		const by = recalled.answer.doubt.by === undefined ? "" : ` by ${recalled.answer.doubt.by}`;
		lines.push(
			`  DOUBTED${by}: ${recalled.answer.doubt.reason}`,
			`    To clear: verify against the code, then record_answer or reaffirm_answer citing resolvesDoubt ${recalled.answer.doubt.factId}`,
		);
	}
	if (recalled.stale.length > 0) {
		lines.push(
			`  STALE: ${recalled.stale.length} cited fact${recalled.stale.length === 1 ? "" : "s"} changed since this was written. Re-check against symbol_facts, then reaffirm_answer with current citations, or record_answer to rewrite.`,
		);
	}
	if (recalled.inheritedStale.length > 0) {
		lines.push(
			`  SHAKY: leans on ${recalled.inheritedStale.length} answer${recalled.inheritedStale.length === 1 ? "" : "s"} whose own ground moved. Re-affirm those first.`,
		);
	}
	if (recalled.doubtedUpstream.length > 0) {
		lines.push(
			`  SHAKY: leans on ${recalled.doubtedUpstream.length} answer${recalled.doubtedUpstream.length === 1 ? "" : "s"} someone has doubted. Recall those, read the doubt, and address it first.`,
		);
	}
	return lines.join("\n");
}

export function renderRecordOutcome(outcome: RecordOutcome): string {
	if (outcome.recorded) {
		// The grade goes to the WRITER at the moment of writing, which is the one moment a better
		// answer costs nothing extra: the facts are already in front of them.
		const thin = outcome.answer.thin
			? "\nMarked THIN: nothing cited reaches beyond the declaration, so this reads as a paraphrase of the signature. Citing a reference, a literal or a child answer would ground it in something a reader cannot already see."
			: "";
		// The store counts out loud on every write. A tally kept by the writer is prose, and one
		// writer inherited another run's outputs and reported 188 where the store held 5; with the
		// count in every response, the last response IS the count and a drifted tally contradicts
		// the next line its keeper reads.
		const mine =
			outcome.stored.byThisModel === undefined ? "" : ` (${outcome.stored.byThisModel} under your model tag)`;
		// A carried doubt is stated to the one writer who can still address it, at the one moment the
		// context to address it is already loaded.
		const carried =
			outcome.doubtCarried === undefined
				? ""
				: `\nA standing doubt rode forward onto this answer: "${outcome.doubtCarried.reason}". If your rewrite addresses it, record again citing resolvesDoubt ${outcome.doubtCarried.factId}.`;
		return `Recorded. The store now holds ${outcome.stored.total} answer${outcome.stored.total === 1 ? "" : "s"}${mine}.${thin}${carried}\nThis answer's own citable id:\n  ${outcome.answer.factId}\nCite it from answers about things that use ${outcome.answer.symbolId}.`;
	}
	const lines = [`Not recorded: ${outcome.reason}.`];
	for (const factId of outcome.unresolved ?? []) lines.push(`  ${factId}`);
	if (outcome.uncovered !== undefined && outcome.uncovered.length > 0) {
		lines.push("The incumbent's still-live citations this write does not cover:");
		for (const factId of outcome.uncovered) lines.push(`  ${factId}`);
	}
	return lines.join("\n");
}

/** What declaring a doubt did, question by question, with the id the eventual clearer must cite. */
export function renderInvalidateOutcome(outcome: InvalidateOutcome): string {
	if (outcome.refused !== undefined) return `Nothing doubted: ${outcome.refused}.`;

	const lines: string[] = [];
	for (const entry of outcome.doubted) {
		lines.push(
			`Doubted the ${entry.question} answer about ${outcome.symbolId}.`,
			`  Readers now see the doubt, and answers leaning on this one show SHAKY.`,
			`  Clearing it requires citing ${entry.doubt.factId}`,
		);
	}
	if (outcome.noAnswer.length > 0) {
		lines.push(`No ${outcome.noAnswer.join(", ")} answer exists to doubt; counted as gap demand instead.`);
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
		return `No knowledge gaps under ${where}.${externals}`;
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
	lines.push(`${gaps.total} ${gaps.question} gap${gaps.total === 1 ? "" : "s"} ${scope}:`);
	if (gaps.seeded === true) {
		lines.push(
			"Nobody has asked anything yet, so these are the most-referenced unanswered symbols rather than measured demand.",
		);
	}

	for (const row of gaps.rows) {
		// The descriptor tail rather than the bare name, because in a minified module half the tree
		// is parameters named $ and v, and a row that cannot be turned back into a symbol_facts call
		// is a to-do list nobody can act on. The tail plus the module reconstructs the full id.
		const tail = row.symbolId.split(" ").slice(3).join(" ");
		const name = row.name === undefined ? row.symbolId : `${row.kind} ${tail}  ${row.module}`;
		const asked = row.askCount > 0 ? `  asked ${row.askCount}x` : "";
		const mark = row.why === "stale" ? "  STALE" : row.why === "doubted" ? "  DOUBTED" : "";
		// The ledger and the health sweep span every question class, so a row for a different
		// question than the headline says which one, or it reads as the filter failing.
		const which = row.question === gaps.question ? "" : `  (${row.question})`;
		lines.push(`  ${name}${mark}${which}${asked}  fan-in ${row.fanIn}`);
	}
	if (gaps.total > gaps.rows.length) lines.push(`  ... ${gaps.total - gaps.rows.length} more`);
	// The reconstruction rule shown by example rather than described, so a row becomes a
	// symbol_facts call without anyone knowing the id grammar. The example came from the store, so
	// nothing here spells a scheme by hand, which the grammar residue test would rightly refuse.
	const first = gaps.rows[0];
	if (first !== undefined) lines.push(`Rows are shortened ids. The first row in full: ${first.symbolId}`);
	if (gaps.truncated) lines.push("The dependency walk hit its cap, so the total above is a floor.");
	if (gaps.staleScanSkipped === true) {
		lines.push(
			"The knowledge base is too large to health-check every answer here: doubted ones are still listed, but an answer gone stale since anyone last asked will only surface on recall.",
		);
	}
	if (gaps.external > 0) {
		lines.push(`${gaps.external} dependencies are outside the index: nothing citable exists for them.`);
	}

	if (gaps.total < INLINE_GAP_THRESHOLD) {
		// A subagent when one exists, because the loop's round trips otherwise sit in the asker's
		// context verbatim; the answers land in the store either way, which is where they are read.
		lines.push(
			"",
			"Short list. Close these now, in order: symbol_facts for each, then record_answer with the cited ids. Leaves come first, so each answer can lean on the ones before it. If you can spawn a subagent, hand it this loop and continue when it returns; the answers land in the store either way.",
		);
	} else {
		lines.push(
			"",
			`${gaps.total} is more than a working agent should absorb mid-task. If your user agrees, hand this to ONE background agent:`,
			"",
			`  Loop until knowledge_gaps${root === undefined ? "" : ` (root ${where})`} returns empty: take the first row, call symbol_facts, read what it points at, and record_answer with the cited fact ids. Leaves come first, so later answers may cite earlier ones' ids.`,
			"",
			"Meanwhile continue your own task; the encyclopedia builds behind you.",
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
		return `No commit message in the last ${result.commits} commits names ${result.name}.`;
	}

	const count = result.mentions.length;
	const lines = [`${count} commit${count === 1 ? "" : "s"} name${count === 1 ? "s" : ""} ${result.name}:`];
	for (const mention of result.mentions) {
		const days = Math.round((Date.now() / 1000 - mention.at) / 86_400);
		const when = days === 0 ? "today" : `${days}d ago`;
		const files = `${mention.files} file${mention.files === 1 ? "" : "s"}`;
		lines.push(`  ${mention.hash.slice(0, 7)}  ${when}  ${files}  ${mention.subject}`);
	}
	lines.push(`Read from ${result.commits} commits.`);
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
	facts: Array<{ factId: string; kind: string; module: string; summary: string }>;
	truncated: string[];
}): string {
	const lines = [`${result.facts.length} facts about ${result.symbolId}:`];

	for (const kind of ["declaration", "reference", "import", "literal", "answer"]) {
		const group = result.facts.filter((fact) => fact.kind === kind);
		if (group.length === 0) continue;
		lines.push(`${kind} (${group.length}):`);
		for (const fact of group) lines.push(`  ${fact.summary}\n    ${fact.factId}`);
	}

	if (result.truncated.length > 0) {
		lines.push(`Capped: ${result.truncated.join(", ")}. Raise limit to see the rest.`);
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
	index: { state: string; done: number; total: number };
	largest: Array<{ module: string; symbols: number }>;
	knowledge?: { answers: number; stale?: number; doubted?: number };
}): string {
	const lines = [
		`${result.files} files, ${result.symbols} symbols, ${result.references} references, ${result.imports} imports, ${result.literals} literals`,
		`scope: ${result.scope}`,
		`index: ${result.index.state}${result.index.state === "ready" ? "" : ` (${result.index.done} of ${result.index.total})`}`,
	];

	// The front door mentions the knowledge layer, because an agent arriving with an ordinary task
	// has no reason to call a tool it has never heard of. One line each way: coverage when it
	// exists, and an honest "none yet" with the pointer when it does not.
	if (result.knowledge !== undefined) {
		if (result.knowledge.answers === 0) {
			lines.push(
				"knowledge: none recorded yet. describe_symbol shows recorded knowledge when it exists; knowledge_gaps lists what is worth writing.",
			);
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
				`knowledge: ${result.knowledge.answers} recorded answer${result.knowledge.answers === 1 ? "" : "s"}${stale}${doubted}. describe_symbol serves them; knowledge_gaps lists what is missing.`,
			);
		}
	}

	lines.push("", "largest modules:");
	for (const module of result.largest) lines.push(`  ${String(module.symbols).padStart(5)}  ${module.module}`);
	return lines.join("\n");
}

/** Import sites, grouped by the file doing the importing. */
export function renderImports(result: {
	imports: Array<{ module: string; specifier: string; name?: string; reExport: boolean }>;
	total: number;
	truncated: boolean;
}): string {
	if (result.total === 0) return "No import matched.\n\nThis reads the import graph, not source text.";

	const byModule = new Map<string, Set<string>>();
	for (const statement of result.imports) {
		const specifiers = byModule.get(statement.module) ?? new Set();
		// The name is shown when there is one. Its absence means the statement binds the module
		// rather than an export, which is a real import and not a missing field.
		const named = statement.name === undefined ? "" : `  { ${statement.name} }`;
		specifiers.add(`${statement.specifier}${named}${statement.reExport ? "  (re-export)" : ""}`);
		byModule.set(statement.module, specifiers);
	}

	const lines = [`${byModule.size} file${byModule.size === 1 ? "" : "s"}, ${result.total} import entries:`];
	for (const [module, specifiers] of byModule) {
		lines.push(`  ${module}`);
		for (const specifier of specifiers) lines.push(`    ${specifier}`);
	}
	if (result.truncated) lines.push("  ... more; raise limit");
	return lines.join("\n");
}

/** The most-referenced symbols, which is where reading pays off most. */
export function renderHubs(
	rows: Array<{ symbolId: string; count: number; declaration: SymbolSummary | null }>,
): string {
	if (rows.length === 0) return "Nothing is referenced yet.";

	const lines = ["Most referenced:"];
	for (const row of rows) {
		const where = row.declaration ? `${line(row.declaration)}  in ${row.declaration.module}` : row.symbolId;
		lines.push(`  ${String(row.count).padStart(4)}  ${where}`);
	}
	lines.push("Counts are bounded by what binding resolved, so this ranks the index rather than the truth.");
	return lines.join("\n");
}

/** Symbols found by a name search, grouped by file. Where browsing starts. */
export function renderSymbolSearch(result: {
	text: string;
	symbols: SymbolSummary[];
	total: number;
	truncated: boolean;
}): string {
	if (result.total === 0) return `No symbol name contains ${JSON.stringify(result.text)}.`;

	const byModule = new Map<string, string[]>();
	for (const symbol of result.symbols) {
		const rows = byModule.get(symbol.module) ?? [];
		rows.push(`    ${line(symbol)}`);
		byModule.set(symbol.module, rows);
	}

	const lines = [`${result.total} symbol${result.total === 1 ? "" : "s"} matching ${JSON.stringify(result.text)}:`];
	for (const [module, rows] of byModule) {
		lines.push(`  ${module}`);
		lines.push(...rows);
	}
	if (result.truncated) lines.push(`  ... more; raise limit or narrow by kind or module`);
	return lines.join("\n");
}

/** Everything one file declares, nested by container. The "open the file" answer. */
export function renderOutline(module: string, declarations: Array<SymbolSummary & { containerId?: string }>): string {
	if (declarations.length === 0) return `${module} declares nothing that is indexed.`;

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

	const lines = [`${module}  (${declarations.length} declarations)`];
	const walk = (nodes: typeof declarations, depth: number) => {
		for (const node of nodes) {
			lines.push(`${"  ".repeat(depth + 1)}${line(node)}`);
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
		`${name}`,
		`  used by ${summary.fanIn} place${summary.fanIn === 1 ? "" : "s"}`,
		`  uses ${summary.fanOut} distinct symbol${summary.fanOut === 1 ? "" : "s"}${via}`,
	];

	if (summary.cycle) {
		lines.push(`  IN A CYCLE of ${summary.cycle.length}:`);
		for (const member of summary.cycle.slice(0, 10)) lines.push(`    ${member}`);
		if (summary.cycle.length > 10) lines.push(`    ... ${summary.cycle.length - 10} more`);
	}

	lines.push("Counts are bounded by what binding resolved, so they describe the index, not the code.");
	return lines.join("\n");
}

/** What a rename did, or what stopped it. A refusal still shows the plan it would have run. */
export function renderRenameOutcome(outcome: RenameOutcome): string {
	if (!outcome.renamed) {
		const lines = [`Did not rename ${outcome.plan.oldName}: ${outcome.reason}`];
		for (const blocker of outcome.plan.blockers) {
			lines.push(`  ${blocker.kind}: ${blocker.detail}`);
			for (const site of blocker.sites ?? []) lines.push(`    ${site.module}:${site.line}`);
		}
		lines.push("Nothing was written.");
		return lines.join("\n");
	}

	const lines = [
		`Renamed ${outcome.plan.oldName} to ${outcome.plan.newName} across ${outcome.modules.length} file${outcome.modules.length === 1 ? "" : "s"}:`,
	];
	for (const module of outcome.modules) lines.push(`  ${module}`);
	// Carried through to the successful case on purpose: a rename can be complete over everything
	// the index sees and still have missed something outside it, and that stays true after writing.
	for (const warning of outcome.plan.warnings) lines.push(`  note  ${warning.kind}: ${warning.detail}`);
	return lines.join("\n");
}

/**
 * Several same-named symbols, so a caller can pick before spending a describe on each.
 *
 * Ambiguity is shown rather than resolved: choosing one silently is how an agent ends up
 * confidently reading about the wrong symbol.
 */
export function renderCandidates(name: string, candidates: SymbolSummary[]): string {
	if (candidates.length === 0) return `No symbol named ${name} is indexed.`;
	if (candidates.length === 1) return "";

	// The id per row is the whole point: telling a caller to pass a symbolId while showing none left
	// eight identical minified methods with no way to be told apart short of guessing ids blind.
	const lines = [`${candidates.length} symbols named ${name}:`];
	for (const candidate of candidates) {
		lines.push(`  ${candidate.module}  ${line(candidate)}`);
		lines.push(`    ${candidate.symbolId}`);
	}
	lines.push("Pass one of the symbolIds above to pick one.");
	return lines.join("\n");
}
