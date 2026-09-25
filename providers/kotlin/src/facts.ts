import type {
	CommentSpan,
	Declaration,
	Diagnostic,
	FileRole,
	ImportedName,
	Literal,
	Range,
	Reference,
	TypeInfo,
} from "@nyaa-lexicon/protocol";
import type { SyntaxNode } from "./tree.js";

export const LANGUAGE = "kotlin";

export const REFERENCE_ROLES = ["call", "read", "write", "import", "extends", "instantiate", "typeUse"] as const;

export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

export type { CommentSpan };

export interface TypeFact {
	symbolId: string;
	answer: TypeInfo;
	annotationRange?: Range;
}

export interface ImportInfo {
	specifier: string;
	imported: ImportedName[];
	reExport: boolean;
	star: boolean;
	importedName?: string;
	localName?: string;
}

/** Dotted segments of a type as written, type arguments dropped. */
export type TypePath = string[];

/** What stands left of a member name. */
export type Receiver =
	/** `callable`: `Type::member`, which reaches instance members. */
	| { kind: "name"; index: number; callable?: boolean }
	| { kind: "this"; label?: string }
	| { kind: "super" }
	| { kind: "expression" };

export interface LocalName {
	declaration: Declaration;
	/** Offset from which a use sees it. */
	from: number;
	/** A constructor parameter: initializers only. */
	initializerOnly?: boolean;
}

export type FrameReceiver =
	/** `nested`: no outer instance past it. */
	| { kind: "class"; classId: string; label: string; nested: boolean }
	| { kind: "extension"; declarationId: string; label: string }
	| { kind: "anonymous"; supertypes: TypePath[] };

/** Per node: what it declares, whether it owns the uses inside, and which identifiers name one. */
export interface DeclaredNodes {
	declarations: ReadonlyMap<SyntaxNode, Declaration>;
	owners: ReadonlySet<SyntaxNode>;
	names: ReadonlySet<SyntaxNode>;
}

/** One lexical scope; a use walks `parent` outward. */
export interface Frame {
	parent: Frame | undefined;
	names?: Map<string, LocalName[]>;
	receiver?: FrameReceiver;
	/** A class member body: constructor parameters end here. */
	member?: boolean;
	/** An arrowless lambda binds `it`. */
	implicitIt?: boolean;
	/** An accessor binds `field`. */
	field?: boolean;
}

export interface ReferenceInfo {
	reference: Reference;
	/** Position in `references`, unique per role. */
	index: number;
	/** Source offset, for declaration order. */
	offset: number;
	frame?: Frame;
	importInfo?: ImportInfo;
	receiver?: Receiver;
}

/** Declaration headers lookup reads, kept at outline depth. */
export interface HeaderFacts {
	/** Class id to its supertypes. */
	supertypes: Map<string, TypePath[]>;
	/** Extension declaration id to its receiver type. */
	receiverTypes: Map<string, TypePath>;
}

export interface KotlinFile extends HeaderFacts {
	module: string;
	packageName?: string;
	declarations: Declaration[];
	references: ReferenceInfo[];
	imports: ImportInfo[];
	literals: Literal[];
	comments: CommentSpan[];
	typeFacts: TypeFact[];
	diagnostics: Diagnostic[];
	role: FileRole;
}
