// The facts one Python file yields, before symbol ids are composed and imports bound across files.

import type {
	CommentSpan,
	Declaration,
	Descriptor,
	Diagnostic,
	FileRole,
	ImportKind,
	Literal,
	Reference,
	Selector,
	UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { RawHeader } from "../header.js";

////////////////////////////////
//  Interfaces & Types

export type Range = Declaration["range"];
export type Position = Range["start"];
export type RawDescriptor = Pick<Descriptor, "kind" | "name" | "disambiguator">;

export interface RawDeclaration {
	name: string;
	kind: Declaration["kind"];
	descriptorPath: RawDescriptor[];
	containerPath: RawDescriptor[];
	range: Range;
	selectionRange: Range;
	visibility: Declaration["visibility"];
	exported: boolean;
	header?: RawHeader;
	memberInsertLine?: number;
	metrics?: RawMetrics;
	typeText?: string;
	typeForwardReference?: boolean;
	typeDescriptorPath?: RawDescriptor[];
	typeReference?: RawTypeReference;
}

export interface RawMetrics {
	lines: number;
	parameters?: number;
	nesting?: number;
	branches?: number;
}

export interface RawTypeReference {
	name: string;
	range: Range;
	role: "call" | "typeUse";
}

export interface RawTypeAnnotation {
	anchorRange: Range;
	annotationRange: Range;
	text: string;
	forwardReference: boolean;
	typeDescriptorPath?: RawDescriptor[];
	typeReference?: RawTypeReference;
}

export interface RawInferredType {
	descriptorPath: RawDescriptor[];
	display?: string;
	basis?: string;
	typeDescriptorPath?: RawDescriptor[];
	reason?: UnknownReason;
	detail?: string;
}

export interface RawLiteral {
	kind: Literal["kind"];
	value: string;
	number?: number;
	range: Range;
	containerPath?: RawDescriptor[];
}

/** One transfer an import statement makes. */
export interface RawImportEdge {
	kind: Extract<ImportKind, "named" | "namespace" | "wildcard" | "sideEffect">;
	span: Range;
	name?: string;
	range?: Range;
	local?: string;
	localRange?: Range;
	selector?: Selector;
	/** Written in a control block, so it may not run. */
	conditional: boolean;
	/** At module level, where its binding is a module global. */
	moduleLevel: boolean;
}

export interface RawImport {
	specifier: string;
	edges: RawImportEdge[];
	/** A `from` statement's load of its module, on the module's name. */
	load?: RawImportEdge;
}

export interface RawImportBinding {
	/** As the statement writes it. */
	specifier: string;
	/** The specifier the local binding lands on: `a` for `import a.b`. */
	lands: string;
	localName: string;
	importedName: string | null;
	scopePath: RawDescriptor[];
	conditional: boolean;
	star: boolean;
	/** The edge it binds through. */
	span: Range;
	/** The side-effect edge loading each submodule past `lands`: `a.b`, then `a.b.c`, for `import a.b.c`. */
	loads: Range[];
}

export type RawExportTarget =
	| { kind: "symbol"; descriptorPath: RawDescriptor[] }
	| { kind: "import"; span: Range }
	| { kind: "unknown"; reason: UnknownReason };

export interface RawExport {
	form: "direct" | "forward" | "star";
	span: Range;
	name?: string;
	range?: Range;
	sourceRange?: Range;
	target: RawExportTarget;
	conditional: boolean;
}

export interface RawAllListEntry {
	name: string;
	range: Range;
	/** What the entry names unless one of `stars` brings it. */
	target: RawExportTarget;
	/** Module-level stars written after the entry's binder, any of which may bind it instead. */
	stars?: Range[];
}

export type RawAllList =
	| { state: "absent" }
	| { state: "static"; entries: RawAllListEntry[] }
	| { state: "dynamic"; reason: UnknownReason };

export interface RawImportAlias {
	name: string;
	localName: string;
	range: Range;
	importedRange?: Range | null;
	localRange?: Range | null;
	star: boolean;
}

export interface RawImportStatement {
	kind: "import" | "from";
	specifier: string;
	range: Range;
	/** Module name tokens after `from`. */
	moduleRange: Range | null;
	/** Indent if the import starts its line; null otherwise. */
	indent: string | null;
	aliases: RawImportAlias[];
}

export type ScopeKind = "module" | "class" | "function";

export interface RawScopeInfo {
	scopePath: RawDescriptor[];
	kind: ScopeKind;
	locals: string[];
	parameters: string[];
	globals: string[];
	nonlocals: string[];
	conditional: string[];
	dynamic: boolean;
}

export type RawReferenceRole = Reference["role"];

export interface RawReference {
	name: string;
	range: Range;
	role: RawReferenceRole;
	qualified: boolean;
	/** Where the name resolves, which a header takes from outside its declaration. */
	scopePath: RawDescriptor[];
	/** Declaration the use is written in, header included. */
	ownerPath: RawDescriptor[];
	binding: RawBinding;
	/** A lambda's or comprehension's own name, which no import reaches. */
	nestedLocal?: boolean;
	/** A member's receiver when it is a name or a dotted chain: `a` and path `["b"]` in `a.b.N`. */
	receiver?: { name: string; binding: RawBinding; path: string[]; nestedLocal: boolean };
}

export type UnboundReason = "NotImplemented" | "NotIndexed" | "Ambiguous" | "RuntimeConstructed";

export type RawBinding =
	| { status: "bound"; descriptorPath: RawDescriptor[] }
	| { status: "unbound"; reason: UnboundReason; detail: string };

export interface RawFacts {
	declarations: RawDeclaration[];
	references: RawReference[];
	role: FileRole;
	imports: RawImport[];
	/** Null when the file did not parse, which is unknown coverage. */
	exports: RawExport[] | null;
	allList: RawAllList | null;
	importStatements: RawImportStatement[];
	/** Point after the shebang, module docstring and future imports. */
	prologueEnd: Position | null;
	importBindings: RawImportBinding[];
	scopeInfos: RawScopeInfo[];
	typeAnnotations: RawTypeAnnotation[];
	inferredTypes: RawInferredType[];
	literals: RawLiteral[];
	comments: CommentSpan[];
	/** Null when lexing stopped short. */
	blankLines: number[] | null;
	diagnostics: Diagnostic[];
}
