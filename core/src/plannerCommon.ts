import { normalizeModulePath } from "@nyaa-lexicon/protocol";
import { type Refusal, unrepresentableModule } from "./refusals.js";

////////////////////////////////
// Functions & Helpers

/** A module a plan may create or write, in its canonical spelling, or why not. */
export function workspaceModule(raw: string): { module: string } | { refused: Refusal } {
	try {
		return { module: normalizeModulePath(raw) };
	} catch (error) {
		return { refused: unrepresentableModule(error instanceof Error ? error.message : String(error)) };
	}
}

/** ExternalDependency, NotIndexed, and DynamicallyTyped are not dangling. */
export function isDangling(reason: string): boolean {
	return reason !== "ExternalDependency" && reason !== "NotIndexed" && reason !== "DynamicallyTyped";
}
