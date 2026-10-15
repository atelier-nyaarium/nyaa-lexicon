import {
	type Landing,
	parseFactId,
	type Range,
	type ReferenceRole,
	type ResolutionMode,
	type StoredDeclaration,
	type StoredFact,
	type StoredImport,
	type StoredReference,
} from "@nyaa-lexicon/protocol";
import type { Statements } from "./database.js";
import type { HiddenModules } from "./store.js";
import { importWhere, TEST_PATH, useSql } from "./storeQuerySql.js";
import {
	rowToComment,
	rowToDeclaration,
	rowToDoc,
	rowToExport,
	rowToImport,
	rowToLiteral,
	rowToReference,
} from "./storeRows.js";

export class StoreFactQueries {
	constructor(private readonly db: Statements) {}

	/**
	 * The fact one id names, or null when it names nothing any more.
	 *
	 * Null IS the staleness signal. A fact id is a digest of the fact's own contents, so an id that
	 * no longer resolves is exactly a fact that changed or vanished, and a citation holder needs no
	 * second hash to compare.
	 */
	factById(factId: string): StoredFact | null {
		const parsed = parseFactId(factId);
		if (parsed === null) return null;

		// The id carries its kind, so this reads one table rather than searching every one.
		switch (parsed.kind) {
			case "declaration": {
				const row = this.db.prepare("SELECT * FROM symbols WHERE factId = ?").get(factId);
				return row ? { fact: "declaration", ...rowToDeclaration(row) } : null;
			}
			case "reference": {
				const row = this.db.prepare("SELECT * FROM refs WHERE factId = ?").get(factId);
				return row ? { fact: "reference", ...rowToReference(row) } : null;
			}
			case "import": {
				const row = this.db.prepare("SELECT * FROM imports WHERE factId = ?").get(factId);
				return row ? { fact: "import", ...rowToImport(row) } : null;
			}
			case "export": {
				const row = this.db.prepare("SELECT * FROM exports WHERE factId = ?").get(factId);
				return row ? { fact: "export", ...rowToExport(row) } : null;
			}
			case "literal": {
				const row = this.db.prepare("SELECT * FROM literals WHERE factId = ?").get(factId);
				return row ? { fact: "literal", ...rowToLiteral(row) } : null;
			}
			case "comment": {
				const row = this.db.prepare("SELECT * FROM comments WHERE factId = ?").get(factId);
				return row ? { fact: "comment", ...rowToComment(row) } : null;
			}
			case "doc": {
				const row = this.db.prepare("SELECT * FROM docs WHERE factId = ?").get(factId);
				return row ? { fact: "doc", ...rowToDoc(row) } : null;
			}
			default: {
				const unreachable: never = parsed.kind;
				return unreachable;
			}
		}
	}

	/** A declaration's pattern digest and what it covers, or null before a full parse minted one. */
	patternDigestOf(symbolId: string): { digest: string; coverage: string } | null {
		const row = this.db
			.prepare("SELECT patternDigest, patternCoverage FROM symbols WHERE symbolId = ?")
			.get(symbolId) as { patternDigest: string | null; patternCoverage: string | null } | undefined;
		if (row === undefined || row.patternDigest === null || row.patternCoverage === null) return null;
		return { digest: row.patternDigest, coverage: row.patternCoverage };
	}

	/** Every symbol id the index holds for one module, which is the subtree a rename re-mints. */
	symbolIdsIn(module: string): string[] {
		const rows = this.db.prepare("SELECT symbolId FROM symbols WHERE module = ?").all(module) as Array<{
			symbolId: string;
		}>;
		return rows.map((row) => row.symbolId);
	}

	////////////////////////////////
	//  Reading

	contentHashOf(module: string): string | null {
		const row = this.db.prepare("SELECT contentHash FROM files WHERE module = ?").get(module) as
			| { contentHash: string }
			| undefined;
		return row?.contentHash ?? null;
	}

	newestIndexedAt(): number | null {
		const row = this.db.prepare("SELECT indexedAt FROM files ORDER BY indexedAt DESC LIMIT 1").get() as
			| { indexedAt: number }
			| undefined;
		return row?.indexedAt ?? null;
	}

	declaration(symbolId: string): StoredDeclaration | null {
		const row = this.db.prepare("SELECT * FROM symbols WHERE symbolId = ?").get(symbolId) as
			| Record<string, unknown>
			| undefined;
		return row ? rowToDeclaration(row) : null;
	}

	declarationsIn(module: string): StoredDeclaration[] {
		const rows = this.db
			.prepare("SELECT * FROM symbols WHERE module = ? ORDER BY startLine, startChar")
			.all(module);
		return rows.map(rowToDeclaration);
	}

	/** Mentions included; see usesTo. */
	referencesTo(symbolId: string): StoredReference[] {
		const rows = this.db
			.prepare("SELECT * FROM refs WHERE targetId = ? ORDER BY module, startLine, startChar")
			.all(symbolId);
		return rows.map(rowToReference);
	}

	/** Why the storage exists. */
	usesTo(symbolId: string): StoredReference[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM refs r WHERE r.targetId = ? AND ${useSql("r")} ORDER BY module, startLine, startChar`,
			)
			.all(symbolId);
		return rows.map(rowToReference);
	}

	/**
	 * How many uses in `modules` each import edge carries, bound or not, by module and edge span, in
	 * one read. Roles in `skip` are left out.
	 */
	importUseCounts(
		modules: readonly string[],
		skip: readonly ReferenceRole[],
	): Array<{ module: string; origin: Range; count: number }> {
		const rows = this.db
			.prepare(
				`SELECT module, originStartLine, originStartChar, originEndLine, originEndChar, COUNT(*) AS count
				 FROM refs r WHERE r.module IN (SELECT value FROM json_each(?)) AND r.originKind = 'import' AND ${useSql("r")}
				 AND r.role NOT IN (SELECT value FROM json_each(?))
				 GROUP BY module, originStartLine, originStartChar, originEndLine, originEndChar
				 ORDER BY module, originStartLine, originStartChar`,
			)
			.all(JSON.stringify(modules), JSON.stringify(skip)) as Array<{
			module: string;
			originStartLine: number;
			originStartChar: number;
			originEndLine: number;
			originEndChar: number;
			count: number;
		}>;
		return rows.map((row) => ({
			module: row.module,
			origin: {
				start: { line: row.originStartLine, character: row.originStartChar },
				end: { line: row.originEndLine, character: row.originEndChar },
			},
			count: row.count,
		}));
	}

	/** The first `limit` uses in `module` through the import edge spanning `origin`, roles in `skip` aside. */
	importUsesThrough(
		module: string,
		origin: Range,
		skip: readonly ReferenceRole[],
		limit: number,
	): Array<{ name: string; range: Range }> {
		const rows = this.db
			.prepare(
				`SELECT name, startLine, startChar, endLine, endChar FROM refs r
				 WHERE r.module = ? AND r.originKind = 'import' AND ${useSql("r")}
				 AND r.originStartLine = ? AND r.originStartChar = ? AND r.originEndLine = ? AND r.originEndChar = ?
				 AND r.role NOT IN (SELECT value FROM json_each(?))
				 ORDER BY startLine, startChar LIMIT ?`,
			)
			.all(
				module,
				origin.start.line,
				origin.start.character,
				origin.end.line,
				origin.end.character,
				JSON.stringify(skip),
				limit,
			) as Array<{ name: string; startLine: number; startChar: number; endLine: number; endChar: number }>;
		return rows.map((row) => ({
			name: row.name,
			range: {
				start: { line: row.startLine, character: row.startChar },
				end: { line: row.endLine, character: row.endChar },
			},
		}));
	}

	/** Use counts per declaration, in one read; unused is absent. */
	useCountsIn(module: string): Map<string, number> {
		const rows = this.db
			.prepare(
				`SELECT r.targetId AS symbolId, COUNT(*) AS n FROM refs r
				 WHERE r.targetId IN (SELECT symbolId FROM symbols WHERE module = ?) AND ${useSql("r")}
				 GROUP BY r.targetId`,
			)
			.all(module) as Array<{ symbolId: string; n: number }>;
		return new Map(rows.map((row) => [row.symbolId, row.n]));
	}

	/** Distinct using declarations per symbol; top-level uses count their module, and unused symbols are absent. */
	holderCounts(symbolIds: readonly string[]): Map<string, number> {
		if (symbolIds.length === 0) return new Map();
		const rows = this.db
			.prepare(
				`SELECT r.targetId AS symbolId, COUNT(DISTINCT COALESCE(r.fromId, 'module ' || r.module)) AS n
				 FROM refs r WHERE r.targetId IN (SELECT value FROM json_each(?)) AND ${useSql("r")}
				 GROUP BY r.targetId`,
			)
			.all(JSON.stringify(symbolIds)) as Array<{ symbolId: string; n: number }>;
		return new Map(rows.map((row) => [row.symbolId, row.n]));
	}

	/** Whether a module's path reads as a test, by the rule name searches rank with. */
	testModule(module: string): boolean {
		const row = this.db.prepare(`SELECT ${TEST_PATH} AS test FROM (SELECT ? AS module)`).get(module) as {
			test: number;
		};
		return row.test === 1;
	}

	/** Each other module using something `module` declares, with up to three of those, `except` aside. */
	usesInto(module: string, except: string): Map<string, string[]> {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT r.module AS module, r.targetId AS targetId FROM refs r
				 JOIN symbols s ON s.symbolId = r.targetId
				 WHERE s.module = ? AND r.module <> ? AND r.targetId <> ? AND ${useSql("r")}
				 ORDER BY r.module, r.targetId`,
			)
			.all(module, module, except) as Array<{ module: string; targetId: string }>;
		const byModule = new Map<string, string[]>();
		for (const row of rows) {
			const held = byModule.get(row.module) ?? [];
			if (held.length < 3) held.push(row.targetId);
			byModule.set(row.module, held);
		}
		return byModule;
	}

	/** Whether `module` uses the symbol. */
	moduleUses(module: string, symbolId: string): boolean {
		return (
			this.db
				.prepare(`SELECT 1 FROM refs r WHERE r.module = ? AND r.targetId = ? AND ${useSql("r")} LIMIT 1`)
				.get(module, symbolId) !== undefined
		);
	}

	/** Use counts for a symbol, grouped by module. */
	usingModules(symbolId: string): Map<string, number> {
		const rows = this.db
			.prepare(
				`SELECT r.module AS module, COUNT(*) AS n FROM refs r WHERE r.targetId = ? AND ${useSql("r")}
				 GROUP BY r.module`,
			)
			.all(symbolId) as Array<{ module: string; n: number }>;
		return new Map(rows.map((row) => [row.module, row.n]));
	}

	/** Distinct resolved import targets for a module. */
	importTargets(module: string): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT target FROM imports WHERE module = ? AND target IS NOT NULL ORDER BY target")
			.all(module) as Array<{ target: string }>;
		return rows.map((row) => row.target);
	}

	/** Modules with at least one declaration marked exported by its provider. */
	exportingModules(): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT module FROM symbols WHERE exported = 1 ORDER BY module")
			.all() as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Mentions included; see usesIn. */
	referencesIn(module: string): StoredReference[] {
		const rows = this.db.prepare("SELECT * FROM refs WHERE module = ? ORDER BY startLine, startChar").all(module);
		return rows.map(rowToReference);
	}

	/** Includes unbound rows too. */
	usesIn(module: string): StoredReference[] {
		const rows = this.db
			.prepare(`SELECT * FROM refs r WHERE r.module = ? AND ${useSql("r")} ORDER BY startLine, startChar`)
			.all(module);
		return rows.map(rowToReference);
	}

	/**
	 * Occurrences spelled like this that did NOT bind to the given symbol.
	 *
	 * The set a rename has to worry about. Some are genuinely other symbols and some are uses of
	 * this one that binding could not follow, and nothing here can tell those apart, which is
	 * precisely why they are returned rather than filtered away.
	 */
	referencesSpelled(name: string, excludingTarget: string): StoredReference[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM refs WHERE name = ? AND (targetId IS NULL OR targetId != ?) ORDER BY module, startLine",
			)
			.all(name, excludingTarget);
		return rows.map(rowToReference);
	}

	/**
	 * Every import that writes this name, anywhere in the workspace.
	 *
	 * Returned unresolved. Whether one of these refers to a particular symbol depends on where its
	 * specifier lands, which only a provider can say, and asking about every import in the workspace
	 * to answer about one symbol would be the wrong trade.
	 */
	importsNamed(name: string): StoredImport[] {
		const rows = this.db.prepare("SELECT * FROM imports WHERE name = ? ORDER BY module, startLine").all(name);
		return rows.map(rowToImport);
	}

	/**
	 * Imports that BIND this name in the importing file, which is not the same question as `importsNamed`.
	 *
	 * `import { a as bar }` is named `a` and binds `bar`. A collision check cares about what the file
	 * calls it, and a rename of the source symbol cares about what the source module calls it, so the
	 * two questions read the same table through different columns.
	 */
	importsBinding(localName: string): StoredImport[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM imports
				 WHERE bindsLocally = 1 AND (localName = ? OR (localName IS NULL AND name = ?))
				 ORDER BY module, spanStartLine`,
			)
			.all(localName, localName);
		return rows.map(rowToImport);
	}

	importsIn(module: string): StoredImport[] {
		const rows = this.db
			.prepare("SELECT * FROM imports WHERE module = ? ORDER BY spanStartLine, spanStartChar")
			.all(module);
		return rows.map(rowToImport);
	}

	/** Each module whose effective exports name `name`, with what it binds to there. */
	exposuresNamed(name: string): Array<{ module: string; originSymbolId: string | null }> {
		return this.db
			.prepare("SELECT module, originSymbolId FROM effective_exports WHERE name = ? ORDER BY module")
			.all(name) as Array<{ module: string; originSymbolId: string | null }>;
	}

	/** Where `specifier` landed from `module` in `mode` when it was written; null when unknown. */
	importLanding(module: string, specifier: string, mode: ResolutionMode | undefined): Landing | null {
		const row = this.db
			.prepare(
				`SELECT landing FROM imports WHERE module = ? AND specifier = ?
				 AND json_extract(edge, '$.resolutionMode') IS ? AND landing IS NOT NULL LIMIT 1`,
			)
			.get(module, specifier, mode ?? null) as { landing: string } | undefined;
		return row === undefined ? null : (JSON.parse(row.landing) as Landing);
	}

	/**
	 * The declaration `name` means in `module`, through its effective exports. Null when nothing
	 * exports it, or it names a namespace or a module value.
	 */
	exportedSymbol(module: string, name: string): string | null {
		const row = this.db
			.prepare(
				`SELECT originSymbolId FROM effective_exports
				 WHERE module = ? AND name = ? AND originSymbolId IS NOT NULL ORDER BY rowid LIMIT 1`,
			)
			.get(module, name) as { originSymbolId: string } | undefined;
		return row?.originSymbolId ?? null;
	}

	/** Import rows for bounded application-side searches. */
	importsForScan(scanLimit: number, hidden: HiddenModules): StoredImport[] {
		const { clause, values } = importWhere(hidden);
		const rows = this.db
			.prepare(`SELECT * FROM imports ${clause} ORDER BY module, startLine LIMIT ?`)
			.all(...values, scanLimit);
		return rows.map(rowToImport);
	}
}
