// Paint facts: a projection of stored or freshly parsed facts, for a client that colors code
// itself instead of running a second parser.

import { z } from "zod";
import { ProviderWordsSchema } from "./methods.js";
import { IndexDepthSchema, LiteralSchema } from "./project.js";
import { RangeSchema, ReferenceRoleSchema, SymbolKindSchema } from "./symbols.js";
import { UnknownReasonSchema } from "./values.js";

////////////////////////////////
//  Schemas

/**
 * One module's facts, shaped for painting.
 *
 * A declaration's range is its NAME, the selection range, never its body. `contentHash` names the
 * text these facts describe: the index's stored hash for a module read, the hash of the handed
 * text for a candidate parse. `words` is the owning provider's own vocabulary, which facts alone
 * cannot give. `depth` says whether an empty `references`, `literals` or `comments` means none or
 * means not parsed that deep yet: a module can sit at `outline` after warmup, whose rows hold
 * neither, and `parseFacts` always answers `full`. Names identify references across parses;
 * older daemons omit reference names, targets and reasons.
 */
export const PaintFactsSchema = z
	.object({
		contentHash: z.string().nullable(),
		words: ProviderWordsSchema,
		depth: IndexDepthSchema,
		declarations: z.array(z.object({ kind: SymbolKindSchema, range: RangeSchema })),
		references: z.array(
			z.object({
				role: ReferenceRoleSchema,
				range: RangeSchema,
				bound: z.boolean(),
				/** The identifier as written. */
				name: z.string().optional(),
				/** The bound target's symbol id; null when unbound. */
				target: z.string().nullable().optional(),
				/** Why an unbound reference did not bind; `Ambiguous` for several candidates. */
				reason: UnknownReasonSchema.optional(),
			}),
		),
		literals: z.array(z.object({ kind: LiteralSchema.shape.kind, range: RangeSchema })),
		comments: z.array(z.object({ range: RangeSchema })),
	})
	.meta({ id: "PaintFacts" });

export type PaintFacts = z.infer<typeof PaintFactsSchema>;
