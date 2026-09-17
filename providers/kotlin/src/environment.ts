import type { Declaration } from "@nyaa-lexicon/protocol";
import type { DeclaredNodes, Frame, ImportInfo } from "./facts.js";
import { childOfType, type SyntaxNode, type SyntaxTree } from "./tree.js";
import { supertypePaths } from "./typePaths.js";

/** What a Kotlin file declares, as the use walk and the binder read it. Built once per parse. */
export interface ScopeEnvironment {
	declaredAt(node: SyntaxNode): Declaration | undefined;
	/** The declaration owning the uses inside a node. */
	ownerAt(node: SyntaxNode): string | undefined;
	namesDeclaration(node: SyntaxNode): boolean;
	/** Keyed by the import's source name. */
	importAt(node: SyntaxNode): ImportInfo | undefined;
	declaresType(name: string): boolean;
	/** The frame's parents are already linked. */
	scopeOpenedBy(node: SyntaxNode): Frame | undefined;
}

export interface EnvironmentInput {
	declarations: Declaration[];
	nodes: DeclaredNodes;
	importNames: ReadonlyMap<SyntaxNode, ImportInfo>;
}

const TYPE_KINDS: ReadonlySet<string> = new Set(["class", "interface", "enum", "package"]);

const CLASS_NODES: ReadonlySet<string> = new Set([
	"class_declaration",
	"object_declaration",
	"companion_object",
	"enum_entry",
]);

/** Scopes holding only what they declare. */
const PLAIN_FRAMES: ReadonlySet<string> = new Set([
	"block",
	"for_statement",
	"catch_block",
	"when_expression",
	"anonymous_initializer",
]);

const BODY_NODES: ReadonlySet<string> = new Set(["class_body", "enum_class_body"]);

/** Directly in a class body, so an outer class's constructor parameters are out of reach. */
function classMember(node: SyntaxNode): boolean {
	const parent = node.parent;
	return parent !== null && BODY_NODES.has(parent.type) && parent.parent?.type !== "object_literal";
}

/** Where a local becomes visible. */
function visibleFrom(node: SyntaxNode): number {
	if (node.type === "property_declaration") return node.end;
	if (node.type === "function_declaration" || CLASS_NODES.has(node.type)) return node.start;
	if (node.type !== "variable_declaration") return 0;
	let holder = node.parent;
	if (holder?.type === "multi_variable_declaration") holder = holder.parent;
	return holder?.type === "property_declaration" || holder?.type === "when_subject" ? holder.end : 0;
}

function extensionProperty(node: SyntaxNode): boolean {
	if (node.type !== "property_declaration") return false;
	const variable = childOfType(node, "variable_declaration");
	if (variable === undefined) return false;
	return node.children.slice(0, node.children.indexOf(variable)).some((child) => child.type === ".");
}

function modifierWords(text: string, node: SyntaxNode): string[] {
	const modifiers = childOfType(node, "modifiers");
	return modifiers === undefined ? [] : modifiers.children.map((child) => text.slice(child.start, child.end));
}

/** The scope tree, in one pass, so every frame stands complete before a use reads it. */
class ScopeBuilder {
	private readonly opened = new Map<SyntaxNode, Frame>();
	private frame: Frame | undefined;

	constructor(
		private readonly text: string,
		private readonly nodes: DeclaredNodes,
	) {}

	build(tree: SyntaxTree): Map<SyntaxNode, Frame> {
		const stack: Array<{ node: SyntaxNode; exit: boolean; outer?: Frame | undefined }> = [
			{ node: tree.root, exit: false },
		];
		while (stack.length > 0) {
			const { node, exit, outer } = stack.pop() as { node: SyntaxNode; exit: boolean; outer?: Frame };
			if (exit) {
				this.frame = outer;
				continue;
			}
			const enclosing = this.frame;
			this.enterScope(node);
			stack.push({ node, exit: true, outer: enclosing });
			for (let index = node.children.length - 1; index >= 0; index--)
				stack.push({ node: node.children[index] as SyntaxNode, exit: false });
		}
		return this.opened;
	}

	/** Declares a local into the enclosing frame, then opens the node's own. */
	private enterScope(node: SyntaxNode): void {
		const declared = this.nodes.declarations.get(node);
		if (declared?.visibility === "local" && this.frame !== undefined) {
			const names = this.frame.names ?? new Map();
			this.frame.names = names;
			const entries = names.get(declared.name) ?? [];
			names.set(declared.name, entries);
			entries.push({
				declaration: declared,
				// An object's members see each other, never its supertype arguments.
				from: this.frame.receiver?.kind === "anonymous" ? (node.parent?.start ?? 0) : visibleFrom(node),
				...(node.type === "class_parameter" ? { initializerOnly: true } : {}),
			});
		}
		const frame = this.frameOf(node, declared);
		if (frame !== undefined) {
			this.opened.set(node, frame);
			this.frame = frame;
		}
	}

	private frameOf(node: SyntaxNode, declared: Declaration | undefined): Frame | undefined {
		const parent = this.frame;
		if (PLAIN_FRAMES.has(node.type)) return { parent };
		switch (node.type) {
			case "lambda_literal":
				return {
					parent,
					...(childOfType(node, "lambda_parameters") === undefined ? { implicitIt: true } : {}),
				};
			case "object_literal":
				return { parent, receiver: { kind: "anonymous", supertypes: supertypePaths(this.text, node) } };
			case "getter":
			case "setter":
				return { parent, field: true, member: node.parent !== null && classMember(node.parent) };
			case "secondary_constructor":
				return { parent, member: classMember(node) };
		}
		if (declared === undefined) return undefined;
		if (CLASS_NODES.has(node.type)) {
			const inner = modifierWords(this.text, node).includes("inner");
			const nested = classMember(node) && !inner && node.type !== "enum_entry";
			return {
				parent,
				member: classMember(node),
				receiver: { kind: "class", classId: declared.symbolId, label: declared.name, nested },
			};
		}
		const extension = declared.languageKind?.split(" ").includes("extensionFunction") || extensionProperty(node);
		if (node.type === "function_declaration" || extension)
			return {
				parent,
				member: classMember(node),
				...(extension
					? { receiver: { kind: "extension", declarationId: declared.symbolId, label: declared.name } }
					: {}),
			};
		return undefined;
	}
}

/** Keyed by node identity: a wrapper and its identifier can span one range. */
class Environment implements ScopeEnvironment {
	constructor(
		private readonly nodes: DeclaredNodes,
		private readonly importNames: ReadonlyMap<SyntaxNode, ImportInfo>,
		private readonly typeNames: ReadonlySet<string>,
		private readonly scopes: ReadonlyMap<SyntaxNode, Frame>,
	) {}

	declaredAt(node: SyntaxNode): Declaration | undefined {
		return this.nodes.declarations.get(node);
	}

	/** The declaration owning the uses inside a node. */
	ownerAt(node: SyntaxNode): string | undefined {
		return this.nodes.owners.has(node) ? this.nodes.declarations.get(node)?.symbolId : undefined;
	}

	namesDeclaration(node: SyntaxNode): boolean {
		return this.nodes.names.has(node);
	}

	/** Keyed by the import's source name. */
	importAt(node: SyntaxNode): ImportInfo | undefined {
		return this.importNames.get(node);
	}

	declaresType(name: string): boolean {
		return this.typeNames.has(name);
	}

	/** The frame's parents are already linked. */
	scopeOpenedBy(node: SyntaxNode): Frame | undefined {
		return this.scopes.get(node);
	}
}

export function buildEnvironment(text: string, tree: SyntaxTree, input: EnvironmentInput): ScopeEnvironment {
	const typeNames = new Set(
		input.declarations
			.filter((declaration) => TYPE_KINDS.has(declaration.kind))
			.map((declaration) => declaration.name),
	);
	const scopes = new ScopeBuilder(text, input.nodes).build(tree);
	return new Environment(input.nodes, input.importNames, typeNames, scopes);
}
