import { z } from "zod";
import { ExportFactIdSchema, ImportFactIdSchema } from "./daemonRows.js";
import { TextEditSchema } from "./edits.js";
import { ModuleCycleSchema as LoadCycleResultSchema } from "./loadCycles.js";
import { ImportKindSchema, MoveAnchorSchema, MoveDependencySchema } from "./move.js";
import { ExportFormSchema, LandingSchema } from "./project.js";
import { RenameSiteSchema } from "./rename.js";
import { PositionSchema, RangeSchema } from "./symbols.js";

/** A source declaration the move exported in place. */
export const PromotedSchema = z.object({ symbolId: z.string(), name: z.string() }).meta({ id: "Promoted" });
export type Promoted = z.infer<typeof PromotedSchema>;
////////////////////////////////
//  Refactoring

export const REFACTOR_ISSUE_KINDS = [
	"ExportedBeyondIndex",
	"FinishIncomplete",
	"ImportersUnchecked",
	"NameAlreadyBound",
	"NameImported",
	"NameNotInSource",
	"NameTaken",
	"NotIndexed",
	"OrphanedReference",
	"OwnerCallsUnresolved",
	"OwnerNotIndexed",
	"ReindexFailed",
	"SameName",
	"SameSpellingUnbound",
	"SyntaxUnchecked",
	"UnboundReference",
	"UnresolvedAfterMove",
	"NotImplemented",
	"ParseError",
	"ReceiverMemberMayCapture",
	"StringLiteral",
	"ExternalContract",
	"NotEditable",
	"PrivateSibling",
	"NoExportPath",
	"NoImportPath",
	"AmbiguousImportPath",
	"DynamicDependency",
	"Landed",
	"FixFailed",
	"RouteUnknown",
	"RouteChanged",
	"StopNotReExport",
	"StopUnsupported",
	"ProofUnavailable",
	"KnowledgeKept",
] as const;

/** Reported, never block commits. */
export const ADVISORY_ISSUE_KINDS: ReadonlySet<string> = new Set([
	"ExportedBeyondIndex",
	"ReceiverMemberMayCapture",
	"SameSpellingUnbound",
]);

export const RefactorIssueSchema = z
	.object({
		kind: z
			.string()
			.refine(
				(kind) => (REFACTOR_ISSUE_KINDS as readonly string[]).includes(kind),
				"unknown refactor issue kind",
			),
		detail: z.string(),
		module: z.string().optional(),
		line: z.number().optional(),
		/** Which step introduced it, so status can point at one rather than at the workspace. */
		stepNo: z.number().optional(),
	})
	.meta({ id: "RefactorIssue" });

export type RefactorIssue = z.infer<typeof RefactorIssueSchema>;

/** A blocker is something known to break; a warning is somewhere the index cannot see far enough. */
export const RenameConcernSchema = z
	.object({
		kind: z.string(),
		detail: z.string(),
		/** Where it was found, when the concern is about specific occurrences. */
		sites: z.array(z.object({ module: z.string(), line: z.number() })).optional(),
	})
	.meta({ id: "RenameConcern" });

export type RenameConcern = z.infer<typeof RenameConcernSchema>;

/** Occurrences of one symbol in one file, which is the unit a provider is asked to rewrite. */
export const RenameFileSchema = z
	.object({
		module: z.string(),
		sites: z.array(RenameSiteSchema),
		/** Calls in this file to the declaration owning the renamed symbol. Absent for an unowned one. */
		ownerCalls: z.array(RangeSchema).optional(),
	})
	.meta({ id: "RenameFile" });

export type RenameFile = z.infer<typeof RenameFileSchema>;

/** What the rename does to one route edge. */
export const RouteStateSchema = z.enum(["renamed", "fixed", "stopped", "unknown"]).meta({ id: "RouteState" });

export type RouteState = z.infer<typeof RouteStateSchema>;

/** One export or import fact a route crosses. An export's id is its stop id when `stoppable`. */
export const RouteEdgeSchema = z
	.discriminatedUnion("fact", [
		z.object({
			fact: z.literal("export"),
			id: ExportFactIdSchema,
			from: z.string(),
			/** Where it points; absent for a local target or an unknown route. */
			landing: LandingSchema.optional(),
			form: ExportFormSchema,
			name: z.string().optional(),
			state: RouteStateSchema,
			stoppable: z.literal(true).optional(),
		}),
		z.object({
			fact: z.literal("import"),
			id: ImportFactIdSchema,
			from: z.string(),
			/** Absent on an unknown route. */
			landing: LandingSchema.optional(),
			transfer: ImportKindSchema,
			name: z.string().optional(),
			state: RouteStateSchema,
		}),
	])
	.refine((edge) => edge.state !== "unknown" || edge.landing === undefined, {
		message: "an unknown route has no landing",
	})
	.meta({ id: "RouteEdge" });

export type RouteEdge = z.infer<typeof RouteEdgeSchema>;

/** One module a route reaches. A module may hold edited and kept sites at once. */
export const RouteModuleSchema = z
	.object({
		module: z.string(),
		roles: z.array(z.enum(["declares", "imports", "reExports", "uses"])),
		edited: z.number(),
		/** Sites a stop keeps. */
		kept: z.number(),
		/** Uses and routes in it no fact proves. */
		unknown: z.number(),
	})
	.meta({ id: "RouteModule" });

export type RouteModule = z.infer<typeof RouteModuleSchema>;

export const RenamePlanSchema = z
	.object({
		symbolId: z.string(),
		oldName: z.string(),
		newName: z.string(),
		files: z.array(RenameFileSchema),
		/** Total occurrences to rewrite, the declaration's own name included. */
		occurrences: z.number(),
		blockers: z.array(RenameConcernSchema),
		warnings: z.array(RenameConcernSchema),
		/** Every route the rename follows. */
		routes: z.object({ edges: z.array(RouteEdgeSchema), modules: z.array(RouteModuleSchema) }),
		/** The old name as a whole word in comment prose and string values. Reported, never edited. */
		mentions: z.object({
			comments: z.number(),
			strings: z.number(),
			/** A module lacks the comment or literal tier. */
			incomplete: z.literal(true).optional(),
		}),
	})
	.meta({ id: "RenamePlan" });

export type RenamePlan = z.infer<typeof RenamePlanSchema>;

export const FileEditsSchema = z
	.object({ module: z.string(), contentHash: z.string(), edits: z.array(TextEditSchema) })
	.meta({ id: "FileEdits" });

export type FileEdits = z.infer<typeof FileEditsSchema>;

/** A rename worked out but not applied, for a caller that will apply it itself. */
export const RenameEditPlanSchema = z
	.discriminatedUnion("ok", [
		z.object({ ok: z.literal(true), plan: RenamePlanSchema, files: z.array(FileEditsSchema) }),
		z.object({ ok: z.literal(false), plan: RenamePlanSchema, reason: z.string() }),
	])
	.meta({ id: "RenameEditPlan" });

export type RenameEditPlan = z.infer<typeof RenameEditPlanSchema>;

/** A move worked out but not yet written. The closure is the moved declaration plus everything inside it. */
export const MovePlanSchema = z
	.discriminatedUnion("ok", [
		z.object({
			ok: z.literal(true),
			symbolId: z.string(),
			name: z.string(),
			fromModule: z.string(),
			toModule: z.string(),
			/** The declaration's own text, which is what gets inserted at the target. */
			text: z.string(),
			removal: RangeSchema,
			closure: z.array(z.string()),
			dependencies: z.array(MoveDependencySchema),
			/** Modules importing the moved symbol, which need their specifier re-pointed. */
			referencing: z.array(z.string()),
			/** Whether anything left behind in the source module still uses it. */
			usedAtSource: z.boolean(),
			/** Used outside the target and not exported now. */
			exportsAtTarget: z.boolean().optional(),
			/** Where the target takes it, from the anchor; absent means the target's end. */
			insertion: PositionSchema.optional(),
			/** The source neighbor it leaves, as the anchor that puts it back. */
			restore: MoveAnchorSchema.optional(),
			baseHash: z.string(),
		}),
		z.object({ ok: z.literal(false), reason: z.string() }),
	])
	.meta({ id: "MovePlan" });

export type MovePlan = z.infer<typeof MovePlanSchema>;

/** Apply edits to the base, or empty text when created, to get `text`. */
export const MovePreviewFileSchema = z
	.object({
		module: z.string(),
		contentHash: z.string().nullable(),
		created: z.boolean(),
		text: z.string(),
		edits: z.array(TextEditSchema),
	})
	.meta({ id: "MovePreviewFile" });

export const MovePreviewSchema = z
	.discriminatedUnion("ok", [
		z.object({
			ok: z.literal(true),
			files: z.array(MovePreviewFileSchema),
			issues: z.array(RefactorIssueSchema),
			blockers: z.array(z.object({ module: z.string().optional(), reason: z.string() })),
			/** Absent from a daemon before protocol 6.8.0, and when nothing was promoted. */
			promoted: z.array(PromotedSchema).optional(),
			loadCycles: z.array(LoadCycleResultSchema).optional(),
		}),
		z.object({
			ok: z.literal(false),
			files: z.array(MovePreviewFileSchema),
			issues: z.array(RefactorIssueSchema),
			blockers: z.array(z.object({ module: z.string().optional(), reason: z.string() })),
			reason: z.string(),
		}),
	])
	.meta({ id: "MovePreview" });

export type MovePreview = z.infer<typeof MovePreviewSchema>;

/** Apply planned edits to the base, or empty text when created, to get `text`. */
export const InsertPreviewSchema = z
	.discriminatedUnion("state", [
		z.object({
			state: z.literal("planned"),
			module: z.string(),
			contentHash: z.string().nullable(),
			created: z.boolean(),
			text: z.string(),
			edits: z.array(TextEditSchema),
			issues: z.array(RefactorIssueSchema),
		}),
		z.object({ state: z.literal("present"), module: z.string(), issues: z.array(RefactorIssueSchema) }),
		z.object({ state: z.literal("refused"), reason: z.string(), issues: z.array(RefactorIssueSchema) }),
	])
	.meta({ id: "InsertPreview" });

export type InsertPreview = z.infer<typeof InsertPreviewSchema>;

/** What writing a whole module's text would do, judged against the stored text `contentHash` names. */
export const ReplacePreviewSchema = z
	.discriminatedUnion("state", [
		z.object({
			state: z.literal("planned"),
			module: z.string(),
			contentHash: z.string(),
			issues: z.array(RefactorIssueSchema),
		}),
		z.object({
			state: z.literal("refused"),
			reason: z.string(),
			/** The index moved past `contentHash`; read again, never retry. */
			stale: z.literal(true).optional(),
			issues: z.array(RefactorIssueSchema),
		}),
	])
	.meta({ id: "ReplacePreview" });

export type ReplacePreview = z.infer<typeof ReplacePreviewSchema>;

export const RefactorBeforeImageSchema = z
	.union([
		z.object({ tracked: z.literal(false), reason: z.string().optional() }),
		z.object({ tracked: z.literal(true), existed: z.literal(false) }),
		z.object({
			tracked: z.literal(true),
			existed: z.literal(true),
			contentHash: z.string(),
			encoding: z.literal("text"),
			text: z.string(),
		}),
		z.object({
			tracked: z.literal(true),
			existed: z.literal(true),
			contentHash: z.string(),
			encoding: z.literal("base64"),
			bytes: z.string(),
		}),
		/** Asked with `content: false`. */
		z.object({
			tracked: z.literal(true),
			existed: z.literal(true),
			contentHash: z.string(),
			encoding: z.enum(["text", "base64"]),
			omitted: z.literal(true),
		}),
	])
	.meta({ id: "RefactorBeforeImage" });

export type RefactorBeforeImage = z.infer<typeof RefactorBeforeImageSchema>;
