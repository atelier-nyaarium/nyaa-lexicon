import {
	handlersFor,
	PROTOCOL_VERSION,
	type ProviderHandlers,
	type ProviderNotificationHandlers,
} from "@nyaa-lexicon/protocol";
import { TypeScriptProvider } from "../main.js";

export function harness() {
	const provider = new TypeScriptProvider();
	const handlers = handlersFor(provider);
	const wire = handlers as ProviderHandlers & ProviderNotificationHandlers;

	return {
		initialize(workspaceRoot: string) {
			const answer = handlers.initialize({ workspaceRoot, protocolVersion: PROTOCOL_VERSION });
			handlers.discoverProject({ workspaceRoot });
			return answer;
		},
		parseFile(params: Parameters<typeof handlers.parseFile>[0]) {
			const answer = handlers.parseFile(params);
			handlers.moduleAdmission?.({
				module: params.module,
				contentHash: params.contentHash,
				outcome: { status: "admitted" },
			});
			return answer;
		},
		probeFile: handlers.probeFile,
		resolveImport: handlers.resolveImport,
		bind: handlers.bind,
		typeOf: handlers.typeOf,
		renameEdits: handlers.renameEdits,
		moveEdits: handlers.moveEdits,
		forgetModule: (params: { module: string }) => wire.forgetModule?.(params),
		programStats: () => {
			const analyzer = provider.store.project.analyzer;
			return (
				analyzer?.programStats() ?? {
					rootFiles: 0,
					workspaceFiles: 0,
					firstProgramMs: undefined,
					programGenerations: 0,
				}
			);
		},
		shutdown: () => handlers.shutdown({}),
		handlers: wire,
		provider,
	};
}
