// What the checker says about a name, read the way the load model needs it.

import ts from "typescript";
import { boundNames } from "../declarations.js";
import { type Domain, domainOf, exactly, union } from "./domains.js";
import type { PinnedProgram } from "./program.js";
import { isAssigned, type Writes } from "./writes.js";

////////////////////////////////
//  Interfaces & Types

/** What a decorated member's design metadata reads at decoration. */
export type MetadataRead =
	| { readonly kind: "none" }
	| { readonly kind: "read"; readonly name: ts.Identifier }
	| { readonly kind: "unknown" };

////////////////////////////////
//  Constants

const DEFERRED_GLOBALS = new Set(["setTimeout", "setInterval", "queueMicrotask"]);

/** Library methods whose callbacks run after the current job: by declaring type, then name. */
const DEFERRED_METHODS = new Map<string, ReadonlySet<string>>([
	["Promise", new Set(["then", "catch", "finally"])],
	["EventTarget", new Set(["addEventListener"])],
	["EventEmitter", new Set(["on", "once"])],
	["Process", new Set(["nextTick"])],
]);

/** Type nodes design metadata serializes without naming a binding. */
const UNNAMED_TYPES = new Set([
	ts.SyntaxKind.StringKeyword,
	ts.SyntaxKind.NumberKeyword,
	ts.SyntaxKind.BooleanKeyword,
	ts.SyntaxKind.BigIntKeyword,
	ts.SyntaxKind.SymbolKeyword,
	ts.SyntaxKind.VoidKeyword,
	ts.SyntaxKind.UndefinedKeyword,
	ts.SyntaxKind.NeverKeyword,
	ts.SyntaxKind.AnyKeyword,
	ts.SyntaxKind.UnknownKeyword,
	ts.SyntaxKind.ObjectKeyword,
	ts.SyntaxKind.ArrayType,
	ts.SyntaxKind.TupleType,
	ts.SyntaxKind.TypeLiteral,
	ts.SyntaxKind.FunctionType,
	ts.SyntaxKind.ConstructorType,
]);

const ARRAY_NAMES = new Set(["Array", "ReadonlyArray"]);

/** Library files describing the host: the DOM, workers, script hosts. */
const HOST_LIBRARY = /^lib\.(dom|webworker|scripthost)\b/;

/** Library owners whose members read the clock or the locale. */
const CLOCK_OR_LOCALE = new Set(["Date", "DateConstructor", "Intl"]);

/** How deep a type is searched for code it might carry. */
const TYPE_DEPTH = 3;

////////////////////////////////
//  Functions & Helpers

/** A symbol's value declaration; an overloaded function's is its implementation. */
export function declarationOf(symbol: ts.Symbol | undefined): ts.Declaration | undefined {
	const declarations = symbol?.declarations ?? [];
	const implementation = declarations.find(
		(declaration) => ts.isFunctionDeclaration(declaration) && declaration.body !== undefined,
	);
	return implementation ?? symbol?.valueDeclaration ?? declarations[0];
}

export function unwrapExpression(node: ts.Expression): ts.Expression {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isPartiallyEmittedExpression(current)
	)
		current = current.expression;
	return current;
}

/** Declared with `declare`, inside an ambient declaration, or in a declaration file: no runtime binding. */
export function isAmbient(node: ts.Node): boolean {
	if (node.getSourceFile().isDeclarationFile) return true;
	for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
		if (hasModifier(current, ts.SyntaxKind.DeclareKeyword)) return true;
	}
	return false;
}

/** The variable declaration a binding element sits in. */
export function rootVariable(node: ts.VariableDeclaration | ts.BindingElement): ts.VariableDeclaration | undefined {
	let current: ts.Node = node;
	while (ts.isBindingElement(current) || ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current))
		current = current.parent;
	return ts.isVariableDeclaration(current) ? current : undefined;
}

function insideFunction(node: ts.Node): boolean {
	for (let current = node.parent; current !== undefined && !ts.isSourceFile(current); current = current.parent) {
		if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current) || ts.isModuleBlock(current))
			return true;
	}
	return false;
}

/** Whether a declaration's binding lives at its module's top level. */
export function isModuleScoped(declaration: ts.Node): boolean {
	if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) {
		const variable = rootVariable(declaration);
		const list = variable?.parent;
		if (list === undefined || !ts.isVariableDeclarationList(list)) return false;
		const holder = list.parent;
		if (ts.isVariableStatement(holder) && ts.isSourceFile(holder.parent)) return true;
		const block = (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using)) === 0;
		return block && !insideFunction(list);
	}
	if (
		ts.isFunctionDeclaration(declaration) ||
		ts.isClassDeclaration(declaration) ||
		ts.isEnumDeclaration(declaration) ||
		ts.isModuleDeclaration(declaration) ||
		ts.isImportEqualsDeclaration(declaration)
	)
		return ts.isSourceFile(declaration.parent);
	return ts.isExportAssignment(declaration);
}

/** How a hazard names a binding's kind. */
export function bindingKind(declaration: ts.Node): string {
	if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) {
		const list = rootVariable(declaration)?.parent;
		if (list === undefined || !ts.isVariableDeclarationList(list)) return "variable";
		if ((list.flags & ts.NodeFlags.Const) !== 0) return "const";
		return (list.flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
	}
	if (ts.isFunctionDeclaration(declaration)) return "function";
	if (ts.isClassDeclaration(declaration)) return "class";
	if (ts.isEnumDeclaration(declaration)) return "enum";
	if (ts.isModuleDeclaration(declaration)) return "namespace";
	if (ts.isExportAssignment(declaration)) return "default";
	if (ts.isImportEqualsDeclaration(declaration)) return "import";
	return "binding";
}

/** A name for a declaration, as a hazard shows it. */
export function nameOfDeclaration(declaration: ts.Node): string {
	if (ts.isExportAssignment(declaration)) return "default";
	const name = (declaration as { name?: ts.Node }).name;
	if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)))
		return name.text;
	return "default";
}

/** A member's name as written, when it has a fixed one. */
export function memberName(name: ts.PropertyName | undefined): string | undefined {
	if (name === undefined) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name))
		return name.text;
	if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
	return undefined;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

/** Written with import or export declarations, which a compiler turns into an `__esModule` object. */
export function usesEsmSyntax(source: ts.SourceFile): boolean {
	return source.statements.some(
		(statement) =>
			ts.isImportDeclaration(statement) ||
			ts.isExportDeclaration(statement) ||
			(ts.isExportAssignment(statement) && statement.isExportEquals !== true) ||
			(!ts.isImportEqualsDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)),
	);
}

/** An `await` evaluated by the module body itself, which makes evaluation asynchronous. */
export function hasTopLevelAwait(source: ts.SourceFile): boolean {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
		if (
			ts.isAwaitExpression(node) ||
			(ts.isForOfStatement(node) && node.awaitModifier !== undefined) ||
			(ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing)
		) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	for (const statement of source.statements) visit(statement);
	return found;
}

/**
 * Each local declaration's names in its module's exports: an `export` modifier, or a local
 * `export { a as b }` naming it. A compiler targeting CommonJS assigns each when the binding is set.
 */
export function exportNamesOf(source: ts.SourceFile, checker: ts.TypeChecker): Map<ts.Node, string[]> {
	const names = new Map<ts.Node, string[]>();
	const add = (node: ts.Node, name: string) => names.set(node, [...(names.get(node) ?? []), name]);
	for (const statement of source.statements) {
		if (ts.isExportDeclaration(statement)) {
			const clause = statement.exportClause;
			if (statement.moduleSpecifier !== undefined || statement.isTypeOnly) continue;
			if (clause === undefined || !ts.isNamedExports(clause)) continue;
			for (const element of clause.elements) {
				if (element.isTypeOnly) continue;
				const local = checker.getExportSpecifierLocalTargetSymbol(element);
				if (local === undefined || (local.flags & ts.SymbolFlags.Alias) !== 0) continue;
				const declaration = declarationOf(local);
				if (declaration !== undefined) add(declaration, element.name.text);
			}
			continue;
		}
		if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword) || ts.isImportEqualsDeclaration(statement)) continue;
		if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
			add(statement, "default");
			continue;
		}
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				for (const binding of boundNames(declaration)) add(binding.node, binding.name.text);
			}
			continue;
		}
		const name = (statement as { name?: ts.Node }).name;
		if (name !== undefined && ts.isIdentifier(name)) add(statement, name.text);
	}
	return names;
}

/** Whether a file is outside the workspace's own code: a library, a package, a declaration file. */
export function isExternal(pinned: PinnedProgram, node: ts.Node): boolean {
	const source = node.getSourceFile();
	return source.isDeclarationFile || pinned.moduleOf(source) === null;
}

/**
 * Whether code runs in strict mode: in an ECMAScript module or a class, under a "use strict"
 * directive, or in a file TypeScript's emit marks strict: an external module, or any file under
 * `alwaysStrict`, JavaScript included.
 */
export function isStrict(pinned: PinnedProgram, node: ts.Node): boolean {
	for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) {
		if (ts.isClassLike(at)) return true;
		if (ts.isFunctionLike(at) && "body" in at && at.body !== undefined && ts.isBlock(at.body)) {
			if (directive(at.body.statements)) return true;
		}
		if (!ts.isSourceFile(at)) continue;
		if (directive(at.statements)) return true;
		const module = pinned.moduleOf(at);
		if (module === null) return false;
		if (pinned.runtime(module) === "esm") return true;
		const options = pinned.options(module);
		return ts.isExternalModule(at) || (options.alwaysStrict ?? options.strict) === true;
	}
	return false;
}

/** A primitive literal an expression spells, as a case label does; undefined for anything else. */
export function literalOf(
	node: ts.Expression,
): { value: string | number | boolean | bigint | null | undefined } | undefined {
	const held = unwrapExpression(node);
	if (ts.isStringLiteralLike(held)) return { value: held.text };
	if (ts.isNumericLiteral(held)) return { value: Number(held.text) };
	if (ts.isBigIntLiteral(held)) {
		try {
			return { value: BigInt(held.text.slice(0, -1).replaceAll("_", "")) };
		} catch {
			return undefined;
		}
	}
	if (held.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
	if (held.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
	if (held.kind === ts.SyntaxKind.NullKeyword) return { value: null };
	if (ts.isPrefixUnaryExpression(held) && held.operator === ts.SyntaxKind.MinusToken) {
		const inner = literalOf(held.operand);
		if (typeof inner?.value === "number" || typeof inner?.value === "bigint") return { value: -inner.value };
	}
	return undefined;
}

/** Whether a directive prologue holds "use strict". */
function directive(statements: ts.NodeArray<ts.Statement>): boolean {
	for (const statement of statements) {
		if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
		if (statement.expression.getText().slice(1, -1) === "use strict") return true;
	}
	return false;
}

/**
 * Whether a name is the language's own library, which computes the same on every run: not the host,
 * the clock, the locale, chance or a package, which are inputs.
 */
export function isPureLibrary(pinned: PinnedProgram, symbol: ts.Symbol | undefined): boolean {
	const declarations = symbol?.declarations ?? [];
	return declarations.length > 0 && declarations.every((declaration) => pureDeclaration(pinned, declaration));
}

function pureDeclaration(pinned: PinnedProgram, declaration: ts.Node): boolean {
	const source = declaration.getSourceFile();
	if (!pinned.program.isSourceFileDefaultLibrary(source)) return false;
	if (HOST_LIBRARY.test(source.fileName.slice(source.fileName.lastIndexOf("/") + 1))) return false;
	const name = nameOfDeclaration(declaration);
	if (name === "random" || name === "localeCompare" || name === "getTimezoneOffset" || name.startsWith("toLocale"))
		return false;
	for (let at: ts.Node | undefined = declaration; at !== undefined; at = at.parent) {
		const owner =
			ts.isInterfaceDeclaration(at) || ts.isModuleDeclaration(at) || ts.isVariableDeclaration(at)
				? at.name
				: undefined;
		if (owner !== undefined && ts.isIdentifier(owner) && CLOCK_OR_LOCALE.has(owner.text)) return false;
	}
	return true;
}

/**
 * Whether a library call runs its callbacks after the current job, as `setTimeout` and a promise's
 * `then` do, and nothing in the program replaces it.
 */
export function isDeferredCallee(
	pinned: PinnedProgram,
	writes: Writes,
	symbol: ts.Symbol | undefined,
	name: string,
): boolean {
	const declarations = symbol?.declarations ?? [];
	if (declarations.length === 0 || !declarations.every((declaration) => isExternal(pinned, declaration)))
		return false;
	if (declarations.some((declaration) => isAssigned(writes, declaration, name))) return false;
	if (DEFERRED_GLOBALS.has(name))
		return declarations.some((declaration) => ts.isFunctionDeclaration(declaration) && isGlobalScope(declaration));
	return declarations.some((declaration) => {
		const owner = declaration.parent;
		const ownerName =
			ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner) ? owner.name?.text : undefined;
		return ownerName !== undefined && DEFERRED_METHODS.get(ownerName)?.has(name) === true;
	});
}

function isGlobalScope(declaration: ts.Node): boolean {
	const parent = declaration.parent;
	if (ts.isSourceFile(parent)) return !ts.isExternalModule(parent);
	return ts.isModuleBlock(parent) && (parent.parent.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
}

/** An alias's final target, for classification only; the checker asserts on an alias it cannot place. */
function aliasTarget(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | undefined {
	try {
		return checker.getAliasedSymbol(symbol);
	} catch {
		return undefined;
	}
}

/**
 * A name's or member's declared type, not the narrower one the checker gives where it is read: what
 * an input may hold whatever ran before. `missing` where an index signature may find no property.
 */
export function declaredType(checker: ts.TypeChecker, node: ts.Node): { type: ts.Type; missing: boolean } {
	const parent = node.parent;
	const member =
		(ts.isElementAccessExpression(parent) && parent.argumentExpression === node) ||
		(ts.isPropertyAccessExpression(parent) && parent.name === node);
	const access = member ? parent : node;
	const name = ts.isPropertyAccessExpression(access) ? access.name : ts.isIdentifier(access) ? access : undefined;
	let symbol = name === undefined ? undefined : checker.getSymbolAtLocation(name);
	if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = aliasTarget(checker, symbol);
	if (symbol !== undefined && (symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property)) !== 0)
		return { type: checker.getTypeOfSymbol(symbol), missing: false };
	if (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) {
		const receiver = declaredType(checker, access.expression).type;
		if ((receiver.flags & ts.TypeFlags.Any) !== 0) return { type: receiver, missing: false };
		const numeric =
			ts.isElementAccessExpression(access) &&
			access.argumentExpression !== undefined &&
			(checker.getTypeAtLocation(access.argumentExpression).flags & ts.TypeFlags.NumberLike) !== 0;
		if (
			numeric &&
			ts.isElementAccessExpression(access) &&
			access.argumentExpression !== undefined &&
			checker.isTupleType(receiver)
		) {
			const index = literalOf(access.argumentExpression)?.value;
			const items = checker.getTypeArguments(receiver as ts.TypeReference);
			if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < items.length)
				return { type: items[index]!, missing: false };
		}
		const index = checker.getIndexTypeOfType(receiver, numeric ? ts.IndexKind.Number : ts.IndexKind.String);
		if (index !== undefined) return { type: index, missing: true };
	}
	return { type: checker.getTypeAtLocation(access), missing: false };
}

/** The values an input read at a node may hold, where its declared type spells them exactly. */
export function inputDomain(checker: ts.TypeChecker, node: ts.Node): Domain | undefined {
	const { type, missing } = declaredType(checker, node);
	const domain = domainOf(type);
	return domain !== undefined && missing ? union(domain, exactly(undefined)) : domain;
}

/**
 * The declaration whose value a name holds: past import and export aliases, and for a CommonJS
 * export assigned a local, or a shorthand, that local.
 */
export function valueDeclaration(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Node | undefined {
	const resolve = (held: ts.Symbol | undefined) =>
		held !== undefined && (held.flags & ts.SymbolFlags.Alias) !== 0 ? aliasTarget(checker, held) : held;
	const declaration: ts.Node | undefined = declarationOf(resolve(symbol));
	if (declaration === undefined) return undefined;
	if (ts.isShorthandPropertyAssignment(declaration))
		return declarationOf(resolve(checker.getShorthandAssignmentValueSymbol(declaration))) ?? declaration;
	const parent = declaration.parent;
	const assignment = ts.isBinaryExpression(declaration)
		? declaration
		: parent !== undefined && ts.isBinaryExpression(parent) && parent.left === declaration
			? parent
			: undefined;
	const value = assignment?.right ?? (ts.isPropertyAssignment(declaration) ? declaration.initializer : undefined);
	const local = value === undefined ? undefined : unwrapExpression(value);
	if (local === undefined || !ts.isIdentifier(local)) return declaration;
	return declarationOf(resolve(checker.getSymbolAtLocation(local))) ?? declaration;
}

/** The declaration of a module's, namespace's or enum's member, as the value it holds. */
export function memberDeclaration(
	checker: ts.TypeChecker,
	owner: ts.Symbol | undefined,
	name: string,
): ts.Node | undefined {
	if (owner === undefined) return undefined;
	const members =
		(owner.flags & ts.SymbolFlags.Enum) !== 0
			? [...(owner.exports?.values() ?? [])]
			: checker.getExportsOfModule(owner);
	return valueDeclaration(
		checker,
		members.find((member) => member.name === name),
	);
}

/** What emitted design metadata reads for a type annotation (rule 16). */
export function metadataRead(pinned: PinnedProgram, annotation: ts.TypeNode | undefined): MetadataRead {
	if (annotation === undefined) return { kind: "none" };
	let type = annotation;
	while (ts.isParenthesizedTypeNode(type)) type = type.type;
	if (UNNAMED_TYPES.has(type.kind)) return { kind: "none" };
	if (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword) return { kind: "none" };
	if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return { kind: "unknown" };
	if (type.typeArguments !== undefined)
		return ARRAY_NAMES.has(type.typeName.text) ? { kind: "none" } : { kind: "unknown" };
	const { checker } = pinned;
	const named = checker.getSymbolAtLocation(type.typeName);
	if (named === undefined) return { kind: "unknown" };
	const alias = (named.flags & ts.SymbolFlags.Alias) !== 0;
	const typeOnly =
		alias &&
		(named.declarations ?? []).some(
			(declaration) =>
				(ts.isImportSpecifier(declaration) &&
					(declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)) ||
				(ts.isImportClause(declaration) && declaration.isTypeOnly) ||
				(ts.isNamespaceImport(declaration) && declaration.parent.isTypeOnly),
		);
	const target = alias ? aliasTarget(checker, named) : named;
	if (target === undefined) return { kind: "unknown" };
	if ((target.flags & ts.SymbolFlags.Class) !== 0) {
		if (typeOnly) return { kind: "none" };
		const declaration = declarationOf(target);
		if (declaration === undefined) return { kind: "unknown" };
		return isExternal(pinned, declaration) ? { kind: "none" } : { kind: "read", name: type.typeName };
	}
	if ((target.flags & ts.SymbolFlags.Enum) !== 0) return { kind: "unknown" };
	if ((target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.TypeParameter)) !== 0)
		return { kind: "none" };
	return { kind: "unknown" };
}

/** Whether a value of this type may carry workspace code that a library could call. */
export function typeCarriesCode(pinned: PinnedProgram, type: ts.Type, depth = 0): boolean {
	const flags = type.flags;
	if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
	const primitive =
		ts.TypeFlags.StringLike |
		ts.TypeFlags.NumberLike |
		ts.TypeFlags.BooleanLike |
		ts.TypeFlags.BigIntLike |
		ts.TypeFlags.ESSymbolLike |
		ts.TypeFlags.Null |
		ts.TypeFlags.Undefined |
		ts.TypeFlags.Void |
		ts.TypeFlags.Never;
	if ((flags & primitive) !== 0) return false;
	if (depth >= TYPE_DEPTH) return true;
	if (type.isUnionOrIntersection()) return type.types.some((member) => typeCarriesCode(pinned, member, depth + 1));
	const symbol = type.aliasSymbol ?? type.getSymbol();
	if (symbol !== undefined && (symbol.declarations ?? []).some((declaration) => !isExternal(pinned, declaration)))
		return true;
	const { checker } = pinned;
	for (const property of checker.getPropertiesOfType(type)) {
		if ((property.declarations ?? []).some((declaration) => !isExternal(pinned, declaration))) return true;
	}
	if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
		const declared = [...type.getCallSignatures(), ...type.getConstructSignatures()].map(
			(signature) => signature.getDeclaration() as ts.Node | undefined,
		);
		if (declared.some((declaration) => declaration === undefined || !isExternal(pinned, declaration))) return true;
	}
	const reference = type as ts.TypeReference;
	const args = (flags & ts.TypeFlags.Object) !== 0 ? checker.getTypeArguments(reference) : [];
	return args.some((argument) => typeCarriesCode(pinned, argument, depth + 1));
}

/** Whether converting a value of this type to a primitive may run workspace code. */
export function typeConverts(pinned: PinnedProgram, type: ts.Type, depth = 0): boolean {
	const flags = type.flags;
	if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
	if ((flags & ts.TypeFlags.Object) === 0 && !type.isUnionOrIntersection()) return false;
	if (depth >= TYPE_DEPTH) return true;
	if (type.isUnionOrIntersection()) return type.types.some((member) => typeConverts(pinned, member, depth + 1));
	return pinned.checker
		.getPropertiesOfType(type)
		.some(
			(property) =>
				(property.name === "valueOf" ||
					property.name === "toString" ||
					property.escapedName.toString().startsWith("__@toPrimitive")) &&
				(property.declarations ?? []).some((declaration) => !isExternal(pinned, declaration)),
		);
}

/** The variables a condition reads: each name's symbol, and each member access's own. */
export function conditionSymbols(checker: ts.TypeChecker, condition: ts.Node): Set<ts.Symbol> {
	const symbols = new Set<ts.Symbol>();
	const add = (symbol: ts.Symbol | undefined) => {
		if (symbol === undefined) return;
		const alias = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
		symbols.add((alias ? aliasTarget(checker, symbol) : undefined) ?? symbol);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isTypeNode(node)) return;
		if (ts.isIdentifier(node)) {
			const parent = node.parent;
			if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
			add(checker.getSymbolAtLocation(node));
			return;
		}
		if (ts.isPropertyAccessExpression(node)) add(checker.getSymbolAtLocation(node.name));
		ts.forEachChild(node, visit);
	};
	visit(condition);
	return symbols;
}

export function specifierOf(statement: ts.Statement): ts.StringLiteral | undefined {
	const specifier =
		ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
	return specifier !== undefined && ts.isStringLiteral(specifier) ? specifier : undefined;
}

/** A module's own symbol; a CommonJS script's comes from its binder, not a location. */
export function moduleSymbol(checker: ts.TypeChecker, source: ts.SourceFile): ts.Symbol | undefined {
	return checker.getSymbolAtLocation(source) ?? (source as unknown as { symbol?: ts.Symbol }).symbol;
}

/** The import statement an import binding comes from, and the name it imports. */
export function importedBy(declaration: ts.Node): { statement: ts.ImportDeclaration; imported: string } | undefined {
	const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
	if (statement === undefined) return undefined;
	if (ts.isImportSpecifier(declaration))
		return { statement, imported: (declaration.propertyName ?? declaration.name).text };
	if (ts.isImportClause(declaration)) return { statement, imported: "default" };
	if (ts.isNamespaceImport(declaration)) return { statement, imported: "*" };
	return undefined;
}

export function isStatic(member: ts.ClassElement): boolean {
	return hasModifier(member, ts.SyntaxKind.StaticKeyword);
}
