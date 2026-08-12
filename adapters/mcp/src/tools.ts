// The structural tools, all of them read-only.
//
// Descriptions are written for the bar an agent actually applies: it already has grep and read,
// both free, so a tool earns a call only by doing something they cannot. Each description says
// what that is.

import type {
	DescribeResult,
	FactSet,
	FileHistory,
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
} from "@nyaa-lexicon/core";
import { compileSearchRegex } from "@nyaa-lexicon/core";
import type { ImportResolution, TypeInfo } from "@nyaa-lexicon/protocol";
import { z } from "zod";
import {
	renderCandidates,
	renderCoChange,
	renderDescribe,
	renderFacts,
	renderFileHistory,
	renderImports,
	renderInvalidateOutcome,
	renderKnowledge,
	renderKnowledgeGaps,
	renderLiterals,
	renderMentions,
	renderMostReferenced,
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
	coChangedWith: (module: string, limit?: number) => Promise<CoChangeResult>;
	searchSymbols: (
		text: string | undefined,
		options: {
			regex?: string | undefined;
			kind?: string | undefined;
			module?: string | undefined;
			limit?: number | undefined;
		},
	) => Promise<SearchResult>;
	outlineModule: (module: string) => Promise<Array<SymbolSummary & { containerId?: string }>>;
	findImports: (query: {
		specifier?: string | undefined;
		specifierRegex?: string | undefined;
		module?: string | undefined;
		moduleRegex?: string | undefined;
		limit?: number | undefined;
	}) => Promise<ImportsResult>;
	hubs: (limit?: number) => Promise<
		Array<{
			symbolId: string;
			count: number;
			declaration: SymbolSummary | null;
		}>
	>;
	overview: () => Promise<OverviewResult>;
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
	text: string | undefined;
	regex?: string;
	symbols: SymbolSummary[];
	total: number;
	truncated: boolean;
}

export interface ImportsResult {
	query: {
		specifier?: string | undefined;
		specifierRegex?: string | undefined;
		module?: string | undefined;
		moduleRegex?: string | undefined;
		limit?: number | undefined;
	};
	imports: StoredImport[];
	total: number;
	truncated: boolean;
	scanIncomplete?: boolean;
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
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
};

export const FindReferencesInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
	limit: z.number().int().positive().max(500).optional().describe(`Maximum results. Default: \`50\`.`),
};

export const ResolveImportInput = {
	fromModule: z.string().min(1).describe(`Workspace-relative importer path.`),
	specifier: z.string().min(1).describe(`Import specifier as written.`),
};

export const TypeOfInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
};

export const FindLiteralsInput = {
	value: z.string().optional().describe(`Exact decoded value.`),
	regex: z.string().min(1).optional().describe(`Regex literal, for example \`/^cycle/i\`.`),
	kind: z
		.enum(["string", "number", "boolean"])
		.optional()
		.describe(`Literal kind. Defaults to \`string\` for regex.`),
	min: z.number().optional().describe(`Inclusive numeric minimum.`),
	max: z.number().optional().describe(`Inclusive numeric maximum.`),
	limit: z.number().int().positive().max(500).optional().describe(`Maximum results. Default: \`50\`.`),
};

export const SearchSymbolsInput = {
	text: z.string().min(1).optional().describe(`Case-sensitive name substring. Use instead of \`regex\`.`),
	regex: z.string().min(1).optional().describe(`Regex literal. Use instead of \`text\`.`),
	kind: z.string().min(1).optional().describe(`Declaration kind filter.`),
	module: z.string().min(1).optional().describe(`Module path substring.`),
	limit: z.number().int().positive().max(300).optional().describe(`Maximum results. Default: \`50\`.`),
};

export const OutlineModuleInput = {
	module: z.string().min(1).describe(`Workspace-relative file path.`),
};

export const FindImportsInput = {
	specifier: z.string().min(1).optional().describe(`Written import-specifier substring.`),
	specifierRegex: z.string().min(1).optional().describe(`Regex for written import specifiers.`),
	module: z.string().min(1).optional().describe(`Resolved workspace-relative module path.`),
	moduleRegex: z.string().min(1).optional().describe(`Regex for resolved module paths.`),
	limit: z.number().int().positive().max(300).optional().describe(`Maximum results. Default: \`50\`.`),
};

export const MostReferencedInput = {
	limit: z.number().int().positive().max(100).optional().describe(`Maximum results. Default: \`20\`.`),
};

export const OverviewInput = {};

export const CoChangedWithInput = {
	module: z.string().min(1).describe(`Workspace-relative file path.`),
	limit: z.number().int().positive().max(100).optional().describe(`Maximum results. Default: \`20\`.`),
};

export const FileHistoryInput = {
	module: z.string().min(1).describe(`Workspace-relative file path.`),
};

export const SymbolHistoryInput = {
	name: z.string().min(1).describe(`Case-sensitive symbol name. Minimum \`3\` characters.`),
	limit: z.number().int().positive().max(100).optional().describe(`Maximum results. Default: \`20\`.`),
};

const QUESTIONS = ["describe", "why", "relate", "contract", "effects", "usage"] as const;

export const RecordAnswerInput = {
	symbolId: z.string().min(1).describe(`Exact \`symbolId\` from an earlier result.`),
	question: z.enum(QUESTIONS).describe(`Answer category for \`prose\`.`),
	prose: z
		.string()
		.min(1)
		.describe(
			`
			Answer in \`1\` or \`2\` sentences. State what the citations establish.
			`.trim(),
		),
	citations: z
		.array(z.string().min(1))
		.min(1)
		.describe(
			`
			Current full fact IDs from \`symbol_facts\`.
			`.trim(),
		),
	model: z.string().min(1).optional().describe(`Author or model name.`),
	resolvesDoubt: z
		.string()
		.min(1)
		.optional()
		.describe(
			`
			Doubt ID from \`recall_answer\`. Omit to carry it forward.
			`.trim(),
		),
	omitting: z.string().min(1).optional().describe(`Why an existing citation is omitted.`),
};

export const RecallAnswerInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Add \`module\` when needed.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative module path.`),
	question: z.enum(QUESTIONS).optional().describe(`Answer category. Omit to show every answer.`),
};

export const InvalidateAnswerInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Add \`module\` when needed.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative module path.`),
	reason: z.string().min(1).describe(`Reason for the doubt.`),
	question: z.enum(QUESTIONS).optional().describe(`Answer category. Omit to doubt every recorded answer.`),
	by: z.string().min(1).optional().describe(`Author declaring the doubt.`),
};

export const ReaffirmAnswerInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Add \`module\` when needed.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative module path.`),
	question: z.enum(QUESTIONS).describe(`Answer category to refresh.`),
	citations: z
		.array(z.string().min(1))
		.optional()
		.describe(
			`
			Current full fact IDs from \`symbol_facts\`. Omit when only clearing a doubt.
			`.trim(),
		),
	model: z.string().min(1).optional().describe(`Author or model name.`),
	resolvesDoubt: z.string().min(1).optional().describe(`Doubt ID from \`recall_answer\`.`),
};

export const KnowledgeGapsInput = {
	name: z.string().min(1).optional().describe(`Root symbol name. Omit for workspace gaps.`),
	symbolId: z.string().min(1).optional().describe(`Exact root \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative module path.`),
	question: z.enum(QUESTIONS).optional().describe(`Answer category. Defaults to \`describe\`.`),
	limit: z.number().int().positive().max(300).optional().describe(`Maximum gaps. Default: \`60\`.`),
};

export const SymbolFactsInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Add \`module\` when needed.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative module path.`),
	limit: z.number().int().positive().max(200).optional().describe(`Maximum facts per kind. Default: \`40\`.`),
};

export const PrepareRenameInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
	newName: z.string().min(1).describe(`Replacement symbol name.`),
};

////////////////////////////////
//  Constants

export const DESCRIBE_DESCRIPTION = `
# \`describe_symbol\`

Show a symbol's declaration, members, type hierarchy, dependencies, usage, and recorded knowledge.

Use \`symbolId\` when known. Otherwise use \`name\`, adding \`module\` when needed.
`.trim();

export const REFERENCES_DESCRIPTION = `
# \`find_references\`

List every bound use, grouped by file. Follows aliases and re-exports.

Excludes import and export statements. Call \`prepare_rename\` before a rewrite.
`.trim();

export const RESOLVE_IMPORT_DESCRIPTION = `
# \`resolve_import\`

Resolve an import specifier through path mappings, package exports, and re-exports.

Distinguishes workspace files, external dependencies, and unresolved specifiers. Unresolved is a result, not an error.
`.trim();

export const PREPARE_RENAME_DESCRIPTION = `
# \`prepare_rename\`

Preview a rename across every bound declaration and use.

Groups touched files and reports unbound spelling matches or export limits.
`.trim();

export const RENAME_SYMBOL_DESCRIPTION = `
# \`rename_symbol\`

Rename a bound symbol across declarations, uses, imports, and re-exports.

Writes files and reindexes them. A blocked plan writes nothing. Call \`prepare_rename\` first.
`.trim();

export const FIND_LITERALS_DESCRIPTION = `
# \`find_literals\`

Find exact values, regex matches, or numeric ranges in decoded literal values.

Use for values rather than textual spelling. Each hit includes its declaration.
`.trim();

export const OVERVIEW_DESCRIPTION = `
# \`overview\`

Summarize selected workspaces: files, symbols, references, imports, literals, largest modules, knowledge, and index coverage.

Use first in an unfamiliar codebase.
`.trim();

export const SEARCH_SYMBOLS_DESCRIPTION = `
# \`search_symbols\`

Find declared names by substring or regular expression. Set exactly one of \`text\` or \`regex\`.

Does not search comments, strings, or aliases.
`.trim();

export const OUTLINE_MODULE_DESCRIPTION = `
# \`outline_module\`

List indexed declarations in a file, nested by container.

Use for source shape without reading bodies.
`.trim();

export const FIND_IMPORTS_DESCRIPTION = `
# \`find_imports\`

Find importers by written specifier or resolved module path. Use substring, exact path, or regex.

Set exactly one of \`specifier\`, \`specifierRegex\`, \`module\`, or \`moduleRegex\`. Uses the import graph across languages.
`.trim();

export const MOST_REFERENCED_DESCRIPTION = `
# \`most_referenced\`

Rank symbols by resolved reference count.
`.trim();

export const CO_CHANGED_WITH_DESCRIPTION = `
# \`co_changed_with\`

Find files edited with a target in Git history.

Each row shows a paired change count and share.
`.trim();

export const FILE_HISTORY_DESCRIPTION = `
# \`file_history\`

Show Git age and line churn for a file.

Reports the history window.
`.trim();

export const SYMBOL_HISTORY_DESCRIPTION = `
# \`symbol_history\`

Find Git commits whose subject names a symbol.

Matches case and word boundaries. Includes changed-file counts.
`.trim();

export const RECORD_ANSWER_DESCRIPTION = `
# \`record_answer\`

Save a cited answer for a symbol.

Use current full IDs from \`symbol_facts\`. Supporting changes make the answer stale.
`.trim();

export const RECALL_ANSWER_DESCRIPTION = `
# \`recall_answer\`

Show recorded answers and their health.

Reports \`STALE\`, \`SHAKY\`, and \`DOUBTED\`.
`.trim();

export const INVALIDATE_ANSWER_DESCRIPTION = `
# \`invalidate_answer\`

Mark recorded answers doubtful without changing their prose.

The doubt reopens demand in \`knowledge_gaps\`.
`.trim();

export const REAFFIRM_ANSWER_DESCRIPTION = `
# \`reaffirm_answer\`

Refresh an answer's citations or clear its doubt.

Use \`resolvesDoubt\` to clear a doubt.
`.trim();

export const KNOWLEDGE_GAPS_DESCRIPTION = `
# \`knowledge_gaps\`

List missing, stale, or doubted answers.

With a root, list dependency gaps leaves first.

Use \`symbol_facts\`, then \`record_answer\` to close a gap.
`.trim();

export const SYMBOL_FACTS_DESCRIPTION = `
# \`symbol_facts\`

Show a symbol's declaration and supporting facts with citable IDs.

Use the IDs as citations for \`record_answer\`.
`.trim();

export const TYPE_OF_DESCRIPTION = `
# \`type_of\`

Show a symbol's resolved type.

Distinguishes declared, inferred, and unknown results.
`.trim();

////////////////////////////////
//  Functions & Helpers

function text(body: string, isError = false): ToolResult {
	return {
		content: [{ type: "text", text: body }],
		...(isError ? { isError: true } : {}),
	};
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
			: `${status.failures} file${status.failures === 1 ? "" : "s"} failed to parse; prior facts were kept.`;
	const withFailure = (answer: string) => (failureNote === "" ? answer : `${answer}\n\n> ${failureNote}`);
	if (status.state === "ready") return withFailure(body);

	// A scan in progress over an index that already holds files is a REFRESH, not a cold build. The
	// answer came from a complete previous scan, and calling that incomplete is its own dishonesty:
	// a daemon restart would otherwise stamp every correct answer as unreliable.
	if (status.stored > 0) {
		return withFailure(
			`${body}\n\n> Answered from an index of ${status.stored} files. A rescan is in progress (${status.done} of ${status.total}), so anything edited since the last scan may not be reflected.`,
		);
	}
	if (status.state === "indexing") {
		return withFailure(
			`${body}\n\n> Still indexing: ${status.done} of ${status.total} files read. This answer may be incomplete.`,
		);
	}
	return withFailure(`${body}\n\n> The index has not been built yet, so this answer covers nothing.`);
}

/**
 * Resolve what the caller gave into one symbol id.
 *
 * Several matches is an answer, not a failure: the caller is told which ones exist so it can pick,
 * rather than being handed a confident description of whichever happened to be first.
 */
async function resolveOne(backend: ToolBackend, args: SymbolArgs): Promise<{ symbolId: string } | { problem: string }> {
	if (args.symbolId) return { symbolId: args.symbolId };
	if (!args.name) return { problem: "Give either `symbolId` or `name`." };

	const candidates = await backend.findByName(args.name, args.module);
	if (candidates.length === 0) return { problem: `No symbol named \`${args.name}\` is indexed.` };
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
				`No symbol with ID \`${resolved.symbolId}\` is indexed. Copy IDs verbatim from a result row.`,
			),
			true,
		);

	// The knowledge line rides on every describe: recorded prose when it exists, one line of
	// invitation when it does not. The recall itself counts the miss, which is what feeds the
	// gap ledger with real demand rather than guesses.
	const recalled = await backend.recallAnswer(resolved.symbolId, "describe");
	return text(`${renderDescribe(described)}\n\n${renderKnowledge(recalled, "describe")}`);
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
	args: {
		text?: string | undefined;
		regex?: string | undefined;
		kind?: string | undefined;
		module?: string | undefined;
		limit?: number | undefined;
	},
): Promise<ToolResult> {
	if ((args.text === undefined) === (args.regex === undefined)) {
		return text("Set exactly one of `text` or `regex`.", true);
	}
	if (args.regex !== undefined) {
		try {
			compileSearchRegex(args.regex);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
	}
	const found = await backend.searchSymbols(args.text, args);
	return text(await withIndexState(backend, renderSymbolSearch(found)));
}

export async function outlineModule(backend: ToolBackend, args: { module: string }): Promise<ToolResult> {
	return text(await withIndexState(backend, renderOutline(args.module, await backend.outlineModule(args.module))));
}

export async function findImports(
	backend: ToolBackend,
	args: {
		specifier?: string | undefined;
		specifierRegex?: string | undefined;
		module?: string | undefined;
		moduleRegex?: string | undefined;
		limit?: number | undefined;
	},
): Promise<ToolResult> {
	const targets = [args.specifier, args.specifierRegex, args.module, args.moduleRegex].filter(
		(value) => value !== undefined,
	).length;
	if (targets !== 1) {
		return text("Set exactly one of `specifier`, `specifierRegex`, `module`, or `moduleRegex`.", true);
	}
	for (const regex of [args.specifierRegex, args.moduleRegex]) {
		if (regex === undefined) continue;
		try {
			compileSearchRegex(regex);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
	}
	try {
		return text(await withIndexState(backend, renderImports(await backend.findImports(args))));
	} catch (error) {
		return text(error instanceof Error ? error.message : String(error), true);
	}
}

export async function mostReferenced(backend: ToolBackend, args: { limit?: number | undefined }): Promise<ToolResult> {
	return text(await withIndexState(backend, renderMostReferenced(await backend.hubs(args.limit))));
}

export async function coChangedWith(
	backend: ToolBackend,
	args: { module: string; limit?: number | undefined },
): Promise<ToolResult> {
	return text(renderCoChange(await backend.coChangedWith(args.module, args.limit)));
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
				`${which} recorded about ${resolved.symbolId}. \`record_answer\` writes one, citing ids from \`symbol_facts\`.`,
			),
			true,
		);
	}
	return text(recalled.map((answer) => renderKnowledge(answer)).join("\n\n"));
}

export async function invalidateAnswer(
	backend: ToolBackend,
	args: SymbolArgs & {
		reason: string;
		question?: QuestionClass | undefined;
		by?: string | undefined;
	},
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
	args: SymbolArgs & {
		question?: QuestionClass | undefined;
		limit?: number | undefined;
	},
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
		return text(await withIndexState(backend, `No symbol with ID \`${resolved.symbolId}\` is indexed.`), true);
	return text(await withIndexState(backend, renderFacts(facts)));
}

export async function resolveImport(
	backend: ToolBackend,
	args: { fromModule: string; specifier: string },
): Promise<ToolResult> {
	const resolution = await backend.resolveImport(args.fromModule, args.specifier);

	if (resolution.status === "resolved") {
		return text(`# Import resolved\n\n\`${args.specifier}\` resolves to \`${resolution.module}\`.`);
	}
	if (resolution.status === "external") {
		const version = resolution.version ? `@${resolution.version}` : "";
		return text(
			`# External import\n\n\`${args.specifier}\` is external.\n\n- Package: \`${resolution.packageName}${version}\``,
		);
	}
	// Not an error: a specifier nothing resolves is a finding, and the reason says whose limit it is.
	return text(
		`# Import unresolved\n\n\`${args.specifier}\` did not resolve.\n\n- Reason: ${resolution.reason}${detailOf(resolution)}`,
	);
}

function detailOf(resolution: ImportResolution): string {
	return resolution.status === "unresolved" && resolution.detail ? `: ${resolution.detail}` : "";
}
