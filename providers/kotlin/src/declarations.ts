import { defined } from "@nyaa-lexicon/protocol";
import {
	classParameter,
	functionDeclaration,
	parameter,
	primaryConstructor,
	secondaryConstructor,
	setterParameter,
	typeParameter,
} from "./declarationCallables.js";
import type { DeclarationWalk, Scope } from "./declarationScope.js";
import { identifiers } from "./declarationShape.js";
import { DeclarationSink, type SinkFacts } from "./declarationSink.js";
import { enumEntry, typeAlias, typeDeclaration } from "./declarationTypes.js";
import { binder, boundVariables, catchParameter, property } from "./declarationValues.js";
import type { ImportInfo } from "./facts.js";
import { importDirectiveOf, packageHeaderOf } from "./headers.js";
import { type LineTable, nameText, type SyntaxNode, type SyntaxTree } from "./tree.js";

export interface DeclarationFacts extends SinkFacts {
	packageName?: string;
	imports: ImportInfo[];
	/** Import directive per source name node. */
	importNames: Map<SyntaxNode, ImportInfo>;
}

class DeclarationWalker implements DeclarationWalk {
	private readonly imports: ImportInfo[] = [];
	private readonly importNames = new Map<SyntaxNode, ImportInfo>();
	readonly sink: DeclarationSink;
	private packageName: string | undefined;

	constructor(
		private readonly module: string,
		readonly text: string,
		readonly tree: SyntaxTree,
		readonly lines: LineTable,
		outline: boolean,
	) {
		this.sink = new DeclarationSink(module, text, lines, outline);
	}

	walk(): DeclarationFacts {
		const stack: Array<{ node: SyntaxNode; scope: Scope }> = [];
		const root: Scope = { descriptors: [] };
		for (let index = this.tree.root.children.length - 1; index >= 0; index--)
			stack.push({ node: this.tree.root.children[index] as SyntaxNode, scope: root });
		while (stack.length > 0) {
			const { node, scope } = stack.pop() as { node: SyntaxNode; scope: Scope };
			const inner = this.enter(node, scope);
			if (inner === null) continue;
			for (let index = node.children.length - 1; index >= 0; index--)
				stack.push({ node: node.children[index] as SyntaxNode, scope: inner });
		}
		return {
			...defined({ packageName: this.packageName }),
			imports: this.imports,
			importNames: this.importNames,
			...this.sink.facts(),
		};
	}

	/** The scope a node's children see, or null to skip them. */
	private enter(node: SyntaxNode, scope: Scope): Scope | null {
		switch (node.type) {
			case "package_header":
				this.packageHeader(node);
				return null;
			case "import":
				this.importDirective(node);
				return null;
			case "class_declaration":
			case "object_declaration":
			case "companion_object":
				return typeDeclaration(this, node, scope);
			case "type_alias":
				return typeAlias(this, node, scope);
			case "primary_constructor":
				return primaryConstructor(this, node, scope);
			case "class_parameter":
				classParameter(this, node, scope);
				return scope;
			case "enum_entry":
				return enumEntry(this, node, scope);
			case "function_declaration":
				return functionDeclaration(this, node, scope);
			case "secondary_constructor":
				return secondaryConstructor(this, node, scope);
			case "anonymous_initializer":
				return { ...scope, descriptors: [...scope.descriptors, { kind: "meta", name: "init" }] };
			case "parameter":
				if (node.parent?.type === "function_value_parameters") parameter(this, node, scope);
				return scope;
			case "type_parameter":
				typeParameter(this, node, scope);
				return scope;
			case "property_declaration":
				return property(this, node, scope);
			case "setter":
				setterParameter(this, node, scope);
				return scope;
			case "lambda_parameters":
				for (const variable of boundVariables(node)) binder(this, variable, scope, "lambdaParameter");
				return scope;
			case "for_statement":
				for (const variable of boundVariables(node)) binder(this, variable, scope, "for");
				return scope;
			case "when_subject":
				for (const variable of boundVariables(node)) binder(this, variable, scope, "val", "term");
				return scope;
			case "catch_block": {
				const name = identifiers(node)[0];
				if (name !== undefined && nameText(this.text, name) !== "_") catchParameter(this, node, name, scope);
				return scope;
			}
			default:
				return scope;
		}
	}

	private packageHeader(node: SyntaxNode): void {
		const header = packageHeaderOf(this.module, this.text, this.lines, node);
		if (header === undefined) return;
		this.packageName = header.name;
		this.sink.push(header.declaration);
	}

	private importDirective(node: SyntaxNode): void {
		const directive = importDirectiveOf(this.text, this.lines, node);
		if (directive === undefined) return;
		this.imports.push(directive.info);
		if (directive.source !== undefined) this.importNames.set(directive.source, directive.info);
	}
}

export function walkDeclarations(
	module: string,
	text: string,
	tree: SyntaxTree,
	lines: LineTable,
	outline: boolean,
): DeclarationFacts {
	return new DeclarationWalker(module, text, tree, lines, outline).walk();
}
