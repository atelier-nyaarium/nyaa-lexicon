// One module's part of a move: what leaves it, what arrives, and the imports both need.

import path from "node:path";
import {
	coordinatesOf,
	MOVE_EDIT_CONFLICT,
	type MoveBlockedSite,
	type MoveEditsRequest,
	type MoveEditsResponse,
	type MoveImportSite,
	normalizeModulePath,
	planEdits,
	type TextCoordinates,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { claimsExtension, scriptKindOf } from "./file-types.js";
import {
	bindsPlanned,
	boundIdentifiers,
	importForDependency,
	moduleBindings,
	sameModulePath,
} from "./move-dependencies.js";
import {
	append,
	blockedSite,
	contentLineBefore,
	importInsertion,
	type LandingKey,
	lineOf,
	mergedImport,
	mergeIndex,
	mergeKey,
	type PlannedImport,
	type PlannedNamed,
	type Quote,
	renderImport,
	standaloneImports,
	type WorkMeter,
} from "./move-imports.js";
import {
	type ImportSiteNode,
	importSiteNode,
	locateImportSite,
	orphanedImports,
	rewriteImportSites,
} from "./move-sites.js";
import type { ModuleResolver, SpecifierRenderer, SpecifierRenderResult } from "./project.js";

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
	const coordinates = coordinatesOf(source.text);
	const syntaxErrors = parseDiagnostics(source);
	if (syntaxErrors.length > 0) {
		return { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" };
	}

	if (sameModulePath(request.module, request.toModule) && request.exists && declaresName(source, request.name)) {
		return {
			status: "refused",
			reason: "TargetCollision",
			detail: `the target already declares ${request.name}`,
		};
	}

	const blocked: MoveBlockedSite[] = [];
	const edits: TextEdit[] = [];
	const removed = request.role.removal === undefined ? undefined : coordinates.offsetsForRange(request.role.removal);
	const bindings = moduleBindings(source, removed);
	const importSites = source.statements
		.map(importSiteNode)
		.filter((site): site is ImportSiteNode => site !== undefined);
	const quote: Quote = importSites[0]?.literal.getText(source).startsWith("'") === true ? "'" : '"';
	const landings = new Map<string, string>();
	const landingKey: LandingKey = (specifier) => {
		let key = landings.get(specifier);
		if (key === undefined) {
			const landing = resolveModule(request.module, specifier);
			key = landing === undefined ? `\0${specifier}` : landing;
			landings.set(specifier, key);
		}
		return key;
	};
	const renders = new Map<string, SpecifierRenderResult>();
	const render: SpecifierRenderer = (fromModule, targetModule, preferred) => {
		const key = `${fromModule}\0${targetModule}\0${preferred ?? ""}`;
		let rendered = renders.get(key);
		if (rendered === undefined) {
			rendered = renderSpecifier(fromModule, targetModule, preferred);
			renders.set(key, rendered);
		}
		return rendered;
	};

	if (request.role.removal !== undefined) {
		const siblings = removed === undefined ? [] : sharedNames(source, removed, request.name);
		if (removed === undefined) {
			blocked.push(blockedSite(request.role.removal, "ParseError", "the removal range is outside the module"));
		} else if (siblings.length > 0) {
			blocked.push(
				blockedSite(
					request.role.removal,
					"NotImplemented",
					`${request.name} shares its declaration with ${siblings.join(", ")}, and splitting it is not implemented`,
				),
			);
		} else {
			edits.push({ range: request.role.removal, newText: "" }, ...orphanedImports(source, coordinates, removed));
		}
	}

	const siteStatements = new Map<ImportSiteNode, MoveImportSite[]>();
	for (const site of request.importSites) {
		const located = locateImportSite(source, coordinates, site, importSites);
		if (located.blocked !== undefined) blocked.push(located.blocked);
		if (located.statement !== undefined) append(siteStatements, located.statement, site);
	}
	const rewrites = [...siteStatements].map(([statement, sites]) =>
		rewriteImportSites(source, coordinates, statement, sites, request, render, meter),
	);

	for (const site of request.sites) {
		blocked.push(blockedSite(site, "NotImplemented", "the moved symbol occurs outside an import statement"));
	}

	const pendingImports = new Map<string, PlannedImport>();
	const pend = (planned: PlannedImport) => pendingImports.set(renderImport([planned], quote), planned);
	for (const dependency of request.dependencies) {
		const plan = importForDependency(request, dependency, source, checker, bindings, render, landingKey, esm);
		if (plan.blocked !== undefined) blocked.push(plan.blocked);
		if (plan.planned !== undefined) pend(plan.planned);
	}

	const excluded = new Set<ts.Node>([...siteStatements.keys()].map((statement) => statement.node));
	const index = mergeIndex(source, coordinates, edits, landingKey, excluded, meter);
	const joins = (planned: PlannedImport) => {
		if (planned.clause !== "named") return undefined;
		if (meter !== undefined) meter.steps++;
		return index.get(mergeKey(planned.typeOnly, landingKey(planned.specifier)));
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

	const merges = new Map<ts.ImportDeclaration, PlannedNamed[]>();
	const unmerged: PlannedImport[] = [];
	for (const planned of pendingImports.values()) {
		const into = joins(planned);
		if (into === undefined || planned.clause !== "named") unmerged.push(planned);
		else append(merges, into, planned);
	}
	for (const [statement, group] of merges) {
		const merged = mergedImport(source, coordinates, statement, group, quote);
		if (merged === undefined) unmerged.push(...group);
		else edits.push(merged);
	}

	const standalone = standaloneImports(unmerged, quote);
	if (standalone.length > 0) {
		const { offset, lineBreak } = importInsertion(source);
		const insertion = coordinates.positionAt(offset);
		if (insertion === undefined) {
			blocked.push({ reason: "ParseError", detail: "the import insertion point is outside the module" });
		} else {
			edits.push({
				range: { start: insertion, end: insertion },
				newText: `${lineBreak ? "\n" : ""}${standalone.join("\n")}\n`,
			});
		}
	}

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
			edits.push({ range: { start: point, end: point }, newText: separate ? `\n${text}` : text });
		}
	}

	return validateEdits(coordinates, edits, blocked);
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

/** Bound in module scope, exported under that name, or the default export when it is `default`. */
function declaresName(source: ts.SourceFile, name: string): boolean {
	if (moduleBindings(source, undefined).has(name)) return true;
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
function sharedNames(source: ts.SourceFile, removed: { start: number; end: number }, name: string): string[] {
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
function exportedText(text: string, module: string): string {
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

function validateEdits(coordinates: TextCoordinates, edits: TextEdit[], blocked: MoveBlockedSite[]): MoveEditsResponse {
	const plan = planEdits(coordinates, edits);
	for (const { edit, conflict } of plan.conflicts) {
		const named = MOVE_EDIT_CONFLICT[conflict];
		blocked.push(blockedSite(edit.range, named.reason, named.detail));
	}
	// Joined insertions are deliberate here: collecting several for one point is how a move adds
	// more than one import to a file.
	return { status: "ready", edits: plan.edits, blocked };
}

function parseDiagnostics(source: ts.SourceFile): readonly ts.Diagnostic[] {
	return (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}
