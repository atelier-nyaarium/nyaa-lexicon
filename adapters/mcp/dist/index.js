////////////////////////////////
//  Interfaces & Types
/**
 * The agent-facing tool names.
 *
 * One query vocabulary lives in core; both adapters are thin translators over it.
 * These names are the MCP spelling of it, and they stay boringly descriptive: an
 * agent decides whether to call a tool from its name and description alone.
 *
 * Phase 5 implements them. Only the vocabulary is pinned here.
 */
export const MCP_TOOL_NAMES = ["describe_symbol", "find_references", "resolve_import"];
//# sourceMappingURL=index.js.map