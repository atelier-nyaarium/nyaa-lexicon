// Modules: when each loads, and what its CommonJS objects hold.

import ts from "typescript";
import {
	BudgetExceeded,
	conditional,
	type Flow,
	type Frame,
	joinValues,
	literal,
	MAX_DOWNSTREAM,
	type ModuleRecord,
	opaque,
	type TrackedObject,
	UNDEFINED,
	UNKNOWN,
	type Value,
	written,
} from "./model.js";
import {
	declarationOf,
	exportNamesOf,
	hasModifier,
	hasTopLevelAwait,
	importedBy,
	moduleSymbol,
	specifierOf,
	usesEsmSyntax,
} from "./symbols.js";
import type { Args, Step, Walker } from "./walker.js";

////////////////////////////////
//  Interfaces & Types

/** What a module's text says about its loading and exports, read once per pin. */
interface ModuleFacts {
	/** Static loader requests in source order, with what emit keeps. */
	readonly requests: ReadonlyArray<{ statement: ts.Statement; target: string | null; loads: boolean | undefined }>;
	readonly exportNames: ReadonlyMap<ts.Node, string[]>;
	/** Per import statement, local `export { x as y }` of its bindings: `*` for a namespace. */
	readonly reexports: ReadonlyMap<ts.Node, ReadonlyArray<{ name: string; imported: string }>>;
	/** Names a compiled CommonJS module sets to undefined before its body runs. */
	readonly placeholders: readonly string[];
	/** Every name the module exports somewhere; undefined when the checker cannot say. */
	readonly assigns: ReadonlySet<string> | undefined;
}

////////////////////////////////
//  Functions & Helpers

function factsOf(w: Walker, module: string, source: ts.SourceFile): ModuleFacts {
	return w.pinned.memo(`facts:${module}`, () => {
		const { checker } = w;
		const requests = source.statements.flatMap((statement) => {
			const specifier = specifierOf(statement);
			if (specifier === undefined) return [];
			return [
				{
					statement,
					target: w.pinned.target(module, specifier),
					loads: w.pinned.statementLoads(module, statement),
				},
			];
		});
		const exportNames = exportNamesOf(source, checker);
		const reexports = new Map<ts.Node, Array<{ name: string; imported: string }>>();
		const forwarded: string[] = [];
		for (const statement of source.statements) {
			if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
			const clause = statement.exportClause;
			if (statement.moduleSpecifier !== undefined) {
				if (clause !== undefined && ts.isNamespaceExport(clause)) forwarded.push(clause.name.text);
				if (clause !== undefined && ts.isNamedExports(clause))
					for (const element of clause.elements) if (!element.isTypeOnly) forwarded.push(element.name.text);
				continue;
			}
			if (clause === undefined || !ts.isNamedExports(clause)) continue;
			for (const element of clause.elements) {
				if (element.isTypeOnly) continue;
				const local = checker.getExportSpecifierLocalTargetSymbol(element);
				const declaration = local === undefined ? undefined : declarationOf(local);
				if (declaration === undefined || local === undefined || (local.flags & ts.SymbolFlags.Alias) === 0)
					continue;
				const found = importedBy(declaration);
				if (found === undefined) continue;
				reexports.set(found.statement, [
					...(reexports.get(found.statement) ?? []),
					{ name: element.name.text, imported: found.imported },
				]);
				forwarded.push(element.name.text);
			}
		}
		const placeholders = [
			...[...exportNames]
				.filter(([node]) => !ts.isFunctionDeclaration(node) && !hasModifier(node, ts.SyntaxKind.DefaultKeyword))
				.flatMap(([, names]) => names),
			...forwarded,
		];
		const symbol = moduleSymbol(checker, source);
		const assigns = symbol === undefined ? undefined : assignedNames(checker, symbol);
		return { requests, exportNames, reexports, placeholders, assigns };
	});
}

/** The names a module exports, and those of what `export =` or `module.exports =` replaces its object with. */
function assignedNames(checker: ts.TypeChecker, symbol: ts.Symbol): Set<string> {
	const names = new Set(checker.getExportsOfModule(symbol).map((item) => item.name));
	const replaced = symbol.exports?.get(ts.InternalSymbolName.ExportEquals);
	if (replaced !== undefined)
		for (const property of checker.getPropertiesOfType(checker.getTypeOfSymbol(replaced))) names.add(property.name);
	return names;
}

function exportsObject(w: Walker, record: ModuleRecord): TrackedObject {
	return w.objects.get(record.exportsObject) as TrackedObject;
}

/** Each name a declaration exports from its module. */
export function exportedNames(w: Walker, declaration: ts.Node): readonly string[] {
	const source = declaration.getSourceFile();
	const module = w.pinned.moduleOf(source);
	if (module === null) return [];
	if (ts.isExportAssignment(declaration)) return declaration.isExportEquals === true ? [] : ["default"];
	return factsOf(w, module, source).exportNames.get(declaration) ?? [];
}

/** A compiled CommonJS module assigns each export as its binding is set. */
export function initializeExports(w: Walker, binding: ts.Node, value: Value, flow: Flow): void {
	const record = w.modules.get(w.pinned.moduleOf(binding.getSourceFile()) ?? "");
	if (record === undefined || record.runtime !== "cjs" || !record.esmSyntax) return;
	const object = exportsObject(w, record);
	for (const name of exportedNames(w, binding)) w.setProp(object, name, value, flow);
}

/** A binding replaced after it was exported: its exports hold what the walk cannot name. */
export function replaceExports(w: Walker, binding: ts.Node): void {
	const record = w.modules.get(w.pinned.moduleOf(binding.getSourceFile()) ?? "");
	if (record === undefined || record.runtime !== "cjs" || !record.esmSyntax) return;
	const object = exportsObject(w, record);
	for (const name of exportedNames(w, binding)) {
		const prop = object.props.get(name);
		if (prop !== undefined) object.props.set(name, { ...prop, value: UNKNOWN });
	}
}

/** A property that reads another object's, as a compiled re-export's getter does. */
function forward(w: Walker, object: TrackedObject, name: string, from: Value, imported: string, flow: Flow): void {
	const source = w.objectOf(from);
	const before = object.props.get(name);
	const state = written(before?.state, conditional(flow.guards));
	object.props.set(
		name,
		source === undefined
			? { state, value: from.kind === "namespace" ? from : UNKNOWN }
			: { state, value: UNKNOWN, forward: { object: source.id, name: imported } },
	);
}

////////////////////////////////
//  Records

function createRecord(w: Walker, module: string): ModuleRecord | undefined {
	const source = w.pinned.sourceOf(module);
	if (source === undefined) {
		w.halt(undefined, "evidence");
		return undefined;
	}
	if (w.pinned.runtime(module) !== w.runtime) {
		w.halt(source.statements[0], "runtime");
		return undefined;
	}
	if (w.pinned.group(module) !== w.pinned.group(w.entry)) {
		w.halt(source.statements[0]);
		return undefined;
	}
	w.pinned.touch(module);
	if (w.pinned.touchedCount() > w.members.size + MAX_DOWNSTREAM) throw new BudgetExceeded();
	const facts = factsOf(w, module, source);
	const exports = w.newObject({
		label: "exports",
		owner: module,
		symbol: moduleSymbol(w.checker, source),
		assigns: facts.assigns,
		open: facts.assigns === undefined,
	});
	const object: Value = { kind: "object", id: exports.id };
	const record: ModuleRecord = {
		module,
		source,
		runtime: w.runtime,
		member: w.members.has(module),
		esmSyntax: usesEsmSyntax(source),
		status: "linked",
		frame: {
			module,
			vars: new Map(),
			parent: null,
			thisValue: w.runtime === "esm" ? UNDEFINED : object,
			fn: null,
		},
		exportsObject: exports.id,
		exportsValue: object,
		exportsVariable: object,
		captures: new Map(),
	};
	w.modules.set(module, record);
	if (w.runtime === "esm" && hasTopLevelAwait(source)) w.halt(source.statements[0]);
	return record;
}

/** Function declarations exist before any of their module's code runs. */
function hoistModule(w: Walker, record: ModuleRecord): void {
	for (const statement of record.source.statements) {
		if (!ts.isFunctionDeclaration(statement) || statement.body === undefined) continue;
		const value: Value = w.writes.bindings.has(statement)
			? UNKNOWN
			: { kind: "function", node: statement, scope: record.frame };
		w.bindings.set(statement, { init: "yes", value });
	}
}

/** What a compiled CommonJS module does before its body: mark itself, and assign its function exports. */
function preamble(w: Walker, record: ModuleRecord): void {
	if (!record.esmSyntax) return;
	const object = exportsObject(w, record);
	const facts = factsOf(w, record.module, record.source);
	object.props.set("__esModule", { state: "yes", value: literal(true) });
	for (const name of facts.placeholders)
		if (!object.props.has(name)) object.props.set(name, { state: "no", value: UNDEFINED });
	for (const statement of record.source.statements) {
		if (!ts.isFunctionDeclaration(statement) || statement.body === undefined) continue;
		const value = w.bindings.get(statement)?.value ?? UNKNOWN;
		for (const name of facts.exportNames.get(statement) ?? []) object.props.set(name, { state: "yes", value });
	}
}

function* moduleBody(w: Walker, record: ModuleRecord, flow: Flow): Step<void> {
	const body = w.branch(flow);
	yield* w.statements(record.source.statements, record.frame, body);
	const throws = body.exits.filter((exit) => exit.kind === "throw");
	flow.exits.push(...throws);
	if (!body.alive && !body.exits.some((exit) => exit.kind === "return")) flow.alive = false;
	else if (throws.length > 0) flow.guards = w.dependent(flow.guards, throws);
}

////////////////////////////////
//  Loading

/** Loads the entry as its runtime does: an ECMAScript module graph, or a CommonJS `require`. */
export function* loadEntry(w: Walker): Step<void> {
	const flow: Flow = { alive: true, guards: [], exits: [] };
	if (w.runtime === "esm") {
		if (!(yield* link(w, w.entry))) return;
		plan(w, w.entry, new Set());
		yield* evaluateModule(w, w.entry, flow);
		return;
	}
	yield* requireModule(w, w.entry, undefined, flow);
}

/** Instantiates every module the root's static imports reach: their functions exist before any runs. */
function* link(w: Walker, root: string): Step<boolean> {
	const pending = [root];
	while (pending.length > 0) {
		const module = pending.pop() as string;
		if (w.modules.has(module)) continue;
		const record = createRecord(w, module);
		if (record === undefined || w.halted) return false;
		hoistModule(w, record);
		for (const request of factsOf(w, module, record.source).requests) {
			yield* w.step();
			if (request.loads === undefined) {
				w.halt(request.statement, "evidence");
				return false;
			}
			if (request.loads && request.target !== null) pending.push(request.target);
		}
	}
	return true;
}

/** The members in the loader's post-order, as a hazard reports them even when a throw cuts it short. */
function plan(w: Walker, module: string, seen: Set<string>): void {
	seen.add(module);
	const record = w.modules.get(module);
	if (record === undefined) return;
	for (const request of factsOf(w, module, record.source).requests) {
		if (request.loads === true && request.target !== null && !seen.has(request.target))
			plan(w, request.target, seen);
	}
	w.started(module);
}

/** Evaluates a linked module after its requests, in the loader's post-order. */
function* evaluateModule(w: Walker, module: string, flow: Flow): Step<void> {
	const record = w.modules.get(module);
	if (record === undefined || record.status !== "linked") return;
	record.status = "evaluating";
	for (const request of factsOf(w, module, record.source).requests) {
		if (!request.loads || request.target === null) continue;
		yield* evaluateModule(w, request.target, flow);
		if (!flow.alive || w.halted) {
			record.status = "failed";
			return;
		}
	}
	w.started(module);
	yield* moduleBody(w, record, flow);
	record.status = flow.alive ? "evaluated" : "failed";
}

/** A CommonJS `require`: runs the module now unless it already started, and returns its exports. */
function* requireModule(w: Walker, module: string, site: ts.Node | undefined, flow: Flow): Step<Value> {
	const held = w.modules.get(module);
	if (held !== undefined) {
		if (held.status !== "failed") return held.exportsValue;
		w.note(site);
		return UNKNOWN;
	}
	// Whether it loads here depends on a condition the walk cannot fold.
	if (conditional(flow.guards) || opaque(flow.guards)) {
		w.halt(site);
		return UNKNOWN;
	}
	const record = createRecord(w, module);
	if (record === undefined) return UNKNOWN;
	record.status = "evaluating";
	hoistModule(w, record);
	preamble(w, record);
	w.started(module);
	yield* moduleBody(w, record, flow);
	record.status = flow.alive ? "evaluated" : "failed";
	return record.exportsValue;
}

/** A `require` in an ECMAScript module runs where it is reached, never as a loader request. */
function* requireEsm(w: Walker, module: string, site: ts.Node, flow: Flow): Step<Value> {
	const held = w.modules.get(module);
	if (held === undefined) {
		if (conditional(flow.guards) || opaque(flow.guards)) {
			w.halt(site);
			return UNKNOWN;
		}
		if (!(yield* link(w, module))) return UNKNOWN;
	}
	yield* evaluateModule(w, module, flow);
	return { kind: "namespace", module };
}

/** `require("m")`: loads a workspace module as its runtime does; a package's runs unseen. */
export function* requireCall(w: Walker, node: ts.CallExpression, args: Args, frame: Frame, flow: Flow): Step<Value> {
	const argument = node.arguments[0];
	if (node.arguments.length !== 1 || argument === undefined || !ts.isStringLiteralLike(argument) || args.open) {
		w.unseen(node);
		return UNKNOWN;
	}
	const target = w.pinned.target(frame.module, argument);
	if (target === null) return UNKNOWN;
	return w.runtime === "esm" ? yield* requireEsm(w, target, node, flow) : yield* requireModule(w, target, node, flow);
}

////////////////////////////////
//  Statements

/** Import and export statements: what each runs where it stands. */
export function* moduleStatement(w: Walker, node: ts.Statement, frame: Frame, flow: Flow): Step<void> {
	const record = w.modules.get(frame.module);
	if (record === undefined) return;
	if (ts.isExportAssignment(node)) {
		const value = yield* w.expr(node.expression, frame, flow);
		if (!flow.alive) return;
		if (node.isExportEquals !== true) {
			w.initialize(node, value, frame, flow);
			return;
		}
		if (record.runtime !== "cjs") {
			w.note(node);
			return;
		}
		record.exportsValue = conditional(flow.guards) ? joinValues(record.exportsValue, value) : value;
		return;
	}
	if (ts.isImportEqualsDeclaration(node)) {
		yield* importEquals(w, node, record, frame, flow);
		return;
	}
	if (record.runtime === "esm") return;
	if (ts.isImportDeclaration(node)) yield* importCommonJs(w, node, record, flow);
	else if (ts.isExportDeclaration(node)) yield* reexportCommonJs(w, node, record, flow);
}

/** Whether a compiled statement keeps its `require`; undecided emit stops the walk. */
function keeps(w: Walker, record: ModuleRecord, node: ts.Statement): boolean {
	const loads = w.pinned.statementLoads(record.module, node);
	if (loads === undefined) w.halt(node, "evidence");
	return loads === true;
}

function* importEquals(
	w: Walker,
	node: ts.ImportEqualsDeclaration,
	record: ModuleRecord,
	frame: Frame,
	flow: Flow,
): Step<void> {
	if (node.isTypeOnly) return;
	const reference = node.moduleReference;
	let value: Value;
	if (ts.isExternalModuleReference(reference)) {
		if (!keeps(w, record, node)) return;
		const specifier = reference.expression;
		const target = ts.isStringLiteral(specifier) ? w.pinned.target(record.module, specifier) : null;
		value =
			target === null
				? UNKNOWN
				: record.runtime === "esm"
					? yield* requireEsm(w, target, node, flow)
					: yield* requireModule(w, target, node, flow);
	} else value = yield* entityValue(w, reference, frame, flow);
	if (!flow.alive) return;
	w.initialize(node, value, frame, flow);
	if (hasModifier(node, ts.SyntaxKind.ExportKeyword) && record.runtime === "cjs")
		w.setProp(exportsObject(w, record), node.name.text, value, flow);
}

function* entityValue(w: Walker, name: ts.EntityName, frame: Frame, flow: Flow): Step<Value> {
	if (ts.isIdentifier(name)) return yield* w.read(name, frame, flow);
	const left = yield* entityValue(w, name.left, frame, flow);
	return yield* w.member(left, name.right.text, name.right, frame, flow);
}

/** A compiled `import`: its `require` where it stands, captured for its bindings' property reads. */
function* importCommonJs(w: Walker, node: ts.ImportDeclaration, record: ModuleRecord, flow: Flow): Step<void> {
	if (!keeps(w, record, node)) return;
	const specifier = specifierOf(node);
	const target = specifier === undefined ? null : w.pinned.target(record.module, specifier);
	const value = target === null ? UNKNOWN : yield* requireModule(w, target, node, flow);
	if (!flow.alive) return;
	record.captures.set(node, value);
	const own = exportsObject(w, record);
	for (const { name, imported } of factsOf(w, record.module, record.source).reexports.get(node) ?? []) {
		if (imported === "*") w.setProp(own, name, value, flow);
		else forward(w, own, name, value, imported, flow);
	}
}

/** A compiled `export ... from`: its `require`, then getters, or copies of every name for `export *`. */
function* reexportCommonJs(w: Walker, node: ts.ExportDeclaration, record: ModuleRecord, flow: Flow): Step<void> {
	const specifier = specifierOf(node);
	if (specifier === undefined || node.isTypeOnly || !keeps(w, record, node)) return;
	const target = w.pinned.target(record.module, specifier);
	const value = target === null ? UNKNOWN : yield* requireModule(w, target, node, flow);
	if (!flow.alive) return;
	const own = exportsObject(w, record);
	const clause = node.exportClause;
	if (clause === undefined) {
		const from = w.objectOf(value);
		if (from === undefined) {
			own.open = true;
			return;
		}
		if (from.open) own.open = true;
		for (const name of from.props.keys()) {
			// `__exportStar` copies what `for in` sees, skipping names already present.
			if (name === "default" || name === "__esModule" || own.props.has(name)) continue;
			own.props.set(name, { state: "yes", value: UNKNOWN, forward: { object: from.id, name } });
		}
		return;
	}
	if (ts.isNamespaceExport(clause)) {
		w.setProp(own, clause.name.text, value, flow);
		return;
	}
	for (const element of clause.elements) {
		if (element.isTypeOnly) continue;
		forward(w, own, element.name.text, value, (element.propertyName ?? element.name).text, flow);
	}
}
