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
	/** Claimed only where a file with one of the `beside` extensions exists; outranks a plain claim. */
	sharedExtensions?: Array<{ extension: string; beside: string[] }>;
	fallback?: boolean;
	/** As declared at initialize; absent means code, resolved here once. */
	content?: FileContent;
}

/** What the workspace holds, which is what a shared claim is conditioned on. */
export interface RoutingContext {
	/** Whether any file with this extension (with its dot, any case) is in the workspace. */
	hasExtension: (extension: string) => boolean;
	/** Adds one module as evidence, for a file indexed outside a scan. */
	observe: (module: string) => void;
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
export function routeModule(module: string, providers: ProviderClaims[], context?: RoutingContext): Route {
	const name = basenameOf(module);
	const byName = providers.filter((p) => p.filenames?.includes(name));
	const shared = byName.length > 0 || context === undefined ? [] : matchBySharedExtension(module, providers, context);
	const extensions = matchByExtension(module, providers);
	const fallback = providers.filter((p) => p.fallback === true);
	const candidates =
		byName.length > 0 ? byName : shared.length > 0 ? shared : extensions.length > 0 ? extensions : fallback;

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

/** Providers whose shared claim on this extension holds, given what the workspace contains. */
function matchBySharedExtension(
	module: string,
	providers: ProviderClaims[],
	context: RoutingContext,
): ProviderClaims[] {
	const extension = extensionOf(module);
	if (extension === "") return [];
	return providers.filter((p) =>
		(p.sharedExtensions ?? []).some(
			(claim) => claim.extension.toLowerCase() === extension && claim.beside.some((e) => context.hasExtension(e)),
		),
	);
}

/** Every module a provider claims, for a bulk pass that asks one provider for its whole set. */
export function modulesFor(
	providerId: string,
	modules: string[],
	providers: ProviderClaims[],
	context?: RoutingContext,
): string[] {
	return modules.filter((module) => {
		const route = routeModule(module, providers, context);
		return route.owned && route.providerId === providerId;
	});
}

/** The context for one set of workspace modules: which extensions are present at all. */
export function routingContextOf(modules: Iterable<string>): RoutingContext {
	const present = new Set<string>();
	const observe = (module: string): void => {
		const extension = extensionOf(module);
		if (extension !== "") present.add(extension);
	};
	for (const module of modules) observe(module);
	return { hasExtension: (extension) => present.has(extension.toLowerCase()), observe };
}
