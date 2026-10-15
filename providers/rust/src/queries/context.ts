import type { ParsedFile } from "../model.js";
import type { RustProjectResolver } from "../project.js";
import type { ScopeResolver } from "../scopes.js";

export const PROVIDER_ID = "rust-provider";
export const LANGUAGE = "rust";

export interface RustQueryContext {
	readonly factsForModule: (module: string) => ParsedFile | null;
	readonly resolver: RustProjectResolver;
	readonly scopes: ScopeResolver;
}

export abstract class RustQueryService {
	constructor(private readonly context: RustQueryContext) {}

	protected get factsForModule() {
		return this.context.factsForModule;
	}

	protected get resolver() {
		return this.context.resolver;
	}

	protected get scopes() {
		return this.context.scopes;
	}
}
