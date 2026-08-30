// What core asks of the provider set, owned here by the callers: a member the indexer starts
// calling is a type error in every fake before it can be a runtime one.

import type { METHOD_SCHEMAS, ProviderMethod, ProviderTiers } from "@nyaa-lexicon/protocol";
import type { z } from "zod";
import type { ProviderClaims, Route } from "./routing.js";
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
	observeWorkspace(modules: Iterable<string>): void;
	observeModule(module: string): void;
	declares(providerId: string, tier: keyof ProviderTiers): boolean;
	ask<K extends ProviderMethod>(module: string, method: K, params: unknown): Promise<MethodResponse<K>>;
	askProvider<K extends ProviderMethod>(providerId: string, method: K, params: unknown): Promise<MethodResponse<K>>;
}

/** What starts a provider, for the one caller that does. */
export type ProviderStarter = Pick<ProviderSupervisor, "start">;
