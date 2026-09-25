// Asking a provider about text that is not on disk.
//
// Candidate parsing uses `probeFile`.

import type {
	FileFacts,
	MoveEditsRequest,
	MoveEditsResponse,
	ProviderTiers,
	ProviderWords,
	RenameEditsRequest,
	RenameEditsResponse,
} from "@nyaa-lexicon/protocol";
import { hashContent } from "@nyaa-lexicon/protocol";
import type { ProviderPort } from "./providerPort.js";

////////////////////////////////
//  Interfaces & Types

export type CandidateParse = { parsed: true; facts: FileFacts } | { parsed: false; reason: string };

/** What planning may ask a provider. Narrow so it cannot start one or set the canonical view. */
export interface ProviderProbe {
	owner(module: string): { owned: true; providerId: string } | { owned: false; reason: string };
	/** Silence from a provider is never approval. */
	declares(providerId: string, tier: keyof ProviderTiers): boolean;
	/** The owning provider's keywords, builtins and literal words; null when the module is unowned. */
	words(module: string): ProviderWords | null;
	/** Failures return `parsed: false`; this call never rejects. */
	parseCandidate(module: string, text: string): Promise<CandidateParse>;
	/** Stateful stores isolate rename and move edits. */
	renameEdits(module: string, request: RenameEditsRequest): Promise<RenameEditsResponse>;
	moveEdits(module: string, request: MoveEditsRequest): Promise<MoveEditsResponse>;
}

////////////////////////////////
//  Functions & Helpers

/** The live probe over a running provider set. */
export function liveProbe(supervisor: ProviderPort): ProviderProbe {
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

		words(module) {
			const route = supervisor.route(module);
			if (!route.owned) return null;
			return supervisor.words(route.providerId) ?? null;
		},

		renameEdits: (module, request) => supervisor.ask(module, "renameEdits", request),

		moveEdits: (module, request) => supervisor.ask(module, "moveEdits", request),

		async parseCandidate(module, text) {
			try {
				const facts = await supervisor.ask(module, "probeFile", {
					module,
					contentHash: hashContent(text),
					text,
				});
				const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
				if (errors.length > 0) {
					return { parsed: false, reason: errors.map((diagnostic) => diagnostic.message).join("; ") };
				}
				return { parsed: true, facts };
			} catch (error) {
				return {
					parsed: false,
					reason: `the provider could not parse the candidate: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},
	};
}
