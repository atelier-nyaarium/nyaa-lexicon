// Which provider owns a file.
//
// Pure, because this is where a language check would otherwise creep into the core. Providers
// state what they claim at initialize; nothing here knows what any of those claims mean.

import type { FileContent } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export interface ProviderClaims {
	providerId: string;
	language: string;
	/** Extensions with their dot, e.g. ".ts". Compared case-insensitively. */
	extensions: string[];
	/** Exact filenames claimed regardless of extension, e.g. "project.godot". */
	filenames?: string[];
	/** As declared at initialize; absent means code, resolved here once. */
	content?: FileContent;
}

/** Why routing answered as it did, so a caller can report an unowned file honestly. */
export type Route =
	| { owned: true; providerId: string; content: FileContent }
	| { owned: false; reason: "unclaimed" }
	| { owned: false; reason: "contested"; providerIds: string[] };

////////////////////////////////
//  Functions & Helpers

function basenameOf(module: string): string {
	const cut = module.lastIndexOf("/");
	return cut === -1 ? module : module.slice(cut + 1);
}

function extensionOf(module: string): string {
	const name = basenameOf(module);
	const dot = name.lastIndexOf(".");
	// A leading dot is the whole name (".gitignore"), not an extension.
	return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Route one module to its provider.
 *
 * An exact filename beats an extension, so a provider claiming `project.godot` wins over one
 * claiming `.godot` generally. Two providers claiming the same file is CONTESTED rather than
 * first-wins: picking one silently would make indexing depend on registration order, which is not
 * something anyone can debug from the output.
 */
export function routeModule(module: string, providers: ProviderClaims[]): Route {
	const name = basenameOf(module);
	const byName = providers.filter((p) => p.filenames?.includes(name));
	const candidates = byName.length > 0 ? byName : matchByExtension(module, providers);

	if (candidates.length === 0) return { owned: false, reason: "unclaimed" };
	if (candidates.length > 1) {
		return { owned: false, reason: "contested", providerIds: candidates.map((p) => p.providerId).sort() };
	}
	const owner = candidates[0] as ProviderClaims;
	return { owned: true, providerId: owner.providerId, content: owner.content ?? "code" };
}

function matchByExtension(module: string, providers: ProviderClaims[]): ProviderClaims[] {
	const extension = extensionOf(module);
	if (extension === "") return [];
	return providers.filter((p) => p.extensions.some((e) => e.toLowerCase() === extension));
}

/** Every module a provider claims, for a bulk pass that asks one provider for its whole set. */
export function modulesFor(providerId: string, modules: string[], providers: ProviderClaims[]): string[] {
	return modules.filter((module) => {
		const route = routeModule(module, providers);
		return route.owned && route.providerId === providerId;
	});
}
