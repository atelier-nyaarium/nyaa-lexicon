// C++ keyword and specifier sets, and name predicates.

import type { Token } from "./tokens.js";

////////////////////////////////
//  Constants

export const KEYWORDS: ReadonlySet<string> = new Set([
	"alignas",
	"alignof",
	"and",
	"and_eq",
	"asm",
	"atomic_cancel",
	"atomic_commit",
	"atomic_noexcept",
	"auto",
	"bitand",
	"bitor",
	"break",
	"case",
	"catch",
	"class",
	"compl",
	"concept",
	"const",
	"consteval",
	"constexpr",
	"constinit",
	"const_cast",
	"continue",
	"co_await",
	"co_return",
	"co_yield",
	"decltype",
	"default",
	"delete",
	"do",
	"dynamic_cast",
	"else",
	"enum",
	"explicit",
	"export",
	"extern",
	"false",
	"for",
	"friend",
	"goto",
	"if",
	"inline",
	"mutable",
	"namespace",
	"new",
	"noexcept",
	"not",
	"not_eq",
	"nullptr",
	"operator",
	"or",
	"or_eq",
	"private",
	"protected",
	"public",
	"register",
	"reinterpret_cast",
	"requires",
	"return",
	"signed",
	"sizeof",
	"static",
	"static_assert",
	"static_cast",
	"struct",
	"switch",
	"template",
	"this",
	"thread_local",
	"throw",
	"true",
	"try",
	"typedef",
	"typeid",
	"typename",
	"union",
	"unsigned",
	"using",
	"virtual",
	"void",
	"volatile",
	"wchar_t",
	"while",
	"xor",
	"xor_eq",
]);

export const TYPE_WORDS: ReadonlySet<string> = new Set([
	"bool",
	"char",
	"char8_t",
	"char16_t",
	"char32_t",
	"double",
	"float",
	"int",
	"long",
	"short",
	"signed",
	"unsigned",
	"void",
	"wchar_t",
	"auto",
	"decltype",
	"const",
	"volatile",
	"static",
	"constexpr",
	"mutable",
	"thread_local",
	"inline",
]);

export const MODIFIERS: ReadonlySet<string> = new Set([
	"const",
	"consteval",
	"constexpr",
	"constinit",
	"explicit",
	"extern",
	"friend",
	"inline",
	"mutable",
	"register",
	"static",
	"thread_local",
	"typename",
	"virtual",
	"volatile",
	"export",
]);

export const DECLARATION_SPECIFIERS: ReadonlySet<string> = new Set(["__declspec", "__attribute__", "alignas"]);

export const CONTROL_NAMES: ReadonlySet<string> = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"sizeof",
	"decltype",
]);

export const ASSIGNMENT_OPERATORS: ReadonlySet<string> = new Set([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"<<=",
	">>=",
]);

////////////////////////////////
//  Functions & Helpers

export function isShoutCase(value: string): boolean {
	return /^[A-Z0-9_]*[A-Z][A-Z0-9_]*$/u.test(value);
}

////////////////////////////////
//  Constants

export const INTEGRAL_WORDS: ReadonlySet<string> = new Set(["signed", "unsigned", "short", "long", "int", "char"]);

/** Function qualifiers that take part in overload identity; `noexcept`, `override` and a trailing return do not. */
export const FUNCTION_QUALIFIERS: ReadonlySet<string> = new Set(["const", "volatile", "&", "&&"]);

////////////////////////////////
//  Functions & Helpers

export function isNameToken(token: Token | undefined): boolean {
	return token?.kind === "identifier" && !KEYWORDS.has(token.value);
}
