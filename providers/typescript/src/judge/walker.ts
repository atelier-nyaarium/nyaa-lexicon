// The walk of one entry's load: its state, findings, paths and the provenance of what it evaluates.

import ts from "typescript";
import { rangeOf } from "../ranges.js";
import { initialize, readBinding, setProp, writeName } from "./bindings.js";
import { bindParameters, escapeValues, invoke, opaqueCall } from "./calls.js";
import { toKey } from "./conversions.js";
import type { Decoration, Gate } from "./decorators.js";
import { superCall } from "./definitions.js";
import { type Domain, eitherWay } from "./domains.js";
import { evaluate } from "./expressions.js";
import { loadEntry, replaceExports } from "./loader.js";
import { readMember, writeMember } from "./members.js";
import {
	type BindingState,
	BudgetExceeded,
	type CallSite,
	type ClassValue,
	conditional,
	correlated,
	EXACT,
	type Exit,
	type Finding,
	type Flow,
	type Frame,
	forget,
	type Guard,
	isNullish,
	isObject,
	MAX_DEPTH,
	MAX_STEPS,
	type ModuleRecord,
	mergeGuards,
	opaque,
	type Prov,
	provOf,
	type Runtime,
	type Source,
	type TrackedObject,
	UNKNOWN,
	type UnknownNote,
	unionProv,
	type Value,
	withProv,
} from "./model.js";
import { readName } from "./names.js";
import type { PinnedProgram } from "./program.js";
import { objectRest, statements as walkStatements, withDefault } from "./statements.js";
import { conditionSymbols, hasModifier, moduleSymbol, unwrapExpression } from "./symbols.js";
import type { Writes } from "./writes.js";

////////////////////////////////
//  Interfaces & Types

export type Step<T> = Generator<undefined, T, undefined>;

export interface Budget {
	steps: number;
}

/** A read the walk checks against initialization, and where it happened. */
export interface Read {
	readonly node: ts.Node;
	readonly module: string;
	readonly name: string;
}

/** A call's arguments; `open` when a spread the walk cannot count follows them. */
export interface Args {
	readonly values: readonly Value[];
	readonly open: boolean;
}

/** An optional chain's guard: in effect once a receiver may be absent, with what that receiver came from. */
export interface ChainGuard {
	readonly sources: Set<Source>;
	opaque: boolean;
	conditional: boolean;
}

////////////////////////////////
//  Constants

/** Steps between checks of the slice deadline. */
const YIELD_EVERY = 32;

////////////////////////////////
//  Class

export class Walker {
	readonly bindings = new Map<ts.Node, BindingState>();
	readonly objects = new Map<number, TrackedObject>();
	readonly modules = new Map<string, ModuleRecord>();
	/** Each class value by its node, from the moment its definition starts. */
	readonly classes = new Map<ts.Node, ClassValue>();
	/** Each class value's base: a class, null for none, or unknown. */
	readonly bases = new Map<number, Value | null>();
	/** Members in the order their evaluation started. */
	readonly order: string[] = [];
	readonly findings: Finding[] = [];
	readonly notes: UnknownNote[] = [];
	readonly stack: CallSite[] = [];
	/** Functions and constructors on the call stack, never walked again inside themselves. */
	readonly active = new Set<ts.Node>();
	/** The rest of this entry's walk is unknown. */
	halted = false;
	/** The optional chain being evaluated, cut when an optional receiver is absent. */
	chain: { cut: boolean; readonly guard: ChainGuard } | undefined;
	/** What standard decorators did to each class value, by its id. */
	readonly decorations = new Map<number, Decoration>();
	/** Each decorator context's `addInitializer`, by the id its value carries. */
	readonly gates = new Map<number, Gate>();
	/** Code the walk cannot see has run, so a function's or stored array's own properties may hold a hook. */
	private exposed = false;
	private ids = 0;
	private readonly noted = new Set<string>();
	/** Each module's exports that code which may run unseen assigns. */
	private readonly unseenWrites = new Map<string, ReadonlySet<string>>();
	/** Objects that are no module's own and that unseen code has not yet reached. */
	private readonly live = new Set<TrackedObject>();
	/** Exports, namespace and enum objects. */
	private readonly owned: TrackedObject[] = [];
	/** Functions, and class prototypes, some code gave properties of their own. */
	private readonly altered = new Set<ts.Node>();
	/** Some stored array was given a property other than an element. */
	private arraysAltered = false;
	/** For each expression being evaluated, what its operands' values came from. */
	private readonly operands: Prov[] = [];

	constructor(
		readonly pinned: PinnedProgram,
		readonly writes: Writes,
		readonly members: ReadonlySet<string>,
		readonly entry: string,
		readonly runtime: Runtime,
		private readonly budget: Budget,
	) {}

	get checker(): ts.TypeChecker {
		return this.pinned.checker;
	}

	*run(): Step<void> {
		yield* loadEntry(this);
	}

	*step(): Step<void> {
		this.budget.steps++;
		if (this.budget.steps > MAX_STEPS) throw new BudgetExceeded();
		if (this.budget.steps % YIELD_EVERY === 0) yield;
	}

	////////////////////////////////
	//  State

	newObject(fields: Omit<TrackedObject, "id" | "props" | "open"> & { open?: boolean }): TrackedObject {
		const object: TrackedObject = { ...fields, id: ++this.ids, props: new Map(), open: fields.open ?? false };
		this.objects.set(object.id, object);
		if (object.owner === undefined) this.live.add(object);
		else this.owned.push(object);
		return object;
	}

	/** A function, stored array or class prototype was given a property the walk does not track. */
	alter(value: Value): void {
		if (value.kind === "function") this.altered.add(value.node);
		else if (value.kind === "prototype") this.altered.add(value.owner.node);
		else if (value.kind === "array") this.arraysAltered = true;
	}

	/** Whether a function's, stored array's or class prototype's own properties may hold a hook the walk never saw. */
	hooked(value: Value): boolean {
		if (value.kind === "function") return this.exposed || this.altered.has(value.node);
		if (value.kind === "prototype") {
			let owner: Value | null | undefined = value.owner;
			for (let depth = 0; owner?.kind === "class" && depth < MAX_DEPTH * 4; depth++) {
				if (this.altered.has(owner.node)) return true;
				owner = this.bases.get(owner.id);
			}
			return false;
		}
		return value.kind === "array" && value.held === true && (this.exposed || this.arraysAltered);
	}

	objectOf(value: Value): TrackedObject | undefined {
		if (value.kind === "object" || value.kind === "class") return this.objects.get(value.id);
		return undefined;
	}

	newGate(gate: Gate): number {
		const id = ++this.ids;
		this.gates.set(id, gate);
		return id;
	}

	/** The object of the namespace a frame chain runs inside. */
	namespaceObject(frame: Frame, namespace: ts.Node): TrackedObject | undefined {
		for (let scope: Frame | null = frame; scope !== null; scope = scope.parent) {
			if (scope.fn === namespace && scope.namespace !== undefined) return this.objects.get(scope.namespace);
		}
		return undefined;
	}

	/** A binding whose value something replaced after its initialization. */
	replaceBinding(binding: ts.Node, frame: Frame): void {
		const held = this.bindings.get(binding);
		if (held !== undefined) this.bindings.set(binding, { init: held.init, value: UNKNOWN });
		else if (frame.vars.has(binding)) frame.vars.set(binding, UNKNOWN);
		replaceExports(this, binding);
	}

	/** The namespace object an exported declaration directly in a namespace body writes to. */
	namespaceOf(frame: Frame, declaration: ts.Node): TrackedObject | undefined {
		const statement =
			ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)
				? ts.findAncestor(declaration, ts.isVariableStatement)
				: declaration;
		if (statement === undefined || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return undefined;
		const block = statement.parent;
		if (!ts.isModuleBlock(block)) return undefined;
		return this.namespaceObject(frame, block.parent);
	}

	/** Marks a module read, so its text and landings are evidence. */
	touch(node: ts.Node): string | null {
		const module = this.pinned.moduleOf(node.getSourceFile());
		if (module !== null) this.pinned.touch(module);
		return module;
	}

	started(module: string): void {
		if (this.members.has(module) && !this.order.includes(module)) this.order.push(module);
	}

	////////////////////////////////
	//  Findings

	/** The walk met something its model does not cover. */
	note(node: ts.Node | undefined, reason: UnknownNote["reason"] = "model", module?: string): void {
		const source = node?.getSourceFile();
		const at = module ?? (source === undefined ? undefined : (this.pinned.moduleOf(source) ?? undefined));
		const range = node === undefined || source === undefined ? undefined : rangeOf(node, source);
		const key = JSON.stringify([at ?? null, reason, range ?? null]);
		if (this.noted.has(key)) return;
		this.noted.add(key);
		this.notes.push({
			...(at === undefined ? {} : { module: at }),
			...(range === undefined ? {} : { range }),
			reason,
		});
	}

	/**
	 * Workspace code may run where the walk cannot see. It may redefine any object it reaches, and a
	 * closure reaches nearly any, so none is known any more. A module's own objects keep what they
	 * hold, except exports some function or other module assigns; one still loading has no property
	 * known absent.
	 */
	unseen(node: ts.Node | undefined): void {
		this.note(node);
		this.exposed = true;
		for (const object of this.live) forget(object);
		this.live.clear();
		for (const object of this.owned) {
			if (object.owner === undefined) continue;
			if (this.modules.get(object.owner)?.status === "evaluating") object.open = true;
			if (object.label !== "exports") continue;
			const changed = this.assignedUnseen(object.owner);
			for (const [name, prop] of object.props)
				if (changed.has(name) && prop.state !== "no") object.props.set(name, { ...prop, value: UNKNOWN });
		}
	}

	/** A module's exports that code which may run unseen assigns: inside a function or class, or from another module. */
	private assignedUnseen(module: string): ReadonlySet<string> {
		let names = this.unseenWrites.get(module);
		if (names === undefined) {
			const source = this.pinned.sourceOf(module);
			const symbol = source === undefined ? undefined : moduleSymbol(this.checker, source);
			const exports = symbol === undefined ? [] : this.checker.getExportsOfModule(symbol);
			const assigned = exports.filter((item) =>
				(item.declarations ?? []).some((declaration) => this.writes.nested.has(declaration)),
			);
			names = new Set(assigned.map((item) => item.name));
			this.unseenWrites.set(module, names);
		}
		return names;
	}

	/** Stops this entry's walk: what follows cannot be modeled. */
	halt(node: ts.Node | undefined, reason: UnknownNote["reason"] = "model"): void {
		this.note(node, reason);
		this.halted = true;
	}

	/**
	 * A read of something not initialized, which `declaration` declares. Bad only on a modeled path:
	 * no opaque guard, no two guards sharing a source, and a reader inside the component. Answers
	 * whether it was bad.
	 */
	hazard(read: Read, target: Finding["target"], flow: Flow, declaration?: ts.Node): boolean {
		if (opaque(flow.guards) || correlated(flow.guards) || !this.members.has(read.module)) {
			this.note(read.node);
			return false;
		}
		const source = read.node.getSourceFile();
		const symbolId = declaration === undefined ? undefined : this.pinned.symbolIdOf(declaration);
		this.findings.push({
			entry: this.entry,
			reader: { module: read.module, range: rangeOf(read.node, source), name: read.name },
			target: symbolId === undefined ? target : { ...target, symbolId },
			calls: this.stack.map(({ module, range, name }) => ({ module, range, name })),
		});
		return true;
	}

	/** A read of an initialization that happened on some paths only. */
	uncertain(read: Read): void {
		this.note(read.node);
	}

	////////////////////////////////
	//  Paths

	/**
	 * A condition's guard: what its value came from, and the variables it names. It decides nothing
	 * provable where the model lost the value, where it shares a source with a guard already on the
	 * path, or where the value varies but `reaches` its domain does not admit, as for anything other
	 * than an input tested simply. A truthiness test by default.
	 */
	guard(value: Value, condition: ts.Node, flow: Flow, reaches: (domain: Domain) => boolean = eitherWay): Guard {
		const prov = provOf(value);
		const sources = new Set<Source>([...prov.sources, ...conditionSymbols(this.checker, condition)]);
		const along = flow.guards.some((guard) => [...guard.sources].some((source) => sources.has(source)));
		const blind = value.kind === "unknown" && (value.domain === undefined || !reaches(value.domain));
		return { sources, opaque: prov.opaque || along || blind, conditional: true };
	}

	branch(flow: Flow, guard?: Guard): Flow {
		return { alive: true, guards: guard === undefined ? [...flow.guards] : [...flow.guards, guard], exits: [] };
	}

	/** Joins branches back: alive when any is or a path skips them all, depending on every exit that left. */
	join(flow: Flow, base: readonly Guard[], branches: readonly Flow[], skipped: boolean): void {
		const exits = branches.flatMap((branch) => branch.exits);
		flow.exits.push(...exits);
		flow.alive = skipped || branches.some((branch) => branch.alive);
		flow.guards = this.dependent(base, exits);
	}

	/** What the continuation after a construct depends on: the guards of every path that left it. */
	dependent(base: readonly Guard[], leaving: ReadonlyArray<Pick<Exit, "guards" | "kind">>): Guard[] {
		const extra = leaving.flatMap((exit) => exit.guards.slice(base.length));
		if (extra.length === 0) return [...base];
		const merged = mergeGuards(extra);
		const stops = leaving.some((exit) => exit.kind !== "throw");
		return [...base, { ...merged, conditional: stops }];
	}

	/** Whether a write on this path may not happen where `base`, the guards its target came with, held. */
	conditional(flow: Flow, base: readonly Guard[] = []): boolean {
		return conditional(base.length === 0 ? flow.guards : flow.guards.filter((guard) => !base.includes(guard)));
	}

	throwExit(flow: Flow, maybe: boolean): void {
		flow.exits.push({ kind: "throw", guards: [...flow.guards], maybe });
		if (!maybe) flow.alive = false;
	}

	/**
	 * An operation that may fail, which only a surrounding catch can tell (rule 14). Outside a try it
	 * does not cut the path: a read after it is bad, since executions where it returns reach that read.
	 */
	mayThrow(flow: Flow): void {
		if (flow.guards.some((guard) => guard.catches === true)) this.throwExit(flow, true);
	}

	////////////////////////////////
	//  Provenance

	/** An expression starts: what its operands' values came from gathers until it ends. */
	openExpression(): void {
		this.operands.push(EXACT);
	}

	/**
	 * An expression ends. A primitive or unknown result depends on what its operands came from; an
	 * object's identity does not. The result then counts as an operand of the expression around it.
	 */
	closeExpression(value: Value): Value {
		const gathered = this.operands.pop() ?? EXACT;
		const result = isObject(value) === true ? value : withProv(value, gathered);
		const outer = this.operands.length - 1;
		if (outer >= 0) this.operands[outer] = unionProv(this.operands[outer] as Prov, provOf(result));
		return result;
	}

	/** A callee's body: what it evaluates reaches the call's value only through what it returns. */
	*isolated<T>(work: () => Step<T>): Step<T> {
		this.operands.push(EXACT);
		try {
			return yield* work();
		} finally {
			this.operands.pop();
		}
	}

	////////////////////////////////
	//  Bindings

	initialize(binding: ts.Node, value: Value, frame: Frame, flow: Flow): void {
		initialize(this, binding, value, frame, flow);
	}

	setProp(object: TrackedObject, name: string, value: Value, flow: Flow): void {
		setProp(this, object, name, value, flow);
	}

	readBinding(declaration: ts.Node, read: Read, flow: Flow): Value {
		return readBinding(this, declaration, read, flow);
	}

	writeName(node: ts.Identifier, value: Value, frame: Frame, flow: Flow): void {
		writeName(this, node, value, frame, flow);
	}

	////////////////////////////////
	//  Expressions

	*expr(node: ts.Expression, frame: Frame, flow: Flow): Step<Value> {
		return yield* evaluate(this, node, frame, flow);
	}

	*read(node: ts.Identifier, frame: Frame, flow: Flow): Step<Value> {
		return yield* readName(this, node, frame, flow);
	}

	*member(receiver: Value, key: string | undefined, node: ts.Node, frame: Frame, flow: Flow): Step<Value> {
		return yield* readMember(this, receiver, key, node, frame, flow);
	}

	*setMember(
		receiver: Value,
		key: string | undefined,
		value: Value,
		node: ts.Node,
		frame: Frame,
		flow: Flow,
	): Step<void> {
		yield* writeMember(this, receiver, key, value, node, frame, flow);
	}

	/** Assigns to an assignment target: a name, a member, or a destructuring pattern. */
	*assignTo(target: ts.Node, value: Value, frame: Frame, flow: Flow): Step<void> {
		const node = ts.isExpression(target) ? unwrapExpression(target) : target;
		if (ts.isIdentifier(node)) {
			this.writeName(node, value, frame, flow);
			return;
		}
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			const receiver = yield* this.expr(node.expression, frame, flow);
			const key = ts.isPropertyAccessExpression(node)
				? node.name.text
				: yield* this.keyOf(node.argumentExpression, frame, flow);
			if (!flow.alive) return;
			yield* writeMember(this, receiver, key, value, node, frame, flow);
			return;
		}
		if (ts.isObjectLiteralExpression(node)) {
			if (isNullish(value)) {
				this.throwExit(flow, false);
				return;
			}
			let taken: Set<string> | undefined = new Set();
			for (const property of node.properties) {
				if (!flow.alive) return;
				if (ts.isShorthandPropertyAssignment(property)) {
					const item = yield* readMember(this, value, property.name.text, property.name, frame, flow);
					taken?.add(property.name.text);
					this.writeName(property.name, item, frame, flow);
				} else if (ts.isPropertyAssignment(property)) {
					const key =
						ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
							? property.name.text
							: undefined;
					if (key === undefined) taken = undefined;
					else taken?.add(key);
					const item =
						key === undefined ? UNKNOWN : yield* readMember(this, value, key, property.name, frame, flow);
					yield* this.assignTo(property.initializer, item, frame, flow);
				} else if (ts.isSpreadAssignment(property)) {
					const copied = yield* objectRest(this, value, taken, node, frame, flow);
					yield* this.assignTo(property.expression, copied, frame, flow);
				} else this.note(property);
			}
			return;
		}
		if (ts.isArrayLiteralExpression(node)) {
			this.unseen(node);
			for (const element of node.elements) {
				if (ts.isOmittedExpression(element)) continue;
				yield* this.assignTo(ts.isSpreadElement(element) ? element.expression : element, UNKNOWN, frame, flow);
			}
			return;
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			const bound = yield* withDefault(this, value, node.right, frame, flow);
			yield* this.assignTo(node.left, bound, frame, flow);
			return;
		}
		this.note(node);
	}

	/** A computed property key, or undefined when the walk cannot name it. */
	*keyOf(node: ts.Expression, frame: Frame, flow: Flow): Step<string | undefined> {
		const key = yield* this.expr(node, frame, flow);
		if (!flow.alive) return undefined;
		return yield* toKey(this, key, node, frame, flow);
	}

	////////////////////////////////
	//  Statements and calls

	*statements(list: readonly ts.Statement[], frame: Frame, flow: Flow): Step<void> {
		yield* walkStatements(this, list, frame, flow);
	}

	*invoke(
		callee: Value,
		thisValue: Value,
		args: Args,
		site: ts.Node,
		frame: Frame,
		flow: Flow,
		replaced = false,
	): Step<Value> {
		return yield* invoke(this, callee, thisValue, args, site, frame, flow, replaced);
	}

	opaqueCall(site: ts.Node, thisValue: Value, args: Args, flow: Flow): Value {
		return opaqueCall(this, site, thisValue, args, flow);
	}

	*bindParameters(node: ts.FunctionLikeDeclaration, args: Args, frame: Frame, flow: Flow): Step<void> {
		yield* bindParameters(this, node, args, frame, flow);
	}

	escape(values: readonly Value[]): void {
		escapeValues(this, values);
	}

	/** `super(...)`: the base's construction, then this class's fields. */
	*superConstruct(node: ts.CallExpression, frame: Frame, flow: Flow): Step<Value> {
		return yield* superCall(this, node, frame, flow);
	}
}
