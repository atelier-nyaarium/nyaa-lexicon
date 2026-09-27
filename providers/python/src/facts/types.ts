// The facts one Python file yields, before symbol ids are composed and imports bound across files.

import type {
	CommentSpan,
	Declaration,
	Descriptor,
	Diagnostic,
	FileRole,
	ImportedName,
	Literal,
	Reference,
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

export interface RawImport {
	specifier: string;
	imported: ImportedName[];
	reExport: boolean;
}

export interface RawImportBinding {
	specifier: string;
	localName: string;
	importedName: string | null;
	scopePath: RawDescriptor[];
	conditional: boolean;
	star: boolean;
}

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
	reExport: boolean;
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
