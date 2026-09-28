// The shapes a C# parse produces and passes between its layers.

import type {
	CommentSpan,
	Declaration,
	Descriptor,
	Diagnostic,
	FileRole,
	ImportedName,
	Literal,
	Range,
	Reference,
	SymbolKind,
} from "@nyaa-lexicon/protocol";
import type { Token } from "./tokens.js";

////////////////////////////////
//  Constants

export const LANGUAGE = "csharp";

////////////////////////////////
//  Interfaces & Types

export interface CsharpImport {
	specifier: string;
	imported: ImportedName[];
	reExport: false;
	alias?: string;
	static: boolean;
	/** `global using`: in every file of the project. */
	global: boolean;
	/** The namespace declaration whose body holds the directive; none at the compilation unit. */
	scopeId?: string;
	/** What the directive names, name by name with the type arguments each takes. */
	target: Segment[];
	/** The alias left of a `::` opening the target: `global`, or an extern alias's assembly. */
	qualifier?: string;
	range: Range;
	/** The specifier's first name, where its reference stands. */
	specifierToken: Token;
}

export interface DeclarationMeta {
	declaration: Declaration;
	startOffset: number;
	endOffset: number;
	namespaceName: string;
	/** The types around it, by `segmentKey`. */
	typePath: string;
	parentId?: string;
	typeText?: string;
	/** The declared type's name, name by name with the type arguments each takes. */
	typeSegments?: Segment[];
	/** The alias left of a `::` opening the declared type. */
	typeQualifier?: string;
	inferredType?: string;
	isPartial?: boolean;
	bodyStartOffset?: number;
	bodyEndOffset?: number;
	parameterCount?: number;
	isStatic?: boolean;
	/** Where a local is visible. */
	scope?: Range;
	/** Its own declarator, when one statement declares several: what it holds is its own. */
	declarator?: { startOffset: number; endOffset: number };
	/** A generic type's count of type parameters. */
	arity?: number;
}

export interface CsharpFacts {
	module: string;
	role: FileRole;
	declarations: Declaration[];
	references: Reference[];
	imports: CsharpImport[];
	literals: Literal[];
	comments: CommentSpan[];
	blankLines: number[];
	diagnostics: Diagnostic[];
	metadata: Map<string, DeclarationMeta>;
	namespaceNames: string[];
	/** Attribute name positions, as `positionKey`. */
	attributeNames: Set<string>;
	/** Name positions in a type's base list, as `positionKey`; the type's members are not in scope there. */
	baseListNames: Set<string>;
	/** What stands left of each name right of a member operator, by the name's `positionKey`. */
	receivers: Map<string, Receiver>;
	/** Each name left of a member operator, by `positionKey`, with the type arguments it takes. */
	receiverNames: Map<string, number>;
	/** Each type reference's count of type arguments, by `positionKey`; absent for none. */
	typeArities: Map<string, number>;
}

/**
 * A member access's receiver: `this`, `base`, a simple name, a dotted path of names (the alias of a
 * `::` opening it dropped and kept as its qualifier, so `global::` alone is an empty path), or any
 * other expression. Each name keeps the type arguments it takes.
 */
export type Receiver =
	| { kind: "this" }
	| { kind: "base" }
	| { kind: "name"; name: string; arity: number; range: Range }
	| { kind: "path"; path: Segment[]; qualifier?: string; range: Range }
	| { kind: "other" };

/** One name of a dotted type or namespace name, and the type arguments it takes. */
export interface Segment {
	name: string;
	arity: number;
}

////////////////////////////////
//  Functions & Helpers

export function positionKey(position: Range["start"]): string {
	return `${position.line}:${position.character}`;
}

/** A dotted name as the index keys it: `Outer`1.Inner`, a generic name with its arity. */
export function segmentKey(segments: readonly Segment[]): string {
	return segments
		.map((segment) => (segment.arity === 0 ? segment.name : `${segment.name}\`${segment.arity}`))
		.join(".");
}

////////////////////////////////
//  Interfaces & Types

/** Doc comment or attribute start. */
export interface Leading {
	start: Token;
	/** First attached attribute section's index, where the header starts. */
	attributes: number | undefined;
}

/** A later declarator: the shared lead ends before `from`, its own span starts at `to`. */
export interface HeaderSkip {
	from: number;
	to: number;
}

/** Each type bracket `<` by token index, to the index of the `>` or `>>` closing it. */
export type AnglePairs = ReadonlyMap<number, number>;

/** Type bracket pairs found so far, and the header's folded groups by opener index. */
export interface BracketWalk {
	pairs: Map<number, number>;
	folded: ReadonlyMap<number, number>;
}

export interface AttributeSection {
	open: number;
	close: number;
	/** Assembly and module targets attach to nothing. */
	attached: boolean;
}

/** One of a statement's declarators, by token index, both ends inclusive. */
export interface Declarator {
	declaration: RawDeclaration;
	start: number;
	end: number;
}

/** Where a local is visible, by token index, both ends inclusive; `to` may be set once the scope closes. */
export interface Scope {
	from: number;
	to: number;
}

export interface RawDeclaration {
	kind: SymbolKind;
	qualifier?: string[];
	languageKind?: string | undefined;
	name: string;
	parent?: RawDeclaration | undefined;
	descriptor?: Descriptor;
	localOrdinal?: number;
	startToken: Token;
	endToken: Token;
	selectionStart: Token;
	selectionEnd: Token;
	codeStart: Token;
	visibility: Visibility;
	exported: boolean;
	signature?: string | undefined;
	typeText?: string | undefined;
	typeSegments?: Segment[] | undefined;
	typeQualifier?: string | undefined;
	inferredType?: string | undefined;
	isPartial?: boolean | undefined;
	bodyStartToken?: Token | undefined;
	bodyEndToken?: Token | undefined;
	parameterCount?: number | undefined;
	isStatic?: boolean | undefined;
	memberInsertLine?: number | undefined;
	scope?: Scope | undefined;
	/** Its own declarator, when one statement declares several. */
	declarator?: { start: Token; end: Token } | undefined;
	nameTokenOffsets: number[];
}

export type Visibility = Declaration["visibility"];

export type RawDeclarationInput = Omit<
	RawDeclaration,
	| "descriptor"
	| "localOrdinal"
	| "languageKind"
	| "parent"
	| "signature"
	| "typeText"
	| "typeSegments"
	| "typeQualifier"
	| "inferredType"
	| "bodyStartToken"
	| "bodyEndToken"
	| "parameterCount"
> & {
	languageKind?: string | undefined;
	parent?: RawDeclaration | undefined;
	signature?: string | undefined;
	typeText?: string | undefined;
	typeSegments?: Segment[] | undefined;
	typeQualifier?: string | undefined;
	inferredType?: string | undefined;
	bodyStartToken?: Token | undefined;
	bodyEndToken?: Token | undefined;
	parameterCount?: number | undefined;
};

export interface ModifierInfo {
	index: number;
	start: number;
	modifiers: Set<string>;
}

export interface Boundary {
	kind: "body" | "semicolon";
	index: number;
}

export interface TypeSpan {
	start: number;
	end: number;
}

/** A declared type: as written, and its qualified name and type arguments unless predefined. */
export interface TypeFacts {
	typeText?: string;
	typeSegments?: Segment[];
	typeQualifier?: string;
}

export interface TypeShape {
	/** Past its last token. */
	end: number;
	/** Rightmost simple name; none for tuples. */
	name: Token | undefined;
	/** The qualified name ending at `name`, its `::` qualifier aside, each name with its type arguments. */
	segments: Segment[];
	/** The alias left of a `::` opening it: `global`, or a using or extern alias. */
	qualifier: string | undefined;
	/** The type arguments `name` takes. */
	arity: number;
	/** Tuple element names. */
	elementNames: number[];
}

export interface LeadingType {
	first: number;
	shape: TypeShape;
}
