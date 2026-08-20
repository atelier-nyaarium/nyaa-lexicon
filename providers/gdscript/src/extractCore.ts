// Owns compatibility re-exports for the GDScript extractor.

export { isGdscriptIdentifier } from "./cursor.js";
export { extractDeclarationsCore, headerEndLine } from "./declarations.js";
export { extractDiagnosticsCore } from "./diagnostics.js";
export type { ImportFact } from "./imports.js";
export { extractImportsCore } from "./imports.js";
export { extractLiteralsCore } from "./literal-tokens.js";
export type { DeclarationFact, DeclarationKind, Descriptor, Visibility } from "./parse-model.js";
export { extractGdscriptParameterNames, extractReferencesCore } from "./references.js";
export type { CommentSpan } from "./source-scan.js";
export { extractCommentsCore } from "./source-scan.js";
export type { TypeAnnotationFact } from "./type-facts.js";
export { extractTypeAnnotationsCore } from "./type-facts.js";
