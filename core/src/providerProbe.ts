// Asking a provider about text that is not on disk, without leaving it believing that text.
//
// Planning a replacement has to know whether the candidate parses, and the only thing that can
// answer is the provider that owns the file. But `parseFile` is how the canonical view is SET, so
// asking it about a candidate leaves the provider holding a version nobody wrote, and every later
// question about that file is answered from it.
//
// The old shape put a restore call on each exit path of the planner. That is the "forgot to call
// refresh" bug class exactly: three restores today, and the fourth early return someone adds is a
// provider quietly serving phantom facts, with nothing failing until a much later question.
//
// Here the restore is structural. It is a finally, so there is no exit path that can skip it, and
// the planner cannot even see the seam.

import type { FileFacts, ProviderTiers } from "@nyaa-lexicon/protocol";
import type { ProviderSupervisor } from "./supervisor.js";
import { hashContent } from "./watcher.js";

////////////////////////////////
//  Interfaces & Types

export type CandidateParse = { parsed: true; facts: FileFacts } | { parsed: false; reason: string };

/**
 * What planning needs from the provider set, and nothing more.
 *
 * Narrow on purpose. A planner holding the whole supervisor could start a provider, re-index a file
 * or set the canonical view, and none of those are things planning is allowed to do.
 */
export interface ProviderProbe {
	/** Which provider owns a module, when one does. */
	owner(module: string): { owned: true; providerId: string } | { owned: false; reason: string };
	/** Whether that provider claims a tier, so silence is never read as approval. */
	declares(providerId: string, tier: keyof ProviderTiers): boolean;
	/** Parse text that is NOT on disk. The provider's view of the module is restored before this returns. */
	parseCandidate(module: string, text: string): Promise<CandidateParse>;
}

////////////////////////////////
//  Functions & Helpers

/** The live probe over a running provider set. */
export function liveProbe(supervisor: ProviderSupervisor, readFile: (module: string) => string | null): ProviderProbe {
	async function restore(module: string): Promise<void> {
		const text = readFile(module);
		if (text === null) return;
		// Swallowed: this is the repair, and a failure to repair must not replace the caller's own
		// answer with an error about the repair.
		await supervisor
			.ask(module, "parseFile", { module, contentHash: hashContent(text), text })
			.catch(() => undefined);
	}

	return {
		owner(module) {
			const route = supervisor.route(module);
			if (route.owned) return { owned: true, providerId: route.providerId };
			return {
				owned: false,
				reason: route.reason === "contested" ? `claimed by ${route.providerIds.join(", ")}` : "unclaimed",
			};
		},

		declares: (providerId, tier) => supervisor.declares(providerId, tier),

		async parseCandidate(module, text) {
			try {
				const facts = await supervisor.ask(module, "parseFile", {
					module,
					contentHash: hashContent(text),
					text,
				});
				const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
				if (errors.length > 0) {
					return { parsed: false, reason: errors.map((diagnostic) => diagnostic.message).join("; ") };
				}
				return { parsed: true, facts };
			} finally {
				await restore(module);
			}
		},
	};
}
