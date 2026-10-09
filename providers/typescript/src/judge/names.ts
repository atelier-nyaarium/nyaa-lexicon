// Names: what a name or import binding reads, with imports resolved one export at a time.

import ts from "typescript";
import { immediateAliasTarget } from "../aliases.js";
import { type Flow, type Frame, input, literal, UNDEFINED, UNKNOWN, type Value } from "./model.js";
import {
	bindingKind,
	declarationOf,
	hasModifier,
	importedBy,
	inputDomain,
	isAmbient,
	isExternal,
	isModuleScoped,
	isPureLibrary,
	memberName,
	moduleSymbol,
	specifierOf,
	valueDeclaration,
} from "./symbols.js";
import type { Read, Step, Walker } from "./walker.js";

////////////////////////////////
//  Names

/** An input: any value its declared type allows, varying with the name read, or the site where none is. */
function inputAt(w: Walker, node: ts.Node, symbol?: ts.Symbol): Value {
	return input(inputDomain(w.checker, node), symbol ?? node);
}

/**
 * A name nothing in the workspace declares: `undefined`, `require`, `module`, `exports`, the
 * language's own library, or what the host or a package gives, an input.
 */
function builtinName(w: Walker, node: ts.Identifier, frame: Frame, symbol?: ts.Symbol): Value {
	const record = w.modules.get(frame.module);
	switch (node.text) {
		case "undefined":
			return UNDEFINED;
		case "require":
			return { kind: "builtin", name: "require" };
		case "module":
			return record?.runtime === "cjs" ? { kind: "module", module: frame.module } : UNKNOWN;
		case "exports":
			return record?.runtime === "cjs" ? record.exportsVariable : UNKNOWN;
		case "NaN":
			return isPureLibrary(w.pinned, symbol) ? literal(Number.NaN) : inputAt(w, node, symbol);
		case "Infinity":
			return isPureLibrary(w.pinned, symbol) ? literal(Number.POSITIVE_INFINITY) : inputAt(w, node, symbol);
		default: {
			if (!isPureLibrary(w.pinned, symbol)) return inputAt(w, node, symbol);
			const type = w.checker.getTypeAtLocation(node);
			if ((type.flags & ts.TypeFlags.Object) === 0) return UNKNOWN;
			const callable = type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
			return { kind: "builtin", name: "library", callable };
		}
	}
}

/**
 * Whether `require`, `module` or `exports` names what the runtime provides. The checker binds
 * `exports` in `exports.x = v` to `x` itself, so the name is resolved in scope instead.
 */
export function isRuntimeName(w: Walker, node: ts.Identifier): boolean {
	if (node.text !== "require" && node.text !== "module" && node.text !== "exports") return false;
	const symbol = w.checker.resolveName(node.text, node, ts.SymbolFlags.Value, false);
	if (symbol === undefined) return true;
	if ((symbol.flags & ts.SymbolFlags.ModuleExports) !== 0) return true;
	const declarations = symbol.declarations ?? [];
	return declarations.every((declaration) => ts.isSourceFile(declaration) || isExternal(w.pinned, declaration));
}

/** A const enum's members are inlined unless isolated compilation keeps them as reads. */
function inlined(w: Walker, declaration: ts.Node, module: string): boolean {
	if (!ts.isEnumDeclaration(declaration) || !hasModifier(declaration, ts.SyntaxKind.ConstKeyword)) return false;
	const options = w.pinned.options(module);
	return options.isolatedModules !== true && options.verbatimModuleSyntax !== true;
}

/** Reads a name: a binding of this or another module, a local, or a builtin. */
export function* readName(w: Walker, node: ts.Identifier, frame: Frame, flow: Flow): Step<Value> {
	const { checker } = w;
	if (isRuntimeName(w, node)) return builtinName(w, node, frame);
	const symbol =
		ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
			? checker.getShorthandAssignmentValueSymbol(node.parent)
			: checker.getSymbolAtLocation(node);
	if (symbol === undefined) return builtinName(w, node, frame);
	const read: Read = { node, module: frame.module, name: node.text };
	if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) return yield* readAlias(w, symbol, read, frame, flow);
	const declaration = declarationOf(symbol);
	if (declaration === undefined || isExternal(w.pinned, declaration)) return builtinName(w, node, frame, symbol);
	// An ambient declaration's value is the environment's; an inlined constant the walk does not compute.
	if (isAmbient(declaration)) return inputAt(w, node, symbol);
	if (inlined(w, declaration, frame.module)) return UNKNOWN;
	w.touch(declaration);
	return yield* declared(w, declaration, read, frame, flow);
}

/** A name's own declaration in the workspace, read as the runtime would. */
function* declared(w: Walker, declaration: ts.Declaration, read: Read, frame: Frame, flow: Flow): Step<Value> {
	if (ts.isEnumMember(declaration)) {
		const owner = enumValue(w, declaration.parent, read, frame, flow);
		return yield* w.member(owner, memberName(declaration.name), read.node, frame, flow);
	}
	if (ts.isClassLike(declaration) && declaration.pos <= read.node.pos && read.node.end <= declaration.end) {
		// The class's own name inside its body reads the inner binding, which a class decorator may replace.
		const inner = w.classes.get(declaration);
		return inner === undefined || w.decorations.get(inner.id)?.replacedClass === true ? UNKNOWN : inner;
	}
	const namespace = exportingNamespace(declaration);
	if (namespace !== undefined) {
		const object = w.namespaceObject(frame, namespace);
		if (object === undefined) return UNKNOWN;
		return yield* w.member({ kind: "object", id: object.id }, read.name, read.node, frame, flow);
	}
	if (isModuleScoped(declaration)) return w.readBinding(declaration, read, flow);
	return readLocal(w, declaration, frame, flow);
}

/** The scope a local's binding belongs to: the function, static block or namespace body around it. */
function scopeOf(declaration: ts.Node): ts.Node | undefined {
	for (let at: ts.Node | undefined = declaration.parent; at !== undefined; at = at.parent) {
		if (ts.isFunctionLike(at) || ts.isClassStaticBlockDeclaration(at)) return at;
		if (ts.isModuleBlock(at)) return at.parent;
		if (ts.isSourceFile(at)) return at;
	}
	return undefined;
}

/**
 * A local's value at a read. One whose scope is running but which is not set yet is a `var` before its
 * declarator, holding undefined, or a `let`, `const` or class in its temporal dead zone, which throws.
 */
function readLocal(w: Walker, declaration: ts.Node, frame: Frame, flow: Flow): Value {
	for (let scope: Frame | null = frame; scope !== null; scope = scope.parent) {
		const value = scope.vars.get(declaration);
		if (value !== undefined) return value;
	}
	const home = scopeOf(declaration);
	let running = false;
	for (let scope: Frame | null = frame; scope !== null && !running; scope = scope.parent)
		running = scope.fn === home || (scope.fn === null && home !== undefined && ts.isSourceFile(home));
	if (!running) return UNKNOWN;
	const kind = bindingKind(declaration);
	if (kind === "var") return UNDEFINED;
	if (kind === "let" || kind === "const" || kind === "class") w.throwExit(flow, false);
	return UNKNOWN;
}

/** The namespace a declaration is an export of, read inside it as a member of its object. */
function exportingNamespace(declaration: ts.Node): ts.ModuleDeclaration | undefined {
	const statement =
		ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)
			? ts.findAncestor(declaration, ts.isVariableStatement)
			: declaration;
	if (statement === undefined || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return undefined;
	const block = statement.parent;
	return ts.isModuleBlock(block) ? block.parent : undefined;
}

function enumValue(w: Walker, node: ts.EnumDeclaration, read: Read, frame: Frame, flow: Flow): Value {
	const first = declarationOf(w.checker.getSymbolAtLocation(node.name)) ?? node;
	if (isModuleScoped(first)) return w.readBinding(first, read, flow);
	return readLocal(w, first, frame, flow);
}

/** An import binding: a compiled capture's property, a namespace, or an export resolved step by step. */
function* readAlias(w: Walker, symbol: ts.Symbol, read: Read, frame: Frame, flow: Flow): Step<Value> {
	const declaration = declarationOf(symbol);
	if (declaration === undefined) return UNKNOWN;
	// What a package exports is an input to the workspace.
	if (isExternal(w.pinned, declaration)) return inputAt(w, read.node, symbol);
	w.touch(declaration);
	// `const x = require()` in JavaScript and `import x = require()` are bindings set where they stand.
	if (
		ts.isVariableDeclaration(declaration) ||
		ts.isBindingElement(declaration) ||
		ts.isImportEqualsDeclaration(declaration)
	)
		return yield* declared(w, declaration, read, frame, flow);
	const imported = importedBy(declaration);
	const module = w.pinned.moduleOf(declaration.getSourceFile());
	const record = module === null ? undefined : w.modules.get(module);
	if (imported === undefined || module === null || record === undefined) {
		w.note(read.node);
		return UNKNOWN;
	}
	const specifier = specifierOf(imported.statement);
	const target = specifier === undefined ? null : w.pinned.target(module, specifier);
	if (target === null) return inputAt(w, read.node, symbol);
	if (record.runtime === "cjs") {
		const captured = record.captures.get(imported.statement);
		if (captured === undefined) {
			// An import emit drops is only read where its value is inlined.
			if (w.pinned.statementLoads(module, imported.statement) === false) return UNKNOWN;
			// Its compiled `const x_1 = require()` has not run yet.
			const target = { module, name: read.name, kind: "import" };
			w.throwExit(flow, !w.hazard(read, target, flow, valueDeclaration(w.checker, symbol)));
			return UNKNOWN;
		}
		const compiled = w.modules.get(target)?.esmSyntax !== false;
		if (imported.imported === "*") {
			if (!compiled) w.note(read.node);
			return compiled ? captured : UNKNOWN;
		}
		if (imported.imported === "default" && !compiled && w.pinned.options(module).esModuleInterop === true)
			return captured;
		return yield* w.member(captured, imported.imported, read.node, frame, flow);
	}
	if (imported.imported === "*") return { kind: "namespace", module: target };
	const next = immediateAliasTarget(w.checker, symbol);
	return resolveExported(w, next, target, read, flow);
}

/** `ns.name` on an ECMAScript namespace: the export of that name, resolved step by step. */
export function readExport(w: Walker, module: string, name: string, node: ts.Node, frame: Frame, flow: Flow): Value {
	const source = w.pinned.sourceOf(module);
	const symbol = source === undefined ? undefined : moduleSymbol(w.checker, source);
	if (symbol === undefined) {
		w.note(node);
		return UNKNOWN;
	}
	const exported = w.checker.getExportsOfModule(symbol).find((item) => item.name === name);
	if (exported === undefined) return UNDEFINED;
	return resolveExported(w, exported, module, { node, module: frame.module, name }, flow);
}

/**
 * Follows an export one step at a time. `export { a as b }`, `export { x } from` and `export *` are
 * live aliases; `export default <expression>` is its own binding, set when that statement completes.
 */
function resolveExported(w: Walker, start: ts.Symbol | undefined, expected: string, read: Read, flow: Flow): Value {
	const { checker } = w;
	let current = start;
	let module = expected;
	for (let hop = 0; hop < 32; hop++) {
		if (current === undefined || checker.isUnknownSymbol(current)) break;
		const declaration = declarationOf(current);
		if (declaration === undefined) break;
		const at = w.pinned.moduleOf(declaration.getSourceFile());
		if (at === null) return UNKNOWN;
		if (!reaches(w, module, at)) break;
		w.touch(declaration);
		if ((current.flags & ts.SymbolFlags.Alias) === 0 || ts.isExportAssignment(declaration)) {
			if (inlined(w, declaration, read.module)) return UNKNOWN;
			if (isAmbient(declaration)) return UNKNOWN;
			if (isModuleScoped(declaration)) return w.readBinding(declaration, read, flow);
			break;
		}
		if (ts.isExportSpecifier(declaration)) {
			const statement = declaration.parent.parent;
			const specifier = specifierOf(statement);
			const next = specifier === undefined ? at : w.pinned.target(at, specifier);
			if (next === null) return UNKNOWN;
			module = next;
		} else if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
			const imported = importedBy(declaration);
			const specifier = imported === undefined ? undefined : specifierOf(imported.statement);
			const next = specifier === undefined ? null : w.pinned.target(at, specifier);
			if (next === null) return UNKNOWN;
			module = next;
		} else if (ts.isNamespaceImport(declaration) || ts.isNamespaceExport(declaration)) {
			const statement = ts.isNamespaceImport(declaration) ? declaration.parent.parent : declaration.parent;
			const specifier = specifierOf(statement as ts.Statement);
			const next = specifier === undefined ? null : w.pinned.target(at, specifier);
			return next === null ? UNKNOWN : { kind: "namespace", module: next };
		} else if (isModuleScoped(declaration)) {
			return w.readBinding(declaration, read, flow);
		} else break;
		current = immediateAliasTarget(checker, current);
	}
	w.note(read.node);
	return UNKNOWN;
}

/** Whether `to` is `from` or one of the modules its `export *` statements reach. */
function reaches(w: Walker, from: string, to: string): boolean {
	if (from === to) return true;
	const seen = new Set([from]);
	const pending = [from];
	while (pending.length > 0) {
		const module = pending.pop() as string;
		const source = w.pinned.sourceOf(module);
		if (source === undefined) continue;
		for (const statement of source.statements) {
			if (!ts.isExportDeclaration(statement) || statement.exportClause !== undefined || statement.isTypeOnly)
				continue;
			const specifier = specifierOf(statement);
			const next = specifier === undefined ? null : w.pinned.target(module, specifier);
			if (next === null || seen.has(next)) continue;
			w.pinned.touch(next);
			if (next === to) return true;
			seen.add(next);
			pending.push(next);
		}
	}
	return false;
}
