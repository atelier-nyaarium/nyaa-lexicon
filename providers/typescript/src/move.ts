// One module's part of a move: what leaves it, what arrives, and the imports both need.

import path from "node:path";
import {
	coordinatesOf,
	MOVE_EDIT_CONFLICT,
	type MoveBlockedSite,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveEditsResponse,
	type MoveImportSite,
	normalizeModulePath,
	type OffsetRange,
	planEdits,
	type Range,
	type TextCoordinates,
	type TextEdit,
	type WorkMeter,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { claimsExtension, scriptKindOf } from "./file-types.js";
import {
	bindsPlanned,
	boundIdentifiers,
	importForDependency,
	type ModuleBinding,
	moduleBindings,
	sameModulePath,
	typeOnlyNames,
} from "./move-dependencies.js";
import {
	append,
	blockedSite,
	contentLineBefore,
	importInsertion,
	joinTarget,
	type LandingKey,
	lineOf,
	mergedImport,
	mergeIndex,
	type PlannedImport,
	type Quote,
	renderImport,
	standaloneImports,
} from "./move-imports.js";
import { settleBlankLines } from "./move-layout.js";
import {
	type ImportSiteNode,
	importSiteNode,
	locateImportSite,
	orphanedImports,
	repointLeavingExports,
	rewriteImportSites,
	type SiteMove,
} from "./move-sites.js";
import {
	type ExtensionStyle,
	type ModuleResolver,
	relativeStyle,
	type SpecifierRenderer,
	type SpecifierRenderResult,
} from "./project.js";

////////////////////////////////
//  Interfaces & Types

/** One module as a move reads it: its imports, its quote, and cached specifier lookups. */
export interface ModuleScope {
	source: ts.SourceFile;
	coordinates: TextCoordinates;
	checker: ts.TypeChecker | undefined;
	/** The module runs as an ECMAScript module. */
	esm: boolean;
	statements: ImportSiteNode[];
	quote: Quote;
	/** How its relative specifiers end, when it writes any. */
	style: ExtensionStyle | undefined;
	landingKey: LandingKey;
	render: SpecifierRenderer;
	meter: WorkMeter | undefined;
}

/** The import work in one module's part. */
export interface ImportWork<S extends MoveImportSite> extends SiteMove<S> {
	fromModule: string;
	importSites: readonly S[];
	/** Uses outside import statements, which block. */
	sites: readonly Range[];
	/** Spans leaving the module, whose names no longer bind. */
	removed: readonly OffsetRange[];
	/** Text landing in the module, one edit per point. */
	landings: readonly TextEdit[];
	dependencies: readonly MoveDependency[];
}

////////////////////////////////
//  Main

export function makeMoveEdits(
	request: MoveEditsRequest,
	source: ts.SourceFile,
	checker: ts.TypeChecker | undefined,
	renderSpecifier: SpecifierRenderer,
	resolveModule: ModuleResolver,
	/** The module runs as an ECMAScript module. */
	esm: boolean,
	meter?: WorkMeter,
): MoveEditsResponse {
	const syntaxErrors = parseDiagnostics(source);
	if (syntaxErrors.length > 0) {
		return { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" };
	}

	const scope = moduleScope(request.module, source, checker, renderSpecifier, resolveModule, esm, meter);
	const { coordinates } = scope;
	const blocked: MoveBlockedSite[] = [];
	const edits: TextEdit[] = [];
	const removed = request.role.removal === undefined ? undefined : coordinates.offsetsForRange(request.role.removal);

	// A reorder: the module keeps the moved name and every import it uses.
	const reorder = sameModulePath(request.fromModule, request.toModule);
	if (
		!reorder &&
		sameModulePath(request.module, request.toModule) &&
		request.exists &&
		targetDeclares(scope, request.name, request.fromModule)
	) {
		return {
			status: "refused",
			reason: "TargetCollision",
			detail: `the target already declares ${request.name}`,
		};
	}

	let repointed: OffsetRange[] = [];
	if (request.role.removal !== undefined) {
		const removal = removalOf(scope, request.role.removal, request.name);
		if ("blocked" in removal) blocked.push(removal.blocked);
		else if (reorder) edits.push({ range: request.role.removal, newText: "" });
		else {
			const exports = repointLeavingExports(
				source,
				coordinates,
				[{ name: request.name, removed: removal.removed }],
				() => scope.render(request.module, request.toModule, undefined, scope.style),
				scope.quote,
			);
			edits.push(
				{ range: request.role.removal, newText: "" },
				...orphanedImports(source, coordinates, [removal.removed]),
				...exports.edits,
			);
			blocked.push(...exports.blocked);
			repointed = exports.spans;
		}
	}

	let landing: TextEdit | undefined;
	if (request.role.insertion !== undefined) {
		const { position, exported } = request.role.insertion;
		const text =
			exported === true ? exportedText(request.role.insertion.text, request.module) : request.role.insertion.text;
		const offset = position === undefined ? source.text.length : coordinates.offsetAt(position);
		const point = offset === undefined ? undefined : coordinates.positionAt(offset);
		if (point === undefined) {
			blocked.push(
				blockedSite(
					position === undefined ? undefined : { start: position, end: position },
					"ParseError",
					"the insertion position is outside the module",
				),
			);
		} else {
			const separate = position === undefined && needsBlankLine(source);
			landing = { range: { start: point, end: point }, newText: separate ? `\n${text}` : text };
		}
	}

	planImports(
		scope,
		{
			module: request.module,
			fromModule: request.fromModule,
			toModule: request.toModule,
			nameOf: () => request.name,
			importSites: request.importSites,
			sites: request.sites,
			removed: removed === undefined ? [] : [removed, ...repointed],
			landings: landing === undefined ? [] : [landing],
			dependencies: request.dependencies,
		},
		edits,
		blocked,
	);
	// After the imports, which may share its point.
	if (landing !== undefined) edits.push(landing);

	return validateEdits(coordinates, settleBlankLines(source.text, coordinates, edits), blocked);
}

////////////////////////////////
//  Module Work

export function moduleScope(
	module: string,
	source: ts.SourceFile,
	checker: ts.TypeChecker | undefined,
	renderSpecifier: SpecifierRenderer,
	resolveModule: ModuleResolver,
	esm: boolean,
	meter: WorkMeter | undefined,
): ModuleScope {
	const statements = source.statements
		.map(importSiteNode)
		.filter((site): site is ImportSiteNode => site !== undefined);
	const quote: Quote = statements[0]?.literal.getText(source).startsWith("'") === true ? "'" : '"';
	const landings = new Map<string, string>();
	const landingKey: LandingKey = (specifier) => {
		let key = landings.get(specifier);
		if (key === undefined) {
			const landing = resolveModule(module, specifier);
			key = landing === undefined ? `\0${specifier}` : landing;
			landings.set(specifier, key);
		}
		return key;
	};
	const renders = new Map<string, SpecifierRenderResult>();
	const render: SpecifierRenderer = (fromModule, targetModule, preferred, style) => {
		const key = `${fromModule}\0${targetModule}\0${preferred ?? ""}\0${style ?? ""}`;
		let rendered = renders.get(key);
		if (rendered === undefined) {
			rendered = renderSpecifier(fromModule, targetModule, preferred, style);
			renders.set(key, rendered);
		}
		return rendered;
	};
	return {
		source,
		coordinates: coordinatesOf(source.text),
		checker,
		esm,
		statements,
		quote,
		style: relativeStyle(statements.map((statement) => statement.literal.text)),
		landingKey,
		render,
		meter,
	};
}

/** The target binds `name`. */
export function targetDeclares(scope: ModuleScope, name: string, fromModule: string): boolean {
	// The target's own import of the moved symbol goes with the move, so it names nothing that collides.
	return declaresName(
		scope.source,
		name,
		(binding) =>
			binding.specifier !== undefined &&
			(binding.imported ?? name) === name &&
			sameModulePath(scope.landingKey(binding.specifier), fromModule),
	);
}

/** A declaration's span, or why it cannot leave alone. */
export function removalOf(
	scope: ModuleScope,
	removal: Range,
	name: string,
): { removed: OffsetRange } | { blocked: MoveBlockedSite } {
	const removed = scope.coordinates.offsetsForRange(removal);
	if (removed === undefined) {
		return { blocked: blockedSite(removal, "ParseError", "the removal range is outside the module") };
	}
	const siblings = sharedNames(scope.source, removed, name);
	if (siblings.length > 0) {
		return {
			blocked: blockedSite(
				removal,
				"NotImplemented",
				`${name} shares its declaration with ${siblings.join(", ")}, and splitting it is not implemented`,
			),
		};
	}
	return { removed };
}

/**
 * Repoints each import statement naming a moved symbol once, blocks other uses, and imports every
 * dependency: joined into an import of the same module where one fits, else after the imports.
 */
export function planImports<S extends MoveImportSite>(
	scope: ModuleScope,
	work: ImportWork<S>,
	edits: TextEdit[],
	blocked: MoveBlockedSite[],
): void {
	const { source, coordinates, quote, landingKey, render, meter } = scope;
	const bindings = moduleBindings(source, work.removed);
	const typeOnly = typeOnlyNames(
		work.module,
		source,
		work.removed,
		work.landings.map((landing) => landing.newText),
		new Set(work.dependencies.map((dependency) => dependency.name)),
	);
	// The moved body's own relative imports, where the module writes none.
	const style =
		scope.style ??
		relativeStyle(
			work.dependencies.flatMap(({ origin }) =>
				origin.kind === "workspaceModule" && origin.via !== undefined ? [origin.via.specifier] : [],
			),
		);
	const siteStatements = new Map<ImportSiteNode, S[]>();
	for (const site of work.importSites) {
		const located = locateImportSite(source, coordinates, site, scope.statements);
		if (located.blocked !== undefined) blocked.push(located.blocked);
		if (located.statement !== undefined) append(siteStatements, located.statement, site);
	}
	const rewrites = [...siteStatements].map(([statement, sites]) =>
		rewriteImportSites(source, coordinates, statement, sites, work, render, meter),
	);

	for (const site of work.sites) {
		blocked.push(blockedSite(site, "NotImplemented", "the moved symbol occurs outside an import statement"));
	}

	const pendingImports = new Map<string, PlannedImport>();
	const pend = (planned: PlannedImport) => pendingImports.set(renderImport([planned], quote), planned);
	for (const dependency of work.dependencies) {
		const plan = importForDependency(work, dependency, source, scope.checker, bindings, {
			render: (fromModule, targetModule, preferred) => render(fromModule, targetModule, preferred, style),
			landingKey,
			esm: scope.esm,
			typeOnly: typeOnly.has(dependency.name),
		});
		if (plan.blocked !== undefined) blocked.push(plan.blocked);
		if (plan.planned !== undefined) pend(plan.planned);
	}

	const excluded = new Set<ts.Node>([...siteStatements.keys()].map((statement) => statement.node));
	const index = mergeIndex(source, coordinates, edits, landingKey, excluded, meter);
	const joins = (planned: PlannedImport) => {
		if (meter !== undefined) meter.steps++;
		return joinTarget(index, planned, landingKey(planned.specifier));
	};
	for (const rewrite of rewrites) {
		blocked.push(...rewrite.blocked);
		// A name the module already imports from its new home needs no second import.
		const fresh = rewrite.planned.filter(
			(planned) =>
				!(bindings.get(planned.localName) ?? []).some((binding) => bindsPlanned(binding, planned, landingKey)),
		);
		const whole = rewrite.whole;
		if (whole === undefined) {
			if (rewrite.edit !== undefined) edits.push(rewrite.edit);
			for (const planned of fresh) pend(planned);
		} else if (whole.removal !== undefined && fresh.every((planned) => joins(planned) !== undefined)) {
			edits.push(whole.removal);
			for (const planned of fresh) pend(planned);
		} else {
			edits.push(whole.rewrite);
		}
	}

	placeImports(scope, joins, pendingImports.values(), work.landings, edits, blocked);
}

/**
 * Joins each planned import into an import of the same module where one fits, else adds them after
 * the imports; text landing at that point follows them a blank line apart.
 */
export function placeImports(
	scope: ModuleScope,
	joins: (planned: PlannedImport) => ts.ImportDeclaration | undefined,
	pending: Iterable<PlannedImport>,
	landings: readonly TextEdit[],
	edits: TextEdit[],
	blocked: MoveBlockedSite[],
): void {
	const { source, coordinates, quote } = scope;
	const merges = new Map<ts.ImportDeclaration, PlannedImport[]>();
	const unmerged: PlannedImport[] = [];
	for (const planned of pending) {
		const into = joins(planned);
		// A statement takes one default.
		const taken =
			into !== undefined &&
			planned.clause === "default" &&
			(merges.get(into) ?? []).some((other) => other.clause === "default");
		if (into === undefined || taken) unmerged.push(planned);
		else append(merges, into, planned);
	}
	for (const [statement, group] of merges) {
		const merged = mergedImport(source, coordinates, statement, group, quote);
		if (merged === undefined) unmerged.push(...group);
		else edits.push(...merged);
	}

	const standalone = standaloneImports(unmerged, quote);
	if (standalone.length > 0) {
		const { offset, lineBreak, blankAfter } = importInsertion(source);
		const insertion = coordinates.positionAt(offset);
		// Text landing here follows the imports, a blank line apart.
		const landing = landings.find((edit) => coordinates.offsetAt(edit.range.start) === offset);
		const blank = landing === undefined ? blankAfter : !/^\r?\n/.test(landing.newText);
		if (insertion === undefined) {
			blocked.push({ reason: "ParseError", detail: "the import insertion point is outside the module" });
		} else {
			edits.push({
				range: { start: insertion, end: insertion },
				newText: `${lineBreak ? "\n" : ""}${standalone.join("\n")}\n${blank ? "\n" : ""}`,
			});
		}
	}
}

////////////////////////////////
//  Target Checks

export function isValidTargetModule(workspaceRoot: string, module: string): boolean {
	if (!claimsExtension(module)) return false;
	try {
		const normalized = normalizeModulePath(module);
		if (normalized !== module) return false;
		const absolute = path.resolve(workspaceRoot, normalized);
		return normalized === module && path.relative(path.resolve(workspaceRoot), absolute) === normalized;
	} catch {
		return false;
	}
}

/** Bound in module scope, but for bindings `exempt` names, exported under that name, or the default export when it is `default`. */
function declaresName(source: ts.SourceFile, name: string, exempt: (binding: ModuleBinding) => boolean): boolean {
	if ((moduleBindings(source, []).get(name) ?? []).some((binding) => !exempt(binding))) return true;
	return source.statements.some((statement) => {
		if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name))
			return statement.name.text === name;
		if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
			if (ts.isNamespaceExport(statement.exportClause)) return statement.exportClause.name.text === name;
			if (ts.isNamedExports(statement.exportClause)) {
				return statement.exportClause.elements.some((element) => element.name.text === name);
			}
		}
		return (
			name === "default" &&
			(ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
			hasDefaultModifier(statement)
		);
	});
}

/** The other names a removed variable statement binds, which removing it would take along. */
function sharedNames(source: ts.SourceFile, removed: OffsetRange, name: string): string[] {
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if (statement.getStart(source) < removed.start || statement.getEnd() > removed.end) continue;
		const names = statement.declarationList.declarations.flatMap((declaration) =>
			boundIdentifiers(declaration.name),
		);
		if (names.includes(name)) return names.filter((other) => other !== name);
	}
	return [];
}

function hasDefaultModifier(node: ts.ClassDeclaration | ts.FunctionDeclaration): boolean {
	return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

////////////////////////////////
//  Exporting

type Exportable =
	| ts.VariableStatement
	| ts.FunctionDeclaration
	| ts.ClassDeclaration
	| ts.InterfaceDeclaration
	| ts.TypeAliasDeclaration
	| ts.EnumDeclaration
	| ts.ModuleDeclaration;

function isExportable(statement: ts.Statement): statement is Exportable {
	return (
		ts.isVariableStatement(statement) ||
		ts.isFunctionDeclaration(statement) ||
		ts.isClassDeclaration(statement) ||
		ts.isInterfaceDeclaration(statement) ||
		ts.isTypeAliasDeclaration(statement) ||
		ts.isEnumDeclaration(statement) ||
		(ts.isModuleDeclaration(statement) &&
			ts.isIdentifier(statement.name) &&
			(statement.flags & ts.NodeFlags.GlobalAugmentation) === 0)
	);
}

/** `text` with `export` on each declaration lacking it, after its decorators. */
export function exportedText(text: string, module: string): string {
	const inserted = ts.createSourceFile(module, text, ts.ScriptTarget.ESNext, true, scriptKindOf(module));
	const points = inserted.statements.flatMap((statement) => {
		if (!isExportable(statement)) return [];
		const modifiers = ts.getModifiers(statement) ?? [];
		if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
		const first =
			modifiers[0] ??
			statement
				.getChildren(inserted)
				.find((child) => child.kind !== ts.SyntaxKind.SyntaxList && !ts.isJSDoc(child));
		return first === undefined ? [] : [first.getStart(inserted)];
	});
	let exported = text;
	for (const point of points.reverse()) exported = `${exported.slice(0, point)}export ${exported.slice(point)}`;
	return exported;
}

////////////////////////////////
//  Ranges & Validation

/** True when the target's last token or comment has no blank line after it. */
function needsBlankLine(source: ts.SourceFile): boolean {
	const last = contentLineBefore(source.endOfFileToken, source);
	return last !== undefined && lineOf(source, source.text.length) - last < 2;
}

export function validateEdits(
	coordinates: TextCoordinates,
	edits: TextEdit[],
	blocked: MoveBlockedSite[],
): MoveEditsResponse {
	const plan = planEdits(coordinates, edits);
	for (const { edit, conflict } of plan.conflicts) {
		const named = MOVE_EDIT_CONFLICT[conflict];
		blocked.push(blockedSite(edit.range, named.reason, named.detail));
	}
	// Joined insertions are deliberate here: collecting several for one point is how a move adds
	// more than one import to a file.
	return { status: "ready", edits: plan.edits, blocked };
}

export function parseDiagnostics(source: ts.SourceFile): readonly ts.Diagnostic[] {
	return (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}
