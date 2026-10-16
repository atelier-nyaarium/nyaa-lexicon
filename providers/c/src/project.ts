// Where a C file's includes are found. A compilation database at the root or in a `build*/`
// directory gives each unit its search lists, which every header the unit reaches is read with;
// without one, the includer's directory, then workspace directories named `include`, then the root.

import path from "node:path";
import { type IncludeSearch, readCompileCommands } from "@nyaa-lexicon/formats/compile-commands";
import {
	type Diagnostic,
	discoverCompileDatabases,
	discoverIncludeDirectories,
	type FoundInclude,
	findWorkspaceInclude,
	forcedIncludeDirectories,
	hashContent,
	type IncludeKind,
	includeSearchDirectories,
	type ReadPolicy,
	workspaceModule,
} from "@nyaa-lexicon/protocol";
import type { ExcludedDirectories } from "@nyaa-lexicon/protocol/excludedDirectories";

////////////////////////////////
//  Interfaces & Types

/** One database entry for a translation unit; a build with several configurations lists a unit more than once. */
export interface CUnit {
	/** Its lists, as an index into `CProject.searches`. */
	search: number;
	/** `-include` files as written, looked for in `directory` first. */
	forced: readonly string[];
	directory: string;
}

export interface CProject {
	root: string;
	/** Each unit's distinct database entries, by module. */
	units: ReadonlyMap<string, readonly CUnit[]>;
	/** Each distinct set of lists the units use. */
	searches: readonly IncludeSearch[];
	/** Without a database: workspace directories named `include`, then the root. */
	fallback: readonly string[];
	/** The workspace headers the units force, which the walk may not reach. */
	forcedHeaders: readonly string[];
	/** The databases read, as workspace modules. */
	databases: readonly string[];
	diagnostics: readonly Diagnostic[];
	/** A digest of every search list, forced include and define, which moves when a file would read differently. */
	fingerprint: string;
}

/**
 * Whose lists an include is searched with: indices into `CProject.searches`, which must agree for an
 * answer, or `fallback` with no database.
 */
export type SearchContext = readonly number[] | "fallback";

export type { IncludeKind } from "@nyaa-lexicon/protocol";

/** Where an include was found. */
export type Found = FoundInclude;

////////////////////////////////
//  Functions & Helpers

/** The first of `directories` holding exactly `name`, never probing a path the scope denies. */
export function findInclude(
	root: string,
	policy: ReadPolicy,
	directories: readonly string[],
	name: string,
): Found | undefined {
	return findWorkspaceInclude(root, policy, directories, name);
}

/** The databases the scope lets be read, and the search lists they and the tree give. */
export function discoverCProject(root: string, excluded: ExcludedDirectories, policy: ReadPolicy): CProject {
	const units = new Map<string, CUnit[]>();
	const searches: IncludeSearch[] = [];
	const searchIds = new Map<string, number>();
	const defines: Array<[string, Record<string, string>, string[]]> = [];
	const databases: string[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const file of discoverCompileDatabases(root)) {
		const module = workspaceModule(root, file);
		const text = policy.readText(file);
		if (module === null || text === undefined) continue;
		databases.push(module);
		const read = readCompileCommands({ module, text, location: path.dirname(file) });
		diagnostics.push(...read.diagnostics);
		for (const command of read.commands) {
			const unit = workspaceModule(root, command.file);
			if (unit === null) continue;
			const key = JSON.stringify(command.includes);
			const search = searchIds.get(key) ?? searches.push(command.includes) - 1;
			searchIds.set(key, search);
			const entry = { search, forced: command.forcedIncludes, directory: command.directory };
			const entries = units.get(unit) ?? [];
			// Configurations that read the file alike are one.
			if (entries.some((held) => JSON.stringify(held) === JSON.stringify(entry))) continue;
			units.set(unit, [...entries, entry]);
			defines.push([unit, command.defines, command.undefines]);
		}
	}
	const fallback = searches.length === 0 ? [...discoverIncludeDirectories(root, excluded, policy), root] : [];
	const forcedHeaders = new Set<string>();
	for (const entries of units.values())
		for (const entry of entries)
			for (const written of entry.forced) {
				const found = findInclude(root, policy, forcedDirectories({ searches }, entry), written);
				if (found !== undefined && "module" in found) forcedHeaders.add(found.module);
			}
	const digest = {
		units: [...units].sort(([left], [right]) => left.localeCompare(right)),
		searches,
		defines: defines.sort(([left], [right]) => left.localeCompare(right)),
		fallback: fallback.map((directory) => path.relative(root, directory)),
	};
	return {
		root,
		units,
		searches,
		fallback,
		forcedHeaders: [...forcedHeaders].sort(),
		databases,
		diagnostics,
		fingerprint: hashContent(JSON.stringify(digest)),
	};
}

/** For a workspace that could not be read: the includer's directory, then the root. */
export function bareProject(root: string): CProject {
	return {
		root,
		units: new Map(),
		searches: [],
		fallback: [root],
		forcedHeaders: [],
		databases: [],
		diagnostics: [],
		fingerprint: hashContent(""),
	};
}

/** The lists `module`'s includes, and every header they reach, are searched with: its entries', or every unit's. */
export function contextOf(project: CProject, module: string): SearchContext {
	const entries = project.units.get(module);
	if (entries !== undefined) return [...new Set(entries.map((entry) => entry.search))].sort((a, b) => a - b);
	return project.searches.length > 0 ? project.searches.map((_, index) => index) : "fallback";
}

/** Where an include from `fromModule` is looked for, in order; a quoted one tries its includer's directory first. */
export function searchDirectories(
	project: Pick<CProject, "root" | "fallback">,
	search: IncludeSearch | undefined,
	fromModule: string,
	kind: IncludeKind,
): string[] {
	return includeSearchDirectories(project.root, project.fallback, search, fromModule, kind);
}

/** Where a unit's forced include is looked for: its working directory, then its quoted search. */
export function forcedDirectories(project: Pick<CProject, "searches">, unit: CUnit): string[] {
	return forcedIncludeDirectories(unit.directory, project.searches[unit.search]);
}
