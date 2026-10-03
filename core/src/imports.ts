// Which module a specifier names, and which statements brought a name into a file.
//
// The knowledge layer, the move planner and the indexer share it, so one fact has one answer.
// Providers through a port, never a supervisor.

import {
	defined,
	type FindImportsResult,
	type ImportOrigin,
	type ImportResolution,
	type IndexDepth,
	type Landing,
	type ModuleExclusion,
	type MoveImportSite,
	moduleOf,
	type Range,
} from "@nyaa-lexicon/protocol";
import type { ScopeLanding } from "./exportProjection.js";
import { DEFAULT_REFERENCE_LIMIT } from "./indexReads.js";
import { type Paged, pageProbed, pageScanned, wire } from "./paging.js";
import { compileSearchRegex } from "./search.js";
import type { IndexStore, StoredImport } from "./store.js";

////////////////////////////////
//  Constants & Helpers

/** Resolving or regex-searching imports reads at most this many rows. */
const IMPORT_SCAN_LIMIT = 20_000;

/** Where a resolution points and how deeply that target is worth reading, or nowhere. A scope is no one module. */
export function importTarget(resolution: ImportResolution): { module: string; depth: IndexDepth } | null {
	if (resolution.status === "resolved" && resolution.landing.kind === "module") {
		return { module: resolution.landing.module, depth: resolution.depth ?? "full" };
	}
	if (resolution.status === "external" && resolution.surface !== undefined) {
		return { module: resolution.surface.module, depth: "surface" };
	}
	return null;
}

/** An edge as a move or an arrangement re-points it. */
function siteOf(statement: StoredImport, range: Range): MoveImportSite {
	return {
		range,
		specifier: statement.specifier,
		importKind: statement.kind,
		...(statement.typeOnly === true ? { typeOnly: true } : {}),
		...defined({ importedName: statement.name, localName: statement.local }),
	};
}

////////////////////////////////
//  Interfaces & Types

/** The one provider capability this needs. Its supplier owns caching and surface globs; `fresh` skips its cache. */
export type ResolveSpecifier = (fromModule: string, specifier: string, fresh?: boolean) => Promise<ImportResolution>;

/** Only the rows a resolver takes for planning; a store or a stamping context both satisfy it. */
export interface ImportReads {
	importsNamed(name: string): StoredImport[];
	importsIn(module: string): StoredImport[];
	/** Each module whose effective exports name `name`, with what it binds to there. */
	exposuresNamed(name: string): Array<{ module: string; originSymbolId: string | null }>;
	scopeMembers(landing: ScopeLanding): Array<{ symbolId: string; name: string }> | null;
}

////////////////////////////////
//  Class

/** Import questions, answered from the index plus one provider capability. */
export class ImportResolver {
	constructor(
		private readonly store: IndexStore,
		private readonly resolve: ResolveSpecifier,
	) {}
	/** Import statements in one module naming the moved symbol, which must now address its target.
	 * A move plans through the context, so `reads` stamps what it answers. */
	importSitesForMove(module: string, name: string, reads: ImportReads): MoveImportSite[] {
		const sites: MoveImportSite[] = [];
		for (const statement of reads.importsIn(module)) {
			if (statement.name !== name && statement.local !== name) continue;
			if (statement.range !== undefined) sites.push(siteOf(statement, statement.range));
		}
		return sites;
	}

	/**
	 * Every import or re-export naming `name` whose specifier resolves to its declaring module, with
	 * the module holding it. A barrel's re-export counts; a same-named import from elsewhere does not.
	 */
	async importSitesResolvingTo(
		declaringModule: string,
		name: string,
		reads: ImportReads,
	): Promise<Array<{ module: string; site: MoveImportSite }>> {
		const resolve = this.resolutionCache();
		const found: Array<{ module: string; site: MoveImportSite }> = [];
		for (const statement of reads.importsNamed(name)) {
			if (statement.range === undefined || statement.module === declaringModule) continue;
			const landed = await resolve(statement.module, statement.specifier);
			if (landed?.kind !== "module" || landed.module !== declaringModule) continue;
			found.push({ module: statement.module, site: siteOf(statement, statement.range) });
		}
		return found;
	}

	/** The import statement that brought a name into a module, when one did. Stamped through `reads`
	 * for a move's dependency walk. */
	importOriginFor(module: string, name: string, reads: ImportReads): ImportOrigin | null {
		for (const statement of reads.importsIn(module)) {
			if (statement.name !== name && statement.local !== name) continue;
			return {
				specifier: statement.specifier,
				importKind: statement.kind,
				...(statement.typeOnly === true ? { typeOnly: true } : {}),
				...defined({ importedName: statement.name, localName: statement.local }),
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
	async findImports({
		exclude,
		...query
	}: {
		specifier?: string | undefined;
		specifierRegex?: string | undefined;
		module?: string | undefined;
		moduleRegex?: string | undefined;
		limit?: number | undefined;
		exclude?: ModuleExclusion | undefined;
	}): Promise<FindImportsResult> {
		const limit = query.limit ?? DEFAULT_REFERENCE_LIMIT;
		const targets = [query.specifier, query.specifierRegex, query.module, query.moduleRegex].filter(
			(value) => value !== undefined,
		).length;
		if (targets !== 1) throw new Error("Set exactly one import search target.");

		// Read before any await, inside the caller's hold.
		const hidden = this.store.hiddenModules(exclude);
		const answer = (paged: Paged<StoredImport>) => ({
			query,
			imports: paged.items,
			...(exclude === undefined ? {} : { excluded: true as const }),
			...wire(paged),
		});

		if (query.specifier !== undefined) {
			return answer(pageProbed(this.store.importsMatching(query.specifier, limit + 1, hidden), limit));
		}
		if (query.specifierRegex !== undefined) {
			const expression = compileSearchRegex(query.specifierRegex);
			const scanned = this.store.importsForScan(IMPORT_SCAN_LIMIT, hidden);
			const matched = scanned.filter((statement) => expression.test(statement.specifier));
			return answer(pageScanned(matched, limit, { read: scanned.length, cap: IMPORT_SCAN_LIMIT }));
		}
		if (query.module !== undefined) {
			const target = query.module;
			const scanned = this.store.importsForScan(IMPORT_SCAN_LIMIT, hidden);
			const matched: StoredImport[] = [];
			let read = 0;
			for (const statement of scanned) {
				read++;
				const landed = await this.resolveImport(statement.module, statement.specifier).catch(() => null);
				if (landed !== null && importTarget(landed)?.module === target) matched.push(statement);
				if (matched.length > limit) break;
			}
			return answer(pageProbed(matched, limit, { read, cap: IMPORT_SCAN_LIMIT }));
		}

		if (query.moduleRegex === undefined) throw new Error("Set exactly one import search target.");
		const expression = compileSearchRegex(query.moduleRegex);
		const scanned = this.store.importsForScan(IMPORT_SCAN_LIMIT, hidden);
		const matched: StoredImport[] = [];
		let read = 0;
		for (const statement of scanned) {
			read++;
			const landed = await this.resolveImport(statement.module, statement.specifier).catch(() => null);
			if (landed !== null) {
				const module = importTarget(landed)?.module;
				if (module !== undefined && expression.test(module)) matched.push(statement);
			}
			if (matched.length > limit) break;
		}
		return answer(pageProbed(matched, limit, { read, cap: IMPORT_SCAN_LIMIT }));
	}

	/**
	 * Where a specifier lands. Asked of the provider, since the index does not hold specifiers.
	 *
	 * Cached because it is the one hot question here: the indexer asks it for every import it writes.
	 */
	resolveImport(fromModule: string, specifier: string): Promise<ImportResolution> {
		return this.resolve(fromModule, specifier);
	}

	/** Where a specifier lands now, asked of the provider past every cache. */
	resolveLive(fromModule: string, specifier: string): Promise<ImportResolution> {
		return this.resolve(fromModule, specifier, true);
	}

	/**
	 * Import statements that write this name AND whose specifier lands on the declaring module.
	 *
	 * Only the alias's source half is a site. `import { foo as bar }` renames `foo` and leaves every
	 * use of `bar` alone, so rewriting the local span here would break the file it was meant to fix.
	 *
	 * Specifiers are resolved here rather than at index time. Resolving all of them while indexing
	 * costs a provider round trip per import across the whole workspace, to answer a question only
	 * the handful sharing a name with a cited declaration ever ask.
	 *
	 * A caller planning through a context passes it, so `reads` stamps what it answers; a read-only
	 * caller names its own unstamped source explicitly, never by an omitted argument.
	 */
	async importSitesFor(
		declaringModule: string,
		name: string,
		reads: ImportReads,
	): Promise<Array<{ module: string; range: Range; factId: string }>> {
		const statements = reads.importsNamed(name);
		const resolve = this.resolutionCache();
		const exposing = this.modulesExposing(declaringModule, name, reads);

		const found: Array<{ module: string; range: Range; factId: string }> = [];
		for (const statement of statements) {
			// A row without a span names no export, so there is nothing here for a rename to rewrite.
			// The row exists for the import GRAPH, which is a different question.
			if (statement.range === undefined) continue;
			const landed = await resolve(statement.module, statement.specifier);
			const reaches =
				landed === null
					? false
					: landed.kind === "module"
						? exposing.has(landed.module)
						: (reads.scopeMembers(landed) ?? []).some(
								(member) => member.name === name && moduleOf(member.symbolId) === declaringModule,
							);
			if (reaches) found.push({ module: statement.module, range: statement.range, factId: statement.factId });
		}
		return found;
	}

	/** One provider round trip per distinct specifier, since a plan revisits them. */
	private resolutionCache(): (fromModule: string, specifier: string) => Promise<Landing | null> {
		const seen = new Map<string, Promise<Landing | null>>();

		return (fromModule, specifier) => {
			// Escaped, never raw: a raw NUL makes the whole file binary to git and invisible to grep.
			const key = `${fromModule}\0${specifier}`;
			let answer = seen.get(key);
			if (answer === undefined) {
				answer = this.resolveImport(fromModule, specifier)
					.then((r) => (r.status === "resolved" ? r.landing : null))
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
	 * the package entry, while X is declared in some file that entry re-exports. Read from the export
	 * projection, so chained barrels and stars come from the same resolver as the surface.
	 */
	modulesExposing(declaringModule: string, name: string, reads: ImportReads): Set<string> {
		const exposing = new Set([declaringModule]);
		for (const row of reads.exposuresNamed(name)) {
			if (row.originSymbolId !== null && moduleOf(row.originSymbolId) === declaringModule)
				exposing.add(row.module);
		}
		return exposing;
	}
}
