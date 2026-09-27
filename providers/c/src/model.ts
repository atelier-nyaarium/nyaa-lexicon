// The shapes a C parse produces and passes between its layers.

import type {
	CommentSpan,
	Declaration,
	Descriptor,
	Diagnostic,
	ImportedName,
	Literal,
	Metrics,
	Range,
	Reference,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Constants

export const LANGUAGE = "c";

////////////////////////////////
//  Interfaces & Types

export type DescriptorPath = Descriptor[];

export interface CImportFact {
	specifier: string;
	imported: ImportedName[];
	reExport: boolean;
	kind: "quoted" | "angle";
	range?: Range;
}

export interface CTypeAnswer {
	display: string;
	typeName?: string;
}

export interface CDeclaration extends Declaration {
	descriptorPath: DescriptorPath;
	startOffset: number;
	endOffset: number;
	selectionIndex: number;
	conditionalKey: string;
	conditionalGroup: string;
	isDefinition?: boolean;
	typeText?: string;
	typeRange?: Range;
}

export interface CReference extends Reference {
	tokenIndex: number;
	qualified: boolean;
}

export interface ParsedCFile {
	module: string;
	declarations: CDeclaration[];
	declarationsByName: Map<string, CDeclaration[]>;
	declarationsById: Map<string, CDeclaration>;
	references: CReference[];
	imports: CImportFact[];
	literals: Literal[];
	comments: CommentSpan[];
	blankLines: number[];
	diagnostics: Diagnostic[];
	typeAnswers: Map<string, CTypeAnswer>;
}

export interface Directive {
	start: number;
	end: number;
	keyword: string;
	keywordIndex: number;
}

export interface ConditionalFrame {
	id: number;
	branch: number;
}

export interface DelimiterEntry {
	value: string;
	index: number;
	aliases: number[];
}

export interface AggregateInfo {
	keyword: "struct" | "union" | "enum";
	keywordIndex: number;
	tagIndex: number;
	bodyOpen: number;
	bodyClose: number;
}

export interface DeclaratorName {
	nameIndex: number;
	nameEndIndex: number;
	name: string;
	typeStart: number;
	typeEnd: number;
	typeText: string;
	typeName?: string;
	/** Where the first declarator begins. */
	listStart: number;
	segmentStart: number;
	/** Exclusive: its `,` or the end. */
	segmentEnd: number;
}

export interface FunctionCandidate {
	nameIndex: number;
	nameEndIndex: number;
	name: string;
	open: number;
	close: number;
}

export interface Statement {
	start: number;
	last: number;
	next: number;
	terminator: "semicolon" | "body" | "eof";
	bodyOpen?: number;
	bodyClose?: number;
}

export interface ScopeContext {
	kind: "file" | "function";
	parentPath: DescriptorPath;
	containerId?: string;
}

export interface Candidate {
	name: string;
	declarationKind: Declaration["kind"];
	descriptorKind: Descriptor["kind"];
	languageKind?: string;
	rangeStartIndex: number;
	rangeEndIndex: number;
	selectionIndex: number;
	selectionEndIndex?: number;
	parentPath: DescriptorPath;
	visibility: Declaration["visibility"];
	exported?: boolean;
	signature?: string | undefined;
	metrics?: Metrics;
	typeText?: string;
	typeStartIndex?: number;
	typeEndIndex?: number;
	typeName?: string;
	conditionalKey: string;
	conditionalGroup: string;
	isDefinition?: boolean;
}

export interface QualifiedName {
	name: string;
	startIndex: number;
	endIndex: number;
	identifierIndices: number[];
}

export interface NumericValue {
	valid: boolean;
	number?: number;
}
