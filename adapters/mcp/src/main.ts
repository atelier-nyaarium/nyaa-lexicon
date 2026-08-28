// The MCP entrypoint. Bundled into dist/ and run as `bun dist/main.js`.
//
// The verdict runs before any lexicon code evaluates. The bundle still hoists builtin imports
// above it, so the named sentence is guaranteed on a node that has `node:sqlite` (22.5+).

import { refuseRuntime } from "@nyaa-lexicon/client";

const refused = refuseRuntime("the lexicon MCP server");
if (refused !== null) {
	console.error(refused);
	process.exit(1);
}

const { main } = await import("./serve.js");
await main(process.argv.slice(2));
