// Owns GDScript static import facts and loader name resolution.

import { coordinatesOf, type ImportedName } from "@nyaa-lexicon/protocol";
import { extractGdscript } from "./declarations.js";
import type { ComposeSymbolId, DeclarationFact, ReferenceToken } from "./parse-model.js";
import { pathSyntax } from "./path-syntax.js";
import { sourceBetween } from "./references.js";
import { readLines } from "./source-scan.js";
import { matchingReferenceToken, nextReferenceToken, referenceTokens } from "./tokens.js";

//////// Imports

export interface ImportFact {
	specifier: string;
	imported: ImportedName[];
	reExport: boolean;
}

function importedLoaderName(declarations: DeclarationFact[], line: number, loaderStart: number): ImportedName[] {
	// Every declaration this provider extracts has its name in the source.
	const declaration = declarations
		.filter(
			(candidate) =>
				candidate.selectionRange !== undefined &&
				candidate.selectionRange.start.line === line &&
				candidate.selectionRange.start.character < loaderStart &&
				candidate.selectionRange.end.character <= loaderStart,
		)
		.sort((left, right) => right.selectionRange.start.character - left.selectionRange.start.character)[0];
	if (declaration === undefined) return [];
	// Every declaration this provider extracts has its name in the source.
	return [{ local: declaration.name, localRange: declaration.selectionRange ?? declaration.range }];
}

export function extractImportsCore(module: string, text: string, compose: ComposeSymbolId): ImportFact[] {
	if (!module.endsWith(".gd")) return [];
	const coordinates = coordinatesOf(text);
	const lines = readLines(text);
	const declarations = extractGdscript(module, text, compose);
	const imports: ImportFact[] = [];
	const literalLoaderPositions = new Set<string>();
	for (const line of lines) {
		for (const path of pathSyntax(line)) {
			if (path.kind === "extends") {
				imports.push({ specifier: path.path, imported: [], reExport: false });
				continue;
			}
			literalLoaderPositions.add(`${line.line}:${path.loaderStart}`);
			imports.push({
				specifier: path.path,
				imported: importedLoaderName(declarations, line.line, path.loaderStart),
				reExport: false,
			});
		}
	}

	const tokens = referenceTokens(lines);
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind !== "identifier" || (token.value !== "preload" && token.value !== "load")) continue;
		const tokenKey = `${token.line}:${token.character}`;
		if (literalLoaderPositions.has(tokenKey)) continue;
		const open = nextReferenceToken(tokens, index);
		if (open < 0 || (tokens[open] as ReferenceToken).value !== "(") continue;
		const close = matchingReferenceToken(tokens, open, "(", ")");
		if (close < 0) continue;
		const closing = tokens[close] as ReferenceToken | undefined;
		if (closing === undefined) continue;
		const specifier = sourceBetween(coordinates, token, closing)?.trim();
		if (specifier === undefined || specifier === "") continue;
		imports.push({
			specifier,
			imported: importedLoaderName(declarations, token.line, token.character),
			reExport: false,
		});
	}
	return imports;
}
