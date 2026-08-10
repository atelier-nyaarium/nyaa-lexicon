// Maps the scanner's facts onto the protocol's shared declaration types.

import { composeSymbolId, type Declaration, type Literal, type Reference } from "@nyaa-lexicon/protocol";
import {
	extractDeclarationsCore,
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
} {
	const declarations = extractDeclarationsCore(module, text, composeSymbolId);
	return {
		declarations: declarations as Declaration[],
		references: extractReferencesCore(module, text, composeSymbolId),
		imports: extractImportsCore(module, text, composeSymbolId),
		literals: extractLiteralsCore(module, text, declarations),
	};
}

export function extractDeclarations(module: string, text: string): Declaration[] {
	return extractFile(module, text).declarations;
}
