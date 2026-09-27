// Owns shared parser data shapes.

import type { Metrics, Position, Range } from "@nyaa-lexicon/protocol";

//////// Types

export type DescriptorKind = "namespace" | "type" | "term" | "method" | "parameter" | "typeParameter" | "meta";

export interface Descriptor {
	kind: DescriptorKind;
	name: string;
}

export type DeclarationKind = "class" | "method" | "property" | "event" | "enum" | "function" | "variable" | "constant";

export type Visibility = "public" | "private" | "local" | "fileLocal";

export interface DeclarationFact {
	symbolId: string;
	kind: DeclarationKind;
	languageKind?: string;
	name: string;
	range: Range;
	selectionRange: Range;
	visibility: Visibility;
	exported?: boolean;
	signature?: string;
	containerId?: string;
	memberInsertLine?: number;
	metrics?: Metrics;
}

export interface SourceLine {
	line: number;
	text: string;
	code: string;
	/** Leading blanks' width, a tab counting four. */
	indent: number;
	/** Content end, before a carriage return. */
	end: number;
	hasString: boolean;
	endsInString: boolean;
}

export type StringQuote = "'" | '"';

/** StringName, NodePath and raw. */
export type StringPrefix = "" | "&" | "^" | "r";

/** A terminated string, prefix and quotes included. */
export interface StringSpan {
	start: Position;
	end: Position;
	prefix: StringPrefix;
	quote: StringQuote;
	triple: boolean;
}

export interface ReferenceToken {
	kind: "identifier" | "symbol" | "newline" | "string" | "number";
	/** Source text; a string includes its prefix and quotes. */
	value: string;
	line: number;
	character: number;
	/** Strings only. */
	string?: StringSpan;
}

export interface ReferenceBlock {
	startLine: number;
	endLine: number;
	indent: number;
	containerId: string;
	functionId?: string;
}

export interface RawLine {
	line: number;
	text: string;
}

export interface Token {
	name: string;
	start: number;
}

export type ParsedKeyword = "class_name" | "extends" | "func" | "var" | "const" | "signal" | "enum" | "class" | "for";

export interface ParsedLine {
	keyword: ParsedKeyword;
	name: Token | null;
	static: boolean;
	annotated: boolean;
	/** Header's start column: its first owned annotation, or the keyword. */
	head: number;
	/** Owned annotation names on this line. */
	annotations: string[];
	/** Nothing but indentation precedes `head`. */
	leading: boolean;
}

export interface Scope {
	indent: number;
	descriptors: Descriptor[];
	containerId: string;
	functionScope: boolean;
}

export interface ActiveEnum {
	indent: number;
	descriptors: Descriptor[];
	containerId: string;
	names: Set<string>;
}

export interface ActiveFunctionHeader {
	indent: number;
	scope: Scope;
	declaration: DeclarationFact;
	start: SourceLine;
	/** The block colon's line. */
	endLine: number;
}

export interface ComposeInput {
	language: string;
	module: string;
	descriptors: Descriptor[];
}

export type ComposeSymbolId = (input: ComposeInput) => string;
