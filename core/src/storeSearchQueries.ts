import {
	type ContentCounts,
	type ContentTotals,
	compileExclusion,
	type FileContent,
	type ModuleExclusion,
	type StoredComment,
	type StoredDeclaration,
	type StoredDoc,
	type StoredImport,
	type StoredLiteral,
	type StoredReference,
} from "@nyaa-lexicon/protocol";
import type { Statements } from "./database.js";
import type { GeneratedVerdict } from "./fileScope.js";
import type { ScopeFilter } from "./scope.js";
import { compileSearchRegex } from "./search.js";
import type { CommentFilter, DocFilter, HiddenModules, LiteralFilter } from "./store.js";
import {
	COMMENT_ORDER,
	commentWhere,
	DOC_ORDER,
	docWhere,
	importWhere,
	leaveOut,
	likePattern,
	literalWhere,
	sharedWhere,
	TEST_PATH,
	under,
	useSql,
	VENDOR_PATH,
} from "./storeQuerySql.js";
import {
	rowToComment,
	rowToDeclaration,
	rowToDoc,
	rowToImport,
	rowToLiteral,
	rowToReference,
	verdictFromRow,
} from "./storeRows.js";
import type { FACT_TABLES } from "./storeSchema.js";

export class StoreSearchQueries {
	constructor(
		private readonly db: Statements,
		private readonly noneHiddenModules: HiddenModules,
	) {}

	/** Search declarations by name substring or regular expression. */
	searchSymbols(
		text: string | undefined,
		options: {
			regex?: string | undefined;
			kind?: string;
			module?: string;
			limit: number;
			scope?: ScopeFilter;
			hidden: HiddenModules;
		},
	): StoredDeclaration[] {
		const regex = options.regex === undefined ? undefined : compileSearchRegex(options.regex);
		const clauses: string[] = [];
		const values: Array<string | number> = [];
		leaveOut(options.hidden, clauses, values);
		if (text !== undefined) {
			clauses.push("name LIKE ? ESCAPE '\\'");
			values.push(`%${likePattern(text)}%`);
		}
		if (options.kind !== undefined) {
			clauses.push("kind = ?");
			values.push(options.kind);
		}
		if (options.module !== undefined) under("module", options.module, clauses, values);
		if (options.scope?.module !== undefined) {
			clauses.push("symbolId >= ? AND symbolId < ?");
			values.push(options.scope.low as string, options.scope.high as string);
		}
		if (options.scope?.like !== undefined) {
			clauses.push("symbolId LIKE ? ESCAPE '\\'");
			values.push(`${options.scope.head}%${likePattern(options.scope.like)}%`);
		}
		if (clauses.length === 0) clauses.push("1 = 1");
		// A scoped read is bounded even under a regex: the exact check runs after it and says so.
		const bounded = regex === undefined || options.scope !== undefined;
		const limit = bounded ? " LIMIT ?" : "";
		if (bounded) values.push(options.limit);

		const rows = this.db
			.prepare(`SELECT * FROM symbols WHERE ${clauses.join(" AND ")} ORDER BY module, startLine${limit}`)
			.all(...values)
			.map(rowToDeclaration);
		if (regex === undefined) return rows;

		return rows.filter((row) => regex.test(row.name)).slice(0, options.limit);
	}

	/** Declarations whose name contains `text`, any case: own code, then top-level, then exact names, then
	 * prefixes, then shortest. */
	symbolsNamedLike(text: string, limit: number, offset = 0, kinds?: readonly string[]): StoredDeclaration[] {
		const kindClause = kinds === undefined ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
		const escaped = likePattern(text);
		return this.db
			.prepare(
				`SELECT * FROM symbols WHERE name LIKE ? ESCAPE '\\'${kindClause}
				 ORDER BY ${VENDOR_PATH} ASC, (containerId IS NULL) DESC, (name = ? COLLATE NOCASE) DESC,
				 (name LIKE ? ESCAPE '\\') DESC, ${TEST_PATH} ASC, length(name), module, startLine
				 LIMIT ? OFFSET ?`,
			)
			.all(`%${escaped}%`, ...(kinds ?? []), text, `${escaped}%`, limit, offset)
			.map(rowToDeclaration);
	}

	/** Indexed files whose path contains `text`, any case: own code, then a name starting with it, then shortest. */
	filesNamedLike(text: string, limit: number): string[] {
		const escaped = likePattern(text);
		// The directory part is what rtrim leaves once every character but '/' is trimmed away.
		const rows = this.db
			.prepare(
				`SELECT module FROM files WHERE module LIKE ? ESCAPE '\\'
				 ORDER BY ${VENDOR_PATH} ASC, (substr(module, length(rtrim(module, replace(module, '/', ''))) + 1) LIKE ? ESCAPE '\\') DESC,
				 ${TEST_PATH} ASC, length(module), module LIMIT ?`,
			)
			.all(`%${escaped}%`, `${escaped}%`, limit) as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Imports whose specifier contains this text. "Which files import X", by the name as written. */
	importsMatching(specifier: string, limit: number, hidden: HiddenModules): StoredImport[] {
		const { clause, values } = importWhere(hidden, specifier);
		const rows = this.db
			.prepare(`SELECT * FROM imports ${clause} ORDER BY module, startLine LIMIT ?`)
			.all(...values, limit);
		return rows.map(rowToImport);
	}

	/** Every module held by the index, including files with no declarations. */
	indexedFiles(): string[] {
		const rows = this.db.prepare("SELECT module FROM files ORDER BY module").all() as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Modules `exclude` hides, for this hold's searches. */
	hiddenModules(exclude: ModuleExclusion | undefined): HiddenModules {
		if (exclude === undefined) return this.noneHiddenModules;
		return this.indexedFiles().filter(compileExclusion(exclude)) as readonly string[] as HiddenModules;
	}

	/** Every module with facts, ordered by symbol count. Content is null on a row written before it was kept. */
	moduleSummary(): Array<{ module: string; symbols: number; content: FileContent | null }> {
		return this.db
			.prepare(
				`SELECT s.module AS module, COUNT(*) AS symbols, f.content AS content
				 FROM symbols s LEFT JOIN files f ON f.module = s.module
				 GROUP BY s.module ORDER BY symbols DESC`,
			)
			.all() as Array<{ module: string; symbols: number; content: FileContent | null }>;
	}

	/** Files and symbols per content class, over the modules a live workspace predicate admits. */
	contentTotals(includeModule: (module: string) => boolean): ContentTotals {
		const rows = this.db
			.prepare(
				`SELECT f.module AS module, f.content AS content, COUNT(s.symbolId) AS symbols
				 FROM files f LEFT JOIN symbols s ON s.module = f.module
				 GROUP BY f.module`,
			)
			.all() as Array<{ module: string; content: FileContent | null; symbols: number }>;
		const files: ContentCounts = { code: 0, data: 0, document: 0, text: 0, unknown: 0 };
		const symbols: ContentCounts = { code: 0, data: 0, document: 0, text: 0, unknown: 0 };
		for (const row of rows) {
			if (!includeModule(row.module)) continue;
			const key = row.content ?? "unknown";
			files[key] += 1;
			symbols[key] += row.symbols;
		}
		return { files, symbols };
	}

	/** Counts for an overview, in one round trip rather than five. */
	totals(): { files: number; symbols: number; references: number; imports: number; literals: number } {
		const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
		return {
			files: one("SELECT COUNT(*) AS n FROM files"),
			symbols: one("SELECT COUNT(*) AS n FROM symbols"),
			references: one("SELECT COUNT(*) AS n FROM refs"),
			imports: one("SELECT COUNT(*) AS n FROM imports"),
			literals: one("SELECT COUNT(*) AS n FROM literals"),
		};
	}

	/**
	 * The symbol count split by kind, so one total cannot mean two things.
	 *
	 * A document's headings and keys are symbols and belong in the count, but a reader taking that
	 * count for callable code is reading it wrong once any document is indexed. Split rather than
	 * filtered, because which kinds are code is the caller's question and not this table's.
	 */
	symbolsByKind(): Record<string, number> {
		const rows = this.db.prepare("SELECT kind, COUNT(*) AS n FROM symbols GROUP BY kind").all() as Array<{
			kind: string;
			n: number;
		}>;
		return Object.fromEntries(rows.map((row) => [row.kind, row.n]));
	}

	/** Counts facts whose modules satisfy a live workspace predicate. */
	totalsForModules(includeModule: (module: string) => boolean): {
		files: number;
		symbols: number;
		references: number;
		imports: number;
		literals: number;
	} {
		const count = (table: "files" | (typeof FACT_TABLES)[number]): number => {
			const rows = this.db.prepare(`SELECT module, COUNT(*) AS n FROM ${table} GROUP BY module`).all() as Array<{
				module: string;
				n: number;
			}>;
			return rows.reduce((total, row) => (includeModule(row.module) ? total + row.n : total), 0);
		};
		return {
			files: count("files"),
			symbols: count("symbols"),
			references: count("refs"),
			imports: count("imports"),
			literals: count("literals"),
		};
	}

	/** Every symbol with a given name, across the workspace. The entry point for a name-only ask. */
	declarationsNamed(name: string): StoredDeclaration[] {
		const rows = this.db.prepare("SELECT * FROM symbols WHERE name = ? ORDER BY module, startLine").all(name);
		return rows.map(rowToDeclaration);
	}

	////////////////////////////////
	//  Literals

	literalsWhere(filter: LiteralFilter, limit: number): StoredLiteral[] {
		const { clause, values, join } = literalWhere(filter);
		const rows = this.db
			.prepare(
				`SELECT l.*, s.name AS containerName, s.kind AS containerKind FROM literals l ${join} ${clause} ORDER BY l.module, l.startLine LIMIT ?`,
			)
			.all(...values, limit);
		return rows.map(rowToLiteral);
	}

	countLiteralsWhere(filter: LiteralFilter): number {
		const { clause, values, join } = literalWhere(filter);
		return (
			this.db.prepare(`SELECT COUNT(*) AS n FROM literals l ${join} ${clause}`).get(...values) as { n: number }
		).n;
	}

	/** Every literal in one module, matching declarationsIn and referencesIn. */
	literalsIn(module: string): StoredLiteral[] {
		const rows = this.db
			.prepare("SELECT * FROM literals WHERE module = ? ORDER BY startLine, startChar")
			.all(module);
		return rows.map(rowToLiteral);
	}

	////////////////////////////////
	//  Comments

	/** Substring over the NORMALIZED text, so a phrase the writer wrapped still matches. */
	commentsContaining(text: string, limit: number, filter: CommentFilter): StoredComment[] {
		const { clause, values } = commentWhere(filter, text);
		const rows = this.db.prepare(`SELECT * FROM comments ${clause} ${COMMENT_ORDER} LIMIT ?`).all(...values, limit);
		return rows.map(rowToComment);
	}

	/** The true count, so a page never reports its own cap as a total. */
	countCommentsContaining(text: string, filter: CommentFilter): number {
		const { clause, values } = commentWhere(filter, text);
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM comments ${clause}`).get(...values) as { n: number }).n;
	}

	/** Every comment a caller must match itself, for the same reason literals need one: no REGEXP. */
	commentsToScan(scanLimit: number, filter: CommentFilter): StoredComment[] {
		const { clause, values } = commentWhere(filter);
		const rows = this.db
			.prepare(`SELECT * FROM comments ${clause} ${COMMENT_ORDER} LIMIT ?`)
			.all(...values, scanLimit);
		return rows.map(rowToComment);
	}

	countComments(filter: CommentFilter): number {
		const { clause, values } = commentWhere(filter);
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM comments ${clause}`).get(...values) as { n: number }).n;
	}

	/** What is written about one symbol, which is how describe gets its documentation. */
	commentsAnchoredTo(symbolId: string): StoredComment[] {
		const rows = this.db
			.prepare("SELECT * FROM comments WHERE anchorId = ? ORDER BY startLine, startChar")
			.all(symbolId);
		return rows.map(rowToComment);
	}

	/** Every comment in one module, matching declarationsIn and referencesIn. */
	commentsIn(module: string): StoredComment[] {
		const rows = this.db
			.prepare("SELECT * FROM comments WHERE module = ? ORDER BY startLine, startChar")
			.all(module);
		return rows.map(rowToComment);
	}

	////////////////////////////////
	//  Documents

	docsContaining(text: string, limit: number, filter: DocFilter): StoredDoc[] {
		const { clause, values } = docWhere(filter, text);
		const rows = this.db.prepare(`SELECT * FROM docs ${clause} ${DOC_ORDER} LIMIT ?`).all(...values, limit);
		return rows.map(rowToDoc);
	}

	/** The true count, so a page never reports its own cap as a total. */
	countDocsContaining(text: string, filter: DocFilter): number {
		const { clause, values } = docWhere(filter, text);
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM docs ${clause}`).get(...values) as { n: number }).n;
	}

	/** Every region a caller must match itself, for the same reason comments need one: no REGEXP. */
	docsToScan(scanLimit: number, filter: DocFilter): StoredDoc[] {
		const { clause, values } = docWhere(filter);
		const rows = this.db.prepare(`SELECT * FROM docs ${clause} ${DOC_ORDER} LIMIT ?`).all(...values, scanLimit);
		return rows.map(rowToDoc);
	}

	countDocs(filter: DocFilter): number {
		const { clause, values } = docWhere(filter);
		return (this.db.prepare(`SELECT COUNT(*) AS n FROM docs ${clause}`).get(...values) as { n: number }).n;
	}

	/** The prose of one section, which is how describe answers about a heading. */
	docsAnchoredTo(symbolId: string): StoredDoc[] {
		const rows = this.db.prepare(`SELECT * FROM docs WHERE anchorId = ? ${DOC_ORDER}`).all(symbolId);
		return rows.map(rowToDoc);
	}

	/**
	 * Values written in more than one file, commonest first.
	 *
	 * The whole point of the tier: a magic string shared by two files is the strongest textual
	 * signal that they are related, and no graph edge connects them.
	 */
	sharedLiterals(
		minimumFiles: number,
		limit: number,
		hidden: HiddenModules,
	): Array<{ value: string; kind: string; files: number; uses: number }> {
		const { clause, values } = sharedWhere(hidden);
		const rows = this.db
			.prepare(
				`SELECT value, kind, COUNT(DISTINCT module) AS files, COUNT(*) AS uses
				 FROM literals ${clause} GROUP BY value, kind HAVING files >= ? ORDER BY files DESC, uses DESC LIMIT ?`,
			)
			.all(...values, minimumFiles, limit) as Array<{ value: string; kind: string; files: number; uses: number }>;
		return rows;
	}

	////////////////////////////////
	//  Graph

	/** Bound rows only; fan-out. */
	usesFrom(symbolId: string): StoredReference[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM refs r WHERE r.fromId = ? AND r.targetId IS NOT NULL AND ${useSql("r")} ORDER BY module, startLine, startChar`,
			)
			.all(symbolId);
		return rows.map(rowToReference);
	}

	/** Distinct bound targets used from any of `fromIds`, in one read however many there are. */
	targetsFrom(fromIds: readonly string[]): Set<string> {
		if (fromIds.length === 0) return new Set();
		const rows = this.db
			.prepare(
				`SELECT DISTINCT r.targetId AS targetId FROM refs r
				 WHERE r.fromId IN (SELECT value FROM json_each(?)) AND r.targetId IS NOT NULL AND ${useSql("r")}`,
			)
			.all(JSON.stringify(fromIds)) as Array<{ targetId: string }>;
		return new Set(rows.map((row) => row.targetId));
	}

	/** Distinct bound targets a module's top level uses. */
	topLevelTargets(module: string): Set<string> {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT r.targetId AS targetId FROM refs r
				 WHERE r.module = ? AND r.fromId IS NULL AND r.targetId IS NOT NULL AND ${useSql("r")}`,
			)
			.all(module) as Array<{ targetId: string }>;
		return new Set(rows.map((row) => row.targetId));
	}

	/** Most-used symbols first. Hub rank, which is fan-in sorted, ties by id so two runs agree. */
	mostReferenced(limit: number): Array<{ symbolId: string; count: number }> {
		return this.db
			.prepare(
				`SELECT targetId AS symbolId, COUNT(*) AS count FROM refs r
				 WHERE targetId IS NOT NULL AND ${useSql("r")} GROUP BY targetId ORDER BY count DESC, targetId LIMIT ?`,
			)
			.all(limit) as Array<{ symbolId: string; count: number }>;
	}

	/** Git's word on a file as recorded; null on a row written without asking. */
	generatedOf(module: string): GeneratedVerdict | null {
		const row = this.db.prepare("SELECT generated, generatedReason FROM files WHERE module = ?").get(module) as
			| { generated: string | null; generatedReason: string | null }
			| undefined;
		if (row === undefined || row.generated === null) return null;
		return verdictFromRow(row.generated, row.generatedReason);
	}

	/** Symbols nothing references. Honest only as far as binding reaches, which the caller states. */
	unreferencedSymbols(): StoredDeclaration[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM symbols WHERE symbolId NOT IN (SELECT targetId FROM refs WHERE targetId IS NOT NULL)",
			)
			.all();
		return rows.map(rowToDeclaration);
	}
}
