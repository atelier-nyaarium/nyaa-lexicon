// A provider that warms on each parse and says so, one parse warming forever, and whose every later
// process dies right after its handshake, so the supervisor's phases can be tested live.

import { existsSync, writeFileSync } from "node:fs";
import {
	notImplementedImport,
	notImplementedMove,
	notImplementedType,
	PROTOCOL_VERSION,
	type ProviderEvents,
	type ProviderHandlers,
	runProviderOnStdio,
} from "@nyaa-lexicon/protocol";

/** Written in the workspace, which is this process's cwd, by the first process to start. */
const STARTED = "phased-provider-started";

let events: ProviderEvents | undefined;

/**
 * Warms for a while before each answer, as a compiler's first program build does, then answers a
 * little after it is ready. `hang.phase` warms forever.
 */
async function parse(params: { module: string; contentHash: string }) {
	events?.providerPhase("initializing", "phased program");
	await new Promise((resolve) => {
		if (params.module !== "hang.phase") setTimeout(resolve, 400);
	});
	events?.providerPhase("ready");
	await new Promise((resolve) => setTimeout(resolve, 200));
	return {
		module: params.module,
		contentHash: params.contentHash,
		declarations: [],
		references: [],
		imports: [],
		literals: [],
		diagnostics: [],
	};
}

// The server awaits a promised answer; the table's type names the settled one.
const handlers = {
	initialize: () => {
		if (existsSync(STARTED)) setTimeout(() => process.exit(1), 50);
		else writeFileSync(STARTED, "");
		return {
			providerId: "phased-provider",
			language: "phased",
			extensions: [".phase"],
			protocolVersion: PROTOCOL_VERSION,
			tiers: {
				projectModel: false,
				declarations: true,
				references: false,
				imports: false,
				binding: false,
				types: false,
				literals: false,
				comments: false,
				docs: false,
				metrics: false,
			},
			words: { keywords: [], builtins: [], literals: [] },
		};
	},
	discoverProject: () => ({ files: [], externalRoots: [], configFiles: [], diagnostics: [] }),
	probeFile: parse,
	parseFile: parse,
	resolveImport: () => notImplementedImport("fixture"),
	bind: () => ({ status: "unbound", reason: "NotImplemented", detail: "fixture" }),
	typeOf: () => notImplementedType("fixture"),
	renameEdits: () => ({ status: "refused", reason: "NotImplemented", detail: "fixture" }),
	moveEdits: () => notImplementedMove("fixture"),
	shutdown: () => ({}),
} as unknown as ProviderHandlers;

events = runProviderOnStdio(handlers);
