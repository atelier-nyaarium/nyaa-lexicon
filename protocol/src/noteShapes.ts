// A knowledge note: one per symbol, four fields a writer answers or declines with `n/a`, the refs
// they carry, who wrote it, and what has moved since.

import { z } from "zod";

////////////////////////////////
//  Constants

export const NOTE_FIELDS = ["summary", "description", "why", "gotchas"] as const;

/** A writer's explicit "nothing supported to say"; stored as null. */
export const NOT_APPLICABLE = "n/a";

////////////////////////////////
//  Schemas

export const NoteFieldSchema = z.enum(NOTE_FIELDS).meta({ id: "NoteField" });

export type NoteField = z.infer<typeof NoteFieldSchema>;

/** Who wrote, as the harness attests it; an agent never names itself. */
export const NoteAuthorSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("person") }),
		z.object({
			kind: z.literal("agent"),
			/** The model the harness launched, as the model reported it. */
			model: z.string().min(1).nullable(),
			/** The channel or harness that ran it. */
			via: z.string().min(1).nullable(),
			run: z.string().min(1).nullable(),
		}),
		/** An MCP client that named itself at the handshake; it cannot attest a model. */
		z.object({ kind: z.literal("client"), name: z.string().min(1), version: z.string().min(1).nullable() }),
	])
	.meta({ id: "NoteAuthor" });

export type NoteAuthor = z.infer<typeof NoteAuthorSchema>;

/** One ref a note carries, at its target's current address. */
export const NoteLinkSchema = z
	.object({
		field: NoteFieldSchema,
		/** As the writer wrote it. */
		written: z.string(),
		/** At the target's current address; the written text when broken. */
		current: z.string(),
		/** The target symbol's current id; absent for a module ref and when broken. */
		symbolId: z.string().optional(),
		/** The target's declaration kind, or `file`; absent when broken. */
		kind: z.string().optional(),
		/**
		 * `broken`: the target is gone. `changed`: its source changed since the note was saved or
		 * confirmed. A file ref is never `changed`: every edit to the file would say so.
		 */
		state: z.enum(["ok", "changed", "broken"]),
	})
	.meta({ id: "NoteLink" });

export type NoteLink = z.infer<typeof NoteLinkSchema>;

const Fields = {
	summary: z.string().nullable(),
	description: z.string().nullable(),
	why: z.string().nullable(),
	gotchas: z.string().nullable(),
};

/** An agent's replacement for a note a person last edited, waiting on that person. */
/** Field text carries each ref at its target's current address, as a note's does. */
export const NoteProposalSchema = z
	.object({
		...Fields,
		baseRevision: z.number().int().positive(),
		by: NoteAuthorSchema.nullable(),
		at: z.number(),
		links: z.array(NoteLinkSchema),
	})
	.meta({ id: "NoteProposal" });

export type NoteProposal = z.infer<typeof NoteProposalSchema>;

/** Field text carries each ref at its target's current address. */
export const NoteSchema = z
	.object({
		symbolId: z.string(),
		/** The address the note was last saved at. */
		recordedAs: z.string(),
		revision: z.number().int().positive(),
		...Fields,
		author: NoteAuthorSchema.nullable(),
		authoredAt: z.number(),
		editedBy: NoteAuthorSchema.nullable(),
		editedAt: z.number(),
		confirmedBy: NoteAuthorSchema.nullable(),
		confirmedAt: z.number().nullable(),
		/** Someone was misled by this revision; any save or confirm clears it. */
		doubt: z.object({ by: NoteAuthorSchema.nullable(), reason: z.string(), at: z.number() }).nullable(),
		/** The symbol's source changed since the note was saved or confirmed. */
		sourceChanged: z.boolean(),
		links: z.array(NoteLinkSchema),
		proposal: NoteProposalSchema.nullable(),
	})
	.meta({ id: "Note" });

export type Note = z.infer<typeof NoteSchema>;

/** A ref a save could not accept, with what the writer might have meant. */
export const NoteRefProblemSchema = z
	.object({ field: NoteFieldSchema, ref: z.string(), problem: z.string(), candidates: z.array(z.string()) })
	.meta({ id: "NoteRefProblem" });

export type NoteRefProblem = z.infer<typeof NoteRefProblemSchema>;

/** `saved` with no note: every field was `n/a`, so nothing stands. `proposed`: waiting on a person. */
export const NoteOutcomeSchema = z
	.discriminatedUnion("outcome", [
		z.object({ outcome: z.literal("saved"), note: NoteSchema.nullable() }),
		z.object({ outcome: z.literal("proposed"), note: NoteSchema }),
		z.object({
			outcome: z.literal("refused"),
			reason: z.string(),
			refs: z.array(NoteRefProblemSchema).optional(),
			/** The note as it stands, when the refusal is a revision mismatch. */
			current: NoteSchema.nullable().optional(),
		}),
	])
	.meta({ id: "NoteOutcome" });

export type NoteOutcome = z.infer<typeof NoteOutcomeSchema>;

export const NoteBacklinksSchema = z
	.object({
		notes: z.array(
			z.object({ symbolId: z.string(), summary: z.string().nullable(), fields: z.array(NoteFieldSchema) }),
		),
		total: z.number().int().nonnegative(),
	})
	.meta({ id: "NoteBacklinks" });

export type NoteBacklinks = z.infer<typeof NoteBacklinksSchema>;

////////////////////////////////
//  Requests

const Author = { author: NoteAuthorSchema.optional() };

/** Every field required: text, or `n/a`. `expectedRevision` 0 means no note stands. */
export const WriteNoteRequestSchema = z
	.object({
		symbolId: z.string().min(1),
		summary: z.string(),
		description: z.string(),
		why: z.string(),
		gotchas: z.string(),
		expectedRevision: z.number().int().nonnegative(),
		...Author,
	})
	.meta({ id: "WriteNoteRequest" });

export const ReadNoteRequestSchema = z.object({ symbolId: z.string().min(1) }).meta({ id: "ReadNoteRequest" });

export const ConfirmNoteRequestSchema = z
	.object({ symbolId: z.string().min(1), expectedRevision: z.number().int().positive(), ...Author })
	.meta({ id: "ConfirmNoteRequest" });

/** `expectedRevision` names the revision that misled. */
export const DoubtNoteRequestSchema = z
	.object({
		symbolId: z.string().min(1),
		reason: z.string().min(1),
		expectedRevision: z.number().int().positive(),
		...Author,
	})
	.meta({ id: "DoubtNoteRequest" });

export const ResolveNoteProposalRequestSchema = z
	.object({
		symbolId: z.string().min(1),
		accept: z.boolean(),
		expectedRevision: z.number().int().positive(),
		...Author,
	})
	.meta({ id: "ResolveNoteProposalRequest" });

/** A symbol or file a ref could name, with the ref already written. */
export const RefCandidateSchema = z
	.object({
		ref: z.string(),
		name: z.string(),
		/** A declaration kind, or `file`. */
		kind: z.string(),
		module: z.string(),
		/** The enclosing declarations by name, outermost first. */
		container: z.array(z.string()),
		symbolId: z.string().optional(),
	})
	.meta({ id: "RefCandidate" });

export type RefCandidate = z.infer<typeof RefCandidateSchema>;

export const SearchRefsSchema = z.object({ results: z.array(RefCandidateSchema) }).meta({ id: "SearchRefs" });

export type SearchRefs = z.infer<typeof SearchRefsSchema>;

/** `limit` caps the declarations; up to eight files follow them. Case folds ASCII only. */
export const SearchRefsRequestSchema = z
	.object({ text: z.string(), limit: z.number().int().positive().max(100).optional() })
	.meta({ id: "SearchRefsRequest" });

export const NoteBacklinksRequestSchema = z
	.object({ symbolId: z.string().min(1), limit: z.number().int().positive().optional() })
	.meta({ id: "NoteBacklinksRequest" });
