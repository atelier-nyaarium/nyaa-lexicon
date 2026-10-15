import type { AllList, Landing, Range, ResolutionMode, StoredExport, StoredImport } from "@nyaa-lexicon/protocol";
import type { Statements } from "./database.js";
import { type EffectiveExport, type ScopeLanding, scopeKey, scopeOfKey } from "./exportProjection.js";
import { rowToExport, rowToImport } from "./storeRows.js";

export class StoreProjectionQueries {
	constructor(private readonly db: Statements) {}

	/** The scope keys a module contributes to. */
	scopeKeysOf(module: string): string[] {
		const rows = this.db
			.prepare("SELECT scopeKey FROM scope_contributions WHERE module = ? ORDER BY scopeKey")
			.all(module) as Array<{ scopeKey: string }>;
		return rows.map((row) => row.scopeKey);
	}

	fileOf(module: string): { exportsKnown: boolean; allList: AllList | null } | null {
		const row = this.db.prepare("SELECT exportsKnown, allList FROM files WHERE module = ?").get(module) as
			| { exportsKnown: number; allList: string | null }
			| undefined;
		if (row === undefined) return null;
		return { exportsKnown: row.exportsKnown === 1, allList: row.allList === null ? null : JSON.parse(row.allList) };
	}

	exportsIn(module: string): StoredExport[] {
		return this.db.prepare("SELECT * FROM exports WHERE module = ?").all(module).map(rowToExport);
	}

	/** Export edges whose target is this declaration, or whose name a module exposes it under. */
	exportsOf(symbolId: string): StoredExport[] {
		return this.db
			.prepare(
				`SELECT * FROM exports WHERE targetSymbolId = ?
				 UNION
				 SELECT e.* FROM exports e JOIN effective_exports x ON x.module = e.module AND x.name = e.name
				 WHERE x.originSymbolId = ?
				 ORDER BY module`,
			)
			.all(symbolId, symbolId)
			.map(rowToExport);
	}

	importEdgeAt(module: string, span: Range): StoredImport | null {
		const row = this.db
			.prepare(
				`SELECT * FROM imports WHERE module = ? AND spanStartLine = ? AND spanStartChar = ?
				 AND spanEndLine = ? AND spanEndChar = ?`,
			)
			.get(module, span.start.line, span.start.character, span.end.line, span.end.character);
		return row === undefined ? null : rowToImport(row);
	}

	exportedDeclarations(module: string): Array<{ symbolId: string; name: string }> {
		return this.db
			.prepare(
				`SELECT symbolId, name FROM symbols
				 WHERE module = ? AND containerId IS NULL AND visibility <> 'local' AND (exported IS NULL OR exported = 1)
				 ORDER BY startLine, startChar`,
			)
			.all(module) as Array<{ symbolId: string; name: string }>;
	}

	scopeMembers(landing: ScopeLanding): Array<{ symbolId: string; name: string }> | null {
		const key = scopeKey(landing);
		if (this.db.prepare("SELECT 1 FROM scope_contributions WHERE scopeKey = ? LIMIT 1").get(key) === undefined) {
			return null;
		}
		return this.db
			.prepare(
				`SELECT s.symbolId, s.name FROM scope_members m JOIN symbols s ON s.symbolId = m.memberId
				 WHERE m.scopeKey = ? ORDER BY s.module, s.startLine`,
			)
			.all(key) as Array<{ symbolId: string; name: string }>;
	}

	scopeExports(landing: ScopeLanding): Array<{ module: string; edge: StoredExport }> {
		return this.db
			.prepare(
				`SELECT e.* FROM exports e JOIN scope_contributions c ON c.module = e.module
				 WHERE c.scopeKey = ? AND json_extract(e.edge, '$.scopeId') = ? ORDER BY e.module`,
			)
			.all(scopeKey(landing), landing.scopeId)
			.map(rowToExport)
			.map((edge) => ({ module: edge.module, edge }));
	}

	/** The effective exports settlement last committed for a module. */
	effectiveExportsOf(module: string): EffectiveExport[] {
		const rows = this.db
			.prepare("SELECT name, meaning, origin, certainty FROM effective_exports WHERE module = ? ORDER BY rowid")
			.all(module) as Array<{ name: string | null; meaning: string | null; origin: string; certainty: string }>;
		return rows.map((row) => ({
			name: row.name,
			...(row.meaning === null ? {} : { meaning: JSON.parse(row.meaning) }),
			origin: JSON.parse(row.origin),
			certainty: JSON.parse(row.certainty),
		}));
	}

	nextProjectionDebt(): string | null {
		const row = this.db.prepare("SELECT module FROM projection_debt ORDER BY rowid LIMIT 1").get() as
			| { module: string }
			| undefined;
		return row?.module ?? null;
	}

	/** Modules whose export edges forward from an import landing on `module` or on one of `scopes`. */
	forwardersOf(module: string | null, scopes: readonly string[]): string[] {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT i.module FROM imports i
				 JOIN exports e ON e.module = i.module AND e.targetKind = 'import'
				  AND json_extract(e.edge, '$.target.span.start.line') = i.spanStartLine
				  AND json_extract(e.edge, '$.target.span.start.character') = i.spanStartChar
				  AND json_extract(e.edge, '$.target.span.end.line') = i.spanEndLine
				  AND json_extract(e.edge, '$.target.span.end.character') = i.spanEndChar
				 WHERE i.target = ? OR i.targetScope IN (SELECT value FROM json_each(?))
				 ORDER BY i.module`,
			)
			.all(module, JSON.stringify(scopes)) as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** The first payable owed module after `after` in module order, or null. */
	owedRebindAfter(after: string | null): string | null {
		const row = this.db
			.prepare("SELECT module FROM rebind_owed WHERE blockedBy IS NULL AND module > ? ORDER BY module LIMIT 1")
			.get(after ?? "") as { module: string } | undefined;
		return row?.module ?? null;
	}

	/** Debts held back by a failed parse, with who failed them and in which process. */
	blockedRebinds(): Array<{ module: string; blockedBy: string; blockedFor: string; blockedIn: string }> {
		return this.db
			.prepare("SELECT module, blockedBy, blockedFor, blockedIn FROM rebind_owed WHERE blockedBy IS NOT NULL")
			.all() as Array<{ module: string; blockedBy: string; blockedFor: string; blockedIn: string }>;
	}

	/** Which of these modules hold a debt their own refusal blocks. */
	refusalBlocked(modules: readonly string[]): string[] {
		const rows = this.db
			.prepare(
				`SELECT module FROM rebind_owed
				 WHERE blockedFor = 'refusal' AND module IN (SELECT value FROM json_each(?)) ORDER BY module`,
			)
			.all(JSON.stringify(modules)) as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Modules with an import that landed on, or reaches through, one of `targets` when written, by target. */
	importersLandedOn(targets: readonly string[]): Array<{ module: string; target: string }> {
		if (targets.length === 0) return [];
		const listed = JSON.stringify(targets);
		return this.db
			.prepare(
				`SELECT DISTINCT module, target FROM imports WHERE target IN (SELECT value FROM json_each(?))
				 UNION SELECT DISTINCT module, surfaceTarget FROM imports WHERE surfaceTarget IN (SELECT value FROM json_each(?))
				 ORDER BY module`,
			)
			.all(listed, listed) as Array<{ module: string; target: string }>;
	}

	/** Modules with an import landing on one of these scopes, by scope. */
	importersOfScopes(keys: readonly string[]): Array<{ module: string; scope: string }> {
		if (keys.length === 0) return [];
		return this.db
			.prepare(
				`SELECT DISTINCT module, targetScope AS scope FROM imports
				 WHERE targetScope IN (SELECT value FROM json_each(?)) ORDER BY module`,
			)
			.all(JSON.stringify(keys)) as Array<{ module: string; scope: string }>;
	}

	/** Import edges that landed on `landing` when written: a module by its path, a scope by its key. */
	importEdgesLandingOn(landing: Landing): StoredImport[] {
		const order = "ORDER BY module, spanStartLine, spanStartChar";
		const rows =
			landing.kind === "module"
				? this.db.prepare(`SELECT * FROM imports WHERE target = ? ${order}`).all(landing.module)
				: this.db.prepare(`SELECT * FROM imports WHERE targetScope = ? ${order}`).all(scopeKey(landing));
		return rows.map(rowToImport);
	}

	/** Modules whose effective exports bind some name to this declaration. */
	modulesExposing(symbolId: string): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT module FROM effective_exports WHERE originSymbolId = ? ORDER BY module")
			.all(symbolId) as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** The scopes listing this declaration as a member. */
	scopesHolding(symbolId: string): ScopeLanding[] {
		const rows = this.db
			.prepare("SELECT DISTINCT scopeKey FROM scope_members WHERE memberId = ? ORDER BY scopeKey")
			.all(symbolId) as Array<{ scopeKey: string }>;
		return rows.map((row) => scopeOfKey(row.scopeKey));
	}

	/** Modules exposing `landing` under some name, as a namespace or a module value. */
	modulesHoldingNamespace(landing: Landing): string[] {
		const rows =
			landing.kind === "module"
				? this.db
						.prepare(
							`SELECT DISTINCT module FROM effective_exports
							 WHERE (json_extract(origin, '$.kind') = 'namespace' AND json_extract(origin, '$.landing.kind') = 'module'
							  AND json_extract(origin, '$.landing.module') = ?)
							 OR (json_extract(origin, '$.kind') = 'moduleValue' AND json_extract(origin, '$.module') = ?)
							 ORDER BY module`,
						)
						.all(landing.module, landing.module)
				: this.db
						.prepare(
							`SELECT DISTINCT module FROM effective_exports
							 WHERE json_extract(origin, '$.kind') = 'namespace' AND json_extract(origin, '$.landing.kind') = ?
							  AND json_extract(origin, '$.landing.providerId') = ? AND json_extract(origin, '$.landing.scopeId') = ?
							 ORDER BY module`,
						)
						.all(landing.kind, landing.providerId, landing.scopeId);
		return (rows as Array<{ module: string }>).map((row) => row.module);
	}

	/** Modules with an unbound reference spelled as one of `names`, by name. */
	modulesWithUnbound(names: readonly string[]): Array<{ module: string; name: string }> {
		if (names.length === 0) return [];
		return this.db
			.prepare(
				// The unary plus keeps the planner on refs_name: unbound rows are many, one name's are few.
				`SELECT DISTINCT module, name FROM refs
				 WHERE name IN (SELECT value FROM json_each(?)) AND +targetId IS NULL ORDER BY module`,
			)
			.all(JSON.stringify(names)) as Array<{ module: string; name: string }>;
	}

	/** Every import edge that states a load and lands on a module, in one read. */
	loadEdges(): Array<{
		module: string;
		target: string;
		span: Range;
		loads: "static" | "deferred";
		elided?: boolean;
		typeOnly: boolean;
	}> {
		const rows = this.db
			.prepare(
				`SELECT module, target, loads, elided, typeOnly, spanStartLine, spanStartChar, spanEndLine, spanEndChar
				 FROM imports WHERE target IS NOT NULL AND loads IS NOT NULL ORDER BY module`,
			)
			.all() as Array<{
			module: string;
			target: string;
			loads: "static" | "deferred";
			elided: number | null;
			typeOnly: number;
			spanStartLine: number;
			spanStartChar: number;
			spanEndLine: number;
			spanEndChar: number;
		}>;
		return rows.map((row) => ({
			module: row.module,
			target: row.target,
			span: {
				start: { line: row.spanStartLine, character: row.spanStartChar },
				end: { line: row.spanEndLine, character: row.spanEndChar },
			},
			loads: row.loads,
			...(row.elided === null ? {} : { elided: row.elided === 1 }),
			typeOnly: row.typeOnly === 1,
		}));
	}

	/** Each module's distinct import specifiers and modes, for asking where each lands. */
	importEdges(): Array<{ module: string; specifier: string; resolutionMode?: ResolutionMode }> {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT module, specifier, json_extract(edge, '$.resolutionMode') AS resolutionMode
				 FROM imports ORDER BY module, specifier`,
			)
			.all() as Array<{ module: string; specifier: string; resolutionMode: ResolutionMode | null }>;
		return rows.map(({ resolutionMode, ...row }) => (resolutionMode === null ? row : { ...row, resolutionMode }));
	}
}
