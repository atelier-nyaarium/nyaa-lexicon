// A provider claiming `.h` only beside `.cpp`, so the supervisor's evidence can be tested live.

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
		providerId: "header-provider",
		language: "header",
		extensions: [],
		sharedExtensions: [{ extension: ".h", beside: [".cpp"] }],
		protocolVersion: PROTOCOL_VERSION,
		tiers: {
			projectModel: false,
			declarations: false,
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
