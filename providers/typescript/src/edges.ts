// A file's import and export edges, in one source order.

import {
	type Certainty,
	comparePositions,
	composeSymbolId,
	type Export,
	type ExportTarget,
	type Import,
	type ImportEdge,
	type Meaning,
	parseSymbolId,
	type Range,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { boundNames } from "./declarations.js";
import {
	asteriskOf,
	CONFLICT,
	type DraftEdge,
	type DraftImport,
	dynamicImportOf,
	importOf,
	isDynamicImport,
	KNOWN,
	requireOf,
	TYPE_ONLY,
} from "./imports.js";
import { rangeOf } from "./ranges.js";

////////////////////////////////
//  Interfaces & Types

export interface EdgeReads {
	/** The ids a declaration node holds when exported as `name`. */
	idsOf(node: ts.Node, name: string): readonly string[];
	/** Proves CommonJS requires and whether a namespace holds values. */
	checker?: ts.TypeChecker | undefined;
	compilerOptions?: ts.CompilerOptions | undefined;
	/** JavaScript, where CommonJS reads apply. */
	javascript: boolean;
	/** Only the imports a re-export names, as a runtime bundle reports them. */
	reExportsOnly?: boolean;
}

export interface ModuleEdges {
	imports: Import[];
	exports: Export[];
}

type DraftExport = Omit<Export, "order">;

/** What a module-scope name exports as. */
interface Resolved {
	target: ExportTarget;
	meaning?: Meaning | undefined;
}

interface Scope {
	has(name: string): boolean;
	/** The edges binding `name`, else its declarations; empty when neither does. */
	resolve(name: string, exported: string): Resolved[];
	/** The declarations among `nodes`, one per symbol. */
	declared(nodes: readonly ts.Node[], exported: string): Resolved[];
}

////////////////////////////////
//  Constants

const VALUE: Meaning = ["value"];

const VALUE_AND_TYPE: Meaning = ["value", "type"];

const NOT_INDEXED: ExportTarget = { kind: "unknown", reason: "NotIndexed" };

const RUNTIME: Certainty = { status: "unknown", reason: "RuntimeConstructed" };

////////////////////////////////
//  Functions & Helpers

/** Every edge and export of `source`, ordered by where each is written. */
export function moduleEdges(source: ts.SourceFile, reads: EdgeReads): ModuleEdges {
	const drafts = importDrafts(source, reads);
	const scope = moduleScope(source, drafts.topLevel, reads);
	const exports = exportDrafts(source, scope, reads);
	if (reads.javascript && !ts.isExternalModule(source) && !scope.has("module") && !scope.has("exports")) {
		exports.push(...commonJsExports(source, scope));
	}
	return ordered(drafts.all, exports);
}

function importDrafts(source: ts.SourceFile, reads: EdgeReads): { all: DraftImport[]; topLevel: DraftImport[] } {
	const all: DraftImport[] = [];
	const topLevel: DraftImport[] = [];
	const add = (draft: DraftImport | undefined, top: boolean, loads?: "static" | "deferred") => {
		if (draft === undefined) return;
		if (loads !== undefined) for (const edge of draft.edges) edge.loads = loads;
		all.push(draft);
		if (top) topLevel.push(draft);
	};
	if (reads.reExportsOnly === true) {
		for (const statement of source.statements) {
			if (ts.isExportDeclaration(statement)) add(importOf(statement, source), true, "static");
		}
		return { all, topLevel };
	}
	const requires = reads.javascript ? reads.checker : undefined;
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
			const imported = importOf(node, source);
			if (ts.isImportDeclaration(node)) markElided(imported, node, source, reads);
			add(imported, node.parent === source, "static");
			return;
		}
		if (ts.isCallExpression(node) && isDynamicImport(node)) {
			const topLevelAwait =
				ts.isAwaitExpression(node.parent) && node.parent.expression === node && !insideFunction(node);
			add(dynamicImportOf(node, source), false, topLevelAwait ? "static" : "deferred");
		} else if (ts.isCallExpression(node) && requires !== undefined) {
			const draft = requireOf(node, source, requires);
			add(
				draft,
				draft?.edges.some((edge) => edge.bindsLocally) === true,
				insideFunction(node) ? "deferred" : "static",
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { all, topLevel };
}

function markElided(
	draft: DraftImport | undefined,
	node: ts.ImportDeclaration,
	source: ts.SourceFile,
	reads: EdgeReads,
): void {
	if (draft === undefined) return;
	const options = reads.compilerOptions;
	if (
		options === undefined ||
		options.verbatimModuleSyntax === true ||
		options.preserveValueImports === true ||
		scriptIsJavaScript(source)
	)
		return;
	const bindings = node.importClause?.namedBindings;
	const names: ts.Identifier[] = [];
	if (node.importClause?.name !== undefined) names.push(node.importClause.name);
	if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.push(bindings.name);
	if (bindings !== undefined && ts.isNamedImports(bindings))
		names.push(...bindings.elements.map((element) => element.name));
	if (names.length === 0) return;
	const checker = reads.checker;
	const hasValueUse =
		checker !== undefined &&
		names.some((name) => {
			const symbol = checker.getSymbolAtLocation(name);
			if (symbol === undefined) return false;
			let used = false;
			const visit = (item: ts.Node) => {
				if (used) return;
				if (
					ts.isIdentifier(item) &&
					item !== name &&
					checker.getSymbolAtLocation(item) === symbol &&
					!ts.isPartOfTypeNode(item)
				)
					used = true;
				ts.forEachChild(item, visit);
			};
			visit(source);
			return used;
		});
	if (!hasValueUse) for (const edge of draft.edges) edge.elided = true;
}

function scriptIsJavaScript(source: ts.SourceFile): boolean {
	return /\.jsx?$/.test(source.fileName);
}

function insideFunction(node: ts.Node): boolean {
	for (let current = node.parent; current !== undefined && !ts.isSourceFile(current); current = current.parent) {
		if (ts.isFunctionLike(current)) return true;
	}
	return false;
}

/** A declaration's meanings by its syntax; a namespace's only when the checker says whether it holds values. */
export function meaningOf(node: ts.Node, checker: ts.TypeChecker | undefined): Meaning | undefined {
	if (ts.isExportAssignment(node)) return meaningOf(node.expression, checker);
	if (ts.isClassLike(node) || ts.isEnumDeclaration(node)) return VALUE_AND_TYPE;
	if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return TYPE_ONLY;
	if (ts.isFunctionLike(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) return VALUE;
	if (ts.isModuleDeclaration(node) && checker !== undefined) {
		const symbol = checker.getSymbolAtLocation(node.name);
		if (symbol === undefined) return undefined;
		return (symbol.flags & ts.SymbolFlags.ValueModule) !== 0 ? VALUE_AND_TYPE : TYPE_ONLY;
	}
	return undefined;
}

/** Both meanings' atoms; unknown when either is. */
function union(left: Meaning | undefined, right: Meaning | undefined): Meaning | undefined {
	if (left === undefined || right === undefined) return undefined;
	return [...new Set([...left, ...right])];
}

/** A merge or an overload is one symbol, named by its first declaration. */
function firstOfSymbol(id: string): string {
	const parsed = parseSymbolId(id);
	const last = parsed?.descriptors.at(-1);
	if (parsed === null || parsed === undefined || last === undefined || parsed.local !== undefined) return id;
	const bare = { kind: last.kind, name: last.name };
	return composeSymbolId({ ...parsed, descriptors: [...parsed.descriptors.slice(0, -1), bare] });
}

function nameOfStatement(statement: ts.Statement): ts.Identifier | undefined {
	const name = (statement as { name?: ts.Node }).name;
	return name !== undefined && ts.isIdentifier(name) ? name : undefined;
}

function moduleScope(source: ts.SourceFile, imports: readonly DraftImport[], reads: EdgeReads): Scope {
	const edges = new Map<string, DraftEdge[]>();
	for (const draft of imports) {
		for (const edge of draft.edges) {
			const name = edge.local ?? edge.name;
			if (!edge.bindsLocally || name === undefined) continue;
			edges.set(name, [...(edges.get(name) ?? []), edge]);
		}
	}
	const declarations = new Map<string, ts.Node[]>();
	const declare = (name: string, node: ts.Node) => declarations.set(name, [...(declarations.get(name) ?? []), node]);
	for (const statement of source.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				for (const binding of boundNames(declaration)) declare(binding.name.text, binding.node);
			}
			continue;
		}
		const declaring =
			ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement) ||
			ts.isEnumDeclaration(statement) ||
			ts.isModuleDeclaration(statement);
		const name = declaring ? nameOfStatement(statement) : undefined;
		if (name !== undefined) declare(name.text, statement);
	}

	const declared = (nodes: readonly ts.Node[], exported: string): Resolved[] => {
		const found = new Map<string, Meaning | undefined>();
		for (const node of nodes) {
			const meaning = meaningOf(node, reads.checker);
			for (const id of reads.idsOf(node, exported)) {
				const key = firstOfSymbol(id);
				found.set(key, found.has(key) ? union(found.get(key), meaning) : meaning);
			}
		}
		return [...found].map(([symbolId, meaning]) => ({ target: { kind: "symbol", symbolId }, meaning }));
	};
	return {
		has: (name) => edges.has(name) || declarations.has(name),
		resolve: (name, exported) => {
			const bound = edges.get(name);
			if (bound !== undefined)
				return bound.map((edge) => ({ target: importTarget(edge), meaning: edge.meaning }));
			return declared(declarations.get(name) ?? [], exported);
		},
		declared,
	};
}

function importTarget(edge: Pick<ImportEdge, "span">): ExportTarget {
	return { kind: "import", span: edge.span };
}

/** One export per target, or one naming no target when nothing resolves. */
function rows(
	resolved: readonly Resolved[],
	fields: Omit<DraftExport, "target" | "conflict" | "certainty">,
	typeOnly: boolean,
	certainty: Certainty = KNOWN,
): DraftExport[] {
	const targets: Resolved[] = resolved.length === 0 ? [{ target: NOT_INDEXED }] : [...resolved];
	return targets.map(({ target, meaning }) => {
		const shown = typeOnly ? TYPE_ONLY : meaning;
		return { ...fields, target, ...(shown === undefined ? {} : { meaning: shown }), conflict: CONFLICT, certainty };
	});
}

function exportDrafts(source: ts.SourceFile, scope: Scope, reads: EdgeReads): DraftExport[] {
	const drafts: DraftExport[] = [];
	const direct = new Map<string, DraftExport>();
	for (const statement of source.statements) {
		if (ts.isExportDeclaration(statement)) {
			drafts.push(...exportDeclarationRows(statement, source, scope));
			continue;
		}
		if (ts.isExportAssignment(statement)) {
			drafts.push(...exportAssignmentRows(statement, source, scope));
			continue;
		}
		const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
		if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
		const keyword = modifiers.find((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
		const name = nameOfStatement(statement);
		if (keyword !== undefined) {
			// A named default keeps its name in the surface's own reading.
			const fields = {
				form: "default" as const,
				span: rangeOf(keyword, source),
				name: "default",
				range: rangeOf(keyword, source),
				...(name === undefined ? {} : { sourceRange: rangeOf(name, source) }),
			};
			drafts.push(...rows(scope.declared([statement], name?.text ?? "default"), fields, false));
			continue;
		}
		if (ts.isImportEqualsDeclaration(statement)) {
			const span = rangeOf(statement.name, source);
			const fields = { form: "local" as const, span, name: statement.name.text, range: span };
			drafts.push(...rows(scope.resolve(statement.name.text, statement.name.text), fields, false));
			continue;
		}
		const named: Array<{ name: ts.Identifier; node: ts.Node }> = ts.isVariableStatement(statement)
			? statement.declarationList.declarations.flatMap((declaration) => boundNames(declaration))
			: name === undefined
				? []
				: [{ name, node: statement }];
		for (const { name: token, node } of named) {
			const span = rangeOf(token, source);
			for (const row of rows(
				scope.declared([node], token.text),
				{
					form: "direct",
					span,
					name: token.text,
					range: span,
				},
				false,
			)) {
				const key = `${token.text}\0${JSON.stringify(row.target)}`;
				const held = direct.get(key);
				if (held === undefined) {
					direct.set(key, row);
					drafts.push(row);
					continue;
				}
				// Every declaration of a merge or an overload exports one symbol.
				const meaning = union(held.meaning, row.meaning);
				if (meaning === undefined) delete held.meaning;
				else held.meaning = meaning;
			}
		}
	}
	return drafts;
}

function exportDeclarationRows(statement: ts.ExportDeclaration, source: ts.SourceFile, scope: Scope): DraftExport[] {
	const typeOnly = statement.isTypeOnly;
	const clause = statement.exportClause;
	if (statement.moduleSpecifier !== undefined) {
		if (!ts.isStringLiteral(statement.moduleSpecifier)) return [];
		if (clause === undefined) {
			const span = rangeOf(asteriskOf(statement, source), source);
			return rows([{ target: importTarget({ span }) }], { form: "star", span }, typeOnly);
		}
		if (ts.isNamespaceExport(clause)) {
			const span = rangeOf(clause, source);
			const fields = {
				form: "namespace" as const,
				span,
				name: clause.name.text,
				range: rangeOf(clause.name, source),
			};
			return rows([{ target: importTarget({ span }) }], fields, typeOnly);
		}
		return clause.elements.flatMap((element) => {
			const span = rangeOf(element, source);
			const fields = {
				form: "forward" as const,
				span,
				name: element.name.text,
				range: rangeOf(element.name, source),
				...(element.propertyName === undefined ? {} : { sourceRange: rangeOf(element.propertyName, source) }),
			};
			return rows([{ target: importTarget({ span }) }], fields, typeOnly || element.isTypeOnly);
		});
	}
	if (clause === undefined || !ts.isNamedExports(clause)) return [];
	return clause.elements.flatMap((element) => {
		const local = element.propertyName ?? element.name;
		const fields = {
			form: "local" as const,
			span: rangeOf(element, source),
			name: element.name.text,
			range: rangeOf(element.name, source),
			...(element.propertyName === undefined ? {} : { sourceRange: rangeOf(element.propertyName, source) }),
		};
		const resolved = ts.isIdentifier(local) ? scope.resolve(local.text, element.name.text) : [];
		return rows(resolved, fields, typeOnly || element.isTypeOnly);
	});
}

function exportAssignmentRows(statement: ts.ExportAssignment, source: ts.SourceFile, scope: Scope): DraftExport[] {
	const equals = statement.isExportEquals === true;
	const expression = statement.expression;
	const identifier = ts.isIdentifier(expression) ? expression : undefined;
	const keyword = statement.getChildren(source).find((child) => child.kind === ts.SyntaxKind.DefaultKeyword);
	const name = equals ? (identifier?.text ?? "export=") : "default";
	const declares =
		ts.isFunctionExpression(expression) || ts.isArrowFunction(expression) || ts.isClassExpression(expression);
	// `export default expr` names no declaration.
	const resolved =
		identifier !== undefined
			? scope.resolve(identifier.text, name)
			: declares
				? scope.declared([statement, expression], name)
				: [];
	const fields = {
		form: equals ? ("assignment" as const) : ("default" as const),
		span: rangeOf(statement, source),
		...(equals || keyword === undefined ? {} : { name: "default", range: rangeOf(keyword, source) }),
		...(identifier === undefined ? {} : { sourceRange: rangeOf(identifier, source) }),
	};
	return rows(resolved, fields, false);
}

////////////////////////////////
//  CommonJS

function isModuleExports(node: ts.Expression): boolean {
	return (
		ts.isPropertyAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "module" &&
		node.name.text === "exports"
	);
}

function isExportsObject(node: ts.Expression): boolean {
	return (ts.isIdentifier(node) && node.text === "exports") || isModuleExports(node);
}

/** The name token `exports.N`, `module.exports.N` or `exports["N"]` assigns. */
function commonJsName(node: ts.Expression): ts.Identifier | ts.StringLiteral | undefined {
	if (ts.isPropertyAccessExpression(node) && isExportsObject(node.expression) && ts.isIdentifier(node.name)) {
		return node.name;
	}
	if (ts.isElementAccessExpression(node) && isExportsObject(node.expression)) {
		const argument = node.argumentExpression;
		if (ts.isStringLiteral(argument)) return argument;
	}
	return undefined;
}

function unwrapped(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
		current = current.expression;
	}
	return current;
}

function isWrapper(node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression {
	return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node);
}

function isAssignedBy(node: ts.Node): boolean {
	const parent = node.parent;
	return (
		ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
	);
}

/** `module` or `exports` as a receiver or an argument, which the checker reads as an export assignment's own symbol. */
export function isModuleName(node: ts.Node): node is ts.Identifier {
	if (!ts.isIdentifier(node) || (node.text !== "module" && node.text !== "exports")) return false;
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
		return parent.expression === node;
	return ts.isCallExpression(parent) && parent.arguments.includes(node);
}

/** `module` or `exports` as the checker's CommonJS module object, never a local of that name. */
function isModuleObject(node: ts.Node, checker: ts.TypeChecker): boolean {
	if (!isModuleName(node)) return false;
	const symbol = checker.resolveName(node.text, node, ts.SymbolFlags.Value, false);
	return (
		symbol !== undefined &&
		((symbol.flags & ts.SymbolFlags.ModuleExports) !== 0 || (symbol.declarations ?? []).some(ts.isSourceFile))
	);
}

/** The checker's symbol at `node` is the one `declaration` declares. */
function declaredBy(node: ts.Node, declaration: ts.Node, checker: ts.TypeChecker): boolean {
	return (checker.getSymbolAtLocation(node)?.declarations ?? []).includes(declaration as ts.Declaration);
}

/**
 * The CommonJS module object, and the names an export assignment declares on it. The checker binds
 * each to the assigned value, yet none is a use of it.
 */
export function isCommonJsTarget(node: ts.Node, checker: ts.TypeChecker): boolean {
	if (!ts.isIdentifier(node)) return false;
	const parent = node.parent;
	if (!ts.isPropertyAccessExpression(parent) || parent.name !== node) return isModuleObject(node, checker);
	if (isModuleExports(parent)) {
		return isModuleObject(parent.expression, checker) || declaredBy(node, parent.parent, checker);
	}
	return isAssignedBy(parent) && isExportsObject(parent.expression) && declaredBy(node, parent, checker);
}

/** The local a `module.exports = { N: local }` member exports, as its export row resolves it. */
export function commonJsMemberValue(declaration: ts.Node): ts.Identifier | undefined {
	if (!ts.isPropertyAssignment(declaration) || !ts.isIdentifier(declaration.name)) return undefined;
	const value = unwrapped(declaration.initializer);
	if (!ts.isIdentifier(value)) return undefined;
	let object: ts.Node = declaration.parent;
	while (isWrapper(object.parent)) object = object.parent;
	const assignment = object.parent;
	const exported =
		ts.isBinaryExpression(assignment) &&
		assignment.right === object &&
		isAssignedBy(assignment.left) &&
		isModuleExports(assignment.left);
	return exported ? value : undefined;
}

/** `exports.N = x`, `module.exports = x` and its object's members, and `Object.defineProperty(exports, "N", ...)`. */
function commonJsExports(source: ts.SourceFile, scope: Scope): DraftExport[] {
	const drafts: DraftExport[] = [];
	const named = (name: string, token: ts.Node, value: ts.Expression | undefined, certainty: Certainty) => {
		const held = value === undefined ? undefined : unwrapped(value);
		const identifier = held !== undefined && ts.isIdentifier(held) ? held : undefined;
		const declares =
			held !== undefined &&
			(ts.isFunctionExpression(held) || ts.isArrowFunction(held) || ts.isClassExpression(held));
		const resolved =
			identifier !== undefined
				? scope.resolve(identifier.text, name)
				: declares
					? scope.declared([held], name)
					: [];
		const span = rangeOf(token, source);
		const fields = {
			form: identifier !== undefined && resolved.length > 0 ? ("local" as const) : ("direct" as const),
			span,
			name,
			range: span,
			...(identifier === undefined ? {} : { sourceRange: rangeOf(identifier, source) }),
		};
		drafts.push(...rows(resolved, fields, false, certainty));
	};
	const assigned = (node: ts.BinaryExpression, certainty: Certainty) => {
		if (isModuleExports(node.left)) {
			const value = unwrapped(node.right);
			const identifier = ts.isIdentifier(value) ? value : undefined;
			const fields = {
				form: "assignment" as const,
				span: rangeOf(node.left, source),
				...(identifier === undefined ? {} : { sourceRange: rangeOf(identifier, source) }),
			};
			const resolved = identifier === undefined ? [] : scope.resolve(identifier.text, identifier.text);
			drafts.push(...rows(resolved, fields, false, certainty));
			if (!ts.isObjectLiteralExpression(value)) return;
			for (const property of value.properties) {
				if (ts.isShorthandPropertyAssignment(property)) {
					named(property.name.text, property.name, property.name, certainty);
				} else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
					named(property.name.text, property.name, property.initializer, certainty);
				} else if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name)) {
					const span = rangeOf(property.name, source);
					const resolved = scope.declared([property], property.name.text);
					drafts.push(
						...rows(
							resolved,
							{ form: "direct", span, name: property.name.text, range: span },
							false,
							certainty,
						),
					);
				}
			}
			return;
		}
		const name = commonJsName(node.left);
		if (name !== undefined) named(name.text, name, node.right, certainty);
	};
	const visit = (node: ts.Node, certainty: Certainty): void => {
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			assigned(node, certainty);
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "Object" &&
			node.expression.name.text === "defineProperty"
		) {
			const [target, key] = node.arguments;
			if (target !== undefined && isExportsObject(target) && key !== undefined && ts.isStringLiteral(key)) {
				if (key.text !== "__esModule") named(key.text, key, undefined, certainty);
			}
		}
		ts.forEachChild(node, (child) => visit(child, RUNTIME));
	};
	for (const statement of source.statements) {
		// Only a module-scope statement runs exactly once, on load.
		if (ts.isExpressionStatement(statement)) visit(statement.expression, KNOWN);
		else visit(statement, RUNTIME);
	}
	return drafts;
}

////////////////////////////////
//  Order

function byStart(left: Range, right: Range): number {
	return comparePositions(left.start, right.start);
}

/** Orders edges and exports together; an import edge precedes an export written at its span. */
function ordered(imports: readonly DraftImport[], exports: readonly DraftExport[]): ModuleEdges {
	const facts: Array<{ fact: object; span: Range; rank: number }> = [
		...imports.flatMap((draft) => draft.edges.map((edge) => ({ fact: edge as object, span: edge.span, rank: 0 }))),
		...exports.map((draft) => ({ fact: draft as object, span: draft.span, rank: 1 })),
	];
	const order = new Map<object, number>();
	facts
		.map((entry, index) => ({ ...entry, index }))
		.sort((left, right) => byStart(left.span, right.span) || left.rank - right.rank || left.index - right.index)
		.forEach((entry, at) => {
			order.set(entry.fact, at);
		});
	const orderOf = (fact: object) => order.get(fact) as number;
	return {
		imports: imports
			.map((draft) => ({
				specifier: draft.specifier,
				edges: draft.edges.map((edge) => ({ ...edge, order: orderOf(edge) })),
			}))
			.sort((left, right) => (left.edges[0]?.order ?? 0) - (right.edges[0]?.order ?? 0)),
		exports: exports.map((draft) => ({ ...draft, order: orderOf(draft) })).sort((l, r) => l.order - r.order),
	};
}
