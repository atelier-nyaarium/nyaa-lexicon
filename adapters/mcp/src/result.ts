export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean | undefined;
}

export function textResult(body: string, isError = false): ToolResult {
	return {
		content: [{ type: "text", text: body }],
		...(isError ? { isError: true } : {}),
	};
}
