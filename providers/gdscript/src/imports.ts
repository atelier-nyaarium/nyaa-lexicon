// Owns GDScript static import facts and loader name resolution.

import { comparePositions, type ImportedName, type Position } from "@nyaa-lexicon/protocol";
import type { DeclarationFact } from "./parse-model.js";
import { extendsPaths, type LoaderCall, loaderCalls } from "./path-syntax.js";
import type { ParsedScript } from "./script.js";

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

export function loaderCallsOf(script: ParsedScript): LoaderCall[] {
	if (!script.module.endsWith(".gd")) return [];
	return loaderCalls(script.lexed.tokens, script.coordinates, script.declarations);
}

/** Literal paths in source order, then computed loaders. */
export function importsOf(script: ParsedScript, calls = loaderCallsOf(script)): ImportFact[] {
	if (!script.module.endsWith(".gd")) return [];
	const { declarations } = script;
	const literal = [
		...extendsPaths(script.lexed.tokens).map((path) => ({
			at: path.range.start,
			fact: { specifier: path.path, imported: [] },
		})),
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
