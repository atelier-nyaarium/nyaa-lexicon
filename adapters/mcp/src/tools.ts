// The structural tools, all of them read-only.
//
// Descriptions are written for the bar an agent actually applies: it already has grep and read,
// both free, so a tool earns a call only by doing something they cannot. Each description says
// what that is.

import type {
	DescribeResult,
	FactSet,
	FileHistory,
	GraphSummary,
	IndexStatus,
	InvalidateOutcome,
	KnowledgeGaps,
	LiteralQuery,
	LiteralsResult,
	Mention,
	QuestionClass,
	RecalledAnswer,
	RecordOutcome,
	ReferencesResult,
	RenameOutcome,
	RenamePlan,
	StoredImport,
	SymbolSummary,
	TypeHierarchy,
} from "@nyaa-lexicon/core";
import type { ImportResolution, TypeInfo } from "@nyaa-lexicon/protocol";
import { z } from "zod";
import {
	renderCandidates,
	renderCoChange,
	renderDescribe,
	renderFacts,
	renderFileHistory,
	renderGraph,
	renderHierarchy,
	renderHubs,
	renderImports,
	renderInvalidateOutcome,
	renderKnowledge,
	renderKnowledgeGaps,
	renderLiterals,
	renderMentions,
	renderOutline,
	renderOverview,
	renderRecordOutcome,
	renderReferences,
	renderRenameOutcome,
	renderRenamePlan,
	renderSymbolSearch,
	renderType,
} from "./render.js";

////////////////////////////////
//  Interfaces & Types

/** What a tool needs from the daemon. Injected, so the tools are testable without one. */
export interface ToolBackend {
	findByName: (name: string, module?: string) => Promise<SymbolSummary[]>;
	describe: (symbolId: string) => Promise<DescribeResult | null>;
	findReferences: (symbolId: string, limit?: number) => Promise<ReferencesResult>;
	resolveImport: (fromModule: string, specifier: string) => Promise<ImportResolution>;
	typeOf: (symbolId: string) => Promise<TypeInfo>;
	prepareRename: (symbolId: string, newName: string) => Promise<RenamePlan>;
	renameSymbol: (symbolId: string, newName: string) => Promise<RenameOutcome>;
	indexStatus: () => Promise<IndexStatus>;
	findLiterals: (query: LiteralQuery & { limit?: number | undefined }) => Promise<LiteralsResult>;
	graphOf: (symbolId: string) => Promise<GraphSummary>;
	coChangedWith: (module: string, limit?: number) => Promise<CoChangeResult>;
	searchSymbols: (
		text: string,
		options: { kind?: string | undefined; module?: string | undefined; limit?: number | undefined },
	) => Promise<SearchResult>;
	outlineModule: (module: string) => Promise<Array<SymbolSummary & { containerId?: string }>>;
	findImports: (query: {
		specifier?: string | undefined;
		module?: string | undefined;
		limit?: number | undefined;
	}) => Promise<ImportsResult>;
	hubs: (limit?: number) => Promise<Array<{ symbolId: string; count: number; declaration: SymbolSummary | null }>>;
	overview: () => Promise<OverviewResult>;
	typeHierarchy: (symbolId: string) => Promise<TypeHierarchy>;
	fileHistory: (module: string) => Promise<FileHistory>;
	factsFor: (symbolId: string, limit?: number) => Promise<FactSet | null>;
	commitsMentioning: (name: string, limit?: number) => Promise<MentionsResult>;
	recordAnswer: (
		symbolId: string,
		question: QuestionClass,
		prose: string,
		citations: string[],
		options?: { model?: string; resolvesDoubt?: string; omitting?: string },
	) => Promise<RecordOutcome>;
	recallAnswer: (symbolId: string, question: QuestionClass) => Promise<RecalledAnswer | null>;
	recallAnswers: (symbolId: string) => Promise<RecalledAnswer[]>;
	invalidateAnswer: (
		symbolId: string,
		reason: string,
		question?: QuestionClass,
		by?: string,
	) => Promise<InvalidateOutcome>;
	reaffirmAnswer: (
		symbolId: string,
		question: QuestionClass,
		options?: { citations?: string[]; model?: string; resolvesDoubt?: string },
	) => Promise<RecordOutcome>;
	knowledgeGaps: (root?: string, question?: QuestionClass, limit?: number) => Promise<KnowledgeGaps>;
}

export interface MentionsResult {
	name: string;
	mentions: Mention[];
	/** Commits read, so an empty answer is readable as "not in this window" rather than "never". */
	commits: number;
}

export interface SearchResult {
	text: string;
	symbols: SymbolSummary[];
	total: number;
	truncated: boolean;
}

export interface ImportsResult {
	query: { specifier?: string | undefined; module?: string | undefined; limit?: number | undefined };
	imports: StoredImport[];
	total: number;
	truncated: boolean;
}

export interface OverviewResult {
	files: number;
	symbols: number;
	references: number;
	imports: number;
	literals: number;
	modules: number;
	scope: string;
	index: IndexStatus;
	largest: Array<{ module: string; symbols: number }>;
	knowledge?: { answers: number; stale?: number; doubted?: number };
}

/** What co-change answered, with the sampling that produced it. */
export interface CoChangeResult {
	module: string;
	partners: Array<{ module: string; together: number; outOf: number }>;
	total: number;
	commits: number;
	skippedWideCommits: number;
	widthLimit: number;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean | undefined;
}

/** What the tool schemas parse to. Optionals carry `undefined` explicitly, per the strict config. */
export interface SymbolArgs {
	name?: string | undefined;
	symbolId?: string | undefined;
	module?: string | undefined;
}

////////////////////////////////
//  Schemas

export const DescribeSymbolInput = {
	name: z.string().min(1).optional().describe("Symbol name. Omit if you already have symbolId."),
	symbolId: z.string().min(1).optional().describe("Exact symbol id, from an earlier answer."),
	module: z.string().min(1).optional().describe("Workspace-relative path, to disambiguate a name."),
};

export const FindReferencesInput = {
	name: z.string().min(1).optional(),
	symbolId: z.string().min(1).optional(),
	module: z.string().min(1).optional(),
	limit: z.number().int().positive().max(500).optional().describe("Default 50."),
};

export const ResolveImportInput = {
	fromModule: z.string().min(1).describe("Workspace-relative path of the importing file."),
	specifier: z.string().min(1).describe("The specifier exactly as written in the import."),
};

export const TypeOfInput = {
	name: z.string().min(1).optional().describe("Symbol name. Omit if you already have symbolId."),
	symbolId: z.string().min(1).optional().describe("Exact symbol id, from an earlier answer."),
	module: z.string().min(1).optional().describe("Workspace-relative path, to disambiguate a name."),
};

export const FindLiteralsInput = {
	value: z.string().optional().describe("Exact decoded value. Indexed, so this is the cheap one."),
	pattern: z.string().optional().describe("JavaScript regular expression, matched against the value."),
	kind: z.enum(["string", "number", "boolean"]).optional().describe("Defaults to string for a pattern search."),
	min: z.number().optional().describe("Numeric lower bound, inclusive."),
	max: z.number().optional().describe("Numeric upper bound, inclusive."),
	limit: z.number().int().positive().max(500).optional().describe("Default 50."),
};

export const GraphOfInput = {
	name: z.string().min(1).optional().describe("Symbol name. Omit if you already have symbolId."),
	symbolId: z.string().min(1).optional().describe("Exact symbol id, from an earlier answer."),
	module: z.string().min(1).optional().describe("Workspace-relative path, to disambiguate a name."),
};

export const SearchSymbolsInput = {
	text: z.string().min(1).describe("Substring of the symbol name. Case-sensitive."),
	kind: z.string().min(1).optional().describe("class, function, method, constant, interface, and so on."),
	module: z.string().min(1).optional().describe("Substring of the file path, to scope the search."),
	limit: z.number().int().positive().max(300).optional().describe("Default 50."),
};

export const OutlineModuleInput = {
	module: z.string().min(1).describe("Workspace-relative path of the file."),
};

export const FindImportsInput = {
	specifier: z.string().min(1).optional().describe("Substring of the specifier as written in source."),
	module: z.string().min(1).optional().describe("Workspace-relative path; answers who imports this file."),
	limit: z.number().int().positive().max(300).optional().describe("Default 50."),
};

export const HubsInput = {
	limit: z.number().int().positive().max(100).optional().describe("Default 20."),
};

export const OverviewInput = {};

export const CoChangedWithInput = {
	module: z.string().min(1).describe("Workspace-relative path of the file to ask about."),
	limit: z.number().int().positive().max(100).optional().describe("Default 20."),
};

export const TypeHierarchyInput = {
	name: z.string().min(1).optional().describe("Symbol name. Omit if you already have symbolId."),
	symbolId: z.string().min(1).optional().describe("Exact symbol id, from an earlier answer."),
	module: z.string().min(1).optional().describe("Workspace-relative path, to disambiguate a name."),
};

export const FileHistoryInput = {
	module: z.string().min(1).describe("Workspace-relative path of the file to ask about."),
};

export const SymbolHistoryInput = {
	name: z.string().min(1).describe("Symbol name as written. Case-sensitive, and at least 3 characters."),
	limit: z.number().int().positive().max(100).optional().describe("Default 20."),
};

const QUESTIONS = ["describe", "why", "relate", "contract", "effects", "usage"] as const;

export const RecordAnswerInput = {
	symbolId: z.string().min(1).describe("Exact symbol id the answer is about, from an earlier tool answer."),
	question: z.enum(QUESTIONS).describe("Which question the prose answers."),
	prose: z
		.string()
		.min(1)
		.describe(
			"The answer, TERSE. One or two sentences, a short paragraph at most. Say only what the facts cannot.",
		),
	citations: z
		.array(z.string().min(1))
		.min(1)
		.describe(
			"Fact ids consumed, whole and exactly as symbol_facts prints them, never the trailing digest alone. Other answers' ids may be cited too.",
		),
	model: z.string().min(1).optional().describe("Who wrote it, e.g. a model name."),
	resolvesDoubt: z
		.string()
		.min(1)
		.optional()
		.describe("The standing doubt's id, from recall. Without it a doubt rides forward onto the new answer."),
	omitting: z
		.string()
		.min(1)
		.optional()
		.describe("When replacing a live answer without citing all its facts: what you dropped and why."),
};

export const RecallAnswerInput = {
	name: z.string().min(1).optional().describe("Symbol name. Omit if you already have symbolId."),
	symbolId: z.string().min(1).optional().describe("Exact symbol id, from an earlier answer."),
	module: z.string().min(1).optional().describe("Workspace-relative path, to disambiguate a name."),
	question: z.enum(QUESTIONS).optional().describe("One question class. Omit for everything recorded about it."),
};

export const InvalidateAnswerInput = {
	name: z.string().min(1).optional().describe("Symbol name. Omit if you already have symbolId."),
	symbolId: z.string().min(1).optional().describe("Exact symbol id, from an earlier answer."),
	module: z.string().min(1).optional().describe("Workspace-relative path, to disambiguate a name."),
	reason: z.string().min(1).describe("Why the recorded answer is no longer trusted. The next writer reads this."),
	question: z.enum(QUESTIONS).optional().describe("One question class. Omit to doubt everything recorded about it."),
	by: z.string().min(1).optional().describe("Who is declaring the doubt, e.g. a model name."),
};

export const ReaffirmAnswerInput = {
	name: z.string().min(1).optional().describe("Symbol name. Omit if you already have symbolId."),
	symbolId: z.string().min(1).optional().describe("Exact symbol id, from an earlier answer."),
	module: z.string().min(1).optional().describe("Workspace-relative path, to disambiguate a name."),
	question: z.enum(QUESTIONS).describe("Which recorded answer is being re-affirmed."),
	citations: z
		.array(z.string().min(1))
		.optional()
		.describe("Current fact ids replacing retired ones, from symbol_facts. Omit when only clearing a doubt."),
	model: z.string().min(1).optional().describe("Who is vouching, e.g. a model name."),
	resolvesDoubt: z.string().min(1).optional().describe("The standing doubt's id, from recall. Required to clear it."),
};

export const KnowledgeGapsInput = {
	name: z.string().min(1).optional().describe("Root symbol name. Omit both name and symbolId for workspace gaps."),
	symbolId: z.string().min(1).optional().describe("Exact root symbol id, from an earlier answer."),
	module: z.string().min(1).optional().describe("Workspace-relative path, to disambiguate the name."),
	question: z.enum(QUESTIONS).optional().describe("Default describe."),
	limit: z.number().int().positive().max(300).optional().describe("Default 60."),
};

export const SymbolFactsInput = {
	name: z.string().min(1).optional().describe("Symbol name. Omit if you already have symbolId."),
	symbolId: z.string().min(1).optional().describe("Exact symbol id, from an earlier answer."),
	module: z.string().min(1).optional().describe("Workspace-relative path, to disambiguate a name."),
	limit: z.number().int().positive().max(200).optional().describe("Per kind, default 40."),
};

export const PrepareRenameInput = {
	name: z.string().min(1).optional().describe("Symbol name. Omit if you already have symbolId."),
	symbolId: z.string().min(1).optional().describe("Exact symbol id, from an earlier answer."),
	module: z.string().min(1).optional().describe("Workspace-relative path, to disambiguate a name."),
	newName: z.string().min(1).describe("The name you intend to give it."),
};

////////////////////////////////
//  Constants

export const DESCRIBE_DESCRIPTION = `
What a symbol is, as its signature surface rather than its source.

Answers with the declaration, its direct members, how many places reference it, and any recorded
knowledge, served with a staleness check.

Use instead of reading a file for a class's shape without its bodies, or to see how widely something
is used before touching it.

Give symbolId when you have one, otherwise name, plus module if the name is not unique.
`.trim();

export const REFERENCES_DESCRIPTION = `
Every USE of a symbol, resolved through imports and re-exports rather than matched by name.

A same-named local elsewhere is excluded and an alias is followed. Grouped by file, capped, and the
cap is reported.

Import and export STATEMENTS are not uses and are not listed. For every occurrence a rewrite would
touch, call prepare_rename.
`.trim();

export const RESOLVE_IMPORT_DESCRIPTION = `
Where an import specifier actually lands.

Follows path mappings, package exports and re-export chains, so it answers for a barrel import.

Distinguishes a file in the workspace, a dependency outside it, and a specifier that resolves to
nothing. Resolving to nothing is a finding, not an error.
`.trim();

export const PREPARE_RENAME_DESCRIPTION = `
Everything a rename would touch, before touching any of it. Reads only.

Lists every occurrence resolved through real binding, including the declaration, grouped by file.

Also reports what it cannot promise: occurrences spelled the same that never bound, and whether the
symbol is exported past the edge of the index.
`.trim();

export const RENAME_SYMBOL_DESCRIPTION = `
Rename a symbol everywhere it is used. THIS WRITES FILES.

Renames the declaration, every use resolved through real binding, and every import and re-export
that reaches it, then re-indexes what it touched.

All or nothing. If any occurrence should change and cannot be changed safely, nothing is written and
you are told which ones and why. Call prepare_rename first for the blast radius.
`.trim();

export const FIND_LITERALS_DESCRIPTION = `
Find literal VALUES written in the code: an exact string, a regex, or a number range.

Searches decoded values, so it sees through quoting. Reaches text no symbol query can: a Python
__all__ entry, the signal name in connect("..."), a magic string two files share, a hard-coded timeout.

Prefer it over grep for the VALUE rather than the line. Every hit carries the declaration it sits inside.
`.trim();

export const GRAPH_OF_DESCRIPTION = `
How a symbol sits in the reference graph: fan-in, fan-out, and whether it is in a cycle.

Fan-in is how many places use it, fan-out how many distinct symbols it uses. A cycle is reported with
every member.

Use before refactoring, to tell a hub from a leaf. Numbers are bounded by what binding resolved, so a
low fan-in can mean barely used or barely resolved.
`.trim();

export const OVERVIEW_DESCRIPTION = `
What this repository is, at a glance. Call it first in a codebase you do not know.

Files, symbols, references, imports and literals indexed, the biggest modules, how much recorded
knowledge exists, and whether scope came from git or was walked off the disk.
`.trim();

export const SEARCH_SYMBOLS_DESCRIPTION = `
Find declarations whose NAME contains some text. Where browsing starts, and how you get a name for
describe_symbol.

Filter by kind (class, function, method, interface, constant) and by a path substring.

Searches DECLARED names, not text. A name inside a comment or string will not match, and a symbol
reached through an alias still matches its real name.
`.trim();

export const OUTLINE_MODULE_DESCRIPTION = `
Everything one file declares, nested by container.

Classes with their methods, functions, constants, each with its signature. Costs a fraction of the
source.

Use instead of reading a file when you want its shape.
`.trim();

export const FIND_IMPORTS_DESCRIPTION = `
Which files import something, by the specifier as written or by the file it resolves to.

Give a specifier substring for every place importing it as written ("discord.js", "~/actions",
"res://"). Give a module path for who imports THAT file.

Reads the import graph rather than searching text, so it works in every language. A text search for
specifiers works in TypeScript and silently returns nothing in Python.
`.trim();

export const HUBS_DESCRIPTION = `
The most-referenced symbols here, most used first.

A hub is where a change is expensive and where reading pays off most.

Counts are bounded by what binding resolved.
`.trim();

export const CO_CHANGED_WITH_DESCRIPTION = `
Files that get edited in the same commits as this one, from git history.

Finds relationships no reference edge can: a test enforcing an invariant by grep, two files held in
sync by a fixture, a doc that goes stale when a behaviour changes.

Use before changing something to find what usually changes with it. Each row gives both counts, so a
9-of-10 partner reads differently from a 2-of-40 one.
`.trim();

export const TYPE_HIERARCHY_DESCRIPTION = `
What a type extends and what extends it, in both directions at once.

Tells you whether overriding a method here changes behaviour elsewhere, and which base actually
declares the thing you are looking at. A subclass in another file is found without opening it.

Unresolved bases are LISTED rather than dropped. A base outside the workspace is a real supertype
this index cannot name.
`.trim();

export const FILE_HISTORY_DESCRIPTION = `
How much a file changes and how long it has existed, from git.

Churn is lines rather than commits. Forty one-line commits and two rewrites are different things.

Says when the history window ran out rather than reporting a floor as a date.

Use to weigh how settled code is before rewriting it.
`.trim();

export const SYMBOL_HISTORY_DESCRIPTION = `
Commits whose message names this symbol. The closest thing here to a reason.

Finds where somebody wrote down WHY: why a cache was added, what a workaround was working around,
which bug a guard exists for.

Matched on a word boundary and case-sensitively. Each row says how many files that commit touched,
so a mention inside a sweep is not read as a deliberate one.

Use before changing something whose shape looks arbitrary.
`.trim();

export const RECORD_ANSWER_DESCRIPTION = `
Save what you just figured out about a symbol, so the next agent does not re-derive it.

Prose plus the fact ids you drew it from, using ids from symbol_facts. The store refuses an answer
that cites nothing, cites ids that do not resolve, or cites only other symbols' facts. YOU are the
model; this never calls one.

KEEP THE PROSE TERSE. One or two sentences is the target, a short paragraph the ceiling. Write the
part a reader cannot already see and stop.

Citing only the subject's own declaration is marked THIN. Add a reference, a literal, or a child
answer.

Answers may cite other answers' ids. When a cited fact changes, the answer reports stale by itself.
`.trim();

export const RECALL_ANSWER_DESCRIPTION = `
The full recorded answer for one symbol, with its health: STALE, SHAKY, or DOUBTED.

describe_symbol already serves the describe answer inline. This is the recall for every other
question class, and the first step of re-affirming or clearing a doubt.

Omit question for everything recorded about the symbol.
`.trim();

export const INVALIDATE_ANSWER_DESCRIPTION = `
Flag a recorded answer you no longer trust, without rewriting it.

Use right after changing code in a way that shifts what a symbol MEANS, where the facts still
resolve but the explanation describes the old purpose.

The doubt shows on every recall, cascades as SHAKY into answers built on this one, and joins
knowledge_gaps as recheck demand.

The reason you give is what the next writer reads. Clearing it requires citing its id, which only a
recall shows.
`.trim();

export const REAFFIRM_ANSWER_DESCRIPTION = `
Vouch that a recorded answer still holds, healing its ground instead of rewriting it.

STALE ids: verify the prose against symbol_facts, then call this with the current fact ids. Same
prose, re-grounded, no re-authoring.

DOUBTED: verify, then call this citing the doubt's id as resolvesDoubt.

Re-grounding mints a new answer id, so answers citing the old one go stale and heal the same way,
leaves first. Only re-affirm what you have re-checked; this call IS the vouching.
`.trim();

export const KNOWLEDGE_GAPS_DESCRIPTION = `
What is not yet understood here: symbols whose recorded knowledge is missing or gone doubtful.

With a root symbol, the dependency tree beneath it comes back LEAVES FIRST, mapping what you are
about to lean on. Answer the rows in order with record_answer, so every parent can lean on its
children.

With no root, the workspace's gaps by measured demand, stale answers first.

Answered entries drop out. Keep calling until it returns empty.
`.trim();

export const SYMBOL_FACTS_DESCRIPTION = `
Every indexed fact about one symbol, each with an id that can be cited and later re-checked.

The declaration, the references, the literals written inside it, and the imports that resolve to it.

Each id is a digest of that fact's own contents, so an id that stops resolving is exactly a fact
that changed.

Use when you want the evidence rather than a summary, or when you intend to record WHY.
`.trim();

export const TYPE_OF_DESCRIPTION = `
What type a symbol actually has, including when the source never says.

Says which of three it is: declared in source, inferred with the basis stated, or unknown with a
reason. Unknown is a real answer, never a failure.

Use for anything unannotated, where the declaration tells you nothing.
`.trim();

////////////////////////////////
//  Functions & Helpers

function text(body: string, isError = false): ToolResult {
	return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

/**
 * Says so when an answer came from an index that is still being built.
 *
 * The daemon serves before its first scan finishes, so that a session gets answers immediately
 * rather than waiting out a whole workspace. That trade is only honest if a partial answer says it
 * is partial: without this line, "no references found" during a scan is indistinguishable from
 * the same sentence once everything has been read.
 *
 * Every ABSENCE goes through here, including "no symbol named X is indexed". That one is the most
 * common answer of all during a cold scan, and the first version of this missed it.
 */
async function withIndexState(backend: ToolBackend, body: string): Promise<string> {
	const status = await backend.indexStatus();
	const failureNote =
		status.failures === 0
			? ""
			: `\n\n${status.failures} file${status.failures === 1 ? "" : "s"} failed to parse; prior facts were kept.`;
	if (status.state === "ready") return `${body}${failureNote}`;

	// A scan in progress over an index that already holds files is a REFRESH, not a cold build. The
	// answer came from a complete previous scan, and calling that incomplete is its own dishonesty:
	// a daemon restart would otherwise stamp every correct answer as unreliable.
	if (status.stored > 0) {
		return `${body}\n\nAnswered from an index of ${status.stored} files. A rescan is in progress (${status.done} of ${status.total}), so anything edited since the last scan may not be reflected.${failureNote}`;
	}
	if (status.state === "indexing") {
		return `${body}\n\nStill indexing: ${status.done} of ${status.total} files read. This answer may be incomplete.${failureNote}`;
	}
	return `${body}\n\nThe index has not been built yet, so this answer covers nothing.${failureNote}`;
}

/**
 * Resolve what the caller gave into one symbol id.
 *
 * Several matches is an answer, not a failure: the caller is told which ones exist so it can pick,
 * rather than being handed a confident description of whichever happened to be first.
 */
async function resolveOne(backend: ToolBackend, args: SymbolArgs): Promise<{ symbolId: string } | { problem: string }> {
	if (args.symbolId) return { symbolId: args.symbolId };
	if (!args.name) return { problem: "Give either symbolId or name." };

	const candidates = await backend.findByName(args.name, args.module);
	if (candidates.length === 0) return { problem: `No symbol named ${args.name} is indexed.` };
	if (candidates.length > 1) return { problem: renderCandidates(args.name, candidates) };
	return { symbolId: (candidates[0] as SymbolSummary).symbolId };
}

////////////////////////////////
//  Handlers

export async function describeSymbol(backend: ToolBackend, args: SymbolArgs): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	const described = await backend.describe(resolved.symbolId);
	// An absence claim is the one that has to know how much was read, so it carries the state and
	// the successful answer does not. The copy-verbatim hint earns its place: an id's trailing
	// period is invisible next to sentence punctuation, and one agent burned five calls learning it.
	if (!described)
		return text(
			await withIndexState(
				backend,
				`No symbol with id ${resolved.symbolId} is indexed. Ids must be copied verbatim from an "id ..." line or a gaps row, including any trailing period.`,
			),
			true,
		);

	// The knowledge line rides on every describe: recorded prose when it exists, one line of
	// invitation when it does not. The recall itself counts the miss, which is what feeds the
	// gap ledger with real demand rather than guesses.
	const recalled = await backend.recallAnswer(resolved.symbolId, "describe");
	return text(`${renderDescribe(described)}\n${renderKnowledge(recalled)}`);
}

export async function findReferences(
	backend: ToolBackend,
	args: SymbolArgs & { limit?: number | undefined },
): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	const found = await backend.findReferences(resolved.symbolId, args.limit);
	return text(await withIndexState(backend, renderReferences(found)));
}

export async function typeOfSymbol(backend: ToolBackend, args: SymbolArgs): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	const type = await backend.typeOf(resolved.symbolId);
	// The name is only for the rendered line, so falling back to the id keeps the answer readable
	// when the caller passed an id and never told us a name.
	return text(renderType(args.name ?? resolved.symbolId, type));
}

export async function prepareRename(backend: ToolBackend, args: SymbolArgs & { newName: string }): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	const plan = await backend.prepareRename(resolved.symbolId, args.newName);
	// A blocked plan is an error result: the caller asked whether it could rename, and the answer
	// is no. Warnings are not, since the caller can weigh those and proceed.
	return text(await withIndexState(backend, renderRenamePlan(plan)), plan.blockers.length > 0);
}

export async function renameSymbol(backend: ToolBackend, args: SymbolArgs & { newName: string }): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	const outcome = await backend.renameSymbol(resolved.symbolId, args.newName);
	return text(await withIndexState(backend, renderRenameOutcome(outcome)), !outcome.renamed);
}

export async function findLiterals(
	backend: ToolBackend,
	args: LiteralQuery & { limit?: number | undefined },
): Promise<ToolResult> {
	try {
		const found = await backend.findLiterals(args);
		return text(await withIndexState(backend, renderLiterals(found)));
	} catch (error) {
		// A bad regex is the caller's mistake and worth saying plainly, rather than an empty result
		// that reads as "nothing matched".
		return text(error instanceof Error ? error.message : String(error), true);
	}
}

export async function overview(backend: ToolBackend): Promise<ToolResult> {
	return text(renderOverview(await backend.overview()));
}

export async function searchSymbols(
	backend: ToolBackend,
	args: { text: string; kind?: string | undefined; module?: string | undefined; limit?: number | undefined },
): Promise<ToolResult> {
	const found = await backend.searchSymbols(args.text, args);
	return text(await withIndexState(backend, renderSymbolSearch(found)));
}

export async function outlineModule(backend: ToolBackend, args: { module: string }): Promise<ToolResult> {
	return text(await withIndexState(backend, renderOutline(args.module, await backend.outlineModule(args.module))));
}

export async function findImports(
	backend: ToolBackend,
	args: { specifier?: string | undefined; module?: string | undefined; limit?: number | undefined },
): Promise<ToolResult> {
	try {
		return text(await withIndexState(backend, renderImports(await backend.findImports(args))));
	} catch (error) {
		return text(error instanceof Error ? error.message : String(error), true);
	}
}

export async function hubs(backend: ToolBackend, args: { limit?: number | undefined }): Promise<ToolResult> {
	return text(await withIndexState(backend, renderHubs(await backend.hubs(args.limit))));
}

export async function coChangedWith(
	backend: ToolBackend,
	args: { module: string; limit?: number | undefined },
): Promise<ToolResult> {
	return text(renderCoChange(await backend.coChangedWith(args.module, args.limit)));
}

export async function typeHierarchy(backend: ToolBackend, args: SymbolArgs): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	return text(await withIndexState(backend, renderHierarchy(await backend.typeHierarchy(resolved.symbolId))));
}

export async function fileHistory(backend: ToolBackend, args: { module: string }): Promise<ToolResult> {
	return text(renderFileHistory(await backend.fileHistory(args.module)));
}

export async function recordAnswer(
	backend: ToolBackend,
	args: {
		symbolId: string;
		question: QuestionClass;
		prose: string;
		citations: string[];
		model?: string | undefined;
		resolvesDoubt?: string | undefined;
		omitting?: string | undefined;
	},
): Promise<ToolResult> {
	const outcome = await backend.recordAnswer(args.symbolId, args.question, args.prose, args.citations, {
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.resolvesDoubt === undefined ? {} : { resolvesDoubt: args.resolvesDoubt }),
		...(args.omitting === undefined ? {} : { omitting: args.omitting }),
	});
	return text(renderRecordOutcome(outcome), !outcome.recorded);
}

export async function recallAnswer(
	backend: ToolBackend,
	args: SymbolArgs & { question?: QuestionClass | undefined },
): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	const recalled =
		args.question === undefined
			? await backend.recallAnswers(resolved.symbolId)
			: [await backend.recallAnswer(resolved.symbolId, args.question)].filter(
					(r): r is RecalledAnswer => r !== null,
				);
	if (recalled.length === 0) {
		const which = args.question === undefined ? "Nothing is" : `No ${args.question} answer is`;
		return text(
			await withIndexState(
				backend,
				`${which} recorded about ${resolved.symbolId}. record_answer writes one, citing ids from symbol_facts.`,
			),
			true,
		);
	}
	return text(recalled.map((answer) => renderKnowledge(answer)).join("\n"));
}

export async function invalidateAnswer(
	backend: ToolBackend,
	args: SymbolArgs & { reason: string; question?: QuestionClass | undefined; by?: string | undefined },
): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	const outcome = await backend.invalidateAnswer(resolved.symbolId, args.reason, args.question, args.by);
	return text(renderInvalidateOutcome(outcome), outcome.refused !== undefined);
}

export async function reaffirmAnswer(
	backend: ToolBackend,
	args: SymbolArgs & {
		question: QuestionClass;
		citations?: string[] | undefined;
		model?: string | undefined;
		resolvesDoubt?: string | undefined;
	},
): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	const outcome = await backend.reaffirmAnswer(resolved.symbolId, args.question, {
		...(args.citations === undefined ? {} : { citations: args.citations }),
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.resolvesDoubt === undefined ? {} : { resolvesDoubt: args.resolvesDoubt }),
	});
	return text(renderRecordOutcome(outcome), !outcome.recorded);
}

export async function knowledgeGaps(
	backend: ToolBackend,
	args: SymbolArgs & { question?: QuestionClass | undefined; limit?: number | undefined },
): Promise<ToolResult> {
	// A root is optional here, unlike every other symbol-taking tool: no root means the workspace.
	let root: string | undefined;
	if (args.symbolId !== undefined || args.name !== undefined) {
		const resolved = await resolveOne(backend, args);
		if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);
		root = resolved.symbolId;
	}

	const gaps = await backend.knowledgeGaps(root, args.question, args.limit);
	return text(await withIndexState(backend, renderKnowledgeGaps(gaps, root)));
}

export async function symbolHistory(
	backend: ToolBackend,
	args: { name: string; limit?: number | undefined },
): Promise<ToolResult> {
	return text(renderMentions(await backend.commitsMentioning(args.name, args.limit)));
}

export async function symbolFacts(
	backend: ToolBackend,
	args: SymbolArgs & { limit?: number | undefined },
): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	const facts = await backend.factsFor(resolved.symbolId, args.limit);
	if (facts === null)
		return text(await withIndexState(backend, `No symbol with id ${resolved.symbolId} is indexed.`), true);
	return text(await withIndexState(backend, renderFacts(facts)));
}

export async function graphOf(backend: ToolBackend, args: SymbolArgs): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem), true);

	return text(
		await withIndexState(
			backend,
			renderGraph(args.name ?? resolved.symbolId, await backend.graphOf(resolved.symbolId)),
		),
	);
}

export async function resolveImport(
	backend: ToolBackend,
	args: { fromModule: string; specifier: string },
): Promise<ToolResult> {
	const resolution = await backend.resolveImport(args.fromModule, args.specifier);

	if (resolution.status === "resolved") return text(`${args.specifier} resolves to ${resolution.module}`);
	if (resolution.status === "external") {
		const version = resolution.version ? `@${resolution.version}` : "";
		return text(`${args.specifier} is external: ${resolution.packageName}${version}`);
	}
	// Not an error: a specifier nothing resolves is a finding, and the reason says whose limit it is.
	return text(`${args.specifier} did not resolve (${resolution.reason})${detailOf(resolution)}`);
}

function detailOf(resolution: ImportResolution): string {
	return resolution.status === "unresolved" && resolution.detail ? `: ${resolution.detail}` : "";
}
