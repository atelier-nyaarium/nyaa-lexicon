// The wiring every provider shares: its handler table, and a walk that spells modules as ids do.

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { METHOD_SCHEMAS, ProviderMethod } from "./methods.js";
import type { ProjectModel } from "./project.js";
import type { ProviderHandlers } from "./serve.js";
import type { Descriptor } from "./symbolId.js";
import { normalizeModulePath } from "./symbolId.js";

////////////////////////////////
//  Interfaces & Types

type Request<M extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[M]["request"]>;
type Response<M extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[M]["response"]>;

/** A provider as a plain object; `handlersFor` wires it to the method table. */
export interface ProviderMethods {
	initialize(workspaceRoot: string): Response<"initialize">;
	discoverProject(workspaceRoot: string): Response<"discoverProject">;
	parseFile(params: Request<"parseFile">): Response<"parseFile">;
	resolveImport(params: Request<"resolveImport">): Response<"resolveImport">;
	bind(params: Request<"bind">): Response<"bind">;
	typeOf(params: Request<"typeOf">): Response<"typeOf">;
	renameEdits(params: Request<"renameEdits">): Response<"renameEdits">;
	moveEdits(params: Request<"moveEdits">): Response<"moveEdits">;
	shutdown?(): void;
}

export interface WalkOptions {
	/** With the dot; a file is claimed when its name ends with one. */
	extensions: readonly string[];
	/** Exact names claimed regardless of extension. */
	filenames?: readonly string[];
	/** Suffixes collected as the project's configuration rather than its sources. */
	configExtensions?: readonly string[];
	/** Directory names never entered. */
	excludedDirectories?: ReadonlySet<string>;
	/** Claim every regular file below the root. */
	everything?: boolean;
}

////////////////////////////////
//  Constants

/** Directories no language's sources live in. A provider adds its own build outputs. */
export const DEFAULT_EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
	".git",
	".hg",
	".svn",
	".cache",
	".venv",
	"build",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor-cache",
]);

////////////////////////////////
//  Functions & Helpers

export function handlersFor(provider: ProviderMethods): ProviderHandlers {
	return {
		initialize: (params) => provider.initialize(params.workspaceRoot),
		discoverProject: (params) => provider.discoverProject(params.workspaceRoot),
		parseFile: (params) => provider.parseFile(params),
		resolveImport: (params) => provider.resolveImport(params),
		bind: (params) => provider.bind(params),
		typeOf: (params) => provider.typeOf(params),
		renameEdits: (params) => provider.renameEdits(params),
		moveEdits: (params) => provider.moveEdits(params),
		shutdown: () => {
			provider.shutdown?.();
			return {};
		},
	};
}

/** The module a file under `root` gets, or null when it is outside or unrepresentable. */
export function workspaceModule(root: string, absolute: string): string | null {
	const relative = path.relative(root, absolute).split(path.sep).join("/");
	if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) return null;
	try {
		return normalizeModulePath(relative);
	} catch {
		return null;
	}
}

/** The absolute path of a module inside `root`, or null when it would leave it. */
export function workspaceFile(root: string, module: string): string | null {
	let canonical: string;
	try {
		canonical = normalizeModulePath(module);
	} catch {
		return null;
	}
	const absolute = path.resolve(root, ...canonical.split("/"));
	const relative = path.relative(root, absolute);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return absolute;
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

/** Every claimed file under `root`, sorted. An unreadable directory is skipped, never fatal. */
export function walkWorkspace(root: string, options: WalkOptions): { files: string[]; configFiles: string[] } {
	const excluded = options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES;
	const claimed = (name: string) =>
		options.everything === true ||
		options.extensions.some((extension) => name.endsWith(extension)) ||
		(options.filenames?.includes(name) ?? false);
	const config = (name: string) => options.configExtensions?.some((extension) => name.endsWith(extension)) ?? false;
	const files: string[] = [];
	const configFiles: string[] = [];

	function visit(directory: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
		} catch {
			return;
		}
		for (const entry of entries) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!excluded.has(entry.name)) visit(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			const source = claimed(entry.name);
			const configuration = config(entry.name);
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
