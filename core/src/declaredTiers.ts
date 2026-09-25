// What a provider's parse carries is what its tiers declare. The supervisor applies this at the
// wire and the test double applies the same function, so no fixture sees a shape the wire drops.

import type { FileFacts, ProviderTiers } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Functions & Helpers

/** Tier-owned fields are dropped when undeclared. */
export function settleDeclaredTiers(
	tiers: Pick<Partial<ProviderTiers>, "comments" | "fileRoles">,
	facts: Partial<Pick<FileFacts, "comments" | "role">>,
): void {
	if (tiers.comments === true) facts.comments ??= [];
	else delete facts.comments;
	if (tiers.fileRoles !== true) delete facts.role;
}
