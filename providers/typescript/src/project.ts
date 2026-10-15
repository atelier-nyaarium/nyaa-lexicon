// The TypeScript project model: which files are in scope and what shapes compiler answers.

import path from "node:path";
import { hashContent, type ReadPolicy } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { type CompilerSetup, resolutionHost, toModule, toPosix } from "./specifier-resolution.js";

export {
	type CompilerSetup,
	type ExtensionStyle,
	type ImportSyntax,
	landingOf,
	type ModuleResolver,
	modeName,
	relativeStyle,
	renderSpecifier,
	resolveSpecifier,
	type SpecifierRenderer,
	type SpecifierRenderResult,
	syntaxMode,
} from "./specifier-resolution.js";
export { toModule };

////////////////////////////////
//  Interfaces & Types

export interface LoadedProject extends CompilerSetup {
	files: string[];
	configFiles: string[];
	/** Referenced project paths. */
	references: string[];
	/** Each referenced project's settings, in reference order. */
	referenced: ts.CompilerOptions[];
	groups: SettingsGroups;
	diagnostics: { severity: "error" | "warning"; message: string; path?: string }[];
}

/** Projects whose binding, typing and resolution settings match share a group, and one Program. */
export interface SettingsGroups {
	/** The root project's group. */
	root: string;
	settings: ReadonlyMap<string, ts.CompilerOptions>;
	/** Each referenced project file's group, by absolute path. */
	byFile: ReadonlyMap<string, string>;
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

const DEPENDENCY_GROUPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/** Root lockfiles, which change with every install, and which a watcher sees where node_modules it does not. */
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"] as const;

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

/**
 * Load the nearest tsconfig, or fall back.
 *
 * A missing tsconfig is not an error: plenty of real JavaScript has none, and refusing would make
 * the provider useless exactly where a symbol index helps most.
 */
export function loadProject(workspaceRoot: string, system: ts.System = ts.sys): LoadedProject {
	const configPath = ts.findConfigFile(workspaceRoot, system.fileExists, "tsconfig.json");
	if (configPath === undefined) {
		return {
			options: FALLBACK,
			system,
			files: [],
			configFiles: [],
			references: [],
			referenced: [],
			groups: settingsGroups(FALLBACK, [], system),
			diagnostics: [],
		};
	}

	const config = parseConfig(configPath, system);
	if ("error" in config) {
		return {
			options: FALLBACK,
			system,
			files: [],
			configFiles: [configPath],
			references: [],
			referenced: [],
			groups: settingsGroups(FALLBACK, [], system),
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
	const projects: Array<{ files: string[]; options: ts.CompilerOptions }> = [];

	// A solution-style tsconfig lists no files of its own, only references. Stopping here would
	// answer "this monorepo contains nothing", which is the shape most real projects have.
	for (const reference of references) {
		const project = loadReferenced(reference, system);
		files.push(...project.files);
		if (project.options !== undefined) projects.push({ files: project.files, options: project.options });
		configFiles.push(...project.configFiles);
		diagnostics.push(...project.diagnostics);
	}

	// Reported rather than thrown: one bad config entry should not make the whole project
	// unanswerable, and the core shows diagnostics beside the facts it did get.
	return {
		options: parsed.options,
		system,
		files: dedupe(files),
		configFiles: dedupe(configFiles),
		references,
		referenced: projects.map((project) => project.options),
		groups: settingsGroups(parsed.options, projects, system),
		diagnostics,
	};
}

/** The root's group first; a file two projects claim compiles with the first. */
function settingsGroups(
	root: ts.CompilerOptions,
	projects: ReadonlyArray<{ files: readonly string[]; options: ts.CompilerOptions }>,
	system: ts.System,
): SettingsGroups {
	const settings = new Map<string, ts.CompilerOptions>();
	const keyOf = (options: ts.CompilerOptions) => {
		const key = settingsKey(options, system);
		if (!settings.has(key)) settings.set(key, options);
		return key;
	};
	const rootKey = keyOf(root);
	const byFile = new Map<string, string>();
	for (const project of projects) {
		const key = keyOf(project.options);
		for (const file of project.files) {
			const absolute = path.resolve(file);
			if (!byFile.has(absolute)) byFile.set(absolute, key);
		}
	}
	return { root: rootKey, settings, byFile };
}

/** Settings, with the config's own path read only as the automatic type packages it finds. */
function settingsKey(options: ts.CompilerOptions, system: ts.System): string {
	const settings = relevantSettings(options).filter(([name]) => name !== "configFilePath");
	const types = automaticTypes(options, system).map((resolved) => resolved?.resolvedFileName ?? null);
	return JSON.stringify([settings, types]);
}

/** Each type package a Program with `options` includes unasked, as it resolves. */
function automaticTypes(
	options: ts.CompilerOptions,
	system: ts.System,
): Array<ts.ResolvedTypeReferenceDirective | undefined> {
	const host = resolutionHost(system);
	const config = (options as { configFilePath?: unknown }).configFilePath;
	const directory = typeof config === "string" ? path.dirname(config) : system.getCurrentDirectory();
	// Resolved from where a Program resolves them.
	const inferred = path.join(directory, "__inferred type names__.ts");
	return ts
		.getAutomaticTypeDirectiveNames(options, host)
		.map((name) => ts.resolveTypeReferenceDirective(name, inferred, options, host).resolvedTypeReferenceDirective);
}

function relevantSettings(options: ts.CompilerOptions): Array<[string, unknown]> {
	return Object.entries(options)
		.filter(([name]) => !INERT_OPTIONS.has(name))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** One referenced project. Its own references are not followed: one level is what a solution is. */
function loadReferenced(
	referencePath: string,
	system: ts.System,
): Pick<LoadedProject, "files" | "configFiles" | "diagnostics"> & { options?: ts.CompilerOptions } {
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
		options: config.parsed.options,
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
 * the project references and settings groups, the declaration files that declare globals, the
 * resolution fields of each package.json over the files, and what is installed: each declared
 * package's installed version, the automatic type packages, the root lockfiles and TypeScript's own
 * libs. What the workspace imports never moves it.
 */
export function projectFingerprint(
	root: string,
	loaded: LoadedProject,
): { fingerprint: string; packageFiles: string[]; lockfiles: string[] } {
	const { system } = loaded;
	const options = relevantSettings(loaded.options);
	const declaring = packageFilesOver(root, loaded.files, system);
	const packageFiles = [...new Set([...declaring, ...resolutionPackages(root, loaded)])].sort();
	// Watched where absent, hashed only where present, so an import that stops probing one moves nothing.
	const packages = packageFiles
		.filter((file) => system.fileExists(file))
		.map((file) => [toPosix(path.relative(root, file)), packageFields(file, system)]);
	const references = [...loaded.references].sort();
	const ambient = globalDeclarations(root, loaded.files, system);
	const referenced = loaded.referenced.map(relevantSettings);
	const groups = [...loaded.groups.settings.keys()].sort();
	const installed = declaring.flatMap((manifest) =>
		declaredPackages(manifest, system).map((name) => [
			toPosix(path.relative(root, manifest)),
			name,
			installedVersion(path.dirname(manifest), name, system),
		]),
	);
	const types = [...loaded.groups.settings.values()].flatMap((settings) =>
		automaticTypes(settings, system).map((resolved) => [
			resolved?.resolvedFileName ?? null,
			resolved?.packageId?.version ?? null,
		]),
	);
	const lockfiles = LOCKFILES.map((name) => path.join(root, name));
	const locks = lockfiles.map((file) => {
		const text = system.readFile(file);
		return text === undefined ? null : hashContent(text);
	});
	const installs = { installed, types, locks, typescript: ts.version };
	return {
		fingerprint: hashContent(
			JSON.stringify({ options, references, referenced, groups, ambient, packages, installs }),
		),
		packageFiles,
		lockfiles,
	};
}

/** Every package a package.json declares, across its dependency groups. */
function declaredPackages(manifest: string, system: ts.System): string[] {
	try {
		const value = JSON.parse(system.readFile(manifest) ?? "null") as Record<string, unknown> | null;
		if (value === null || typeof value !== "object") return [];
		const names = DEPENDENCY_GROUPS.flatMap((group) => {
			const declared = value[group];
			return declared !== null && typeof declared === "object" ? Object.keys(declared) : [];
		});
		return [...new Set(names)].sort();
	} catch {
		return [];
	}
}

/** The version a package installed for `directory` declares, found as Node finds it; null when absent. */
function installedVersion(directory: string, name: string, system: ts.System): string | null {
	for (let current = directory; ; current = path.dirname(current)) {
		const text = system.readFile(path.join(current, "node_modules", name, "package.json"));
		if (text !== undefined) {
			try {
				const version = (JSON.parse(text) as { version?: unknown }).version;
				return typeof version === "string" ? version : hashContent(text);
			} catch {
				return hashContent(text);
			}
		}
		if (path.dirname(current) === current) return null;
	}
}

/** The settings group `fileName` compiles in: its referenced project's, else the root's. */
export function groupOf(fileName: string, loaded: LoadedProject): string {
	return loaded.groups.byFile.get(path.resolve(fileName)) ?? loaded.groups.root;
}

export function optionsForFile(fileName: string, loaded: LoadedProject): ts.CompilerOptions {
	return loaded.groups.settings.get(groupOf(fileName, loaded)) ?? loaded.options;
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
 * linked workspace package: each specifier resolved once in its file's settings, recording what the
 * host reads.
 */
function resolutionPackages(root: string, loaded: LoadedProject): string[] {
	const { system } = loaded;
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
	const caches = new Map<string, ts.ModuleResolutionCache>();
	for (const [group, options] of loaded.groups.settings)
		caches.set(group, ts.createModuleResolutionCache(root, canonical, options));
	for (const file of loaded.files) {
		const text = system.readFile(file);
		if (text === undefined) continue;
		const cache = caches.get(groupOf(file, loaded));
		const options = optionsForFile(file, loaded);
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

/** Module format when TypeScript can name one from the project and file. */
export function runtimeOf(fileName: string, setup: CompilerSetup): "esm" | "cjs" | undefined {
	const kind = setup.options.module;
	if (kind === ts.ModuleKind.AMD || kind === ts.ModuleKind.UMD || kind === ts.ModuleKind.System) return undefined;
	if (/\.m[tj]s$/.test(fileName)) return "esm";
	if (/\.c[tj]s$/.test(fileName)) return "cjs";
	if (kind === undefined || kind === ts.ModuleKind.Preserve) return undefined;
	if (kind >= ts.ModuleKind.Node16 && kind <= ts.ModuleKind.NodeNext) {
		return runsAsEsm(fileName, setup) ? "esm" : "cjs";
	}
	if (kind === ts.ModuleKind.CommonJS) return "cjs";
	if (kind >= ts.ModuleKind.ES2015 && kind <= ts.ModuleKind.ESNext) return "esm";
	return undefined;
}
