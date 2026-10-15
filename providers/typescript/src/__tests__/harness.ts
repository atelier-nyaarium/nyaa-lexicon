import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	handlersFor,
	PROTOCOL_VERSION,
	type ProviderHandlers,
	type ProviderNotificationHandlers,
} from "@nyaa-lexicon/protocol";
import { TypeScriptProvider } from "../main.js";

const workspaces: string[] = [];
const workspaceCleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of workspaceCleanups.splice(0)) cleanup();
	for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function workspace(
	files: Record<string, string>,
	options: {
		configFiles?: Record<string, string>;
		createParents?: boolean;
		setup?: (root: string) => (() => void) | undefined;
	} = {},
): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-"));
	workspaces.push(root);
	for (const [file, text] of Object.entries({ ...(options.configFiles ?? {}), ...files })) {
		const target = path.join(root, file);
		if (options.createParents !== false) mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, text);
	}
	const cleanup = options.setup?.(root);
	if (cleanup !== undefined) workspaceCleanups.push(cleanup);
	return root;
}

export function harness() {
	const provider = new TypeScriptProvider();
	const handlers = handlersFor(provider);
	const wire = handlers as ProviderHandlers & ProviderNotificationHandlers;

	return {
		initialize(workspaceRoot: string, deny?: string[]) {
			const answer = handlers.initialize({
				workspaceRoot,
				protocolVersion: PROTOCOL_VERSION,
				...(deny === undefined ? {} : { deny }),
			});
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
		arrangeEdits: handlers.arrangeEdits,
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
