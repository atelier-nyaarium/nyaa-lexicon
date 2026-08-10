import ts from "typescript";

export const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

export function claimsExtension(module: string): boolean {
	return EXTENSIONS.some((extension) => module.endsWith(extension));
}

export function scriptKindOf(fileName: string): ts.ScriptKind {
	if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
	if (/\.(js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}
