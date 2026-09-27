// The Python syntax tree, in the node classes and field order of CPython's `ast` module, with UTF-16
// offsets for positions. Fields are camelCased; child order follows each class's `_fields`.

////////////////////////////////
//  Interfaces & Types

/** Offsets into the parsed text: `pos` inclusive, `end` exclusive. */
export interface Span {
	pos: number;
	end: number;
}

/** A Python value a literal spells. */
export type PyValue =
	| { kind: "str"; value: string }
	| { kind: "bytes"; value: string }
	| { kind: "int"; value: bigint }
	| { kind: "float"; value: number }
	| { kind: "complex"; imag: number }
	| { kind: "bool"; value: boolean }
	| { kind: "None" }
	| { kind: "Ellipsis" };

export type Context = "Load" | "Store" | "Del";
export type BoolOperator = "And" | "Or";
export type Operator =
	| "Add"
	| "Sub"
	| "Mult"
	| "MatMult"
	| "Div"
	| "Mod"
	| "Pow"
	| "LShift"
	| "RShift"
	| "BitOr"
	| "BitXor"
	| "BitAnd"
	| "FloorDiv";
export type UnaryOperator = "Invert" | "Not" | "UAdd" | "USub";
export type ComparisonOperator = "Eq" | "NotEq" | "Lt" | "LtE" | "Gt" | "GtE" | "Is" | "IsNot" | "In" | "NotIn";

interface Base<T extends string> extends Span {
	type: T;
}

export interface Module extends Base<"Module"> {
	body: Statement[];
	typeIgnores: TypeIgnore[];
}

/** A `# type: ignore` comment, spanning the comment. */
export interface TypeIgnore extends Base<"TypeIgnore"> {
	tag: string;
}

////////////////////////////////
//  Statements

export interface FunctionDef extends Base<"FunctionDef" | "AsyncFunctionDef"> {
	name: string;
	args: Arguments;
	body: Statement[];
	decoratorList: Expression[];
	returns: Expression | undefined;
	typeComment: string | undefined;
	typeParams: TypeParam[];
}

export interface ClassDef extends Base<"ClassDef"> {
	name: string;
	bases: Expression[];
	keywords: Keyword[];
	body: Statement[];
	decoratorList: Expression[];
	typeParams: TypeParam[];
}

export interface Return extends Base<"Return"> {
	value: Expression | undefined;
}

export interface Delete extends Base<"Delete"> {
	targets: Expression[];
}

export interface Assign extends Base<"Assign"> {
	targets: Expression[];
	value: Expression;
	typeComment: string | undefined;
}

export interface TypeAlias extends Base<"TypeAlias"> {
	name: Name;
	typeParams: TypeParam[];
	value: Expression;
}

export interface AugAssign extends Base<"AugAssign"> {
	target: Expression;
	op: Operator;
	value: Expression;
}

export interface AnnAssign extends Base<"AnnAssign"> {
	target: Expression;
	annotation: Expression;
	value: Expression | undefined;
	simple: boolean;
}

export interface For extends Base<"For" | "AsyncFor"> {
	target: Expression;
	iter: Expression;
	body: Statement[];
	orelse: Statement[];
	typeComment: string | undefined;
}

export interface While extends Base<"While"> {
	test: Expression;
	body: Statement[];
	orelse: Statement[];
}

export interface If extends Base<"If"> {
	test: Expression;
	body: Statement[];
	orelse: Statement[];
}

export interface With extends Base<"With" | "AsyncWith"> {
	items: WithItem[];
	body: Statement[];
	typeComment: string | undefined;
}

export interface Match extends Base<"Match"> {
	subject: Expression;
	cases: MatchCase[];
}

export interface Raise extends Base<"Raise"> {
	exc: Expression | undefined;
	cause: Expression | undefined;
}

export interface Try extends Base<"Try" | "TryStar"> {
	body: Statement[];
	handlers: ExceptHandler[];
	orelse: Statement[];
	finalbody: Statement[];
}

export interface Assert extends Base<"Assert"> {
	test: Expression;
	msg: Expression | undefined;
}

export interface Import extends Base<"Import"> {
	names: Alias[];
}

export interface ImportFrom extends Base<"ImportFrom"> {
	module: string | undefined;
	names: Alias[];
	level: number;
}

export interface Global extends Base<"Global" | "Nonlocal"> {
	names: string[];
}

export interface Expr extends Base<"Expr"> {
	value: Expression;
}

export interface Simple extends Base<"Pass" | "Break" | "Continue"> {}

export type Statement =
	| FunctionDef
	| ClassDef
	| Return
	| Delete
	| Assign
	| TypeAlias
	| AugAssign
	| AnnAssign
	| For
	| While
	| If
	| With
	| Match
	| Raise
	| Try
	| Assert
	| Import
	| ImportFrom
	| Global
	| Expr
	| Simple;

////////////////////////////////
//  Expressions

export interface BoolOp extends Base<"BoolOp"> {
	op: BoolOperator;
	values: Expression[];
}

export interface NamedExpr extends Base<"NamedExpr"> {
	target: Expression;
	value: Expression;
}

export interface BinOp extends Base<"BinOp"> {
	left: Expression;
	op: Operator;
	right: Expression;
}

export interface UnaryOp extends Base<"UnaryOp"> {
	op: UnaryOperator;
	operand: Expression;
}

export interface Lambda extends Base<"Lambda"> {
	args: Arguments;
	body: Expression;
}

export interface IfExp extends Base<"IfExp"> {
	test: Expression;
	body: Expression;
	orelse: Expression;
}

export interface Dict extends Base<"Dict"> {
	/** Undefined for a `**` unpacking. */
	keys: Array<Expression | undefined>;
	values: Expression[];
}

export interface SetNode extends Base<"Set"> {
	elts: Expression[];
}

export interface Comprehended extends Base<"ListComp" | "SetComp" | "GeneratorExp"> {
	elt: Expression;
	generators: Comprehension[];
}

export interface DictComp extends Base<"DictComp"> {
	key: Expression;
	value: Expression;
	generators: Comprehension[];
}

export interface Await extends Base<"Await" | "YieldFrom"> {
	value: Expression;
}

export interface Yield extends Base<"Yield"> {
	value: Expression | undefined;
}

export interface Compare extends Base<"Compare"> {
	left: Expression;
	ops: ComparisonOperator[];
	comparators: Expression[];
}

export interface Call extends Base<"Call"> {
	func: Expression;
	args: Expression[];
	keywords: Keyword[];
}

export interface FormattedValue extends Base<"FormattedValue" | "Interpolation"> {
	value: Expression;
	/** -1 for none, else the code of `s`, `r` or `a`. */
	conversion: number;
	formatSpec: JoinedStr | undefined;
}

export interface JoinedStr extends Base<"JoinedStr" | "TemplateStr"> {
	values: Array<Constant | FormattedValue>;
}

export interface Constant extends Base<"Constant"> {
	value: PyValue;
}

export interface Attribute extends Base<"Attribute"> {
	value: Expression;
	attr: string;
	ctx: Context;
}

export interface Subscript extends Base<"Subscript"> {
	value: Expression;
	slice: Expression;
	ctx: Context;
}

export interface Starred extends Base<"Starred"> {
	value: Expression;
	ctx: Context;
}

export interface Name extends Base<"Name"> {
	id: string;
	ctx: Context;
}

export interface Sequence extends Base<"List" | "Tuple"> {
	elts: Expression[];
	ctx: Context;
}

export interface Slice extends Base<"Slice"> {
	lower: Expression | undefined;
	upper: Expression | undefined;
	step: Expression | undefined;
}

export type Expression =
	| BoolOp
	| NamedExpr
	| BinOp
	| UnaryOp
	| Lambda
	| IfExp
	| Dict
	| SetNode
	| Comprehended
	| DictComp
	| Await
	| Yield
	| Compare
	| Call
	| FormattedValue
	| JoinedStr
	| Constant
	| Attribute
	| Subscript
	| Starred
	| Name
	| Sequence
	| Slice;

////////////////////////////////
//  Parts

export interface Arguments extends Base<"arguments"> {
	posonlyargs: Arg[];
	args: Arg[];
	vararg: Arg | undefined;
	kwonlyargs: Arg[];
	/** Undefined where a keyword-only parameter has no default. */
	kwDefaults: Array<Expression | undefined>;
	kwarg: Arg | undefined;
	defaults: Expression[];
}

export interface Arg extends Base<"arg"> {
	arg: string;
	annotation: Expression | undefined;
	typeComment: string | undefined;
}

export interface Keyword extends Base<"keyword"> {
	/** Undefined for `**` unpacking. */
	arg: string | undefined;
	value: Expression;
}

export interface Alias extends Base<"alias"> {
	name: string;
	asname: string | undefined;
}

export interface WithItem extends Base<"withitem"> {
	contextExpr: Expression;
	optionalVars: Expression | undefined;
}

export interface Comprehension extends Base<"comprehension"> {
	target: Expression;
	iter: Expression;
	ifs: Expression[];
	isAsync: boolean;
}

export interface ExceptHandler extends Base<"ExceptHandler"> {
	exceptionType: Expression | undefined;
	name: string | undefined;
	body: Statement[];
}

export interface MatchCase extends Base<"match_case"> {
	pattern: Pattern;
	guard: Expression | undefined;
	body: Statement[];
}

export interface MatchValue extends Base<"MatchValue"> {
	value: Expression;
}

export interface MatchSingleton extends Base<"MatchSingleton"> {
	value: PyValue;
}

export interface MatchSequence extends Base<"MatchSequence" | "MatchOr"> {
	patterns: Pattern[];
}

export interface MatchMapping extends Base<"MatchMapping"> {
	keys: Expression[];
	patterns: Pattern[];
	rest: string | undefined;
}

export interface MatchClass extends Base<"MatchClass"> {
	cls: Expression;
	patterns: Pattern[];
	kwdAttrs: string[];
	kwdPatterns: Pattern[];
}

export interface MatchStar extends Base<"MatchStar"> {
	name: string | undefined;
}

export interface MatchAs extends Base<"MatchAs"> {
	pattern: Pattern | undefined;
	name: string | undefined;
}

export type Pattern = MatchValue | MatchSingleton | MatchSequence | MatchMapping | MatchClass | MatchStar | MatchAs;

export interface TypeParam extends Base<"TypeVar" | "ParamSpec" | "TypeVarTuple"> {
	name: string;
	bound: Expression | undefined;
	defaultValue: Expression | undefined;
}

/** A signature type comment, as `ast.parse(text, mode="func_type")` reads it. */
export interface FunctionType {
	argtypes: Expression[];
	returns: Expression;
}

export type Node =
	| Module
	| Statement
	| Expression
	| Arguments
	| Arg
	| Keyword
	| Alias
	| WithItem
	| Comprehension
	| ExceptHandler
	| MatchCase
	| Pattern
	| TypeParam;

////////////////////////////////
//  Constants

/** Each node class's child fields in `_fields` order. */
const CHILDREN: Readonly<Record<Node["type"], readonly string[]>> = {
	Module: ["body"],
	FunctionDef: ["args", "body", "decoratorList", "returns", "typeParams"],
	AsyncFunctionDef: ["args", "body", "decoratorList", "returns", "typeParams"],
	ClassDef: ["bases", "keywords", "body", "decoratorList", "typeParams"],
	Return: ["value"],
	Delete: ["targets"],
	Assign: ["targets", "value"],
	TypeAlias: ["name", "typeParams", "value"],
	AugAssign: ["target", "value"],
	AnnAssign: ["target", "annotation", "value"],
	For: ["target", "iter", "body", "orelse"],
	AsyncFor: ["target", "iter", "body", "orelse"],
	While: ["test", "body", "orelse"],
	If: ["test", "body", "orelse"],
	With: ["items", "body"],
	AsyncWith: ["items", "body"],
	Match: ["subject", "cases"],
	Raise: ["exc", "cause"],
	Try: ["body", "handlers", "orelse", "finalbody"],
	TryStar: ["body", "handlers", "orelse", "finalbody"],
	Assert: ["test", "msg"],
	Import: ["names"],
	ImportFrom: ["names"],
	Global: [],
	Nonlocal: [],
	Expr: ["value"],
	Pass: [],
	Break: [],
	Continue: [],
	BoolOp: ["values"],
	NamedExpr: ["target", "value"],
	BinOp: ["left", "right"],
	UnaryOp: ["operand"],
	Lambda: ["args", "body"],
	IfExp: ["test", "body", "orelse"],
	Dict: ["keys", "values"],
	Set: ["elts"],
	ListComp: ["elt", "generators"],
	SetComp: ["elt", "generators"],
	GeneratorExp: ["elt", "generators"],
	DictComp: ["key", "value", "generators"],
	Await: ["value"],
	Yield: ["value"],
	YieldFrom: ["value"],
	Compare: ["left", "comparators"],
	Call: ["func", "args", "keywords"],
	FormattedValue: ["value", "formatSpec"],
	Interpolation: ["value", "formatSpec"],
	JoinedStr: ["values"],
	TemplateStr: ["values"],
	Constant: [],
	Attribute: ["value"],
	Subscript: ["value", "slice"],
	Starred: ["value"],
	Name: [],
	List: ["elts"],
	Tuple: ["elts"],
	Slice: ["lower", "upper", "step"],
	arguments: ["posonlyargs", "args", "vararg", "kwonlyargs", "kwDefaults", "kwarg", "defaults"],
	arg: ["annotation"],
	keyword: ["value"],
	alias: [],
	withitem: ["contextExpr", "optionalVars"],
	comprehension: ["target", "iter", "ifs"],
	ExceptHandler: ["exceptionType", "body"],
	match_case: ["pattern", "guard", "body"],
	MatchValue: ["value"],
	MatchSingleton: [],
	MatchSequence: ["patterns"],
	MatchMapping: ["keys", "patterns"],
	MatchClass: ["cls", "patterns", "kwdPatterns"],
	MatchStar: [],
	MatchAs: ["pattern"],
	MatchOr: ["patterns"],
	TypeVar: ["bound", "defaultValue"],
	ParamSpec: ["defaultValue"],
	TypeVarTuple: ["defaultValue"],
};

////////////////////////////////
//  Functions & Helpers

/** Each node a node holds, in field order, without collecting them. */
export function forEachChild(node: Node, visit: (child: Node) => void): void {
	const record = node as unknown as Record<string, unknown>;
	for (const field of CHILDREN[node.type]) {
		const value = record[field];
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) if (item !== undefined) visit(item as Node);
		} else visit(value as Node);
	}
}

/** `ast.iter_child_nodes`: every node a node holds, in field order. */
export function childNodes(node: Node): Node[] {
	const children: Node[] = [];
	forEachChild(node, (child) => children.push(child));
	return children;
}

/** Whether a path from `node` down holds more than `limit` edges. */
export function deeperThan(node: Node, limit: number): boolean {
	const pending: Node[] = [node];
	const depths: number[] = [0];
	for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
		const depth = depths.pop() as number;
		if (depth > limit) return true;
		forEachChild(current, (child) => {
			pending.push(child);
			depths.push(depth + 1);
		});
	}
	return false;
}

/** `ast.walk`: breadth first, the node itself first. */
export function walk(node: Node): Node[] {
	const nodes: Node[] = [node];
	const collect = (child: Node): void => {
		nodes.push(child);
	};
	for (let index = 0; index < nodes.length; index++) forEachChild(nodes[index] as Node, collect);
	return nodes;
}
