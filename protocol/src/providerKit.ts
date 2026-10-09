// The wiring every provider shares: its handler table, and a walk that spells modules as ids do.

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
	directoryEntries,
	type ExcludedDirectories,
	excludesDirectory,
	underExcludedDirectory,
} from "./excludedDirectories.js";
import type { METHOD_SCHEMAS, NOTIFICATION_SCHEMAS, ProviderMethod } from "./methods.js";
import { type ModuleValue, type StoreProvider, storeHandlersFor } from "./moduleStore.js";
import type { ProjectModel } from "./project.js";
import { type ReadPolicy, readPolicy } from "./readPolicy.js";
import { type ProviderEvents, type ProviderHandlers, type ProviderNotificationHandlers, whenServed } from "./serve.js";
import { shebangInterpreter } from "./shebang.js";
import { readWorkspaceHead } from "./sourceFile.js";
import type { Descriptor } from "./symbolId.js";
import { workspaceModule } from "./workspacePath.js";

export { workspaceFile, workspaceModule } from "./workspacePath.js";

////////////////////////////////
//  Interfaces & Types

type Request<M extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[M]["request"]>;
type Response<M extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[M]["response"]>;

/** Handler contract for stateless providers. */
export interface ProviderMethods {
	/** `policy` says which workspace files it may read. */
	initialize(workspaceRoot: string, policy: ReadPolicy): Response<"initialize">;
	discoverProject(workspaceRoot: string, scope?: string[]): Response<"discoverProject">;
	parseFile(params: Request<"parseFile">): Response<"parseFile">;
	resolveImport(params: Request<"resolveImport">): Response<"resolveImport">;
	judgeLoadCycle?(params: Request<"judgeLoadCycle">): Response<"judgeLoadCycle">;
	/** Drops the state a `judgeLoadCycle` partial token holds. */
	releaseLoadCycle?(params: z.infer<(typeof NOTIFICATION_SCHEMAS)["releaseLoadCycle"]>): void;
	prepareLoadCyclePreview?(params: Request<"prepareLoadCyclePreview">): Response<"prepareLoadCyclePreview">;
	releaseLoadCyclePreview?(params: z.infer<(typeof NOTIFICATION_SCHEMAS)["releaseLoadCyclePreview"]>): void;
	bind(params: Request<"bind">): Response<"bind">;
	typeOf(params: Request<"typeOf">): Response<"typeOf">;
	renameEdits(params: Request<"renameEdits">): Response<"renameEdits">;
	moveEdits(params: Request<"moveEdits">): Response<"moveEdits">;
	arrangeEdits(params: Request<"arrangeEdits">): Response<"arrangeEdits">;
	importEdits(params: Request<"importEdits">): Response<"importEdits">;
	shutdown?(): void;
	/** The sender for what the provider tells core unasked, once it is served. */
	connected?(events: ProviderEvents): void;
}

export interface WalkOptions {
	/** With the dot; a file is claimed when its name ends with one. */
	extensions: readonly string[];
	/** Exact names claimed regardless of extension. */
	filenames?: readonly string[];
	/** Interpreters whose shebang claims an extensionless file; the walk reads its first line for it. */
	shebangs?: readonly string[];
	/** Suffixes collected as the project's configuration rather than its sources. */
	configExtensions?: readonly string[];
	/** Directories never entered, as declared at initialize. Absent: the default names, at any depth. */
	excludedDirectories?: ExcludedDirectories;
	/** Claim every regular file below the root. */
	everything?: boolean;
	/** Core-owned workspace-relative modules to consider. */
	scope?: readonly string[] | undefined;
}

////////////////////////////////
//  Constants

/** Directories no language's sources live in, and outputs at the root. A provider adds its own. */
export const DEFAULT_EXCLUDED_DIRECTORIES = {
	anywhere: [".git", ".hg", ".svn", ".cache", ".venv", "node_modules", "vendor-cache"],
	beside: [{ names: ["build", "dist", "out", "target"] }],
} as const satisfies ExcludedDirectories;

/** A walk with no declared set: core excludes nothing for it, and the walk skips every default name. */
const UNDECLARED_EXCLUDED_DIRECTORIES: ExcludedDirectories = {
	anywhere: [
		...DEFAULT_EXCLUDED_DIRECTORIES.anywhere,
		...DEFAULT_EXCLUDED_DIRECTORIES.beside.flatMap((group) => group.names),
	],
};

////////////////////////////////
//  Functions & Helpers

/** Wire stateless methods; probes call `parseFile`. */
export function handlersFor<V extends ModuleValue, P, E>(
	provider: ProviderMethods | StoreProvider<V, P, E>,
): ProviderHandlers & ProviderNotificationHandlers {
	if ("store" in provider) return storeHandlersFor(provider);
	const judgeLoadCycle = provider.judgeLoadCycle;
	const releaseLoadCycle = provider.releaseLoadCycle;
	const prepareLoadCyclePreview = provider.prepareLoadCyclePreview;
	const releaseLoadCyclePreview = provider.releaseLoadCyclePreview;
	const handlers: ProviderHandlers & ProviderNotificationHandlers = {
		initialize: (params) =>
			provider.initialize(params.workspaceRoot, readPolicy(params.workspaceRoot, params.deny)),
		discoverProject: (params) => provider.discoverProject(params.workspaceRoot, params.scope),
		parseFile: (params) => provider.parseFile(params),
		probeFile: (params) => provider.parseFile(params),
		// Reads other files from disk, so it holds no view of several proposed texts.
		probeBatch: () => ({ status: "unsupported" }),
		prepareLoadCyclePreview: (params) =>
			prepareLoadCyclePreview?.call(provider, params) ?? { status: "unsupported" },
		resolveImport: (params) => provider.resolveImport(params),
		...(judgeLoadCycle === undefined
			? {}
			: { judgeLoadCycle: (params: Request<"judgeLoadCycle">) => judgeLoadCycle.call(provider, params) }),
		...(releaseLoadCycle === undefined
			? {}
			: { releaseLoadCycle: (params: { partial: string }) => releaseLoadCycle.call(provider, params) }),
		...(releaseLoadCyclePreview === undefined
			? {}
			: {
					releaseLoadCyclePreview: (params: { preview: string }) =>
						releaseLoadCyclePreview.call(provider, params),
				}),
		bind: (params) => provider.bind(params),
		typeOf: (params) => provider.typeOf(params),
		renameEdits: (params) => provider.renameEdits(params),
		moveEdits: (params) => provider.moveEdits(params),
		arrangeEdits: (params) => provider.arrangeEdits(params),
		importEdits: (params) => provider.importEdits(params),
		shutdown: () => {
			provider.shutdown?.();
			return {};
		},
	};
	whenServed(handlers, (events) => provider.connected?.(events));
	return handlers;
}

export function projectDiagnostic(root: string, message: string): ProjectModel {
	return { files: [], externalRoots: [], configFiles: [], diagnostics: [{ severity: "error", message, path: root }] };
}

/** Resolves written qualifiers: same-parse declarations keep their descriptor; other segments use namespace identity. */
export function qualifierDescriptors(
	names: string[],
	declared: (name: string) => Descriptor | undefined,
): Descriptor[] {
	return names.map((name) => declared(name) ?? { kind: "namespace", name });
}

/** Returns angle depth change; `>>=` is not a closer here. */
export function angleDelta(text: string): number {
	if (text === "<") return 1;
	if (text === ">") return -1;
	if (text === ">>") return -2;
	return 0;
}

/** Whether a name has no extension; a leading dot is the whole name, not an extension. */
function extensionless(name: string): boolean {
	return name.lastIndexOf(".") <= 0;
}

/** Whether a module is claimed as source, by its name or, extensionless, its shebang, and as config. */
function claimsOf(root: string, options: WalkOptions) {
	const shebangs = options.shebangs ?? [];
	const byShebang = (module: string | null) => {
		const interpreter = module === null ? undefined : shebangInterpreter(readWorkspaceHead(root, module) ?? "");
		return interpreter !== undefined && shebangs.includes(interpreter);
	};
	return {
		/** `module` is asked only for an extensionless name. */
		source: (name: string, module: () => string | null) =>
			options.everything === true ||
			options.extensions.some((extension) => name.endsWith(extension)) ||
			(options.filenames?.includes(name) ?? false) ||
			(shebangs.length > 0 && extensionless(name) && byShebang(module())),
		config: (name: string) => options.configExtensions?.some((extension) => name.endsWith(extension)) ?? false,
	};
}

/** Every claimed file under `root`, or in `options.scope`, sorted. An unreadable directory is skipped, never fatal. */
export function walkWorkspace(root: string, options: WalkOptions): { files: string[]; configFiles: string[] } {
	if (options.scope !== undefined) return scopedWorkspace(root, options);
	const excluded = options.excludedDirectories ?? UNDECLARED_EXCLUDED_DIRECTORIES;
	const claims = claimsOf(root, options);
	const files: string[] = [];
	const configFiles: string[] = [];

	function visit(directory: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
		} catch {
			return;
		}
		const names = entries.map((entry) => entry.name);
		for (const entry of entries) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!excludesDirectory(excluded, entry.name, directory === root, () => names)) visit(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			const source = claims.source(entry.name, () => workspaceModule(root, absolute));
			const configuration = claims.config(entry.name);
			if (!source && !configuration) continue;
			const module = workspaceModule(root, absolute);
			if (module === null) continue;
			if (source) files.push(module);
			if (configuration) configFiles.push(module);
		}
	}
	visit(root);
	return { files: files.sort(), configFiles: configFiles.sort() };
}

/**
 * The claimed files among core's scope, which already left out what the workspace ignores. A
 * provider's own excluded directories are skipped as core skips them, so only a declared set applies.
 */
function scopedWorkspace(root: string, options: WalkOptions): { files: string[]; configFiles: string[] } {
	const excluded = options.excludedDirectories;
	const entries = directoryEntries(root);
	const claims = claimsOf(root, options);
	const files = new Set<string>();
	const configFiles = new Set<string>();
	for (const module of options.scope ?? []) {
		if (excluded !== undefined && underExcludedDirectory(module, excluded, entries)) continue;
		if (workspaceModule(root, path.resolve(root, module)) === null) continue;
		const name = path.basename(module);
		if (claims.source(name, () => module)) files.add(module);
		if (claims.config(name)) configFiles.add(module);
	}
	return { files: [...files].sort(), configFiles: [...configFiles].sort() };
}

/** The project model of a workspace with no build system to ask: a walk, or why not. */
export function discoverByWalk(workspaceRoot: string, options: WalkOptions): ProjectModel {
	const root = path.resolve(workspaceRoot);
	try {
		if (!existsSync(root)) return projectDiagnostic(root, `workspace root does not exist: ${root}`);
		if (!statSync(root).isDirectory()) return projectDiagnostic(root, `workspace root is not a directory: ${root}`);
		const walked = walkWorkspace(root, options);
		return { files: walked.files, externalRoots: [], configFiles: walked.configFiles, diagnostics: [] };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return projectDiagnostic(root, `unable to inspect workspace root: ${detail}`);
	}
}
