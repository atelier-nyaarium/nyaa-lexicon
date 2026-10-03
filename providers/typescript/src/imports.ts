// Import and re-export statements, one edge per transfer.

import type { Certainty, Conflict, ImportEdge, ImportKind, Meaning, Range, Selector } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { rangeOf } from "./ranges.js";

////////////////////////////////
//  Interfaces & Types

export type ImportStatement = ts.ImportDeclaration | ts.ExportDeclaration | ts.ImportEqualsDeclaration;

/** An edge before the file's source order is known. */
export type DraftEdge = Omit<ImportEdge, "order">;

export interface DraftImport {
	specifier: string;
	edges: DraftEdge[];
}

interface EdgeFields {
	name?: ts.ModuleExportName | undefined;
	local?: ts.Identifier | undefined;
	bindsLocally: boolean;
	typeOnly: boolean;
	selector?: Selector;
}

////////////////////////////////
//  Constants

/** TypeScript's rule: a local and an imported binding of one name cannot both stand. */
export const CONFLICT: Conflict = { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" };

export const KNOWN: Certainty = { status: "known" };

export const TYPE_ONLY: Meaning = ["type"];

////////////////////////////////
//  Functions & Helpers

export function isDynamicImport(node: ts.CallExpression): boolean {
	return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function edge(kind: ImportKind, span: ts.Node, source: ts.SourceFile, fields: EdgeFields): DraftEdge {
	return {
		kind,
		span: rangeOf(span, source),
		...(fields.name === undefined ? {} : { name: fields.name.text, range: rangeOf(fields.name, source) }),
		...(fields.local === undefined ? {} : { local: fields.local.text, localRange: rangeOf(fields.local, source) }),
		bindsLocally: fields.bindsLocally,
		...(fields.typeOnly ? { typeOnly: true, meaning: TYPE_ONLY } : {}),
		...(fields.selector === undefined ? {} : { selector: fields.selector }),
		...(fields.bindsLocally ? { conflict: CONFLICT } : {}),
		certainty: KNOWN,
	};
}

/** The `*` of `export * from`, which is the star edge as written. */
export function asteriskOf(node: ts.ExportDeclaration, source: ts.SourceFile): ts.Node {
	return node.getChildren(source).find((child) => child.kind === ts.SyntaxKind.AsteriskToken) ?? node;
}

/** One import or re-export statement's edges. */
export function importOf(node: ImportStatement, source: ts.SourceFile): DraftImport | undefined {
	if (ts.isImportEqualsDeclaration(node)) {
		const reference = node.moduleReference;
		if (!ts.isExternalModuleReference(reference) || !ts.isStringLiteral(reference.expression)) return undefined;
		const fields = { local: node.name, bindsLocally: true, typeOnly: node.isTypeOnly };
		return { specifier: reference.expression.text, edges: [edge("require", node.name, source, fields)] };
	}
	const specifier = node.moduleSpecifier;
	if (specifier === undefined || !ts.isStringLiteral(specifier)) return undefined;

	const edges: DraftEdge[] = [];
	if (ts.isImportDeclaration(node)) {
		const clause = node.importClause;
		const typeOnly = clause?.isTypeOnly === true;
		if (clause?.name !== undefined) {
			edges.push(edge("default", clause.name, source, { local: clause.name, bindsLocally: true, typeOnly }));
		}
		const bindings = clause?.namedBindings;
		if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
			edges.push(edge("namespace", bindings, source, { local: bindings.name, bindsLocally: true, typeOnly }));
		}
		if (bindings !== undefined && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				edges.push(
					edge("named", element, source, {
						name: element.propertyName ?? element.name,
						local: element.propertyName === undefined ? undefined : element.name,
						bindsLocally: true,
						typeOnly: typeOnly || element.isTypeOnly,
					}),
				);
			}
		}
	} else {
		const clause = node.exportClause;
		const typeOnly = node.isTypeOnly;
		if (clause === undefined) {
			const selector = { kind: "allButDefault" } as const;
			edges.push(edge("wildcard", asteriskOf(node, source), source, { bindsLocally: false, typeOnly, selector }));
		} else if (ts.isNamespaceExport(clause)) {
			// `export * as ns` binds nothing here; the export names the namespace.
			const selector = { kind: "visible" } as const;
			edges.push(edge("wildcard", clause, source, { bindsLocally: false, typeOnly, selector }));
		} else {
			for (const element of clause.elements) {
				edges.push(
					edge("named", element, source, {
						name: element.propertyName ?? element.name,
						bindsLocally: false,
						typeOnly: typeOnly || element.isTypeOnly,
					}),
				);
			}
		}
	}
	// `import {} from`, or a bare side-effect import.
	if (edges.length === 0) edges.push(edge("sideEffect", node, source, { bindsLocally: false, typeOnly: false }));
	return { specifier: specifier.text, edges };
}

/** `import("m")`: loads a module and binds nothing. */
export function dynamicImportOf(node: ts.CallExpression, source: ts.SourceFile): DraftImport | undefined {
	const argument = node.arguments[0];
	if (argument === undefined || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
		return undefined;
	}
	return {
		specifier: argument.text,
		edges: [edge("sideEffect", node, source, { bindsLocally: false, typeOnly: false })],
	};
}

/** The specifier of a call to the CommonJS `require`, when the checker proves no local declaration shadows it. */
function provedRequire(node: ts.Expression | undefined, checker: ts.TypeChecker): string | undefined {
	if (node === undefined || !ts.isCallExpression(node)) return undefined;
	const callee = node.expression;
	const [argument, ...rest] = node.arguments;
	if (!ts.isIdentifier(callee) || callee.text !== "require" || rest.length > 0) return undefined;
	if (argument === undefined || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
		return undefined;
	}
	const declarations = checker.getSymbolAtLocation(callee)?.declarations ?? [];
	return declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
		? argument.text
		: undefined;
}

/** Whether the checker binds `name` as an alias, which it does only for a CommonJS import. */
function isAlias(name: ts.Node, checker: ts.TypeChecker): boolean {
	const symbol = checker.getSymbolAtLocation(name);
	return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0;
}

/**
 * A CommonJS `require("m")` call the checker proves. A module-scope `const x = require("m")`,
 * `const { a, b: c } = require("m")` or `const x = require("m").a` binds; any other call loads
 * the module and binds nothing.
 */
export function requireOf(
	call: ts.CallExpression,
	source: ts.SourceFile,
	checker: ts.TypeChecker,
): DraftImport | undefined {
	const specifier = provedRequire(call, checker);
	if (specifier === undefined) return undefined;
	const edges = requireBindings(call, source, checker);
	if (edges.length === 0) edges.push(edge("sideEffect", call, source, { bindsLocally: false, typeOnly: false }));
	return { specifier, edges };
}

/** The bindings a module-scope variable initialized by `call` writes. */
function requireBindings(call: ts.CallExpression, source: ts.SourceFile, checker: ts.TypeChecker): DraftEdge[] {
	const accessed = ts.isPropertyAccessExpression(call.parent) ? call.parent : undefined;
	const declaration = (accessed ?? call).parent;
	if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== (accessed ?? call)) return [];
	const statement = declaration.parent.parent;
	if (!ts.isVariableStatement(statement) || statement.parent !== source) return [];
	const target = declaration.name;
	const edges: DraftEdge[] = [];
	const member = accessed?.name;
	if (ts.isIdentifier(target) && isAlias(target, checker)) {
		const fields = { local: target, bindsLocally: true, typeOnly: false };
		if (member === undefined) edges.push(edge("require", target, source, fields));
		else if (ts.isIdentifier(member)) edges.push(edge("named", target, source, { ...fields, name: member }));
	} else if (ts.isObjectBindingPattern(target) && accessed === undefined) {
		for (const element of target.elements) {
			const property = element.propertyName ?? element.name;
			if (!ts.isIdentifier(element.name) || !ts.isIdentifier(property) || element.dotDotDotToken) continue;
			if (!isAlias(element.name, checker)) continue;
			edges.push(
				edge("named", element, source, {
					name: property,
					local: element.propertyName === undefined ? undefined : element.name,
					bindsLocally: true,
					typeOnly: false,
				}),
			);
		}
	}
	return edges;
}

/** An alias declaration whose edge binds a whole module: a namespace import or a require. */
export function bindsModule(declaration: ts.Node): boolean {
	if (ts.isNamespaceImport(declaration)) return true;
	if (ts.isImportEqualsDeclaration(declaration)) return ts.isExternalModuleReference(declaration.moduleReference);
	return (
		ts.isVariableDeclaration(declaration) &&
		declaration.initializer !== undefined &&
		ts.isCallExpression(declaration.initializer)
	);
}

/** The node an alias declaration's edge spans, matching `importOf` and `requireOf`. */
function spanNodeOf(declaration: ts.Node): ts.Node | undefined {
	if (ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration)) return declaration;
	if (ts.isImportClause(declaration)) return declaration.name;
	if (ts.isImportEqualsDeclaration(declaration) || ts.isVariableDeclaration(declaration)) return declaration.name;
	if (ts.isBindingElement(declaration)) return declaration;
	return undefined;
}

/** The span of the edge an alias declaration writes, when it writes one. */
export function aliasEdgeSpan(declaration: ts.Node, source: ts.SourceFile): Range | undefined {
	if (declaration.getSourceFile() !== source) return undefined;
	const node = spanNodeOf(declaration);
	return node === undefined ? undefined : rangeOf(node, source);
}
