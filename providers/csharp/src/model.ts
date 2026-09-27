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
	range: Range;
	specifierRange: Range;
}

export interface DeclarationMeta {
	declaration: Declaration;
	startOffset: number;
	endOffset: number;
	namespaceName: string;
	typePath: string;
	parentId?: string;
	typeText?: string;
	typeName?: string;
	inferredType?: string;
	isPartial?: boolean;
	bodyStartOffset?: number;
	bodyEndOffset?: number;
	parameterCount?: number;
	isStatic?: boolean;
}

export interface CsharpFacts {
	module: string;
	text: string;
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
}

////////////////////////////////
//  Functions & Helpers

export function positionKey(position: Range["start"]): string {
	return `${position.line}:${position.character}`;
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
	typeName?: string | undefined;
	inferredType?: string | undefined;
	isPartial?: boolean | undefined;
	bodyStartToken?: Token | undefined;
	bodyEndToken?: Token | undefined;
	parameterCount?: number | undefined;
	isStatic?: boolean | undefined;
	memberInsertLine?: number | undefined;
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
	| "typeName"
	| "inferredType"
	| "bodyStartToken"
	| "bodyEndToken"
	| "parameterCount"
> & {
	languageKind?: string | undefined;
	parent?: RawDeclaration | undefined;
	signature?: string | undefined;
	typeText?: string | undefined;
	typeName?: string | undefined;
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

/** Type read from tokens. */
export interface TypeShape {
	/** Past its last token. */
	end: number;
	/** Rightmost simple name; none for tuples. */
	name: Token | undefined;
	/** Tuple element names. */
	elementNames: number[];
}

export interface LeadingType {
	first: number;
	shape: TypeShape;
}
