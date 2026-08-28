// The MCP server, loaded by main.ts once the runtime has been judged.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { daemonChannel, writeInstallRecord } from "@nyaa-lexicon/client";
import {
	createDispatch,
	createSessionBinds,
	IndexStore,
	LexiconService,
	lexiconRoot,
	ownSource,
	ProviderSupervisor,
	readRegistry,
	type SessionProject,
	sourceReader,
	startProviders,
	storeIdentity,
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
	PROJECT_DIAGNOSTICS_DESCRIPTION,
	ProjectDiagnosticsInput,
	projectDiagnosticsTool,
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

/** The typed question a backend asks, whichever side of the wire answers it. */
type Asker = ReturnType<typeof daemonChannel>["ask"];

////////////////////////////////
//  Functions & Helpers

/**
 * A backend that forwards every question to the daemon over one persistent connection.
 *
 * The open connection IS this session's presence: the daemon counts it, and its close is what
 * eventually arms the daemon's shutdown. Holding it open, and getting it back when it drops, is
 * `daemonChannel`'s job rather than this file's, since the editor adapter needs the same rule and
 * two copies of a retry rule is how two surfaces come to disagree about when a daemon is gone.
 */
export function daemonBackend(workspaceRoot: string, stateDir?: string): ToolBackend {
	const { ask } = daemonChannel({
		workspaceRoot,
		source: ownSource(),
		...(stateDir === undefined ? {} : { stateDir }),
	});
	return backendOver(ask);
}

/** One table over one `ask`, so the daemon's socket and the in-process dispatcher meet the wire alike. */
function backendOver(ask: Asker): ToolBackend {
	return {
		findByName: (name, module) => ask("findByName", { name, module }),
		describe: (symbolId) => ask("describe", { symbolId }),
		findReferences: (symbolId, limit, within) => ask("findReferences", { symbolId, limit, within }),
		resolveImport: (fromModule, specifier) => ask("resolveImport", { fromModule, specifier }),
		typeOf: (symbolId) => ask("typeOf", { symbolId }),
		symbolSource: (address) => ask("symbolSource", address),
		refactorStart: () => ask("refactorStart", {}),
		refactorStatus: () => ask("refactorStatus", {}),
		prepareRename: (symbolId, newName) => ask("prepareRename", { symbolId, newName }),
		planMove: (symbolId, toModule) => ask("planMove", { symbolId, toModule }),
		refactorTrack: (module) => ask("refactorTrack", { module }),
		refactorUndo: () => ask("refactorUndo", {}),
		refactorRevert: () => ask("refactorRevert", {}),
		refactorCommit: (force) => ask("refactorCommit", { force }),
		refactorReplace: (args) => ask("refactorReplace", args),
		refactorInsert: (args) => ask("refactorInsert", args),
		refactorRename: (symbolId, newName) => ask("refactorRename", { symbolId, newName }),
		refactorMove: (symbolId, toModule) => ask("refactorMove", { symbolId, toModule }),
		indexStatus: (concerning) => ask("indexStatus", concerning === undefined ? {} : { concerning }),
		findLiterals: (query) => ask("findLiterals", query),
		findComments: (query) => ask("findComments", query),
		findDocs: (query) => ask("findDocs", query),
		coChangedWith: (module, limit) => ask("coChangedWith", { module, limit }),
		searchSymbols: (text, options) => ask("searchSymbols", { ...(text === undefined ? {} : { text }), ...options }),
		outlineModule: (module) => ask("outlineModule", { module }),
		fileNotes: (module) => ask("fileNotes", { module }),
		findImports: (query) => ask("findImports", query),
		hubs: (limit) => ask("mostReferenced", { limit }),
		overview: () => ask("overview", {}),
		fileHistory: (module) => ask("fileHistory", { module }),
		factsFor: (symbolId, limit) => ask("factsFor", { symbolId, limit }),
		commitsMentioning: (name, limit) => ask("commitsMentioning", { name, limit }),
		recordAnswer: (symbolId, question, prose, citations, options) =>
			ask("recordAnswer", { symbolId, question, prose, citations, ...options }),
		// One wire method answers both arities; the question decides which shape comes back.
		recallAnswer: async (symbolId, question) => {
			const answer = await ask("recallAnswer", { symbolId, question });
			return Array.isArray(answer) ? (answer[0] ?? null) : answer;
		},
		recallAnswers: async (symbolId) => {
			const answer = await ask("recallAnswer", { symbolId });
			return Array.isArray(answer) ? answer : answer === null ? [] : [answer];
		},
		invalidateAnswer: (symbolId, reason, question, by) =>
			ask("invalidateAnswer", { symbolId, reason, question, by }),
		reaffirmAnswer: (symbolId, question, options) => ask("reaffirmAnswer", { symbolId, question, ...options }),
		knowledgeGaps: (root, question, limit, module) => ask("knowledgeGaps", { root, question, limit, module }),
	};
}

/**
 * An index living in this process, for when no daemon is running.
 *
 * Indexes lazily on the first question rather than at startup, so an MCP client's handshake is not
 * held behind a scan of the workspace. The cost is that each session builds its own index, which
 * is exactly what the daemon exists to avoid; this is the fallback, not the design.
 */
const NO_JOURNAL =
	"refactor transactions need the daemon, whose index is on disk; this session is running its own in-memory index, where an undo record would not survive the process";

export function localBackend(workspaceRoot: string): ToolBackend {
	let ready: Promise<Asker> | null = null;

	// Through the daemon's own dispatcher, so a request meets the wire's validation and containment
	// here exactly as it would over the socket.
	async function build(): Promise<Asker> {
		const { store } = IndexStore.open(":memory:");
		const supervisor = new ProviderSupervisor();
		await startProviders(supervisor, workspaceRoot);

		const service = new LexiconService(store, supervisor, sourceReader(workspaceRoot), workspaceRoot);
		await service.indexWorkspace();
		const dispatch = createDispatch(service);
		return ((method, params) => dispatch(method, params)) as Asker;
	}

	function asker(): Promise<Asker> {
		ready ??= build();
		return ready;
	}

	return {
		...backendOver((async (method, params) => (await asker())(method, params as never)) as Asker),
		// A journal in an in-memory index dies with the process, so this backend would offer an undo
		// it could not honour and leave written files with no record of what they replaced.
		refactorStart: async () => ({ started: false, id: "", reason: NO_JOURNAL }),
		refactorStatus: async () => ({ open: false, steps: [], tracked: [], issues: [] }),
		refactorTrack: async () => ({ tracked: false, reason: NO_JOURNAL }),
		refactorUndo: async () => ({ undone: false, reason: NO_JOURNAL }),
		refactorRevert: async () => ({ reverted: false, modules: [], reason: NO_JOURNAL }),
		refactorCommit: async () => ({ committed: false, issues: [], reason: NO_JOURNAL }),
		refactorReplace: async () => ({ replaced: false, issues: [], reason: NO_JOURNAL }),
		refactorInsert: async () => ({ inserted: false, issues: [], reason: NO_JOURNAL }),
		refactorRename: async () => ({ renamed: false, issues: [], reason: NO_JOURNAL }),
		refactorMove: async () => ({ moved: false, issues: [], reason: NO_JOURNAL }),
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
	const diagnosticsShape = ProjectDiagnosticsInput as any;
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
		{ title: `List Projects`, description: LIST_PROJECTS_DESCRIPTION, inputSchema: listProjectsShape },
		adapt(async () => listProjectsTool(binding)),
	);

	server.registerTool(
		"register_project",
		{ title: `Register Project`, description: REGISTER_PROJECT_DESCRIPTION, inputSchema: registerProjectShape },
		adapt(async (args) => registerProjectTool(binding, args)),
	);

	server.registerTool(
		"bind_project",
		{ title: `Bind Project`, description: BIND_PROJECT_DESCRIPTION, inputSchema: bindProjectShape },
		adapt(async (args) => bindProjectTool(binding, args)),
	);

	server.registerTool(
		"unbind_project",
		{ title: `Unbind Project`, description: UNBIND_PROJECT_DESCRIPTION, inputSchema: bindProjectShape },
		adapt(async (args) => unbindProjectTool(binding, args)),
	);

	// Machine-wide rather than workspace-wide, and the only tools here that write. They read the
	// state root directly, since the daemon they could ask is the one serving THIS workspace and
	// the question is about the others.
	const manage = manageDeps ?? liveDeps();

	server.registerTool(
		"list_project_stores",
		{ title: `List Project Stores`, description: LIST_STORES_DESCRIPTION, inputSchema: listStoresShape },
		adapt(async () => listProjectStoresTool(manage)),
	);

	server.registerTool(
		"project_diagnostics",
		{ title: `Project Diagnostics`, description: PROJECT_DIAGNOSTICS_DESCRIPTION, inputSchema: diagnosticsShape },
		adapt(async (args) => projectDiagnosticsTool(manage, args)),
	);

	server.registerTool(
		"delete_project_store",
		{ title: `Delete Project Store`, description: DELETE_STORE_DESCRIPTION, inputSchema: deleteStoreShape },
		adapt(async (args) => deleteProjectStoreTool(manage, args)),
	);

	server.registerTool(
		"stop_project_daemon",
		{ title: `Stop Project Daemon`, description: STOP_DAEMON_DESCRIPTION, inputSchema: stopDaemonShape },
		adapt(async (args) =>
			stopProjectDaemonTool(manage, () => binding.list().filter((project) => project.bound), args),
		),
	);

	return server;
}

////////////////////////////////
//  Main

export async function main(argv: string[]): Promise<void> {
	if (argv.includes("--version")) {
		console.log(SERVER_INFO.version);
		return;
	}

	// Where lexicon is, for a consumer's client to find. Before anything is registered, and never
	// fatal: this server does not need the record itself.
	try {
		writeInstallRecord(lexiconRoot());
	} catch (error) {
		console.error(`install record not written: ${error instanceof Error ? error.message : String(error)}`);
	}

	// No workspace is guessed from the environment or the working directory. Which codebase to
	// answer about is the agent's to state, and it states it by binding.
	// One channel per store, since a workspace may have a default store and custom ones.
	const backends = new Map<string, ToolBackend>();
	const backendFor = (project: SessionProject): ToolBackend => {
		const identity = storeIdentity(project);
		const existing = backends.get(identity);
		if (existing !== undefined) return existing;
		const created = daemonBackend(project.root, project.stateDir);
		backends.set(identity, created);
		return created;
	};

	await buildServer(backendFor).connect(new StdioServerTransport());
}
