// Asking a provider about text that is not on disk.
//
// Candidate parsing uses `probeFile`.

import type {
	ArrangeEditsRequest,
	FileFacts,
	ImportEditsRequest,
	ImportEditsResponse,
	MoveEditsRequest,
	MoveEditsResponse,
	ProbeBatchRequest,
	ProbeBatchResponse,
	ProviderTiers,
	ProviderWords,
	RenameEditsRequest,
	RenameEditsResponse,
} from "@nyaa-lexicon/protocol";
import { hashContent } from "@nyaa-lexicon/protocol";
import { ErrorCodes } from "vscode-jsonrpc/node";
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
	arrangeEdits(module: string, request: ArrangeEditsRequest): Promise<MoveEditsResponse>;
	importEdits(module: string, request: ImportEditsRequest): Promise<ImportEditsResponse>;
	/** Facts for `request.answer` with every proposed text as one view, asked of `module`'s owner. */
	probeBatch(module: string, request: ProbeBatchRequest): Promise<ProbeBatchResponse>;
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
		arrangeEdits: (module, request) => supervisor.ask(module, "arrangeEdits", request),
		async importEdits(module, request) {
			try {
				return await supervisor.ask(module, "importEdits", request);
			} catch (error) {
				// Only an unknown method means unsupported.
				if ((error as { code?: number }).code !== ErrorCodes.MethodNotFound) throw error;
				return { status: "refused", reason: "NotImplemented", detail: "the provider does not plan imports" };
			}
		},
		probeBatch: (module, request) => supervisor.ask(module, "probeBatch", request),

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
