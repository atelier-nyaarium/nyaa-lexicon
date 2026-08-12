import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionProject } from "@nyaa-lexicon/core";
import { z } from "zod";
import type { BindingDeps } from "./binding.js";
import { nothingBoundMessage } from "./binding.js";
import {
	CO_CHANGED_WITH_DESCRIPTION,
	CoChangedWithInput,
	coChangedWith,
	DESCRIBE_DESCRIPTION,
	DescribeSymbolInput,
	describeSymbol,
	FILE_HISTORY_DESCRIPTION,
	FIND_IMPORTS_DESCRIPTION,
	FIND_LITERALS_DESCRIPTION,
	FileHistoryInput,
	FindImportsInput,
	FindLiteralsInput,
	FindReferencesInput,
	fileHistory,
	findImports,
	findLiterals,
	findReferences,
	INVALIDATE_ANSWER_DESCRIPTION,
	InvalidateAnswerInput,
	invalidateAnswer,
	KNOWLEDGE_GAPS_DESCRIPTION,
	KnowledgeGapsInput,
	knowledgeGaps,
	MOST_REFERENCED_DESCRIPTION,
	MostReferencedInput,
	mostReferenced,
	OUTLINE_MODULE_DESCRIPTION,
	OutlineModuleInput,
	OVERVIEW_DESCRIPTION,
	OverviewInput,
	outlineModule,
	overview,
	PREPARE_RENAME_DESCRIPTION,
	PrepareRenameInput,
	prepareRename,
	REAFFIRM_ANSWER_DESCRIPTION,
	RECALL_ANSWER_DESCRIPTION,
	RECORD_ANSWER_DESCRIPTION,
	REFERENCES_DESCRIPTION,
	RENAME_SYMBOL_DESCRIPTION,
	RESOLVE_IMPORT_DESCRIPTION,
	ReaffirmAnswerInput,
	RecallAnswerInput,
	RecordAnswerInput,
	ResolveImportInput,
	reaffirmAnswer,
	recallAnswer,
	recordAnswer,
	renameSymbol,
	resolveImport,
	SEARCH_SYMBOLS_DESCRIPTION,
	SearchSymbolsInput,
	SYMBOL_FACTS_DESCRIPTION,
	SYMBOL_HISTORY_DESCRIPTION,
	SymbolFactsInput,
	SymbolHistoryInput,
	searchSymbols,
	symbolFacts,
	symbolHistory,
	type ToolBackend,
	type ToolResult,
	TYPE_OF_DESCRIPTION,
	TypeOfInput,
	typeOfSymbol,
} from "./tools.js";

////////////////////////////////
//  Interfaces & Types

export type BackendSource = ToolBackend | ((project: SessionProject) => ToolBackend);
export type ProjectToolScope = "query" | "mutation";

interface ProjectToolDefinition {
	name: string;
	title: string;
	description: string;
	scope: ProjectToolScope;
	batch?: boolean;
	queryValidation?: QueryValidation;
	input: Record<string, z.ZodType>;
	handler: (...args: never[]) => Promise<ToolResult>;
}

interface QueryValidation {
	check: (query: Record<string, unknown>) => boolean;
	message: string;
}

interface Selection {
	projects: SessionProject[];
	args: Record<string, unknown>;
}

interface Route {
	name?: string;
	backend: ToolBackend;
}

////////////////////////////////
//  Constants

const QUERY_PROJECTS = z
	.array(z.string().min(1))
	.refine((names) => new Set(names).size === names.length, `Project names must be unique.`)
	.meta({ uniqueItems: true })
	.optional()
	.describe(`Bound project names from \`list_projects\`. \`[]\` selects all bound projects.`);

const MUTATION_PROJECT = z.string().min(1).optional().describe(`Bound project name from \`list_projects\`.`);

const QUERY_BATCH_NOTE = `\n\nRun one or more query objects in \`queries\`. \`projects\` applies to each.`;

function queryBatch(input: Record<string, z.ZodType>, validation?: QueryValidation): z.ZodType {
	const query = z.strictObject(input);
	const validated = validation === undefined ? query : query.refine(validation.check, validation.message);
	return z.array(validated).min(1).describe(`One or more query objects.`);
}

export const PROJECT_TOOL_DEFINITIONS = [
	{
		name: "describe_symbol",
		title: "Describe Symbol",
		description: DESCRIBE_DESCRIPTION,
		scope: "query",
		input: DescribeSymbolInput,
		handler: describeSymbol,
	},
	{
		name: "find_references",
		title: "Find References",
		description: REFERENCES_DESCRIPTION,
		scope: "query",
		input: FindReferencesInput,
		handler: findReferences,
	},
	{
		name: "resolve_import",
		title: "Resolve Import",
		description: RESOLVE_IMPORT_DESCRIPTION,
		scope: "query",
		input: ResolveImportInput,
		handler: resolveImport,
	},
	{
		name: "type_of",
		title: "Type Of",
		description: TYPE_OF_DESCRIPTION,
		scope: "query",
		input: TypeOfInput,
		handler: typeOfSymbol,
	},
	{
		name: "prepare_rename",
		title: "Prepare Rename",
		description: PREPARE_RENAME_DESCRIPTION,
		scope: "query",
		input: PrepareRenameInput,
		handler: prepareRename,
	},
	{
		name: "rename_symbol",
		title: "Rename Symbol",
		description: RENAME_SYMBOL_DESCRIPTION,
		scope: "mutation",
		input: PrepareRenameInput,
		handler: renameSymbol,
	},
	{
		name: "find_literals",
		title: "Find Literals",
		description: FIND_LITERALS_DESCRIPTION,
		scope: "query",
		input: FindLiteralsInput,
		handler: findLiterals,
	},
	{
		name: "co_changed_with",
		title: "Co-changed With",
		description: CO_CHANGED_WITH_DESCRIPTION,
		scope: "query",
		input: CoChangedWithInput,
		handler: coChangedWith,
	},
	{
		name: "file_history",
		title: "File History",
		description: FILE_HISTORY_DESCRIPTION,
		scope: "query",
		input: FileHistoryInput,
		handler: fileHistory,
	},
	{
		name: "symbol_facts",
		title: "Symbol Facts",
		description: SYMBOL_FACTS_DESCRIPTION,
		scope: "query",
		input: SymbolFactsInput,
		handler: symbolFacts,
	},
	{
		name: "symbol_history",
		title: "Symbol History",
		description: SYMBOL_HISTORY_DESCRIPTION,
		scope: "query",
		input: SymbolHistoryInput,
		handler: symbolHistory,
	},
	{
		name: "record_answer",
		title: "Record Answer",
		description: RECORD_ANSWER_DESCRIPTION,
		scope: "mutation",
		input: RecordAnswerInput,
		handler: recordAnswer,
	},
	{
		name: "recall_answer",
		title: "Recall Answer",
		description: RECALL_ANSWER_DESCRIPTION,
		scope: "query",
		input: RecallAnswerInput,
		handler: recallAnswer,
	},
	{
		name: "invalidate_answer",
		title: "Invalidate Answer",
		description: INVALIDATE_ANSWER_DESCRIPTION,
		scope: "mutation",
		input: InvalidateAnswerInput,
		handler: invalidateAnswer,
	},
	{
		name: "reaffirm_answer",
		title: "Reaffirm Answer",
		description: REAFFIRM_ANSWER_DESCRIPTION,
		scope: "mutation",
		input: ReaffirmAnswerInput,
		handler: reaffirmAnswer,
	},
	{
		name: "knowledge_gaps",
		title: "Knowledge Gaps",
		description: KNOWLEDGE_GAPS_DESCRIPTION,
		scope: "query",
		input: KnowledgeGapsInput,
		handler: knowledgeGaps,
	},
	{
		name: "overview",
		title: "Overview",
		description: OVERVIEW_DESCRIPTION,
		scope: "query",
		batch: false,
		input: OverviewInput,
		handler: (backend) => overview(backend),
	},
	{
		name: "search_symbols",
		title: "Search Symbols",
		description: SEARCH_SYMBOLS_DESCRIPTION,
		scope: "query",
		queryValidation: {
			check: (query) => (query["text"] === undefined) !== (query["regex"] === undefined),
			message: "Set exactly one of `text` or `regex`.",
		},
		input: SearchSymbolsInput,
		handler: searchSymbols,
	},
	{
		name: "outline_module",
		title: "Outline Module",
		description: OUTLINE_MODULE_DESCRIPTION,
		scope: "query",
		input: OutlineModuleInput,
		handler: outlineModule,
	},
	{
		name: "find_imports",
		title: "Find Imports",
		description: FIND_IMPORTS_DESCRIPTION,
		scope: "query",
		queryValidation: {
			check: (query) =>
				[query["specifier"], query["specifierRegex"], query["module"], query["moduleRegex"]].filter(
					(value) => value !== undefined,
				).length === 1,
			message: "Set exactly one of `specifier`, `specifierRegex`, `module`, or `moduleRegex`.",
		},
		input: FindImportsInput,
		handler: findImports,
	},
	{
		name: "most_referenced",
		title: "Most Referenced",
		description: MOST_REFERENCED_DESCRIPTION,
		scope: "query",
		input: MostReferencedInput,
		handler: mostReferenced,
	},
] as const satisfies readonly ProjectToolDefinition[];

export const PROJECT_TOOL_NAMES = PROJECT_TOOL_DEFINITIONS.map((definition) => definition.name);

////////////////////////////////
//  Functions & Helpers

function text(body: string): ToolResult {
	return { content: [{ type: "text", text: body }], isError: true };
}

function resolveNamed(names: string[], all: SessionProject[], bound: SessionProject[]): SessionProject[] | ToolResult {
	const byName = new Map(all.map((project) => [project.name, project]));
	const boundKeys = new Set(bound.map((project) => project.key));
	const selected: SessionProject[] = [];

	for (const name of names) {
		const project = byName.get(name);
		if (project === undefined) {
			return text(
				`# Project not found\n\nNo project named \`${name}\` is registered in this session. Call \`list_projects\`.`,
			);
		}
		if (!boundKeys.has(project.key)) {
			return text(`# Project not bound\n\n\`${name}\` is registered but not bound. Call \`bind_project\` first.`);
		}
		selected.push(project);
	}
	return selected;
}

function selectProjects(
	scope: ProjectToolScope,
	binding: BindingDeps,
	raw: Record<string, unknown>,
): Selection | ToolResult {
	const all = binding.list();
	const bound = all.filter((project) => project.bound);
	if (bound.length === 0) return text(nothingBoundMessage(all));

	if (scope === "mutation") {
		const { project, ...args } = raw as Record<string, unknown> & { project?: string };
		if (project === undefined) {
			if (bound.length === 1 && bound[0] !== undefined) return { projects: [bound[0]], args };
			return text(
				`# Project selection required\n\nSeveral projects are bound: ${bound.map((entry) => `\`${entry.name}\``).join(", ")}. Pass \`project\` with one binding name.`,
			);
		}
		const selected = resolveNamed([project], all, bound);
		return Array.isArray(selected) ? { projects: selected, args } : selected;
	}

	const { projects, ...args } = raw as Record<string, unknown> & { projects?: string[] };
	if (projects === undefined) {
		if (bound.length === 1 && bound[0] !== undefined) return { projects: [bound[0]], args };
		return text(
			`# Project selection required\n\nSeveral projects are bound: ${bound.map((entry) => `\`${entry.name}\``).join(", ")}. Pass \`projects\` with binding names, or \`[]\` for all.`,
		);
	}
	if (projects.length === 0) return { projects: bound, args };
	const selected = resolveNamed(projects, all, bound);
	return Array.isArray(selected) ? { projects: selected, args } : selected;
}

function isToolResult(value: Selection | ToolResult): value is ToolResult {
	return "content" in value;
}

function stripSelector(scope: ProjectToolScope, raw: Record<string, unknown>): Record<string, unknown> {
	if (scope === "mutation") {
		const { project: _project, ...args } = raw as Record<string, unknown> & { project?: string };
		return args;
	}
	const { projects: _projects, ...args } = raw as Record<string, unknown> & { projects?: string[] };
	return args;
}

async function runSelected(
	selection: Selection,
	routed: (project: SessionProject) => ToolBackend,
	handler: (backend: ToolBackend, args: Record<string, unknown>) => Promise<ToolResult>,
): Promise<ToolResult> {
	if (selection.projects.length === 1 && selection.projects[0] !== undefined) {
		return handler(routed(selection.projects[0]), selection.args);
	}

	const sections: string[] = [];
	let failed = false;
	for (const project of selection.projects) {
		const result = await handler(routed(project), selection.args);
		failed ||= result.isError === true;
		sections.push(`## Project: \`${project.name}\`\n\n${result.content.map((chunk) => chunk.text).join("\n")}`);
	}
	return { content: [{ type: "text", text: sections.join("\n\n") }], ...(failed ? { isError: true } : {}) };
}

async function runQueryBatch(
	routes: Route[],
	queries: Record<string, unknown>[],
	handler: (backend: ToolBackend, args: Record<string, unknown>) => Promise<ToolResult>,
): Promise<ToolResult> {
	if (routes.length === 1 && queries.length === 1 && routes[0] !== undefined && queries[0] !== undefined) {
		return handler(routes[0].backend, queries[0]);
	}

	let failed = false;
	const projectSections: string[] = [];
	for (const route of routes) {
		const querySections: string[] = [];
		for (const query of queries) {
			const result = await handler(route.backend, query);
			failed ||= result.isError === true;
			const body = result.content.map((chunk) => chunk.text).join("\n");
			querySections.push(body);
		}
		const body = querySections.join("\n\n");
		projectSections.push(route.name === undefined ? body : `## Project: \`${route.name}\`\n\n${body}`);
	}

	const text = projectSections.join("\n\n");
	return { content: [{ type: "text", text }], ...(failed ? { isError: true } : {}) };
}

function serverResult(result: ToolResult): ToolResult & Record<string, unknown> {
	return result as ToolResult & Record<string, unknown>;
}

export function registerProjectTools(server: McpServer, source: BackendSource, binding: BindingDeps): void {
	const routed = typeof source === "function" ? source : null;

	for (const definition of PROJECT_TOOL_DEFINITIONS) {
		const batched = definition.scope === "query" && (!("batch" in definition) || definition.batch !== false);
		const queryValidation = "queryValidation" in definition ? definition.queryValidation : undefined;
		const handler = definition.handler as unknown as (
			backend: ToolBackend,
			args: Record<string, unknown>,
		) => Promise<ToolResult>;
		const selector = batched
			? { queries: queryBatch(definition.input, queryValidation), projects: QUERY_PROJECTS }
			: definition.scope === "query"
				? { ...definition.input, projects: QUERY_PROJECTS }
				: { ...definition.input, project: MUTATION_PROJECT };
		const inputSchema = z.strictObject(selector);
		server.registerTool(
			definition.name,
			{
				title: definition.title,
				description: batched ? `${definition.description}${QUERY_BATCH_NOTE}` : definition.description,
				inputSchema,
			},
			async (raw: Record<string, unknown>): Promise<ToolResult & Record<string, unknown>> => {
				if (routed === null) {
					const args = stripSelector(definition.scope, raw);
					if (batched) {
						return serverResult(
							await runQueryBatch(
								[{ backend: source as ToolBackend }],
								(args as { queries: Record<string, unknown>[] }).queries,
								handler,
							),
						);
					}
					return serverResult(await handler(source as ToolBackend, args));
				}
				const selection = selectProjects(definition.scope, binding, raw);
				if (isToolResult(selection)) return serverResult(selection);
				if (batched) {
					return serverResult(
						await runQueryBatch(
							selection.projects.map((project) => ({ name: project.name, backend: routed(project) })),
							(selection.args as { queries: Record<string, unknown>[] }).queries,
							handler,
						),
					);
				}
				return serverResult(await runSelected(selection, routed, handler));
			},
		);
	}
}
