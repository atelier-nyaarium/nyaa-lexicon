// Where a C++ file's includes are found. A compilation database at the root or in a `build*/`
// directory gives each unit its search lists and forced includes, which every header the unit
// reaches is read with, once per entry building it; without one, the includer's directory, then
// workspace directories named `include`, then the root.

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type IncludeSearch, readCompileCommands } from "@nyaa-lexicon/formats/compile-commands";
import { type Diagnostic, hashContent, type ReadPolicy, workspaceFile, workspaceModule } from "@nyaa-lexicon/protocol";
import { type ExcludedDirectories, excludesDirectory } from "@nyaa-lexicon/protocol/excludedDirectories";

////////////////////////////////
//  Interfaces & Types

/** One database entry building a translation unit. */
export interface CppEntry {
	/** Its lists, as an index into `CppProject.searches`. */
	search: number;
	/** `-include` files as written, looked for in `directory` first. */
	forced: readonly string[];
	directory: string;
}

export interface CppProject {
	root: string;
	/** The distinct entries building each unit, by module: one per configuration a build has. */
	units: ReadonlyMap<string, readonly CppEntry[]>;
	/** Each distinct set of lists the entries use. */
	searches: readonly IncludeSearch[];
	/** Without a database: workspace directories named `include`, then the root. */
	fallback: readonly string[];
	/** The databases read, as workspace modules. */
	databases: readonly string[];
	/** The workspace headers forced includes name, wherever they stand. */
	forcedModules: readonly string[];
	diagnostics: readonly Diagnostic[];
	/** A digest of every search list, forced include and define, which moves when a file would read differently. */
	fingerprint: string;
}

/**
 * Whose lists an include is searched with, as indexes into `CppProject.searches`: the entries
 * building its unit, or every entry for a file none builds; `fallback`, with no database.
 */
export type SearchContext = readonly number[] | "fallback";

export type IncludeKind = "quoted" | "angle";

/** Where an include was found: a workspace module, or a file outside the workspace. */
export type FoundInclude = { module: string } | { outside: true };

////////////////////////////////
//  Constants

const DATABASE = "compile_commands.json";

////////////////////////////////
//  Functions & Helpers

function isFile(file: string): boolean {
	return existsSync(file) && statSync(file).isFile();
}

/** The root's database, then each top directory's whose name starts `build`, in name order. */
function databaseFiles(root: string): string[] {
	const builds = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("build"))
		.map((entry) => entry.name)
		.sort();
	return [path.join(root, DATABASE), ...builds.map((build) => path.join(root, build, DATABASE))].filter(isFile);
}

/**
 * Workspace directories named `include`, absolute and sorted, outside `excluded` ones, links and what
 * `policy` denies. A directory that cannot be listed is skipped.
 */
function includeDirectories(root: string, excluded: ExcludedDirectories, policy: ReadPolicy): string[] {
	const found: string[] = [];
	const pending = [root];
	for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		const names = entries.map((entry) => entry.name);
		for (const entry of entries) {
			if (!entry.isDirectory() || excludesDirectory(excluded, entry.name, directory === root, () => names))
				continue;
			const child = path.join(directory, entry.name);
			if (!policy.readable(child)) continue;
			if (entry.name === "include") found.push(child);
			pending.push(child);
		}
	}
	return found.sort();
}

/** The databases the scope lets be read, and the search lists they and the tree give. */
export function discoverCppProject(root: string, excluded: ExcludedDirectories, policy: ReadPolicy): CppProject {
	const units = new Map<string, CppEntry[]>();
	const searches: IncludeSearch[] = [];
	const searchIds = new Map<string, number>();
	// Each unit's entries as the digest reads them, which leaves out where they stand in the database.
	const described = new Map<string, Set<string>>();
	const databases: string[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const file of databaseFiles(root)) {
		const module = workspaceModule(root, file);
		if (module === null || !policy.readable(file)) continue;
		databases.push(module);
		const read = readCompileCommands({ module, text: readFileSync(file, "utf8"), location: path.dirname(file) });
		diagnostics.push(...read.diagnostics);
		for (const command of read.commands) {
			const unit = workspaceModule(root, command.file);
			if (unit === null) continue;
			const { includes, forcedIncludes: forced, directory, defines, undefines } = command;
			const description = JSON.stringify({ includes, forced, directory, defines, undefines });
			const seen = described.get(unit) ?? new Set<string>();
			described.set(unit, seen);
			// One configuration written twice is one entry.
			if (seen.has(description)) continue;
			seen.add(description);
			const key = JSON.stringify(includes);
			const search = searchIds.get(key) ?? searches.push(includes) - 1;
			searchIds.set(key, search);
			const entries = units.get(unit) ?? [];
			if (
				!entries.some(
					(entry) =>
						entry.search === search &&
						isDeepStrictEqual(entry.forced, forced) &&
						entry.directory === directory,
				)
			)
				entries.push({ search, forced, directory });
			units.set(unit, entries);
		}
	}
	const fallback = searches.length === 0 ? [...includeDirectories(root, excluded, policy), root] : [];
	const digest = {
		units: [...described]
			.map(([unit, descriptions]) => [unit, [...descriptions].sort()] as const)
			.sort(([left], [right]) => left.localeCompare(right)),
		fallback: fallback.map((directory) => path.relative(root, directory)),
	};
	const project: CppProject = {
		root,
		units,
		searches,
		fallback,
		databases,
		forcedModules: [],
		diagnostics,
		fingerprint: hashContent(JSON.stringify(digest)),
	};
	const forcedModules = new Set<string>();
	for (const entries of units.values())
		for (const entry of entries)
			for (const name of entry.forced) {
				const found = findInclude(project, policy, forcedDirectories(project, entry), name);
				if (found !== undefined && "module" in found) forcedModules.add(found.module);
			}
	return { ...project, forcedModules: [...forcedModules].sort() };
}

/** For a workspace that could not be read: the includer's directory, then the root. */
export function bareProject(root: string): CppProject {
	return {
		root,
		units: new Map(),
		searches: [],
		fallback: [root],
		databases: [],
		forcedModules: [],
		diagnostics: [],
		fingerprint: hashContent(""),
	};
}

/** The lists `module`'s includes, and every header they reach, are searched with. */
export function contextOf(project: CppProject, module: string): SearchContext {
	const entries = project.units.get(module);
	if (entries !== undefined)
		return [...new Set(entries.map((entry) => entry.search))].sort((left, right) => left - right);
	return project.searches.length > 0 ? project.searches.map((_, index) => index) : "fallback";
}

/** Where an include written in `includer` is looked for under one set of lists, in order. */
function searchDirectories(
	project: CppProject,
	search: IncludeSearch | undefined,
	includer: string,
	kind: IncludeKind,
): string[] {
	const directory = path.dirname(path.join(project.root, includer));
	if (search === undefined) return kind === "quoted" ? [directory, ...project.fallback] : [...project.fallback];
	const listed = [...(kind === "quoted" ? search.quote : []), ...search.user, ...search.system, ...search.after];
	return kind === "quoted" && search.includerDirectory ? [directory, ...listed] : listed;
}

/**
 * Where an include written in `includer` is looked for, once per set of lists it may be read with:
 * each of the entries building its unit, every entry for a file none builds, or the fallback.
 */
export function searchOrders(
	project: CppProject,
	context: SearchContext,
	includer: string,
	kind: IncludeKind,
): string[][] {
	if (context === "fallback") return [searchDirectories(project, undefined, includer, kind)];
	return context.map((index) => searchDirectories(project, project.searches[index], includer, kind));
}

/** Where an entry's forced include is looked for: its working directory, then its quoted search. */
export function forcedDirectories(project: CppProject, entry: CppEntry): string[] {
	const search = project.searches[entry.search];
	return search === undefined
		? [entry.directory]
		: [entry.directory, ...search.quote, ...search.user, ...search.system, ...search.after];
}

/** The first of `directories` holding exactly `name` that `policy` lets be read, or undefined when none does. */
export function findInclude(
	project: CppProject,
	policy: ReadPolicy,
	directories: readonly string[],
	name: string,
): FoundInclude | undefined {
	for (const directory of directories) {
		const candidate = path.resolve(directory, name);
		// A denied file is not looked at.
		if (!policy.readable(candidate)) continue;
		const module = workspaceModule(project.root, candidate);
		const absolute = module === null ? candidate : workspaceFile(project.root, module);
		if (absolute === null || !isFile(absolute)) continue;
		return module === null ? { outside: true } : { module };
	}
	return undefined;
}
