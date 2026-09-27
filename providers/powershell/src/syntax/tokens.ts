// PowerShell's tokens: kinds, their traits, the keyword and operator tables, and the character
// classes the tokenizer decides by, as PowerShell's own tokenizer defines them.

import type { CursorMark } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export type TokenKind =
	| "Unknown"
	| "Variable"
	| "SplattedVariable"
	| "Parameter"
	| "Number"
	| "Label"
	| "Identifier"
	| "Generic"
	| "NewLine"
	| "LineContinuation"
	| "Comment"
	| "EndOfInput"
	| "StringLiteral"
	| "StringExpandable"
	| "HereStringLiteral"
	| "HereStringExpandable"
	| "LParen"
	| "RParen"
	| "LCurly"
	| "RCurly"
	| "LBracket"
	| "RBracket"
	| "AtParen"
	| "AtCurly"
	| "DollarParen"
	| "Semi"
	| "AndAnd"
	| "OrOr"
	| "Ampersand"
	| "Pipe"
	| "Comma"
	| "MinusMinus"
	| "PlusPlus"
	| "DotDot"
	| "ColonColon"
	| "Dot"
	| "Exclaim"
	| "Multiply"
	| "Divide"
	| "Rem"
	| "Plus"
	| "Minus"
	| "Equals"
	| "PlusEquals"
	| "MinusEquals"
	| "MultiplyEquals"
	| "DivideEquals"
	| "RemainderEquals"
	| "Redirection"
	| "RedirectInStd"
	| "Format"
	| "Not"
	| "Bnot"
	| "And"
	| "Or"
	| "Xor"
	| "Band"
	| "Bor"
	| "Bxor"
	| "Join"
	| "Ieq"
	| "Ine"
	| "Ige"
	| "Igt"
	| "Ilt"
	| "Ile"
	| "Ilike"
	| "Inotlike"
	| "Imatch"
	| "Inotmatch"
	| "Ireplace"
	| "Icontains"
	| "Inotcontains"
	| "Iin"
	| "Inotin"
	| "Isplit"
	| "Ceq"
	| "Cne"
	| "Cge"
	| "Cgt"
	| "Clt"
	| "Cle"
	| "Clike"
	| "Cnotlike"
	| "Cmatch"
	| "Cnotmatch"
	| "Creplace"
	| "Ccontains"
	| "Cnotcontains"
	| "Cin"
	| "Cnotin"
	| "Csplit"
	| "Is"
	| "IsNot"
	| "As"
	| "PostfixPlusPlus"
	| "PostfixMinusMinus"
	| "Shl"
	| "Shr"
	| "Colon"
	| "QuestionMark"
	| "QuestionQuestionEquals"
	| "QuestionQuestion"
	| "QuestionDot"
	| "QuestionLBracket"
	| Keyword;

export type Keyword =
	| "Begin"
	| "Break"
	| "Catch"
	| "Class"
	| "Continue"
	| "Data"
	| "Define"
	| "Do"
	| "Dynamicparam"
	| "Else"
	| "ElseIf"
	| "End"
	| "Exit"
	| "Filter"
	| "Finally"
	| "For"
	| "Foreach"
	| "From"
	| "Function"
	| "If"
	| "In"
	| "Param"
	| "Process"
	| "Return"
	| "Switch"
	| "Throw"
	| "Trap"
	| "Try"
	| "Until"
	| "Using"
	| "Var"
	| "While"
	| "Workflow"
	| "Parallel"
	| "Sequence"
	| "InlineScript"
	| "Configuration"
	| "DynamicKeyword"
	| "Public"
	| "Private"
	| "Static"
	| "Interface"
	| "Enum"
	| "Namespace"
	| "Module"
	| "Type"
	| "Assembly"
	| "Command"
	| "Hidden"
	| "Base"
	| "Default"
	| "Clean";

interface BaseToken<K extends TokenKind = TokenKind> {
	kind: K;
	/** File offsets, as are the lines and columns. */
	pos: number;
	end: number;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	/** As written; in a string's `$(...)`, with its doubled quotes undone. */
	text: string;
}

/** A token its kind says all about. */
export type PlainToken = BaseToken;

export interface VariableToken extends BaseToken<"Variable" | "SplattedVariable"> {
	/** The path as written, scope or drive included, without `$`, `@` or braces. */
	path: string;
	braced: boolean;
}

export interface ParameterToken extends BaseToken<"Parameter"> {
	name: string;
	usedColon: boolean;
}

export interface NumberToken extends BaseToken<"Number"> {
	/** Its value as a double; past a double's range, infinite. */
	value: number;
	/** Its .NET type as PowerShell names it: `int`, `long`, `double`, `decimal`. */
	staticType: string;
}

export interface LabelToken extends BaseToken<"Label"> {
	label: string;
}

export interface RedirectionToken extends BaseToken<"Redirection" | "RedirectInStd"> {
	/** The stream redirected, `*` for all. */
	from: string;
	/** The stream merged into, for a merging redirection. */
	to?: string;
	append: boolean;
}

/** A `$(...)` inside an expandable string, read later as its own statements. */
export interface NestedExpression {
	kind: "SubExpression";
	pos: number;
	end: number;
	/** The text as the nested scan reads it, doubled quotes undone. */
	text: string;
	/** Where each code point of `text` starts, and its end, in the file, by `text` offset. */
	origins: ReadonlyMap<number, CursorMark>;
}

export type NestedPart = VariableToken | NestedExpression;

export interface StringToken extends BaseToken<"StringLiteral" | "HereStringLiteral" | "Generic"> {
	value: string;
}

export interface ExpandableToken extends BaseToken<"StringExpandable" | "HereStringExpandable" | "Generic"> {
	value: string;
	/** Variables and subexpressions the string expands, in order. */
	nested: NestedPart[];
	expandable: true;
}

export type Token =
	| PlainToken
	| VariableToken
	| ParameterToken
	| NumberToken
	| LabelToken
	| RedirectionToken
	| StringToken
	| ExpandableToken;

////////////////////////////////
//  Constants

export const KEYWORDS: ReadonlyMap<string, Keyword> = new Map(
	(
		[
			"elseif",
			"if",
			"else",
			"switch",
			"foreach",
			"from",
			"in",
			"for",
			"while",
			"until",
			"do",
			"try",
			"catch",
			"finally",
			"trap",
			"data",
			"return",
			"continue",
			"break",
			"exit",
			"throw",
			"begin",
			"process",
			"end",
			"dynamicparam",
			"function",
			"filter",
			"param",
			"class",
			"define",
			"var",
			"using",
			"workflow",
			"parallel",
			"sequence",
			"inlinescript",
			"configuration",
			"public",
			"private",
			"static",
			"interface",
			"enum",
			"namespace",
			"module",
			"type",
			"assembly",
			"command",
			"hidden",
			"base",
			"default",
			"clean",
		] as const
	).map((word) => [word, keywordKind(word)]),
);

/** `-name` operators, case-insensitive; the `i` forms read as the plain ones. */
export const OPERATORS: ReadonlyMap<string, TokenKind> = new Map([
	["bnot", "Bnot"],
	["not", "Not"],
	["eq", "Ieq"],
	["ieq", "Ieq"],
	["ceq", "Ceq"],
	["ne", "Ine"],
	["ine", "Ine"],
	["cne", "Cne"],
	["ge", "Ige"],
	["ige", "Ige"],
	["cge", "Cge"],
	["gt", "Igt"],
	["igt", "Igt"],
	["cgt", "Cgt"],
	["lt", "Ilt"],
	["ilt", "Ilt"],
	["clt", "Clt"],
	["le", "Ile"],
	["ile", "Ile"],
	["cle", "Cle"],
	["like", "Ilike"],
	["ilike", "Ilike"],
	["clike", "Clike"],
	["notlike", "Inotlike"],
	["inotlike", "Inotlike"],
	["cnotlike", "Cnotlike"],
	["match", "Imatch"],
	["imatch", "Imatch"],
	["cmatch", "Cmatch"],
	["notmatch", "Inotmatch"],
	["inotmatch", "Inotmatch"],
	["cnotmatch", "Cnotmatch"],
	["replace", "Ireplace"],
	["ireplace", "Ireplace"],
	["creplace", "Creplace"],
	["contains", "Icontains"],
	["icontains", "Icontains"],
	["ccontains", "Ccontains"],
	["notcontains", "Inotcontains"],
	["inotcontains", "Inotcontains"],
	["cnotcontains", "Cnotcontains"],
	["in", "Iin"],
	["iin", "Iin"],
	["cin", "Cin"],
	["notin", "Inotin"],
	["inotin", "Inotin"],
	["cnotin", "Cnotin"],
	["split", "Isplit"],
	["isplit", "Isplit"],
	["csplit", "Csplit"],
	["isnot", "IsNot"],
	["is", "Is"],
	["as", "As"],
	["f", "Format"],
	["and", "And"],
	["band", "Band"],
	["or", "Or"],
	["bor", "Bor"],
	["xor", "Xor"],
	["bxor", "Bxor"],
	["join", "Join"],
	["shl", "Shl"],
	["shr", "Shr"],
]);

/** Binary precedence, loosest first. */
const PRECEDENCE: ReadonlyArray<readonly [number, readonly TokenKind[]]> = [
	[1, ["And", "Or", "Xor"]],
	[2, ["Band", "Bor", "Bxor"]],
	[
		5,
		[
			"Join",
			"Ieq",
			"Ine",
			"Ige",
			"Igt",
			"Ilt",
			"Ile",
			"Ilike",
			"Inotlike",
			"Imatch",
			"Inotmatch",
			"Ireplace",
			"Icontains",
			"Inotcontains",
			"Iin",
			"Inotin",
			"Isplit",
			"Ceq",
			"Cne",
			"Cge",
			"Cgt",
			"Clt",
			"Cle",
			"Clike",
			"Cnotlike",
			"Cmatch",
			"Cnotmatch",
			"Creplace",
			"Ccontains",
			"Cnotcontains",
			"Cin",
			"Cnotin",
			"Csplit",
			"Is",
			"IsNot",
			"As",
			"Shl",
			"Shr",
		],
	],
	[7, ["QuestionQuestion"]],
	[9, ["Plus", "Minus"]],
	[10, ["Multiply", "Divide", "Rem"]],
	[12, ["Format"]],
	[13, ["DotDot"]],
];

const BINARY: ReadonlyMap<TokenKind, number> = new Map(
	PRECEDENCE.flatMap(([level, kinds]) => kinds.map((kind) => [kind, level] as const)),
);

const UNARY: ReadonlySet<TokenKind> = new Set([
	"Comma",
	"MinusMinus",
	"PlusPlus",
	"Exclaim",
	"Plus",
	"Minus",
	"Not",
	"Bnot",
	"Join",
	"Isplit",
	"Csplit",
]);

const ASSIGNMENT: ReadonlySet<TokenKind> = new Set([
	"Equals",
	"PlusEquals",
	"MinusEquals",
	"MultiplyEquals",
	"DivideEquals",
	"RemainderEquals",
	"QuestionQuestionEquals",
]);

/** Tokens that read the same in command and expression mode. */
const MODE_INVARIANT: ReadonlySet<TokenKind> = new Set([
	"NewLine",
	"LineContinuation",
	"Comment",
	"EndOfInput",
	"StringLiteral",
	"StringExpandable",
	"HereStringLiteral",
	"HereStringExpandable",
	"LParen",
	"RParen",
	"LCurly",
	"RCurly",
	"RBracket",
	"AtParen",
	"AtCurly",
	"DollarParen",
	"Semi",
	"AndAnd",
	"OrOr",
	"Ampersand",
	"Pipe",
	"Comma",
	"RedirectInStd",
]);

/** Keywords no attribute may precede. */
const NO_ATTRIBUTES: ReadonlySet<TokenKind> = new Set([
	"Break",
	"Continue",
	"Data",
	"Define",
	"Do",
	"Exit",
	"Filter",
	"For",
	"Foreach",
	"From",
	"Function",
	"If",
	"Return",
	"Switch",
	"Throw",
	"Trap",
	"Try",
	"Using",
	"Var",
	"While",
	"Workflow",
	"Parallel",
	"Sequence",
	"InlineScript",
]);

export const BLOCK_NAMES: ReadonlySet<TokenKind> = new Set(["Begin", "Process", "End", "Dynamicparam", "Clean"]);

const KEYWORD_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([...KEYWORDS.values(), "DynamicKeyword"]);

////////////////////////////////
//  Functions & Helpers

function keywordKind(word: string): Keyword {
	const special: Record<string, Keyword> = {
		elseif: "ElseIf",
		dynamicparam: "Dynamicparam",
		inlinescript: "InlineScript",
	};
	return special[word] ?? ((word[0]?.toUpperCase() + word.slice(1)) as Keyword);
}

export function isKeyword(kind: TokenKind): kind is Keyword {
	return KEYWORD_KINDS.has(kind);
}

export function binaryPrecedence(kind: TokenKind): number | undefined {
	return BINARY.get(kind);
}

export function isUnaryOperator(kind: TokenKind): boolean {
	return UNARY.has(kind);
}

export function isAssignmentOperator(kind: TokenKind): boolean {
	return ASSIGNMENT.has(kind);
}

export function isModeInvariant(kind: TokenKind): boolean {
	return MODE_INVARIANT.has(kind);
}

export function rejectsAttributes(kind: TokenKind): boolean {
	return NO_ATTRIBUTES.has(kind);
}

////////////////////////////////
//  Characters

const characters = (...points: number[]): Set<string> => new Set(points.map((point) => String.fromCodePoint(point)));

/** The hyphen, en dash, em dash and horizontal bar. */
const DASHES = characters(0x2d, 0x2013, 0x2014, 0x2015);
/** Apostrophe and the typographic single quotes. */
const SINGLE_QUOTES = characters(0x27, 0x2018, 0x2019, 0x201a, 0x201b);
/** Quotation mark and the typographic double quotes. */
const DOUBLE_QUOTES = characters(0x22, 0x201c, 0x201d, 0x201e);
/** ASCII characters that end a bare word whatever the mode. */
/** PowerShell reads a NUL as it reads the end of input. */
export const NUL = String.fromCharCode(0);
const TOKEN_ENDERS = new Set(["", NUL, "\t", "\n", "\u000b", "\f", "\r", " ", "&", "(", ")", ",", ";", "{", "|", "}"]);
/** ASCII characters that end a piece of an assembly name. */
const ASSEMBLY_ENDERS = new Set(["", NUL, "\t", "\n", "\u000b", "\f", "\r", " ", ",", "=", "]"]);
/** ASCII characters that also end a number in expression mode. */
const NUMBER_ENDERS = new Set(["!", "#", "%", "*", "+", "-", ".", "/", "<", "=", ">", "]"]);

const LETTER_RE = /^\p{L}$/u;
const LETTER_OR_DIGIT_RE = /^[\p{L}\p{Nd}]$/u;
const SEPARATOR_RE = /^\p{Z}$/u;

export function isDash(character: string): boolean {
	return DASHES.has(character);
}

export function isSingleQuote(character: string): boolean {
	return SINGLE_QUOTES.has(character);
}

export function isDoubleQuote(character: string): boolean {
	return DOUBLE_QUOTES.has(character);
}

export function isLetter(character: string): boolean {
	return LETTER_RE.test(character);
}

export function isLetterOrDigit(character: string): boolean {
	return LETTER_OR_DIGIT_RE.test(character);
}

export function isDecimalDigit(character: string): boolean {
	return character.length === 1 && character >= "0" && character <= "9";
}

export function isHexDigit(character: string): boolean {
	return character.length === 1 && /^[0-9a-fA-F]$/.test(character);
}

/** Blank that is no line break: spaces, tabs, form feed, and Unicode separators. */
export function isWhitespace(character: string): boolean {
	if (character === " " || character === "\t" || character === "\u000b" || character === "\f") return true;
	const point = character.codePointAt(0) ?? 0;
	if (point < 128) return false;
	if (point <= 256) return point === 0xa0 || point === 0x85;
	return SEPARATOR_RE.test(character);
}

export function isVariableStart(character: string): boolean {
	const point = character.codePointAt(0) ?? 0;
	if (point < 128) return /^[A-Za-z0-9_$:?^]$/.test(character);
	return isLetterOrDigit(character);
}

export function isIdentifierStart(character: string): boolean {
	const point = character.codePointAt(0) ?? 0;
	if (point < 128) return /^[A-Za-z_]$/.test(character);
	return isLetter(character);
}

export function isIdentifierFollow(character: string): boolean {
	const point = character.codePointAt(0) ?? 0;
	if (point < 128) return /^[A-Za-z0-9_]$/.test(character);
	return isLetterOrDigit(character);
}

/** Ends a bare word in any mode. */
export function forcesNewToken(character: string): boolean {
	const point = character.codePointAt(0) ?? 0;
	if (point < 128) return TOKEN_ENDERS.has(character);
	return isWhitespace(character);
}

/** Ends a number in expression mode; `?` and `:` too after a ternary's `?`. */
export function forcesNewTokenAfterNumber(character: string, ternary: boolean): boolean {
	const point = character.codePointAt(0) ?? 0;
	if (point < 128) return NUMBER_ENDERS.has(character) || (ternary && (character === "?" || character === ":"));
	return isDash(character);
}

/** Ends a token of an assembly name spec. */
export function forcesNewAssemblyToken(character: string): boolean {
	const point = character.codePointAt(0) ?? 0;
	if (point < 128) return ASSEMBLY_ENDERS.has(character);
	return isWhitespace(character);
}
