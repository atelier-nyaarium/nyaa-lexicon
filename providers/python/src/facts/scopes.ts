// Python's scopes, and the same-file declaration a name binds to when that is certain.

import { comparePositions } from "@nyaa-lexicon/protocol";
import type * as A from "../syntax/ast.js";
import { childNodes } from "../syntax/ast.js";
import { assignmentTargets, isAssignment, isDefinition, parameters, patternNames } from "./nodes.js";
import type {
	Position,
	RawBinding,
	RawDeclaration,
	RawDescriptor,
	RawReferenceRole,
	RawScopeInfo,
	ScopeKind,
	UnboundReason,
} from "./types.js";

////////////////////////////////
//  Interfaces & Types

export interface ScopeInfo {
	kind: ScopeKind;
	path: RawDescriptor[];
	locals: Set<string>;
	parameters: Set<string>;
	/** Never a shadow-stop for an ordinary read or write. */
	typeParameters: Set<string>;
	globals: Set<string>;
	nonlocals: Set<string>;
	conditional: Set<string>;
	starImport: boolean;
	dynamic: boolean;
}

/** Where a declaration's own path comes from, falling back to its scope and name. */
export type DeclarationPath = (
	node: A.FunctionDef | A.ClassDef | A.TypeAlias,
	scope: RawDescriptor[],
	kind: RawDescriptor["kind"],
) => RawDescriptor[];

export interface BindingQuery {
	name: string;
	role: RawReferenceRole;
	scopePath: RawDescriptor[];
	position: Position;
	bindable?: boolean;
	blockedReason?: string | undefined;
	ownerPath?: RawDescriptor[];
	blockedLocal?: boolean;
}

////////////////////////////////
//  Constants

/** Kinds a same-file typeUse reference may bind to. */
const TYPE_USE_KINDS: ReadonlySet<RawDeclaration["kind"]> = new Set([
	"class",
	"variable",
	"function",
	"interface",
	"typeParameter",
]);

const ROLES: ReadonlySet<RawReferenceRole> = new Set(["call", "read", "write", "extends", "typeUse"]);

////////////////////////////////
//  Functions & Helpers

/** A path's identity by kinds and names; a method's disambiguator does not split its scope. */
export function pathKey(path: readonly RawDescriptor[]): string {
	let key = "";
	for (const item of path) key += `${item.kind} ${item.name}/`;
	return key;
}

export function unbound(reason: UnboundReason, detail: string): RawBinding {
	return { status: "unbound", reason, detail };
}

function typeParamNames(node: A.FunctionDef | A.ClassDef | A.TypeAlias): string[] {
	return node.typeParams.map((parameter) => parameter.name);
}

////////////////////////////////
//  Classes

export class Scopes {
	readonly infos = new Map<string, ScopeInfo>();
	private readonly duplicates = new Set<string>();
	private readonly conditionalDeclarations = new Set<string>();
	private readonly declarationsByScope = new Map<string, Map<string, RawDeclaration[]>>();
	private readonly dynamicCalls = new Map<A.Node, boolean>();
	private readonly walruses = new Map<A.Node, string[]>();

	constructor(
		module: A.Module,
		private readonly declarationPath: DeclarationPath,
		occurrences: ReadonlyMap<string, readonly RawDeclaration[]>,
	) {
		this.collect(module.body, [], "module");
		for (const entries of occurrences.values()) {
			const path = (entries[0] as RawDeclaration).descriptorPath;
			if (path.length === 0) continue;
			const scope = pathKey(path.slice(0, -1));
			const name = (path.at(-1) as RawDescriptor).name;
			const byName = this.declarationsByScope.get(scope) ?? new Map<string, RawDeclaration[]>();
			byName.set(name, [...(byName.get(name) ?? []), ...entries]);
			this.declarationsByScope.set(scope, byName);
		}
	}

	info(path: readonly RawDescriptor[]): ScopeInfo | undefined {
		return this.infos.get(pathKey(path));
	}

	isConditional(path: readonly RawDescriptor[], name: string): boolean {
		return this.info(path)?.conditional.has(name) === true;
	}

	/** Every scope as the provider reads it. */
	raw(): RawScopeInfo[] {
		const sorted = (names: Set<string>): string[] => [...names].sort(codePointOrder);
		return [...this.infos.values()].map((info) => ({
			scopePath: info.path,
			kind: info.kind,
			locals: sorted(info.locals),
			parameters: sorted(info.parameters),
			globals: sorted(info.globals),
			nonlocals: sorted(info.nonlocals),
			conditional: sorted(info.conditional),
			dynamic: info.dynamic,
		}));
	}

	////////////////////////////////
	//  Collection

	private ensure(path: RawDescriptor[], kind: ScopeKind): ScopeInfo {
		const key = pathKey(path);
		const existing = this.infos.get(key);
		if (existing !== undefined) {
			if (existing.kind !== kind) this.duplicates.add(key);
			return existing;
		}
		const info: ScopeInfo = {
			kind,
			path: [...path],
			locals: new Set(),
			parameters: new Set(),
			typeParameters: new Set(),
			globals: new Set(),
			nonlocals: new Set(),
			conditional: new Set(),
			starImport: false,
			dynamic: false,
		};
		this.infos.set(key, info);
		return info;
	}

	private addName(info: ScopeInfo, name: string, conditional: boolean): void {
		info.locals.add(name);
		if (conditional) info.conditional.add(name);
	}

	private markConditional(path: RawDescriptor[], name: string, conditional: boolean): void {
		if (conditional) this.conditionalDeclarations.add(pathKey([...path, { kind: "term", name }]));
	}

	/** A call to `exec` or `eval` in a node, nested scopes aside. */
	private hasDynamicCall(node: A.Node): boolean {
		let found = this.dynamicCalls.get(node);
		if (found === undefined) {
			found =
				(node.type === "Call" &&
					node.func.type === "Name" &&
					(node.func.id === "exec" || node.func.id === "eval")) ||
				childNodes(node).some(
					(child) => !isDefinition(child) && child.type !== "Lambda" && this.hasDynamicCall(child),
				);
			this.dynamicCalls.set(node, found);
		}
		return found;
	}

	/** Names a walrus in a node binds, nested scopes and comprehensions aside. */
	private walrusNames(node: A.Node): string[] {
		let names = this.walruses.get(node);
		if (names === undefined) {
			names = node.type === "NamedExpr" && node.target.type === "Name" ? [node.target.id] : [];
			if (!isDefinition(node) && node.type !== "Lambda" && node.type !== "comprehension") {
				for (const child of childNodes(node)) names.push(...this.walrusNames(child));
			}
			this.walruses.set(node, names);
		}
		return names;
	}

	private collect(statements: A.Statement[], path: RawDescriptor[], kind: ScopeKind, conditional = false): void {
		const info = this.ensure(path, kind);
		const binds = kind === "module" || kind === "class";
		for (const node of statements) {
			if (!isDefinition(node) && this.hasDynamicCall(node)) info.dynamic = true;
			for (const name of this.walrusNames(node)) this.addName(info, name, conditional);
			switch (node.type) {
				case "Global":
					for (const name of node.names) info.globals.add(name);
					continue;
				case "Nonlocal":
					for (const name of node.names) info.nonlocals.add(name);
					continue;
				case "Import":
				case "ImportFrom":
					for (const alias of node.names) {
						if (alias.name === "*") info.starImport = true;
						else {
							const local =
								alias.asname ??
								(node.type === "Import" ? (alias.name.split(".")[0] as string) : alias.name);
							this.addName(info, local, conditional);
						}
					}
					continue;
				case "ClassDef":
				case "FunctionDef":
				case "AsyncFunctionDef": {
					this.addName(info, node.name, conditional);
					const childKind: ScopeKind = node.type === "ClassDef" ? "class" : "function";
					const childPath = this.declarationPath(node, path, childKind === "class" ? "type" : "method");
					this.markConditional(path, node.name, conditional);
					const child = this.ensure(childPath, childKind);
					for (const name of typeParamNames(node)) child.typeParameters.add(name);
					if (node.type !== "ClassDef") {
						for (const argument of parameters(node.args)) {
							this.addName(child, argument.arg, false);
							child.parameters.add(argument.arg);
						}
					}
					this.collect(node.body, childPath, childKind);
					continue;
				}
				case "TypeAlias": {
					this.addName(info, node.name.id, conditional);
					const aliasPath = this.declarationPath(node, path, "type");
					this.markConditional(path, node.name.id, conditional);
					const alias = this.ensure(aliasPath, "class");
					for (const name of typeParamNames(node)) alias.typeParameters.add(name);
					continue;
				}
			}
			if (
				isAssignment(node) ||
				node.type === "For" ||
				node.type === "AsyncFor" ||
				node.type === "With" ||
				node.type === "AsyncWith"
			) {
				for (const target of assignmentTargets(node)) {
					this.addName(info, target.id, conditional);
					if (binds) this.markConditional(path, target.id, conditional);
				}
			}
			switch (node.type) {
				case "If":
				case "For":
				case "AsyncFor":
				case "While":
					this.collect(node.body, path, kind, true);
					this.collect(node.orelse, path, kind, true);
					break;
				case "With":
				case "AsyncWith":
					this.collect(node.body, path, kind, true);
					break;
				case "Try":
				case "TryStar":
					this.collect(node.body, path, kind, true);
					for (const handler of node.handlers) {
						if (handler.name !== undefined) this.addName(info, handler.name, true);
						this.collect(handler.body, path, kind, true);
					}
					this.collect(node.orelse, path, kind, true);
					this.collect(node.finalbody, path, kind, true);
					break;
				case "Match":
					for (const matchCase of node.cases) {
						for (const name of patternNames(matchCase.pattern)) this.addName(info, name, true);
						this.collect(matchCase.body, path, kind, true);
					}
					break;
			}
		}
	}

	////////////////////////////////
	//  Binding

	private declarationCandidate(
		scope: string,
		name: string,
		role: RawReferenceRole,
		position: Position,
	): RawBinding | undefined {
		let entries = this.declarationsByScope.get(scope)?.get(name) ?? [];
		if (role === "extends") entries = entries.filter((entry) => entry.kind === "class");
		else if (role === "typeUse") entries = entries.filter((entry) => TYPE_USE_KINDS.has(entry.kind));
		// A type parameter resolves only through the enclosing-scope lookup.
		else entries = entries.filter((entry) => entry.kind !== "typeParameter");
		if (entries.length === 0) return undefined;
		if (entries.length !== 1) return unbound("Ambiguous", "multiple same-file declarations match this name");
		const declaration = entries[0] as RawDeclaration;
		if (this.conditionalDeclarations.has(pathKey(declaration.descriptorPath))) {
			return unbound("Ambiguous", "the matching declaration is conditional");
		}
		if ((role === "extends" || role === "typeUse") && comparePositions(declaration.range.start, position) > 0) {
			return unbound("NotImplemented", "forward base or annotation binding is not supported");
		}
		return { status: "bound", descriptorPath: declaration.descriptorPath };
	}

	private typeParameterCandidate(owner: readonly RawDescriptor[], name: string): RawBinding | undefined {
		const entries = (this.declarationsByScope.get(pathKey(owner))?.get(name) ?? []).filter(
			(entry) => entry.kind === "typeParameter",
		);
		if (entries.length === 0) return undefined;
		if (entries.length !== 1) return unbound("Ambiguous", "multiple same-file declarations match this name");
		return { status: "bound", descriptorPath: (entries[0] as RawDeclaration).descriptorPath };
	}

	/** Reaches through every ancestor, class bodies included. */
	private enclosingTypeParameter(path: readonly RawDescriptor[], name: string): RawBinding | undefined {
		for (let length = path.length; length > 0; length--) {
			const candidate = this.typeParameterCandidate(path.slice(0, length), name);
			if (candidate !== undefined) return candidate;
		}
		return undefined;
	}

	private resolveLevel(
		path: readonly RawDescriptor[],
		name: string,
		role: RawReferenceRole,
		position: Position,
		current: string,
		nonlocal: boolean,
	): RawBinding | undefined {
		const key = pathKey(path);
		const info = this.infos.get(key);
		if (info === undefined) return undefined;
		if (this.duplicates.has(key)) return unbound("Ambiguous", "same-named scopes make this lookup ambiguous");
		if (info.dynamic) return unbound("RuntimeConstructed", "exec or eval can change this scope");
		if (nonlocal && (key === current || info.kind !== "function")) return undefined;
		if (info.conditional.has(name)) return unbound("Ambiguous", "a conditional definition can shadow this name");
		const candidate = this.declarationCandidate(key, name, role, position);
		if (candidate?.status === "bound" && path.length === 0 && info.starImport) {
			return unbound("Ambiguous", "a star import can shadow module names");
		}
		if (candidate !== undefined) return candidate;
		if (info.locals.has(name)) return unbound("NotIndexed", "local, parameter, or imported binding is not indexed");
		if (nonlocal && info.kind === "function") return unbound("NotIndexed", "the nonlocal target is not indexed");
		return undefined;
	}

	bindingFor(query: BindingQuery): RawBinding {
		const { name, role, scopePath, position } = query;
		if (query.bindable === false) return unbound("Ambiguous", "attribute binding requires a resolved receiver");
		if (!ROLES.has(role)) return unbound("NotImplemented", "this reference role is not indexed");
		const current = pathKey(scopePath);
		const info = this.infos.get(current);
		const global = info?.kind === "function" && info.globals.has(name);
		const nonlocal = info?.kind === "function" && info.nonlocals.has(name);

		// A closer ordinary binding wins over a type parameter.
		if (query.blockedReason === undefined && !global) {
			const result = this.resolveLevel(scopePath, name, role, position, current, nonlocal);
			if (result !== undefined) return result;
		}

		// Then the type parameters of this declaration and its ancestors.
		if ((role === "typeUse" || role === "read") && !global && !nonlocal && query.blockedLocal !== true) {
			const owner = query.ownerPath ?? [];
			if (role === "typeUse" && owner.length > 0) {
				const candidate = this.typeParameterCandidate(owner, name);
				if (candidate !== undefined) return candidate;
			}
			const candidate = this.enclosingTypeParameter(scopePath, name);
			if (candidate !== undefined) return candidate;
		}

		if (query.blockedReason !== undefined) return unbound("NotIndexed", query.blockedReason);
		if (info === undefined) return unbound("NotImplemented", "reference scope is not indexed");
		if (info.dynamic) return unbound("RuntimeConstructed", "exec or eval can change this scope");

		// Last, the enclosing ordinary scopes, skipping class bodies around a method.
		const paths: RawDescriptor[][] = [];
		if (global) paths.push([]);
		else {
			let path = scopePath;
			while (path.length > 0) {
				let parent = path.slice(0, -1);
				if (
					parent.length > 0 &&
					parent.at(-1)?.kind === "type" &&
					scopePath.slice(parent.length).some((item) => item.kind === "method")
				) {
					parent = parent.slice(0, -1);
				}
				paths.push(parent);
				path = parent;
			}
		}
		for (const path of paths) {
			const result = this.resolveLevel(path, name, role, position, current, nonlocal);
			if (result !== undefined) return result;
		}
		return unbound("NotImplemented", "no certain same-file declaration; cross-file binding is not implemented");
	}
}

/** Python sorts strings by code point; UTF-16 units disagree past the surrogates. */
export function codePointOrder(left: string, right: string): number {
	const a = [...left];
	const b = [...right];
	for (let index = 0; index < Math.min(a.length, b.length); index++) {
		const difference = (a[index]?.codePointAt(0) as number) - (b[index]?.codePointAt(0) as number);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}
