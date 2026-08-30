// A provider that reports comment spans while declaring no comments tier, so the supervisor's
// boundary can be tested live.

import {
	notImplementedBinding,
	notImplementedImport,
	notImplementedMove,
	notImplementedType,
	PROTOCOL_VERSION,
	type ProviderHandlers,
	runProviderOnStdio,
} from "@nyaa-lexicon/protocol";

const handlers: ProviderHandlers = {
	initialize: () => ({
		providerId: "undeclared-comments-provider",
		language: "undeclared",
		extensions: [".undeclared"],
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
	}),
	discoverProject: () => ({ files: [], externalRoots: [], configFiles: [], diagnostics: [] }),
	parseFile: (params) => ({
		module: params.module,
		contentHash: params.contentHash,
		declarations: [],
		references: [],
		imports: [],
		literals: [],
		comments: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, text: "// a" }],
		diagnostics: [],
	}),
	resolveImport: () => notImplementedImport("fixture"),
	bind: () => notImplementedBinding("fixture"),
	typeOf: () => notImplementedType("fixture"),
	renameEdits: () => ({ status: "refused", reason: "NotImplemented", detail: "fixture" }),
	moveEdits: () => notImplementedMove("fixture"),
	shutdown: () => ({}),
};

if (import.meta.main) runProviderOnStdio(handlers);
