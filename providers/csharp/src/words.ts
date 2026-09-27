// C# word and punctuation sets, and the token predicates every parse layer shares.

import type { Token } from "./tokens.js";

////////////////////////////////
//  Constants

/** Deeper is no type. */
export const MAX_TYPE_DEPTH = 32;

export const MODIFIERS: ReadonlySet<string> = new Set([
	"public",
	"private",
	"protected",
	"internal",
	"static",
	"abstract",
	"sealed",
	"partial",
	"readonly",
	"ref",
	"out",
	"in",
	"async",
	"implicit",
	"explicit",
	"extern",
	"unsafe",
	"new",
	"required",
	"virtual",
	"override",
	"volatile",
	"file",
	"scoped",
	"const",
	"fixed",
]);

export const SKIPPED_WORDS: ReadonlySet<string> = new Set([
	"abstract",
	"add",
	"alias",
	"and",
	"as",
	"await",
	"base",
	"break",
	"case",
	"catch",
	"checked",
	"class",
	"const",
	"continue",
	"default",
	"delegate",
	"do",
	"else",
	"enum",
	"event",
	"explicit",
	"extern",
	"false",
	"finally",
	"fixed",
	"for",
	"foreach",
	"from",
	"get",
	"global",
	"goto",
	"if",
	"init",
	"implicit",
	"in",
	"interface",
	"internal",
	"is",
	"lock",
	"namespace",
	"nameof",
	"new",
	"null",
	"object",
	"operator",
	"out",
	"override",
	"params",
	"partial",
	"private",
	"protected",
	"public",
	"readonly",
	"record",
	"ref",
	"remove",
	"return",
	"sealed",
	"select",
	"set",
	"scoped",
	"sizeof",
	"stackalloc",
	"static",
	"struct",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"unchecked",
	"unsafe",
	"using",
	"var",
	"virtual",
	"required",
	"file",
	"async",
	"not",
	"or",
	"void",
	"volatile",
	"when",
	"where",
	"while",
	"with",
	"yield",
]);

export const BUILTIN_TYPES: ReadonlySet<string> = new Set([
	"bool",
	"byte",
	"sbyte",
	"char",
	"decimal",
	"double",
	"float",
	"int",
	"long",
	"nint",
	"nuint",
	"object",
	"short",
	"string",
	"uint",
	"ulong",
	"ushort",
	"void",
	"dynamic",
	"var",
]);

/** May precede a type. */
export const TYPE_PREFIXES: ReadonlySet<string> = new Set([...MODIFIERS, "this", "params", "checked"]);

export const ASSIGNMENT_WORDS: ReadonlySet<string> = new Set([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"??=",
]);

export const ACCESSOR_KEYWORDS: ReadonlySet<string> = new Set(["get", "set", "init", "add", "remove"]);

export const STATEMENT_BOUNDARY: ReadonlySet<string> = new Set([";", "{", "}"]);

export const LAMBDA_ATTRIBUTE_CONTEXT: ReadonlySet<string> = new Set(["(", ",", "=>", "return", ...ASSIGNMENT_WORDS]);

export const CONSTRAINT_KEYWORDS: ReadonlySet<string> = new Set([
	"class",
	"struct",
	"notnull",
	"unmanaged",
	"default",
	"new",
]);

/** A `[` or `(` after these opens a value. */
export const VALUE_OPENERS: ReadonlySet<string> = new Set(["=", "(", ",", "=>", ":", "??", "?"]);

/** Their parenthesized operand is a type. */
export const TYPE_OPERATORS: ReadonlySet<string> = new Set(["typeof", "default", "sizeof", "nameof"]);

/** Keywords that may follow a value. */
export const VALUE_FOLLOWERS: ReadonlySet<string> = new Set(["is", "as", "switch", "with"]);

/** After `()`: lambda params, a type argument, or another argument before `,`. */
export const NOT_TUPLE_FOLLOWERS: ReadonlySet<string> = new Set(["=>", ",", ">", ">>"]);

/** Member access and qualifier operators. */
export const MEMBER_OPERATORS: ReadonlySet<string> = new Set([".", "?.", "->", "::"]);

/** After a type argument list in an expression, these keep it one. */
export const TYPE_ARGUMENT_FOLLOWERS: ReadonlySet<string> = new Set([
	"(",
	")",
	"]",
	"}",
	":",
	";",
	",",
	".",
	"?",
	"?.",
	"==",
	"!=",
	"|",
	"^",
	"&&",
	"||",
	"&",
	"[",
	"{",
	"=>",
	"<",
	"<=",
	">=",
	"is",
	"as",
]);

export const GROUP_CLOSERS: ReadonlyMap<string, string> = new Map([
	["(", ")"],
	["[", "]"],
	["{", "}"],
]);

/** Punctuation a type argument list holds outside its groups. */
export const TYPE_LIST_PUNCTUATION: ReadonlySet<string> = new Set([",", ".", "::", "?", "*", "<", ">", ">>", "(", "["]);

export const EMPTY_MAP: ReadonlyMap<number, number> = new Map();

////////////////////////////////
//  Functions & Helpers

export function isTrivia(token: Token | undefined): boolean {
	return (
		token === undefined ||
		token.kind === "comment" ||
		token.kind === "doc" ||
		token.kind === "directive" ||
		token.kind === "newline"
	);
}

export function isIdentifier(token: Token | undefined): token is Token {
	return token?.kind === "identifier";
}

export function syntaxValue(token: Token | undefined): string | undefined {
	return token?.kind === "identifier" || token?.kind === "punctuation" ? token.value : undefined;
}
