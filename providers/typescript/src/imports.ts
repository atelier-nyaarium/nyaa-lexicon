// Import and re-export statements, each name with the form binding it.

import type { Import, ImportedName, ImportKind } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { rangeOf } from "./ranges.js";

////////////////////////////////
//  Interfaces & Types

export type ImportStatement = ts.ImportDeclaration | ts.ExportDeclaration | ts.ImportEqualsDeclaration;

////////////////////////////////
//  Functions & Helpers

export function isDynamicImport(node: ts.CallExpression): boolean {
	return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/** A named import carries no kind. */
function importedNameOf(
	source: ts.SourceFile,
	name: ts.Identifier | ts.StringLiteral | undefined,
	local: ts.Identifier | ts.StringLiteral | undefined,
	kind: ImportKind | undefined,
	typeOnly: boolean,
): ImportedName {
	const imported: ImportedName = {};
	if (name !== undefined) {
		imported.name = name.text;
		imported.range = rangeOf(name, source);
	}
	if (local !== undefined && (name === undefined || local.text !== name.text)) {
		imported.local = local.text;
		imported.localRange = rangeOf(local, source);
	}
	if (kind !== undefined) imported.kind = kind;
	if (typeOnly) imported.typeOnly = true;
	return imported;
}

/** One import or re-export statement's names, each with the form binding it. */
export function importOf(node: ImportStatement, source: ts.SourceFile): Import | undefined {
	if (ts.isImportEqualsDeclaration(node)) {
		const reference = node.moduleReference;
		if (!ts.isExternalModuleReference(reference) || !ts.isStringLiteral(reference.expression)) return undefined;
		const imported = importedNameOf(source, undefined, node.name, "require", node.isTypeOnly);
		return { specifier: reference.expression.text, imported: [imported], reExport: false };
	}
	const specifier = node.moduleSpecifier;
	if (specifier === undefined || !ts.isStringLiteral(specifier)) return undefined;

	const named: ImportedName[] = [];
	if (ts.isImportDeclaration(node)) {
		const clause = node.importClause;
		const typeOnly = clause?.isTypeOnly === true;
		if (clause?.name) named.push(importedNameOf(source, undefined, clause.name, "default", typeOnly));
		const bindings = clause?.namedBindings;
		if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				const name = element.propertyName ?? element.name;
				const local = element.propertyName === undefined ? undefined : element.name;
				named.push(importedNameOf(source, name, local, undefined, typeOnly || element.isTypeOnly));
			}
		}
		if (bindings && ts.isNamespaceImport(bindings)) {
			named.push(importedNameOf(source, undefined, bindings.name, "namespace", typeOnly));
		}
	} else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
		for (const element of node.exportClause.elements) {
			const name = element.propertyName ?? element.name;
			const local =
				element.name.text === "default" || element.propertyName === undefined ? undefined : element.name;
			named.push(importedNameOf(source, name, local, undefined, node.isTypeOnly || element.isTypeOnly));
		}
	} else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
		named.push(importedNameOf(source, undefined, node.exportClause.name, "namespace", node.isTypeOnly));
	}

	return { specifier: specifier.text, imported: named, reExport: ts.isExportDeclaration(node) };
}
