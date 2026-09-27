// The shapes a C++ parse produces and passes between its layers.

import type {
	CommentSpan,
	Declaration,
	Descriptor,
	Diagnostic,
	FileRole,
	Import,
	Literal,
	Metrics,
	Range,
	Reference,
	TypeInfo,
	UnknownReason,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export type Visibility = Declaration["visibility"];

////////////////////////////////
//  Constants

export const LANGUAGE = "cpp";

////////////////////////////////
//  Interfaces & Types

export interface ImportFact {
	imported: Import;
	quoted: boolean;
	tokenStart: number;
	tokenEnd: number;
}

export interface CppDeclarationRecord {
	declaration: Declaration;
	parent: CppDeclarationRecord | null;
	own: Descriptor;
	tokenStart: number;
	tokenEnd: number;
	nameTokenStart: number;
	nameTokenEnd: number;
	templateDependent: boolean;
	parameterNames: Set<string>;
	hasBody: boolean;
}

export type DraftInput = Omit<
	DraftRecord,
	"languageKind" | "signature" | "metrics" | "type" | "parameterNames" | "parameterSignature" | "hasBody"
> & {
	languageKind?: string | undefined;
	signature?: string | undefined;
	metrics?: Metrics | undefined;
	type?: DraftType | undefined;
	parameterNames?: Set<string>;
	parameterSignature?: string;
	hasBody?: boolean;
};

export interface CppReferenceRecord {
	name: string;
	range: Range;
	role: Reference["role"];
	tokenIndex: number;
	from: CppDeclarationRecord | null;
	qualifiedPath: string[];
	qualified: boolean;
	templateDependent: boolean;
}

export interface CppFacts {
	declarations: Declaration[];
	references: CppReferenceRecord[];
	imports: Import[];
	literals: Literal[];
	comments: CommentSpan[];
	blankLines: number[];
	diagnostics: Diagnostic[];
	role: FileRole;
	records: CppDeclarationRecord[];
	importFacts: ImportFact[];
	typeAnswers: Map<string, TypeInfo>;
}

export type DraftType =
	| { status: "known"; display: string }
	| { status: "inferred"; display: string; basis: string }
	| { status: "unknown"; reason: UnknownReason; detail: string };

export interface DraftRecord {
	parent: DraftRecord | null;
	qualifier?: Descriptor[];
	qualifierNames?: string[];
	own: Descriptor;
	kind: Declaration["kind"];
	name: string;
	visibility: Visibility;
	languageKind: string | undefined;
	exported: boolean;
	startIndex: number;
	endIndex: number;
	nameStartIndex: number;
	nameEndIndex: number;
	signature: string | undefined;
	metrics: Metrics | undefined;
	type: DraftType | undefined;
	templateDependent: boolean;
	parameterNames: Set<string>;
	parameterSignature: string | undefined;
	hasBody: boolean;
	memberInsertLine?: number | undefined;
}

export interface TemplateParameter {
	name: string;
	nameStartIndex: number;
	nameEndIndex: number;
	startIndex: number;
	endIndex: number;
	typeText: string;
}

export interface TemplateInfo {
	startIndex: number;
	endIndex: number;
	parameters: TemplateParameter[];
}

export interface Prefix {
	startIndex: number;
	keywordIndex: number;
	template: TemplateInfo | null;
	explicitInstantiation: boolean;
	modifiers: Set<string>;
	exported: boolean;
}

export interface Scope {
	parent: DraftRecord | null;
	kind: "module" | "namespace" | "class" | "function" | "enum";
	defaultVisibility: Visibility;
	templateDependent: boolean;
}
