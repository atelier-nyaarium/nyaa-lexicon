// The LSP entrypoint. Bundled into dist/ and run as `node dist/lsp.js`, so nothing here may import
// a bun-only module.
//
// An editor speaks this over stdin and stdout, which is why nothing may ever be written to stdout
// except a framed message: a stray console.log corrupts the stream and the editor sees a protocol
// error rather than the print. Every diagnostic here goes to stderr.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
	currentHost,
	type DaemonChannel,
	daemonChannel,
	ensureDaemon,
	IndexStore,
	LexiconService,
	nodeReportSetup,
	ProviderSupervisor,
	startProviders,
	workspacePaths,
} from "@nyaa-lexicon/core";
import { daemonReads, deferredReads, type LexiconReads, localReads } from "./reads.js";
import { LspServer, pathFromUri } from "./server.js";
import { createReader, encode, type Message } from "./transport.js";

////////////////////////////////
//  Constants

/** What this server can actually do. Anything absent is a capability we do not claim. */
const CAPABILITIES = {
	// Full sync, because the index re-reads whole files anyway and incremental sync would mean
	// maintaining a second copy of every open buffer to apply deltas to.
	textDocumentSync: 1,
	hoverProvider: true,
	definitionProvider: true,
	referencesProvider: true,
	documentSymbolProvider: true,
	renameProvider: { prepareProvider: true },
	// All four read rows the reference index already holds, the heritage roles for the type side and
	// the call role for the other, so claiming them costs no new provider capability.
	typeDefinitionProvider: true,
	implementationProvider: true,
	typeHierarchyProvider: true,
	callHierarchyProvider: true,
};

////////////////////////////////
//  Interfaces & Types

/** Everything that cannot exist until the editor has named a workspace. */
interface Served {
	lsp: LspServer;
	/** Releases whatever the answer source turned out to need: a socket, or a provider set. */
	close(): void;
}

/** An index in this process. Held so `exit` can shut its providers down. */
interface LocalIndex {
	store: IndexStore;
	supervisor: ProviderSupervisor;
}

////////////////////////////////
//  Functions & Helpers

/** The root the EDITOR names. `workspaceFolders` wins over the deprecated `rootUri`, and a client
 * that names neither is editing a loose file with no project to index. */
function rootFrom(params: unknown): string | null {
	const named = (params ?? {}) as { rootUri?: string | null; workspaceFolders?: Array<{ uri?: string }> | null };
	const uri = named.workspaceFolders?.[0]?.uri ?? named.rootUri;
	return typeof uri === "string" ? pathFromUri(uri) : null;
}

/**
 * The fallback index, built and scanned in this process.
 *
 * Only reached when no daemon can be started, which in practice means a checkout with no built
 * bundle. It answers correctly and shares nothing, which is the trade being made knowingly.
 */
async function buildLocal(workspaceRoot: string, hold: (index: LocalIndex) => void): Promise<LexiconReads> {
	const { store } = IndexStore.open(":memory:");
	const supervisor = new ProviderSupervisor();
	hold({ store, supervisor });

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

	// Crash reports only. The daemon owns the sampled collection; a second writer would corrupt it.
	const reportsDir = workspacePaths(currentHost(), workspaceRoot).reportsDir;
	await startProviders(supervisor, workspaceRoot, { node: nodeReportSetup(reportsDir) });
	const outcomes = await service.indexWorkspace();
	const indexed = outcomes.filter((outcome) => outcome.action === "indexed").length;
	process.stderr.write(`indexed ${indexed} files in this process\n`);
	return localReads(service);
}

/**
 * Answers for one workspace, preferring the daemon.
 *
 * An editor answering from a private index disagrees with the agents beside it, and is invisible to
 * the daemon's linger count, so it can shut down mid-edit. The choice is deferred, not made here.
 */
function serve(workspaceRoot: string): Served {
	let channel: DaemonChannel | null = null;
	let local: LocalIndex | null = null;

	const reads = deferredReads(async () => {
		const daemon = await ensureDaemon({ workspaceRoot });
		if (daemon.connected) {
			process.stderr.write(`answering from the daemon on port ${daemon.lock.port}\n`);
			channel = daemonChannel(workspaceRoot);
			return daemonReads(channel);
		}

		process.stderr.write(`no daemon (${daemon.reason}); indexing in this process instead\n`);
		return buildLocal(workspaceRoot, (index) => {
			local = index;
		});
	});

	return {
		lsp: new LspServer(reads, workspaceRoot),
		close(): void {
			channel?.close();
			local?.supervisor.stopAll();
			local?.store.close();
		},
	};
}

////////////////////////////////
//  Main

async function main(): Promise<void> {
	// Nothing is read from the environment: the workspace arrives in `initialize`, so everything
	// below it is built only once the editor has said which project this is.
	let served: Served | null = null;

	function send(message: Message): void {
		process.stdout.write(encode(message));
	}

	function reply(id: number | string | undefined, result: unknown): void {
		if (id !== undefined) send({ jsonrpc: "2.0", id, result });
	}

	async function handle(message: Message): Promise<void> {
		const params = (message.params ?? {}) as {
			textDocument?: { uri: string };
			position?: { line: number; character: number };
			context?: { includeDeclaration?: boolean };
			newName?: string;
		};
		const uri = params.textDocument?.uri ?? "";
		const position = params.position ?? { line: 0, character: 0 };

		// Lifecycle first, because these are the only methods that mean anything before a workspace
		// exists, and `initialize` is what brings one into being.
		if (message.method === "initialize") {
			const workspaceRoot = rootFrom(message.params);
			// No capabilities rather than false ones: with no workspace there is nothing to index, and
			// claiming hover or rename would promise answers this server cannot have.
			if (workspaceRoot === null) {
				process.stderr.write("no workspace folder named in initialize; nothing to index\n");
				reply(message.id, { capabilities: {}, serverInfo: { name: "nyaa-lexicon" } });
				return;
			}

			// Answered before anything is connected or scanned, so an editor is never held waiting on a
			// workspace before it can show anything at all.
			served = serve(workspaceRoot);
			reply(message.id, { capabilities: CAPABILITIES, serverInfo: { name: "nyaa-lexicon" } });
			return;
		}

		if (message.method === "initialized") return;

		if (message.method === "shutdown") {
			reply(message.id, null);
			return;
		}

		if (message.method === "exit") {
			served?.close();
			process.exit(0);
		}

		// Everything past here reads the index. A request must still be ANSWERED when there is none,
		// or the editor waits for it forever.
		if (served === null) {
			if (message.id !== undefined) {
				send({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32002, message: "no workspace: initialize named none" },
				});
			}
			return;
		}
		const { lsp } = served;

		switch (message.method) {
			case "textDocument/hover":
				reply(message.id, await lsp.hover(uri, position));
				return;

			case "textDocument/definition":
				reply(message.id, await lsp.definition(uri, position));
				return;

			case "textDocument/references":
				reply(message.id, await lsp.references(uri, position, params.context?.includeDeclaration ?? true));
				return;

			case "textDocument/documentSymbol":
				reply(message.id, await lsp.documentSymbol(uri));
				return;

			case "textDocument/typeDefinition":
				reply(message.id, await lsp.typeDefinition(uri, position));
				return;

			case "textDocument/implementation":
				reply(message.id, await lsp.implementation(uri, position));
				return;

			// Prepare returns the item an editor then expands. Ours is the symbol under the cursor, and
			// the two expansions below read the same heritage rows in opposite directions.
			case "textDocument/prepareTypeHierarchy":
				reply(message.id, await lsp.prepareTypeHierarchy(uri, position));
				return;

			case "typeHierarchy/supertypes":
				reply(message.id, await lsp.typeHierarchyStep(message.params, "supertypes"));
				return;

			case "typeHierarchy/subtypes":
				reply(message.id, await lsp.typeHierarchyStep(message.params, "subtypes"));
				return;

			case "textDocument/prepareCallHierarchy":
				reply(message.id, await lsp.prepareCallHierarchy(uri, position));
				return;

			case "callHierarchy/incomingCalls":
				reply(message.id, await lsp.callHierarchyStep(message.params, "incoming"));
				return;

			case "callHierarchy/outgoingCalls":
				reply(message.id, await lsp.callHierarchyStep(message.params, "outgoing"));
				return;

			case "textDocument/prepareRename":
				reply(message.id, await lsp.prepareRename(uri, position));
				return;

			case "textDocument/rename":
				reply(message.id, await lsp.rename(uri, position, params.newName ?? ""));
				return;

			default:
				// A notification has no id and expects no answer; a REQUEST must be answered even when
				// unsupported, or the editor waits for it forever.
				if (message.id !== undefined) {
					send({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: `unsupported: ${message.method}` },
					});
				}
		}
	}

	const read = createReader(
		(message) => {
			void handle(message).catch((error) => {
				process.stderr.write(`request failed: ${error}\n`);
				if (message.id !== undefined) {
					send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error) } });
				}
			});
		},
		(problem) => process.stderr.write(`${problem}\n`),
	);

	process.stdin.on("data", read);
	process.stdin.on("end", () => process.exit(0));
}

if (import.meta.main) await main();
