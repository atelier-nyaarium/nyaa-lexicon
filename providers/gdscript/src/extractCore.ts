// Owns the text-taking extractor entry points, each over one fresh parse.

import type { Reference } from "@nyaa-lexicon/protocol";
import { declarationsOf } from "./declarations.js";
import type { ComposeSymbolId, DeclarationFact } from "./parse-model.js";
import { referencesOf } from "./references.js";
import { ParsedScript } from "./script.js";
import { type TypeAnnotationFact, typeAnnotationsOf } from "./type-facts.js";

export { isGdscriptIdentifier } from "./characters.js";
export type { ImportFact } from "./imports.js";
export type { Layout } from "./layout.js";
export type { CommentSpan } from "./lexer.js";
export type { DeclarationFact, DeclarationKind, Descriptor, Visibility } from "./parse-model.js";
export type { LoaderCall } from "./path-syntax.js";
export type { TypeAnnotationFact } from "./type-facts.js";

export function extractDeclarationsCore(module: string, text: string, compose: ComposeSymbolId): DeclarationFact[] {
	return declarationsOf(new ParsedScript(module, text, compose));
}

export function extractReferencesCore(module: string, text: string, compose: ComposeSymbolId): Reference[] {
	return referencesOf(new ParsedScript(module, text, compose));
}

export function extractTypeAnnotationsCore(
	module: string,
	text: string,
	compose: ComposeSymbolId,
): TypeAnnotationFact[] {
	return typeAnnotationsOf(new ParsedScript(module, text, compose));
}
