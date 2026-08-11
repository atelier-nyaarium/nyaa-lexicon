// The MCP entrypoint. Bundled into dist/ and run as `node dist/main.js`, so nothing here may
// import a bun-only module.

import { readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	ConnectionLostError,
	connectFrames,
	createSessionBinds,
	ensureDaemon,
	type FrameClient,
	IndexStore,
	LexiconService,
	ProviderSupervisor,
	type RegisteredProject,
	readRegistry,
	startProviders,
} from "@nyaa-lexicon/core";
import packageJson from "../../../package.json";
import {
	BIND_PROJECT_DESCRIPTION,
	type BindingDeps,
	BindProjectInput,
	bindProjectTool,
	LIST_PROJECTS_DESCRIPTION,
	ListProjectsInput,
	listProjectsTool,
	liveBindingDeps,
	nothingBoundMessage,
	REGISTER_PROJECT_DESCRIPTION,
	RegisterProjectInput,
	registerProjectTool,
	UNBIND_PROJECT_DESCRIPTION,
	unbindProjectTool,
} from "./binding.js";
import {
	DELETE_STORE_DESCRIPTION,
	DeleteStoreInput,
	deleteProjectStoreTool,
	LIST_STORES_DESCRIPTION,
	ListStoresInput,
	listProjectStoresTool,
	liveDeps,
	type ManageDeps,
	STOP_DAEMON_DESCRIPTION,
	StopDaemonInput,
	stopProjectDaemonTool,
} from "./manage.js";
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
	GRAPH_OF_DESCRIPTION,
	GraphOfInput,
	graphOf,
	HUBS_DESCRIPTION,
	HubsInput,
	hubs,
	INVALIDATE_ANSWER_DESCRIPTION,
	InvalidateAnswerInput,
	invalidateAnswer,
	KNOWLEDGE_GAPS_DESCRIPTION,
	KnowledgeGapsInput,
	knowledgeGaps,
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
	TYPE_HIERARCHY_DESCRIPTION,
	TYPE_OF_DESCRIPTION,
	TypeHierarchyInput,
	TypeOfInput,
	typeHierarchy,
	typeOfSymbol,
} from "./tools.js";

////////////////////////////////
//  Constants

/**
 * The version is DERIVED from package.json, never stored as a literal here.
 * scripts/build.ts verifies that derivation still exists and refuses to build if someone replaces
 * it with a string, since a hard-coded version reads as correct right up until the next bump ships
 * a server lying about what it is.
 */
export const SERVER_INFO = { name: "nyaa-lexicon", version: packageJson.version } as const;

////////////////////////////////
//  Functions & Helpers

/**
 * A backend that forwards every question to the daemon over one persistent connection.
 *
 * The open connection IS this session's presence: the daemon counts it, and its close is what
 * eventually arms the daemon's shutdown. A dropped connection is re-established through
 * ensureDaemon, which spawns a fresh daemon if the old one is gone.
 */
export function daemonBackend(workspaceRoot: string): ToolBackend {
	let client: FrameClient | null = null;

	async function ask<T>(method: string, params: unknown): Promise<T> {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (client === null || client.closed) {
				const daemon = await ensureDaemon({ workspaceRoot });
				if (!daemon.connected) throw new Error(`no indexer for ${workspaceRoot}: ${daemon.reason}`);
				client = await connectFrames(daemon.lock.port, daemon.lock.token);
			}
			try {
				return (await client.request(method, params)) as T;
			} catch (error) {
				if (!(error instanceof ConnectionLostError)) throw error;
				client = null;
			}
		}
		throw new Error(`the daemon for ${workspaceRoot} dropped the connection twice; giving up`);
	}

	return {
		findByName: (name, module) => ask("findByName", { name, module }),
		describe: (symbolId) => ask("describe", { symbolId }),
		findReferences: (symbolId, limit) => ask("findReferences", { symbolId, limit }),
		resolveImport: (fromModule, specifier) => ask("resolveImport", { fromModule, specifier }),
		typeOf: (symbolId) => ask("typeOf", { symbolId }),
		prepareRename: (symbolId, newName) => ask("prepareRename", { symbolId, newName }),
		renameSymbol: (symbolId, newName) => ask("renameSymbol", { symbolId, newName }),
		indexStatus: () => ask("indexStatus", {}),
		findLiterals: (query) => ask("findLiterals", query),
		graphOf: (symbolId) => ask("graphOf", { symbolId }),
		coChangedWith: (module, limit) => ask("coChangedWith", { module, limit }),
		searchSymbols: (text, options) => ask("searchSymbols", { text, ...options }),
		outlineModule: (module) => ask("outlineModule", { module }),
		findImports: (query) => ask("findImports", query),
		hubs: (limit) => ask("hubs", { limit }),
		overview: () => ask("overview", {}),
		typeHierarchy: (symbolId) => ask("typeHierarchy", { symbolId }),
		fileHistory: (module) => ask("fileHistory", { module }),
		factsFor: (symbolId, limit) => ask("factsFor", { symbolId, limit }),
		commitsMentioning: (name, limit) => ask("commitsMentioning", { name, limit }),
		recordAnswer: (symbolId, question, prose, citations, options) =>
			ask("recordAnswer", { symbolId, question, prose, citations, ...options }),
		recallAnswer: (symbolId, question) => ask("recallAnswer", { symbolId, question }),
		recallAnswers: (symbolId) => ask("recallAnswer", { symbolId }),
		invalidateAnswer: (symbolId, reason, question, by) =>
			ask("invalidateAnswer", { symbolId, reason, question, by }),
		reaffirmAnswer: (symbolId, question, options) => ask("reaffirmAnswer", { symbolId, question, ...options }),
		knowledgeGaps: (root, question, limit) => ask("knowledgeGaps", { root, question, limit }),
	};
}

/**
 * An index living in this process, for when no daemon is running.
 *
 * Indexes lazily on the first question rather than at startup, so an MCP client's handshake is not
 * held behind a scan of the workspace. The cost is that each session builds its own index, which
 * is exactly what the daemon exists to avoid; this is the fallback, not the design.
 */
export function localBackend(workspaceRoot: string): ToolBackend {
	let ready: Promise<LexiconService> | null = null;

	async function build(): Promise<LexiconService> {
		const { store } = IndexStore.open(":memory:");
		const supervisor = new ProviderSupervisor();
		await startProviders(supervisor, workspaceRoot);

		const service = new LexiconService(
			store,
			supervisor,
			(module) => {
				try {
					return readFileSync(path.join(workspaceRoot, module), "utf8");
				} catch {
					return null;
				}
			},
			workspaceRoot,
		);
		await service.indexWorkspace();
		return service;
	}

	function service(): Promise<LexiconService> {
		ready ??= build();
		return ready;
	}

	return {
		findByName: async (name, module) => (await service()).findByName(name, module),
		describe: async (symbolId) => (await service()).describe(symbolId),
		findReferences: async (symbolId, limit) => (await service()).findReferences(symbolId, limit),
		resolveImport: async (fromModule, specifier) => (await service()).resolveImport(fromModule, specifier),
		typeOf: async (symbolId) => (await service()).typeOf(symbolId),
		prepareRename: async (symbolId, newName) => (await service()).prepareRename(symbolId, newName),
		renameSymbol: async (symbolId, newName) => (await service()).renameSymbol(symbolId, newName),
		indexStatus: async () => (await service()).indexStatus(),
		findLiterals: async ({ limit, ...query }) => (await service()).findLiterals(query, limit),
		graphOf: async (symbolId) => (await service()).graphOf(symbolId),
		coChangedWith: async (module, limit) => (await service()).coChangedWith(module, limit),
		searchSymbols: async (text, options) => (await service()).searchSymbols(text, options),
		outlineModule: async (module) => (await service()).outline(module),
		findImports: async (query) => (await service()).findImports(query),
		hubs: async (limit) => (await service()).hubs(limit),
		overview: async () => (await service()).overview(),
		typeHierarchy: async (symbolId) => (await service()).typeHierarchy(symbolId),
		fileHistory: async (module) => (await service()).fileHistory(module),
		factsFor: async (symbolId, limit) => (await service()).factsFor(symbolId, limit),
		commitsMentioning: async (name, limit) => (await service()).commitsMentioning(name, limit),
		recordAnswer: async (symbolId, question, prose, citations, options) =>
			(await service()).recordAnswer(symbolId, question, prose, citations, options),
		recallAnswer: async (symbolId, question) => (await service()).recallAnswer(symbolId, question),
		recallAnswers: async (symbolId) => (await service()).recallAnswers(symbolId),
		invalidateAnswer: async (symbolId, reason, question, by) =>
			(await service()).invalidateAnswer(symbolId, reason, question, by),
		reaffirmAnswer: async (symbolId, question, options) =>
			(await service()).reaffirmAnswer(symbolId, question, options),
		knowledgeGaps: async (root, question, limit) => (await service()).knowledgeGaps(root, question, limit),
	};
}

/** One fixed backend, or one per bound project. Tests pass a backend; production routes. */
export type BackendSource = ToolBackend | ((project: RegisteredProject) => ToolBackend);

export function buildServer(source: BackendSource, manageDeps?: ManageDeps, bindingDeps?: BindingDeps): McpServer {
	const server = new McpServer(SERVER_INFO);
	const routed = typeof source === "function" ? source : null;
	// One set per server, so binds die with the session that made them.
	const binds = createSessionBinds(() => readRegistry());

	// The SDK's callback type is wider than ours in ways the strict optional settings will not
	// unify, so each handler is adapted once here rather than loosening the tool signatures.
	// biome-ignore-start lint/suspicious/noExplicitAny: MCP SDK type compat
	const describeShape = DescribeSymbolInput as any;
	const referencesShape = FindReferencesInput as any;
	const importShape = ResolveImportInput as any;
	const typeShape = TypeOfInput as any;
	const renameShape = PrepareRenameInput as any;
	const literalShape = FindLiteralsInput as any;
	const graphShape = GraphOfInput as any;
	const coChangeShape = CoChangedWithInput as any;
	const searchShape = SearchSymbolsInput as any;
	const outlineShape = OutlineModuleInput as any;
	const importsShape = FindImportsInput as any;
	const hubsShape = HubsInput as any;
	const overviewShape = OverviewInput as any;
	const hierarchyShape = TypeHierarchyInput as any;
	const fileHistoryShape = FileHistoryInput as any;
	const factsShape = SymbolFactsInput as any;
	const symbolHistoryShape = SymbolHistoryInput as any;
	const recordShape = RecordAnswerInput as any;
	const recallShape = RecallAnswerInput as any;
	const invalidateShape = InvalidateAnswerInput as any;
	const reaffirmShape = ReaffirmAnswerInput as any;
	const gapsShape = KnowledgeGapsInput as any;
	const listStoresShape = ListStoresInput as any;
	const deleteStoreShape = DeleteStoreInput as any;
	const stopDaemonShape = StopDaemonInput as any;
	const listProjectsShape = ListProjectsInput as any;
	const registerProjectShape = RegisterProjectInput as any;
	const bindProjectShape = BindProjectInput as any;
	const adapt =
		(handler: (args: any) => Promise<ToolResult>) =>
		async (args: any): Promise<any> =>
			handler(args);

	// Every question goes to each bound project in turn, labelled, because "which codebase" is the
	// one thing the agent knows and lexicon cannot infer.
	const perProject =
		(handler: (backend: ToolBackend, args: any) => Promise<ToolResult>) =>
		async (args: any): Promise<any> => {
			if (routed === null) return handler(source as ToolBackend, args);

			const bound = binding.list().filter((project) => project.bound);
			if (bound.length === 0) {
				return { content: [{ type: "text", text: nothingBoundMessage(binding.list()) }], isError: true };
			}
			if (bound.length === 1 && bound[0] !== undefined) return handler(routed(bound[0]), args);

			const sections: string[] = [];
			for (const project of bound) {
				const result = await handler(routed(project), args);
				sections.push(`=== ${project.name}\n${result.content.map((chunk) => chunk.text).join("\n")}`);
			}
			return { content: [{ type: "text", text: sections.join("\n\n") }] };
		};
	// biome-ignore-end lint/suspicious/noExplicitAny: MCP SDK type compat

	server.registerTool(
		"describe_symbol",
		{ title: "Describe Symbol", description: DESCRIBE_DESCRIPTION, inputSchema: describeShape },
		perProject((backend, args) => describeSymbol(backend, args)),
	);

	server.registerTool(
		"find_references",
		{ title: "Find References", description: REFERENCES_DESCRIPTION, inputSchema: referencesShape },
		perProject((backend, args) => findReferences(backend, args)),
	);

	server.registerTool(
		"resolve_import",
		{ title: "Resolve Import", description: RESOLVE_IMPORT_DESCRIPTION, inputSchema: importShape },
		perProject((backend, args) => resolveImport(backend, args)),
	);

	server.registerTool(
		"type_of",
		{ title: "Type Of", description: TYPE_OF_DESCRIPTION, inputSchema: typeShape },
		perProject((backend, args) => typeOfSymbol(backend, args)),
	);

	server.registerTool(
		"prepare_rename",
		{ title: "Prepare Rename", description: PREPARE_RENAME_DESCRIPTION, inputSchema: renameShape },
		perProject((backend, args) => prepareRename(backend, args)),
	);

	server.registerTool(
		"rename_symbol",
		{ title: "Rename Symbol", description: RENAME_SYMBOL_DESCRIPTION, inputSchema: renameShape },
		perProject((backend, args) => renameSymbol(backend, args)),
	);

	server.registerTool(
		"find_literals",
		{ title: "Find Literals", description: FIND_LITERALS_DESCRIPTION, inputSchema: literalShape },
		perProject((backend, args) => findLiterals(backend, args)),
	);

	server.registerTool(
		"graph_of",
		{ title: "Graph Of", description: GRAPH_OF_DESCRIPTION, inputSchema: graphShape },
		perProject((backend, args) => graphOf(backend, args)),
	);

	server.registerTool(
		"co_changed_with",
		{ title: "Co-changed With", description: CO_CHANGED_WITH_DESCRIPTION, inputSchema: coChangeShape },
		perProject((backend, args) => coChangedWith(backend, args)),
	);

	server.registerTool(
		"type_hierarchy",
		{ title: "Type Hierarchy", description: TYPE_HIERARCHY_DESCRIPTION, inputSchema: hierarchyShape },
		perProject((backend, args) => typeHierarchy(backend, args)),
	);

	server.registerTool(
		"file_history",
		{ title: "File History", description: FILE_HISTORY_DESCRIPTION, inputSchema: fileHistoryShape },
		perProject((backend, args) => fileHistory(backend, args)),
	);

	server.registerTool(
		"symbol_facts",
		{ title: "Symbol Facts", description: SYMBOL_FACTS_DESCRIPTION, inputSchema: factsShape },
		perProject((backend, args) => symbolFacts(backend, args)),
	);

	server.registerTool(
		"symbol_history",
		{ title: "Symbol History", description: SYMBOL_HISTORY_DESCRIPTION, inputSchema: symbolHistoryShape },
		perProject((backend, args) => symbolHistory(backend, args)),
	);

	server.registerTool(
		"record_answer",
		{ title: "Record Answer", description: RECORD_ANSWER_DESCRIPTION, inputSchema: recordShape },
		perProject((backend, args) => recordAnswer(backend, args)),
	);

	server.registerTool(
		"recall_answer",
		{ title: "Recall Answer", description: RECALL_ANSWER_DESCRIPTION, inputSchema: recallShape },
		perProject((backend, args) => recallAnswer(backend, args)),
	);

	server.registerTool(
		"invalidate_answer",
		{ title: "Invalidate Answer", description: INVALIDATE_ANSWER_DESCRIPTION, inputSchema: invalidateShape },
		perProject((backend, args) => invalidateAnswer(backend, args)),
	);

	server.registerTool(
		"reaffirm_answer",
		{ title: "Reaffirm Answer", description: REAFFIRM_ANSWER_DESCRIPTION, inputSchema: reaffirmShape },
		perProject((backend, args) => reaffirmAnswer(backend, args)),
	);

	server.registerTool(
		"knowledge_gaps",
		{ title: "Knowledge Gaps", description: KNOWLEDGE_GAPS_DESCRIPTION, inputSchema: gapsShape },
		perProject((backend, args) => knowledgeGaps(backend, args)),
	);

	server.registerTool(
		"overview",
		{ title: "Overview", description: OVERVIEW_DESCRIPTION, inputSchema: overviewShape },
		perProject((backend) => overview(backend)),
	);

	server.registerTool(
		"search_symbols",
		{ title: "Search Symbols", description: SEARCH_SYMBOLS_DESCRIPTION, inputSchema: searchShape },
		perProject((backend, args) => searchSymbols(backend, args)),
	);

	server.registerTool(
		"outline_module",
		{ title: "Outline Module", description: OUTLINE_MODULE_DESCRIPTION, inputSchema: outlineShape },
		perProject((backend, args) => outlineModule(backend, args)),
	);

	server.registerTool(
		"find_imports",
		{ title: "Find Imports", description: FIND_IMPORTS_DESCRIPTION, inputSchema: importsShape },
		perProject((backend, args) => findImports(backend, args)),
	);

	server.registerTool(
		"hubs",
		{ title: "Hubs", description: HUBS_DESCRIPTION, inputSchema: hubsShape },
		perProject((backend, args) => hubs(backend, args)),
	);

	// Never gated on a binding: these are how an agent RECOVERS from having none.
	const binding = bindingDeps ?? liveBindingDeps(binds);

	server.registerTool(
		"list_projects",
		{ title: "List Projects", description: LIST_PROJECTS_DESCRIPTION, inputSchema: listProjectsShape },
		adapt(async () => listProjectsTool(binding)),
	);

	server.registerTool(
		"register_project",
		{ title: "Register Project", description: REGISTER_PROJECT_DESCRIPTION, inputSchema: registerProjectShape },
		adapt(async (args) => registerProjectTool(binding, args)),
	);

	server.registerTool(
		"bind_project",
		{ title: "Bind Project", description: BIND_PROJECT_DESCRIPTION, inputSchema: bindProjectShape },
		adapt(async (args) => bindProjectTool(binding, args)),
	);

	server.registerTool(
		"unbind_project",
		{ title: "Unbind Project", description: UNBIND_PROJECT_DESCRIPTION, inputSchema: bindProjectShape },
		adapt(async (args) => unbindProjectTool(binding, args)),
	);

	// Machine-wide rather than workspace-wide, and the only tools here that write. They read the
	// state root directly, since the daemon they could ask is the one serving THIS workspace and
	// the question is about the others.
	const manage = manageDeps ?? liveDeps();

	server.registerTool(
		"list_project_stores",
		{ title: "List Project Stores", description: LIST_STORES_DESCRIPTION, inputSchema: listStoresShape },
		adapt(async () => listProjectStoresTool(manage)),
	);

	server.registerTool(
		"delete_project_store",
		{ title: "Delete Project Store", description: DELETE_STORE_DESCRIPTION, inputSchema: deleteStoreShape },
		adapt(async (args) => deleteProjectStoreTool(manage, args)),
	);

	server.registerTool(
		"stop_project_daemon",
		{ title: "Stop Project Daemon", description: STOP_DAEMON_DESCRIPTION, inputSchema: stopDaemonShape },
		adapt(async (args) => stopProjectDaemonTool(manage, () => binds.bound(), args)),
	);

	return server;
}

////////////////////////////////
//  Main

async function main(argv: string[]): Promise<void> {
	if (argv.includes("--version")) {
		console.log(SERVER_INFO.version);
		return;
	}

	// No workspace is guessed from the environment or the working directory. Which codebase to
	// answer about is the agent's to state, and it states it by binding.
	const backends = new Map<string, ToolBackend>();
	const backendFor = (project: RegisteredProject): ToolBackend => {
		const existing = backends.get(project.key);
		if (existing !== undefined) return existing;
		const created = daemonBackend(project.root);
		backends.set(project.key, created);
		return created;
	};

	await buildServer(backendFor).connect(new StdioServerTransport());
}

if (import.meta.main) await main(process.argv.slice(2));
