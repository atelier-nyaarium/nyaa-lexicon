import { defined } from "@nyaa-lexicon/protocol";
import { walkDeclarations } from "./declarations.js";
import { syntaxDiagnostics } from "./diagnostics.js";
import { buildEnvironment } from "./environment.js";
import type { KotlinFile } from "./facts.js";
import { walkUses } from "./references.js";
import { parseSource } from "./repairs.js";
import { childOfType, childrenOfType, LineTable, type SyntaxNode } from "./tree.js";
import { typePath } from "./typePaths.js";

const JVM_STATIC = "kotlin.jvm.JvmStatic";

/** Explicit imports, then the default `kotlin.jvm`. */
function annotationName(path: string[], imports: KotlinFile["imports"]): string {
	const [first, ...rest] = path;
	const imported = imports.find((item) => !item.star && item.localName === first);
	if (imported !== undefined) return [imported.specifier, ...rest].join(".");
	return path.length === 1 && first === "JvmStatic" ? JVM_STATIC : path.join(".");
}

/** Use-site targets excluded. */
function hasJvmStatic(node: SyntaxNode, text: string, imports: KotlinFile["imports"]): boolean {
	const modifiers = childOfType(node, "modifiers");
	if (modifiers === undefined) return false;
	for (const annotation of childrenOfType(modifiers, "annotation")) {
		if (childOfType(annotation, "use_site_target") !== undefined) continue;
		for (const child of annotation.children) {
			const type = child.type === "constructor_invocation" ? childOfType(child, "user_type") : child;
			const path = typePath(text, type);
			if (path !== undefined && annotationName(path, imports) === JVM_STATIC) return true;
		}
	}
	return false;
}

function fileRole(
	declarations: KotlinFile["declarations"],
	text: string,
	declarationNodes: ReadonlyMap<SyntaxNode, KotlinFile["declarations"][number]>,
	imports: KotlinFile["imports"],
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
		return node !== undefined && hasJvmStatic(node, text, imports);
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
		? { references: [], literals: [], comments: [], blankLines: undefined }
		: walkUses(text, tree, lines, buildEnvironment(text, tree, facts));
	return {
		module,
		...defined({ packageName: facts.packageName }),
		declarations: facts.declarations,
		references: uses.references,
		imports: facts.imports,
		literals: uses.literals,
		comments: uses.comments,
		...defined({ blankLines: uses.blankLines }),
		typeFacts: facts.typeFacts,
		supertypes: facts.supertypes,
		receiverTypes: facts.receiverTypes,
		diagnostics: syntaxDiagnostics(module, parsed, lines),
		role: fileRole(facts.declarations, text, facts.nodes.declarations, facts.imports),
	};
}
