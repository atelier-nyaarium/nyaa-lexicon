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

/** The type a declaration names: a tag after `struct`, `union` or `enum`, or an ordinary name. */
export interface TypeName {
	name: string;
	tag: boolean;
}

export interface CTypeAnswer {
	display: string;
	typeName?: TypeName;
	/** The declarator holding its anonymous body's fields. */
	fieldsOf?: string;
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
	/** Where a block's name is in scope; a file's name has none. */
	scope?: BlockScope;
	/** Its body's braces, by offset: what it contains, as its initializer is not. */
	body?: { start: number; end: number };
}

/** A block, by token index, and where one of its names comes into scope. */
export interface BlockScope {
	/** The block's opening token; a block nested in another opens after it. */
	open: number;
	/** The block's last token. */
	close: number;
	/** Just past the name's declarator, where C puts its scope's start. */
	from: number;
}

export interface CReference extends Reference {
	tokenIndex: number;
	qualified: boolean;
	/** A name after `struct`, `union` or `enum`. */
	tag?: boolean;
	/** A name after `.` or `->`. */
	member?: boolean;
	/** The token of a member's receiver, when that is a plain name. */
	receiver?: number;
}

export interface ParsedCFile {
	module: string;
	declarations: CDeclaration[];
	declarationsByName: Map<string, CDeclaration[]>;
	declarationsById: Map<string, CDeclaration>;
	/** By `scopeKey`: each name's declarations directly in one scope. */
	declarationsByScope: Map<string, CDeclaration[]>;
	/** Each container's declarations. */
	childrenById: Map<string, CDeclaration[]>;
	references: CReference[];
	/** The first reference each token starts. */
	referencesByToken: Map<number, CReference>;
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
	/** The keys of the groups around it. */
	outerKey: string;
	outerGroup: string;
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
	/** The tag's last token; past `tagIndex` for a dotted name. */
	tagEndIndex: number;
	bodyOpen: number;
	bodyClose: number;
}

/** A declaration's specifiers, up to its first declarator. */
export interface DeclarationHead {
	first: number;
	/** Where the first declarator begins. */
	listStart: number;
	aggregate?: AggregateInfo;
	/** Storage classes, qualifiers and keyword types among them. */
	specifiers: ReadonlySet<string>;
	typedef: boolean;
}

export interface FunctionCandidate {
	nameIndex: number;
	nameEndIndex: number;
	name: string;
	open: number;
	close: number;
}

/** Where a search of one statement's head for a function stopped, so a later `{` resumes it. */
export interface CandidateScan {
	start: number;
	/** The next token to read. */
	index: number;
	parentheses: number;
	brackets: number;
	/** Every delimiter open, for whether an `=` sits at the top level. */
	open: { parentheses: number; brackets: number; braces: number };
	/** A top-level `=` came before: what follows is an initializer, not a parameter list. */
	assigned: boolean;
}

export interface DeclaratorName {
	nameIndex: number;
	nameEndIndex: number;
	name: string;
	typeStart: number;
	typeEnd: number;
	typeText: string;
	typeName?: TypeName;
	/** Where the first declarator begins. */
	listStart: number;
	segmentStart: number;
	/** Exclusive: its `,` or the end. */
	segmentEnd: number;
	/** Its parameter list, when it declares a function. */
	function?: FunctionCandidate;
}

export interface Statement {
	start: number;
	last: number;
	next: number;
	/** `block` is a compound statement; `invocation` a macro call with no semicolon. */
	terminator: "semicolon" | "body" | "block" | "invocation" | "eof";
	bodyOpen?: number;
	bodyClose?: number;
	/** Where an old-style definition's parameter declarations begin. */
	parameterDeclarations?: number;
}

export interface ScopeContext {
	/** `member` is an aggregate's body. */
	kind: "file" | "function" | "member";
	parentPath: DescriptorPath;
	containerId?: string;
	/** The innermost block a function's statement sits in, by token index. */
	block?: { open: number; close: number };
	/** Inside a function, so a tag or enumerator declared here, even in an aggregate's body, is local. */
	local?: true;
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
	typeName?: TypeName;
	conditionalKey: string;
	conditionalGroup: string;
	isDefinition?: boolean;
	scope?: BlockScope;
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
