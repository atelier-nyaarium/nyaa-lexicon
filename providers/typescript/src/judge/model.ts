// The load-cycle judge's abstract values, state and paths.

import type { Range } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { type Domain, exactly, narrowPresent, narrowTruthy, onlyTruthy, tagsOf, union } from "./domains.js";

////////////////////////////////
//  Interfaces & Types

/** Whether something has happened on every path, on none, or on some. */
export type Tri = "yes" | "no" | "maybe";

export type Runtime = "esm" | "cjs";

/** What a value or a guard depends on: a variable a condition names, or the site an input was read at. */
export type Source = ts.Symbol | ts.Node;

/**
 * Where a value came from. Free (not opaque): it varies between executions with its sources, as an
 * input does. Opaque: the model lost track of it, so no read a condition on it guards is proven bad
 * or fine. A condition on a free value reaches both branches (rule 14) only where the value has a
 * domain admitting both outcomes.
 */
export interface Prov {
	readonly sources: ReadonlySet<Source>;
	readonly opaque: boolean;
}

type Shape =
	/**
	 * `truthy` when every value it may be agrees on it. `direct` for an input, or a member of one,
	 * read as it is. `domain` when it ranges over all of one: an input's type where that spells its
	 * values exactly, a simple test of one, or a choice between such.
	 */
	| {
			readonly kind: "unknown";
			readonly truthy?: boolean;
			readonly direct?: true;
			readonly domain?: Domain | undefined;
	  }
	| { readonly kind: "literal"; readonly value: string | number | boolean | bigint | null | undefined }
	| { readonly kind: "function"; readonly node: ts.FunctionLikeDeclaration; readonly scope: Frame }
	| { readonly kind: "class"; readonly node: ts.ClassLikeDeclaration; readonly scope: Frame; readonly id: number }
	| { readonly kind: "object"; readonly id: number }
	/** `held` once stored where code may change it, so its elements are no longer known. */
	| { readonly kind: "array"; readonly elements: readonly Value[]; readonly held?: true }
	/** An ESM module namespace object. */
	| { readonly kind: "namespace"; readonly module: string }
	/** A CommonJS `module` object. */
	| { readonly kind: "module"; readonly module: string }
	/** A class's `prototype`, holding its methods and accessors. */
	| { readonly kind: "prototype"; readonly owner: Value & { kind: "class" } }
	| { readonly kind: "builtin"; readonly name: "require" }
	/** An object or function of the language's own library, the same on every run. */
	| { readonly kind: "builtin"; readonly name: "library"; readonly callable: boolean }
	/** The global object, a sloppy call's `this`, which the walk does not follow. */
	| { readonly kind: "builtin"; readonly name: "global" }
	/** A standard decorator context's `addInitializer`, adding to the list its gate names. */
	| { readonly kind: "builtin"; readonly name: "addInitializer"; readonly gate: number }
	/** A promise, or a generator object whose body runs only when iterated. */
	| { readonly kind: "deferred"; readonly generator?: true };

/** An abstract value; one without `prov` is exact, or opaque when unknown. */
export type Value = Shape & { readonly prov?: Prov | undefined };

export type ClassValue = Extract<Value, { kind: "class" }>;
export type FunctionValue = Extract<Value, { kind: "function" }>;

/** One property of a tracked object. */
export interface Prop {
	readonly state: Tri;
	readonly value: Value;
	readonly getter?: Value | undefined;
	readonly setter?: Value | undefined;
	/** A live re-export: reading it reads `name` on object `object`. */
	readonly forward?: { readonly object: number; readonly name: string } | undefined;
}

/** An object the walk follows by identity. */
export interface TrackedObject {
	readonly id: number;
	readonly props: Map<string, Prop>;
	/** Writes the walk cannot name may have happened, so an absent property is not known absent. */
	open: boolean;
	/** Code the walk cannot see may have redefined it: any lookup on it may run a hook. */
	lost?: boolean;
	/** The module whose exports object, namespace object or enum this is. */
	readonly owner?: string | undefined;
	/** The module, namespace or enum whose own object this is, which declares its members. */
	readonly symbol?: ts.Symbol | undefined;
	/** Names its owner assigns somewhere, so a missing one is a read before its assignment. */
	readonly assigns?: ReadonlySet<string> | undefined;
	/** The class whose instance this is, for methods and accessors. */
	readonly instanceOf?: ClassValue | undefined;
	/** An object literal's `__proto__`: what a lookup missing its own properties reads next. */
	proto?: Value | undefined;
	/** The guards of the path that made it: a write under no others happens wherever it exists. */
	readonly base?: readonly Guard[] | undefined;
	/** How a hazard names the object's owner kind. */
	readonly label: "exports" | "namespace" | "enum" | "object" | "instance";
}

/** A module-level binding: whether its initialization event has run, and the value it holds. */
export interface BindingState {
	readonly init: Tri;
	readonly value: Value;
}

/** A condition the current path depends on. */
export interface Guard {
	/** What the condition's value came from, and the variables it names; two guards sharing one correlate. */
	readonly sources: ReadonlySet<Source>;
	/** The walk cannot say whether the path is taken, so its reads are unknown. */
	readonly opaque: boolean;
	/** Writes under it may not happen. A throw guard at load does not: a throw ends the load. */
	readonly conditional: boolean;
	/** A try block with a catch: a throw inside resumes after it. */
	readonly catches?: boolean;
	/** A loop body the walk follows once: what it writes may differ on a later pass. */
	readonly repeats?: boolean;
}

/** An abrupt completion leaving a statement. */
export interface Exit {
	readonly kind: "return" | "throw" | "break" | "continue" | "await";
	readonly label?: string | undefined;
	/** Every guard at the exit point. */
	readonly guards: readonly Guard[];
	/** A throw that may not happen: an operation the walk cannot see into. */
	readonly maybe: boolean;
	readonly value?: Value | undefined;
}

/** Where the walk stands within one function body or module. */
export interface Flow {
	alive: boolean;
	guards: Guard[];
	exits: Exit[];
}

/** A lexical scope: a function call's locals, or a module's top level. */
export interface Frame {
	readonly module: string;
	readonly vars: Map<ts.Node, Value>;
	readonly parent: Frame | null;
	readonly thisValue: Value;
	/** The function whose call made it; null at a module's top level. */
	readonly fn: ts.Node | null;
	/** The namespace object an exported namespace member writes to. */
	readonly namespace?: number | undefined;
	/** The guards of the path that entered it: a write of a local under no others happens wherever it runs. */
	readonly base?: readonly Guard[] | undefined;
	/** A derived class's constructor: whether `super()` has bound `this` yet. */
	readonly thisInit?: { state: Tri } | undefined;
}

export type ModuleStatus = "linked" | "evaluating" | "evaluated" | "failed";

export interface ModuleRecord {
	readonly module: string;
	readonly source: ts.SourceFile;
	readonly runtime: Runtime;
	readonly member: boolean;
	/** Written with import and export declarations, as a compiler emits for CommonJS. */
	readonly esmSyntax: boolean;
	status: ModuleStatus;
	readonly frame: Frame;
	/** CommonJS: the object `exports` starts as. */
	readonly exportsObject: number;
	/** CommonJS: what `module.exports` holds now. */
	exportsValue: Value;
	/** CommonJS: what the free variable `exports` holds now. */
	exportsVariable: Value;
	/** CommonJS: what each import statement's `require` returned. */
	readonly captures: Map<ts.Node, Value>;
}

/** A read the model proves runs before its binding is initialized. */
export interface Finding {
	readonly entry: string;
	readonly reader: { readonly module: string; readonly range: Range; readonly name: string };
	/** `symbolId`: the declaration it names, when one in the workspace has one. */
	readonly target: {
		readonly module: string;
		readonly name: string;
		readonly kind: string;
		readonly symbolId?: string | undefined;
	};
	readonly calls: ReadonlyArray<{ readonly module: string; readonly range: Range; readonly name: string }>;
}

/** Where the walk left its modeled subset. */
export interface UnknownNote {
	readonly module?: string | undefined;
	readonly range?: Range | undefined;
	readonly reason: "model" | "runtime" | "budget" | "evidence" | "notReady";
}

/** One call on the walk's stack, for a hazard's `calls`. */
export interface CallSite {
	readonly module: string;
	readonly range: Range;
	readonly name: string;
	readonly node: ts.Node;
}

////////////////////////////////
//  Constants

/** Provenance of a value that depends on nothing that varies. */
export const EXACT: Prov = { sources: new Set(), opaque: false };

/** Provenance of a value the model lost track of. */
export const LOST: Prov = { sources: new Set(), opaque: true };

/** A value the model lost track of. */
export const UNKNOWN: Value = { kind: "unknown" };

/** Unknown only because its operands are: evaluation gives it theirs as its provenance. */
export const VARIES: Value = { kind: "unknown", prov: EXACT };

export const UNDEFINED: Value = { kind: "literal", value: undefined };

export const DEFERRED: Value = { kind: "deferred" };

export const GLOBAL: Value = { kind: "builtin", name: "global" };

/** Call depth the walk follows; deeper calls are unknown. */
export const MAX_DEPTH = 8;

/** Steps one judgment may take before it is unknown ("budget"). */
export const MAX_STEPS = 200_000;

export const MAX_ENTRIES = 32;

/** Elements of a literal a `for of` or `for in` walks one by one; past it, the variable is unknown. */
export const MAX_ITERATIONS = 16;

/** Longest string a fold builds; past it, the result is unknown. */
export const MAX_TEXT = 10_000;

/** Widest bigint a fold builds, in bits; past it, the result is unknown. */
export const MAX_BITS = 4_096;

/** Modules outside the component one judgment may read. */
export const MAX_DOWNSTREAM = 2_000;

/** About how long one slice works before returning a partial token. */
export const SLICE_MS = 150;

/** Held state expires this long after its last slice. */
export const HOLD_MS = 60_000;

////////////////////////////////
//  Class

/** A judgment past its step or downstream budget. */
export class BudgetExceeded extends Error {}

////////////////////////////////
//  Functions & Helpers

export function literal(value: string | number | boolean | bigint | null | undefined): Value {
	return { kind: "literal", value };
}

export function provOf(value: Value): Prov {
	return value.prov ?? (value.kind === "unknown" ? LOST : EXACT);
}

export function unionProv(a: Prov, b: Prov): Prov {
	if (b.sources.size === 0 && (a.opaque || !b.opaque)) return a;
	if (a.sources.size === 0 && (b.opaque || !a.opaque)) return b;
	return { sources: new Set([...a.sources, ...b.sources]), opaque: a.opaque || b.opaque };
}

/** The value, depending on `extra` too. */
export function withProv(value: Value, extra: Prov): Value {
	const own = provOf(value);
	const prov = unionProv(own, extra);
	return prov === own ? value : { ...value, prov };
}

/** A value that varies between executions with `sources`, computed from them rather than read directly. */
export function free(...sources: Source[]): Value {
	return { kind: "unknown", prov: { sources: new Set(sources), opaque: false } };
}

/** An input read at `sources`, any value of `domain`, which its declared type gives. */
export function input(domain: Domain | undefined, ...sources: Source[]): Value {
	return { kind: "unknown", prov: { sources: new Set(sources), opaque: false }, direct: true, domain };
}

/** The values a value may be, each possible; undefined where the walk does not know them all. */
export function domainOfValue(value: Value): Domain | undefined {
	if (value.kind === "literal") return exactly(value.value);
	return value.kind === "unknown" ? value.domain : undefined;
}

/** What a path's guards make a value written or chosen under them depend on. */
export function guardProv(guards: readonly Guard[]): Prov {
	let prov = EXACT;
	for (const guard of guards)
		prov = unionProv(prov, { sources: guard.sources, opaque: guard.opaque || guard.repeats === true });
	return prov;
}

/**
 * A value chosen or written on a path past `guards`: it depends on them, and is opaque where it
 * depends on what they test, since that path may then be impossible.
 */
export function underGuards(value: Value, guards: readonly Guard[]): Value {
	if (guards.length === 0) return value;
	const path = guardProv(guards);
	const own = provOf(value);
	const correlated = [...own.sources].some((source) => path.sources.has(source));
	return withProv(value, correlated ? { ...path, opaque: true } : path);
}

/**
 * One value standing for two paths: equal when both agree, else unknown, truthy or falsy where both
 * are. It depends on what both do.
 */
export function joinValues(a: Value, b: Value): Value {
	const prov = unionProv(provOf(a), provOf(b));
	if (sameValue(a, b)) return withProv(a, prov);
	const truthy = truthiness(a);
	const da = domainOfValue(a);
	const db = domainOfValue(b);
	const domain = da === undefined || db === undefined ? undefined : union(da, db);
	return {
		kind: "unknown",
		prov,
		...(truthy !== undefined && truthy === truthiness(b) ? { truthy } : {}),
		...(domain === undefined ? {} : { domain }),
	};
}

/** A value on a path that learned its truthiness. */
export function withTruthiness(value: Value, truthy: boolean): Value {
	if (value.kind !== "unknown") return value;
	return { ...value, truthy, ...(value.domain === undefined ? {} : { domain: narrowTruthy(value.domain, truthy) }) };
}

/** A value on a path that learned it is not null or undefined. */
export function withPresence(value: Value): Value {
	if (value.kind !== "unknown" || value.domain === undefined) return value;
	return { ...value, domain: narrowPresent(value.domain) };
}

/** A value stored where code may change it since: an array's elements are no longer known. */
export function held(value: Value): Value {
	return value.kind === "array" && value.held !== true ? { ...value, held: true } : value;
}

function sameValue(a: Value, b: Value): boolean {
	if (a === b) return true;
	if (a.kind === "literal" && b.kind === "literal") return Object.is(a.value, b.value);
	if (a.kind === "object" && b.kind === "object") return a.id === b.id;
	if (a.kind === "class" && b.kind === "class") return a.id === b.id;
	if (a.kind === "function" && b.kind === "function") return a.node === b.node && a.scope === b.scope;
	if (a.kind === "namespace" && b.kind === "namespace") return a.module === b.module;
	if (a.kind === "module" && b.kind === "module") return a.module === b.module;
	return false;
}

/** `===` on two values: objects by identity; undefined where the walk cannot tell. */
export function strictEquals(a: Value, b: Value): boolean | undefined {
	if (a.kind === "unknown" || b.kind === "unknown") return undefined;
	if (a.kind === "literal" || b.kind === "literal")
		return a.kind === "literal" && b.kind === "literal" ? a.value === b.value : false;
	if ((a.kind === "object" || a.kind === "class") && (b.kind === "object" || b.kind === "class"))
		return a.id === b.id;
	if (a.kind === "prototype" && b.kind === "prototype") return a.owner.id === b.owner.id;
	if (a.kind === "function" && b.kind === "function")
		// One function expression evaluated twice in one scope makes two closures.
		return a.node === b.node && a.scope === b.scope ? undefined : false;
	const tracked = new Set(["object", "class", "prototype", "function", "array"]);
	return tracked.has(a.kind) && tracked.has(b.kind) && a.kind !== b.kind ? false : undefined;
}

/** Whether `new` can construct a value, and `extends` take it; undefined when the walk cannot tell. */
export function isConstructor(value: Value): boolean | undefined {
	switch (value.kind) {
		case "class":
			return true;
		case "function": {
			const fn = value.node;
			const plain = ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn);
			const async = (ts.getModifiers(fn) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
			return plain && fn.asteriskToken === undefined && !async;
		}
		case "unknown":
		case "builtin":
		case "deferred":
			return undefined;
		default:
			return false;
	}
}

/** Own string keys in the language's order: array indices ascending, then the rest as first added. */
export function ownKeys(names: Iterable<string>): string[] {
	const seen = new Set<string>();
	const indices: number[] = [];
	const rest: string[] = [];
	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);
		if (/^(0|[1-9]\d*)$/.test(name) && Number(name) < 2 ** 32 - 1) indices.push(Number(name));
		else rest.push(name);
	}
	return [...indices.sort((a, b) => a - b).map(String), ...rest];
}

/**
 * Code the walk cannot see may have redefined the object: its properties, accessors, prototype and
 * extensibility are no longer known, so any lookup on it may run a hook.
 */
export function forget(object: TrackedObject): void {
	object.open = true;
	object.lost = true;
}

/** A write's state: certain on an unconditional path, else possible. Once certain, it stays certain. */
export function written(before: Tri | undefined, conditional: boolean): Tri {
	if (before === "yes") return "yes";
	return conditional ? "maybe" : "yes";
}

/** Fixed-value literal or unknown, for a `typeof`. */
export function typeofValue(value: Value): Value {
	switch (value.kind) {
		case "literal":
			return literal(value.value === null ? "object" : typeof value.value);
		case "builtin":
			return literal(
				value.name === "global" || (value.name === "library" && !value.callable) ? "object" : "function",
			);
		case "function":
		case "class":
			return literal("function");
		case "unknown": {
			if (value.domain === undefined) return VARIES;
			const tags = tagsOf(value.domain);
			const [only] = tags;
			return tags.length === 1 && only?.kind === "value"
				? literal(only.value)
				: { kind: "unknown", prov: EXACT, domain: tags };
		}
		default:
			return literal("object");
	}
}

/** Whether a value's truthiness is known. */
export function truthiness(value: Value): boolean | undefined {
	switch (value.kind) {
		case "literal":
			return Boolean(value.value);
		case "function":
		case "class":
		case "object":
		case "array":
		case "namespace":
		case "module":
		case "prototype":
		case "builtin":
		case "deferred":
			return true;
		default:
			// A domain all of one truthiness decides it.
			return value.truthy ?? (value.domain === undefined ? undefined : onlyTruthy(value.domain));
	}
}

/** Whether a value is an object rather than a primitive; undefined when unknown. */
export function isObject(value: Value): boolean | undefined {
	if (value.kind === "unknown") return undefined;
	return value.kind !== "literal";
}

export function isNullish(value: Value): boolean {
	return value.kind === "literal" && (value.value === null || value.value === undefined);
}

/** One guard standing for several: every source any has; opaque when any is or two correlate. */
export function mergeGuards(guards: readonly Guard[]): Guard {
	const sources = new Set<Source>();
	for (const guard of guards) for (const source of guard.sources) sources.add(source);
	return {
		sources,
		opaque: guards.some((guard) => guard.opaque) || correlated(guards),
		conditional: guards.some((guard) => guard.conditional),
	};
}

/** Whether a path's guards make its writes uncertain. */
export function conditional(guards: readonly Guard[]): boolean {
	return guards.some((guard) => guard.conditional);
}

/** Two guards sharing a source make the path they share possibly infeasible. */
export function correlated(guards: readonly Guard[]): boolean {
	const seen = new Set<Source>();
	for (const guard of guards) {
		for (const source of guard.sources) if (seen.has(source)) return true;
		for (const source of guard.sources) seen.add(source);
	}
	return false;
}

export function opaque(guards: readonly Guard[]): boolean {
	return guards.some((guard) => guard.opaque);
}
