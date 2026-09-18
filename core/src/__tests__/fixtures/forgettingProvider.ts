// A provider that remembers each module it is told to forget, and says so through `bind`, so the
// supervisor's notification can be tested live.

import {
	notImplementedImport,
	notImplementedMove,
	notImplementedType,
	PROTOCOL_VERSION,
	type ProviderHandlers,
	type ProviderNotificationHandlers,
	runProviderOnStdio,
} from "@nyaa-lexicon/protocol";

const forgotten: string[] = [];

const handlers: ProviderHandlers & ProviderNotificationHandlers = {
	initialize: () => ({
		providerId: "forgetting-provider",
		language: "forgetting",
		extensions: [".forget"],
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
	bind: () => ({ status: "unbound", reason: "NotIndexed", detail: `forgotten: ${forgotten.join(",")}` }),
	typeOf: () => notImplementedType("fixture"),
	renameEdits: () => ({ status: "refused", reason: "NotImplemented", detail: "fixture" }),
	moveEdits: () => notImplementedMove("fixture"),
	shutdown: () => ({}),
	forgetModule: ({ module }) => {
		forgotten.push(module);
	},
};

if (import.meta.main) runProviderOnStdio(handlers);
