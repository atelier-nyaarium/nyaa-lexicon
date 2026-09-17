import { type Declaration, defined, type Metrics } from "@nyaa-lexicon/protocol";
import {
	accessOf,
	BODY_TYPES,
	type Context,
	contextOf,
	identifiers,
	LANGUAGE_MODIFIERS,
	leadingAnnotationsSkipped,
	modifiersOf,
	until,
} from "./declarationShape.js";
import { DeclarationSink, type IdScope, type SinkFacts } from "./declarationSink.js";
import type { ImportInfo } from "./facts.js";
import { importDirectiveOf, packageHeaderOf } from "./headers.js";
import { bodyMetrics } from "./metrics.js";
import { render } from "./render.js";
import { childOfType, childrenOfType, type LineTable, nameText, type SyntaxNode, type SyntaxTree } from "./tree.js";
import { supertypePaths, TYPE_NODES } from "./typePaths.js";

interface Scope extends IdScope {
	classId?: string;
	className?: string;
	/** Inside a primary constructor: where its properties land. */
	classScope?: Scope;
}

export interface DeclarationFacts extends SinkFacts {
	packageName?: string;
	imports: ImportInfo[];
	/** Import directive per source name node. */
	importNames: Map<SyntaxNode, ImportInfo>;
}

class DeclarationWalker {
	private readonly imports: ImportInfo[] = [];
	private readonly importNames = new Map<SyntaxNode, ImportInfo>();
	private readonly sink: DeclarationSink;
	private packageName: string | undefined;

	constructor(
		private readonly module: string,
		private readonly text: string,
		private readonly tree: SyntaxTree,
		private readonly lines: LineTable,
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
				return this.typeDeclaration(node, scope);
			case "type_alias":
				return this.typeAlias(node, scope);
			case "primary_constructor":
				return this.primaryConstructor(node, scope);
			case "class_parameter":
				this.classParameter(node, scope);
				return scope;
			case "enum_entry":
				return this.enumEntry(node, scope);
			case "function_declaration":
				return this.functionDeclaration(node, scope);
			case "secondary_constructor":
				return this.secondaryConstructor(node, scope);
			case "anonymous_initializer":
				return { ...scope, descriptors: [...scope.descriptors, { kind: "meta", name: "init" }] };
			case "parameter":
				if (node.parent?.type === "function_value_parameters") this.parameter(node, scope);
				return scope;
			case "type_parameter":
				this.typeParameter(node, scope);
				return scope;
			case "property_declaration":
				return this.property(node, scope);
			case "setter":
				this.setterParameter(node, scope);
				return scope;
			case "lambda_parameters":
				for (const variable of this.boundVariables(node)) this.binder(variable, scope, "lambdaParameter");
				return scope;
			case "for_statement":
				for (const variable of this.boundVariables(node)) this.binder(variable, scope, "for");
				return scope;
			case "when_subject":
				for (const variable of this.boundVariables(node)) this.binder(variable, scope, "val", "term");
				return scope;
			case "catch_block": {
				const name = identifiers(node)[0];
				if (name !== undefined && nameText(this.text, name) !== "_") this.catchParameter(node, name, scope);
				return scope;
			}
			default:
				return scope;
		}
	}

	private modifiers(node: SyntaxNode | undefined): string[] {
		return modifiersOf(this.text, node);
	}

	private access(modifiers: string[], context: Context): Pick<Declaration, "visibility" | "exported"> {
		return accessOf(modifiers, context);
	}

	private bodyMetrics(body: SyntaxNode | undefined): Pick<Metrics, "nesting" | "branches"> {
		return bodyMetrics(this.tree.leaves, body);
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

	private typeDeclaration(node: SyntaxNode, scope: Scope): Scope {
		const companion = node.type === "companion_object";
		const object = companion || node.type === "object_declaration";
		const nameNode = node.children.find((child) => child.field === "name" && child.end > child.start);
		const keyword = childOfType(node, companion ? "object" : object ? "object" : "class");
		const interfaceKeyword = childOfType(node, "interface");
		const selection = nameNode ?? (companion ? keyword : undefined);
		if (selection === undefined) return scope;
		const name = nameNode === undefined ? "Companion" : nameText(this.text, nameNode);
		const modifiers = this.modifiers(childOfType(node, "modifiers"));
		const context = contextOf(node);
		const kind: Declaration["kind"] = modifiers.includes("enum")
			? "enum"
			: interfaceKeyword !== undefined
				? "interface"
				: "class";
		const languageParts = [
			...modifiers.filter((modifier) => LANGUAGE_MODIFIERS.has(modifier)),
			...(object ? [companion ? "companionObject" : "object"] : []),
			...(interfaceKeyword !== undefined ? ["interface"] : []),
		];
		const body = node.children.find((child) => BODY_TYPES.has(child.type));
		const added = this.sink.add({
			node,
			nameNode: selection,
			name,
			kind,
			...defined({ languageKind: languageParts.length === 0 ? undefined : languageParts.join(" ") }),
			descriptorKind: "type",
			scope,
			access: this.access(modifiers, context),
			signature: render(
				this.text,
				until(leadingAnnotationsSkipped(node), (child) => BODY_TYPES.has(child.type)),
				this.lines,
			),
			owns: true,
			metrics: this.bodyMetrics(body),
		});
		this.sink.supertypes(added.symbolId, supertypePaths(this.text, node));
		return {
			descriptors: added.descriptors,
			containerId: added.symbolId,
			classId: added.symbolId,
			className: name,
		};
	}

	private typeAlias(node: SyntaxNode, scope: Scope): Scope {
		const nameNode = node.children.find((child) => child.field === "type");
		if (nameNode === undefined || nameNode.end === nameNode.start) return scope;
		const context = contextOf(node);
		const added = this.sink.add({
			node,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: "class",
			languageKind: "typealias",
			descriptorKind: "type",
			scope,
			access: this.access(this.modifiers(childOfType(node, "modifiers")), context),
			signature: render(this.text, leadingAnnotationsSkipped(node), this.lines),
			owns: true,
		});
		const equals = node.children.findIndex((child) => child.type === "=");
		this.sink.declaredType(
			added.symbolId,
			node.children.slice(equals + 1).find((child) => TYPE_NODES.has(child.type)),
		);
		return { ...scope, descriptors: added.descriptors, containerId: added.symbolId };
	}

	private primaryConstructor(node: SyntaxNode, scope: Scope): Scope {
		const owner = node.parent;
		const className = owner?.children.find((child) => child.field === "name");
		if (owner === null || className === undefined || scope.classId === undefined) return scope;
		const keyword = childOfType(node, "constructor");
		const parameters = childrenOfType(childOfType(node, "class_parameters") ?? node, "class_parameter");
		const typeParameters = childOfType(owner, "type_parameters");
		const signatureNodes =
			keyword === undefined
				? [className, ...(typeParameters === undefined ? [] : [typeParameters]), node]
				: node.children.slice(node.children.indexOf(keyword));
		const added = this.sink.add({
			node,
			start: keyword === undefined ? className.start : node.start,
			nameNode: keyword ?? className,
			name: scope.className ?? nameText(this.text, className),
			kind: "constructor",
			languageKind: "primaryConstructor",
			descriptorKind: "method",
			scope,
			access: this.access(this.modifiers(childOfType(node, "modifiers")), "class"),
			signature: render(this.text, signatureNodes, this.lines),
			owns: true,
			metrics: { parameters: parameters.length },
		});
		return { ...scope, descriptors: added.descriptors, containerId: added.symbolId, classScope: scope };
	}

	private classParameter(node: SyntaxNode, scope: Scope): void {
		const nameNode = identifiers(node)[0];
		if (nameNode === undefined) return;
		const name = nameText(this.text, nameNode);
		const keyword = node.children.find((child) => child.type === "val" || child.type === "var");
		const type = node.children.find((child) => TYPE_NODES.has(child.type));
		const signature = render(this.text, [node], this.lines);
		if (keyword !== undefined && scope.classScope !== undefined) {
			const added = this.sink.add({
				node,
				nameNode,
				name,
				kind: "property",
				languageKind: keyword.type === "var" ? "constructorVar" : "constructorVal",
				descriptorKind: "term",
				scope: scope.classScope,
				access: this.access(this.modifiers(childOfType(node, "modifiers")), "class"),
				signature,
				owns: false,
			});
			if (type !== undefined) this.sink.declaredType(added.symbolId, type);
			else this.sink.inferredType(added.symbolId, this.initializer(node));
			return;
		}
		const added = this.sink.add({
			node,
			nameNode,
			name,
			kind: "variable",
			languageKind: "parameter",
			descriptorKind: "parameter",
			scope,
			access: { visibility: "local", exported: false },
			signature,
			owns: false,
		});
		this.sink.declaredType(added.symbolId, type);
	}

	private initializer(node: SyntaxNode): SyntaxNode | undefined {
		const equals = node.children.findIndex((child) => child.type === "=");
		return equals < 0 ? undefined : node.children.slice(equals + 1).find((child) => child.named);
	}

	private enumEntry(node: SyntaxNode, scope: Scope): Scope {
		const nameNode = identifiers(node)[0];
		if (nameNode === undefined) return scope;
		const name = nameText(this.text, nameNode);
		const added = this.sink.add({
			node,
			nameNode,
			name,
			kind: "constant",
			languageKind: "enumEntry",
			descriptorKind: "term",
			scope,
			access: this.access([], "class"),
			signature: render(this.text, [node], this.lines),
			owns: true,
		});
		return {
			descriptors: added.descriptors,
			containerId: added.symbolId,
			classId: added.symbolId,
			className: name,
		};
	}

	private functionDeclaration(node: SyntaxNode, scope: Scope): Scope {
		const nameNode = node.children.find((child) => child.field === "name" && child.end > child.start);
		if (nameNode === undefined) return scope;
		const modifiers = this.modifiers(childOfType(node, "modifiers"));
		const context = contextOf(node);
		const parameters = childOfType(node, "function_value_parameters");
		const nameIndex = node.children.indexOf(nameNode);
		const dot = node.children.slice(0, nameIndex).findLastIndex((child) => child.type === ".");
		const receiver = dot >= 0;
		const body = childOfType(node, "function_body");
		const languageParts = [
			...(modifiers.includes("suspend") ? ["suspend"] : []),
			...(receiver ? ["extensionFunction"] : []),
		];
		const added = this.sink.add({
			node,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: context === "class" ? "method" : "function",
			...defined({ languageKind: languageParts.length === 0 ? undefined : languageParts.join(" ") }),
			descriptorKind: "method",
			scope,
			access: this.access(modifiers, context),
			signature: render(
				this.text,
				until(leadingAnnotationsSkipped(node), (child) => child.type === "function_body"),
				this.lines,
			),
			owns: true,
			metrics: {
				parameters: parameters === undefined ? 0 : childrenOfType(parameters, "parameter").length,
				...this.bodyMetrics(childOfType(body ?? node, "block")),
			},
		});
		if (receiver) this.sink.receiverType(added.symbolId, node.children.slice(0, dot));
		if (parameters !== undefined) {
			const after = node.children.slice(node.children.indexOf(parameters) + 1);
			this.sink.declaredType(
				added.symbolId,
				until(after, (child) => child.type === "function_body").find((child) => TYPE_NODES.has(child.type)),
			);
		}
		return { ...scope, descriptors: added.descriptors, containerId: added.symbolId };
	}

	private secondaryConstructor(node: SyntaxNode, scope: Scope): Scope {
		const keyword = childOfType(node, "constructor");
		if (keyword === undefined) return scope;
		const parameters = childOfType(node, "function_value_parameters");
		const block = childOfType(node, "block");
		const added = this.sink.add({
			node,
			nameNode: keyword,
			name: scope.className ?? "constructor",
			kind: "constructor",
			languageKind: "secondaryConstructor",
			descriptorKind: "method",
			scope,
			access: this.access(this.modifiers(childOfType(node, "modifiers")), contextOf(node)),
			signature: render(
				this.text,
				until(leadingAnnotationsSkipped(node), (child) => child.type === "block"),
				this.lines,
			),
			owns: true,
			metrics: {
				parameters: parameters === undefined ? 0 : childrenOfType(parameters, "parameter").length,
				...this.bodyMetrics(block),
			},
		});
		return { ...scope, descriptors: added.descriptors, containerId: added.symbolId };
	}

	/** Modifiers before and a default after sit beside the parameter node. */
	private parameter(node: SyntaxNode, scope: Scope): void {
		const nameNode = identifiers(node)[0];
		const list = node.parent;
		if (nameNode === undefined || list === null) return;
		const index = list.children.indexOf(node);
		const before = list.children[index - 1];
		const first = before?.type === "parameter_modifiers" ? before : node;
		let last = node;
		for (let next = index + 1; next < list.children.length; next++) {
			const sibling = list.children[next] as SyntaxNode;
			if (
				sibling.type === "," ||
				sibling.type === ")" ||
				sibling.type === "parameter_modifiers" ||
				sibling.type === "parameter"
			)
				break;
			last = sibling;
		}
		const siblings = list.children.slice(list.children.indexOf(first), list.children.indexOf(last) + 1);
		const added = this.sink.add({
			node,
			start: first.start,
			end: last.end,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: "variable",
			languageKind: "parameter",
			descriptorKind: "parameter",
			scope,
			access: { visibility: "local", exported: false },
			signature: render(this.text, siblings, this.lines),
			owns: false,
		});
		this.sink.declaredType(
			added.symbolId,
			node.children.find((child) => TYPE_NODES.has(child.type)),
		);
	}

	private typeParameter(node: SyntaxNode, scope: Scope): void {
		const nameNode = identifiers(node)[0];
		if (nameNode === undefined) return;
		this.sink.add({
			node,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: "typeParameter",
			languageKind: "typeParameter",
			descriptorKind: "typeParameter",
			scope,
			access: { visibility: "local", exported: false },
			signature: render(this.text, [node], this.lines),
			owns: false,
		});
	}

	private property(node: SyntaxNode, scope: Scope): Scope {
		const keyword = node.children.find((child) => child.type === "val" || child.type === "var");
		const multiple = childOfType(node, "multi_variable_declaration");
		const context = contextOf(node);
		if (multiple !== undefined) {
			for (const variable of childrenOfType(multiple, "variable_declaration"))
				this.binder(variable, scope, "destructured");
			return scope;
		}
		const variable = childOfType(node, "variable_declaration");
		const nameNode = identifiers(variable)[0];
		if (variable === undefined || nameNode === undefined) return scope;
		const modifiers = this.modifiers(childOfType(node, "modifiers"));
		const constant = modifiers.includes("const");
		const header = until(
			leadingAnnotationsSkipped(node),
			(child) =>
				child.type === "=" ||
				child.type === "property_delegate" ||
				child.type === "getter" ||
				child.type === "setter",
		);
		const added = this.sink.add({
			node,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: context === "function" ? "variable" : constant ? "constant" : "property",
			...defined({ languageKind: constant ? "constVal" : keyword?.type }),
			descriptorKind: "term",
			scope,
			access: this.access(modifiers, context),
			signature: render(this.text, header, this.lines),
			owns: true,
		});
		const beforeName = node.children.slice(0, node.children.indexOf(variable));
		if (beforeName.some((child) => child.type === ".")) this.sink.receiverType(added.symbolId, beforeName);
		const type = variable.children.find((child) => TYPE_NODES.has(child.type));
		if (type !== undefined) this.sink.declaredType(added.symbolId, type);
		else this.sink.inferredType(added.symbolId, this.initializer(node));
		// A local's initializer binds into its function, as a block does.
		if (context === "function") return scope;
		this.sink.holdsValues(added.declaration);
		return { ...scope, descriptors: added.descriptors, containerId: added.symbolId };
	}

	private setterParameter(node: SyntaxNode, scope: Scope): void {
		const nameNode = identifiers(node)[0];
		if (nameNode === undefined) return;
		const added = this.sink.add({
			node: nameNode,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: "variable",
			languageKind: "parameter",
			descriptorKind: "parameter",
			scope,
			access: { visibility: "local", exported: false },
			signature: render(this.text, [nameNode], this.lines),
			owns: false,
		});
		this.sink.declaredType(
			added.symbolId,
			node.children.find((child) => TYPE_NODES.has(child.type)),
		);
	}

	private boundVariables(node: SyntaxNode): SyntaxNode[] {
		return node.children.flatMap((child) =>
			child.type === "variable_declaration"
				? [child]
				: child.type === "multi_variable_declaration"
					? childrenOfType(child, "variable_declaration")
					: [],
		);
	}

	/** A parameter descriptor unless the binder is a `val`, so no new binder renumbers a `val` local. */
	private binder(
		variable: SyntaxNode,
		scope: Scope,
		languageKind: string,
		descriptorKind: "parameter" | "term" = "parameter",
	): void {
		const nameNode = identifiers(variable)[0];
		if (nameNode === undefined) return;
		const name = nameText(this.text, nameNode);
		// `_` binds nothing.
		if (name === "_") return;
		const added = this.sink.add({
			node: variable,
			nameNode,
			name,
			kind: "variable",
			languageKind,
			descriptorKind,
			scope,
			access: { visibility: "local", exported: false },
			signature: render(this.text, [variable], this.lines),
			owns: false,
		});
		this.sink.declaredType(
			added.symbolId,
			variable.children.find((child) => TYPE_NODES.has(child.type)),
		);
	}

	private catchParameter(node: SyntaxNode, nameNode: SyntaxNode, scope: Scope): void {
		const type = node.children.find((child) => TYPE_NODES.has(child.type));
		const added = this.sink.add({
			node: nameNode,
			end: type?.end ?? nameNode.end,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: "variable",
			languageKind: "catch",
			descriptorKind: "parameter",
			scope,
			access: { visibility: "local", exported: false },
			signature: render(
				this.text,
				type === undefined
					? [nameNode]
					: node.children.slice(node.children.indexOf(nameNode), node.children.indexOf(type) + 1),
				this.lines,
			),
			owns: false,
		});
		this.sink.declaredType(added.symbolId, type);
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
