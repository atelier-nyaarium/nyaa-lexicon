// The MCP entrypoint. Bundled into dist/ and run as `node dist/main.js`, so nothing here may
// import a bun-only module.

import { readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	admitWorkspace,
	ConnectionLostError,
	connectFrames,
	ensureDaemon,
	type FrameClient,
	IndexStore,
	LexiconService,
	ProviderSupervisor,
	startProviders,
} from "@nyaa-lexicon/core";
import packageJson from "../../../package.json";
import {
	DELETE_STORE_DESCRIPTION,
	DeleteStoreInput,
	deleteProjectStoreTool,
	LIST_STORES_DESCRIPTION,
	ListStoresInput,
	listProjectStoresTool,
	liveDeps,
	type ManageDeps,
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

/** The daemon when one can be reached, this process when it cannot. */
async function warmBackend(workspaceRoot: string): Promise<ToolBackend> {
	const daemon = await ensureDaemon({ workspaceRoot });
	return daemon.connected ? daemonBackend(workspaceRoot) : localBackend(workspaceRoot);
}

/** Every question answers the refusal, so it explains itself at whichever tool was reached for. */
export function refusedBackend(reason: string): ToolBackend {
	const refuse = () => Promise.reject(new Error(reason));
	return new Proxy({} as ToolBackend, { get: () => refuse });
}

export function buildServer(backend: ToolBackend, manageDeps?: ManageDeps): McpServer {
	const server = new McpServer(SERVER_INFO);

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
	const adapt =
		(handler: (args: any) => Promise<ToolResult>) =>
		async (args: any): Promise<any> =>
			handler(args);
	// biome-ignore-end lint/suspicious/noExplicitAny: MCP SDK type compat

	server.registerTool(
		"describe_symbol",
		{ title: "Describe Symbol", description: DESCRIBE_DESCRIPTION, inputSchema: describeShape },
		adapt((args) => describeSymbol(backend, args)),
	);

	server.registerTool(
		"find_references",
		{ title: "Find References", description: REFERENCES_DESCRIPTION, inputSchema: referencesShape },
		adapt((args) => findReferences(backend, args)),
	);

	server.registerTool(
		"resolve_import",
		{ title: "Resolve Import", description: RESOLVE_IMPORT_DESCRIPTION, inputSchema: importShape },
		adapt((args) => resolveImport(backend, args)),
	);

	server.registerTool(
		"type_of",
		{ title: "Type Of", description: TYPE_OF_DESCRIPTION, inputSchema: typeShape },
		adapt((args) => typeOfSymbol(backend, args)),
	);

	server.registerTool(
		"prepare_rename",
		{ title: "Prepare Rename", description: PREPARE_RENAME_DESCRIPTION, inputSchema: renameShape },
		adapt((args) => prepareRename(backend, args)),
	);

	server.registerTool(
		"rename_symbol",
		{ title: "Rename Symbol", description: RENAME_SYMBOL_DESCRIPTION, inputSchema: renameShape },
		adapt((args) => renameSymbol(backend, args)),
	);

	server.registerTool(
		"find_literals",
		{ title: "Find Literals", description: FIND_LITERALS_DESCRIPTION, inputSchema: literalShape },
		adapt((args) => findLiterals(backend, args)),
	);

	server.registerTool(
		"graph_of",
		{ title: "Graph Of", description: GRAPH_OF_DESCRIPTION, inputSchema: graphShape },
		adapt((args) => graphOf(backend, args)),
	);

	server.registerTool(
		"co_changed_with",
		{ title: "Co-changed With", description: CO_CHANGED_WITH_DESCRIPTION, inputSchema: coChangeShape },
		adapt((args) => coChangedWith(backend, args)),
	);

	server.registerTool(
		"type_hierarchy",
		{ title: "Type Hierarchy", description: TYPE_HIERARCHY_DESCRIPTION, inputSchema: hierarchyShape },
		adapt((args) => typeHierarchy(backend, args)),
	);

	server.registerTool(
		"file_history",
		{ title: "File History", description: FILE_HISTORY_DESCRIPTION, inputSchema: fileHistoryShape },
		adapt((args) => fileHistory(backend, args)),
	);

	server.registerTool(
		"symbol_facts",
		{ title: "Symbol Facts", description: SYMBOL_FACTS_DESCRIPTION, inputSchema: factsShape },
		adapt((args) => symbolFacts(backend, args)),
	);

	server.registerTool(
		"symbol_history",
		{ title: "Symbol History", description: SYMBOL_HISTORY_DESCRIPTION, inputSchema: symbolHistoryShape },
		adapt((args) => symbolHistory(backend, args)),
	);

	server.registerTool(
		"record_answer",
		{ title: "Record Answer", description: RECORD_ANSWER_DESCRIPTION, inputSchema: recordShape },
		adapt((args) => recordAnswer(backend, args)),
	);

	server.registerTool(
		"recall_answer",
		{ title: "Recall Answer", description: RECALL_ANSWER_DESCRIPTION, inputSchema: recallShape },
		adapt((args) => recallAnswer(backend, args)),
	);

	server.registerTool(
		"invalidate_answer",
		{ title: "Invalidate Answer", description: INVALIDATE_ANSWER_DESCRIPTION, inputSchema: invalidateShape },
		adapt((args) => invalidateAnswer(backend, args)),
	);

	server.registerTool(
		"reaffirm_answer",
		{ title: "Reaffirm Answer", description: REAFFIRM_ANSWER_DESCRIPTION, inputSchema: reaffirmShape },
		adapt((args) => reaffirmAnswer(backend, args)),
	);

	server.registerTool(
		"knowledge_gaps",
		{ title: "Knowledge Gaps", description: KNOWLEDGE_GAPS_DESCRIPTION, inputSchema: gapsShape },
		adapt((args) => knowledgeGaps(backend, args)),
	);

	server.registerTool(
		"overview",
		{ title: "Overview", description: OVERVIEW_DESCRIPTION, inputSchema: overviewShape },
		adapt(() => overview(backend)),
	);

	server.registerTool(
		"search_symbols",
		{ title: "Search Symbols", description: SEARCH_SYMBOLS_DESCRIPTION, inputSchema: searchShape },
		adapt((args) => searchSymbols(backend, args)),
	);

	server.registerTool(
		"outline_module",
		{ title: "Outline Module", description: OUTLINE_MODULE_DESCRIPTION, inputSchema: outlineShape },
		adapt((args) => outlineModule(backend, args)),
	);

	server.registerTool(
		"find_imports",
		{ title: "Find Imports", description: FIND_IMPORTS_DESCRIPTION, inputSchema: importsShape },
		adapt((args) => findImports(backend, args)),
	);

	server.registerTool(
		"hubs",
		{ title: "Hubs", description: HUBS_DESCRIPTION, inputSchema: hubsShape },
		adapt((args) => hubs(backend, args)),
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

	return server;
}

////////////////////////////////
//  Main

async function main(argv: string[]): Promise<void> {
	if (argv.includes("--version")) {
		console.log(SERVER_INFO.version);
		return;
	}

	// CLAUDE_PROJECT_DIR is set in this process's environment by the client and is the stable
	// project root, which cwd is not: it does not move when working directories are added
	// mid-session. Reading it here is what lets a config carry no absolute workspace path.
	const workspaceRoot = process.env["LEXICON_WORKSPACE"] ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();

	// Before ensureDaemon, or a session launched from a home directory spawns a daemon that walks
	// it. The server still starts, so the refusal arrives as an answer rather than a failed load.
	const admission = admitWorkspace(workspaceRoot);
	const backend = admission.admitted ? await warmBackend(workspaceRoot) : refusedBackend(admission.reason);

	await buildServer(backend).connect(new StdioServerTransport());
}

if (import.meta.main) await main(process.argv.slice(2));
