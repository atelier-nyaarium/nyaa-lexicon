// The LSP entrypoint. Bundled into dist/ and run as `node dist/lsp.js`, so nothing here may import
// a bun-only module.
//
// An editor speaks this over stdin and stdout, which is why nothing may ever be written to stdout
// except a framed message: a stray console.log corrupts the stream and the editor sees a protocol
// error rather than the print. Every diagnostic here goes to stderr.

import { readFileSync } from "node:fs";
import path from "node:path";
import { IndexStore, LexiconService, ProviderSupervisor, startProviders } from "@nyaa-lexicon/core";
import { LspServer } from "./server.js";
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
//  Main

async function main(): Promise<void> {
	const workspaceRoot = process.env["LEXICON_WORKSPACE"] ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();

	const { store } = IndexStore.open(":memory:");
	const supervisor = new ProviderSupervisor();
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
	const lsp = new LspServer(service, workspaceRoot);

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

		switch (message.method) {
			case "initialize":
				reply(message.id, { capabilities: CAPABILITIES, serverInfo: { name: "nyaa-lexicon" } });
				// Indexing starts AFTER the handshake is answered, so an editor is never held waiting
				// on a workspace scan before it can show anything at all.
				void startProviders(supervisor, workspaceRoot)
					.then(() => service.indexWorkspace())
					.then((outcomes) => {
						const indexed = outcomes.filter((outcome) => outcome.action === "indexed").length;
						process.stderr.write(`indexed ${indexed} files\n`);
					})
					.catch((error) => process.stderr.write(`indexing failed: ${error}\n`));
				return;

			case "initialized":
				return;

			case "shutdown":
				reply(message.id, null);
				return;

			case "exit":
				supervisor.stopAll();
				store.close();
				process.exit(0);
				return;

			case "textDocument/hover":
				reply(message.id, await lsp.hover(uri, position));
				return;

			case "textDocument/definition":
				reply(message.id, lsp.definition(uri, position));
				return;

			case "textDocument/references":
				reply(message.id, lsp.references(uri, position, params.context?.includeDeclaration ?? true));
				return;

			case "textDocument/documentSymbol":
				reply(message.id, lsp.documentSymbol(uri));
				return;

			case "textDocument/typeDefinition":
				reply(message.id, await lsp.typeDefinition(uri, position));
				return;

			case "textDocument/implementation":
				reply(message.id, lsp.implementation(uri, position));
				return;

			// Prepare returns the item an editor then expands. Ours is the symbol under the cursor, and
			// the two expansions below read the same heritage rows in opposite directions.
			case "textDocument/prepareTypeHierarchy":
				reply(message.id, lsp.prepareTypeHierarchy(uri, position));
				return;

			case "typeHierarchy/supertypes":
				reply(message.id, lsp.typeHierarchyStep(message.params, "supertypes"));
				return;

			case "typeHierarchy/subtypes":
				reply(message.id, lsp.typeHierarchyStep(message.params, "subtypes"));
				return;

			case "textDocument/prepareCallHierarchy":
				reply(message.id, lsp.prepareCallHierarchy(uri, position));
				return;

			case "callHierarchy/incomingCalls":
				reply(message.id, lsp.callHierarchyStep(message.params, "incoming"));
				return;

			case "callHierarchy/outgoingCalls":
				reply(message.id, lsp.callHierarchyStep(message.params, "outgoing"));
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
