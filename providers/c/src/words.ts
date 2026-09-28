// C keyword, specifier and operator sets, and word predicates.

import type { CToken } from "./tokens.js";

////////////////////////////////
//  Constants

export const C_KEYWORDS: ReadonlySet<string> = new Set([
	"alignas",
	"alignof",
	"asm",
	"auto",
	"break",
	"case",
	"char",
	"const",
	"continue",
	"default",
	"do",
	"double",
	"else",
	"enum",
	"extern",
	"float",
	"for",
	"goto",
	"if",
	"inline",
	"int",
	"long",
	"register",
	"restrict",
	"return",
	"short",
	"signed",
	"sizeof",
	"static",
	"struct",
	"switch",
	"typedef",
	"union",
	"unsigned",
	"void",
	"volatile",
	"while",
	"_Alignas",
	"_Alignof",
	"_Atomic",
	"_Bool",
	"_Complex",
	"_Generic",
	"_Imaginary",
	"_Noreturn",
	"_Static_assert",
	"_Thread_local",
	"bool",
	"false",
	"true",
	"typeof",
	"typeof_unqual",
	"__alignof",
	"__alignof__",
	"__asm",
	"__asm__",
	"__attribute",
	"__attribute__",
	"__declspec",
	"__typeof",
	"__typeof__",
	"__extension__",
	"__inline",
	"__inline__",
	"__restrict",
	"__restrict__",
	"__volatile__",
]);

export const STORAGE_WORDS: ReadonlySet<string> = new Set([
	"auto",
	"extern",
	"inline",
	"register",
	"static",
	"typedef",
	"_Thread_local",
	"__extension__",
	"__inline",
	"__inline__",
]);

export const TYPE_QUALIFIERS: ReadonlySet<string> = new Set([
	"const",
	"restrict",
	"volatile",
	"_Atomic",
	"__const",
	"__const__",
	"__restrict",
	"__restrict__",
	"__volatile",
	"__volatile__",
]);

export const CALLING_CONVENTIONS: ReadonlySet<string> = new Set([
	"__cdecl",
	"__fastcall",
	"__stdcall",
	"__thiscall",
	"__vectorcall",
	"__usercall",
	"__userpurge",
	"__noreturn",
	"__forceinline",
	"__packed",
	"__interrupt",
	"__far",
	"__near",
	"__ptr32",
	"__ptr64",
]);

/** Specifiers whose `(...)` holds arguments. */
export const ARGUMENT_SPECIFIERS: ReadonlySet<string> = new Set([
	"__attribute__",
	"__attribute",
	"__declspec",
	"_Alignas",
	"alignas",
]);

/** Type specifiers taking `(...)`. */
export const TYPE_OPERATORS: ReadonlySet<string> = new Set([
	"_Atomic",
	"typeof",
	"typeof_unqual",
	"__typeof__",
	"__typeof",
]);

export const ASM_LABELS: ReadonlySet<string> = new Set(["asm", "__asm", "__asm__"]);

export const ALIGNMENT_SPECIFIERS: ReadonlySet<string> = new Set(["_Alignas", "alignas"]);

/** Specifiers whose arguments name nothing a declaration holds. */
export const ATTRIBUTE_SPECIFIERS: ReadonlySet<string> = new Set(["__attribute__", "__attribute", "__declspec"]);

/** Statements whose `(...)` a body follows. */
export const CONTROL_WORDS: ReadonlySet<string> = new Set(["if", "for", "while", "switch"]);

export const TAG_WORDS: ReadonlySet<string> = new Set(["struct", "union", "enum"]);

/** Declaration words a type spelling omits. */
export const UNSPELLED_WORDS: ReadonlySet<string> = new Set([
	"static",
	"extern",
	"typedef",
	"inline",
	"register",
	"auto",
	"_Thread_local",
	"__extension__",
	"const",
	"restrict",
	"volatile",
	"__const",
	"__const__",
	"__restrict",
	"__restrict__",
	"__volatile",
	"__volatile__",
]);

export const BUILTIN_TYPES: ReadonlySet<string> = new Set([
	"char",
	"double",
	"float",
	"int",
	"long",
	"short",
	"signed",
	"unsigned",
	"void",
	"_Bool",
	"bool",
	"size_t",
	"ssize_t",
	"ptrdiff_t",
	"wchar_t",
	"int8_t",
	"int16_t",
	"int32_t",
	"int64_t",
	"uint8_t",
	"uint16_t",
	"uint32_t",
	"uint64_t",
	"intptr_t",
	"uintptr_t",
	"byte",
	"word",
	"dword",
	"qword",
	"code",
	"undefined",
	"undefined1",
	"undefined2",
	"undefined3",
	"undefined4",
	"undefined5",
	"undefined6",
	"undefined7",
	"undefined8",
	"undefined9",
	"undefined10",
	"uint",
	"uint8",
	"uint16",
	"uint32",
	"uint64",
	"int8",
	"int16",
	"int32",
	"int64",
	"uchar",
	"ushort",
	"ulong",
	"ulonglong",
	"__int8",
	"__int16",
	"__int32",
	"__int64",
	"BOOL",
	"BYTE",
	"WORD",
	"DWORD",
	"QWORD",
	"HANDLE",
	"LPCSTR",
	"LPCWSTR",
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

/** Member access and designators. */
export const MEMBER_OPERATORS: ReadonlySet<string> = new Set([".", "->"]);

export const OPENERS: ReadonlySet<string> = new Set(["(", "[", "{"]);

export const CLOSERS: ReadonlyMap<string, string> = new Map([
	[")", "("],
	["]", "["],
	["}", "{"],
]);

////////////////////////////////
//  Functions & Helpers

export function isIdentifierToken(token: CToken | undefined): token is CToken & { kind: "identifier" } {
	return token?.kind === "identifier";
}

/** Adjacent word tokens need a space. */
export function wordLike(token: CToken): boolean {
	return token.kind === "identifier" || token.kind === "number" || token.kind === "string" || token.kind === "char";
}

/** Joins a type's specifiers and declarator. */
export function joinSpelling(specifiers: string, declarator: string): string {
	if (specifiers === "") return declarator;
	return declarator === "" ? specifiers : `${specifiers} ${declarator}`;
}

export function typeWords(value: string): boolean {
	return (
		BUILTIN_TYPES.has(value) ||
		C_KEYWORDS.has(value) ||
		STORAGE_WORDS.has(value) ||
		TYPE_QUALIFIERS.has(value) ||
		CALLING_CONVENTIONS.has(value)
	);
}

export function isSpecifierWord(value: string): boolean {
	return (
		BUILTIN_TYPES.has(value) ||
		STORAGE_WORDS.has(value) ||
		TYPE_QUALIFIERS.has(value) ||
		CALLING_CONVENTIONS.has(value) ||
		ARGUMENT_SPECIFIERS.has(value) ||
		TYPE_OPERATORS.has(value)
	);
}

export function isTypeToken(token: CToken | undefined): boolean {
	return (
		token?.kind === "identifier" &&
		!C_KEYWORDS.has(token.value) &&
		!STORAGE_WORDS.has(token.value) &&
		!CALLING_CONVENTIONS.has(token.value) &&
		!TYPE_QUALIFIERS.has(token.value)
	);
}
