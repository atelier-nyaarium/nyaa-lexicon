// Which module a specifier names, and which statements brought a name into a file.
//
// Its own owner because import resolution is the one concept that both halves of the service need
// and neither owns: the knowledge layer cites an import statement as a fact, and the rename planner
// has to know which statements would have to be repointed. Answering it in two places would let
// them disagree about what a specifier resolves to, which is the same fact under two names.
//
// The provider is reached through a PORT, not a supervisor. Everything language-specific about
// resolving a specifier, along with the caching and the surface globs that decide how deeply a
// package is read, sits behind one injected function. This module cannot start a provider, cannot
// see the scope, and cannot cache; it asks its port and reads its store.

import type { ImportOrigin, ImportResolution, IndexDepth, MoveImportSite, Range } from "@nyaa-lexicon/protocol";
import { DEFAULT_REFERENCE_LIMIT } from "./indexReads.js";
import { compileSearchRegex } from "./search.js";
import type { IndexStore, StoredImport } from "./store.js";

////////////////////////////////
//  Constants & Helpers

/** Resolving or regex-searching imports reads at most this many rows. */
const IMPORT_SCAN_LIMIT = 20_000;

/** Where a resolution points and how deeply that target is worth reading, or nowhere. */
export function importTarget(resolution: ImportResolution): { module: string; depth: IndexDepth } | null {
	if (resolution.status === "resolved") {
		return { module: resolution.module, depth: resolution.depth ?? "full" };
	}
	if (resolution.status === "external" && resolution.surface !== undefined) {
		return { module: resolution.surface.module, depth: "surface" };
	}
	return null;
}

////////////////////////////////
//  Interfaces & Types

/**
 * The single provider capability an import resolver needs.
 *
 * A function rather than a supervisor, so this module cannot grow a second reason to talk to a
 * provider without the signature changing and someone noticing. Whoever supplies it owns the
 * caching and the surface globs, which are decisions about the workspace rather than about imports.
 */
export type ResolveSpecifier = (fromModule: string, specifier: string) => Promise<ImportResolution>;

////////////////////////////////
//  Class

/**
 * Import questions, answered from the index plus one provider capability.
 *
 * Held by LexiconService, which supplies the port and delegates to it.
 */
export class ImportResolver {
	constructor(
		private readonly store: IndexStore,
		private readonly resolve: ResolveSpecifier,
	) {}

	/** Import statements in one module naming the moved symbol, which must now address its target. */
	importSitesForMove(module: string, name: string): MoveImportSite[] {
		const sites: MoveImportSite[] = [];
		for (const statement of this.store.importsIn(module)) {
			if (statement.name !== name && statement.local !== name) continue;
			if (statement.range === undefined) continue;
			sites.push({
				range: statement.range,
				specifier: statement.specifier,
				importKind: statement.name === undefined ? "namespace" : "named",
				...(statement.name === undefined ? {} : { importedName: statement.name }),
				...(statement.local === undefined ? {} : { localName: statement.local }),
				reExport: statement.reExport,
			});
		}
		return sites;
	}

	/** The import statement that brought a name into a module, when one did. */
	importOriginFor(module: string, name: string): ImportOrigin | null {
		for (const statement of this.store.importsIn(module)) {
			if (statement.name !== name && statement.local !== name) continue;
			return {
				specifier: statement.specifier,
				// A statement naming no export binds the module itself, which is a namespace import.
				importKind: statement.name === undefined ? "namespace" : "named",
				...(statement.name === undefined ? {} : { importedName: statement.name }),
				...(statement.local === undefined ? {} : { localName: statement.local }),
			};
		}
		return null;
	}

	/**
	 * Which files import a specifier, or which import a particular module.
	 *
	 * Reads the imports table rather than the literals tier, which is what makes it uniform. A
	 * TypeScript specifier IS a string in source and a Python one is not, so any answer built on
	 * literal search works in one language and silently returns nothing in the other.
	 */
	async findImports(query: {
		specifier?: string | undefined;
		specifierRegex?: string | undefined;
		module?: string | undefined;
		moduleRegex?: string | undefined;
		limit?: number | undefined;
	}) {
		const limit = query.limit ?? DEFAULT_REFERENCE_LIMIT;
		const targets = [query.specifier, query.specifierRegex, query.module, query.moduleRegex].filter(
			(value) => value !== undefined,
		).length;
		if (targets !== 1) throw new Error("Set exactly one import search target.");

		if (query.specifier !== undefined) {
			const found = this.store.importsMatching(query.specifier, limit + 1);
			return { query, imports: found.slice(0, limit), total: found.length, truncated: found.length > limit };
		}
		if (query.specifierRegex !== undefined) {
			const expression = compileSearchRegex(query.specifierRegex);
			const scanned = this.store.importsForScan(IMPORT_SCAN_LIMIT);
			const matched = scanned.filter((statement) => {
				expression.lastIndex = 0;
				return expression.test(statement.specifier);
			});
			const result = {
				query,
				imports: matched.slice(0, limit),
				total: matched.length,
				truncated: matched.length > limit,
			};
			return scanned.length >= IMPORT_SCAN_LIMIT ? { ...result, scanIncomplete: true } : result;
		}
		if (query.module !== undefined) {
			const target = query.module;
			const matched: StoredImport[] = [];
			for (const statement of this.store.importsForScan(IMPORT_SCAN_LIMIT)) {
				const landed = await this.resolveImport(statement.module, statement.specifier).catch(() => null);
				if (landed !== null && importTarget(landed)?.module === target) matched.push(statement);
				if (matched.length > limit) break;
			}
			return {
				query,
				imports: matched.slice(0, limit),
				total: matched.length,
				truncated: matched.length > limit,
			};
		}

		if (query.moduleRegex === undefined) throw new Error("Set exactly one import search target.");
		const expression = compileSearchRegex(query.moduleRegex);
		const scanned = this.store.importsForScan(IMPORT_SCAN_LIMIT);
		const matched: StoredImport[] = [];
		for (const statement of scanned) {
			const landed = await this.resolveImport(statement.module, statement.specifier).catch(() => null);
			if (landed !== null) {
				const module = importTarget(landed)?.module;
				if (module !== undefined) {
					expression.lastIndex = 0;
					if (expression.test(module)) matched.push(statement);
				}
			}
			if (matched.length > limit) break;
		}
		const result = {
			query,
			imports: matched.slice(0, limit),
			total: matched.length,
			truncated: matched.length > limit,
		};
		return scanned.length >= IMPORT_SCAN_LIMIT ? { ...result, scanIncomplete: true } : result;
	}

	/**
	 * Where a specifier lands. Asked of the provider, since the index does not hold specifiers.
	 *
	 * Cached because it is the one hot question here: it costs a provider round trip, a rename asks
	 * it once per same-named import, and the re-export walk asks the same handful repeatedly.
	 */
	resolveImport(fromModule: string, specifier: string): Promise<ImportResolution> {
		return this.resolve(fromModule, specifier);
	}

	/**
	 * Import statements that write this name AND whose specifier lands on the declaring module.
	 *
	 * Only the alias's source half is a site. `import { foo as bar }` renames `foo` and leaves every
	 * use of `bar` alone, so rewriting the local span here would break the file it was meant to fix.
	 *
	 * Specifiers are resolved here rather than at index time. Resolving all of them while indexing
	 * costs a provider round trip per import across the whole workspace, to answer a question only
	 * the handful sharing a name with a rename target ever ask.
	 */
	async importSitesFor(
		declaringModule: string,
		name: string,
	): Promise<Array<{ module: string; range: Range; factId: string }>> {
		const statements = this.store.importsNamed(name);
		const resolve = this.resolutionCache();
		const exposing = await this.modulesExposing(declaringModule, statements, resolve);

		const found: Array<{ module: string; range: Range; factId: string }> = [];
		for (const statement of statements) {
			// A row without a span names no export, so there is nothing here for a rename to rewrite.
			// The row exists for the import GRAPH, which is a different question.
			if (statement.range === undefined) continue;
			const landed = await resolve(statement.module, statement.specifier);
			if (landed !== null && exposing.has(landed))
				found.push({ module: statement.module, range: statement.range, factId: statement.factId });
		}
		return found;
	}

	/** One provider round trip per distinct specifier, since the re-export walk revisits them. */
	private resolutionCache(): (fromModule: string, specifier: string) => Promise<string | null> {
		const seen = new Map<string, Promise<string | null>>();

		return (fromModule, specifier) => {
			// Escaped, never raw: a raw NUL makes the whole file binary to git and invisible to grep.
			const key = `${fromModule}\0${specifier}`;
			let answer = seen.get(key);
			if (answer === undefined) {
				answer = this.resolveImport(fromModule, specifier)
					.then((r) => (r.status === "resolved" ? r.module : null))
					.catch(() => null);
				seen.set(key, answer);
			}
			return answer;
		};
	}

	/**
	 * Every module through which this name can be reached, the declaring one included.
	 *
	 * A barrel is the normal case, not an exotic one: `import { X } from "@scope/pkg"` resolves to
	 * the package entry, while X is declared in some file that entry re-exports. Demanding the two
	 * be the same module made every such import invisible to a rename, which was found by asking
	 * this tool about its own `ProviderHandlers` and getting 9 of 12 occurrences.
	 *
	 * A fixpoint rather than one hop, because barrels chain. Bounded by the number of re-export
	 * rows, so a cycle of barrels terminates instead of walking forever.
	 */
	async modulesExposing(
		declaringModule: string,
		statements: StoredImport[],
		resolve: (fromModule: string, specifier: string) => Promise<string | null>,
	): Promise<Set<string>> {
		const exposing = new Set([declaringModule]);
		const reExports = statements.filter((statement) => statement.reExport);

		for (let pass = 0; pass <= reExports.length; pass++) {
			let grew = false;
			for (const statement of reExports) {
				if (exposing.has(statement.module)) continue;
				const landed = await resolve(statement.module, statement.specifier);
				if (landed !== null && exposing.has(landed)) {
					exposing.add(statement.module);
					grew = true;
				}
			}
			if (!grew) break;
		}
		return exposing;
	}
}
