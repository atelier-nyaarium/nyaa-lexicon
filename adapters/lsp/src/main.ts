// The LSP entrypoint. Bundled into dist/ and run as `bun dist/lsp.js`.
//
// The verdict runs before any lexicon code evaluates, on stderr since stdout is the editor's. The
// bundle still hoists builtin imports above it, so the named sentence is guaranteed on a node
// that has `node:sqlite` (22.5+).

import { refuseRuntime } from "@nyaa-lexicon/client";

const refused = refuseRuntime("the lexicon language server");
if (refused !== null) {
	process.stderr.write(`${refused}\n`);
	process.exit(1);
}

const { main } = await import("./serve.js");
await main();
