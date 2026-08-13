// Maps the scanner's facts onto the protocol's shared declaration types.

import {
	composeSymbolId,
	type Declaration,
	type Diagnostic,
	type Literal,
	type Reference,
} from "@nyaa-lexicon/protocol";
import {
	extractDeclarationsCore,
	extractDiagnosticsCore,
	extractImportsCore,
	extractLiteralsCore,
	extractReferencesCore,
} from "./extractCore.js";

//////// Constants

export const LANGUAGE = "gdscript";

//////// Functions

export function extractFile(
	module: string,
	text: string,
): {
	declarations: Declaration[];
	references: Reference[];
	imports: ReturnType<typeof extractImportsCore>;
	literals: Literal[];
	diagnostics: Diagnostic[];
} {
	const declarations = extractDeclarationsCore(module, text, composeSymbolId);
	return {
		declarations: declarations as Declaration[],
		references: extractReferencesCore(module, text, composeSymbolId),
		imports: extractImportsCore(module, text, composeSymbolId),
		literals: extractLiteralsCore(module, text, declarations),
		diagnostics: extractDiagnosticsCore(module, text),
	};
}

export function extractDeclarations(module: string, text: string): Declaration[] {
	return extractFile(module, text).declarations;
}
