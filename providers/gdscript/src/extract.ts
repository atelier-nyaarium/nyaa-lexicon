// Maps one parse's facts onto the protocol's shared declaration types.

import {
	composeSymbolId,
	type Declaration,
	type Diagnostic,
	type Literal,
	type Reference,
} from "@nyaa-lexicon/protocol";
import { declarationsOf, scriptHeaderOf } from "./declarations.js";
import { diagnosticsOf } from "./diagnostics.js";
import { type ImportFact, importsOf, loaderCallsOf } from "./imports.js";
import { layoutOf } from "./layout.js";
import type { CommentSpan } from "./lexer.js";
import { literalsOf } from "./literal-tokens.js";
import type { LoaderCall } from "./path-syntax.js";
import { referencesOf } from "./references.js";
import { ParsedScript } from "./script.js";
import { type TypeAnnotationFact, typeAnnotationsOf } from "./type-facts.js";

//////// Constants

export const LANGUAGE = "gdscript";

//////// Types

export interface OutlineFacts {
	declarations: Declaration[];
	/** The script's `extends` target. */
	base?: string;
}

export interface FileFacts extends OutlineFacts {
	references: Reference[];
	imports: ImportFact[];
	literals: Literal[];
	comments: CommentSpan[];
	blankLines: number[];
	diagnostics: Diagnostic[];
	loaders: LoaderCall[];
	annotations: TypeAnnotationFact[];
}

//////// Functions

function outlineOf(script: ParsedScript): OutlineFacts {
	const base = scriptHeaderOf(script.lexed)?.base;
	return { declarations: declarationsOf(script) as Declaration[], ...(base === undefined ? {} : { base }) };
}

export function extractFile(module: string, text: string): FileFacts {
	const script = new ParsedScript(module, text, composeSymbolId);
	const declarations = declarationsOf(script);
	const base = scriptHeaderOf(script.lexed)?.base;
	const layout = layoutOf(script.lexed);
	const loaders = loaderCallsOf(script);
	return {
		declarations: declarations as Declaration[],
		...(base === undefined ? {} : { base }),
		references: referencesOf(script),
		imports: importsOf(script, loaders),
		literals: literalsOf(script, declarations, loaders),
		comments: layout.comments,
		blankLines: layout.blankLines,
		diagnostics: diagnosticsOf(module, script.lexed),
		loaders,
		annotations: typeAnnotationsOf(script),
	};
}

export function extractOutline(module: string, text: string): OutlineFacts {
	return outlineOf(new ParsedScript(module, text, composeSymbolId));
}

export function extractDeclarations(module: string, text: string): Declaration[] {
	return extractOutline(module, text).declarations;
}
