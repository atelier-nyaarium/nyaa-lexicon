////////////////////////////////
//  Interfaces & Types

/**
 * The agent-facing tool names.
 *
 * One query vocabulary lives in core; both adapters are thin translators over it.
 * These names are the MCP spelling of it, and they stay boringly descriptive: an
 * agent decides whether to call a tool from its name and description alone.
 */
export const MCP_TOOL_NAMES = [
	"describe_symbol",
	"find_references",
	"resolve_import",
	"type_of",
	"prepare_rename",
	"rename_symbol",
	"find_literals",
	"graph_of",
	"co_changed_with",
	"overview",
	"search_symbols",
	"outline_module",
	"find_imports",
	"hubs",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
