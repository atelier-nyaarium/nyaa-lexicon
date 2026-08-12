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
	readRegistry,
	type SessionProject,
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
import { type BackendSource, registerProjectTools } from "./projectTools.js";
import type { ToolBackend, ToolResult } from "./tools.js";

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
		coChangedWith: (module, limit) => ask("coChangedWith", { module, limit }),
		searchSymbols: (text, options) => ask("searchSymbols", { ...(text === undefined ? {} : { text }), ...options }),
		outlineModule: (module) => ask("outlineModule", { module }),
		findImports: (query) => ask("findImports", query),
		hubs: (limit) => ask("mostReferenced", { limit }),
		overview: () => ask("overview", {}),
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
		coChangedWith: async (module, limit) => (await service()).coChangedWith(module, limit),
		searchSymbols: async (text, options) => (await service()).searchSymbols(text, options),
		outlineModule: async (module) => (await service()).outline(module),
		findImports: async (query) => (await service()).findImports(query),
		hubs: async (limit) => (await service()).mostReferenced(limit),
		overview: async () => (await service()).overview(),
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

export function buildServer(source: BackendSource, manageDeps?: ManageDeps, bindingDeps?: BindingDeps): McpServer {
	const server = new McpServer(SERVER_INFO);
	// One catalog per server, so names and binds die with the MCP session that made them.
	const binding = bindingDeps ?? liveBindingDeps(createSessionBinds(() => readRegistry()));
	registerProjectTools(server, source, binding);

	// The SDK's callback type is wider than ours in ways the strict optional settings will not
	// unify, so each handler is adapted once here rather than loosening the tool signatures.
	// biome-ignore-start lint/suspicious/noExplicitAny: MCP SDK type compat
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
	// biome-ignore-end lint/suspicious/noExplicitAny: MCP SDK type compat

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
		adapt(async (args) =>
			stopProjectDaemonTool(manage, () => binding.list().filter((project) => project.bound), args),
		),
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
	const backendFor = (project: SessionProject): ToolBackend => {
		const existing = backends.get(project.key);
		if (existing !== undefined) return existing;
		const created = daemonBackend(project.root);
		backends.set(project.key, created);
		return created;
	};

	await buildServer(backendFor).connect(new StdioServerTransport());
}

if (import.meta.main) await main(process.argv.slice(2));
