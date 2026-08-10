// The load-bearing return types. These, not the method list, are the provider contract.
//
// Uncertainty lives in the value, never in the interface. Every provider implements every method;
// a missing capability answers Unknown with a reason, so the core never branches on language.

import { z } from "zod";

////////////////////////////////
//  Schemas

/** Closed on purpose: an open string lets a provider invent a reason the core cannot render. */
export const UnknownReasonSchema = z
	.enum([
		/** This provider has not implemented the tier. A fact about our code, not the user's. */
		"NotImplemented",
		/** The language genuinely cannot answer. */
		"DynamicallyTyped",
		/** Defined outside the indexed set. */
		"ExternalDependency",
		/** The file did not parse, so nothing here is trustworthy. */
		"ParseError",
		/** Inference bailed at a depth or fixpoint limit rather than looping. */
		"RecursionLimit",
		/** More than one candidate and no way to choose. */
		"Ambiguous",
		/** Built at runtime: computed import, reflection, string-keyed access. */
		"RuntimeConstructed",
		/**
		 * Real and statically known, but not something this index contains. Locals and parameters are
		 * the usual case. Distinct from RuntimeConstructed, which claims the target cannot be known.
		 */
		"NotIndexed",
	])
	.meta({ id: "UnknownReason" });

export type UnknownReason = z.infer<typeof UnknownReasonSchema>;

/** How a fact was established, so a consumer can weigh a binding against a name match. */
export const ProvenanceSchema = z
	.enum([
		/** Resolved through real scope and import rules. */
		"bound",
		/** Stated in source, e.g. an explicit annotation. */
		"declared",
		/** Computed by the provider's inference. */
		"inferred",
		/** Matched by name alone, the weakest thing we report. */
		"nameMatched",
		/** Asserted by a human or a confirmed AI finding, not derived from source. */
		"asserted",
	])
	.meta({ id: "Provenance" });

export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Ambiguous is a first-class answer, never an error and never a guess. */
export const BindingSchema = z
	.discriminatedUnion("status", [
		z.object({
			status: z.literal("bound"),
			symbolId: z.string().min(1),
			provenance: ProvenanceSchema,
		}),
		z.object({
			status: z.literal("ambiguous"),
			candidates: z.array(z.string().min(1)).min(2),
			provenance: ProvenanceSchema,
		}),
		z.object({
			status: z.literal("unbound"),
			reason: UnknownReasonSchema,
			/** Prose for a human; the reason is the machine-readable part. */
			detail: z.string().optional(),
		}),
	])
	.meta({ id: "Binding" });

export type Binding = z.infer<typeof BindingSchema>;

/**
 * `display` is a string because a structural type tree is a TypeScript idea that Python and
 * GDScript cannot fill. Structure, if ever wanted, rides alongside it rather than replacing it.
 */
export const TypeInfoSchema = z
	.discriminatedUnion("status", [
		z.object({
			status: z.literal("known"),
			display: z.string().min(1),
			/** Absent for structural and primitive types, which have no symbol of their own. */
			symbolId: z.string().min(1).optional(),
			provenance: ProvenanceSchema,
		}),
		z.object({
			status: z.literal("inferred"),
			display: z.string().min(1),
			/** What the inference was drawn from, e.g. "return statements". */
			basis: z.string().min(1),
			/**
			 * Present when the inferred type is one named declaration the index holds.
			 *
			 * An inference lands on a named class as often as an annotation does, and without this
			 * "go to the type's definition" would work on annotated code and fail on inferred code
			 * for no reason a reader could see.
			 */
			symbolId: z.string().min(1).optional(),
		}),
		z.object({
			status: z.literal("unknown"),
			reason: UnknownReasonSchema,
			detail: z.string().optional(),
		}),
	])
	.meta({ id: "TypeInfo" });

export type TypeInfo = z.infer<typeof TypeInfoSchema>;

////////////////////////////////
//  Functions & Helpers

/** One predicate for "definite enough to build on", so call sites cannot each invent their own. */
export function isResolved(value: Binding | TypeInfo): boolean {
	return value.status === "bound" || value.status === "known" || value.status === "inferred";
}

/** Ambiguous reports a reason rather than null, since a caller asking why deserves an answer. */
export function reasonOf(value: Binding | TypeInfo): UnknownReason | null {
	if (value.status === "unbound" || value.status === "unknown") return value.reason;
	if (value.status === "ambiguous") return "Ambiguous";
	return null;
}
