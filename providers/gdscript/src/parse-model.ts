// Owns shared parser data shapes.

import type { Metrics, Range } from "@nyaa-lexicon/protocol";

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
	metrics?: Metrics;
}

export interface SourceLine {
	line: number;
	text: string;
	code: string;
	hasString: boolean;
	stringStarts: number[];
	endsInString: boolean;
}

export interface ReferenceToken {
	kind: "identifier" | "symbol" | "newline";
	value: string;
	line: number;
	character: number;
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
	lines: SourceLine[];
}

export interface ComposeInput {
	language: string;
	module: string;
	descriptors: Descriptor[];
}

export type ComposeSymbolId = (input: ComposeInput) => string;
