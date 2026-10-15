import { compileSearchRegex } from "@nyaa-lexicon/core";
import type { RequestOf } from "@nyaa-lexicon/protocol";
import { z } from "zod";
import {
	renderCoChange,
	renderComments,
	renderDocs,
	renderFileHistory,
	renderImports,
	renderLiterals,
	renderMentions,
	renderMostReferenced,
	renderOutline,
	renderOverview,
	renderSymbolSearch,
} from "../render.js";
import type { ToolBackend, ToolResult } from "../result.js";
import { textResult as text } from "../result.js";
import { refusedTerm, WITHIN_NOTE, withIndexState } from "./shared.js";

////////////////////////////////
//  Schemas

const RE2_NOTE = `RE2 syntax: linear time, no lookaround or backreferences.`;

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
	module: z.string().min(1).optional().describe(`Workspace-relative file or folder.`),
};

export const FindCommentsInput = {
	text: z.string().min(1).optional().describe(`Substring of the prose. Use instead of \`regex\`.`),
	regex: z.string().min(1).optional().describe(`Regex literal, for example \`/TODO|FIXME/\`. ${RE2_NOTE}`),
	form: z
		.enum(["leading", "trailing", "inline", "standalone"])
		.optional()
		.describe(`Where the comment sits relative to its symbol.`),
	module: z.string().min(1).optional().describe(`Workspace-relative file or folder.`),
	limit: z.number().int().positive().max(200).optional().describe(`Maximum results. Default: \`50\`.`),
	within: z.string().min(1).optional().describe(WITHIN_NOTE),
};

export const SearchDocsInput = {
	text: z.string().min(1).optional().describe(`Substring of the prose. Use instead of \`regex\`.`),
	regex: z.string().min(1).optional().describe(`Regex literal, for example \`/TODO|FIXME/\`. ${RE2_NOTE}`),
	fenced: z.boolean().optional().describe(`\`true\` for code blocks only, \`false\` for prose only.`),
	module: z.string().min(1).optional().describe(`Workspace-relative file or folder.`),
	limit: z.number().int().positive().max(200).optional().describe(`Maximum results. Default: \`50\`.`),
};

export const SearchSymbolsInput = {
	text: z.string().min(1).optional().describe(`Case-sensitive name substring. Use instead of \`regex\`.`),
	regex: z.string().min(1).optional().describe(`Regex literal. Use instead of \`text\`. ${RE2_NOTE}`),
	kind: z.string().min(1).optional().describe(`Declaration kind filter.`),
	module: z.string().min(1).optional().describe(`Workspace-relative file or folder.`),
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

////////////////////////////////
//  Constants

export const FIND_LITERALS_DESCRIPTION = `
# \`find_literals\`

Find exact values, regex matches, or numeric ranges in decoded literal values.

Use for values rather than textual spelling. Each hit includes its declaration.

Set one of \`value\`, \`regex\`, or a range. Use \`key\` for an exact immediate container name,
\`within\` for a scope and \`module\` for a file or folder.
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

Summarize selected workspaces: files, symbols, references, imports, literals, largest modules, and index coverage.

Use first in an unfamiliar codebase.
`.trim();

export const SEARCH_SYMBOLS_DESCRIPTION = `
# \`search_symbols\`

Find declared names by substring or regular expression. Set at most one of \`text\` or \`regex\`;
with neither, \`kind\`, \`module\` or \`within\` lists what they narrow to.

Does not search comments, strings, or aliases.

Use \`within\` to restrict declarations to a scope.
`.trim();

export const OUTLINE_MODULE_DESCRIPTION = `
# \`outline_module\`

List indexed declarations in a file, nested by container. Locals are left out.

Each row ends with \`refs=N\`, the uses \`describe_symbol\` counts.

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

////////////////////////////////
//  Handlers

export async function findLiterals(
	backend: ToolBackend,
	args: Omit<RequestOf<"findLiterals">, "exclude">,
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
	args: Omit<RequestOf<"findComments">, "exclude">,
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
	args: Omit<RequestOf<"findDocs">, "exclude">,
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
		within?: string | undefined;
		limit?: number | undefined;
	},
): Promise<ToolResult> {
	if (args.text !== undefined && args.regex !== undefined) {
		return text(`Set \`text\` or \`regex\`, not both.`, true);
	}
	if ([args.text, args.regex, args.kind, args.module, args.within].every((each) => each === undefined)) {
		return text(`Set \`text\`, \`regex\`, \`kind\`, \`module\` or \`within\`.`, true);
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
	const found = await backend.searchSymbols(args);
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

export async function symbolHistory(
	backend: ToolBackend,
	args: { name: string; limit?: number | undefined },
): Promise<ToolResult> {
	return text(renderMentions(await backend.commitsMentioning(args.name, args.limit)));
}
