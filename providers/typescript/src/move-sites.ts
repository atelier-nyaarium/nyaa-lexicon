// Repointing the import statements that name a moved symbol.

import type {
	MoveBlockedReason,
	MoveBlockedSite,
	MoveImportSite,
	OffsetRange,
	TextCoordinates,
	TextEdit,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { moduleBindings, sameModulePath } from "./move-dependencies.js";
import { append, blockedSite, type PlannedImport, type Quote, quoted, type WorkMeter } from "./move-imports.js";
import type { SpecifierRenderer, SpecifierRenderResult } from "./project.js";

////////////////////////////////
//  Interfaces & Types

export interface ImportSiteNode {
	node: ts.ImportDeclaration | ts.ExportDeclaration | ts.ImportEqualsDeclaration;
	literal: ts.StringLiteral;
}

/** One name an import or re-export statement binds. */
type StatementBinding =
	| { form: "default"; node: ts.Identifier }
	| { form: "namespace"; node: ts.NamespaceImport }
	| { form: "named"; node: ts.ImportSpecifier | ts.ExportSpecifier };

/** Where the moved names go, and the name each site imports. */
export interface SiteMove<S extends MoveImportSite = MoveImportSite> {
	/** The module holding the sites. */
	module: string;
	toModule: string;
	nameOf(site: S): string;
}

/** What repointing the moved names of one statement does to it. */
export interface SiteRewrite {
	blocked: MoveBlockedSite[];
	/** The statement without its moved names, when others stay. */
	edit?: TextEdit;
	/** The moved names, imported from their new home. */
	planned: PlannedImport[];
	/** Every name moves: repoint the statement, or drop it once each name joins another import. */
	whole?: { rewrite: TextEdit; removal?: TextEdit };
}

/** A declaration leaving its module: the name it binds and its span. */
export interface Leaving {
	name: string;
	removed: OffsetRange;
}

/** What repointing a module's own exports of the names that leave it does. */
export interface LocalExports {
	edits: TextEdit[];
	blocked: MoveBlockedSite[];
	/** The repointed names, which no longer read the module's binding. */
	spans: OffsetRange[];
}

////////////////////////////////
//  Site Rewriting

/** The import statement a site names, or why it cannot be rewritten. */
export function locateImportSite(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	site: MoveImportSite,
	statements: ImportSiteNode[],
): { statement?: ImportSiteNode; blocked?: MoveBlockedSite } {
	// These kinds bind every export of the source, so repointing them repoints symbols that did not move.
	if (site.importKind === "namespace" || site.importKind === "wildcard" || site.importKind === "sideEffect") {
		return {
			blocked: blockedSite(
				site.range,
				"NotImplemented",
				`a ${site.importKind} edge binds the whole module, and splitting it is not implemented`,
			),
		};
	}

	const offsets = coordinates.offsetsForRange(site.range);
	if (offsets === undefined)
		return { blocked: blockedSite(site.range, "ParseError", "the import range is outside the module") };

	const statement = statementAt(statements, offsets.start, source);
	if (statement === undefined || statement.literal.text !== site.specifier) {
		return {
			blocked: blockedSite(site.range, "ParseError", "the range does not name the requested import"),
		};
	}
	if (ts.isImportEqualsDeclaration(statement.node)) {
		return {
			blocked: blockedSite(
				site.range,
				"NotImplemented",
				"`import x = require()` binds the whole module, and splitting it is not implemented",
			),
		};
	}
	return { statement };
}

/**
 * Moves the statement's moved names to their new home. Names that stay keep the statement; the
 * moved ones leave it in their own form, and a re-export of them follows it.
 */
export function rewriteImportSites<S extends MoveImportSite>(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	statement: ImportSiteNode,
	sites: readonly S[],
	move: SiteMove<S>,
	renderSpecifier: SpecifierRenderer,
	meter?: WorkMeter,
): SiteRewrite {
	const node = statement.node as ts.ImportDeclaration | ts.ExportDeclaration;
	// The target declares the moved names itself, so its import of them goes rather than pointing home.
	const home = sameModulePath(move.module, move.toModule);
	if (home && ts.isExportDeclaration(node)) {
		return {
			blocked: sites.map((site) =>
				blockedSite(site.range, "NotImplemented", "the target re-exports the moved symbol from its old home"),
			),
			planned: [],
		};
	}
	const rendered = home ? { specifier: "" } : renderSpecifier(move.module, move.toModule, statement.literal.text);
	if ("reason" in rendered) {
		return { blocked: sites.map((site) => blockedSite(site.range, rendered.reason, rendered.detail)), planned: [] };
	}
	if (rendered.specifier === statement.literal.text) return { blocked: [], planned: [] };

	const bound = statementBindings(node);
	const named = bindingFinder(source, bound, meter);
	const moved = new Set<ts.Node>();
	for (const site of sites) {
		const match = named(site, coordinates.offsetsForRange(site.range)?.start ?? -1, move.nameOf(site));
		if (match === undefined) {
			return {
				blocked: [blockedSite(site.range, "ParseError", "the range does not name the requested import")],
				planned: [],
			};
		}
		moved.add(match.node);
	}

	const quote = statement.literal.getText(source).startsWith("'") ? "'" : '"';
	const specifier = quoted(rendered.specifier, quote);
	const planned =
		!home && ts.isImportDeclaration(node)
			? bound.flatMap((binding) => (moved.has(binding.node) ? plannedFor(node, binding, rendered.specifier) : []))
			: [];
	const start = node.getStart(source);
	const range = coordinates.rangeAt(start, node.getEnd());
	const literalStart = statement.literal.getStart(source) - start;
	if (range === undefined || literalStart < 0) {
		return {
			blocked: sites.map((site) =>
				blockedSite(site.range, "ParseError", "the import range does not contain its specifier"),
			),
			planned: [],
		};
	}
	const raw = source.text.slice(start, node.getEnd());

	if (bound.every((binding) => moved.has(binding.node))) {
		if (home) {
			const removal = statementRemoval(source, coordinates, node);
			return removal === undefined
				? {
						blocked: sites.map((site) =>
							blockedSite(site.range, "ParseError", "the import is outside the module"),
						),
						planned: [],
					}
				: { blocked: [], planned: [], edit: removal };
		}
		const literalEnd = statement.literal.getEnd() - start;
		const rewrite = { range, newText: `${raw.slice(0, literalStart)}${specifier}${raw.slice(literalEnd)}` };
		const removal = ts.isImportDeclaration(node) ? statementRemoval(source, coordinates, node) : undefined;
		return { blocked: [], planned, whole: removal === undefined ? { rewrite } : { rewrite, removal } };
	}

	let kept = keptText(source, node, moved, start);
	if (ts.isExportDeclaration(node)) {
		const names = bound.flatMap((binding) => (moved.has(binding.node) ? [binding.node.getText(source)] : []));
		kept += `\nexport ${node.isTypeOnly ? "type " : ""}{ ${names.join(", ")} } from ${specifier};`;
	}
	return { blocked: [], planned, edit: { range, newText: kept } };
}

////////////////////////////////
//  Orphaned Imports

/**
 * Drops the import bindings only the removed text named, and a statement left with none. A name
 * written anywhere else keeps its binding, so an import unused before the move stays.
 */
export function orphanedImports(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	removed: readonly OffsetRange[],
): TextEdit[] {
	const inside = new Set<string>();
	const outside = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) return;
		if (ts.isIdentifier(node)) {
			const at = node.getStart(source);
			(removed.some((span) => span.start <= at && at < span.end) ? inside : outside).add(node.text);
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(source, visit);

	const edits: TextEdit[] = [];
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const bound = statementBindings(statement);
		const orphaned = new Set<ts.Node>();
		for (const binding of bound) {
			const name = localNameOf(binding);
			if (inside.has(name) && !outside.has(name)) orphaned.add(binding.node);
		}
		if (orphaned.size === 0) continue;
		if (orphaned.size === bound.length) {
			const removal = statementRemoval(source, coordinates, statement);
			if (removal !== undefined) edits.push(removal);
			continue;
		}
		const start = statement.getStart(source);
		const range = coordinates.rangeAt(start, statement.getEnd());
		if (range === undefined) continue;
		edits.push({ range, newText: keptText(source, statement, orphaned, start) });
	}
	return edits;
}

////////////////////////////////
//  Local Exports

/**
 * Repoints each `export { name }` outside the leaving spans to the name's new home, one edit per
 * clause, splitting the leaving names out of a clause that keeps others. Blocks a name its new home
 * may not export, or that still binds here.
 */
export function repointLeavingExports(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	leaving: readonly Leaving[],
	render: () => SpecifierRenderResult,
	quote: Quote,
): LocalExports {
	const result: LocalExports = { edits: [], blocked: [], spans: [] };
	const names = new Set(leaving.map((declaration) => declaration.name));
	const declared = new Map<string, ts.Statement[]>();
	const clauses: { node: ts.ExportDeclaration; clause: ts.NamedExports; moved: ts.ExportSpecifier[] }[] = [];
	for (const statement of source.statements) {
		const start = statement.getStart(source);
		const within = leaving.filter(({ removed }) => removed.start <= start && statement.getEnd() <= removed.end);
		if (within.length > 0) {
			for (const { name } of within) append(declared, name, statement);
			continue;
		}
		if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined) continue;
		const clause = statement.exportClause;
		if (clause === undefined || !ts.isNamedExports(clause)) continue;
		const moved = clause.elements.filter((element) => names.has(exportedLocal(element)));
		if (moved.length > 0) clauses.push({ node: statement, clause, moved });
	}
	if (clauses.length === 0) return result;

	const refusals = new Map<string, { reason: MoveBlockedReason; detail: string }>();
	const spans = leaving.map((declaration) => declaration.removed);
	const bound = moduleBindings(source, spans);
	const exported = new Set(clauses.flatMap(({ moved }) => moved.map(exportedLocal)));
	for (const name of exported) {
		// Only the declaration's own `export` lands with it.
		const statements = declared.get(name) ?? [];
		if (statements.length === 0 || !statements.every(exportsByName)) {
			const detail = `the declaration of ${name} does not export it by name, so its new home may not`;
			refusals.set(name, { reason: "NotImplemented", detail });
		} else if (bound.has(name)) {
			const detail = `${name} also names a declaration that stays, and splitting its export is not implemented`;
			refusals.set(name, { reason: "NotImplemented", detail });
		}
	}
	let from = "";
	if (refusals.size < exported.size) {
		const rendered = render();
		if ("reason" in rendered) {
			for (const name of exported) if (!refusals.has(name)) refusals.set(name, rendered);
		} else from = quoted(rendered.specifier, quote);
	}

	const block = (element: ts.ExportSpecifier, reason: MoveBlockedReason, detail: string) => {
		const range = coordinates.rangeAt(element.getStart(source), element.getEnd());
		result.blocked.push(blockedSite(range, reason, detail));
	};
	const typed = (element: ts.ExportSpecifier) =>
		(declared.get(exportedLocal(element)) ?? []).every(
			(statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement),
		);
	for (const { node, clause, moved } of clauses) {
		const moving = moved.filter((element) => {
			const refusal = refusals.get(exportedLocal(element));
			if (refusal !== undefined) block(element, refusal.reason, refusal.detail);
			return refusal === undefined;
		});
		if (moving.length === 0) continue;
		const start = clause.getStart(source);
		const range = coordinates.rangeAt(start, node.getEnd());
		if (range === undefined) {
			for (const element of moving) block(element, "ParseError", "the export is outside the module");
			continue;
		}
		// A re-exported type needs `type` under isolatedModules.
		const marked = !node.isTypeOnly && moving.every(typed);
		const typeOnly = node.isTypeOnly || marked;
		const elements = moving.map((element) => {
			if (typeOnly) return bareExport(element, source);
			return `${typed(element) && !element.isTypeOnly ? "type " : ""}${element.getText(source)}`;
		});
		const repointed = `{ ${elements.join(", ")} } from ${from};`;
		const newText =
			moving.length === clause.elements.length
				? `${marked ? "type " : ""}${repointed}`
				: `${keptText(source, node, new Set(moving), start)}\nexport ${typeOnly ? "type " : ""}${repointed}`;
		result.edits.push({ range, newText });
		for (const element of moving) result.spans.push({ start: element.getStart(source), end: element.getEnd() });
	}
	return result;
}

/** The module binding an export specifier reads. */
function exportedLocal(element: ts.ExportSpecifier): string {
	return (element.propertyName ?? element.name).text;
}

/** Exported under a name, not as the default. */
function exportsByName(statement: ts.Statement): boolean {
	const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
	return (
		modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
		!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
	);
}

/** The element without an inline `type`. */
function bareExport(element: ts.ExportSpecifier, source: ts.SourceFile): string {
	const local = element.propertyName === undefined ? "" : `${element.propertyName.getText(source)} as `;
	return `${local}${element.name.getText(source)}`;
}

function localNameOf(binding: StatementBinding): string {
	if (binding.form === "default") return binding.node.text;
	return binding.node.name.text;
}

function statementBindings(node: ts.ImportDeclaration | ts.ExportDeclaration): StatementBinding[] {
	const bound: StatementBinding[] = [];
	if (ts.isExportDeclaration(node)) {
		if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
			for (const element of node.exportClause.elements) bound.push({ form: "named", node: element });
		}
		return bound;
	}
	const clause = node.importClause;
	if (clause?.name !== undefined) bound.push({ form: "default", node: clause.name });
	const named = clause?.namedBindings;
	if (named !== undefined && ts.isNamespaceImport(named)) bound.push({ form: "namespace", node: named });
	if (named !== undefined && ts.isNamedImports(named)) {
		for (const element of named.elements) bound.push({ form: "named", node: element });
	}
	return bound;
}

/** The binding a site names: the one at its position, else the first by name, indexed once. */
function bindingFinder(
	source: ts.SourceFile,
	bound: readonly StatementBinding[],
	meter?: WorkMeter,
): (site: MoveImportSite, at: number, name: string) => StatementBinding | undefined {
	const byName = new Map<string, StatementBinding[]>();
	for (const binding of bound) {
		if (binding.form === "default") append(byName, `default\0${binding.node.text}`, binding);
		if (binding.form !== "named") continue;
		const imported = (binding.node.propertyName ?? binding.node.name).text;
		append(byName, `named\0${imported}`, binding);
		append(byName, `named\0${imported}\0${binding.node.name.text}`, binding);
	}
	return (site, at, name) => {
		let low = 0;
		let high = bound.length - 1;
		while (low <= high) {
			if (meter !== undefined) meter.steps++;
			const middle = (low + high) >> 1;
			const binding = bound[middle] as StatementBinding;
			if (at < binding.node.getStart(source)) high = middle - 1;
			else if (at >= binding.node.getEnd()) low = middle + 1;
			else if (namesSite(binding, site, name)) return binding;
			else break;
		}
		const imported = site.importedName ?? name;
		const key =
			site.importKind === "default"
				? `default\0${site.localName ?? name}`
				: site.localName === undefined
					? `named\0${imported}`
					: `named\0${imported}\0${site.localName}`;
		if (meter !== undefined) meter.steps++;
		return byName.get(key)?.[0];
	};
}

function namesSite(binding: StatementBinding, site: MoveImportSite, name: string): boolean {
	if (binding.form === "namespace") return false;
	if (binding.form === "default")
		return site.importKind === "default" && binding.node.text === (site.localName ?? name);
	const element = binding.node;
	const imported = (element.propertyName ?? element.name).text;
	return (
		imported === (site.importedName ?? name) &&
		(site.localName === undefined || element.name.text === site.localName)
	);
}

function plannedFor(node: ts.ImportDeclaration, binding: StatementBinding, specifier: string): PlannedImport[] {
	const typeOnly = node.importClause?.isTypeOnly === true;
	if (binding.form === "default") return [{ clause: "default", typeOnly, specifier, localName: binding.node.text }];
	if (binding.form === "namespace" || !ts.isImportSpecifier(binding.node)) return [];
	const element = binding.node;
	return [
		{
			clause: "named",
			typeOnly: typeOnly || element.isTypeOnly,
			specifier,
			importedName: (element.propertyName ?? element.name).text,
			localName: element.name.text,
		},
	];
}

/**
 * Moved names with the separators that go with them; some name always stays. A comment before a
 * name's separator is that name's, and one after it belongs to the next name.
 */
function removedSpans(
	source: ts.SourceFile,
	node: ts.ImportDeclaration | ts.ExportDeclaration,
	moved: ReadonlySet<ts.Node>,
): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
	const list = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause;
	if (clause?.name !== undefined && moved.has(clause.name) && list !== undefined) {
		spans.push({ start: clause.name.getStart(source), end: afterSeparator(source, clause.name.getEnd()) });
	}
	if (list === undefined || ts.isNamespaceImport(list) || ts.isNamespaceExport(list)) return spans;
	const elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[] = list.elements;
	const lastKept = elements.findLastIndex((element) => !moved.has(element));
	if (lastKept === -1) {
		// Only the default stays.
		if (clause?.name !== undefined && elements.length > 0) {
			spans.push({ start: separatorAt(source, clause.name.getEnd()), end: list.getEnd() });
		}
		return spans;
	}
	// Each run of moved names before a kept one goes with the separator after it.
	let run: number | undefined;
	for (let position = 0; position < lastKept; position++) {
		const element = elements[position] as ts.Node;
		if (!moved.has(element)) continue;
		run ??= element.getStart(source);
		if (!moved.has(elements[position + 1] as ts.Node)) {
			spans.push({ start: run, end: afterSeparator(source, element.getEnd()) });
			run = undefined;
		}
	}
	const last = elements.at(-1);
	if (last !== undefined && lastKept < elements.length - 1) {
		spans.push({ start: separatorAt(source, (elements[lastKept] as ts.Node).getEnd()), end: last.getEnd() });
	}
	return spans;
}

/** `node`'s text from `start`, without the moved names. */
function keptText(
	source: ts.SourceFile,
	node: ts.ImportDeclaration | ts.ExportDeclaration,
	moved: ReadonlySet<ts.Node>,
	start: number,
): string {
	const raw = source.text.slice(start, node.getEnd());
	let kept = "";
	let cursor = 0;
	for (const span of removedSpans(source, node, moved)) {
		kept += raw.slice(cursor, span.start - start);
		cursor = span.end - start;
	}
	return kept + raw.slice(cursor);
}

/** Where the comma after `offset` starts, past whitespace and comments. */
function separatorAt(source: ts.SourceFile, offset: number): number {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, source.languageVariant, source.text);
	scanner.resetTokenState(offset);
	return scanner.scan() === ts.SyntaxKind.CommaToken ? scanner.getTokenStart() : offset;
}

/** Past the comma after `offset` and the whitespace after that. */
function afterSeparator(source: ts.SourceFile, offset: number): number {
	const separator = separatorAt(source, offset);
	if (separator === offset && source.text[offset] !== ",") return offset;
	let end = separator + 1;
	while (end < source.text.length && /\s/.test(source.text[end] as string)) end++;
	return end;
}

/** The statement and its line break. */
function statementRemoval(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	node: ts.Statement,
): TextEdit | undefined {
	let end = node.getEnd();
	if (source.text.startsWith("\r\n", end)) end += 2;
	else if (source.text[end] === "\n") end += 1;
	const range = coordinates.rangeAt(node.getStart(source), end);
	return range === undefined ? undefined : { range, newText: "" };
}

/** The import statement holding `offset`; statements are in source order. */
function statementAt(statements: readonly ImportSiteNode[], offset: number, source: ts.SourceFile) {
	let low = 0;
	let high = statements.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const candidate = statements[middle] as ImportSiteNode;
		if (offset < candidate.node.getStart(source)) high = middle - 1;
		else if (offset >= candidate.node.getEnd()) low = middle + 1;
		else return candidate;
	}
	return undefined;
}

export function importSiteNode(statement: ts.Statement): ImportSiteNode | undefined {
	if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
		return { node: statement, literal: statement.moduleSpecifier };
	}
	const moduleSpecifier = ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
	if (ts.isExportDeclaration(statement) && moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) {
		return { node: statement, literal: moduleSpecifier };
	}
	if (ts.isImportEqualsDeclaration(statement)) {
		const reference = statement.moduleReference;
		if (
			ts.isExternalModuleReference(reference) &&
			reference.expression !== undefined &&
			ts.isStringLiteral(reference.expression)
		) {
			return { node: statement, literal: reference.expression };
		}
	}
	return undefined;
}
