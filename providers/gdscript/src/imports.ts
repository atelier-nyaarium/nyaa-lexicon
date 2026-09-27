// Owns GDScript static import facts and loader name resolution.

import { comparePositions, coordinatesOf, type ImportedName, type Position } from "@nyaa-lexicon/protocol";
import { extractGdscript } from "./declarations.js";
import type { ComposeSymbolId, DeclarationFact } from "./parse-model.js";
import { extendsPaths, type LoaderCall, loaderCalls } from "./path-syntax.js";
import { scanSource } from "./source-scan.js";
import { referenceTokens } from "./tokens.js";

//////// Imports

export interface ImportFact {
	specifier: string;
	imported: ImportedName[];
	reExport: boolean;
}

function importedLoaderName(declarations: DeclarationFact[], loader: Position): ImportedName[] {
	// Every declaration this provider extracts has its name in the source.
	const declaration = declarations
		.filter(
			(candidate) =>
				candidate.selectionRange !== undefined &&
				candidate.selectionRange.start.line === loader.line &&
				candidate.selectionRange.start.character < loader.character &&
				candidate.selectionRange.end.character <= loader.character,
		)
		.sort((left, right) => right.selectionRange.start.character - left.selectionRange.start.character)[0];
	if (declaration === undefined) return [];
	// Every declaration this provider extracts has its name in the source.
	return [{ local: declaration.name, localRange: declaration.selectionRange ?? declaration.range }];
}

function moduleLoaderCalls(module: string, text: string, compose: ComposeSymbolId) {
	const scanned = scanSource(text);
	const tokens = referenceTokens(scanned);
	const declarations = extractGdscript(module, text, compose);
	return { tokens, declarations, calls: loaderCalls(tokens, coordinatesOf(text), declarations) };
}

export function extractLoaderCallsCore(module: string, text: string, compose: ComposeSymbolId): LoaderCall[] {
	return module.endsWith(".gd") ? moduleLoaderCalls(module, text, compose).calls : [];
}

/** Literal paths in source order, then computed loaders. */
export function extractImportsCore(module: string, text: string, compose: ComposeSymbolId): ImportFact[] {
	if (!module.endsWith(".gd")) return [];
	const { tokens, declarations, calls } = moduleLoaderCalls(module, text, compose);
	const literal = [
		...extendsPaths(tokens).map((path) => ({ at: path.range.start, fact: { specifier: path.path, imported: [] } })),
		...calls
			.filter((call) => call.literal !== undefined)
			.map((call) => ({
				at: call.range.start,
				fact: { specifier: call.specifier, imported: importedLoaderName(declarations, call.range.start) },
			})),
	].sort((left, right) => comparePositions(left.at, right.at));
	const computed = calls
		.filter((call) => call.literal === undefined)
		.map((call) => ({ specifier: call.specifier, imported: importedLoaderName(declarations, call.range.start) }));
	return [...literal.map((entry) => entry.fact), ...computed].map((fact) => ({ ...fact, reExport: false }));
}
