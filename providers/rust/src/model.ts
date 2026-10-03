import type {
	CommentSpan,
	Declaration,
	Diagnostic,
	Export,
	Import,
	Literal,
	OffsetRange,
	Range,
	Reference,
	ScopeContribution,
	UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { RustToken } from "./tokens.js";

export type RustDescriptor = {
	kind: "namespace" | "type" | "term" | "method" | "parameter" | "typeParameter" | "meta";
	name: string;
	disambiguator?: string;
	occurrence?: number;
};

/** Taken from the wire shape, so the span cannot drift from the protocol. */
export type { CommentSpan };

export interface RawDeclaration {
	declaration: Declaration;
	startOffset: number;
	endOffset: number;
	nameToken: RustToken;
	descriptorPath: RustDescriptor[];
	/** The path it hangs from: an impl's type for the impl's items, else its container's. */
	containerPath: RustDescriptor[];
	/** An impl's: the type path its items hang from. */
	memberPath?: RustDescriptor[];
	typeName?: string;
	typeDisplay?: string;
	/** Token indices of a declared type, end exclusive. */
	typeSpan?: { start: number; end: number };
	localOrdinal?: number;
	/** Offsets where a local's name refers to it; absent for items and function parameters. */
	scope?: OffsetRange;
	/** An item in a body: the block it is visible in. */
	block?: OffsetRange;
	/** The written type path of an annotated binding, a function's return, an alias's type or an impl's target. */
	valueType?: readonly string[];
	/** An unannotated local's initializer that is one call: its callee's offset, whose declared return is its type. */
	initializer?: number;
	generics?: Generics;
	/** A `mod name;` declaration: the file it loads, by its `path` attribute when one is written. */
	fileModule?: { path?: string };
	/** An impl's: the last segment of its target's path, through this file's imports. */
	targetName?: string;
}

/** The generic parameters an item declares, lifetimes aside, each to its bounds' written trait paths. */
export type Generics = ReadonlyMap<string, readonly (readonly string[])[]>;

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
	/** The token naming the source. */
	sourceIndex?: number;
	localRange?: Range;
	containerId?: string;
	/** A `use` in a body: the block it is visible in. */
	block?: OffsetRange;
	/** `use ::name`: the path starts at the crates, never a local name. */
	absolute?: boolean;
	ambiguous: boolean;
}

export interface RawReference {
	reference: Reference;
	token: RustToken;
	containerId?: string;
	importBinding?: ImportBinding;
	path: string[];
	/** A `.name` access or a field label, which only a type's member answers. */
	member?: boolean;
	/** A `.name` access's receiver, when it is one name. */
	receiver?: RustToken;
	/** A path segment another follows, which names a module or type. */
	qualifier?: boolean;
	/** A path after a leading `::`, whose first segment names a crate. */
	absolute?: boolean;
}

export interface ParsedFile {
	module: string;
	text: string;
	declarations: Declaration[];
	references: Reference[];
	imports: Import[];
	/** Absent in a failed parse. */
	exports?: Export[];
	scopeContributions: ScopeContribution[];
	literals: Literal[];
	comments: CommentSpan[];
	/** Absent in an outline or a failed parse. */
	blankLines?: number[];
	diagnostics: Diagnostic[];
	rawDeclarations: RawDeclaration[];
	/** The declarations by name, block-scoped locals aside, then all by id. */
	byName: ReadonlyMap<string, readonly RawDeclaration[]>;
	byId: ReadonlyMap<string, RawDeclaration>;
	/** Block-scoped locals by name, in the order their scopes start. */
	locals: ReadonlyMap<string, readonly RawDeclaration[]>;
	/** Its impl blocks. */
	impls: readonly RawDeclaration[];
	rawReferences: RawReference[];
	/** Each reference by the offset its name starts at. */
	referenceAt: ReadonlyMap<number, RawReference>;
	importBindings: ImportBinding[];
	typeAnswers: Map<string, TypeAnswer>;
}
