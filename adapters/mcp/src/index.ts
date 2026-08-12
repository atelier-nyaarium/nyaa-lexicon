import { PROJECT_TOOL_NAMES } from "./projectTools.js";

export { PROJECT_TOOL_NAMES, PROJECT_TOOL_NAMES as MCP_TOOL_NAMES };

export type ProjectToolName = (typeof PROJECT_TOOL_NAMES)[number];
export type McpToolName = ProjectToolName;
