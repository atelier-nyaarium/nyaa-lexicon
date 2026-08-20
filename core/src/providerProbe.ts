// Asking a provider about text that is not on disk.
//
// `parseFile` SETS the canonical view, so a candidate leaves the provider holding text nobody
// wrote. Restoring is a finally here; by hand it missed exits.

import type {
	FileFacts,
	MoveEditsRequest,
	MoveEditsResponse,
	ProviderTiers,
	RenameEditsRequest,
	RenameEditsResponse,
} from "@nyaa-lexicon/protocol";
import type { ProviderSupervisor } from "./supervisor.js";
import { hashContent } from "./watcher.js";

////////////////////////////////
//  Interfaces & Types

export type CandidateParse = { parsed: true; facts: FileFacts } | { parsed: false; reason: string };

/** What planning may ask a provider. Narrow so it cannot start one or set the canonical view. */
export interface ProviderProbe {
	owner(module: string): { owned: true; providerId: string } | { owned: false; reason: string };
	/** Silence from a provider is never approval. */
	declares(providerId: string, tier: keyof ProviderTiers): boolean;
	/** Restores the provider's view before returning. */
	parseCandidate(module: string, text: string): Promise<CandidateParse>;
	/** These ASK rather than SET, so no restore is needed. */
	renameEdits(module: string, request: RenameEditsRequest): Promise<RenameEditsResponse>;
	moveEdits(module: string, request: MoveEditsRequest): Promise<MoveEditsResponse>;
}

////////////////////////////////
//  Functions & Helpers

/** The live probe over a running provider set. */
export function liveProbe(supervisor: ProviderSupervisor, readFile: (module: string) => string | null): ProviderProbe {
	async function restore(module: string): Promise<void> {
		// An absent file restores to EMPTY, or the provider keeps serving the candidate as the view
		// of a module that does not exist.
		const text = readFile(module) ?? "";
		// Swallowed: a failed repair must not replace the caller's answer.
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

		renameEdits: (module, request) => supervisor.ask(module, "renameEdits", request),

		moveEdits: (module, request) => supervisor.ask(module, "moveEdits", request),

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
