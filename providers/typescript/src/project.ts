// The project model: which files are in scope, and where a specifier lands.
//
// The largest per-language cost in the contract, and the reason this provider wraps the compiler
// rather than a grammar. tsconfig paths, package exports and extension resolution are all here,
// and none of them are things a syntax tree can answer.

import path from "node:path";
import { normalizeModulePath } from "@nyaa-lexicon/protocol";
import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

export interface LoadedProject {
	options: ts.CompilerOptions;
	files: string[];
	configFiles: string[];
	diagnostics: { severity: "error" | "warning"; message: string; path?: string }[];
}

////////////////////////////////
//  Constants

const HOST: ts.ModuleResolutionHost = {
	fileExists: ts.sys.fileExists,
	readFile: ts.sys.readFile,
	directoryExists: ts.sys.directoryExists,
	getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
	getDirectories: ts.sys.getDirectories,
	// Omitted rather than set undefined: the host declares it optional, and this project forbids
	// an explicit undefined standing in for an absent one.
	...(ts.sys.realpath ? { realpath: ts.sys.realpath } : {}),
};

/** Defaults for a workspace with no tsconfig, so an unconfigured repo still answers. */
const FALLBACK: ts.CompilerOptions = {
	target: ts.ScriptTarget.ESNext,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	allowJs: true,
};

////////////////////////////////
//  Functions & Helpers

/**
 * Load the nearest tsconfig, or fall back.
 *
 * A missing tsconfig is not an error: plenty of real JavaScript has none, and refusing would make
 * the provider useless exactly where a symbol index helps most.
 */
export function loadProject(workspaceRoot: string): LoadedProject {
	const configPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, "tsconfig.json");
	if (configPath === undefined) {
		return { options: FALLBACK, files: [], configFiles: [], diagnostics: [] };
	}

	const read = ts.readConfigFile(configPath, ts.sys.readFile);
	if (read.error) {
		return {
			options: FALLBACK,
			files: [],
			configFiles: [configPath],
			diagnostics: [{ severity: "error", message: messageOf(read.error), path: configPath }],
		};
	}

	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), undefined, configPath);
	const configFiles = [configPath];
	const files = [...parsed.fileNames];
	const diagnostics: LoadedProject["diagnostics"] = parsed.errors.map((error) => ({
		severity: "error",
		message: messageOf(error),
	}));

	// A solution-style tsconfig lists no files of its own, only references. Stopping here would
	// answer "this monorepo contains nothing", which is the shape most real projects have.
	for (const reference of parsed.projectReferences ?? []) {
		const referenced = loadReferenced(reference.path);
		files.push(...referenced.files);
		configFiles.push(...referenced.configFiles);
		diagnostics.push(...referenced.diagnostics);
	}

	// Reported rather than thrown: one bad config entry should not make the whole project
	// unanswerable, and the core shows diagnostics beside the facts it did get.
	return { options: parsed.options, files: dedupe(files), configFiles, diagnostics };
}

/** One referenced project. Its own references are not followed: one level is what a solution is. */
function loadReferenced(referencePath: string): Omit<LoadedProject, "options"> {
	const configPath = ts.sys.directoryExists(referencePath)
		? path.join(referencePath, "tsconfig.json")
		: referencePath;
	if (!ts.sys.fileExists(configPath)) {
		return { files: [], configFiles: [], diagnostics: [{ severity: "warning", message: `missing ${configPath}` }] };
	}

	const read = ts.readConfigFile(configPath, ts.sys.readFile);
	if (read.error) {
		return {
			files: [],
			configFiles: [configPath],
			diagnostics: [{ severity: "error", message: messageOf(read.error), path: configPath }],
		};
	}

	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), undefined, configPath);
	return {
		files: parsed.fileNames,
		configFiles: [configPath],
		diagnostics: parsed.errors.map((error) => ({ severity: "error" as const, message: messageOf(error) })),
	};
}

function dedupe(files: string[]): string[] {
	return [...new Set(files)];
}

function messageOf(diagnostic: ts.Diagnostic): string {
	return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

/** Workspace-relative and POSIX, matching the id grammar. Null when it escapes the workspace. */
export function toModule(workspaceRoot: string, absolute: string): string | null {
	try {
		return normalizeModulePath(path.relative(workspaceRoot, absolute));
	} catch {
		return null;
	}
}

////////////////////////////////
//  Resolution

/**
 * Where a specifier lands, per the compiler's own rules.
 *
 * The three answers are deliberately distinct. A file in the workspace, a dependency we chose not
 * to index, and a specifier that resolves to nothing are different facts, and collapsing the last
 * two would hide every genuinely broken import.
 */
export function resolveSpecifier(
	workspaceRoot: string,
	fromModule: string,
	specifier: string,
	options: ts.CompilerOptions,
):
	| { status: "resolved"; module: string }
	| { status: "external"; packageName: string }
	| { status: "unresolved"; reason: "ExternalDependency" | "RuntimeConstructed"; detail: string } {
	const containing = path.join(workspaceRoot, fromModule);
	const resolved = ts.resolveModuleName(specifier, containing, options, HOST).resolvedModule;

	if (resolved === undefined) {
		// A bare specifier that resolves to nothing is still named as a package, since that is what
		// the author wrote and what a reader needs to go look up.
		const bare = !specifier.startsWith(".") && !path.isAbsolute(specifier);
		return {
			status: "unresolved",
			reason: bare ? "ExternalDependency" : "RuntimeConstructed",
			detail: bare ? `${packageNameOf(specifier)} is not installed` : "no file matched the specifier",
		};
	}

	if (resolved.isExternalLibraryImport === true) {
		return { status: "external", packageName: resolved.packageId?.name ?? packageNameOf(specifier) };
	}

	const module = toModule(workspaceRoot, resolved.resolvedFileName);
	if (module === null) return { status: "external", packageName: packageNameOf(specifier) };
	return { status: "resolved", module };
}

/** `@scope/name` keeps two segments; everything else keeps one. */
function packageNameOf(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}
