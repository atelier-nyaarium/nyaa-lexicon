import type { ChainAnswer } from "@nyaa-lexicon/client";
import type {
	CommentsResult,
	ContentTotals,
	DescribeResult,
	DocsResult,
	FileHistory,
	FileNotes,
	IndexStatus,
	LiteralsResult,
	MovePlan,
	ReferencesResult,
	RenamePlan,
	SymbolSource,
	SymbolSummary,
	TransactionStatus,
} from "@nyaa-lexicon/core";
import type {
	CoChangedWithResult,
	CommitsMentioningResult,
	EntryHow,
	FindImportsResult,
	ImportResolution,
	InsertOutcome,
	ModuleStatus,
	MostReferencedResult,
	MoveAnchor,
	MoveOutcome,
	Note,
	NoteAuthor,
	NoteBacklinks,
	NoteOutcome,
	RefactorCommitResult,
	RefactorRevertResult,
	RefactorStartResult,
	RefactorTrackResult,
	RefactorUndoResult,
	RenameStepOutcome,
	ReplaceOutcome,
	ReplaceSpanOutcome,
	RequestOf,
	SearchSymbolsResult,
	StoredDeclaration,
	SubjectDiagnosis,
	TypeInfo,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** What a tool needs from the daemon. Injected, so the tools are testable without one. */
export interface ToolBackend {
	projectId: string;
	findByName: (name: string, module?: string) => Promise<SymbolSummary[]>;
	resolveChain: (module: string, segments: string[]) => Promise<ChainAnswer>;
	moduleStatus: (module: string) => Promise<ModuleStatus>;
	describe: (symbolId: string) => Promise<DescribeResult | null>;
	findReferences: (symbolId: string, limit?: number, within?: string, module?: string) => Promise<ReferencesResult>;
	resolveImport: (fromModule: string, specifier: string) => Promise<ImportResolution>;
	typeOf: (symbolId: string) => Promise<TypeInfo>;
	symbolSource: (address: { symbolId?: string | undefined; factId?: string | undefined }) => Promise<SymbolSource>;
	refactorStart: () => Promise<RefactorStartResult>;
	refactorStatus: () => Promise<TransactionStatus>;
	prepareRename: (symbolId: string, newName: string, stops?: string[]) => Promise<RenamePlan>;
	planMove: (symbolId: string, toModule: string) => Promise<MovePlan>;
	refactorTrack: (module: string) => Promise<RefactorTrackResult>;
	refactorUndo: () => Promise<RefactorUndoResult>;
	refactorRevert: (args: {
		drifted: TransactionStatus["drifted"];
		expect?: { id: string; revision: number };
	}) => Promise<RefactorRevertResult>;
	refactorCommit: (force?: boolean) => Promise<RefactorCommitResult>;
	refactorReplace: (args: {
		symbolId?: string | undefined;
		factId?: string | undefined;
		newText: string;
	}) => Promise<ReplaceOutcome>;
	refactorReplaceSpan: (args: {
		symbolId: string;
		expectedSpanHash: string;
		newText: string;
	}) => Promise<ReplaceSpanOutcome>;
	refactorInsert: (args: {
		after?: string | undefined;
		module?: string | undefined;
		text: string;
	}) => Promise<InsertOutcome>;
	refactorMove: (symbolId: string, toModule: string, together: string[], anchor?: MoveAnchor) => Promise<MoveOutcome>;
	refactorRename: (symbolId: string, newName: string, stops?: string[]) => Promise<RenameStepOutcome>;
	indexStatus: (concerning?: string) => Promise<IndexStatus>;
	findLiterals: (query: RequestOf<"findLiterals">) => Promise<LiteralsResult>;
	findComments: (query: RequestOf<"findComments">) => Promise<CommentsResult>;
	findDocs: (query: RequestOf<"findDocs">) => Promise<DocsResult>;
	coChangedWith: (module: string, limit?: number) => Promise<CoChangedWithResult>;
	searchSymbols: (query: RequestOf<"searchSymbols">) => Promise<SearchSymbolsResult>;
	outlineModule: (module: string) => Promise<SymbolSummary[]>;
	fileNotes: (module: string) => Promise<FileNotes>;
	findImports: (query: RequestOf<"findImports">) => Promise<FindImportsResult>;
	hubs: (limit?: number) => Promise<MostReferencedResult>;
	overview: () => Promise<OverviewResult>;
	fileHistory: (module: string) => Promise<FileHistory>;
	commitsMentioning: (name: string, limit?: number) => Promise<CommitsMentioningResult>;
	readNote: (symbolId: string) => Promise<Note | null>;
	writeNote: (request: RequestOf<"writeNote">) => Promise<NoteOutcome>;
	doubtNote: (
		symbolId: string,
		reason: string,
		expectedRevision: number,
		author?: NoteAuthor,
	) => Promise<NoteOutcome>;
	/** A symbol id, or a module path for notes naming that file. */
	noteBacklinks: (target: string, limit?: number) => Promise<NoteBacklinks>;
	declarationOf: (symbolId: string) => Promise<StoredDeclaration | null>;
	diagnoseSubject: (symbolId: string) => Promise<SubjectDiagnosis>;
}

/** The backend's overview, with every section past the counts optional so a stub can omit it. */
export interface OverviewResult {
	files: number;
	symbols: number;
	references: number;
	imports: number;
	literals: number;
	symbolsByKind?: Record<string, number>;
	/** Files and symbols per content class, including the separate plain-text row. */
	content?: ContentTotals;
	modules: number;
	scope: string;
	index: IndexStatus;
	/** Code modules, largest first. */
	largest: Array<{ module: string; symbols: number }>;
	/** Data and document files, largest first, each saying which. */
	largestData?: Array<{ module: string; symbols: number; content: "data" | "document" }>;
	entryPoints?: Array<{ module: string; how: EntryHow; symbolId?: string | undefined }> | undefined;
	moreEntryPoints?: number | undefined;
}

/** What the tool schemas parse to. Optionals carry `undefined` explicitly, per the strict config. */
export interface SymbolArgs {
	name?: string | undefined;
	symbolId?: string | undefined;
	module?: string | undefined;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean | undefined;
}

export function textResult(body: string, isError = false): ToolResult {
	return {
		content: [{ type: "text", text: body }],
		...(isError ? { isError: true } : {}),
	};
}
