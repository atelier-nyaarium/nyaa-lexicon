// The PowerShell syntax tree, in the node classes of PowerShell's own `System.Management.Automation.
// Language` tree, with file offsets for positions.

import type { TokenKind } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

/** Offsets into the file: `pos` inclusive, `end` exclusive. */
export interface Span {
	pos: number;
	end: number;
}

interface Base<T extends string> extends Span {
	type: T;
}

/** A type as written: a name, generic arguments or array dimensions. */
export interface TypeName extends Span {
	/** The name without generic arguments or dimensions, as written. */
	name: string;
	/** Generic arguments, for a generic type. */
	arguments?: TypeName[];
	/** The element type, for an array type. */
	element?: TypeName;
	assembly?: string;
}

////////////////////////////////
//  Script blocks

export interface ScriptBlock extends Base<"ScriptBlockAst"> {
	usingStatements: UsingStatement[];
	paramBlock: ParamBlock | undefined;
	blocks: NamedBlock[];
}

export interface NamedBlock extends Base<"NamedBlockAst"> {
	/** `begin`, `process`, `end`, `clean` or `dynamicparam`; an unnamed body reads as `end`. */
	blockKind: TokenKind;
	unnamed: boolean;
	statements: Statement[];
	traps: TrapStatement[];
}

export interface ParamBlock extends Base<"ParamBlockAst"> {
	attributes: Attribute[];
	parameters: Parameter[];
}

export interface Parameter extends Base<"ParameterAst"> {
	name: VariableExpression;
	attributes: AttributeBase[];
	defaultValue: Expression | undefined;
}

export interface Attribute extends Base<"AttributeAst"> {
	typeName: TypeName;
	positionalArguments: Expression[];
	namedArguments: NamedAttributeArgument[];
}

export interface NamedAttributeArgument extends Base<"NamedAttributeArgumentAst"> {
	argumentName: string;
	argument: Expression;
	expressionOmitted: boolean;
}

export interface TypeConstraint extends Base<"TypeConstraintAst"> {
	typeName: TypeName;
}

export type AttributeBase = Attribute | TypeConstraint;

export interface StatementBlock extends Base<"StatementBlockAst"> {
	statements: Statement[];
	traps: TrapStatement[];
}

////////////////////////////////
//  Statements

export interface Pipeline extends Base<"PipelineAst"> {
	elements: CommandBase[];
	background: boolean;
}

export interface PipelineChain extends Base<"PipelineChainAst"> {
	left: PipelineChain | Pipeline;
	right: Pipeline;
	operator: "AndAnd" | "OrOr";
	background: boolean;
}

export type PipelineBase = Pipeline | PipelineChain | AssignmentStatement;

export interface Command extends Base<"CommandAst"> {
	elements: CommandElement[];
	/** `.` or `&` before the name. */
	invocationOperator: "Dot" | "Ampersand" | undefined;
	redirections: Redirection[];
}

export interface CommandExpression extends Base<"CommandExpressionAst"> {
	expression: Expression;
	redirections: Redirection[];
}

export type CommandBase = Command | CommandExpression;

export interface CommandParameter extends Base<"CommandParameterAst"> {
	parameterName: string;
	argument: Expression | undefined;
}

export type CommandElement = CommandParameter | Expression;

export interface FileRedirection extends Base<"FileRedirectionAst"> {
	from: string;
	location: Expression;
	append: boolean;
}

export interface MergingRedirection extends Base<"MergingRedirectionAst"> {
	from: string;
	to: string;
}

export type Redirection = FileRedirection | MergingRedirection;

export interface AssignmentStatement extends Base<"AssignmentStatementAst"> {
	left: Expression;
	operator: TokenKind;
	/** An expression's command, unwrapped from its pipeline. */
	right: Statement;
}

export interface IfStatement extends Base<"IfStatementAst"> {
	clauses: Array<[PipelineBase, StatementBlock]>;
	elseClause: StatementBlock | undefined;
}

export interface LoopStatement extends Base<"WhileStatementAst" | "DoWhileStatementAst" | "DoUntilStatementAst"> {
	label: string | undefined;
	condition: PipelineBase;
	body: StatementBlock;
}

export interface ForStatement extends Base<"ForStatementAst"> {
	label: string | undefined;
	initializer: PipelineBase | undefined;
	condition: PipelineBase | undefined;
	iterator: PipelineBase | undefined;
	body: StatementBlock;
}

export interface ForEachStatement extends Base<"ForEachStatementAst"> {
	label: string | undefined;
	variable: VariableExpression;
	condition: PipelineBase;
	body: StatementBlock;
	throttleLimit: Expression | undefined;
}

export interface SwitchStatement extends Base<"SwitchStatementAst"> {
	label: string | undefined;
	condition: PipelineBase | undefined;
	clauses: Array<[Expression, StatementBlock]>;
	defaultClause: StatementBlock | undefined;
}

export interface TryStatement extends Base<"TryStatementAst"> {
	body: StatementBlock;
	catchClauses: CatchClause[];
	finallyClause: StatementBlock | undefined;
}

export interface CatchClause extends Base<"CatchClauseAst"> {
	catchTypes: TypeConstraint[];
	body: StatementBlock;
}

export interface TrapStatement extends Base<"TrapStatementAst"> {
	trapType: TypeConstraint | undefined;
	body: StatementBlock;
}

export interface JumpStatement extends Base<"BreakStatementAst" | "ContinueStatementAst"> {
	label: Expression | undefined;
}

export interface ExitStatement extends Base<"ReturnStatementAst" | "ExitStatementAst" | "ThrowStatementAst"> {
	pipeline: PipelineBase | undefined;
}

export interface FunctionDefinition extends Base<"FunctionDefinitionAst"> {
	isFilter: boolean;
	isWorkflow: boolean;
	name: string;
	/** Where the name is written. */
	nameSpan: Span;
	parameters: Parameter[];
	body: ScriptBlock;
}

export interface TypeDefinition extends Base<"TypeDefinitionAst"> {
	name: string;
	nameSpan: Span;
	/** Where the `{` opening the members sits. */
	bodyStart: number;
	isEnum: boolean;
	attributes: Attribute[];
	baseTypes: TypeConstraint[];
	members: Member[];
}

export interface PropertyMember extends Base<"PropertyMemberAst"> {
	name: string;
	nameSpan: Span;
	propertyType: TypeConstraint | undefined;
	attributes: Attribute[];
	isStatic: boolean;
	isHidden: boolean;
	initialValue: Expression | undefined;
}

export interface FunctionMember extends Base<"FunctionMemberAst"> {
	body: FunctionDefinition;
	returnType: TypeConstraint | undefined;
	attributes: Attribute[];
	isStatic: boolean;
	isHidden: boolean;
	isConstructor: boolean;
}

export type Member = PropertyMember | FunctionMember;

export interface UsingStatement extends Base<"UsingStatementAst"> {
	usingKind: "Namespace" | "Type" | "Module" | "Command" | "Assembly";
	name: StringConstantExpression | undefined;
	alias: StringConstantExpression | undefined;
	moduleSpecification: Hashtable | undefined;
}

export interface DataStatement extends Base<"DataStatementAst"> {
	variable: string | undefined;
	commandsAllowed: Expression[];
	body: StatementBlock;
}

export interface ConfigurationDefinition extends Base<"ConfigurationDefinitionAst"> {
	name: Expression;
	body: ScriptBlockExpression;
}

export interface BlockStatement extends Base<"BlockStatementAst"> {
	kind: "Parallel" | "Sequence";
	body: StatementBlock;
}

/** A constructor's base call stands as a bare command expression. */
export type Statement =
	| PipelineBase
	| CommandExpression
	| IfStatement
	| LoopStatement
	| ForStatement
	| ForEachStatement
	| SwitchStatement
	| TryStatement
	| TrapStatement
	| JumpStatement
	| ExitStatement
	| FunctionDefinition
	| TypeDefinition
	| UsingStatement
	| DataStatement
	| ConfigurationDefinition
	| BlockStatement;

////////////////////////////////
//  Expressions

export interface BinaryExpression extends Base<"BinaryExpressionAst"> {
	left: Expression;
	operator: TokenKind;
	right: Expression;
}

export interface UnaryExpression extends Base<"UnaryExpressionAst"> {
	operator: TokenKind;
	child: Expression;
}

export interface TernaryExpression extends Base<"TernaryExpressionAst"> {
	condition: Expression;
	ifTrue: Expression;
	ifFalse: Expression;
}

export interface ConvertExpression extends Base<"ConvertExpressionAst"> {
	typeConstraint: TypeConstraint;
	child: Expression;
}

export interface AttributedExpression extends Base<"AttributedExpressionAst"> {
	attribute: AttributeBase;
	child: Expression;
}

export interface TypeExpression extends Base<"TypeExpressionAst"> {
	typeName: TypeName;
}

export interface VariableExpression extends Base<"VariableExpressionAst"> {
	/** The path as written, scope or drive included. */
	path: string;
	splatted: boolean;
	/** Written `${...}`. */
	braced: boolean;
}

export interface UsingExpression extends Base<"UsingExpressionAst"> {
	child: Expression;
}

export interface ConstantExpression extends Base<"ConstantExpressionAst"> {
	/** The literal as written. */
	text: string;
	value: number | boolean | undefined;
	/** A number's .NET type, as PowerShell names it. */
	staticType?: string;
}

export interface StringConstantExpression extends Base<"StringConstantExpressionAst"> {
	value: string;
	stringKind: "SingleQuoted" | "SingleQuotedHereString" | "DoubleQuoted" | "DoubleQuotedHereString" | "BareWord";
}

export interface ExpandableStringExpression extends Base<"ExpandableStringExpressionAst"> {
	value: string;
	stringKind: "DoubleQuoted" | "DoubleQuotedHereString" | "BareWord";
	nestedExpressions: Expression[];
}

export interface ScriptBlockExpression extends Base<"ScriptBlockExpressionAst"> {
	scriptBlock: ScriptBlock;
}

export interface ArrayLiteral extends Base<"ArrayLiteralAst"> {
	elements: Expression[];
}

export interface Hashtable extends Base<"HashtableAst"> {
	pairs: Array<[Expression, Statement]>;
}

export interface SubExpression extends Base<"ArrayExpressionAst" | "SubExpressionAst"> {
	statements: StatementBlock;
}

export interface ParenExpression extends Base<"ParenExpressionAst"> {
	pipeline: PipelineBase;
}

export interface MemberExpression extends Base<"MemberExpressionAst"> {
	target: Expression;
	member: CommandElement;
	isStatic: boolean;
	nullConditional: boolean;
}

export interface InvokeMemberExpression extends Base<"InvokeMemberExpressionAst"> {
	target: Expression;
	member: CommandElement;
	arguments: Expression[];
	isStatic: boolean;
	nullConditional: boolean;
	genericArguments: TypeName[];
}

/** `: base(...)`, or the implicit call, spanning nothing, of a constructor without one. */
export interface BaseCtorInvokeMemberExpression extends Base<"BaseCtorInvokeMemberExpressionAst"> {
	/** The `base` keyword. */
	keyword: Span;
	arguments: Expression[];
}

export interface IndexExpression extends Base<"IndexExpressionAst"> {
	target: Expression;
	index: Expression;
	nullConditional: boolean;
}

export type Expression =
	| BinaryExpression
	| UnaryExpression
	| TernaryExpression
	| ConvertExpression
	| AttributedExpression
	| TypeExpression
	| VariableExpression
	| UsingExpression
	| ConstantExpression
	| StringConstantExpression
	| ExpandableStringExpression
	| ScriptBlockExpression
	| ArrayLiteral
	| Hashtable
	| SubExpression
	| ParenExpression
	| MemberExpression
	| InvokeMemberExpression
	| BaseCtorInvokeMemberExpression
	| IndexExpression;

export type Node =
	| ScriptBlock
	| NamedBlock
	| ParamBlock
	| Parameter
	| AttributeBase
	| NamedAttributeArgument
	| StatementBlock
	| Statement
	| CommandBase
	| CommandParameter
	| Redirection
	| CatchClause
	| Member
	| Expression;

////////////////////////////////
//  Functions & Helpers

function defined<T>(value: T | undefined): T[] {
	return value === undefined ? [] : [value];
}

/** Each node a node holds, in source order. */
export function childNodes(node: Node): Node[] {
	switch (node.type) {
		case "ScriptBlockAst":
			return [...node.usingStatements, ...defined(node.paramBlock), ...node.blocks];
		case "NamedBlockAst":
		case "StatementBlockAst":
			return [...node.traps, ...node.statements].sort((a, b) => a.pos - b.pos);
		case "ParamBlockAst":
			return [...node.attributes, ...node.parameters];
		case "ParameterAst":
			return [...node.attributes, node.name, ...defined(node.defaultValue)];
		case "AttributeAst":
			return [...node.positionalArguments, ...node.namedArguments].sort((a, b) => a.pos - b.pos);
		case "NamedAttributeArgumentAst":
			return [node.argument];
		case "TypeConstraintAst":
		case "TypeExpressionAst":
			return [];
		case "PipelineAst":
			return node.elements;
		case "PipelineChainAst":
			return [node.left, node.right];
		case "CommandAst":
			return [...node.elements, ...node.redirections].sort((a, b) => a.pos - b.pos);
		case "CommandExpressionAst":
			return [node.expression, ...node.redirections];
		case "CommandParameterAst":
			return defined(node.argument);
		case "FileRedirectionAst":
			return [node.location];
		case "MergingRedirectionAst":
			return [];
		case "AssignmentStatementAst":
			return [node.left, node.right];
		case "IfStatementAst":
			return [...node.clauses.flat(), ...defined(node.elseClause)];
		case "WhileStatementAst":
			return [node.condition, node.body];
		case "DoWhileStatementAst":
		case "DoUntilStatementAst":
			return [node.body, node.condition];
		case "ForStatementAst":
			return [...defined(node.initializer), ...defined(node.condition), ...defined(node.iterator), node.body];
		case "ForEachStatementAst":
			return [...defined(node.throttleLimit), node.variable, node.condition, node.body];
		case "SwitchStatementAst":
			return [...defined(node.condition), ...node.clauses.flat(), ...defined(node.defaultClause)].sort(
				(a, b) => a.pos - b.pos,
			);
		case "TryStatementAst":
			return [node.body, ...node.catchClauses, ...defined(node.finallyClause)];
		case "CatchClauseAst":
			return [...node.catchTypes, node.body];
		case "TrapStatementAst":
			return [...defined(node.trapType), node.body];
		case "BreakStatementAst":
		case "ContinueStatementAst":
			return defined(node.label);
		case "ReturnStatementAst":
		case "ExitStatementAst":
		case "ThrowStatementAst":
			return defined(node.pipeline);
		case "FunctionDefinitionAst":
			return [...node.parameters, node.body];
		case "TypeDefinitionAst":
			return [...node.attributes, ...node.baseTypes, ...node.members];
		case "PropertyMemberAst":
			return [...node.attributes, ...defined(node.propertyType), ...defined(node.initialValue)];
		case "FunctionMemberAst":
			return [...node.attributes, ...defined(node.returnType), node.body];
		case "UsingStatementAst":
			return [...defined(node.name), ...defined(node.alias), ...defined(node.moduleSpecification)];
		case "DataStatementAst":
			return [...node.commandsAllowed, node.body];
		case "ConfigurationDefinitionAst":
			return [node.name, node.body];
		case "BlockStatementAst":
			return [node.body];
		case "BinaryExpressionAst":
			return [node.left, node.right];
		case "UnaryExpressionAst":
			return [node.child];
		case "TernaryExpressionAst":
			return [node.condition, node.ifTrue, node.ifFalse];
		case "ConvertExpressionAst":
			return [node.typeConstraint, node.child];
		case "AttributedExpressionAst":
			return [node.attribute, node.child];
		case "VariableExpressionAst":
		case "ConstantExpressionAst":
		case "StringConstantExpressionAst":
			return [];
		case "UsingExpressionAst":
			return [node.child];
		case "ExpandableStringExpressionAst":
			return node.nestedExpressions;
		case "ScriptBlockExpressionAst":
			return [node.scriptBlock];
		case "ArrayLiteralAst":
			return node.elements;
		case "HashtableAst":
			return node.pairs.flat();
		case "ArrayExpressionAst":
		case "SubExpressionAst":
			return [node.statements];
		case "ParenExpressionAst":
			return [node.pipeline];
		case "MemberExpressionAst":
			return [node.target, node.member];
		case "InvokeMemberExpressionAst":
			return [node.target, node.member, ...node.arguments];
		case "BaseCtorInvokeMemberExpressionAst":
			return node.arguments;
		case "IndexExpressionAst":
			return [node.target, node.index];
	}
}

/** Whether any node sits more than `limit` levels under `root`, measured without recursion. */
export function deeperThan(root: Node, limit: number): boolean {
	const pending: Array<[Node, number]> = [[root, 0]];
	for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
		const [node, depth] = entry;
		if (depth > limit) return true;
		for (const child of childNodes(node)) pending.push([child, depth + 1]);
	}
	return false;
}

/** Every node under `root`, itself first, depth first in source order. */
export function walk(root: Node): Node[] {
	const nodes: Node[] = [];
	const pending: Node[] = [root];
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		nodes.push(node);
		const children = childNodes(node);
		for (let index = children.length - 1; index >= 0; index--) pending.push(children[index] as Node);
	}
	return nodes;
}
