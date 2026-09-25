import { defined } from "@nyaa-lexicon/protocol";
import { walkDeclarations } from "./declarations.js";
import { syntaxDiagnostics } from "./diagnostics.js";
import { buildEnvironment } from "./environment.js";
import type { KotlinFile } from "./facts.js";
import { walkUses } from "./references.js";
import { parseSource } from "./repairs.js";
import { LineTable, type SyntaxNode } from "./tree.js";

/** Supports plain and qualified names. */
function hasJvmStatic(node: SyntaxNode, text: string): boolean {
	const modifiers = node.children.find((child) => child.type === "modifiers");
	return (modifiers?.children ?? []).some(
		(annotation) =>
			annotation.type === "annotation" &&
			/^@(?:[A-Za-z_][A-Za-z0-9_]*\.)*JvmStatic$/.test(text.slice(annotation.start, annotation.end)),
	);
}

function fileRole(
	declarations: KotlinFile["declarations"],
	text: string,
	declarationNodes: ReadonlyMap<SyntaxNode, KotlinFile["declarations"][number]>,
): KotlinFile["role"] {
	const main = declarations.find(
		(declaration) =>
			declaration.kind === "function" &&
			declaration.name === "main" &&
			declaration.containerId === undefined &&
			!declaration.languageKind?.split(" ").includes("extensionFunction"),
	);
	if (main !== undefined) return { kind: "entry", how: "main", symbolId: main.symbolId };

	const declarationsById = new Map(declarations.map((declaration) => [declaration.symbolId, declaration]));
	const syntaxById = new Map<string, SyntaxNode>();
	for (const [node, declaration] of declarationNodes) syntaxById.set(declaration.symbolId, node);
	const staticMain = declarations.find((declaration) => {
		if (
			(declaration.kind !== "method" && declaration.kind !== "function") ||
			declaration.name !== "main" ||
			declaration.containerId === undefined ||
			declaration.languageKind?.split(" ").includes("extensionFunction")
		) {
			return false;
		}
		const owner = declarationsById.get(declaration.containerId);
		if (!owner?.languageKind?.split(" ").some((kind) => kind === "object" || kind === "companionObject")) {
			return false;
		}
		const node = syntaxById.get(declaration.symbolId);
		return node !== undefined && hasJvmStatic(node, text);
	});
	return staticMain === undefined
		? { kind: "library" }
		: { kind: "entry", how: "main", symbolId: staticMain.symbolId };
}

/** An outline answers declarations alone, so it builds no environment. */
export function parseKotlin(module: string, text: string, outline = false): KotlinFile {
	const parsed = parseSource(text);
	const { tree } = parsed;
	const lines = new LineTable(text);
	const facts = walkDeclarations(module, text, tree, lines, outline);
	const uses = outline
		? { references: [], literals: [], comments: [] }
		: walkUses(text, tree, lines, buildEnvironment(text, tree, facts));
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
		role: fileRole(facts.declarations, text, facts.nodes.declarations),
	};
}
