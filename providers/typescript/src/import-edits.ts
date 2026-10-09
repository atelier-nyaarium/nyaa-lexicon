// One import added to a module's text, in the form the declaring module exports the name: joined into
// an import of that module where one fits, else after the imports, as a move places its imports.

import {
	type ImportEditsRequest,
	type ImportEditsResponse,
	type ImportRefusal,
	type MoveBlockedReason,
	type MoveBlockedSite,
	planEdits,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { scriptKindOf } from "./file-types.js";
import { moduleScope, parseDiagnostics, placeImports } from "./move.js";
import { bindsPlanned, moduleBindings, typeOnlyNames } from "./move-dependencies.js";
import { joinTarget, mergeIndex, type PlannedImport, syntaxOf } from "./move-imports.js";
import type { ModuleResolver, SpecifierRenderer } from "./project.js";

////////////////////////////////
//  Interfaces & Types

/** How the declaring module exports a top-level name, and whether it carries a runtime value. */
export type ExportedAs = ({ clause: "named"; importedName: string } | { clause: "default" }) & { value: boolean };

type Refused = { reason: ImportRefusal; detail: string };

////////////////////////////////
//  Functions & Helpers

/** The refusal for a blocked placement; reasons an import can meet keep their name. */
function refusalOf(reason: MoveBlockedReason): ImportRefusal {
	return reason === "ParseError" ||
		reason === "NoImportPath" ||
		reason === "AmbiguousImportPath" ||
		reason === "TargetCollision"
		? reason
		: "NotImplemented";
}

function refused(reason: ImportRefusal, detail: string): ImportEditsResponse {
	return { status: "refused", reason, detail };
}

/**
 * The export binding `source`'s top-level `name`: under its own name first, then as the default,
 * then under any other name. `resolve` follows aliases to the declaration.
 */
export function exportedAs(
	checker: ts.TypeChecker,
	source: ts.SourceFile,
	name: string,
	resolve: (symbol: ts.Symbol) => ts.Symbol,
): ExportedAs | Refused {
	const module = checker.getSymbolAtLocation(source);
	if (module === undefined) return { reason: "NotExported", detail: `${source.fileName} is not a module` };
	const declares = (symbol: ts.Symbol) =>
		(resolve(symbol).declarations ?? []).some((declaration) => {
			const named = ts.getNameOfDeclaration(declaration);
			return (
				declaration.getSourceFile() === source &&
				named !== undefined &&
				ts.isIdentifier(named) &&
				named.text === name
			);
		});
	const exports = checker.getExportsOfModule(module).filter(declares);
	const chosen =
		exports.find((symbol) => symbol.name === name) ??
		exports.find((symbol) => symbol.name === "default") ??
		exports[0];
	if (chosen === undefined) return { reason: "NotExported", detail: `the module does not export ${name}` };
	const value = (resolve(chosen).flags & ts.SymbolFlags.Value) !== 0;
	return chosen.name === "default"
		? { clause: "default", value }
		: { clause: "named", importedName: chosen.name, value };
}

////////////////////////////////
//  Main

export function makeImportEdits(
	request: ImportEditsRequest,
	source: ts.SourceFile,
	checker: ts.TypeChecker | undefined,
	exported: ExportedAs,
	renderSpecifier: SpecifierRenderer,
	resolveModule: ModuleResolver,
	/** The module runs as an ECMAScript module. */
	esm: boolean,
): ImportEditsResponse {
	if (parseDiagnostics(source).length > 0) return refused("ParseError", "the module contains syntax errors");
	const kind = scriptKindOf(request.module);
	const script = kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX;
	if (script && !esm && !source.statements.some(ts.isImportDeclaration)) {
		return refused("NotImplemented", "a CommonJS script binds through require, which is not planned");
	}

	const scope = moduleScope(request.module, source, checker, renderSpecifier, resolveModule, esm, undefined);
	const rendered = scope.render(request.module, request.fromModule, undefined, scope.style);
	if ("reason" in rendered) return refused(rendered.reason, rendered.detail);
	const localName = request.name;
	const typeOnly = typeOnlyNames(request.module, source, [], [], new Set([localName])).has(localName);
	if (!typeOnly && !exported.value) return refused("NotExported", `${localName} is exported only as a type`);
	const planned: PlannedImport =
		exported.clause === "default"
			? { clause: "default", typeOnly, specifier: rendered.specifier, localName }
			: {
					clause: "named",
					typeOnly,
					specifier: rendered.specifier,
					importedName: exported.importedName,
					localName,
				};

	const existing = moduleBindings(source, []).get(localName);
	if (existing !== undefined) {
		if (existing.every((binding) => bindsPlanned(binding, planned, scope.landingKey))) return { status: "present" };
		return refused("TargetCollision", `the module already binds ${localName} to something else`);
	}

	const edits: TextEdit[] = [];
	const blocked: MoveBlockedSite[] = [];
	const index = mergeIndex(source, scope.coordinates, edits, scope.landingKey, new Set());
	const joins = (each: PlannedImport) =>
		joinTarget(index, each, scope.landingKey(each.specifier, syntaxOf(each.clause)));
	placeImports(scope, joins, [planned], [], edits, blocked);
	const [first] = blocked;
	if (first !== undefined) return refused(refusalOf(first.reason), first.detail ?? first.reason);
	const plan = planEdits(scope.coordinates, edits);
	if (plan.conflicts.length > 0 || plan.edits.length === 0) {
		return refused("NotImplemented", "the import's edits overlap");
	}
	return { status: "planned", edits: plan.edits };
}
