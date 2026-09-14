import { defined } from "@nyaa-lexicon/protocol";
import { walkDeclarations } from "./declarations.js";
import { syntaxDiagnostics } from "./diagnostics.js";
import type { KotlinFile } from "./facts.js";
import { walkUses } from "./references.js";
import { parseSource } from "./repairs.js";
import { LineTable } from "./tree.js";

/** Outline skips uses, literals, comments and types. */
export function parseKotlin(module: string, text: string, outline = false): KotlinFile {
	const parsed = parseSource(text);
	const { tree } = parsed;
	const lines = new LineTable(text);
	const facts = walkDeclarations(module, text, tree, lines, outline);
	const uses = outline
		? { references: [], literals: [], comments: [] }
		: walkUses(text, tree, lines, facts.declarations, facts.importNames);
	return {
		module,
		...defined({ packageName: facts.packageName }),
		declarations: facts.declarations,
		references: uses.references,
		imports: facts.imports,
		literals: uses.literals,
		comments: uses.comments,
		typeFacts: facts.typeFacts,
		supertypes: facts.supertypes,
		receiverTypes: facts.receiverTypes,
		diagnostics: syntaxDiagnostics(module, parsed, lines),
	};
}
