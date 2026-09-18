// What core asks of the provider set, owned here by the callers: a member the indexer starts
// calling is a type error in every fake before it can be a runtime one.

import type {
	METHOD_SCHEMAS,
	ModuleAdmission,
	ProviderMethod,
	ProviderTiers,
	ProviderWords,
} from "@nyaa-lexicon/protocol";
import type { z } from "zod";
import type { HeadReader, ProviderClaims, Route } from "./routing.js";
import type { ProviderSupervisor } from "./supervisor.js";

////////////////////////////////
//  Interfaces & Types

export type MethodRequest<K extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[K]["request"]>;

export type MethodResponse<K extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[K]["response"]>;

/** Reading and asking only; nothing here starts or stops a process. */
export interface ProviderPort {
	running(): ProviderClaims[];
	route(module: string): Route;
	evidenceFrom(modules: () => Iterable<string>): void;
	/** Where a module's first line comes from, for a shebang claim. */
	headFrom(read: HeadReader): void;
	observeWorkspace(modules: Iterable<string>): void;
	observeModule(module: string): void;
	declares(providerId: string, tier: keyof ProviderTiers): boolean;
	/** The vocabulary the provider announced at initialize; undefined when it is not running. */
	words(providerId: string): ProviderWords | undefined;
	ask<K extends ProviderMethod>(module: string, method: K, params: unknown): Promise<MethodResponse<K>>;
	askProvider<K extends ProviderMethod>(providerId: string, method: K, params: unknown): Promise<MethodResponse<K>>;
	/** Tells every provider a module is gone. Not awaited. */
	forget(module: string): void;
	/** Which process answers for this provider now; null when none does. */
	incarnationOf(providerId: string): number | null;
	/**
	 * Tells the process that ANSWERED the parse what the index did with it. Not awaited.
	 *
	 * The incarnation is read before the parse and handed back here, so a provider that restarted
	 * under the same id meanwhile is not told about a parse its fresh ledger never staged.
	 */
	admission(providerId: string, incarnation: number | null, verdict: ModuleAdmission): void;
}

/** What starts a provider, for the one caller that does. */
export type ProviderStarter = Pick<ProviderSupervisor, "start">;
