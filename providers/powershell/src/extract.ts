// The walk over the syntax tree: what each node means to an index.

import { coordinatesOf, defined, type HeaderFold, type Range } from "@nyaa-lexicon/protocol";
import {
	baseTypeName,
	isAutomatic,
	keyOf,
	type ParsedPowerShellFile,
	type PowerShellDeclaration,
	pushLiteral,
	pushReference,
	rangeAt,
	type Scope,
	splitScope,
	staticText,
	type Walk,
	wildcardMatches,
} from "./context.js";
import { childScope, declare, landing, settle } from "./scope.js";
import type * as A from "./syntax/ast.js";
import { parsePowerShell } from "./syntax/parser.js";
import { blankLinesOf, commentSpans, signHeaders } from "./trivia.js";

export type {
	ParsedPowerShellFile,
	PowerShellDeclaration,
	PowerShellReference,
	SourceImport,
} from "./context.js";
export { LANGUAGE } from "./context.js";

////////////////////////////////
//  Constants

/** Scopes a variable path may name; any other prefix is a drive, as `env:`. */
const SCOPES: ReadonlySet<string> = new Set(["script", "global", "local", "private"]);

/** Common parameters that name a variable to fill. */
const VARIABLE_PARAMETERS: ReadonlySet<string> = new Set([
	"outvariable",
	"ov",
	"errorvariable",
	"ev",
	"warningvariable",
	"wv",
	"informationvariable",
	"iv",
	"pipelinevariable",
	"pv",
]);

/** Switch parameters of the commands read here, which take no value after them. */
const SWITCHES: ReadonlySet<string> = new Set([
	"force",
	"global",
	"passthru",
	"ascustomobject",
	"disablenamechecking",
	"noclobber",
	"skipeditioncheck",
	"usewindowspowershell",
	"strict",
]);

/** Attributes that make a function advanced, so it takes the common parameters. */
const ADVANCED_ATTRIBUTES: ReadonlySet<string> = new Set(["cmdletbinding", "parameter"]);

/** Commands that prepare a script rather than run it. */
const SETUP_COMMANDS: ReadonlySet<string> = new Set([
	"import-module",
	"ipmo",
	"set-strictmode",
	"export-modulemember",
	"add-type",
	"set-alias",
	"new-alias",
	"register-argumentcompleter",
	"update-formatdata",
	"update-typedata",
]);

////////////////////////////////
//  Functions & Helpers

/** A path a script names beside itself: `$PSScriptRoot` or a relative path. */
function scriptPath(expression: A.Expression | undefined): string | undefined {
	const text = staticText(expression);
	// A `$` nothing expands names a file literally, which `$PSScriptRoot` in a path must not read as.
	if (text !== undefined) return text.startsWith("$") ? undefined : text;
	if (expression?.type === "ParenExpressionAst") return joinedPath(expression);
	if (expression?.type !== "ExpandableStringExpressionAst") return undefined;
	const [first, ...rest] = expression.nestedExpressions;
	// `"$PSScriptRoot\x.ps1"`: the file's own folder, then text.
	if (!isScriptRoot(first) || rest.length > 0) return undefined;
	return expression.value;
}

function isScriptRoot(expression: A.Expression | undefined): boolean {
	return expression?.type === "VariableExpressionAst" && keyOf(expression.path) === "psscriptroot";
}

/** `(Join-Path $PSScriptRoot x.ps1)`, as `$PSScriptRoot/x.ps1`. */
function joinedPath(expression: A.ParenExpression): string | undefined {
	const pipeline = expression.pipeline;
	const command =
		pipeline.type === "PipelineAst" && pipeline.elements.length === 1 ? pipeline.elements[0] : undefined;
	if (command?.type !== "CommandAst") return undefined;
	const [name, ...rest] = command.elements;
	if (keyOf(staticText(name as A.Expression) ?? "") !== "join-path") return undefined;
	const values = rest.flatMap((element) =>
		element.type === "CommandParameterAst" ? (element.argument === undefined ? [] : [element.argument]) : [element],
	);
	const [root, child] = values;
	const tail = staticText(child);
	return isScriptRoot(root) && tail !== undefined && values.length === 2 ? `$PSScriptRoot/${tail}` : undefined;
}

/** Each name a list of strings holds: one string, an array of them, or a module specification's name. */
function staticNames(expression: A.Expression | undefined): string[] {
	if (expression?.type === "ArrayLiteralAst") return expression.elements.flatMap((element) => staticNames(element));
	if (expression?.type === "HashtableAst") {
		for (const [key, value] of expression.pairs) {
			if (keyOf(staticText(key) ?? "") !== "modulename") continue;
			const element = value.type === "PipelineAst" ? value.elements[0] : undefined;
			return element?.type === "CommandExpressionAst" ? staticNames(element.expression) : [];
		}
		return [];
	}
	if (expression?.type === "ParenExpressionAst" || expression?.type === "ArrayExpressionAst") {
		// `@(...)` may hold a name per line.
		const inner =
			expression.type === "ParenExpressionAst" ? [expression.pipeline] : expression.statements.statements;
		return inner.flatMap((statement) =>
			statement.type === "PipelineAst" && statement.elements[0]?.type === "CommandExpressionAst"
				? staticNames(statement.elements[0].expression)
				: [],
		);
	}
	const text = staticText(expression);
	return text === undefined ? [] : [text];
}

/** `[OutputType([T])]` or `[OutputType("T")]` on a function's `param`. */
function outputType(block: A.ScriptBlock): string | undefined {
	for (const attribute of block.paramBlock?.attributes ?? []) {
		if (keyOf(attribute.typeName.name) !== "outputtype") continue;
		const [first] = attribute.positionalArguments;
		if (first?.type === "TypeExpressionAst") return baseTypeName(first.typeName).name;
		const named = staticText(first);
		if (named !== undefined) return named;
	}
	return undefined;
}

function isModule(module: string): boolean {
	return keyOf(module).endsWith(".psm1");
}

function isManifest(module: string): boolean {
	return keyOf(module).endsWith(".psd1");
}

////////////////////////////////
//  Walks

function walkScriptBlock(w: Walk, scope: Scope, block: A.ScriptBlock): void {
	for (const using of block.usingStatements) walkUsing(w, scope, using);
	for (const named of block.blocks) walkStatementList(w, scope, named.statements, named.traps);
}

function walkStatementList(w: Walk, scope: Scope, statements: A.Statement[], traps: A.TrapStatement[]): void {
	const all: A.Statement[] = [...statements, ...traps].sort((a, b) => a.pos - b.pos);
	for (const statement of all) {
		walkStatement(w, scope, statement);
		// A function outputs every pipeline its body leaves uncaptured; a method only what it returns.
		const owner = scope.owner;
		if (
			owner?.kind === "function" &&
			(statement.type === "PipelineAst" || statement.type === "CommandExpressionAst")
		)
			output(w, scope, owner, statement);
	}
}

function output(w: Walk, scope: Scope, owner: PowerShellDeclaration, statement: A.Statement): void {
	const written = { statement, scope, at: rangeAt(w, statement.pos, statement.pos).start };
	w.outputs.set(owner, [...(w.outputs.get(owner) ?? []), written]);
}

function walkBlock(w: Walk, scope: Scope, block: A.StatementBlock | undefined): void {
	if (block !== undefined) walkStatementList(w, scope, block.statements, block.traps);
}

function walkStatement(w: Walk, scope: Scope, node: A.Statement): void {
	switch (node.type) {
		case "FunctionDefinitionAst":
			walkFunction(w, scope, node);
			break;
		case "TypeDefinitionAst":
			walkType(w, scope, node);
			break;
		case "AssignmentStatementAst":
			walkStatement(w, scope, node.right);
			assign(w, scope, node.left, node, node.right);
			break;
		case "PipelineAst":
			for (const element of node.elements) {
				if (element.type === "CommandAst") walkCommand(w, scope, element);
				else walkCommandExpression(w, scope, element);
			}
			break;
		case "CommandExpressionAst":
			walkCommandExpression(w, scope, node);
			break;
		case "PipelineChainAst":
			walkStatement(w, scope, node.left);
			walkStatement(w, scope, node.right);
			break;
		case "IfStatementAst":
			for (const [condition, body] of node.clauses) {
				walkStatement(w, scope, condition);
				walkBlock(w, scope, body);
			}
			walkBlock(w, scope, node.elseClause);
			break;
		case "WhileStatementAst":
		case "DoWhileStatementAst":
		case "DoUntilStatementAst":
			walkStatement(w, scope, node.condition);
			walkBlock(w, scope, node.body);
			break;
		case "ForStatementAst":
			for (const part of [node.initializer, node.condition, node.iterator])
				if (part) walkStatement(w, scope, part);
			walkBlock(w, scope, node.body);
			break;
		case "ForEachStatementAst":
			walkStatement(w, scope, node.condition);
			if (node.throttleLimit !== undefined) walkExpression(w, scope, node.throttleLimit);
			writeVariable(w, scope, node.variable, node.variable, undefined, undefined);
			walkBlock(w, scope, node.body);
			break;
		case "SwitchStatementAst":
			if (node.condition !== undefined) walkStatement(w, scope, node.condition);
			for (const [condition, body] of node.clauses) {
				walkArgument(w, scope, condition);
				walkBlock(w, scope, body);
			}
			walkBlock(w, scope, node.defaultClause);
			break;
		case "TryStatementAst":
			walkBlock(w, scope, node.body);
			for (const clause of node.catchClauses) {
				for (const type of clause.catchTypes) typeUse(w, scope, type.typeName);
				walkBlock(w, scope, clause.body);
			}
			walkBlock(w, scope, node.finallyClause);
			break;
		case "TrapStatementAst":
			if (node.trapType !== undefined) typeUse(w, scope, node.trapType.typeName);
			walkBlock(w, scope, node.body);
			break;
		case "BreakStatementAst":
		case "ContinueStatementAst":
			break;
		case "ReturnStatementAst":
			if (node.pipeline === undefined) break;
			walkStatement(w, scope, node.pipeline);
			if (scope.owner !== undefined) output(w, scope, scope.owner, node.pipeline);
			break;
		case "ExitStatementAst":
		case "ThrowStatementAst":
			if (node.pipeline !== undefined) walkStatement(w, scope, node.pipeline);
			break;
		case "UsingStatementAst":
			walkUsing(w, scope, node);
			break;
		case "DataStatementAst":
			for (const command of node.commandsAllowed) walkExpression(w, scope, command);
			walkBlock(w, scope, node.body);
			break;
		case "ConfigurationDefinitionAst":
			walkConfiguration(w, scope, node);
			break;
		case "BlockStatementAst":
			walkBlock(w, scope, node.body);
			break;
	}
}

function walkCommandExpression(w: Walk, scope: Scope, node: A.CommandExpression): void {
	walkExpression(w, scope, node.expression);
	for (const redirection of node.redirections) walkRedirection(w, scope, redirection);
}

function walkRedirection(w: Walk, scope: Scope, redirection: A.Redirection): void {
	if (redirection.type === "FileRedirectionAst") walkArgument(w, scope, redirection.location);
}

function walkUsing(w: Walk, scope: Scope, node: A.UsingStatement): void {
	const name = node.name?.value;
	if (node.usingKind === "Module" && name !== undefined) importSource(w, name, node, "module");
	else if (name !== undefined) w.out.imports.push({ specifier: name, imported: [], reExport: false });
	if (node.moduleSpecification !== undefined) {
		for (const specified of staticNames(node.moduleSpecification)) importSource(w, specified, node, "module");
		walkExpression(w, scope, node.moduleSpecification);
	}
}

function importSource(w: Walk, specifier: string, at: A.Span, kind: "dotSource" | "module"): void {
	w.out.imports.push({ specifier, imported: [], reExport: false });
	w.out.sources.push({ specifier, kind, range: rangeAt(w, at.pos, at.end) });
}

////////////////////////////////
//  Declarations

/** A function's header: its keyword and name, then its parameters. */
function functionHeader(node: A.FunctionDefinition): {
	lead?: { start: number; end: number };
	start: number;
	end: number;
} {
	const params = node.body.paramBlock;
	if (params === undefined) return { start: node.pos, end: node.body.pos };
	return { lead: { start: node.pos, end: node.body.pos }, start: params.pos, end: params.end };
}

function linesOf(range: Range): number {
	return range.end.line - range.start.line + 1;
}

function walkFunction(w: Walk, scope: Scope, node: A.FunctionDefinition): void {
	const { name } = splitScope(node.name);
	const written = node.nameSpan;
	const selection = rangeAt(w, Math.max(written.pos, written.end - name.length), written.end);
	const range = rangeAt(w, node.pos, node.end);
	const nested = scope.kind !== "script";
	const parameters = [...node.parameters, ...(node.body.paramBlock?.parameters ?? [])];
	const declaration = declare(w, scope, {
		name,
		kind: "function",
		descriptor: "method",
		...defined({
			languageKind: node.isFilter ? "filter" : node.isWorkflow ? "workflow" : undefined,
			declaredType: outputType(node.body),
		}),
		selection,
		range,
		visibility: nested ? "local" : "public",
		header: functionHeader(node),
	});
	declaration.metrics = { lines: linesOf(range), parameters: parameters.length };
	const key = keyOf(name);
	const definitions = w.out.functionsByName.get(key);
	if (definitions === undefined) w.out.functionsByName.set(key, [declaration]);
	else definitions.push(declaration);
	w.definedIn.set(declaration, scope);
	const inner = childScope(w, scope, "function", declaration);
	declaration.parameters = new Map();
	for (const parameter of parameters) declareParameter(w, inner, parameter, declaration);
	const attributes = [
		...(node.body.paramBlock?.attributes ?? []),
		...parameters.flatMap((parameter) => parameter.attributes),
	];
	if (attributes.some((attribute) => ADVANCED_ATTRIBUTES.has(attributeName(attribute)))) declaration.advanced = true;
	walkScriptBlockBody(w, inner, node.body);
}

/** An attribute's class name, lowercase, without namespace or `Attribute`. */
function attributeName(attribute: A.AttributeBase): string {
	const parts = keyOf(attribute.typeName.name).split(".");
	const last = parts.at(-1) ?? "";
	return last.endsWith("attribute") ? last.slice(0, -"attribute".length) : last;
}

/** A body whose parameters are declared already. */
function walkScriptBlockBody(w: Walk, scope: Scope, block: A.ScriptBlock): void {
	for (const attribute of block.paramBlock?.attributes ?? []) walkAttribute(w, scope, attribute);
	walkScriptBlock(w, scope, block);
}

function declareParameter(w: Walk, scope: Scope, node: A.Parameter, owner?: PowerShellDeclaration): void {
	const variable = node.name;
	const { name } = splitScope(variable.path);
	const constraint = node.attributes.find((attribute) => attribute.type === "TypeConstraintAst");
	for (const attribute of node.attributes) walkAttribute(w, scope, attribute);
	if (node.defaultValue !== undefined) walkExpression(w, scope, node.defaultValue);
	const declaration = declare(w, scope, {
		name,
		kind: "variable",
		// A script's own parameters sit at its top level, under no callable.
		descriptor: scope.kind === "script" ? "term" : "parameter",
		languageKind: "parameter",
		selection: variableSelection(w, variable, name),
		range: rangeAt(w, node.pos, node.end),
		visibility: "local",
		header: { start: node.pos, end: node.end },
		...defined({ declaredType: constraint === undefined ? undefined : baseTypeName(constraint.typeName).name }),
	});
	scope.locals.set(keyOf(name), declaration);
	owner?.parameters?.set(keyOf(name), declaration);
	for (const attribute of node.attributes) {
		if (attribute.type !== "AttributeAst" || attributeName(attribute) !== "alias") continue;
		for (const argument of attribute.positionalArguments)
			for (const alias of staticNames(argument)) owner?.parameters?.set(keyOf(alias), declaration);
	}
}

/** The name alone, without `$`, `@`, braces or a scope; a braced name as written, escapes and all. */
function variableSelection(w: Walk, variable: A.VariableExpression, name: string): Range {
	if (variable.braced) {
		const qualifier = variable.path.length - name.length;
		return rangeAt(w, Math.min(variable.pos + 2 + qualifier, variable.end - 1), variable.end - 1);
	}
	return rangeAt(w, Math.max(variable.pos, variable.end - name.length), variable.end);
}

function walkType(w: Walk, scope: Scope, node: A.TypeDefinition): void {
	const range = rangeAt(w, node.pos, node.end);
	const declaration = declare(w, scope, {
		name: node.name,
		kind: node.isEnum ? "enum" : "class",
		descriptor: "type",
		selection: rangeAt(w, node.nameSpan.pos, node.nameSpan.end),
		range,
		visibility: "public",
		header: { start: node.pos, end: node.bodyStart },
	});
	declaration.metrics = { lines: linesOf(range) };
	declaration.members = new Map();
	const key = keyOf(node.name);
	if (!w.out.typesByName.has(key)) w.out.typesByName.set(key, declaration);
	for (const attribute of node.attributes) walkAttribute(w, scope, attribute);
	for (const [index, base] of node.baseTypes.entries()) {
		const type = baseTypeName(base.typeName);
		pushReference(w, scope, {
			name: type.name,
			range: rangeAt(w, type.pos, type.pos + type.name.length),
			role: index === 0 && !node.isEnum ? "extends" : "implements",
			of: { kind: "type" },
			qualified: false,
		});
		for (const argument of base.typeName.arguments ?? []) typeUse(w, scope, argument);
	}
	const inner: Scope = { ...childScope(w, scope, "type", declaration), typeName: node.name };
	for (const member of node.members) {
		const declared =
			member.type === "PropertyMemberAst"
				? walkProperty(w, inner, member, node.isEnum)
				: walkMethod(w, inner, member);
		const memberKey = keyOf(declared.name);
		const same = declaration.members.get(memberKey);
		if (same === undefined) declaration.members.set(memberKey, [declared]);
		else same.push(declared);
	}
}

function walkProperty(w: Walk, scope: Scope, node: A.PropertyMember, inEnum: boolean): PowerShellDeclaration {
	for (const attribute of node.attributes) walkAttribute(w, scope, attribute);
	if (node.propertyType !== undefined) typeUse(w, scope, node.propertyType.typeName);
	if (node.initialValue !== undefined) walkExpression(w, scope, node.initialValue);
	return declare(w, scope, {
		name: node.name,
		kind: inEnum ? "constant" : "property",
		descriptor: "term",
		...defined({ languageKind: inEnum ? "enumMember" : node.isStatic ? "static" : undefined }),
		selection: rangeAt(w, node.nameSpan.pos, node.nameSpan.end),
		range: rangeAt(w, node.pos, node.end),
		visibility: "public",
		header: { start: node.pos, end: node.end },
		...defined({
			declaredType: node.propertyType === undefined ? undefined : baseTypeName(node.propertyType.typeName).name,
		}),
	});
}

function walkMethod(w: Walk, scope: Scope, node: A.FunctionMember): PowerShellDeclaration {
	for (const attribute of node.attributes) walkAttribute(w, scope, attribute);
	if (node.returnType !== undefined) typeUse(w, scope, node.returnType.typeName);
	const body = node.body;
	const range = rangeAt(w, node.pos, node.end);
	const declaration = declare(w, scope, {
		name: body.name,
		kind: node.isConstructor ? "constructor" : "method",
		descriptor: "method",
		...defined({ languageKind: node.isStatic ? "static" : undefined }),
		selection: rangeAt(w, body.nameSpan.pos, body.nameSpan.end),
		range,
		visibility: "public",
		header: { start: node.pos, end: body.body.pos },
		...defined({
			declaredType: node.returnType === undefined ? undefined : baseTypeName(node.returnType.typeName).name,
		}),
	});
	declaration.metrics = { lines: linesOf(range), parameters: body.parameters.length };
	const inner = childScope(w, scope, "function", declaration);
	declaration.parameters = new Map();
	for (const parameter of body.parameters) declareParameter(w, inner, parameter, declaration);
	walkScriptBlockBody(w, inner, body.body);
	return declaration;
}

function walkConfiguration(w: Walk, scope: Scope, node: A.ConfigurationDefinition): void {
	const name = staticText(node.name);
	if (name === undefined) {
		walkExpression(w, scope, node.name);
		walkExpression(w, scope, node.body);
		return;
	}
	const range = rangeAt(w, node.pos, node.end);
	const declaration = declare(w, scope, {
		name,
		kind: "function",
		descriptor: "method",
		languageKind: "configuration",
		selection: rangeAt(w, node.name.pos, node.name.end),
		range,
		visibility: "public",
		header: { start: node.pos, end: node.body.pos },
	});
	declaration.metrics = { lines: linesOf(range) };
	const key = keyOf(name);
	const definitions = w.out.functionsByName.get(key);
	if (definitions === undefined) w.out.functionsByName.set(key, [declaration]);
	else definitions.push(declaration);
	w.definedIn.set(declaration, scope);
	const inner = childScope(w, scope, "function", declaration);
	declaration.parameters = new Map();
	for (const parameter of node.body.scriptBlock.paramBlock?.parameters ?? [])
		declareParameter(w, inner, parameter, declaration);
	walkScriptBlockBody(w, inner, node.body.scriptBlock);
}

////////////////////////////////
//  Variables

/**
 * An assignment's left side: variables written, and what a member or index target reads. `value`
 * is what a single variable receives, read for its type later.
 */
function assign(w: Walk, scope: Scope, target: A.Expression, statement: A.Span, value: A.Statement | undefined): void {
	switch (target.type) {
		case "VariableExpressionAst":
			writeVariable(w, scope, target, statement, undefined, value);
			break;
		case "ConvertExpressionAst": {
			typeUse(w, scope, target.typeConstraint.typeName);
			const declared = baseTypeName(target.typeConstraint.typeName).name;
			if (target.child.type === "VariableExpressionAst")
				writeVariable(w, scope, target.child, statement, declared, value);
			else assign(w, scope, target.child, statement, value);
			break;
		}
		case "AttributedExpressionAst":
			walkAttribute(w, scope, target.attribute);
			assign(w, scope, target.child, statement, value);
			break;
		case "ArrayLiteralAst":
			for (const element of target.elements) assign(w, scope, element, statement, undefined);
			break;
		case "MemberExpressionAst":
			walkMember(w, scope, target, "write");
			break;
		default:
			walkExpression(w, scope, target);
	}
}

/** An assignment declares a name in its scope the first time, and writes it after. */
function writeVariable(
	w: Walk,
	scope: Scope,
	variable: A.VariableExpression,
	statement: A.Span,
	declaredType: string | undefined,
	value: A.Statement | undefined,
): void {
	const { scope: qualifier, name } = splitScope(variable.path);
	if (qualifier !== undefined && !SCOPES.has(qualifier)) return;
	const key = keyOf(name);
	if (qualifier === undefined && isAutomatic(scope, key)) return;
	const home = qualifier === "script" || qualifier === "global" ? w.script : landing(scope);
	const selection = variableSelection(w, variable, name);
	const existing = home.locals.get(key);
	if (existing !== undefined) {
		if (existing.declaredType === undefined && declaredType !== undefined) existing.declaredType = declaredType;
		pushReference(w, scope, {
			name,
			range: selection,
			role: "write",
			target: existing.symbolId,
			of: { kind: "variable", ...defined({ scope: qualifier }) },
			qualified: false,
		});
		return;
	}
	const scriptLevel = home.kind === "script";
	const declaration = declare(w, home, {
		name,
		kind: "variable",
		descriptor: "term",
		...defined({ languageKind: qualifier === "global" ? "global" : undefined }),
		selection,
		range: rangeAt(w, statement.pos, statement.end),
		visibility: !scriptLevel ? "local" : isModule(w.module) && qualifier !== "global" ? "fileLocal" : "public",
		header: { start: statement.pos, end: statement.end, folds: foldsOf(statement) },
		...defined({ declaredType }),
	});
	home.locals.set(key, declaration);
	if (value !== undefined) {
		w.firstValues.set(declaration, { statement: value, scope, at: rangeAt(w, statement.pos, statement.pos).start });
	}
}

/** A value written as a block, hashtable or array reads as the fold mark in a header. */
function foldsOf(statement: A.Span): HeaderFold[] {
	const assignment = statement as A.Statement;
	if (assignment.type !== "AssignmentStatementAst") return [];
	const right = assignment.right;
	const value = right.type === "CommandExpressionAst" ? right.expression : undefined;
	if (value === undefined) return [];
	if (value.type === "ScriptBlockExpressionAst") return [{ start: value.pos, end: value.end }];
	// `@{`, `@(` and `$(` fold from their bracket, the sigil kept.
	const sigiled =
		value.type === "HashtableAst" || value.type === "ArrayExpressionAst" || value.type === "SubExpressionAst";
	return sigiled ? [{ start: value.pos + 1, end: value.end }] : [];
}

function readVariable(w: Walk, scope: Scope, variable: A.VariableExpression, role: "read" | "write"): void {
	const { scope: qualifier, name } = splitScope(variable.path);
	if (qualifier !== undefined && !SCOPES.has(qualifier)) return;
	const key = keyOf(name);
	if (qualifier === undefined && (key === "true" || key === "false")) {
		pushLiteral(w, scope, { kind: "boolean", value: key }, variable.pos, variable.end);
		return;
	}
	if (qualifier === undefined && isAutomatic(scope, key)) return;
	pushReference(w, scope, {
		name,
		range: variableSelection(w, variable, name),
		role,
		of: { kind: "variable", ...defined({ scope: qualifier }) },
		qualified: false,
	});
}

////////////////////////////////
//  Commands

function walkCommand(w: Walk, scope: Scope, node: A.Command): void {
	const [first, ...rest] = node.elements;
	if (first === undefined) return;
	const name = first.type === "StringConstantExpressionAst" ? first.value : undefined;
	if (node.invocationOperator === "Dot" && first.type !== "ScriptBlockExpressionAst") {
		const path = scriptPath(first as A.Expression);
		if (path !== undefined) importSource(w, path, first, "dotSource");
		else walkArgument(w, scope, first as A.Expression);
	} else if (name !== undefined && isCommandName(name)) {
		pushReference(w, scope, {
			name,
			range: rangeAt(w, first.pos, first.end),
			role: "call",
			of: { kind: "command" },
			qualified: false,
		});
		commandFacts(w, scope, keyOf(name), rest, node);
	} else if (first.type !== "CommandParameterAst") walkExpression(w, scope, first);
	for (const element of rest) {
		if (element.type === "CommandParameterAst") {
			if (name !== undefined && isCommandName(name) && node.invocationOperator !== "Dot") {
				const at = element.pos + 1;
				pushReference(w, scope, {
					name: element.parameterName,
					range: rangeAt(w, at, at + element.parameterName.length),
					role: "write",
					of: { kind: "parameter", command: name },
					qualified: false,
				});
			}
			if (element.argument !== undefined) walkArgument(w, scope, element.argument);
		} else walkArgument(w, scope, element);
	}
	for (const redirection of node.redirections) walkRedirection(w, scope, redirection);
}

/** A name a command runs as a function: no path, no file extension. */
function isCommandName(name: string): boolean {
	if (name === "" || name.includes("/") || name.includes("\\")) return false;
	return !/\.(ps1|psm1|exe|cmd|bat|com|sh)$/i.test(name);
}

/** What a command says beyond its call: an import, the exports, a type built, a variable filled. */
function commandFacts(w: Walk, scope: Scope, command: string, elements: A.CommandElement[], node: A.Command): void {
	const named = new Map<string, A.Expression | undefined>();
	const positional: A.Expression[] = [];
	for (let index = 0; index < elements.length; index++) {
		const element = elements[index] as A.CommandElement;
		if (element.type !== "CommandParameterAst") {
			positional.push(element);
			continue;
		}
		const key = keyOf(element.parameterName);
		// A parameter's value may follow it as the next element; a switch takes none.
		const following = elements[index + 1];
		const isSwitch = [...SWITCHES].some((name) => name.startsWith(key));
		if (element.argument !== undefined) named.set(key, element.argument);
		else if (!isSwitch && following !== undefined && following.type !== "CommandParameterAst") {
			named.set(key, following);
			index++;
		} else named.set(key, undefined);
	}
	const argument = (...names: string[]): A.Expression | undefined => {
		for (const [key, value] of named) if (names.some((name) => name.startsWith(key))) return value;
		return undefined;
	};
	for (const [key, value] of named) {
		const filled = staticText(value);
		if (VARIABLE_PARAMETERS.has(key) && filled !== undefined && value !== undefined) {
			// `+name` appends to the variable.
			writeNamed(w, scope, filled.startsWith("+") ? filled.slice(1) : filled, value, node);
		}
	}
	switch (command) {
		case "import-module":
		case "ipmo": {
			const target = argument("name") ?? positional[0];
			for (const specifier of staticNames(target)) importSource(w, specifier, target as A.Span, "module");
			const path = scriptPath(target);
			if (path !== undefined && staticNames(target).length === 0)
				importSource(w, path, target as A.Span, "module");
			break;
		}
		case "export-modulemember": {
			const functions = argument("function") ?? positional[0];
			w.out.exportedFunctions ??= new Set();
			for (const exported of staticNames(functions)) w.out.exportedFunctions.add(keyOf(exported));
			const variables = argument("variable");
			if (variables !== undefined) {
				w.out.exportedVariables ??= new Set();
				for (const exported of staticNames(variables)) w.out.exportedVariables.add(keyOf(exported));
			}
			break;
		}
		case "new-object": {
			const type = argument("typename") ?? positional[0];
			const typeName = staticText(type);
			if (typeName !== undefined && type !== undefined) {
				pushReference(w, scope, {
					name: typeName,
					range: rangeAt(w, type.pos, type.end),
					role: "instantiate",
					of: { kind: "type" },
					qualified: false,
				});
			}
			break;
		}
		case "set-variable":
		case "new-variable": {
			const target = argument("name") ?? positional[0];
			const variable = staticText(target);
			// `-Scope Global` or `Script` names the scope a qualifier would.
			const named = keyOf(staticText(argument("scope")) ?? "");
			const qualifier = named === "global" || named === "script" ? `${named}:` : "";
			if (variable !== undefined && target !== undefined)
				writeNamed(w, scope, `${qualifier}${variable}`, target, node);
			break;
		}
	}
}

/** A variable a command names in a string: declared the first time, written after. */
function writeNamed(w: Walk, scope: Scope, path: string, at: A.Expression, statement: A.Span): void {
	const quoted =
		(at.type === "StringConstantExpressionAst" || at.type === "ExpandableStringExpressionAst") &&
		(at.stringKind === "SingleQuoted" || at.stringKind === "DoubleQuoted");
	const pos = quoted ? at.pos + 1 : at.pos;
	const end = quoted ? at.end - 1 : at.end;
	writeVariable(
		w,
		scope,
		{ type: "VariableExpressionAst", pos, end, path, splatted: false, braced: false },
		statement,
		undefined,
		undefined,
	);
}

/** A command's argument: a bare word is a string value. */
function walkArgument(w: Walk, scope: Scope, argument: A.Expression): void {
	if (argument.type === "StringConstantExpressionAst" && argument.stringKind === "BareWord") {
		const number = /^-?[0-9]+(\.[0-9]+)?$/.test(argument.value) ? Number(argument.value) : undefined;
		pushLiteral(
			w,
			scope,
			{ kind: number === undefined ? "string" : "number", value: argument.value, ...defined({ number }) },
			argument.pos,
			argument.end,
		);
		return;
	}
	if (argument.type === "ArrayLiteralAst") {
		for (const element of argument.elements) walkArgument(w, scope, element);
		return;
	}
	walkExpression(w, scope, argument);
}

////////////////////////////////
//  Expressions

function walkExpression(w: Walk, scope: Scope, node: A.Expression): void {
	switch (node.type) {
		case "VariableExpressionAst":
			readVariable(w, scope, node, "read");
			break;
		case "UsingExpressionAst":
			walkExpression(w, scope, node.child);
			break;
		case "ConstantExpressionAst":
			if (typeof node.value === "number") {
				const number = Number.isFinite(node.value) ? node.value : undefined;
				pushLiteral(w, scope, { kind: "number", value: node.text, ...defined({ number }) }, node.pos, node.end);
			}
			break;
		case "StringConstantExpressionAst":
			if (node.stringKind !== "BareWord")
				pushLiteral(w, scope, { kind: "string", value: node.value }, node.pos, node.end);
			break;
		case "ExpandableStringExpressionAst":
			// One literal, its holes as written.
			if (node.stringKind !== "BareWord")
				pushLiteral(w, scope, { kind: "string", value: node.value }, node.pos, node.end);
			for (const nested of node.nestedExpressions) walkExpression(w, scope, nested);
			break;
		case "ScriptBlockExpressionAst": {
			const inner = childScope(w, scope, "block");
			for (const parameter of node.scriptBlock.paramBlock?.parameters ?? [])
				declareParameter(w, inner, parameter);
			walkScriptBlockBody(w, inner, node.scriptBlock);
			break;
		}
		case "HashtableAst":
			for (const [key, value] of node.pairs) {
				if (key.type !== "StringConstantExpressionAst" || key.stringKind !== "BareWord")
					walkExpression(w, scope, key);
				walkStatement(w, scope, value);
			}
			break;
		case "ArrayLiteralAst":
			for (const element of node.elements) walkExpression(w, scope, element);
			break;
		case "ArrayExpressionAst":
		case "SubExpressionAst":
			walkBlock(w, scope, node.statements);
			break;
		case "ParenExpressionAst":
			walkStatement(w, scope, node.pipeline);
			break;
		case "BinaryExpressionAst":
			walkExpression(w, scope, node.left);
			walkExpression(w, scope, node.right);
			break;
		case "UnaryExpressionAst":
			// `$x++` sets `$x`, declaring it the first time as an assignment would.
			if (
				node.child.type === "VariableExpressionAst" &&
				["PlusPlus", "MinusMinus", "PostfixPlusPlus", "PostfixMinusMinus"].includes(node.operator)
			) {
				writeVariable(w, scope, node.child, node, undefined, undefined);
			} else walkExpression(w, scope, node.child);
			break;
		case "TernaryExpressionAst":
			walkExpression(w, scope, node.condition);
			walkExpression(w, scope, node.ifTrue);
			walkExpression(w, scope, node.ifFalse);
			break;
		case "ConvertExpressionAst":
			typeUse(w, scope, node.typeConstraint.typeName);
			walkExpression(w, scope, node.child);
			break;
		case "AttributedExpressionAst":
			walkAttribute(w, scope, node.attribute);
			walkExpression(w, scope, node.child);
			break;
		case "TypeExpressionAst":
			typeUse(w, scope, node.typeName);
			break;
		case "MemberExpressionAst":
			walkMember(w, scope, node, "read");
			break;
		case "InvokeMemberExpressionAst":
			walkMember(w, scope, node, "call");
			for (const argument of node.arguments) walkExpression(w, scope, argument);
			break;
		case "BaseCtorInvokeMemberExpressionAst":
			for (const argument of node.arguments) walkExpression(w, scope, argument);
			break;
		case "IndexExpressionAst":
			walkExpression(w, scope, node.target);
			walkExpression(w, scope, node.index);
			break;
	}
}

/** `x.Member`, `[T]::Member` and their calls; `[T]::new()` builds a `T`. */
function walkMember(
	w: Walk,
	scope: Scope,
	node: A.MemberExpression | A.InvokeMemberExpression,
	role: "read" | "write" | "call",
): void {
	const member = node.member.type === "StringConstantExpressionAst" ? node.member.value : undefined;
	const target = node.target;
	const typeName = target.type === "TypeExpressionAst" ? baseTypeName(target.typeName) : undefined;
	if (typeName !== undefined && member !== undefined && node.isStatic && role === "call" && keyOf(member) === "new") {
		pushReference(w, scope, {
			name: typeName.name,
			range: rangeAt(w, typeName.pos, typeName.pos + typeName.name.length),
			role: "instantiate",
			of: { kind: "type" },
			qualified: false,
		});
		for (const argument of typeName.arguments ?? []) typeUse(w, scope, argument);
		return;
	}
	walkExpression(w, scope, target);
	if (member === undefined) {
		if (node.member.type !== "CommandParameterAst") walkExpression(w, scope, node.member);
		return;
	}
	const receiver = target.type === "UsingExpressionAst" ? target.child : target;
	const arity = node.type === "InvokeMemberExpressionAst" ? node.arguments.length : undefined;
	pushReference(
		w,
		scope,
		{
			name: member,
			range: rangeAt(w, node.member.pos, node.member.end),
			role,
			of: { kind: "member", isStatic: node.isStatic, ...defined({ typeName: typeName?.name, arity }) },
			qualified: true,
		},
		typeName === undefined ? receiver : undefined,
	);
}

function walkAttribute(w: Walk, scope: Scope, attribute: A.AttributeBase): void {
	typeUse(w, scope, attribute.typeName);
	if (attribute.type !== "AttributeAst") return;
	for (const argument of attribute.positionalArguments) walkExpression(w, scope, argument);
	for (const argument of attribute.namedArguments) {
		if (!argument.expressionOmitted) walkExpression(w, scope, argument.argument);
	}
}

/** A type as written: its name, and each generic argument's. */
function typeUse(w: Walk, scope: Scope, type: A.TypeName): void {
	const base = baseTypeName(type);
	pushReference(w, scope, {
		name: base.name,
		range: rangeAt(w, base.pos, base.pos + base.name.length),
		role: "typeUse",
		of: { kind: "type" },
		qualified: false,
	});
	for (const argument of base.arguments ?? []) typeUse(w, scope, argument);
}

////////////////////////////////
//  File

/** Whether a statement runs on load, rather than defining or preparing. */
function runsOnLoad(statement: A.Statement): boolean {
	switch (statement.type) {
		case "FunctionDefinitionAst":
		case "TypeDefinitionAst":
		case "UsingStatementAst":
		case "AssignmentStatementAst":
		case "ConfigurationDefinitionAst":
			return false;
		case "PipelineAst": {
			if (statement.elements.length !== 1) return true;
			const [element] = statement.elements;
			if (element?.type !== "CommandAst") return element?.type === "CommandExpressionAst";
			if (element.invocationOperator === "Dot") return false;
			const name = element.elements[0];
			return !(name?.type === "StringConstantExpressionAst" && SETUP_COMMANDS.has(keyOf(name.value)));
		}
		case "IfStatementAst":
			return (
				statement.clauses.some(([, body]) => body.statements.some(runsOnLoad)) ||
				(statement.elseClause?.statements.some(runsOnLoad) ?? false)
			);
		case "TryStatementAst":
			return (
				statement.body.statements.some(runsOnLoad) ||
				statement.catchClauses.some((clause) => clause.body.statements.some(runsOnLoad)) ||
				(statement.finallyClause?.statements.some(runsOnLoad) ?? false)
			);
		default:
			return true;
	}
}

function fileRole(module: string, script: A.ScriptBlock): ParsedPowerShellFile["role"] {
	if (isModule(module) || isManifest(module)) return { kind: "library" };
	const statements = script.blocks.flatMap((block) => block.statements);
	return statements.some(runsOnLoad) ? { kind: "entry", how: "topLevel" } : { kind: "library" };
}

/**
 * A module's functions leave it unless `Export-ModuleMember` names others, and its variables only
 * as it names them; a script's say nothing.
 */
function markExports(w: Walk): void {
	if (!isModule(w.module)) return;
	const matches = (patterns: Set<string>, name: string) =>
		[...patterns].some((pattern) => wildcardMatches(pattern, name));
	const functions = w.out.exportedFunctions;
	for (const [, definitions] of w.out.functionsByName) {
		for (const definition of definitions) {
			if (definition.visibility !== "public") continue;
			definition.exported = functions === undefined || matches(functions, definition.name);
		}
	}
	const variables = w.out.exportedVariables;
	for (const [, variable] of w.out.variablesByName) {
		if (variables !== undefined && matches(variables, variable.name)) variable.exported = true;
	}
}

/** A manifest's modules, scripts and exports, read from its hashtable. */
function walkManifest(w: Walk, script: A.ScriptBlock): void {
	const statement = script.blocks[0]?.statements[0];
	const element = statement?.type === "PipelineAst" ? statement.elements[0] : undefined;
	const table = element?.type === "CommandExpressionAst" ? element.expression : undefined;
	if (table?.type !== "HashtableAst") return;
	for (const [key, value] of table.pairs) {
		const name = keyOf(staticText(key) ?? "");
		const expression =
			value.type === "PipelineAst" && value.elements[0]?.type === "CommandExpressionAst"
				? value.elements[0].expression
				: undefined;
		if (expression === undefined) continue;
		if (
			name === "rootmodule" ||
			name === "moduletoprocess" ||
			name === "nestedmodules" ||
			name === "requiredmodules"
		) {
			for (const specifier of staticNames(expression)) importSource(w, specifier, expression, "module");
		} else if (name === "scriptstoprocess") {
			for (const specifier of staticNames(expression)) importSource(w, specifier, expression, "dotSource");
		} else if (name === "functionstoexport") {
			w.out.exportedFunctions ??= new Set();
			for (const exported of staticNames(expression)) w.out.exportedFunctions.add(keyOf(exported));
		} else if (name === "variablestoexport") {
			w.out.exportedVariables ??= new Set();
			for (const exported of staticNames(expression)) w.out.exportedVariables.add(keyOf(exported));
		}
	}
}

////////////////////////////////
//  Main

export function parsePowerShellFile(module: string, text: string): ParsedPowerShellFile {
	const parsed = parsePowerShell(text);
	const script: Scope = { kind: "script", descriptors: [], locals: new Map() };
	const out: ParsedPowerShellFile = {
		module,
		text,
		role: { kind: "library" },
		declarations: [],
		references: [],
		imports: [],
		sources: [],
		literals: [],
		comments: [],
		blankLines: [],
		diagnostics: [],
		functionsByName: new Map(),
		variablesByName: script.locals,
		typesByName: new Map(),
	};
	const w: Walk = {
		module,
		text,
		coordinates: coordinatesOf(text),
		out,
		pending: [],
		headers: [],
		minted: new Map(),
		definedIn: new WeakMap(),
		descriptors: new WeakMap(),
		script,
		firstValues: new WeakMap(),
		outputs: new WeakMap(),
		inferring: new WeakMap(),
	};
	out.comments = commentSpans(w, parsed.tokens);
	out.blankLines = blankLinesOf(w, parsed.tokens);
	if (parsed.script === undefined) {
		const at = parsed.problem?.pos ?? 0;
		out.role = { kind: "unknown", reason: "ParseError" };
		out.diagnostics.push({
			severity: "error",
			message: parsed.problem?.message ?? "the script does not parse",
			range: rangeAt(w, at, Math.min(at + 1, text.length)),
			path: module,
		});
		return out;
	}
	out.role = fileRole(module, parsed.script);
	if (isManifest(module)) walkManifest(w, parsed.script);
	for (const parameter of parsed.script.paramBlock?.parameters ?? []) declareParameter(w, script, parameter);
	walkScriptBlockBody(w, script, parsed.script);
	settle(w);
	markExports(w);
	signHeaders(w, parsed.tokens);
	return out;
}
