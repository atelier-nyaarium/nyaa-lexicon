// TypeScript module specifier resolution and its compiler-backed helpers.
//
// tsconfig paths, package exports and extension resolution follow the compiler's rules.

import path from "node:path";
import { type ImportResolution, normalizeModulePath, type ResolutionMode } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { configuredSurfaceCandidates, isDeclarationModule, surfaceGlobMatches } from "./bundle.js";
import { claimsExtension } from "./file-types.js";

////////////////////////////////
//  Interfaces & Types

/** What resolution needs: the compiler's options and the disk it may read. */
export interface CompilerSetup {
	options: ts.CompilerOptions;
	/** Every disk read goes through this. */
	system: ts.System;
}

const MODE_KINDS: Record<ResolutionMode, ts.ResolutionMode> = {
	import: ts.ModuleKind.ESNext,
	require: ts.ModuleKind.CommonJS,
};

////////////////////////////////
//  Functions & Helpers

function resolutionHost(system: ts.System): ts.ModuleResolutionHost {
	return {
		fileExists: system.fileExists,
		readFile: system.readFile,
		directoryExists: system.directoryExists,
		getCurrentDirectory: () => system.getCurrentDirectory(),
		getDirectories: system.getDirectories,
		// Omitted rather than set undefined: the host declares it optional, and this project forbids
		// an explicit undefined standing in for an absent one.
		...(system.realpath ? { realpath: system.realpath } : {}),
	};
}

export { resolutionHost };

/** The protocol's name for a TypeScript resolution mode. */
export function modeName(mode: ts.ResolutionMode): ResolutionMode | undefined {
	if (mode === ts.ModuleKind.ESNext) return "import";
	return mode === ts.ModuleKind.CommonJS ? "require" : undefined;
}

/** The mode TypeScript resolves an import written in `fileName` with, in `syntax`. */
export function syntaxMode(fileName: string, setup: CompilerSetup, syntax: ImportSyntax): ResolutionMode | undefined {
	const host = resolutionHost(setup.system);
	const impliedNodeFormat = ts.getImpliedNodeFormatForFile(fileName, undefined, host, setup.options);
	const languageVersion = ts.ScriptTarget.ESNext;
	const text = syntax === "require" ? 'import m = require("m");' : 'import "m";';
	const probe = ts.createSourceFile(fileName, text, { languageVersion, impliedNodeFormat }, true);
	const statement = probe.statements[0];
	const literal =
		statement === undefined
			? undefined
			: ts.isImportDeclaration(statement)
				? statement.moduleSpecifier
				: ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)
					? statement.moduleReference.expression
					: undefined;
	if (literal === undefined || !ts.isStringLiteral(literal)) return undefined;
	return modeName(ts.getModeForUsageLocation(probe, literal, setup.options));
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
	setup: CompilerSetup,
	surfaceGlobs: string[] = [],
	lookupSurface: (module: string, fileName: string) => boolean = () => false,
	resolutionMode?: ResolutionMode,
): ImportResolution {
	const containing = path.join(workspaceRoot, fromModule);
	const resolved = ts.resolveModuleName(
		specifier,
		containing,
		setup.options,
		resolutionHost(setup.system),
		undefined,
		undefined,
		resolutionMode === undefined ? undefined : MODE_KINDS[resolutionMode],
	).resolvedModule;

	if (resolved === undefined) {
		const runtime = resolveRuntimeSurface(workspaceRoot, containing, specifier, setup, surfaceGlobs, lookupSurface);
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
	// The compiler marks a linked workspace package external too; a dependency lives under node_modules.
	if (resolved.isExternalLibraryImport === true && module.split("/").includes("node_modules")) {
		return {
			status: "external",
			packageName: resolved.packageId?.name ?? packageNameOf(specifier),
			surface: { module },
		};
	}
	const landing = { kind: "module", module } as const;
	return surfaceDepth(module, resolved.resolvedFileName, surfaceGlobs, lookupSurface) === "surface"
		? { status: "resolved", landing, depth: "surface" }
		: { status: "resolved", landing };
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
	style?: ExtensionStyle,
) => SpecifierRenderResult;

/** How a relative specifier ends: the runtime extension (`./a.js`), the source one (`./a.ts`), or none. */
export type ExtensionStyle = "runtime" | "source" | "none";

/** How an import is written: a declaration, or `import x = require()`; each resolves in its own mode. */
export type ImportSyntax = "import" | "require";

/** The workspace module a specifier written in `syntax` lands on, when it lands on one. */
export type ModuleResolver = (fromModule: string, specifier: string, syntax: ImportSyntax) => string | undefined;

/** A resolution's module, a package's surface included. */
export function landingOf(resolution: ImportResolution): string | undefined {
	if (resolution.status === "resolved") {
		return resolution.landing.kind === "module" ? resolution.landing.module : undefined;
	}
	return resolution.status === "external" ? resolution.surface?.module : undefined;
}

/** Render a module specifier that the existing resolver can send back to the target module. */
export function renderSpecifier(
	workspaceRoot: string,
	fromModule: string,
	targetModule: string,
	setup: CompilerSetup,
	preferredSpecifier?: string,
	lookupSurface: (module: string, fileName: string) => boolean = () => false,
	/** The importing file's own; outranks the preferred specifier's extension. */
	style?: ExtensionStyle,
): SpecifierRenderResult {
	const root = path.resolve(workspaceRoot);
	const from = moduleAbsolute(root, fromModule);
	const target = moduleAbsolute(root, targetModule);
	if (from === undefined || target === undefined) {
		return { reason: "NoImportPath", detail: "the importing or target module is not a TypeScript module" };
	}

	const { options } = setup;
	const targetExists = setup.system.fileExists(target);
	// The importer's own bare spelling wins while it still lands here, as a linked package does.
	if (
		preferredSpecifier !== undefined &&
		!preferredSpecifier.startsWith(".") &&
		targetExists &&
		resolvesToTarget(root, fromModule, preferredSpecifier, targetModule, setup, lookupSurface)
	) {
		return { specifier: preferredSpecifier };
	}
	const candidates = dedupeCandidates([
		{
			specifier: relativeSpecifier(fromModule, targetModule, options, preferredSpecifier, style),
			kind: "relative" as const,
		},
		...pathAliasCandidates(root, target, options),
		...packageCandidates(root, fromModule, target, targetModule, setup, lookupSurface),
	]);
	const preferredKind = preferredSpecifier === undefined ? undefined : candidateKind(preferredSpecifier, options);
	const preferred =
		preferredKind === undefined ? candidates : candidates.filter((candidate) => candidate.kind === preferredKind);
	const considered = preferred.length > 0 ? preferred : candidates;
	const valid = targetExists
		? considered.filter((candidate) =>
				resolvesToTarget(root, fromModule, candidate.specifier, targetModule, setup, lookupSurface),
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
	style: ExtensionStyle | undefined,
): string {
	const targetBase = stripModuleExtension(targetModule);
	const relativeBase = toPosix(path.relative(path.posix.dirname(fromModule), targetBase));
	const base = relativeBase === "" ? "" : relativeBase;
	const preferred =
		preferredSpecifier?.startsWith(".") === true ? (extensionStyleOf(preferredSpecifier) ?? "none") : undefined;
	const chosen = style ?? preferred ?? (isNodeEsm(options) ? "runtime" : "none");
	const targetExtension = moduleExtension(targetModule);
	const extension =
		chosen === "runtime" ? runtimeExtension(targetExtension) : chosen === "source" ? targetExtension : "";
	const rendered = `${base}${extension}`;
	return rendered.startsWith(".") ? rendered : `./${rendered}`;
}

/** A specifier's style; undefined for an extension no module has, such as `.json`. */
function extensionStyleOf(specifier: string): ExtensionStyle | undefined {
	const extension = path.posix.extname(specifier.split(/[?#]/, 1)[0] ?? specifier);
	if (extension === "") return "none";
	if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "runtime";
	if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return "source";
	return undefined;
}

/** The style most of these relative specifiers share, the earliest on a tie. */
export function relativeStyle(specifiers: readonly string[]): ExtensionStyle | undefined {
	const counts = new Map<ExtensionStyle, number>();
	for (const specifier of specifiers) {
		const style = specifier.startsWith(".") ? extensionStyleOf(specifier) : undefined;
		if (style !== undefined) counts.set(style, (counts.get(style) ?? 0) + 1);
	}
	let chosen: ExtensionStyle | undefined;
	for (const [style, count] of counts) if (chosen === undefined || count > (counts.get(chosen) ?? 0)) chosen = style;
	return chosen;
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
	const resolution = options.moduleResolution;
	if (resolution !== undefined) {
		return resolution === ts.ModuleResolutionKind.Node16 || resolution === ts.ModuleResolutionKind.NodeNext;
	}
	// A node module kind implies its own resolution.
	const kind = options.module;
	return kind !== undefined && kind >= ts.ModuleKind.Node16 && kind <= ts.ModuleKind.NodeNext;
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
	setup: CompilerSetup,
	lookupSurface: (module: string, fileName: string) => boolean,
): RenderCandidate[] {
	const packageInfo = nearestPackage(target, root, setup.system);
	if (packageInfo === undefined || packageInfo.exports === false) return [];
	const relative = stripModuleExtension(toPosix(path.relative(packageInfo.root, target)));
	if (relative.startsWith("..")) return [];
	const suffix = relative === "index" ? "" : `/${relative}`;
	const specifier = `${packageInfo.name}${suffix}`;
	return resolvesToTarget(root, fromModule, specifier, targetModule, setup, lookupSurface)
		? [{ specifier, kind: "package" }]
		: [];
}

function nearestPackage(
	target: string,
	root: string,
	system: ts.System,
): { name: string; root: string; exports: boolean } | undefined {
	let directory = path.dirname(target);
	while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
		const packagePath = path.join(directory, "package.json");
		const text = system.readFile(packagePath);
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
	setup: CompilerSetup,
	lookupSurface: (module: string, fileName: string) => boolean,
): boolean {
	const mode = syntaxMode(path.join(root, fromModule), setup, "import");
	return landingOf(resolveSpecifier(root, fromModule, specifier, setup, [], lookupSurface, mode)) === targetModule;
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

export { toPosix };

/** Runtime-root imports need an explicit bundle boundary because TypeScript treats them as URLs. */
function resolveRuntimeSurface(
	workspaceRoot: string,
	containing: string,
	specifier: string,
	setup: CompilerSetup,
	surfaceGlobs: string[],
	lookupSurface: (module: string, fileName: string) => boolean,
): ImportResolution | null {
	if (!specifier.startsWith("/")) return null;
	const clean = specifier.slice(1).split(/[?#]/, 1)[0] ?? "";
	const candidates = new Set(configuredSurfaceCandidates(specifier, surfaceGlobs));
	const direct = normalizeCandidate(clean);
	if (direct !== null) candidates.add(direct);

	const existing = [...candidates].filter((module) => {
		const file = path.join(workspaceRoot, module);
		if (!setup.system.fileExists(file)) return false;
		if (surfaceGlobs.some((glob) => surfaceGlobMatches(glob, module))) return true;
		return lookupSurface(module, file);
	});
	if (existing.length !== 1) return null;

	const runtime = path.join(workspaceRoot, existing[0] as string);
	const typed = ts.resolveModuleName(runtime, containing, setup.options, resolutionHost(setup.system)).resolvedModule;
	const fileName = typed?.resolvedFileName ?? runtime;
	const module = toModule(workspaceRoot, fileName);
	return module === null ? null : { status: "resolved", landing: { kind: "module", module }, depth: "surface" };
}

function normalizeCandidate(module: string): string | null {
	try {
		return normalizeModulePath(module);
	} catch {
		return null;
	}
}

function surfaceDepth(
	module: string,
	fileName: string,
	globs: string[],
	lookupSurface: (module: string, fileName: string) => boolean,
): "full" | "surface" {
	if (isDeclarationModule(module) || globs.some((glob) => surfaceGlobMatches(glob, module))) return "surface";
	return lookupSurface(module, fileName) ? "surface" : "full";
}

/** `@scope/name` keeps two segments; everything else keeps one. */
function packageNameOf(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}
