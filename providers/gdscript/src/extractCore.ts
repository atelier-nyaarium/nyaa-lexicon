// Owns compatibility re-exports for the GDScript extractor.

export { isGdscriptIdentifier } from "./cursor.js";
export { extractDeclarationsCore } from "./declarations.js";
export { extractDiagnosticsCore } from "./diagnostics.js";
export type { ImportFact } from "./imports.js";
export { extractImportsCore, extractLoaderCallsCore } from "./imports.js";
export type { Layout } from "./layout.js";
export { extractLayoutCore } from "./layout.js";
export { extractLiteralsCore } from "./literal-tokens.js";
export type { DeclarationFact, DeclarationKind, Descriptor, Visibility } from "./parse-model.js";
export type { LoaderCall } from "./path-syntax.js";
export { extractGdscriptParameterNames, extractReferencesCore } from "./references.js";
export type { CommentSpan } from "./source-scan.js";
export type { TypeAnnotationFact } from "./type-facts.js";
export { extractTypeAnnotationsCore } from "./type-facts.js";
