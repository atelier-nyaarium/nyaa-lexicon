import {
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type Import,
	type ImportedName,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { isDeclarationModule } from "./bundle.js";
import { LANGUAGE } from "./extract.js";
import { scriptKindOf } from "./file-types.js";

////////////////////////////////
//  Interfaces & Types

export interface SurfaceFacts {
	declarations: Declaration[];
	references: [];
	imports: Import[];
	literals: [];
	comments: [];
	diagnostics: Diagnostic[];
}

interface ExportedNode {
	name: string;
	node: ts.Node;
	selection: ts.Node | undefined;
}

type SurfaceCallable = ts.FunctionLikeDeclaration | ts.MethodSignature;
type SurfaceCallableKind = "function" | "method" | "constructor";

////////////////////////////////
//  Extraction

/** Extracts only an external module's callable API or its declaration-file surface. */
export function extractSurfaceFile(module: string, text: string): SurfaceFacts {
	const source = ts.createSourceFile(module, text, ts.ScriptTarget.ESNext, true, scriptKindOf(module));
	const declarations = isDeclarationModule(module)
		? declarationSurface(module, source)
		: runtimeSurface(module, source);
	return {
		declarations,
		references: [],
		imports: isDeclarationModule(module) ? declarationImports(source) : [],
		literals: [],
		comments: [],
		diagnostics: syntaxDiagnostics(module, source),
	};
}

function runtimeSurface(module: string, source: ts.SourceFile): Declaration[] {
	const exported = exportedNodes(source, false).filter((item) => callableOf(item.node) !== undefined);
	const declarations: Declaration[] = [];
	const occurrences = new Map<string, number>();
	for (const item of exported) {
		const callable = callableOf(item.node);
		if (callable === undefined) continue;
		recordFunction(module, source, declarations, occurrences, item.name, callable, item.selection, false);
	}
	return declarations;
}

function declarationSurface(module: string, source: ts.SourceFile): Declaration[] {
	const declarations: Declaration[] = [];
	const occurrences = new Map<string, number>();
	for (const item of exportedNodes(source, true)) {
		const callable = callableOf(item.node);
		if (callable !== undefined) {
			recordFunction(module, source, declarations, occurrences, item.name, callable, item.selection, true);
			continue;
		}
		recordDeclaration(module, source, declarations, occurrences, item);
	}
	return declarations;
}

function exportedNodes(source: ts.SourceFile, declarations: boolean): ExportedNode[] {
	const locals = localNodes(source);
	const exported: ExportedNode[] = [];
	const seen = new Set<string>();
	const add = (name: string, node: ts.Node, selection?: ts.Node) => {
		const key = `${name}:${node.pos}:${node.end}`;
		if (seen.has(key)) return;
		seen.add(key);
		exported.push({ name, node, selection });
	};

	for (const statement of source.statements) {
		const direct = directlyExported(statement);
		for (const node of direct) {
			const localName = nodeName(node);
			const name = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : localName;
			if (name !== null) add(name, node, name === "default" ? defaultToken(statement, source) : nameNode(node));
		}

		if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined) {
			if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue;
			for (const element of statement.exportClause.elements) {
				const local = (element.propertyName ?? element.name).text;
				for (const node of locals.get(local) ?? []) add(element.name.text, node, element.name);
			}
		}

		if (ts.isExportAssignment(statement)) {
			if (ts.isIdentifier(statement.expression)) {
				for (const node of locals.get(statement.expression.text) ?? []) {
					add(statement.isExportEquals ? statement.expression.text : "default", node, statement.expression);
				}
			} else if (ts.isFunctionExpression(statement.expression) || ts.isArrowFunction(statement.expression)) {
				add("default", statement.expression, statement.expression);
			}
		}
	}

	if (!declarations) collectCommonJsExports(source, locals, add);
	return exported;
}

function localNodes(source: ts.SourceFile): Map<string, ts.Node[]> {
	const found = new Map<string, ts.Node[]>();
	const add = (name: string, node: ts.Node) => found.set(name, [...(found.get(name) ?? []), node]);
	for (const statement of source.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration);
			}
			continue;
		}
		const name = nodeName(statement);
		if (name !== null) add(name, statement);
	}
	return found;
}

function directlyExported(statement: ts.Statement): ts.Node[] {
	if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
	if (ts.isVariableStatement(statement)) return [...statement.declarationList.declarations];
	return [statement];
}

function collectCommonJsExports(
	source: ts.SourceFile,
	locals: Map<string, ts.Node[]>,
	add: (name: string, node: ts.Node, selection?: ts.Node) => void,
): void {
	const stack: ts.Node[] = [...source.statements];
	while (stack.length > 0) {
		const node = stack.pop() as ts.Node;
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			const name = commonJsExportName(node.left);
			if (name !== null) addExportExpression(name, node.right, locals, add, propertyNameNode(node.left));
			if (isModuleExports(node.left) && ts.isObjectLiteralExpression(node.right)) {
				for (const property of node.right.properties) addObjectExport(property, locals, add);
			}
		}
		ts.forEachChild(node, (child) => stack.push(child));
	}
}

function addObjectExport(
	property: ts.ObjectLiteralElementLike,
	locals: Map<string, ts.Node[]>,
	add: (name: string, node: ts.Node, selection?: ts.Node) => void,
): void {
	if (ts.isShorthandPropertyAssignment(property)) {
		for (const node of locals.get(property.name.text) ?? []) add(property.name.text, node, property.name);
		return;
	}
	if (ts.isMethodDeclaration(property) && property.name !== undefined) {
		const name = propertyNameText(property.name);
		if (name !== null) add(name, property, property.name);
		return;
	}
	if (!ts.isPropertyAssignment(property)) return;
	const name = propertyNameText(property.name);
	if (name !== null) addExportExpression(name, property.initializer, locals, add, property.name);
}

function addExportExpression(
	name: string,
	expression: ts.Expression,
	locals: Map<string, ts.Node[]>,
	add: (name: string, node: ts.Node, selection?: ts.Node) => void,
	selection?: ts.Node,
): void {
	const unwrapped = unwrapExpression(expression);
	if (ts.isFunctionExpression(unwrapped) || ts.isArrowFunction(unwrapped)) {
		add(name, unwrapped, selection);
		return;
	}
	if (ts.isIdentifier(unwrapped)) {
		const candidates = locals.get(unwrapped.text) ?? [];
		if (candidates.length === 1) add(name, candidates[0] as ts.Node, selection);
	}
}

function callableOf(node: ts.Node): SurfaceCallable | undefined {
	if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node;
	if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return node;
	if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return undefined;
	const initializer = unwrapExpression(node.initializer);
	return ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer) ? initializer : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function recordFunction(
	module: string,
	source: ts.SourceFile,
	declarations: Declaration[],
	occurrences: Map<string, number>,
	name: string,
	callable: SurfaceCallable,
	selection: ts.Node | undefined,
	typed: boolean,
	container?: { symbolId: string; descriptors: Descriptor[] },
	kind: SurfaceCallableKind = container === undefined ? "function" : "method",
): void {
	const descriptors = [
		...(container?.descriptors ?? []),
		descriptor(occurrences, container?.descriptors ?? [], "method", name),
	];
	const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
	const range = rangeOf(callable, source);
	// No name token means no name span; the whole node is not a name.
	const named = selection ?? nameNode(callable);
	declarations.push({
		symbolId,
		kind,
		name,
		range,
		...(named === undefined ? {} : { selectionRange: rangeOf(named, source) }),
		visibility: "public",
		exported: container === undefined,
		metrics: { lines: range.end.line - range.start.line + 1, parameters: callable.parameters.length },
		signature: functionSignature(name, callable, source, typed, kind),
		...(container === undefined ? {} : { containerId: container.symbolId }),
	});
	recordParameters(module, source, declarations, occurrences, callable.parameters, symbolId, descriptors);
}

function recordDeclaration(
	module: string,
	source: ts.SourceFile,
	declarations: Declaration[],
	occurrences: Map<string, number>,
	item: ExportedNode,
): void {
	const classified = declarationKind(item.node);
	if (classified === null) return;
	const descriptors = [descriptor(occurrences, [], classified.descriptor, item.name)];
	const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
	const range = rangeOf(item.node, source);
	const named = item.selection ?? nameNode(item.node);
	declarations.push({
		symbolId,
		kind: classified.kind,
		name: item.name,
		range,
		...(named === undefined ? {} : { selectionRange: rangeOf(named, source) }),
		visibility: "public",
		exported: true,
		metrics: { lines: range.end.line - range.start.line + 1 },
		...(declarationSignature(item.name, item.node, source) === undefined
			? {}
			: { signature: declarationSignature(item.name, item.node, source) as string }),
	});
	if (ts.isClassDeclaration(item.node) || ts.isInterfaceDeclaration(item.node)) {
		recordMembers(module, source, declarations, occurrences, item.node.members, symbolId, descriptors);
	}
}

function recordMembers(
	module: string,
	source: ts.SourceFile,
	declarations: Declaration[],
	occurrences: Map<string, number>,
	members: ts.NodeArray<ts.ClassElement | ts.TypeElement>,
	containerId: string,
	containerDescriptors: Descriptor[],
): void {
	for (const member of members) {
		if (!isPublicMember(member)) continue;
		if (ts.isConstructorDeclaration(member)) {
			recordFunction(
				module,
				source,
				declarations,
				occurrences,
				"constructor",
				member,
				constructorToken(member, source),
				true,
				{ symbolId: containerId, descriptors: containerDescriptors },
				"constructor",
			);
			continue;
		}
		if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
			const name = propertyNameText(member.name);
			if (name !== null) {
				recordFunction(module, source, declarations, occurrences, name, member, member.name, true, {
					symbolId: containerId,
					descriptors: containerDescriptors,
				});
			}
			continue;
		}
		if (
			!ts.isPropertyDeclaration(member) &&
			!ts.isPropertySignature(member) &&
			!ts.isGetAccessorDeclaration(member) &&
			!ts.isSetAccessorDeclaration(member)
		)
			continue;
		const name = propertyNameText(member.name);
		if (name === null) continue;
		const descriptors = [...containerDescriptors, descriptor(occurrences, containerDescriptors, "term", name)];
		const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
		const range = rangeOf(member, source);
		declarations.push({
			symbolId,
			kind: "property",
			name,
			range,
			selectionRange: rangeOf(member.name, source),
			visibility: "public",
			exported: false,
			containerId,
			metrics: { lines: range.end.line - range.start.line + 1 },
			signature: member.getText(source),
		});
		if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
			recordParameters(module, source, declarations, occurrences, member.parameters, symbolId, descriptors);
		}
	}
}

function recordParameters(
	module: string,
	source: ts.SourceFile,
	declarations: Declaration[],
	occurrences: Map<string, number>,
	parameters: ts.NodeArray<ts.ParameterDeclaration>,
	containerId: string,
	containerDescriptors: Descriptor[],
): void {
	for (const parameter of parameters) {
		for (const binding of parameterBindings(parameter.name)) {
			const descriptors = [
				...containerDescriptors,
				descriptor(occurrences, containerDescriptors, "term", binding.text, "parameter"),
			];
			declarations.push({
				symbolId: composeSymbolId({ language: LANGUAGE, module, descriptors }),
				kind: "variable",
				name: binding.text,
				range: rangeOf(parameter, source),
				selectionRange: rangeOf(binding, source),
				visibility: "local",
				exported: false,
				containerId,
			});
		}
	}
}

function parameterBindings(name: ts.BindingName): ts.Identifier[] {
	if (ts.isIdentifier(name)) return [name];
	return name.elements.flatMap((element) => (ts.isBindingElement(element) ? parameterBindings(element.name) : []));
}

// Only a method renders a disambiguator, so only a method counts occurrences. Numbering other
// kinds produced an ordinal the composer dropped, which reads like disambiguation and is not.
function descriptor(
	occurrences: Map<string, number>,
	parents: Descriptor[],
	kind: "type" | "method" | "term",
	name: string,
	descriptorKind: "type" | "method" | "term" | "parameter" = kind,
): Descriptor {
	if (descriptorKind !== "method") return { kind: descriptorKind, name };
	const key = `${parents.map((item) => `${item.kind}:${item.name}`).join("/")}/${descriptorKind}:${name}`;
	const ordinal = occurrences.get(key) ?? 0;
	occurrences.set(key, ordinal + 1);
	return ordinal === 0
		? { kind: descriptorKind, name }
		: { kind: descriptorKind, name, disambiguator: String(ordinal) };
}

function declarationKind(node: ts.Node): { kind: Declaration["kind"]; descriptor: "type" | "method" | "term" } | null {
	if (ts.isClassDeclaration(node)) return { kind: "class", descriptor: "type" };
	if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
		return { kind: "interface", descriptor: "type" };
	}
	if (ts.isEnumDeclaration(node)) return { kind: "enum", descriptor: "type" };
	if (ts.isModuleDeclaration(node)) return { kind: "namespace", descriptor: "type" };
	if (ts.isVariableDeclaration(node)) {
		const list = node.parent;
		return {
			kind:
				ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 ? "constant" : "variable",
			descriptor: "term",
		};
	}
	return null;
}

function functionSignature(
	name: string,
	callable: SurfaceCallable,
	source: ts.SourceFile,
	typed: boolean,
	kind: SurfaceCallableKind,
): string {
	const typeParameters = callable.typeParameters?.map((item) => item.getText(source)).join(", ");
	const parameters = callable.parameters
		.map((parameter) => (typed ? parameter.getText(source) : parameter.name.getText(source)))
		.join(", ");
	const returns = typed && callable.type !== undefined ? `: ${callable.type.getText(source)}` : "";
	const label = kind === "function" ? `function ${name}` : kind === "constructor" ? "constructor" : name;
	return `${label}${typeParameters === undefined ? "" : `<${typeParameters}>`}(${parameters})${returns}`;
}

function declarationSignature(name: string, node: ts.Node, source: ts.SourceFile): string | undefined {
	if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
		const keyword = ts.isClassDeclaration(node) ? "class" : "interface";
		const typeParameters = node.typeParameters?.map((item) => item.getText(source)).join(", ");
		return `${keyword} ${name}${typeParameters === undefined ? "" : `<${typeParameters}>`}`;
	}
	if (ts.isTypeAliasDeclaration(node)) return `type ${name} = ${node.type.getText(source)}`;
	if (ts.isEnumDeclaration(node)) return `enum ${name}`;
	if (ts.isVariableDeclaration(node)) return node.getText(source);
	return undefined;
}

function declarationImports(source: ts.SourceFile): Import[] {
	const imports: Import[] = [];
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
		const specifier = statement.moduleSpecifier;
		if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
		const imported: ImportedName[] = [];
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (clause?.name !== undefined) imported.push(importedName(source, undefined, clause.name));
			if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements) {
					imported.push(
						importedName(
							source,
							element.propertyName ?? element.name,
							element.propertyName ? element.name : undefined,
						),
					);
				}
			}
			if (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
				imported.push(importedName(source, undefined, clause.namedBindings.name));
			}
		} else if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) {
				imported.push(
					importedName(
						source,
						element.propertyName ?? element.name,
						element.propertyName ? element.name : undefined,
					),
				);
			}
		}
		imports.push({ specifier: specifier.text, imported, reExport: ts.isExportDeclaration(statement) });
	}
	return imports;
}

function importedName(
	source: ts.SourceFile,
	name: ts.Identifier | ts.StringLiteral | undefined,
	local: ts.Identifier | ts.StringLiteral | undefined,
): ImportedName {
	return {
		...(name === undefined ? {} : { name: name.text, range: rangeOf(name, source) }),
		...(local === undefined ? {} : { local: local.text, localRange: rangeOf(local, source) }),
	};
}

function syntaxDiagnostics(module: string, source: ts.SourceFile): Diagnostic[] {
	const diagnostics =
		(source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
	const coordinates = coordinatesOf(source.text);
	return diagnostics.map((diagnostic) => {
		const range =
			diagnostic.start === undefined || diagnostic.length === undefined
				? undefined
				: coordinates.rangeAt(diagnostic.start, diagnostic.start + diagnostic.length);
		return {
			severity: "error",
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
			path: module,
			...(range === undefined ? {} : { range }),
		};
	});
}

////////////////////////////////
//  Syntax Helpers

function rangeOf(node: ts.Node, source: ts.SourceFile) {
	return {
		start: source.getLineAndCharacterOfPosition(node.getStart(source)),
		end: source.getLineAndCharacterOfPosition(node.getEnd()),
	};
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function isPublicMember(node: ts.Node): boolean {
	if (hasModifier(node, ts.SyntaxKind.PrivateKeyword) || hasModifier(node, ts.SyntaxKind.ProtectedKeyword))
		return false;
	const name = nameNode(node);
	return name === undefined || !ts.isPrivateIdentifier(name);
}

function nodeName(node: ts.Node): string | null {
	const name = nameNode(node);
	return name === undefined ? null : propertyNameText(name);
}

function nameNode(node: ts.Node): ts.PropertyName | undefined {
	return (node as { name?: ts.PropertyName }).name;
}

function propertyNameText(name: ts.PropertyName): string | null {
	if (
		ts.isIdentifier(name) ||
		ts.isPrivateIdentifier(name) ||
		ts.isStringLiteral(name) ||
		ts.isNumericLiteral(name)
	) {
		return name.text;
	}
	return null;
}

function defaultToken(node: ts.Node, source: ts.SourceFile): ts.Node | undefined {
	return (
		(ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.find(
			(modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
		) ?? node.getChildren(source).find((child) => child.kind === ts.SyntaxKind.DefaultKeyword)
	);
}

function constructorToken(node: ts.ConstructorDeclaration, source: ts.SourceFile): ts.Node | undefined {
	return node.getChildren(source).find((child) => child.kind === ts.SyntaxKind.ConstructorKeyword);
}

function commonJsExportName(node: ts.Expression): string | null {
	if (ts.isPropertyAccessExpression(node)) {
		if (ts.isIdentifier(node.expression) && node.expression.text === "exports") return node.name.text;
		if (isModuleExports(node.expression)) return node.name.text;
	}
	if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined) {
		const target = node.expression;
		if ((ts.isIdentifier(target) && target.text === "exports") || isModuleExports(target)) {
			const argument = node.argumentExpression;
			if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) return argument.text;
		}
	}
	return null;
}

function isModuleExports(node: ts.Expression): boolean {
	return (
		ts.isPropertyAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "module" &&
		node.name.text === "exports"
	);
}

function propertyNameNode(node: ts.Expression): ts.Node | undefined {
	if (ts.isPropertyAccessExpression(node)) return node.name;
	if (ts.isElementAccessExpression(node)) return node.argumentExpression;
	return undefined;
}
