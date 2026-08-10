////////////////////////////////
//  Interfaces & Types

/**
 * The vocabulary. `LspServer` answers the subset marked below; the rest are still names.
 *
 * Kept as a list rather than trimmed to what is built, because it states the target and makes the
 * gap between target and body visible instead of implied.
 *
 * ANSWERED: hover, definition, references, documentSymbol, prepareRename, rename.
 * NOT YET: typeDefinition, implementation, both call hierarchies, both type hierarchies.
 */
export const LSP_STANDARD_METHODS = [
	"textDocument/hover",
	"textDocument/definition",
	"textDocument/typeDefinition",
	"textDocument/implementation",
	"textDocument/references",
	"textDocument/documentSymbol",
	"callHierarchy/incomingCalls",
	"callHierarchy/outgoingCalls",
	"typeHierarchy/supertypes",
	"typeHierarchy/subtypes",
] as const;

/** Namespace for the custom methods. Kept apart so a standard request is never shadowed. */
export const LSP_CUSTOM_NAMESPACE = "lexicon/" as const;

export {
	type DocumentSymbol,
	type Hover,
	type Location,
	LspServer,
	type Position,
	type Range,
	toModule,
	toUri,
} from "./server.js";
export { createReader, encode, type Message } from "./transport.js";
