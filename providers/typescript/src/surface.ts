import {
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	defined,
	type FileRole,
	type Import,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { isDeclarationModule } from "./bundle.js";
import { LANGUAGE } from "./extract.js";
import { fileRoleOf } from "./file-role.js";
import { scriptKindOf } from "./file-types.js";
import { headerOf } from "./header.js";
import { importOf } from "./imports.js";
import { ownedTypeLiterals } from "./members.js";

////////////////////////////////
//  Interfaces & Types

export interface SurfaceFacts {
	declarations: Declaration[];
	references: [];
	imports: Import[];
	literals: [];
	comments: [];
	diagnostics: Diagnostic[];
	role: FileRole;
}

interface ExportedNode {
	name: string;
	node: ts.Node;
	selection: ts.Node | undefined;
}

/** A declaration its members sit under. */
interface Owner {
	symbolId: string;
	descriptors: Descriptor[];
	/** Its members leave the module. */
	exported: boolean;
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
		role: fileRoleOf(source),
	};
}

function runtimeSurface(module: string, source: ts.SourceFile): Declaration[] {
	const exported = exportedNodes(source, false).filter((item) => callableOf(item.node) !== undefined);
	const declarations: Declaration[] = [];
	const occurrences = new Map<string, number>();
	for (const item of exported) {
		const callable = callableOf(item.node);
		if (callable === undefined) continue;
		recordFunction(module, source, declarations, occurrences, item.name, callable, item.selection, item.node);
	}
	return declarations;
}

function declarationSurface(module: string, source: ts.SourceFile): Declaration[] {
	const declarations: Declaration[] = [];
	const occurrences = new Map<string, number>();
	for (const item of [...exportedNodes(source, true), ...ambientNodes(source)]) {
		const callable = callableOf(item.node);
		if (callable !== undefined) {
			recordFunction(module, source, declarations, occurrences, item.name, callable, item.selection, item.node);
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
			// A named default keeps its name, as the full extractor and the checker name it.
			const localName = nodeName(node);
			const name = localName ?? (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : null);
			if (name !== null) add(name, node, localName === null ? defaultToken(statement, source) : nameNode(node));
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

/** What other files see without importing: a script's declarations, and `declare global` or `declare module` blocks. */
function ambientNodes(source: ts.SourceFile): ExportedNode[] {
	const script = !ts.isExternalModule(source);
	const found: ExportedNode[] = [];
	for (const statement of source.statements) {
		const ambient =
			ts.isModuleDeclaration(statement) &&
			(ts.isStringLiteral(statement.name) || (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0);
		if (!script && !ambient) continue;
		const nodes = ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [statement];
		for (const node of nodes) {
			const name = nodeName(node);
			if (name !== null) found.push({ name, node, selection: nameNode(node) });
		}
	}
	return found;
}

function localNodes(source: ts.SourceFile): Map<string, ts.Node[]> {
	const found = new Map<string, ts.Node[]>();
	const add = (name: string, node: ts.Node) => {
		const nodes = found.get(name);
		if (nodes === undefined) found.set(name, [node]);
		else nodes.push(node);
	};
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
	/** The exported node; its header is the signature. */
	exported: ts.Node,
	container?: Owner,
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
		exported: container?.exported ?? true,
		metrics: { lines: range.end.line - range.start.line + 1, parameters: callable.parameters.length },
		...defined({ signature: headerOf(holderOf(exported), source) }),
		...(container === undefined ? {} : { containerId: container.symbolId }),
	});
	const owner = { symbolId, descriptors, exported: false };
	const properties = kind === "constructor" ? container : undefined;
	recordParameters(module, source, declarations, occurrences, callable.parameters, owner, properties);
}

function recordDeclaration(
	module: string,
	source: ts.SourceFile,
	declarations: Declaration[],
	occurrences: Map<string, number>,
	item: ExportedNode,
	container?: Owner,
): void {
	const classified = declarationKind(item.node);
	if (classified === null) return;
	const parents = container?.descriptors ?? [];
	const descriptors = [...parents, descriptor(occurrences, parents, classified.descriptor, item.name)];
	const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
	const range = rangeOf(item.node, source);
	const named = item.selection ?? nameNode(item.node);
	const exported = container?.exported ?? true;
	declarations.push({
		symbolId,
		kind: classified.kind,
		name: item.name,
		range,
		...(named === undefined ? {} : { selectionRange: rangeOf(named, source) }),
		visibility: "public",
		exported,
		metrics: { lines: range.end.line - range.start.line + 1 },
		...defined({ languageKind: classified.languageKind, signature: headerOf(item.node, source) }),
		...(container === undefined ? {} : { containerId: container.symbolId }),
	});
	const owner = { symbolId, descriptors, exported };
	if (ts.isEnumDeclaration(item.node)) {
		recordEnumMembers(module, source, declarations, occurrences, item.node, owner);
		return;
	}
	if (ts.isModuleDeclaration(item.node)) {
		recordNamespaceBody(module, source, declarations, occurrences, item.node, owner);
		return;
	}
	const bodies =
		ts.isClassDeclaration(item.node) || ts.isInterfaceDeclaration(item.node)
			? [item.node.members]
			: ownedTypeLiterals(item.node).map((literal) => literal.members);
	for (const members of bodies) recordMembers(module, source, declarations, occurrences, members, owner);
}

function recordEnumMembers(
	module: string,
	source: ts.SourceFile,
	declarations: Declaration[],
	occurrences: Map<string, number>,
	node: ts.EnumDeclaration,
	owner: Owner,
): void {
	for (const member of node.members) {
		const name = propertyNameText(member.name as ts.PropertyName);
		if (name === null) continue;
		const descriptors = [...owner.descriptors, descriptor(occurrences, owner.descriptors, "term", name)];
		const range = rangeOf(member, source);
		declarations.push({
			symbolId: composeSymbolId({ language: LANGUAGE, module, descriptors }),
			kind: "constant",
			name,
			range,
			selectionRange: rangeOf(member.name, source),
			visibility: "public",
			exported: owner.exported,
			containerId: owner.symbolId,
			metrics: { lines: range.end.line - range.start.line + 1 },
			...defined({ signature: headerOf(member, source) }),
		});
	}
}

/** What a namespace exports: every member, unless it names its exports. */
function recordNamespaceBody(
	module: string,
	source: ts.SourceFile,
	declarations: Declaration[],
	occurrences: Map<string, number>,
	node: ts.ModuleDeclaration,
	owner: Owner,
): void {
	const body = node.body;
	// `namespace A.B` nests B in A.
	if (body !== undefined && ts.isModuleDeclaration(body)) {
		const item = { name: body.name.text, node: body, selection: body.name };
		recordDeclaration(module, source, declarations, occurrences, item, owner);
		return;
	}
	if (body === undefined || !ts.isModuleBlock(body)) return;
	const implicit = !body.statements.some(
		(statement) => ts.isExportDeclaration(statement) || ts.isExportAssignment(statement),
	);
	for (const statement of body.statements) {
		if (!implicit && !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
		const members = ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [statement];
		for (const member of members) {
			const name = nodeName(member);
			if (name === null) continue;
			const selection = nameNode(member);
			const callable = callableOf(member);
			if (callable === undefined) {
				recordDeclaration(module, source, declarations, occurrences, { name, node: member, selection }, owner);
				continue;
			}
			recordFunction(
				module,
				source,
				declarations,
				occurrences,
				name,
				callable,
				selection,
				member,
				owner,
				"function",
			);
		}
	}
}

function recordMembers(
	module: string,
	source: ts.SourceFile,
	declarations: Declaration[],
	occurrences: Map<string, number>,
	members: ts.NodeArray<ts.ClassElement | ts.TypeElement>,
	owner: Owner,
): void {
	for (const member of members) {
		if (!isPublicMember(member)) continue;
		if (ts.isConstructorDeclaration(member)) {
			const token = constructorToken(member, source);
			recordFunction(
				module,
				source,
				declarations,
				occurrences,
				"constructor",
				member,
				token,
				member,
				owner,
				"constructor",
			);
			continue;
		}
		if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
			const name = propertyNameText(member.name);
			if (name !== null) {
				recordFunction(module, source, declarations, occurrences, name, member, member.name, member, owner);
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
		const property = recordProperty(module, source, declarations, occurrences, member, name, member.name, owner);
		if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
			recordParameters(module, source, declarations, occurrences, member.parameters, property);
		}
	}
}

/** A property, and the members of its own object types beneath it, as the full extractor holds them. */
function recordProperty(
	module: string,
	source: ts.SourceFile,
	declarations: Declaration[],
	occurrences: Map<string, number>,
	node: ts.Node,
	name: string,
	nameNode: ts.Node,
	owner: Owner,
): Owner {
	const descriptors = [...owner.descriptors, descriptor(occurrences, owner.descriptors, "term", name)];
	const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
	const range = rangeOf(node, source);
	declarations.push({
		symbolId,
		kind: "property",
		name,
		range,
		selectionRange: rangeOf(nameNode, source),
		visibility: "public",
		exported: owner.exported,
		containerId: owner.symbolId,
		metrics: { lines: range.end.line - range.start.line + 1 },
		...defined({ signature: headerOf(node, source) }),
	});
	const property = { symbolId, descriptors, exported: owner.exported };
	for (const literal of ownedTypeLiterals(node)) {
		recordMembers(module, source, declarations, occurrences, literal.members, property);
	}
	return property;
}

/** A constructor's parameter property is its class's property, which `properties` holds. */
function recordParameters(
	module: string,
	source: ts.SourceFile,
	declarations: Declaration[],
	occurrences: Map<string, number>,
	parameters: ts.NodeArray<ts.ParameterDeclaration>,
	owner: Owner,
	properties?: Owner,
): void {
	for (const parameter of parameters) {
		if (properties !== undefined && ts.isParameterPropertyDeclaration(parameter, parameter.parent)) {
			if (isPublicMember(parameter) && ts.isIdentifier(parameter.name)) {
				const name = parameter.name.text;
				recordProperty(module, source, declarations, occurrences, parameter, name, parameter.name, properties);
			}
			continue;
		}
		for (const binding of parameterBindings(parameter.name)) {
			const descriptors = [
				...owner.descriptors,
				descriptor(occurrences, owner.descriptors, "term", binding.text, "parameter"),
			];
			const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
			declarations.push({
				symbolId,
				kind: "variable",
				name: binding.text,
				range: rangeOf(parameter, source),
				selectionRange: rangeOf(binding, source),
				visibility: "local",
				exported: false,
				containerId: owner.symbolId,
			});
			if (binding !== parameter.name) continue;
			const local = { symbolId, descriptors, exported: false };
			for (const literal of ownedTypeLiterals(parameter)) {
				recordMembers(module, source, declarations, occurrences, literal.members, local);
			}
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
	kind: "type" | "method" | "term" | "namespace",
	name: string,
	descriptorKind: "type" | "method" | "term" | "namespace" | "parameter" = kind,
): Descriptor {
	if (descriptorKind !== "method") return { kind: descriptorKind, name };
	const key = `${parents.map((item) => `${item.kind}:${item.name}`).join("/")}/${descriptorKind}:${name}`;
	const ordinal = occurrences.get(key) ?? 0;
	occurrences.set(key, ordinal + 1);
	return ordinal === 0
		? { kind: descriptorKind, name }
		: { kind: descriptorKind, name, disambiguator: String(ordinal) };
}

function declarationKind(
	node: ts.Node,
): { kind: Declaration["kind"]; descriptor: "type" | "method" | "term" | "namespace"; languageKind?: string } | null {
	if (ts.isClassDeclaration(node)) return { kind: "class", descriptor: "type" };
	if (ts.isInterfaceDeclaration(node)) return { kind: "interface", descriptor: "type" };
	if (ts.isTypeAliasDeclaration(node)) return { kind: "interface", descriptor: "type", languageKind: "typeAlias" };
	if (ts.isEnumDeclaration(node)) return { kind: "enum", descriptor: "type" };
	if (ts.isModuleDeclaration(node)) {
		return { kind: ts.isStringLiteral(node.name) ? "module" : "namespace", descriptor: "namespace" };
	}
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

/** The statement or assignment writing an exported function value, else the node itself. */
function holderOf(node: ts.Node): ts.Node {
	let value = node;
	while (
		ts.isParenthesizedExpression(value.parent) ||
		ts.isAsExpression(value.parent) ||
		ts.isTypeAssertionExpression(value.parent) ||
		ts.isSatisfiesExpression(value.parent) ||
		ts.isNonNullExpression(value.parent)
	) {
		value = value.parent;
	}
	const parent = value.parent;
	if (ts.isExportAssignment(parent) || ts.isPropertyAssignment(parent)) return parent;
	if (ts.isBinaryExpression(parent) && parent.right === value) return parent;
	return node;
}

/** The file's imports, and those inside its namespace and `declare module` bodies. */
function declarationImports(source: ts.SourceFile): Import[] {
	const imports: Import[] = [];
	const visit = (statements: readonly ts.Statement[]): void => {
		for (const statement of statements) {
			if (ts.isModuleDeclaration(statement)) {
				let body = statement.body;
				while (body !== undefined && ts.isModuleDeclaration(body)) body = body.body;
				if (body !== undefined && ts.isModuleBlock(body)) visit(body.statements);
				continue;
			}
			const importing =
				ts.isImportDeclaration(statement) ||
				ts.isExportDeclaration(statement) ||
				ts.isImportEqualsDeclaration(statement);
			if (!importing) continue;
			const read = importOf(statement, source);
			if (read !== undefined) imports.push(read);
		}
	};
	visit(source.statements);
	return imports;
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
			...defined({ range }),
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
