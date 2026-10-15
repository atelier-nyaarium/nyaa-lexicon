/** Strict and reserved keywords of edition 2018 and later. `gen` (2024 only) and weak keywords such as `union` stay names. */
const RUST_KEYWORD_NAMES = [
	"Self",
	"abstract",
	"as",
	"async",
	"await",
	"become",
	"box",
	"break",
	"const",
	"continue",
	"crate",
	"do",
	"dyn",
	"else",
	"enum",
	"extern",
	"false",
	"final",
	"fn",
	"for",
	"if",
	"impl",
	"in",
	"let",
	"loop",
	"macro",
	"match",
	"mod",
	"move",
	"mut",
	"override",
	"priv",
	"pub",
	"ref",
	"return",
	"self",
	"static",
	"struct",
	"super",
	"trait",
	"true",
	"try",
	"type",
	"typeof",
	"unsafe",
	"unsized",
	"use",
	"virtual",
	"where",
	"while",
	"yield",
] as const;

/** Highlighted as keywords, but valid names in some position or edition. */
const RUST_CONTEXTUAL_KEYWORDS = ["gen", "union"] as const;

const RUST_KEYWORDS: ReadonlySet<string> = new Set(RUST_KEYWORD_NAMES);
const RUST_TYPE_KINDS: ReadonlySet<string> = new Set(["struct", "enum", "interface", "class"]);
const RUST_PATH_HEADS: ReadonlySet<string> = new Set(["crate", "self", "super", "Self"]);
const RUST_LITERALS = ["false", "true"] as const;
const RUST_LITERAL_SET: ReadonlySet<string> = new Set(RUST_LITERALS);

export function isRustKeyword(value: string): boolean {
	return RUST_KEYWORDS.has(value);
}

export function isRustTypeKind(kind: string): boolean {
	return RUST_TYPE_KINDS.has(kind);
}

export function isRustPathHead(value: string): boolean {
	return RUST_PATH_HEADS.has(value);
}

export const WORDS = {
	keywords: [...RUST_KEYWORD_NAMES.filter((word) => !RUST_LITERAL_SET.has(word)), ...RUST_CONTEXTUAL_KEYWORDS].sort(),
	builtins: [
		"String",
		"Vec",
		"bool",
		"char",
		"f32",
		"f64",
		"i128",
		"i16",
		"i32",
		"i64",
		"i8",
		"isize",
		"str",
		"u128",
		"u16",
		"u32",
		"u64",
		"u8",
		"usize",
	],
	literals: [...RUST_LITERALS],
};

export { RUST_KEYWORDS as KEYWORDS };
