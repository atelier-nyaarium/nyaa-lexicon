// Moving a declaration to another module, as a contract rather than a cut and paste.
//
// The split matches rename: the core owns WHICH modules are involved and WHAT the moved body
// depends on, because that comes out of the reference index. The provider owns WHAT TEXT to
// write, because rendering an import specifier needs tsconfig paths, package export maps and
// language builtins that the core must never learn.
//
// The dependency inventory is the load-bearing half. A moved class's body references are owned by
// its METHODS rather than by the class, so "references whose fromId is the moved symbol" misses
// most of them. The core walks the whole moved closure instead, and every reference in it arrives
// classified or the move blocks. Silence is never read as "no import needed".

import { z } from "zod";
import { type EditConflict, TextEditSchema } from "./edits.js";
import { PositionSchema, RangeSchema } from "./symbols.js";
import { UnknownReasonSchema } from "./values.js";

////////////////////////////////
//  Schemas

/** How a name was brought into a module. Rendering an addition has to preserve the form. */
export const ImportKindSchema = z
	.enum([
		/** One named export, aliased or not. */
		"named",
		/** The module's default export. */
		"default",
		/** The whole module bound to one name. */
		"namespace",
		/** Every export bound at once, e.g. Python's `from x import *`. */
		"wildcard",
		/** Imported for effect, binding no name. */
		"sideEffect",
		/** Erased at runtime, e.g. TypeScript's `import type`. */
		"typeOnly",
	])
	.meta({ id: "ImportKind" });

export type ImportKind = z.infer<typeof ImportKindSchema>;

/** The import statement a name arrived through, kept whole so an addition can preserve its form. */
export const ImportOriginSchema = z
	.object({
		specifier: z.string().min(1),
		importKind: ImportKindSchema,
		/** The name as the origin exports it. Absent for namespace and side-effect imports. */
		importedName: z.string().min(1).optional(),
		/** The name as this module spells it, which is what the moved body actually wrote. */
		localName: z.string().min(1).optional(),
		range: RangeSchema.optional(),
	})
	.meta({ id: "ImportOrigin" });

export type ImportOrigin = z.infer<typeof ImportOriginSchema>;

/**
 * Where a name used inside the moved body comes from, as far as the index can prove.
 *
 * The provider decides what to WRITE for each of these; the core only says what it found. A
 * builtin is absent from this union on purpose, because whether `console` needs an import is
 * language knowledge and the core would have to branch on language to claim it.
 */
export const DependencyOriginSchema = z
	.discriminatedUnion("kind", [
		/** Declared inside the moved closure, so it travels with the body and needs no import. */
		z.object({ kind: z.literal("insideClosure"), symbolId: z.string().min(1) }),
		/**
		 * Declared in the module being moved OUT OF, so it stays behind and the target must reach
		 * it. `exported` is optional because a language can have no answer, exactly as on a
		 * declaration; absent means unknown rather than false.
		 */
		z.object({
			kind: z.literal("sourceModule"),
			symbolId: z.string().min(1),
			name: z.string().min(1),
			exported: z.boolean().optional(),
		}),
		/** Declared in some other indexed module, reached by an import the source module writes. */
		z.object({
			kind: z.literal("workspaceModule"),
			symbolId: z.string().min(1),
			module: z.string().min(1),
			/** The import statement in the source module that supplied it, when one did. */
			via: ImportOriginSchema.optional(),
		}),
		/** Reached by an import that resolves outside the workspace, so the specifier is preserved. */
		z.object({ kind: z.literal("external"), via: ImportOriginSchema }),
		/** The index could not say. Carries the reason so a block can name it. */
		z.object({ kind: z.literal("unresolved"), reason: UnknownReasonSchema }),
	])
	.meta({ id: "DependencyOrigin" });

export type DependencyOrigin = z.infer<typeof DependencyOriginSchema>;

/**
 * One name the moved body uses, with everything the index knows about where it comes from.
 *
 * The core resolves the origin before the provider sees it, because the imports table holds an
 * unresolved specifier with no lexical scope and cannot separate two same-named imports.
 */
export const MoveDependencySchema = z
	.object({
		/** The identifier as written inside the moved body. */
		name: z.string().min(1),
		origin: DependencyOriginSchema,
		/** Where it is written, so a block can point at a line. */
		range: RangeSchema.optional(),
	})
	.meta({ id: "MoveDependency" });

export type MoveDependency = z.infer<typeof MoveDependencySchema>;

/** An import in this module naming the moved symbol, whose specifier addresses the target module. */
export const MoveImportSiteSchema = z
	.object({
		/**
		 * The imported NAME's span, not the whole statement.
		 *
		 * The index stores the rewritable name rather than the statement around it, so this locates
		 * the statement rather than delimiting it. A provider widens from here to whatever it needs
		 * to rewrite, which it can do because it has the text.
		 */
		range: RangeSchema,
		specifier: z.string().min(1),
		importKind: ImportKindSchema,
		importedName: z.string().min(1).optional(),
		localName: z.string().min(1).optional(),
		/** Set when this statement re-exports rather than consumes, which rewrites differently. */
		reExport: z.boolean(),
	})
	.meta({ id: "MoveImportSite" });

export type MoveImportSite = z.infer<typeof MoveImportSiteSchema>;

/** What this module gets: text removed, text inserted, or neither for a plain referencing module. */
export const MoveRoleSchema = z
	.object({
		/** The declaration's whole range in the source module, comments included. */
		removal: RangeSchema.optional(),
		/** The text to write into the target. Absent position means the end of the file. */
		insertion: z.object({ text: z.string().min(1), position: PositionSchema.optional() }).optional(),
	})
	.meta({ id: "MoveRole" });

/**
 * Why a provider will not carry out one part of a move it receives.
 *
 * Kept separate from rename's list despite five shared spellings, so neither contract needs the
 * other's agreement to gain a member.
 */
export const MoveBlockedReasonSchema = z
	.enum([
		/** The moved body uses something that stays behind and is not visible outside its module. */
		"PrivateSibling",
		/** The dependency is visible but nothing re-exports it where the target could reach it. */
		"NoExportPath",
		/** No specifier can address the origin from this module. */
		"NoImportPath",
		/** Several specifiers could address it and nothing chooses between them. */
		"AmbiguousImportPath",
		/** Reached by reflection, a computed import or a string, so no edit is safe. */
		"DynamicDependency",
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
	.meta({ id: "MoveBlockedReason" });

export type MoveBlockedReason = z.infer<typeof MoveBlockedReasonSchema>;

/**
 * How a move names what `planEdits` found, in one place for every provider.
 *
 * Shared because three providers said the same three things in their own words, and the wording is
 * what an agent reads when a move refuses. Drift here is a user-visible inconsistency for no reason.
 */
export const MOVE_EDIT_CONFLICT: Record<EditConflict, { reason: MoveBlockedReason; detail: string }> = {
	unaddressable: { reason: "ParseError", detail: "an edit range is outside the module" },
	duplicate: { reason: "NotImplemented", detail: "the move produces duplicate edits" },
	overlapping: { reason: "NotImplemented", detail: "the move produces overlapping edits" },
};

export const MoveBlockedSiteSchema = z
	.object({ range: RangeSchema.optional(), reason: MoveBlockedReasonSchema, detail: z.string().optional() })
	.meta({ id: "MoveBlockedSite" });

export type MoveBlockedSite = z.infer<typeof MoveBlockedSiteSchema>;

/** Why a provider will not attempt this module's part at all. Whole-request, not per-site. */
export const MoveRefusalSchema = z
	.enum([
		/** The target path is not a module this language can hold. */
		"InvalidTarget",
		/** The target already declares this name, so inserting would change what that name means. */
		"TargetCollision",
		/** This provider does not implement move. */
		"NotImplemented",
		/** The file did not parse. */
		"ParseError",
	])
	.meta({ id: "MoveRefusal" });

export type MoveRefusal = z.infer<typeof MoveRefusalSchema>;

/**
 * One module's part of a move. The core sends one of these per involved module.
 *
 * The source module can also be a REFERENCING module: moving `foo` out of a file whose `bar` still
 * calls it leaves that file needing an import. So the fields describe work rather than a role, and
 * a module can carry several kinds at once.
 */
export const MoveEditsRequestSchema = z
	.object({
		module: z.string().min(1),
		/** Passed in, like parseFile, so the provider never disagrees with the core about the text. */
		text: z.string(),
		/**
		 * False when the target does not exist yet. The provider must still parse and answer, since
		 * the file is created by applying these edits.
		 */
		exists: z.boolean(),
		symbolId: z.string().min(1),
		name: z.string().min(1),
		fromModule: z.string().min(1),
		toModule: z.string().min(1),
		role: MoveRoleSchema,
		importSites: z.array(MoveImportSiteSchema),
		/**
		 * Names this module must be able to reach after the move.
		 *
		 * For the target that is everything the moved body uses. For the source and for any
		 * referencing module it is the moved symbol itself, when it is still used there.
		 *
		 * Required rather than optional, and complete by contract: the core always runs the
		 * inventory, so empty means nothing needs importing rather than nothing was looked for.
		 */
		dependencies: z.array(MoveDependencySchema),
		/**
		 * Occurrences of the moved symbol in this module that are not import statements.
		 *
		 * A qualified use like `helpers.foo()` names the MODULE rather than the symbol, so moving
		 * changes the use itself and no import rewrite alone would fix it.
		 */
		sites: z.array(RangeSchema),
	})
	.meta({ id: "MoveEditsRequest" });

export type MoveEditsRequest = z.infer<typeof MoveEditsRequestSchema>;

/**
 * Ready carries edits AND blocked sites, because both can be non-empty at once.
 *
 * The applier's rule is the same as rename's: any blocked site stops the whole move, since a
 * partially repaired import graph is code that no longer builds.
 */
export const MoveEditsResponseSchema = z
	.discriminatedUnion("status", [
		z.object({
			status: z.literal("ready"),
			edits: z.array(TextEditSchema),
			blocked: z.array(MoveBlockedSiteSchema),
		}),
		z.object({
			status: z.literal("refused"),
			reason: MoveRefusalSchema,
			detail: z.string().optional(),
		}),
	])
	.meta({ id: "MoveEditsResponse" });

export type MoveEditsResponse = z.infer<typeof MoveEditsResponseSchema>;
