// The project model: which files are in scope, and where a specifier lands.
//
// The largest per-language cost in the contract, and the reason this provider wraps the compiler
// rather than a grammar. tsconfig paths, package exports and extension resolution are all here,
// and none of them are things a syntax tree can answer.

import path from "node:path";
import { hashContent, type ImportResolution, normalizeModulePath, type ReadPolicy } from "@nyaa-lexicon/protocol";
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

export interface LoadedProject extends CompilerSetup {
	files: string[];
	configFiles: string[];
	/** Referenced project paths. */
	references: string[];
	diagnostics: { severity: "error" | "warning"; message: string; path?: string }[];
}

/** Defaults for a workspace with no tsconfig, so an unconfigured repo still answers. */
const FALLBACK: ts.CompilerOptions = {
	target: ts.ScriptTarget.ESNext,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	allowJs: true,
};

/** Options that change no binding, type or resolution. */
const INERT_OPTIONS = new Set([
	"assumeChangesOnlyAffectDirectDependencies",
	"charset",
	"composite",
	"declaration",
	"declarationDir",
	"declarationMap",
	"diagnostics",
	"disableReferencedProjectLoad",
	"disableSizeLimit",
	"disableSolutionSearching",
	"disableSourceOfProjectReferenceRedirect",
	"emitBOM",
	"emitDeclarationOnly",
	"emitDecoratorMetadata",
	"explainFiles",
	"extendedDiagnostics",
	"forceConsistentCasingInFileNames",
	"generateCpuProfile",
	"generateTrace",
	"importHelpers",
	"incremental",
	"inlineSourceMap",
	"inlineSources",
	"isolatedDeclarations",
	"isolatedModules",
	"listEmittedFiles",
	"listFiles",
	"locale",
	"mapRoot",
	"newLine",
	"noCheck",
	"noEmit",
	"noEmitHelpers",
	"noEmitOnError",
	"noFallthroughCasesInSwitch",
	"noImplicitOverride",
	"noImplicitReturns",
	"noPropertyAccessFromIndexSignature",
	"noUnusedLocals",
	"noUnusedParameters",
	"out",
	"outDir",
	"outFile",
	"plugins",
	"preserveConstEnums",
	"preserveWatchOutput",
	"pretty",
	"removeComments",
	"rootDir",
	"skipDefaultLibCheck",
	"skipLibCheck",
	"sourceMap",
	"sourceRoot",
	"stripInternal",
	"traceResolution",
	"tsBuildInfoFile",
	"watch",
]);

/** The package.json fields module resolution reads. */
const PACKAGE_FIELDS = ["name", "type", "main", "types", "typings", "typesVersions", "exports", "imports"] as const;

////////////////////////////////
//  Functions & Helpers

/** `ts.sys`, reading nothing the policy denies. */
export function readableSystem(policy: ReadPolicy): ts.System {
	return {
		...ts.sys,
		readFile: (fileName, encoding) => (policy.readable(fileName) ? ts.sys.readFile(fileName, encoding) : undefined),
		fileExists: (fileName) => policy.readable(fileName) && ts.sys.fileExists(fileName),
	};
}

/** `system` with proposed texts standing in for, or beside, the files on disk. */
export function overlaidSystem(
	root: string,
	files: ReadonlyMap<string, { readonly text: string }>,
	system: ts.System,
): ts.System {
	const proposed = new Map([...files].map(([module, { text }]) => [path.resolve(root, module), text]));
	const directories = new Set([...proposed.keys()].flatMap((file) => ancestorsOf(path.dirname(file))));
	return {
		...system,
		readFile: (fileName, encoding) => proposed.get(path.resolve(fileName)) ?? system.readFile(fileName, encoding),
		fileExists: (fileName) => proposed.has(path.resolve(fileName)) || system.fileExists(fileName),
		directoryExists: (directory) => directories.has(path.resolve(directory)) || system.directoryExists(directory),
	};
}

function ancestorsOf(directory: string): string[] {
	const found = [directory];
	for (let parent = path.dirname(directory); parent !== found.at(-1); parent = path.dirname(parent))
		found.push(parent);
	return found;
}

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

/**
 * Load the nearest tsconfig, or fall back.
 *
 * A missing tsconfig is not an error: plenty of real JavaScript has none, and refusing would make
 * the provider useless exactly where a symbol index helps most.
 */
export function loadProject(workspaceRoot: string, system: ts.System = ts.sys): LoadedProject {
	const configPath = ts.findConfigFile(workspaceRoot, system.fileExists, "tsconfig.json");
	if (configPath === undefined) {
		return { options: FALLBACK, system, files: [], configFiles: [], references: [], diagnostics: [] };
	}

	const config = parseConfig(configPath, system);
	if ("error" in config) {
		return {
			options: FALLBACK,
			system,
			files: [],
			configFiles: [configPath],
			references: [],
			diagnostics: [{ severity: "error", message: messageOf(config.error), path: configPath }],
		};
	}

	const { parsed } = config;
	const configFiles = [...config.configFiles];
	const files = [...parsed.fileNames];
	const references = (parsed.projectReferences ?? []).map((reference) => reference.path);
	const diagnostics: LoadedProject["diagnostics"] = parsed.errors.map((error) => ({
		severity: "error",
		message: messageOf(error),
	}));

	// A solution-style tsconfig lists no files of its own, only references. Stopping here would
	// answer "this monorepo contains nothing", which is the shape most real projects have.
	for (const reference of references) {
		const referenced = loadReferenced(reference, system);
		files.push(...referenced.files);
		configFiles.push(...referenced.configFiles);
		diagnostics.push(...referenced.diagnostics);
	}

	// Reported rather than thrown: one bad config entry should not make the whole project
	// unanswerable, and the core shows diagnostics beside the facts it did get.
	return {
		options: parsed.options,
		system,
		files: dedupe(files),
		configFiles: dedupe(configFiles),
		references,
		diagnostics,
	};
}

/** One referenced project. Its own references are not followed: one level is what a solution is. */
function loadReferenced(
	referencePath: string,
	system: ts.System,
): Pick<LoadedProject, "files" | "configFiles" | "diagnostics"> {
	const configPath = system.directoryExists(referencePath)
		? path.join(referencePath, "tsconfig.json")
		: referencePath;
	if (!system.fileExists(configPath)) {
		return { files: [], configFiles: [], diagnostics: [{ severity: "warning", message: `missing ${configPath}` }] };
	}

	const config = parseConfig(configPath, system);
	if ("error" in config) {
		return {
			files: [],
			configFiles: [configPath],
			diagnostics: [{ severity: "error", message: messageOf(config.error), path: configPath }],
		};
	}

	return {
		files: config.parsed.fileNames,
		configFiles: config.configFiles,
		diagnostics: config.parsed.errors.map((error) => ({ severity: "error" as const, message: messageOf(error) })),
	};
}

/** One tsconfig, and the configs it extends. */
function parseConfig(
	configPath: string,
	system: ts.System,
): { parsed: ts.ParsedCommandLine; configFiles: string[] } | { error: ts.Diagnostic } {
	const read = ts.readConfigFile(configPath, system.readFile);
	if (read.error) return { error: read.error };
	const source = ts.readJsonConfigFile(configPath, system.readFile);
	const parsed = ts.parseJsonSourceFileConfigFileContent(
		source,
		system,
		path.dirname(configPath),
		undefined,
		configPath,
	);
	return { parsed, configFiles: [configPath, ...(source.extendedSourceFiles ?? [])] };
}

/**
 * What facts depend on beyond file text: the options that shape binding, types and resolution,
 * the project references, the declaration files that declare globals, and the resolution fields of
 * each package.json over the files.
 */
export function projectFingerprint(
	root: string,
	loaded: LoadedProject,
): { fingerprint: string; packageFiles: string[] } {
	const options = Object.entries(loaded.options)
		.filter(([name]) => !INERT_OPTIONS.has(name))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	const packageFiles = [
		...new Set([...packageFilesOver(root, loaded.files, loaded.system), ...resolutionPackages(root, loaded)]),
	].sort();
	const packages = packageFiles.map((file) => [
		toPosix(path.relative(root, file)),
		packageFields(file, loaded.system),
	]);
	const references = [...loaded.references].sort();
	const ambient = globalDeclarations(root, loaded.files, loaded.system);
	return { fingerprint: hashContent(JSON.stringify({ options, references, ambient, packages })), packageFiles };
}

/** Program `.d.ts` files whose declarations reach every file unimported. */
function globalDeclarations(root: string, files: readonly string[], system: ts.System): string[] {
	const found: string[] = [];
	for (const file of files) {
		if (!file.endsWith(".d.ts")) continue;
		const text = system.readFile(file);
		if (text === undefined) continue;
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
		const global =
			!ts.isExternalModule(source) ||
			source.statements.some((statement) => (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0);
		if (global) found.push(toPosix(path.relative(root, file)));
	}
	return found.sort();
}

/** Each workspace package.json from a file's directory up to the root. */
function packageFilesOver(root: string, files: readonly string[], system: ts.System): string[] {
	const visited = new Set<string>();
	const found: string[] = [];
	for (const file of files) {
		let directory = path.dirname(file);
		while (!visited.has(directory) && (directory === root || directory.startsWith(`${root}${path.sep}`))) {
			visited.add(directory);
			const candidate = path.join(directory, "package.json");
			if (!directory.split(path.sep).includes("node_modules") && system.fileExists(candidate)) {
				found.push(candidate);
			}
			if (directory === root) break;
			directory = path.dirname(directory);
		}
	}
	return found.sort();
}

/**
 * Workspace package.json files that resolving the project's imports reads, through `paths` or a
 * linked workspace package: each specifier resolved once, recording what the host reads.
 */
function resolutionPackages(root: string, loaded: LoadedProject): string[] {
	const { system, options } = loaded;
	// Probed, found or not: creating one moves resolution as much as editing one.
	const probed = new Set<string>();
	const host: ts.ModuleResolutionHost = {
		...resolutionHost(system),
		fileExists: (fileName) => {
			if (path.basename(fileName) === "package.json") probed.add(fileName);
			return system.fileExists(fileName);
		},
		readFile: (fileName) => {
			if (path.basename(fileName) === "package.json") probed.add(fileName);
			return system.readFile(fileName);
		},
	};
	const canonical = (fileName: string) => (system.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase());
	const cache = ts.createModuleResolutionCache(root, canonical, options);
	for (const file of loaded.files) {
		const text = system.readFile(file);
		if (text === undefined) continue;
		for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
			ts.resolveModuleName(imported.fileName, file, options, host, cache);
		}
	}
	// Through links, so a linked package or a root opened through a link still counts.
	const real = (fileName: string) => path.resolve(system.realpath?.(fileName) ?? fileName);
	const realRoot = real(root);
	const found = new Set<string>();
	for (const probe of probed) {
		const resolved = system.fileExists(probe) ? real(probe) : path.join(real(path.dirname(probe)), "package.json");
		const relative = path.relative(realRoot, resolved);
		const inside = !relative.startsWith("..") && !path.isAbsolute(relative);
		if (inside && !relative.split(path.sep).includes("node_modules")) found.add(path.join(root, relative));
	}
	return [...found];
}

function packageFields(file: string, system: ts.System): unknown {
	try {
		const value = JSON.parse(system.readFile(file) ?? "null") as Record<string, unknown> | null;
		if (value === null || typeof value !== "object") return null;
		return PACKAGE_FIELDS.map((field) => value[field] ?? null);
	} catch {
		return null;
	}
}

function dedupe(files: string[]): string[] {
	return [...new Set(files)];
}

function messageOf(diagnostic: ts.Diagnostic): string {
	return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

/** Whether a file runs as an ECMAScript module, where `import x = require()` is an error. */
export function runsAsEsm(fileName: string, setup: CompilerSetup): boolean {
	const kind = setup.options.module;
	if (kind === ts.ModuleKind.Preserve) return false;
	if (/\.m[tj]s$/.test(fileName)) return true;
	if (kind === undefined || /\.c[tj]s$/.test(fileName)) return false;
	if (kind >= ts.ModuleKind.Node16 && kind <= ts.ModuleKind.NodeNext) {
		const host = resolutionHost(setup.system);
		return ts.getImpliedNodeFormatForFile(fileName, undefined, host, setup.options) === ts.ModuleKind.ESNext;
	}
	// A tsconfig's ECMAScript module kind; the fallback's only guesses.
	return setup.options !== FALLBACK && kind >= ts.ModuleKind.ES2015 && kind <= ts.ModuleKind.ESNext;
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
): ImportResolution {
	const containing = path.join(workspaceRoot, fromModule);
	const resolved = ts.resolveModuleName(
		specifier,
		containing,
		setup.options,
		resolutionHost(setup.system),
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

/** The workspace module a specifier lands on, when it lands on one. */
export type ModuleResolver = (fromModule: string, specifier: string) => string | undefined;

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
	return landingOf(resolveSpecifier(root, fromModule, specifier, setup, [], lookupSurface)) === targetModule;
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
