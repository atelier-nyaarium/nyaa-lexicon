// Where a name lives and which declaration it reaches: scopes, identity, and settlement.

import {
	comparePositions,
	composeSymbolId,
	type Descriptor,
	defined,
	type HeaderSpan,
	type Position,
	type Range,
	type SymbolKind,
	type Visibility,
} from "@nyaa-lexicon/protocol";
import {
	baseTypeName,
	keyOf,
	LANGUAGE,
	type PowerShellDeclaration,
	type PowerShellReference,
	type Scope,
	splitScope,
	staticText,
	type Walk,
} from "./context.js";
import type * as A from "./syntax/ast.js";

////////////////////////////////
//  Interfaces & Types

export interface DeclareOptions {
	name: string;
	kind: SymbolKind;
	descriptor: Descriptor["kind"];
	languageKind?: string;
	selection: Range;
	range: Range;
	visibility: Visibility;
	exported?: boolean;
	header?: HeaderSpan;
	declaredType?: string;
	inferredType?: string;
}

////////////////////////////////
//  Functions & Helpers

export function childScope(w: Walk, scope: Scope, kind: Scope["kind"], declaration?: PowerShellDeclaration): Scope {
	const own = declaration === undefined ? undefined : w.descriptors.get(declaration);
	return {
		kind,
		descriptors: own === undefined ? scope.descriptors : [...scope.descriptors, own],
		locals: new Map(),
		parent: scope,
		...defined({
			fromId: declaration?.symbolId ?? scope.fromId,
			typeName: scope.typeName,
			// A script block runs apart from its function, so its output is its own.
			owner: kind === "function" ? declaration : kind === "block" ? undefined : scope.owner,
		}),
	};
}

/** A repeated name path carries an occurrence, so what it holds nests under its own definition. */
function mint(w: Walk, descriptors: Descriptor[]): { id: string; own: Descriptor } {
	const base = composeSymbolId({ language: LANGUAGE, module: w.module, descriptors });
	const seen = (w.minted.get(base) ?? 0) + 1;
	w.minted.set(base, seen);
	const last = descriptors.at(-1) as Descriptor;
	if (seen === 1) return { id: base, own: last };
	const own = { ...last, occurrence: seen };
	return {
		id: composeSymbolId({ language: LANGUAGE, module: w.module, descriptors: [...descriptors.slice(0, -1), own] }),
		own,
	};
}

export function declare(w: Walk, scope: Scope, options: DeclareOptions): PowerShellDeclaration {
	const { id, own } = mint(w, [...scope.descriptors, { kind: options.descriptor, name: options.name }]);
	const declaration: PowerShellDeclaration = {
		symbolId: id,
		kind: options.kind,
		...defined({ languageKind: options.languageKind }),
		name: options.name,
		range: options.range,
		selectionRange: options.selection,
		visibility: options.visibility,
		...defined({ exported: options.exported }),
		...(scope.fromId === undefined ? {} : { containerId: scope.fromId }),
		...defined({ declaredType: options.declaredType, inferredType: options.inferredType }),
	};
	w.descriptors.set(declaration, own);
	w.out.declarations.push(declaration);
	if (options.header !== undefined) w.headers.push({ declaration, span: options.header });
	return declaration;
}

/** Where an assignment lands: the nearest function, or the script; a script block runs in its caller. */
export function landing(scope: Scope): Scope {
	for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) {
		if (s.kind === "function" || s.kind === "script") return s;
	}
	return scope;
}

/** The variable a read reaches: the nearest enclosing local, then the script's. */
export function resolveVariable(
	w: Walk,
	scope: Scope,
	name: string,
	qualifier: string | undefined,
	at?: Range["start"],
): PowerShellDeclaration | undefined {
	const key = keyOf(name);
	if (qualifier === "script" || qualifier === "global") return w.script.locals.get(key);
	for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) {
		const local = s.locals.get(key);
		if (local !== undefined) {
			// An enclosing function's local is live whenever this body runs, wherever it was declared.
			const live = at === undefined || s.fromId !== scope.fromId;
			if (live || comparePositions(local.range.start, at) <= 0) return local;
		}
		if ((qualifier === "local" || qualifier === "private") && s.kind !== "block") return undefined;
	}
	return undefined;
}

/**
 * The function a command name reaches. One defined in the same body runs in order, so it counts
 * only before the call; one defined around that body was defined before it ran, so the last counts.
 */
export function functionFor(
	w: Walk,
	scope: Scope,
	name: string,
	at: Range["start"],
): PowerShellDeclaration | undefined {
	const body = landing(scope);
	return (w.out.functionsByName.get(keyOf(name)) ?? [])
		.filter((definition) => {
			const home = w.definedIn.get(definition);
			if (home === undefined) return true;
			if (!encloses(home, scope)) return false;
			return landing(home) !== body || comparePositions(definition.range.start, at) < 0;
		})
		.at(-1);
}

function encloses(outer: Scope, inner: Scope): boolean {
	for (let s: Scope | undefined = inner; s !== undefined; s = s.parent) if (s === outer) return true;
	return false;
}

////////////////////////////////
//  Inference

/** Past this many steps, a chain of values names no type rather than loop. */
const MAX_INFERENCE_DEPTH = 32;

/**
 * The class an expression's value holds, by how it is written: `$this`, a variable's declared or
 * first value, `[T]::new()`, a cast, a member's declared type, a call's returns.
 */
export function typeOfExpression(
	w: Walk,
	scope: Scope,
	expression: A.Expression,
	at: Position,
	depth = 0,
): string | undefined {
	if (depth > MAX_INFERENCE_DEPTH) return undefined;
	switch (expression.type) {
		case "ConstantExpressionAst":
			return expression.staticType;
		case "StringConstantExpressionAst":
		case "ExpandableStringExpressionAst":
			return expression.stringKind === "BareWord" ? undefined : "string";
		case "ArrayLiteralAst":
		case "ArrayExpressionAst":
			return "object[]";
		case "HashtableAst":
			return "hashtable";
		case "ScriptBlockExpressionAst":
			return "scriptblock";
		case "VariableExpressionAst": {
			const { scope: qualifier, name } = splitScope(expression.path);
			const key = keyOf(name);
			if (qualifier === undefined && key === "this") return scope.typeName;
			if (qualifier === undefined && (key === "true" || key === "false")) return "bool";
			const variable = resolveVariable(w, scope, name, qualifier, at);
			return variable === undefined ? undefined : typeOfDeclaration(w, variable, depth + 1);
		}
		case "ConvertExpressionAst":
			return baseTypeName(expression.typeConstraint.typeName).name;
		case "ParenExpressionAst":
			return typeOfStatement(w, scope, expression.pipeline, at, depth + 1);
		case "IndexExpressionAst":
			// An element of a typed array; PowerShell also reaches a member through a whole array.
			return typeOfExpression(w, scope, expression.target, at, depth + 1);
		case "MemberExpressionAst":
		case "InvokeMemberExpressionAst": {
			const member = staticText(expression.member as A.Expression);
			if (member === undefined) return undefined;
			const arity = expression.type === "InvokeMemberExpressionAst" ? expression.arguments.length : undefined;
			if (expression.target.type === "TypeExpressionAst") {
				const typeName = baseTypeName(expression.target.typeName).name;
				if (arity !== undefined && keyOf(member) === "new") return typeName;
				return memberType(w, typeName, member, arity, depth);
			}
			const target = typeOfExpression(w, scope, expression.target, at, depth + 1);
			return target === undefined ? undefined : memberType(w, target, member, arity, depth);
		}
		default:
			return undefined;
	}
}

/** A statement's value: an expression's, `New-Object T`, or a call to a function whose output says. */
function typeOfStatement(
	w: Walk,
	scope: Scope,
	statement: A.Statement,
	at: Position,
	depth: number,
): string | undefined {
	if (statement.type === "CommandExpressionAst") return typeOfExpression(w, scope, statement.expression, at, depth);
	if (statement.type !== "PipelineAst" || statement.elements.length !== 1) return undefined;
	const element = statement.elements[0] as A.CommandBase;
	if (element.type === "CommandExpressionAst") return typeOfExpression(w, scope, element.expression, at, depth);
	const [name, ...rest] = element.elements;
	const command = staticText(name as A.Expression);
	if (command === undefined) return undefined;
	if (keyOf(command) === "new-object") {
		const named = rest.find(
			(part) => part.type === "CommandParameterAst" && "typename".startsWith(keyOf(part.parameterName)),
		);
		if (named?.type === "CommandParameterAst") return staticText(named.argument);
		return staticText(rest.find((part) => part.type !== "CommandParameterAst") as A.Expression | undefined);
	}
	const called = functionFor(w, scope, command, at);
	return called === undefined ? undefined : typeOfDeclaration(w, called, depth + 1);
}

function memberType(
	w: Walk,
	typeName: string,
	member: string,
	arity: number | undefined,
	depth: number,
): string | undefined {
	const declaration = memberOf(w, typeName, member, arity);
	return declaration === undefined ? undefined : typeOfDeclaration(w, declaration, depth + 1);
}

/**
 * A declaration's type: declared, else inferred once, from its first value or from what its body
 * outputs when every output that names a type names the same one.
 */
export function typeOfDeclaration(w: Walk, declaration: PowerShellDeclaration, depth = 0): string | undefined {
	if (declaration.declaredType !== undefined) return declaration.declaredType;
	if (w.inferring.has(declaration)) return w.inferring.get(declaration) ?? undefined;
	w.inferring.set(declaration, null);
	const first = w.firstValues.get(declaration);
	let inferred: string | undefined;
	let basis: string | undefined;
	if (first !== undefined) {
		inferred = typeOfStatement(w, first.scope, first.statement, first.at, depth + 1);
		basis = "assigned value";
	} else {
		const types = new Map<string, string>();
		for (const { statement, scope, at } of w.outputs.get(declaration) ?? []) {
			const type = typeOfStatement(w, scope, statement, at, depth + 1);
			if (type !== undefined && keyOf(type) !== "void") types.set(keyOf(type), type);
		}
		if (types.size === 1) {
			inferred = [...types.values()][0];
			basis = "output";
		}
	}
	w.inferring.set(declaration, inferred ?? null);
	if (inferred !== undefined) {
		declaration.inferredType = inferred;
		if (basis !== undefined) declaration.inferredBasis = basis;
	}
	return inferred;
}

/**
 * A class's members by a name: a call's methods, narrowed by argument count when that fits some, or
 * a read's properties.
 */
export function membersOf(
	types: ReadonlyMap<string, PowerShellDeclaration>,
	typeName: string | undefined,
	name: string,
	arity?: number,
): PowerShellDeclaration[] {
	if (typeName === undefined) return [];
	const all = types.get(keyOf(typeName))?.members?.get(keyOf(name)) ?? [];
	const callable = (member: PowerShellDeclaration) => member.kind === "method" || member.kind === "constructor";
	const kinds = all.filter((member) => callable(member) === (arity !== undefined));
	const named = kinds.length > 0 ? kinds : all;
	if (arity === undefined) return named;
	const fitting = named.filter((member) => (member.metrics?.parameters ?? 0) === arity);
	return fitting.length > 0 ? fitting : named;
}

/** A member of a class or enum in this file; among overloads, the first. */
export function memberOf(
	w: Walk,
	typeName: string | undefined,
	name: string,
	arity?: number,
): PowerShellDeclaration | undefined {
	return membersOf(w.out.typesByName, typeName, name, arity)[0];
}

/** Parameters every advanced function takes, by name and alias. */
const COMMON_PARAMETERS: readonly string[] = [
	"verbose",
	"vb",
	"debug",
	"db",
	"erroraction",
	"ea",
	"warningaction",
	"wa",
	"informationaction",
	"infa",
	"progressaction",
	"proga",
	"errorvariable",
	"ev",
	"warningvariable",
	"wv",
	"informationvariable",
	"iv",
	"outvariable",
	"ov",
	"outbuffer",
	"ob",
	"pipelinevariable",
	"pv",
	"whatif",
	"wi",
	"confirm",
	"cf",
];

/**
 * A parameter as PowerShell binds a named argument: by its name or alias, else by a prefix only it
 * starts with. An advanced function's common parameters take part, so `-Verbose` names none of its own.
 */
export function parameterOf(
	command: PowerShellDeclaration | undefined,
	name: string,
): PowerShellDeclaration | undefined {
	const parameters = command?.parameters;
	if (parameters === undefined) return undefined;
	const key = keyOf(name);
	const exact = parameters.get(key);
	if (exact !== undefined) return exact;
	const common = command?.advanced === true ? COMMON_PARAMETERS : [];
	if (common.includes(key)) return undefined;
	const matching = new Set<PowerShellDeclaration>();
	for (const [candidate, parameter] of parameters) if (candidate.startsWith(key)) matching.add(parameter);
	const clashes = common.some((candidate) => candidate.startsWith(key));
	return matching.size === 1 && !clashes ? [...matching][0] : undefined;
}

/**
 * A name settles once every declaration is known, against the scope it was read in. A member keeps
 * its receiver's class by name, so one whose class lives in another file binds there. Every inferred
 * type settles too, for `typeOf`.
 */
export function settle(w: Walk): void {
	for (const { reference, scope, receiver } of w.pending) {
		const of = reference.of;
		const typed =
			of.kind === "member" && of.typeName === undefined && receiver !== undefined
				? typeOfExpression(w, scope, receiver, reference.range.start)
				: undefined;
		const read = typed === undefined ? reference : { ...reference, of: { ...of, typeName: typed } };
		const callee = calleeOf(w, scope, read);
		const target = read.target ?? settled(w, scope, read, callee)?.symbolId;
		w.out.references.push({ ...read, ...defined({ target, callee: callee?.symbolId }) });
	}
	for (const declaration of w.out.declarations) typeOfDeclaration(w, declaration);
}

/** The function a command or a named argument reaches. */
function calleeOf(w: Walk, scope: Scope, reference: PowerShellReference): PowerShellDeclaration | undefined {
	const at = reference.range.start;
	if (reference.of.kind === "command") return functionFor(w, scope, reference.name, at);
	if (reference.of.kind === "parameter") return functionFor(w, scope, reference.of.command, at);
	return undefined;
}

function settled(
	w: Walk,
	scope: Scope,
	reference: PowerShellReference,
	callee: PowerShellDeclaration | undefined,
): PowerShellDeclaration | undefined {
	const at = reference.range.start;
	switch (reference.of.kind) {
		case "variable":
			return resolveVariable(w, scope, reference.name, reference.of.scope, at);
		case "command":
			return callee;
		case "type":
			return w.out.typesByName.get(keyOf(reference.name));
		case "member": {
			// Overloads the call cannot tell apart leave it to binding, which names them all.
			const members = membersOf(w.out.typesByName, reference.of.typeName, reference.name, reference.of.arity);
			return members.length === 1 ? members[0] : undefined;
		}
		case "parameter":
			return parameterOf(callee, reference.name);
	}
}
