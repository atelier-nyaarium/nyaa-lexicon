// Maps the scanner's facts onto the protocol's shared declaration types.

import {
	composeSymbolId,
	type Declaration,
	type Diagnostic,
	type Literal,
	type Reference,
} from "@nyaa-lexicon/protocol";
import {
	type CommentSpan,
	extractDeclarationsCore,
	extractDiagnosticsCore,
	extractImportsCore,
	extractLayoutCore,
	extractLiteralsCore,
	extractLoaderCallsCore,
	extractReferencesCore,
	type LoaderCall,
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
	comments: CommentSpan[];
	blankLines: number[];
	diagnostics: Diagnostic[];
	loaders: LoaderCall[];
} {
	const declarations = extractDeclarationsCore(module, text, composeSymbolId);
	const layout = extractLayoutCore(text);
	return {
		declarations: declarations as Declaration[],
		references: extractReferencesCore(module, text, composeSymbolId),
		imports: extractImportsCore(module, text, composeSymbolId),
		literals: extractLiteralsCore(module, text, declarations),
		comments: layout.comments,
		blankLines: layout.blankLines,
		diagnostics: extractDiagnosticsCore(module, text),
		loaders: extractLoaderCallsCore(module, text, composeSymbolId),
	};
}

export function extractDeclarations(module: string, text: string): Declaration[] {
	return extractDeclarationsCore(module, text, composeSymbolId) as Declaration[];
}
