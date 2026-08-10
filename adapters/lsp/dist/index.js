////////////////////////////////
//  Interfaces & Types
/**
 * DECLARED STUB. See CLAUDE.md > Known Stubs and Placeholders.
 *
 * The package boundary is real; the body is not. MCP proves the seam first, so
 * this ships as a name and a vocabulary through the foundation plan.
 *
 * The standard requests this will serve, plus namespaced custom methods for the
 * questions LSP has no vocabulary for (describe, why, relate).
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
];
/** Namespace for the custom methods. Kept apart so a standard request is never shadowed. */
export const LSP_CUSTOM_NAMESPACE = "lexicon/";
//# sourceMappingURL=index.js.map