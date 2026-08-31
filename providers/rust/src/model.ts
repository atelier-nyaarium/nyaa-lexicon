import type {
	CommentSpan,
	Declaration,
	Diagnostic,
	Import,
	ImportedName,
	Literal,
	Position,
	Range,
	Reference,
	UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { CursorSpan } from "./cursor.js";
import type { RustToken } from "./tokens.js";

export type RustDescriptor = {
	kind: "namespace" | "type" | "term" | "method" | "parameter" | "typeParameter" | "meta";
	name: string;
	disambiguator?: string;
};

/** Taken from the wire shape, so the span cannot drift from the protocol. */
export type { CommentSpan };

export interface RawDeclaration {
	declaration: Declaration;
	startOffset: number;
	endOffset: number;
	nameToken: RustToken;
	descriptorPath: RustDescriptor[];
	containerPath: RustDescriptor[];
	typeName?: string;
	typeDisplay?: string;
	typeRange?: Range;
	functionId?: string;
	localOrdinal?: number;
}

export interface TypeAnswer {
	status: "known" | "inferred" | "unknown";
	display?: string;
	basis?: string;
	reason?: UnknownReason;
	detail?: string;
	typeName?: string;
}

export interface ImportBinding {
	specifier: string;
	path: string[];
	sourceName: string | null;
	localName: string | null;
	glob: boolean;
	sourceRange?: Range;
	localRange?: Range;
	containerId?: string;
	ambiguous: boolean;
}

export interface RawReference {
	reference: Reference;
	token: RustToken;
	containerId?: string;
	importBinding?: ImportBinding;
	path: string[];
}

export interface ParsedFile {
	module: string;
	text: string;
	declarations: Declaration[];
	references: Reference[];
	imports: Import[];
	literals: Literal[];
	comments: CommentSpan[];
	diagnostics: Diagnostic[];
	rawDeclarations: RawDeclaration[];
	rawReferences: RawReference[];
	importBindings: ImportBinding[];
	typeAnswers: Map<string, TypeAnswer>;
	lineTokens: Map<number, RustToken[]>;
}

export function rangeOf(span: CursorSpan): Range {
	return { start: span.start, end: span.end };
}

export function tokenRange(token: RustToken): Range {
	return { start: token.start, end: token.end };
}

export function pointRange(position: Position): Range {
	return { start: position, end: { line: position.line, character: position.character + 1 } };
}
