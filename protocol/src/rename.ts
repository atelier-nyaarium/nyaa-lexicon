// Renaming a symbol, as a contract rather than a text replace.
//
// The core owns WHICH occurrences belong to a symbol, because the reference index and its
// provenance are language-neutral and a rename is only honest over bound edges. The provider owns
// WHAT TEXT each occurrence becomes, because that part is pure syntax: `import { foo as bar }`
// rewrites the specifier and must leave bar alone, a shorthand `{ foo }` has to grow a key, and a
// GDScript signal reached by string literal is not an identifier at all.
//
// Splitting it the other way round would put language knowledge in the core, and splitting it no
// way at all would make every provider reimplement the reference index.

import { z } from "zod";
import { type EditConflict, TextEditSchema } from "./edits.js";
import { RangeSchema } from "./symbols.js";

////////////////////////////////
//  Schemas

/**
 * Why a provider will not rewrite one occurrence it was handed.
 *
 * Closed, like every other reason enum here. A blocked site does not mean "nothing to do": it
 * means this occurrence SHOULD change and the provider cannot change it safely, so the rename as a
 * whole would leave the code broken. An occurrence that correctly needs no edit is simply absent
 * from both lists, which is a different answer and must stay distinguishable from this one.
 */
export const BlockedSiteReasonSchema = z
	.enum([
		/** Reached through a string literal, where rewriting risks hitting unrelated text. */
		"StringLiteral",
		/** The name is load-bearing outside this file's language, e.g. a scene or serialized asset. */
		"ExternalContract",
		/** Generated or vendored, so an edit would be overwritten or is not ours to make. */
		"NotEditable",
		/** The construct is understood and rewriting it correctly is not implemented yet. */
		"NotImplemented",
		/** The file did not parse, so no position in it can be trusted. */
		"ParseError",
	])
	.meta({ id: "BlockedSiteReason" });

export type BlockedSiteReason = z.infer<typeof BlockedSiteReasonSchema>;

export const BlockedSiteSchema = z
	.object({ range: RangeSchema, reason: BlockedSiteReasonSchema, detail: z.string().optional() })
	.meta({ id: "BlockedSite" });

export type BlockedSite = z.infer<typeof BlockedSiteSchema>;

/** Why a provider will not attempt the rename at all. Whole-request, not per-site. */
export const RenameRefusalSchema = z
	.enum([
		/** Not a legal identifier in this language. */
		"InvalidName",
		/** Legal in shape, but reserved by the language. */
		"ReservedWord",
		/** Something else already answers to the new name here, so the rename would change meaning. */
		"Collision",
		/** This provider does not implement rename. */
		"NotImplemented",
		/** The file did not parse. */
		"ParseError",
	])
	.meta({ id: "RenameRefusal" });

export type RenameRefusal = z.infer<typeof RenameRefusalSchema>;

/**
 * How a rename names what `planEdits` found. Here rather than in the providers that read it,
 * because two copies of this had already drifted onto different reasons for the same condition.
 *
 * The reason is narrowed to the two names BlockedSiteReason and RenameRefusal share, so one
 * mapping serves a provider that blocks the site and a provider that refuses the whole request.
 */
export const RENAME_EDIT_CONFLICT: Record<EditConflict, { reason: BlockedSiteReason & RenameRefusal; detail: string }> =
	{
		unaddressable: { reason: "ParseError", detail: "an edit range is outside the module" },
		duplicate: { reason: "NotImplemented", detail: "the rename sites produce conflicting edits" },
		overlapping: { reason: "NotImplemented", detail: "the rename sites produce overlapping edits" },
	};

/**
 * One occurrence the core believes belongs to the symbol.
 *
 * The role rides along because it changes the edit: an `import` occurrence of an aliased specifier
 * is rewritten differently from a `read` of the local alias, and the provider would otherwise have
 * to re-derive from the syntax what the index already knows.
 */
export const RenameSiteSchema = z
	.object({ range: RangeSchema, role: z.string().min(1).optional() })
	.meta({ id: "RenameSite" });

export type RenameSite = z.infer<typeof RenameSiteSchema>;

export const RenameEditsRequestSchema = z
	.object({
		module: z.string().min(1),
		/** Passed in, like parseFile, so the provider never disagrees with the core about the text. */
		text: z.string(),
		oldName: z.string().min(1),
		newName: z.string().min(1),
		sites: z.array(RenameSiteSchema),
		/**
		 * Calls, in this module, to the declaration that OWNS the symbol being renamed.
		 *
		 * Renaming a parameter has to rewrite the argument that names it at every call site, and those
		 * are occurrences of the FUNCTION's name rather than the parameter's, so no search for
		 * `oldName` finds them and the sites list cannot carry them. A provider given these rewrites
		 * the named argument inside each call and leaves anything positional alone.
		 *
		 * Every range here is a call that BOUND to the owner. Calls that did not bind are the caller's
		 * problem to report, not silently absent: the core raises them as concerns on the plan.
		 *
		 * ABSENT and EMPTY mean different things, and a provider must act on the difference. Empty
		 * says the owner's calls were gathered and none are in this file, which is the ordinary case
		 * for the file holding the declaration. Absent says nothing was gathered, so a provider that
		 * cannot rewrite an owned symbol without them still has to refuse.
		 */
		ownerCalls: z.array(RangeSchema).optional(),
	})
	.meta({ id: "RenameEditsRequest" });

export type RenameEditsRequest = z.infer<typeof RenameEditsRequestSchema>;

/**
 * Ready carries edits AND blocked sites, because both can be non-empty at once.
 *
 * A caller that reads only the edits would write a half-rename and call it done, so the applier's
 * rule is that any blocked site stops the whole operation. Reporting them beats silently dropping
 * them, which is how a rewriter ends up quietly producing code that no longer compiles.
 */
export const RenameEditsResponseSchema = z
	.discriminatedUnion("status", [
		z.object({
			status: z.literal("ready"),
			edits: z.array(TextEditSchema),
			blocked: z.array(BlockedSiteSchema),
		}),
		z.object({
			status: z.literal("refused"),
			reason: RenameRefusalSchema,
			detail: z.string().optional(),
		}),
	])
	.meta({ id: "RenameEditsResponse" });

export type RenameEditsResponse = z.infer<typeof RenameEditsResponseSchema>;
