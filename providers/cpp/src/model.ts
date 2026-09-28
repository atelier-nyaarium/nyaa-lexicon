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
import type { ScopeIndex } from "./scopes.js";
import type { Alternative } from "./tokens.js";

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
	module: string;
	parent: CppDeclarationRecord | null;
	own: Descriptor;
	/** Its id's descriptor names, outermost first. */
	readonly names: readonly string[];
	tokenStart: number;
	tokenEnd: number;
	nameTokenStart: number;
	templateDependent: boolean;
	hasBody: boolean;
	/** A body's local: the token ending the block or statement it is visible in, from its name on. */
	visibleEnd?: number;
	/** Where a local's visibility starts when not at its name: an init-capture's lambda body. */
	visibleFrom?: number;
	/** Where the name is first declared, a prototype's or a forward declaration's name included. */
	declaredAt: number;
	/** Another opening or declaration of one it merged into, held for lookup, never reported. */
	merged: boolean;
	/** The innermost `#if` alternative it is declared in. */
	alternative?: Alternative;
	/** A class's `{`, where its base clause ends and its members start. */
	bodyStart?: number;
	/** A class's base names, each a reference in its base clause. */
	baseTokens?: readonly number[];
	/** Its type's name, a reference: a variable's, a function's return, an alias's target. */
	typeRef?: number;
	typeShape?: TypeShape;
	/** A namespace alias's target, the last name it writes: a reference. */
	aliasOf?: number;
}

/** How far a declared type is from its named class: pointers and array dimensions. */
export interface TypeShape {
	pointers: number;
	arrays: number;
}

/** What a member access reaches through: a name, a call's result, a subscript's element, or `this`. */
export interface Receiver {
	kind: "name" | "call" | "subscript" | "this";
	/** The receiver's name, the callee's name, or the subscripted name; -1 for `this`. */
	token: number;
	arrow: boolean;
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
	qualified: boolean;
	/** Followed by `::`, so it names a namespace or a type. */
	scope: boolean;
	/** The name before its `::`, whose scope it is looked up in. */
	qualifierToken?: number;
	/** `::name`, looked up at file scope. */
	global: boolean;
	/** What a `.` or `->` before it reaches through. */
	receiver?: Receiver;
	/** Followed by template arguments. */
	templated: boolean;
	/** The template-id as written, `Box<int>`, which an explicit specialization is named by. */
	written?: string;
	/** The declaration whose earlier declaration this name is: a prototype, a forward declaration. */
	prototypeOf?: CppDeclarationRecord;
	/** Inside a template, where a name found nowhere may come with its arguments. */
	inTemplate: boolean;
	/** The innermost `#if` alternative it stands in, which sees no other branch's declarations. */
	alternative?: Alternative;
	/** On a directive's line, as in a macro body, whose names mean what they do where it expands. */
	macro: boolean;
}

export interface CppFacts extends ScopeIndex {
	declarations: Declaration[];
	references: CppReferenceRecord[];
	imports: Import[];
	literals: Literal[];
	comments: CommentSpan[];
	blankLines: number[];
	diagnostics: Diagnostic[];
	role: FileRole;
	/** Using-directives and using-declarations by the id of the scope they stand in. */
	usingsByScope: Map<string, CppUsing[]>;
	referencesByToken: Map<number, CppReferenceRecord>;
	/** Reported declarations by their name's first token. */
	declarationsByToken: Map<number, CppDeclarationRecord>;
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
	/** The last token counts its first character only: a `>>` closing a default's list and the head. */
	splitEnd?: boolean;
	/** A body's local: the token ending the block or statement it is visible in. */
	visibleEnd?: number;
	/** Where a local's visibility starts when not at its name. */
	visibleFrom?: number;
	/** Where the name is first declared, when earlier than `nameStartIndex`. */
	declaredAt?: number;
	/** `extern` without an initializer: a declaration some definition completes. */
	declarationOnly?: boolean;
	/** The declaration it merged into: another opening of a namespace, or a class's definition. */
	mergedInto?: DraftRecord;
	bodyStart?: number;
	/** A class's base names, each a reference in its base clause. */
	baseTokens?: number[];
	typeRef?: number;
	typeShape?: TypeShape;
	/** A namespace alias's target, the last name it writes: a reference. */
	aliasOf?: number;
}

/** `using namespace a::b;`, or with `declaration`, `using a::b;`: names a scope sees from `at` on. */
export interface UsingDraft {
	scope: DraftRecord | null;
	at: number;
	/** Where it stops applying: its block's end, or undefined for a namespace's or the file's. */
	end?: number;
	/** The last name it writes, a reference: the namespace, or the name declared. */
	nameToken: number;
	declaration: boolean;
	alternative?: Alternative;
}

/** A using-directive or using-declaration by the id of the scope it stands in, `""` at file scope. */
export interface CppUsing extends Omit<UsingDraft, "scope"> {
	scopeId: string;
}

export interface TemplateParameter {
	name: string;
	nameStartIndex: number;
	nameEndIndex: number;
	startIndex: number;
	endIndex: number;
	typeText: string;
	splitEnd?: boolean;
}

export interface TemplateInfo {
	startIndex: number;
	endIndex: number;
	parameters: TemplateParameter[];
}

export interface Prefix {
	startIndex: number;
	keywordIndex: number;
	/** The last template head, nearest the declaration. */
	template: TemplateInfo | null;
	/** Every template head, outermost first: enclosing class templates' heads, then its own. */
	heads: TemplateInfo[];
	explicitInstantiation: boolean;
	modifiers: Set<string>;
	exported: boolean;
}

export interface Scope {
	parent: DraftRecord | null;
	kind: "module" | "namespace" | "class" | "function" | "enum";
	defaultVisibility: Visibility;
	templateDependent: boolean;
	/** In a body: the token ending the block or statement its declarations are visible in. */
	blockEnd?: number;
}
