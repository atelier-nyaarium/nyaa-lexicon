// The structural tools, all of them read-only.
//
// Descriptions are written for the bar an agent actually applies: it already has grep and read,
// both free, so a tool earns a call only by doing something they cannot. Each description says
// what that is.

import type {
	CommentQuery,
	CommentsResult,
	ContentTotals,
	DescribeResult,
	DocQuery,
	DocsResult,
	FactSet,
	FileHistory,
	FileNotes,
	IndexStatus,
	InvalidateOutcome,
	KnowledgeGaps,
	LiteralQuery,
	LiteralsResult,
	MovePlan,
	QuestionClass,
	RecalledAnswer,
	RecordOutcome,
	RefactorIssue,
	ReferencesResult,
	RenamePlan,
	SymbolSource,
	SymbolSummary,
	TransactionStatus,
} from "@nyaa-lexicon/core";
import { compileSearchRegex, searchTerm } from "@nyaa-lexicon/core";
import type {
	CoChangedWithResult,
	CommitsMentioningResult,
	FindImportsResult,
	ImportResolution,
	InsertOutcome,
	MostReferencedResult,
	MoveOutcome,
	RefactorCommitResult,
	RefactorRevertResult,
	RefactorStartResult,
	RefactorTrackResult,
	RefactorUndoResult,
	RenameStepOutcome,
	ReplaceOutcome,
	SearchSymbolsResult,
	TypeInfo,
} from "@nyaa-lexicon/protocol";
import { parseSymbolId } from "@nyaa-lexicon/protocol";
import { z } from "zod";
import {
	renderCandidates,
	renderCoChange,
	renderComments,
	renderDescribe,
	renderDocs,
	renderFacts,
	renderFileHistory,
	renderImports,
	renderInsertOutcome,
	renderInvalidateOutcome,
	renderKnowledge,
	renderKnowledgeGaps,
	renderLiterals,
	renderMentions,
	renderMostReferenced,
	renderMoveOutcome,
	renderMovePlan,
	renderOutline,
	renderOverview,
	renderRecordOutcome,
	renderRefactorCommit,
	renderRefactorStart,
	renderRefactorStatus,
	renderReferences,
	renderRenamePlan,
	renderRenameStep,
	renderReplaceOutcome,
	renderSymbolSearch,
	renderSymbolSource,
	renderType,
} from "./render.js";

////////////////////////////////
//  Interfaces & Types

/** What a tool needs from the daemon. Injected, so the tools are testable without one. */
export interface ToolBackend {
	findByName: (name: string, module?: string) => Promise<SymbolSummary[]>;
	describe: (symbolId: string) => Promise<DescribeResult | null>;
	findReferences: (symbolId: string, limit?: number, within?: string) => Promise<ReferencesResult>;
	resolveImport: (fromModule: string, specifier: string) => Promise<ImportResolution>;
	typeOf: (symbolId: string) => Promise<TypeInfo>;
	symbolSource: (address: { symbolId?: string | undefined; factId?: string | undefined }) => Promise<SymbolSource>;
	refactorStart: () => Promise<RefactorStartResult>;
	refactorStatus: () => Promise<TransactionStatus>;
	prepareRename: (symbolId: string, newName: string) => Promise<RenamePlan>;
	planMove: (symbolId: string, toModule: string) => Promise<MovePlan>;
	refactorTrack: (module: string) => Promise<RefactorTrackResult>;
	refactorUndo: () => Promise<RefactorUndoResult>;
	refactorRevert: () => Promise<RefactorRevertResult>;
	refactorCommit: (force?: boolean) => Promise<RefactorCommitResult>;
	refactorReplace: (args: {
		symbolId?: string | undefined;
		factId?: string | undefined;
		newText: string;
	}) => Promise<ReplaceOutcome>;
	refactorInsert: (args: {
		after?: string | undefined;
		module?: string | undefined;
		text: string;
	}) => Promise<InsertOutcome>;
	refactorMove: (symbolId: string, toModule: string) => Promise<MoveOutcome>;
	refactorRename: (symbolId: string, newName: string) => Promise<RenameStepOutcome>;
	indexStatus: (concerning?: string) => Promise<IndexStatus>;
	findLiterals: (query: LiteralQuery & { limit?: number | undefined }) => Promise<LiteralsResult>;
	findComments: (query: CommentQuery & { limit?: number | undefined }) => Promise<CommentsResult>;
	findDocs: (query: DocQuery & { limit?: number | undefined }) => Promise<DocsResult>;
	coChangedWith: (module: string, limit?: number) => Promise<CoChangedWithResult>;
	searchSymbols: (
		text: string | undefined,
		options: {
			regex?: string | undefined;
			kind?: string | undefined;
			module?: string | undefined;
			limit?: number | undefined;
			within?: string | undefined;
		},
	) => Promise<SearchSymbolsResult>;
	outlineModule: (module: string) => Promise<SymbolSummary[]>;
	fileNotes: (module: string) => Promise<FileNotes>;
	findImports: (query: {
		specifier?: string | undefined;
		specifierRegex?: string | undefined;
		module?: string | undefined;
		moduleRegex?: string | undefined;
		limit?: number | undefined;
	}) => Promise<FindImportsResult>;
	hubs: (limit?: number) => Promise<MostReferencedResult>;
	overview: () => Promise<OverviewResult>;
	fileHistory: (module: string) => Promise<FileHistory>;
	factsFor: (symbolId: string, limit?: number) => Promise<FactSet | null>;
	commitsMentioning: (name: string, limit?: number) => Promise<CommitsMentioningResult>;
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
	knowledgeGaps: (root?: string, question?: QuestionClass, limit?: number, module?: string) => Promise<KnowledgeGaps>;
}

/** The backend's overview, with every section past the counts optional so a stub can omit it. */
export interface OverviewResult {
	files: number;
	symbols: number;
	references: number;
	imports: number;
	literals: number;
	symbolsByKind?: Record<string, number>;
	/** Files and symbols per content class, including the separate plain-text row. */
	content?: ContentTotals;
	modules: number;
	scope: string;
	index: IndexStatus;
	/** Code modules, largest first. */
	largest: Array<{ module: string; symbols: number }>;
	/** Data and document files, largest first, each saying which. */
	largestData?: Array<{ module: string; symbols: number; content: "data" | "document" }>;
	knowledge?: { answers: number; stale?: number | undefined; doubted?: number | undefined };
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

const WITHIN_NOTE = `Scope: a symbol id from an earlier result, or a declaration name. An ambiguous name is refused with its candidates.`;

export const FindReferencesInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
	limit: z.number().int().positive().max(500).optional().describe(`Maximum results. Default: \`50\`.`),
	within: z.string().min(1).optional().describe(WITHIN_NOTE),
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

export const SymbolSourceInput = {
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	factId: z.string().min(1).optional().describe(`A literal's \`factId\` from \`find_literals\`.`),
};

export const RefactorTrackInput = {
	module: z.string().min(1).describe(`Workspace-relative path you are about to edit by hand.`),
};

export const RefactorCommitInput = {
	force: z.boolean().optional().describe(`Commit despite outstanding issues.`),
};

export const RefactorReplaceInput = {
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	factId: z.string().min(1).optional().describe(`A literal's \`factId\` from \`find_literals\`.`),
	newText: z.string().min(1).describe(`Replacement for the whole span \`symbol_source\` returned.`),
};

export const RefactorInsertInput = {
	after: z.string().min(1).optional().describe(`Sibling anchor: the declaration goes directly after this symbol.`),
	module: z
		.string()
		.min(1)
		.optional()
		.describe(`Append at top level of this module instead; created if absent. Set exactly one anchor.`),
	text: z.string().min(1).describe(`The declaration(s), flush-left. Indentation is applied from the anchor.`),
};

const RE2_NOTE = `RE2 syntax: linear time, no lookaround or backreferences.`;

export const RefactorPreviewInput = {
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path, to say which \`name\`.`),
	newName: z.string().min(1).optional().describe(`Preview a rename to this name.`),
	toModule: z.string().min(1).optional().describe(`Preview a move to this module path.`),
};

export const FindLiteralsInput = {
	value: z.string().optional().describe(`Exact decoded value.`),
	regex: z.string().min(1).optional().describe(`Regex literal, for example \`/^cycle/i\`. ${RE2_NOTE}`),
	kind: z
		.enum(["string", "number", "boolean"])
		.optional()
		.describe(`Literal kind. Defaults to \`string\` for regex.`),
	min: z.number().optional().describe(`Inclusive numeric minimum.`),
	max: z.number().optional().describe(`Inclusive numeric maximum.`),
	limit: z.number().int().positive().max(500).optional().describe(`Maximum results. Default: \`50\`.`),
	key: z.string().min(1).optional().describe(`Exact immediate container name.`),
	within: z.string().min(1).optional().describe(WITHIN_NOTE),
};

export const FindCommentsInput = {
	text: z.string().min(1).optional().describe(`Substring of the prose. Use instead of \`regex\`.`),
	regex: z.string().min(1).optional().describe(`Regex literal, for example \`/TODO|FIXME/\`. ${RE2_NOTE}`),
	form: z
		.enum(["leading", "trailing", "inline", "standalone"])
		.optional()
		.describe(`Where the comment sits relative to its symbol.`),
	module: z.string().min(1).optional().describe(`Exact workspace-relative file path.`),
	limit: z.number().int().positive().max(200).optional().describe(`Maximum results. Default: \`50\`.`),
	within: z.string().min(1).optional().describe(WITHIN_NOTE),
};

export const SearchDocsInput = {
	text: z.string().min(1).optional().describe(`Substring of the prose. Use instead of \`regex\`.`),
	regex: z.string().min(1).optional().describe(`Regex literal, for example \`/TODO|FIXME/\`. ${RE2_NOTE}`),
	fenced: z.boolean().optional().describe(`\`true\` for code blocks only, \`false\` for prose only.`),
	module: z.string().min(1).optional().describe(`Exact workspace-relative file path.`),
	limit: z.number().int().positive().max(200).optional().describe(`Maximum results. Default: \`50\`.`),
};

export const SearchSymbolsInput = {
	text: z.string().min(1).optional().describe(`Case-sensitive name substring. Use instead of \`regex\`.`),
	regex: z.string().min(1).optional().describe(`Regex literal. Use instead of \`text\`. ${RE2_NOTE}`),
	kind: z.string().min(1).optional().describe(`Declaration kind filter.`),
	module: z.string().min(1).optional().describe(`Module path substring.`),
	limit: z.number().int().positive().max(300).optional().describe(`Maximum results. Default: \`50\`.`),
	within: z.string().min(1).optional().describe(WITHIN_NOTE),
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
	// Both id kinds appear in one `symbol_facts` answer, and this tool takes one of each.
	symbolId: z.string().min(1).describe(`The subject's own \`symbolId\`, never a \`lexfact\` id.`),
	question: z.enum(QUESTIONS).describe(`Answer category for \`prose\`.`),
	prose: z
		.string()
		.min(1)
		.describe(
			`State what the cited facts establish in roughly 1 to 2 concise incomplete sentences. May be longer if too complex for ≤2.`,
		),
	citations: z.array(z.string().min(1)).min(1).describe(`Current full fact IDs from \`symbol_facts\`.`),
	model: z.string().min(1).optional().describe(`Author or model name.`),
	resolvesDoubt: z.string().min(1).optional().describe(`Doubt ID from \`recall_answer\`. Omit to carry it forward.`),
	omitting: z.string().min(1).optional().describe(`Why an existing fact ID is omitted.`),
};

export const RecallAnswerInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Add \`module\` when needed.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative module path.`),
	question: z.enum(QUESTIONS).optional().describe(`Answer category. Omit to show every answer.`),
};

export const InvalidateAnswerInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Add \`module\` when needed.`),
	symbolId: z.string().min(1).optional().describe(`The subject's own \`symbolId\`, never a \`lexfact\` id.`),
	module: z.string().min(1).optional().describe(`Workspace-relative module path.`),
	reason: z.string().min(1).describe(`Reason for the doubt.`),
	question: z.enum(QUESTIONS).optional().describe(`Answer category. Omit to doubt every recorded answer.`),
	by: z.string().min(1).optional().describe(`Author declaring the doubt.`),
};

export const ReaffirmAnswerInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Add \`module\` when needed.`),
	symbolId: z.string().min(1).optional().describe(`The subject's own \`symbolId\`, never a \`lexfact\` id.`),
	module: z.string().min(1).optional().describe(`Workspace-relative module path.`),
	question: z.enum(QUESTIONS).describe(`Answer category to refresh.`),
	citations: z
		.array(z.string().min(1))
		.optional()
		.describe(`Current full fact IDs from \`symbol_facts\`. Omit when only clearing a doubt.`),
	model: z.string().min(1).optional().describe(`Author or model name.`),
	resolvesDoubt: z.string().min(1).optional().describe(`Doubt ID from \`recall_answer\`.`),
};

export const KnowledgeGapsInput = {
	name: z.string().min(1).optional().describe(`Root symbol name: the tree under it, leaves first.`),
	symbolId: z.string().min(1).optional().describe(`Exact root \`symbolId\` from an earlier result.`),
	module: z
		.string()
		.min(1)
		.optional()
		.describe(`Workspace-relative module path. Alone: that file's declarations. With \`name\`: which \`name\`.`),
	question: z.enum(QUESTIONS).optional().describe(`Answer category. Defaults to \`describe\`.`),
	limit: z.number().int().positive().max(300).optional().describe(`Maximum gaps. Default: \`60\`.`),
};

export const SymbolFactsInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Add \`module\` when needed.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative module path.`),
	limit: z.number().int().positive().max(200).optional().describe(`Maximum facts per kind. Default: \`40\`.`),
};

export const RefactorMoveInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
	toModule: z.string().min(1).describe(`Workspace-relative path to move it to. Created if absent.`),
};

export const RefactorRenameInput = {
	name: z.string().min(1).optional().describe(`Symbol name. Omit with \`symbolId\`.`),
	symbolId: z.string().min(1).optional().describe(`Exact \`symbolId\` from an earlier result.`),
	module: z.string().min(1).optional().describe(`Workspace-relative \`module\` path.`),
	newName: z.string().min(1).describe(`Replacement symbol name.`),
};

////////////////////////////////
//  Constants

export const DESCRIBE_DESCRIPTION = `
# \`describe_symbol\`

Show a symbol's declaration, members, type hierarchy, dependencies, usage, notes and recorded
knowledge.

Documentation is the comment above it. Notes are what else was written about it: beside the code,
or inside its body.

Use \`symbolId\` when known. Otherwise use \`name\`, adding \`module\` when needed.
`.trim();

export const REFERENCES_DESCRIPTION = `
# \`find_references\`

List every bound use, grouped by file. Follows aliases and re-exports.

Excludes import and export statements. Call \`prepare_rename\` before a rewrite.

Use \`within\` to restrict references to declarations inside a scope.
`.trim();

export const RESOLVE_IMPORT_DESCRIPTION = `
# \`resolve_import\`

Resolve an import specifier through path mappings, package exports, and re-exports.

Distinguishes workspace files, external dependencies, and unresolved specifiers. Unresolved is a result, not an error.
`.trim();

export const REFACTOR_MOVE_DESCRIPTION = `
# \`refactor_move\`

Move a declaration to another module, rewriting the imports that reach it.

Creates the target if it does not exist. Imports in every referencing file are re-pointed, and the
moved body's own dependencies are imported into its new home. A site that cannot be rewritten
safely stops the whole move rather than relocating the declaration and stranding its importers.
`.trim();

export const REFACTOR_RENAME_DESCRIPTION = `
# \`refactor_rename\`

Rename a bound symbol across declarations, uses, imports, and re-exports, as a transaction step.

Nothing is written unless every occurrence can be. Recorded knowledge follows the symbol and its
members, whose ids are re-minted too. Files that only used the old name through a member are
reindexed even though their text does not change.
`.trim();

export const SYMBOL_SOURCE_DESCRIPTION = `
# \`symbol_source\`

Read one symbol's exact source text by id, without reading the file around it.

Answers with the text and the range it occupies, so a rewrite goes back where it came from. Refuses
a stale index rather than slicing a range that has moved.
`.trim();

export const REFACTOR_START_DESCRIPTION = `
# \`refactor_start\`

Open the workspace's refactor transaction, and return the rules for operating it.

Every other \`refactor_\` tool needs one open. One per workspace, shared by every session.
`.trim();

export const REFACTOR_PREVIEW_DESCRIPTION = `
# \`refactor_preview\`

What a rename or a move would touch. Read-only, no transaction.

\`newName\` previews a rename: files, sites per file, every blocker and warning.
\`toModule\` previews a move: the removal, the insertion, the imports re-pointed, and what the moved text depends on.
`.trim();

export const REFACTOR_STATUS_DESCRIPTION = `
# \`refactor_status\`

Show the open transaction: its steps, tracked files, and outstanding issues.

Answers "none open" as a result, not an error. Also how you find what another session already did.
`.trim();

export const REFACTOR_TRACK_DESCRIPTION = `
# \`refactor_track\`

Snapshot a file BEFORE you edit it by hand, so undo and revert can put it back.

An untracked edit cannot be undone and survives revert. Tracking twice keeps the first snapshot.
`.trim();

export const REFACTOR_UNDO_DESCRIPTION = `
# \`refactor_undo\`

Remove the newest step, restoring the files it wrote.

Refuses when one of those files changed since, rather than overwriting whatever changed it.
`.trim();

export const REFACTOR_COMMIT_DESCRIPTION = `
# \`refactor_commit\`

Keep what is on disk and close the transaction. Nothing is undoable afterwards.

Refuses while issues are outstanding. \`force\` accepts them deliberately.
`.trim();

export const REFACTOR_REPLACE_DESCRIPTION = `
# \`refactor_replace\`

Replace one symbol's whole span with new text, checked before it is written.

Text that does not parse is refused before touching disk. Text that parses is applied, then what it
broke is reported: symbols that vanished while other files still use them, and names that stopped
resolving. Read the span with \`symbol_source\` first and send back the edited whole.

Renaming the declaration itself is refused; use \`refactor_rename\`.
`.trim();

export const REFACTOR_INSERT_DESCRIPTION = `
# \`refactor_insert\`

Author new declaration(s) as a transaction step: after a sibling symbol, or appended to a module.

Send the text flush-left; indentation is copied from the anchor. Text that does not parse in place
is refused before touching disk. Names the new body uses that resolve to nothing are reported, and
imports are never authored for you. A retry after a timeout answers already-inserted instead of
duplicating.

Declarations only: statement positions, switch cases, and single-line layouts are refused.
`.trim();

export const REFACTOR_REVERT_DESCRIPTION = `
# \`refactor_revert\`

Return every tracked file to how the transaction found it, and close it.

Discards manual edits made since, including ones made after a step.
`.trim();

export const FIND_LITERALS_DESCRIPTION = `
# \`find_literals\`

Find exact values, regex matches, or numeric ranges in decoded literal values.

Use for values rather than textual spelling. Each hit includes its declaration.

Use \`key\` for an exact immediate container name and \`within\` for a scope.
`.trim();

export const FIND_COMMENTS_DESCRIPTION = `
# \`find_comments\`

Search comment prose: doctrine, rationale, TODOs, warnings. Each hit names the symbol it is
attached to, or the module when it is attached to none.

Matches NORMALIZED text, so markers are stripped and a wrapped sentence is one string. Search for
\`TODO\`, never \`// TODO\`.

Set exactly one of \`text\` or \`regex\`. Set neither with \`form\` or \`module\` to list a slice.

Use \`within\` to restrict comments to anchored declarations inside a scope.

Indexed files only. An unclaimed file, or a language whose provider has no comment tier, is
invisible here. Use ripgrep for an exhaustive byte audit.
`.trim();

export const SEARCH_DOCS_DESCRIPTION = `
# \`search_docs\`

Search documentation prose. Each hit names the HEADING PATH it sits under, so an answer is
\`CLAUDE.md > Principles\` rather than a line number, and the line and column of the match.

Matches NORMALIZED text, so a sentence wrapped across lines is one string. A hit inside a fenced
code block says so, which is how a runnable command written only in a fence is findable at all.

Set exactly one of \`text\` or \`regex\`. Set neither with \`fenced\` or \`module\` to list a slice.

Indexed documents only. An unclaimed file, or one no provider reads as a document, is invisible
here. Use ripgrep for an exhaustive byte audit. Prose in a code comment is \`find_comments\`.
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

Use \`within\` to restrict declarations to a scope.
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

Show a file's Git age and churn.

Includes recent commits with dates, line changes, and subjects.
`.trim();

export const SYMBOL_HISTORY_DESCRIPTION = `
# \`symbol_history\`

Find Git commits whose subject names a symbol.

Matches case and word boundaries. Includes changed-file counts.
`.trim();

export const RECORD_ANSWER_DESCRIPTION = `
# Record Answer

Save an answer grounded in cited facts.

Use current full fact IDs from \`symbol_facts\`. Changes to supporting facts make the answer stale.

Answer should be 1 to 2 concise incomplete sentences. May be longer if it's too complex for ≤2.

Capitalize first letters of a sentence. Punctuate.
`.trim();

export const RECALL_ANSWER_DESCRIPTION = `
# Recall Answer

Show recorded answers and their health.

Reports \`STALE\`, \`SHAKY\`, and \`DOUBTED\`.
`.trim();

export const INVALIDATE_ANSWER_DESCRIPTION = `
# Invalidate Answer

Mark recorded answers doubtful without changing their prose.

The doubt reopens demand in \`knowledge_gaps\`.
`.trim();

export const REAFFIRM_ANSWER_DESCRIPTION = `
# Reaffirm Answer

Refresh an answer's evidence or clear its doubt.

Use \`resolvesDoubt\` to clear a doubt.
`.trim();

export const KNOWLEDGE_GAPS_DESCRIPTION = `
# Knowledge Gaps

List missing, stale, or doubted answers. Three scopes, by what you pass:

- nothing: the workspace, ranked by demand
- \`module\`: that file's declarations
- \`name\` or \`symbolId\`: the tree under that symbol, leaves first

Use \`symbol_facts\` for each gap.
`.trim();

export const SYMBOL_FACTS_DESCRIPTION = `
# Symbol Facts

Show a symbol's declaration and supporting facts with full fact IDs.

Use the full fact IDs as citations for \`record_answer\`.
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
async function withIndexState(backend: ToolBackend, body: string, concerning?: string): Promise<string> {
	const status = await backend.indexStatus(concerning);
	const notes: string[] = [];

	// Concerning file first.
	const retry = `Fix what the reason names and save; a changed file is re-read at once, an unchanged one on the next scan.`;
	if (status.concerning !== undefined) {
		notes.push(
			`\`${status.concerning.module}\`, the file this answer concerns, failed to parse: ${oneLine(status.concerning.reason)}. Its facts are missing or predate the failure. ${retry}`,
		);
	}
	const others = status.failures - (status.concerning === undefined ? 0 : 1);
	if (others > 0) {
		const named = status.failed.filter((failure) => failure.module !== status.concerning?.module);
		const more = others - named.length;
		const list =
			named.length === 0
				? ""
				: `: ${named.map((failure) => `\`${failure.module}\` (${oneLine(failure.reason)})`).join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
		notes.push(
			`${others} ${status.concerning === undefined ? "" : `other `}file${others === 1 ? "" : "s"} failed to parse; facts indexed before each failure were kept${list}. \`overview\` lists every one.${status.concerning === undefined ? ` ${retry}` : ""}`,
		);
	}

	// Outline facts make reference and literal counts lower bounds.
	const outline = status.outlineFiles ?? 0;
	if (outline > 0) {
		notes.push(
			`${outline} of ${outline + (status.fullFiles ?? 0)} files hold outline facts only (names and imports), so reference and literal counts are lower bounds until the upgrade finishes.`,
		);
	} else if (status.state !== "ready") {
		// A stored index remains usable during a rescan, but edited files may be missing.
		if (status.stored > 0) {
			const progress = status.total > 0 ? ` (${status.done} of ${status.total})` : "";
			notes.push(
				`Answered from an index of ${status.stored} files. A rescan is in progress${progress}, so anything edited since the last scan may not be reflected.`,
			);
		} else if (status.state === "warming" || status.state === "indexing") {
			notes.push(`Still indexing: ${status.done} of ${status.total} files read. This answer may be incomplete.`);
		} else {
			notes.push(`The index has not been built yet, so this answer covers nothing.`);
		}
	}

	return notes.length === 0 ? body : `${body}\n\n${notes.map((note) => `> ${note}`).join("\n")}`;
}

function oneLine(reason: string): string {
	return reason.replace(/\s+/g, " ").trim();
}

/** Refused before the round trip. */
function refusedTerm(...terms: Array<string | undefined>): ToolResult | undefined {
	for (const term of terms) {
		if (term === undefined) continue;
		try {
			searchTerm(term);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
	}
	return undefined;
}

/** Symbol id to its file. */
function moduleOf(symbolId: string): string | undefined {
	return parseSymbolId(symbolId)?.module;
}

/**
 * Resolve what the caller gave into one symbol id.
 *
 * Several matches is an answer, not a failure: the caller is told which ones exist so it can pick,
 * rather than being handed a confident description of whichever happened to be first.
 */
async function resolveOne(backend: ToolBackend, args: SymbolArgs): Promise<{ symbolId: string } | { problem: string }> {
	if (args.symbolId) return { symbolId: args.symbolId };
	if (!args.name) return { problem: `Give either \`symbolId\` or \`name\`.` };

	const candidates = await backend.findByName(args.name, args.module);
	if (candidates.length === 0) return { problem: `No symbol named \`${args.name}\` is indexed.` };
	if (candidates.length > 1) return { problem: renderCandidates(args.name, candidates) };
	return { symbolId: (candidates[0] as SymbolSummary).symbolId };
}

////////////////////////////////
//  Handlers

export async function describeSymbol(backend: ToolBackend, args: SymbolArgs): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const described = await backend.describe(resolved.symbolId);
	// An absence claim is the one that has to know how much was read, so it carries the state and
	// the successful answer does not. The copy-verbatim hint earns its place: an id's trailing
	// period is invisible next to sentence punctuation, and one agent burned five calls learning it.
	if (!described)
		return text(
			await withIndexState(
				backend,
				`No symbol with ID \`${resolved.symbolId}\` is indexed. Copy IDs verbatim from a result row.`,
				moduleOf(resolved.symbolId),
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
	args: SymbolArgs & { limit?: number | undefined; within?: string | undefined },
): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const found = await backend.findReferences(resolved.symbolId, args.limit, args.within);
	return text(await withIndexState(backend, renderReferences(found), moduleOf(resolved.symbolId)));
}

export async function typeOfSymbol(backend: ToolBackend, args: SymbolArgs): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const type = await backend.typeOf(resolved.symbolId);
	// The name is only for the rendered line, so falling back to the id keeps the answer readable
	// when the caller passed an id and never told us a name.
	return text(renderType(args.name ?? resolved.symbolId, type));
}

export async function refactorMove(backend: ToolBackend, args: SymbolArgs & { toModule: string }): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(resolved.problem, true);

	const outcome = await backend.refactorMove(resolved.symbolId, args.toModule).catch(
		(error: unknown): Awaited<ReturnType<ToolBackend["refactorMove"]>> => ({
			moved: false,
			issues: [],
			reason: error instanceof Error ? error.message : String(error),
		}),
	);
	return text(renderMoveOutcome(outcome.toModule ?? args.toModule, outcome), !outcome.moved);
}

export async function refactorRename(
	backend: ToolBackend,
	args: SymbolArgs & { newName: string },
): Promise<ToolResult> {
	const resolved = await resolveOne(backend, args);
	if ("problem" in resolved) return text(resolved.problem, true);

	const outcome = await backend.refactorRename(resolved.symbolId, args.newName).catch((error: unknown) => ({
		renamed: false,
		issues: [] as RefactorIssue[],
		reason: error instanceof Error ? error.message : String(error),
	}));
	return text(renderRenameStep(args.newName, outcome), !outcome.renamed);
}

/**
 * Every refactor tool renders its own failure.
 *
 * A thrown request escapes as a transport error, which tells the caller nothing about the state
 * the transaction is in. Mid-refactor that is the difference between "retry" and "you have files
 * on disk from a step that did not finish".
 */
async function rendered(work: () => Promise<string>): Promise<ToolResult> {
	try {
		return text(await work());
	} catch (error) {
		return text(
			`the refactor could not be carried out: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	}
}

export async function symbolSource(
	backend: ToolBackend,
	args: { symbolId?: string | undefined; factId?: string | undefined },
): Promise<ToolResult> {
	const source = await backend.symbolSource(args);
	const concerning = args.symbolId === undefined ? undefined : moduleOf(args.symbolId);
	return text(await withIndexState(backend, renderSymbolSource(source), concerning), !source.found);
}

export async function refactorStart(backend: ToolBackend): Promise<ToolResult> {
	return rendered(async () => renderRefactorStart(await backend.refactorStart()));
}

export async function refactorStatus(backend: ToolBackend): Promise<ToolResult> {
	return rendered(async () => renderRefactorStatus(await backend.refactorStatus()));
}

export async function refactorPreview(
	backend: ToolBackend,
	args: SymbolArgs & { newName?: string | undefined; toModule?: string | undefined },
): Promise<ToolResult> {
	if ((args.newName === undefined) === (args.toModule === undefined)) {
		return text(`Give \`newName\` for a rename preview or \`toModule\` for a move preview, not both.`, true);
	}
	try {
		const resolved = await resolveOne(backend, args);
		if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

		const body =
			args.newName !== undefined
				? renderRenamePlan(await backend.prepareRename(resolved.symbolId, args.newName))
				: renderMovePlan(await backend.planMove(resolved.symbolId, args.toModule ?? ""));
		return text(await withIndexState(backend, body, moduleOf(resolved.symbolId)));
	} catch (error) {
		return text(
			`the preview could not be worked out: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	}
}

export async function refactorTrack(backend: ToolBackend, args: { module: string }): Promise<ToolResult> {
	return rendered(async () => {
		const outcome = await backend.refactorTrack(args.module);
		return outcome.tracked
			? `Tracking \`${args.module}\`. Its current contents are the state \`refactor_revert\` returns it to.`
			: (outcome.reason ?? `the file could not be tracked`);
	});
}

export async function refactorUndo(backend: ToolBackend): Promise<ToolResult> {
	return rendered(async () => {
		const outcome = await backend.refactorUndo();
		if (!outcome.undone) return `Nothing was undone. ${outcome.reason ?? ""}`.trim();
		return `Undid step ${outcome.stepNo}, restoring ${(outcome.modules ?? []).map((m) => `\`${m}\``).join(", ")}.`;
	});
}

export async function refactorRevert(backend: ToolBackend): Promise<ToolResult> {
	return rendered(async () => {
		const outcome = await backend.refactorRevert();
		if (!outcome.reverted) return `Nothing was reverted. ${outcome.reason ?? ""}`.trim();
		return outcome.modules.length === 0
			? `Reverted. No file had been changed.`
			: `Reverted ${outcome.modules.length} file(s) to how the transaction found them: ${outcome.modules
					.map((m) => `\`${m}\``)
					.join(", ")}.`;
	});
}

export async function refactorCommit(backend: ToolBackend, args: { force?: boolean }): Promise<ToolResult> {
	return rendered(async () => renderRefactorCommit(await backend.refactorCommit(args.force)));
}

export async function refactorReplace(
	backend: ToolBackend,
	args: { symbolId?: string | undefined; factId?: string | undefined; newText: string },
): Promise<ToolResult> {
	const outcome = await backend.refactorReplace(args).catch((error: unknown) => ({
		replaced: false,
		issues: [] as RefactorIssue[],
		reason: error instanceof Error ? error.message : String(error),
	}));
	return text(renderReplaceOutcome(outcome), !outcome.replaced);
}

export async function refactorInsert(
	backend: ToolBackend,
	args: { after?: string | undefined; module?: string | undefined; text: string },
): Promise<ToolResult> {
	if ((args.after === undefined) === (args.module === undefined)) {
		return text(`Set exactly one of \`after\` or \`module\`.`, true);
	}
	const outcome = await backend.refactorInsert(args).catch(
		(error: unknown): Awaited<ReturnType<ToolBackend["refactorInsert"]>> => ({
			inserted: false,
			issues: [],
			reason: error instanceof Error ? error.message : String(error),
		}),
	);
	return text(renderInsertOutcome(outcome), !outcome.inserted && outcome.alreadyInserted !== true);
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

export async function findComments(
	backend: ToolBackend,
	args: CommentQuery & { limit?: number | undefined },
): Promise<ToolResult> {
	if (args.text !== undefined && args.regex !== undefined) {
		return text(`Set \`text\` or \`regex\`, not both.`, true);
	}
	const refused = refusedTerm(args.text);
	if (refused !== undefined) return refused;
	try {
		const found = await backend.findComments(args);
		return text(await withIndexState(backend, renderComments(found), args.module));
	} catch (error) {
		// A bad regex is the caller's mistake and worth saying plainly, rather than an empty result
		// that reads as "nothing matched".
		return text(error instanceof Error ? error.message : String(error), true);
	}
}

export async function searchDocs(
	backend: ToolBackend,
	args: DocQuery & { limit?: number | undefined },
): Promise<ToolResult> {
	if (args.text !== undefined && args.regex !== undefined) {
		return text(`Set \`text\` or \`regex\`, not both.`, true);
	}
	const refused = refusedTerm(args.text);
	if (refused !== undefined) return refused;
	try {
		return text(await withIndexState(backend, renderDocs(await backend.findDocs(args)), args.module));
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
		return text(`Set exactly one of \`text\` or \`regex\`.`, true);
	}
	if (args.regex !== undefined) {
		try {
			compileSearchRegex(args.regex);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
	}
	const refused = refusedTerm(args.text, args.module);
	if (refused !== undefined) return refused;
	const found = await backend.searchSymbols(args.text, args);
	return text(await withIndexState(backend, renderSymbolSearch(found)));
}

export async function outlineModule(backend: ToolBackend, args: { module: string }): Promise<ToolResult> {
	const [declarations, notes] = await Promise.all([
		backend.outlineModule(args.module),
		backend.fileNotes(args.module),
	]);
	return text(await withIndexState(backend, renderOutline(args.module, declarations, notes), args.module));
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
		return text(`Set exactly one of \`specifier\`, \`specifierRegex\`, \`module\`, or \`moduleRegex\`.`, true);
	}
	for (const regex of [args.specifierRegex, args.moduleRegex]) {
		if (regex === undefined) continue;
		try {
			compileSearchRegex(regex);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
	}
	const refused = refusedTerm(args.specifier);
	if (refused !== undefined) return refused;
	try {
		return text(await withIndexState(backend, renderImports(await backend.findImports(args)), args.module));
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
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const recalled =
		args.question === undefined
			? await backend.recallAnswers(resolved.symbolId)
			: [await backend.recallAnswer(resolved.symbolId, args.question)].filter(
					(r): r is RecalledAnswer => r !== null,
				);
	if (recalled.length === 0) {
		const which = args.question === undefined ? `Nothing is` : `No ${args.question} answer is`;
		return text(
			await withIndexState(
				backend,
				`${which} recorded about ${resolved.symbolId}. \`record_answer\` writes one, citing ids from \`symbol_facts\`.`,
				moduleOf(resolved.symbolId),
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
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

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
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

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
		if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);
		root = resolved.symbolId;
	}

	// Alone, module is the scope.
	const module = root === undefined ? args.module : undefined;
	const gaps = await backend.knowledgeGaps(root, args.question, args.limit, module);
	const concerning = root === undefined ? module : moduleOf(root);
	return text(await withIndexState(backend, renderKnowledgeGaps(gaps, root), concerning));
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
	if ("problem" in resolved) return text(await withIndexState(backend, resolved.problem, args.module), true);

	const facts = await backend.factsFor(resolved.symbolId, args.limit);
	const concerning = moduleOf(resolved.symbolId);
	if (facts === null)
		return text(
			await withIndexState(backend, `No symbol with ID \`${resolved.symbolId}\` is indexed.`, concerning),
			true,
		);
	return text(await withIndexState(backend, renderFacts(facts), concerning));
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
