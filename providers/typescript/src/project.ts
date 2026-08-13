// The project model: which files are in scope, and where a specifier lands.
//
// The largest per-language cost in the contract, and the reason this provider wraps the compiler
// rather than a grammar. tsconfig paths, package exports and extension resolution are all here,
// and none of them are things a syntax tree can answer.

import path from "node:path";
import { type ImportResolution, normalizeModulePath } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { configuredSurfaceCandidates, isDeclarationModule, isLikelyBundle, surfaceGlobMatches } from "./bundle.js";
import { claimsExtension } from "./file-types.js";

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
	surfaceGlobs: string[] = [],
): ImportResolution {
	const containing = path.join(workspaceRoot, fromModule);
	const resolved = ts.resolveModuleName(specifier, containing, options, HOST).resolvedModule;

	if (resolved === undefined) {
		const runtime = resolveRuntimeSurface(workspaceRoot, containing, specifier, options, surfaceGlobs);
		if (runtime !== null) return runtime;
		// A bare specifier that resolves to nothing is still named as a package, since that is what
		// the author wrote and what a reader needs to go look up.
		const bare = !specifier.startsWith(".") && !path.isAbsolute(specifier);
		return {
			status: "unresolved",
			reason: bare ? "ExternalDependency" : "RuntimeConstructed",
			detail: bare ? `${packageNameOf(specifier)} is not installed` : "no file matched the specifier",
		};
	}

	const module = toModule(workspaceRoot, resolved.resolvedFileName);
	if (module === null) return { status: "external", packageName: packageNameOf(specifier) };
	if (resolved.isExternalLibraryImport === true) {
		return {
			status: "external",
			packageName: resolved.packageId?.name ?? packageNameOf(specifier),
			surface: { module },
		};
	}
	return surfaceDepth(module, resolved.resolvedFileName, surfaceGlobs) === "surface"
		? { status: "resolved", module, depth: "surface" }
		: { status: "resolved", module };
}

////////////////////////////////
//  Reverse Resolution

export type SpecifierRenderResult =
	| { specifier: string }
	| { reason: "NoImportPath" | "AmbiguousImportPath"; detail: string };

export type SpecifierRenderer = (
	fromModule: string,
	targetModule: string,
	preferredSpecifier?: string,
) => SpecifierRenderResult;

/** Render a module specifier that the existing resolver can send back to the target module. */
export function renderSpecifier(
	workspaceRoot: string,
	fromModule: string,
	targetModule: string,
	options: ts.CompilerOptions,
	preferredSpecifier?: string,
): SpecifierRenderResult {
	const root = path.resolve(workspaceRoot);
	const from = moduleAbsolute(root, fromModule);
	const target = moduleAbsolute(root, targetModule);
	if (from === undefined || target === undefined) {
		return { reason: "NoImportPath", detail: "the importing or target module is not a TypeScript module" };
	}

	const targetExists = ts.sys.fileExists(target);
	const candidates = dedupeCandidates([
		{
			specifier: relativeSpecifier(fromModule, targetModule, options, preferredSpecifier),
			kind: "relative" as const,
		},
		...pathAliasCandidates(root, target, options),
		...packageCandidates(root, fromModule, target, targetModule, options),
	]);
	const preferredKind = preferredSpecifier === undefined ? undefined : candidateKind(preferredSpecifier, options);
	const preferred =
		preferredKind === undefined ? candidates : candidates.filter((candidate) => candidate.kind === preferredKind);
	const considered = preferred.length > 0 ? preferred : candidates;
	const valid = targetExists
		? considered.filter((candidate) =>
				resolvesToTarget(root, fromModule, candidate.specifier, targetModule, options),
			)
		: considered;

	if (valid.length === 1) return { specifier: valid[0]?.specifier as string };
	if (valid.length > 1) {
		return {
			reason: "AmbiguousImportPath",
			detail: `several specifiers address ${targetModule}`,
		};
	}
	return { reason: "NoImportPath", detail: `no specifier addresses ${targetModule} from ${fromModule}` };
}

interface RenderCandidate {
	specifier: string;
	kind: "relative" | "alias" | "package";
}

function moduleAbsolute(root: string, module: string): string | undefined {
	if (!claimsExtension(module)) return undefined;
	try {
		const normalized = normalizeModulePath(module);
		const absolute = path.resolve(root, normalized);
		return toModule(root, absolute) === normalized ? absolute : undefined;
	} catch {
		return undefined;
	}
}

function relativeSpecifier(
	fromModule: string,
	targetModule: string,
	options: ts.CompilerOptions,
	preferredSpecifier: string | undefined,
): string {
	const targetBase = stripModuleExtension(targetModule);
	const relativeBase = toPosix(path.relative(path.posix.dirname(fromModule), targetBase));
	const base = relativeBase === "" ? "" : relativeBase;
	const extension = relativeImportExtension(targetModule, options, preferredSpecifier);
	const rendered = `${base}${extension}`;
	return rendered.startsWith(".") ? rendered : `./${rendered}`;
}

function relativeImportExtension(
	targetModule: string,
	options: ts.CompilerOptions,
	preferredSpecifier: string | undefined,
): string {
	const targetExtension = moduleExtension(targetModule);
	if (preferredSpecifier?.startsWith(".")) {
		const preferredPath = preferredSpecifier.split(/[?#]/, 1)[0] ?? preferredSpecifier;
		const preferredExtension = path.posix.extname(preferredPath);
		if ([".js", ".jsx", ".mjs", ".cjs"].includes(preferredExtension)) {
			return runtimeExtension(targetExtension);
		}
		if ([".ts", ".tsx", ".mts", ".cts", ".d.ts"].includes(preferredExtension)) {
			return targetExtension;
		}
		return "";
	}
	if (isNodeEsm(options)) {
		if ([".ts", ".tsx", ".mts", ".cts", ".d.ts"].includes(targetExtension))
			return runtimeExtension(targetExtension);
		if ([".js", ".jsx", ".mjs", ".cjs"].includes(targetExtension)) return targetExtension;
	}
	return "";
}

function runtimeExtension(extension: string): string {
	if (extension === ".mts") return ".mjs";
	if (extension === ".cts") return ".cjs";
	if (extension === ".tsx") return ".jsx";
	if (extension === ".d.ts") return ".js";
	if (extension === ".ts") return ".js";
	return extension;
}

function isNodeEsm(options: ts.CompilerOptions): boolean {
	return (
		options.moduleResolution === ts.ModuleResolutionKind.Node16 ||
		options.moduleResolution === ts.ModuleResolutionKind.NodeNext
	);
}

function pathAliasCandidates(root: string, target: string, options: ts.CompilerOptions): RenderCandidate[] {
	if (options.paths === undefined) return [];
	const baseUrl = options.baseUrl ?? root;
	const candidates: RenderCandidate[] = [];
	for (const [pattern, substitutions] of Object.entries(options.paths)) {
		for (const substitution of substitutions ?? []) {
			const star = substitution.indexOf("*");
			if (star === -1) {
				const candidateTarget = path.resolve(baseUrl, substitution);
				if (stripExtension(candidateTarget) !== stripExtension(target)) continue;
				candidates.push({ specifier: pattern, kind: "alias" });
				continue;
			}

			const prefix = path.resolve(baseUrl, substitution.slice(0, star));
			const suffix = substitution.slice(star + 1);
			const relative = path.relative(prefix, target);
			if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
			const relativeWithoutExtension = stripModuleExtension(toPosix(relative));
			const suffixWithoutExtension = stripModuleExtension(toPosix(suffix));
			if (suffixWithoutExtension !== "" && !relativeWithoutExtension.endsWith(suffixWithoutExtension)) continue;
			const wildcard =
				suffixWithoutExtension === ""
					? relativeWithoutExtension
					: relativeWithoutExtension.slice(0, -suffixWithoutExtension.length);
			candidates.push({ specifier: pattern.replace("*", wildcard), kind: "alias" });
		}
	}
	return candidates;
}

function packageCandidates(
	root: string,
	fromModule: string,
	target: string,
	targetModule: string,
	options: ts.CompilerOptions,
): RenderCandidate[] {
	const packageInfo = nearestPackage(target, root);
	if (packageInfo === undefined || packageInfo.exports === false) return [];
	const relative = stripModuleExtension(toPosix(path.relative(packageInfo.root, target)));
	if (relative.startsWith("..")) return [];
	const suffix = relative === "index" ? "" : `/${relative}`;
	const specifier = `${packageInfo.name}${suffix}`;
	return resolvesToTarget(root, fromModule, specifier, targetModule, options) ? [{ specifier, kind: "package" }] : [];
}

function nearestPackage(target: string, root: string): { name: string; root: string; exports: boolean } | undefined {
	let directory = path.dirname(target);
	while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
		const packagePath = path.join(directory, "package.json");
		const text = ts.sys.readFile(packagePath);
		if (text !== undefined) {
			try {
				const value = JSON.parse(text) as { name?: unknown; exports?: unknown };
				if (typeof value.name === "string") {
					return { name: value.name, root: directory, exports: value.exports !== undefined };
				}
			} catch {
				return undefined;
			}
		}
		if (directory === root) break;
		directory = path.dirname(directory);
	}
	return undefined;
}

function candidateKind(specifier: string, options: ts.CompilerOptions): RenderCandidate["kind"] {
	if (specifier.startsWith(".")) return "relative";
	if (Object.keys(options.paths ?? {}).some((pattern) => matchesPathPattern(pattern, specifier))) return "alias";
	return "package";
}

function matchesPathPattern(pattern: string, specifier: string): boolean {
	const star = pattern.indexOf("*");
	if (star === -1) return pattern === specifier;
	return specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
}

function resolvesToTarget(
	root: string,
	fromModule: string,
	specifier: string,
	targetModule: string,
	options: ts.CompilerOptions,
): boolean {
	const result = resolveSpecifier(root, fromModule, specifier, options);
	if (result.status === "resolved") return result.module === targetModule;
	return result.status === "external" && result.surface?.module === targetModule;
}

function dedupeCandidates(candidates: RenderCandidate[]): RenderCandidate[] {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		if (seen.has(candidate.specifier)) return false;
		seen.add(candidate.specifier);
		return true;
	});
}

function moduleExtension(module: string): string {
	if (module.endsWith(".d.ts")) return ".d.ts";
	return path.posix.extname(module);
}

function stripModuleExtension(module: string): string {
	const extension = moduleExtension(module);
	return extension === "" ? module : module.slice(0, -extension.length);
}

function stripExtension(value: string): string {
	return stripModuleExtension(toPosix(value));
}

function toPosix(value: string): string {
	return value.replace(/\\/g, "/");
}

/** Runtime-root imports need an explicit bundle boundary because TypeScript treats them as URLs. */
function resolveRuntimeSurface(
	workspaceRoot: string,
	containing: string,
	specifier: string,
	options: ts.CompilerOptions,
	surfaceGlobs: string[],
): ImportResolution | null {
	if (!specifier.startsWith("/")) return null;
	const clean = specifier.slice(1).split(/[?#]/, 1)[0] ?? "";
	const candidates = new Set(configuredSurfaceCandidates(specifier, surfaceGlobs));
	const direct = normalizeCandidate(clean);
	if (direct !== null) candidates.add(direct);

	const existing = [...candidates].filter((module) => {
		const file = path.join(workspaceRoot, module);
		if (!ts.sys.fileExists(file)) return false;
		if (surfaceGlobs.some((glob) => surfaceGlobMatches(glob, module))) return true;
		const text = ts.sys.readFile(file);
		return text !== undefined && isLikelyBundle(module, text);
	});
	if (existing.length !== 1) return null;

	const runtime = path.join(workspaceRoot, existing[0] as string);
	const typed = ts.resolveModuleName(runtime, containing, options, HOST).resolvedModule;
	const fileName = typed?.resolvedFileName ?? runtime;
	const module = toModule(workspaceRoot, fileName);
	return module === null ? null : { status: "resolved", module, depth: "surface" };
}

function normalizeCandidate(module: string): string | null {
	try {
		return normalizeModulePath(module);
	} catch {
		return null;
	}
}

function surfaceDepth(module: string, fileName: string, globs: string[]): "full" | "surface" {
	if (isDeclarationModule(module) || globs.some((glob) => surfaceGlobMatches(glob, module))) return "surface";
	const text = ts.sys.readFile(fileName);
	return text !== undefined && isLikelyBundle(module, text) ? "surface" : "full";
}

/** `@scope/name` keeps two segments; everything else keeps one. */
function packageNameOf(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}
