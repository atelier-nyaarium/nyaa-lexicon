import {
	composeSymbolId,
	type Declaration,
	type Descriptor,
	defined,
	type ImportedName,
	type Metrics,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import { type HeaderFacts, type ImportInfo, LANGUAGE, type TypeFact, type TypePath } from "./facts.js";
import { render } from "./render.js";
import { childOfType, childrenOfType, type LineTable, nameText, type SyntaxNode, type SyntaxTree } from "./tree.js";

type Context = "module" | "class" | "function";

interface Scope {
	descriptors: Descriptor[];
	containerId?: string;
	classId?: string;
	className?: string;
	/** Inside a primary constructor: where its properties land. */
	classScope?: Scope;
}

export interface DeclarationFacts extends HeaderFacts {
	packageName?: string;
	declarations: Declaration[];
	imports: ImportInfo[];
	/** Import directive per source name node. */
	importNames: Map<SyntaxNode, ImportInfo>;
	typeFacts: TypeFact[];
}

export const TYPE_NODES: ReadonlySet<string> = new Set([
	"user_type",
	"nullable_type",
	"non_nullable_type",
	"function_type",
	"parenthesized_type",
	"dynamic",
]);

const BODY_TYPES: ReadonlySet<string> = new Set(["class_body", "enum_class_body"]);

const LANGUAGE_MODIFIERS: ReadonlySet<string> = new Set([
	"data",
	"sealed",
	"abstract",
	"inner",
	"enum",
	"annotation",
	"value",
]);

const BRANCH_KEYWORDS: ReadonlySet<string> = new Set(["if", "when", "for", "while", "catch"]);

export interface LiteralShape {
	kind: "string" | "number" | "boolean" | "null";
	display: string;
	value: string;
	number?: number;
}

const ESCAPES: Record<string, string> = {
	b: "\b",
	n: "\n",
	r: "\r",
	t: "\t",
	"0": "\0",
};

function decodeEscape(raw: string): string {
	const body = raw.slice(1);
	if (body.startsWith("u") && body.length === 5) {
		const code = Number.parseInt(body.slice(1), 16);
		if (Number.isFinite(code)) return String.fromCharCode(code);
	}
	return ESCAPES[body] ?? body;
}

const HEX_RE = /^[0-9A-Fa-f]{4}/u;

/** The grammar splits `A` into contents `\u` and `0041`. */
function stringValue(text: string, node: SyntaxNode): string {
	let value = "";
	let unicode = false;
	for (const child of node.children) {
		let part = text.slice(child.start, child.end);
		if (unicode && child.type === "string_content" && HEX_RE.test(part)) {
			value = value.slice(0, -2) + String.fromCharCode(Number.parseInt(part.slice(0, 4), 16));
			part = part.slice(4);
		}
		unicode = node.type === "string_literal" && child.type === "string_content" && part.endsWith("\\u");
		if (child.type === "string_content" || child.type === "interpolation") value += part;
		else if (child.type === "escape_sequence") value += decodeEscape(part);
	}
	return value;
}

function numberShape(raw: string): LiteralShape | null {
	let body = raw.replaceAll("_", "");
	const radix = /^0[xXbB]/u.test(body);
	let long = false;
	let unsigned = false;
	let float = false;
	if (/[lL]$/u.test(body)) {
		long = true;
		body = body.slice(0, -1);
	}
	if (/[uU]$/u.test(body)) {
		unsigned = true;
		body = body.slice(0, -1);
	}
	if (!radix && !long && !unsigned && /[fF]$/u.test(body)) {
		float = true;
		body = body.slice(0, -1);
	}
	const number = Number(body);
	if (!Number.isFinite(number)) return null;
	const display = unsigned
		? long
			? "ULong"
			: "UInt"
		: long
			? "Long"
			: float
				? "Float"
				: !radix && /[.eE]/u.test(body)
					? "Double"
					: "Int";
	return { kind: "number", display, value: raw, number };
}

export function literalShape(text: string, node: SyntaxNode): LiteralShape | null {
	switch (node.type) {
		case "string_literal":
		case "multiline_string_literal":
			return { kind: "string", display: "String", value: stringValue(text, node) };
		case "character_literal": {
			const sequence = childOfType(node, "escape_sequence");
			const value =
				sequence === undefined
					? text.slice(node.start + 1, node.end - 1)
					: decodeEscape(text.slice(sequence.start, sequence.end));
			return { kind: "string", display: "Char", value };
		}
		case "number_literal":
		case "float_literal":
			return numberShape(text.slice(node.start, node.end));
		case "identifier": {
			const word = text.slice(node.start, node.end);
			if (word === "true" || word === "false") return { kind: "boolean", display: "Boolean", value: word };
			if (word === "null") return { kind: "null", display: "Nothing?", value: word };
			return null;
		}
		default:
			return null;
	}
}

const TYPE_WRAPPERS: ReadonlySet<string> = new Set(["nullable_type", "non_nullable_type", "parenthesized_type"]);

/** A named type's segments; undefined for a function type. */
export function typePath(text: string, node: SyntaxNode | undefined): TypePath | undefined {
	let current = node;
	while (current !== undefined && current.type !== "user_type") {
		if (!TYPE_WRAPPERS.has(current.type)) return undefined;
		current = current.children.find((child) => child.named);
	}
	if (current === undefined) return undefined;
	const segments = childrenOfType(current, "identifier").map((item) => nameText(text, item));
	return segments.length === 0 ? undefined : segments;
}

export function supertypePaths(text: string, node: SyntaxNode): TypePath[] {
	const list = childOfType(node, "delegation_specifiers");
	if (list === undefined) return [];
	const paths: TypePath[] = [];
	for (const specifier of childrenOfType(list, "delegation_specifier")) {
		const inner = specifier.children.find((child) => child.named);
		const type =
			inner?.type === "constructor_invocation" || inner?.type === "explicit_delegation"
				? inner.children.find((child) => TYPE_NODES.has(child.type))
				: inner;
		const path = typePath(text, type);
		if (path !== undefined) paths.push(path);
	}
	return paths;
}

function identifiers(node: SyntaxNode | undefined): SyntaxNode[] {
	return node === undefined ? [] : childrenOfType(node, "identifier").filter((item) => item.end > item.start);
}

function contextOf(node: SyntaxNode): Context {
	let parent = node.parent;
	while (parent !== null && parent.type === "ERROR") parent = parent.parent;
	if (parent === null || parent.type === "source_file") return "module";
	if (BODY_TYPES.has(parent.type) && parent.parent !== null && parent.parent.type !== "object_literal")
		return "class";
	return "function";
}

function leadingAnnotationsSkipped(node: SyntaxNode): SyntaxNode[] {
	const out: SyntaxNode[] = [];
	let leading = true;
	for (const child of node.children) {
		if (child.type === "modifiers") {
			for (const modifier of child.children) {
				if (leading && modifier.type === "annotation") continue;
				leading = false;
				out.push(modifier);
			}
			continue;
		}
		leading = false;
		out.push(child);
	}
	return out;
}

function until(nodes: SyntaxNode[], stop: (node: SyntaxNode) => boolean): SyntaxNode[] {
	const index = nodes.findIndex(stop);
	return index < 0 ? nodes : nodes.slice(0, index);
}

class DeclarationWalker {
	private readonly declarations: Declaration[] = [];
	private readonly imports: ImportInfo[] = [];
	private readonly importNames = new Map<SyntaxNode, ImportInfo>();
	private readonly typeFacts: TypeFact[] = [];
	private readonly nameCounts = new Map<string, number>();
	private readonly supertypes = new Map<string, TypePath[]>();
	private readonly receiverTypes = new Map<string, TypePath>();
	/** Properties, keyed by id. */
	private readonly valueHolders = new Map<string, Declaration>();
	private packageName: string | undefined;

	constructor(
		private readonly module: string,
		private readonly text: string,
		private readonly tree: SyntaxTree,
		private readonly lines: LineTable,
		private readonly outline: boolean,
	) {}

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
			declarations: this.declarations,
			imports: this.imports,
			importNames: this.importNames,
			typeFacts: this.typeFacts,
			supertypes: this.supertypes,
			receiverTypes: this.receiverTypes,
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

	private range(node: SyntaxNode) {
		return this.lines.range(node.start, node.end);
	}

	private descriptor(kind: Descriptor["kind"], name: string, parent: Descriptor[], method: boolean): Descriptor {
		const key = `${parent.map((item) => `${item.kind}:${item.name}`).join("/")}|${kind}:${name}`;
		const count = this.nameCounts.get(key) ?? 0;
		this.nameCounts.set(key, count + 1);
		if (count === 0 || !method) return { kind, name: count === 0 ? name : `${name}@${count}` };
		return { kind: "method", name, disambiguator: String(count) };
	}

	private modifiers(node: SyntaxNode | undefined): string[] {
		if (node === undefined) return [];
		return node.children
			.filter((child) => child.type !== "annotation")
			.map((child) => this.text.slice(child.start, child.end));
	}

	private access(modifiers: string[], context: Context): Pick<Declaration, "visibility" | "exported"> {
		if (context === "function") return { visibility: "local", exported: false };
		if (modifiers.includes("private")) return { visibility: "private", exported: false };
		if (modifiers.includes("protected")) return { visibility: "protected", exported: false };
		if (modifiers.includes("internal")) return { visibility: "internal", exported: true };
		return { visibility: "public", exported: true };
	}

	private add(input: {
		node: SyntaxNode;
		start?: number;
		end?: number;
		nameNode: SyntaxNode;
		name: string;
		kind: Declaration["kind"];
		languageKind?: string;
		descriptorKind: Descriptor["kind"];
		scope: Scope;
		access: Pick<Declaration, "visibility" | "exported">;
		signature?: string;
		owner: boolean;
		metrics?: Omit<Metrics, "lines">;
	}): { symbolId: string; descriptors: Descriptor[]; declaration: Declaration } {
		const method = input.descriptorKind === "method";
		const descriptor = this.descriptor(input.descriptorKind, input.name, input.scope.descriptors, method);
		const descriptors = [...input.scope.descriptors, descriptor];
		const symbolId = composeSymbolId({ language: LANGUAGE, module: this.module, descriptors });
		const range = this.lines.range(input.start ?? input.node.start, input.end ?? input.node.end);
		const declaration: Declaration = {
			symbolId,
			kind: input.kind,
			...defined({ languageKind: input.languageKind }),
			name: input.name,
			range,
			selectionRange: this.range(input.nameNode),
			...input.access,
			...defined({ signature: input.signature, containerId: input.scope.containerId }),
			metrics: { lines: range.end.line - range.start.line + 1, ...input.metrics },
		};
		this.declarations.push(declaration);
		// Type params: signature only.
		const holder =
			input.scope.containerId === undefined ? undefined : this.valueHolders.get(input.scope.containerId);
		if (holder !== undefined && input.descriptorKind !== "typeParameter") holder.contains = "locals";
		input.node.declared = symbolId;
		if (input.owner) input.node.owner = symbolId;
		if (input.nameNode.type === "identifier") input.nameNode.declaresName = true;
		return { symbolId, descriptors, declaration };
	}

	private declaredType(symbolId: string, type: SyntaxNode | undefined): void {
		if (this.outline || type === undefined) return;
		const display = render(this.text, [type], this.lines);
		if (display === "") return;
		this.typeFacts.push({
			symbolId,
			answer: { status: "known", display, provenance: "declared" },
			annotationRange: this.range(type),
		});
	}

	private inferredType(symbolId: string, initializer: SyntaxNode | undefined): void {
		if (this.outline || initializer === undefined) return;
		const shape = literalShape(this.text, initializer);
		if (shape === null) return;
		const answer: TypeInfo = { status: "inferred", display: shape.display, basis: "literal initializer" };
		this.typeFacts.push({ symbolId, answer });
	}

	/** Decision points and brace depth inside a body, its own braces excluded. */
	private bodyMetrics(body: SyntaxNode | undefined): Pick<Metrics, "nesting" | "branches"> {
		if (body === undefined) return {};
		const leaves = this.tree.leaves;
		let low = 0;
		let high = leaves.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((leaves[middle] as SyntaxNode).start <= body.start) low = middle + 1;
			else high = middle;
		}
		let depth = 0;
		let nesting = 0;
		let branches = 1;
		for (let index = low; index < leaves.length; index++) {
			const leaf = leaves[index] as SyntaxNode;
			if (leaf.start >= body.end - 1) break;
			if (leaf.type === "{") nesting = Math.max(nesting, ++depth);
			else if (leaf.type === "}") depth = Math.max(0, depth - 1);
			else if (BRANCH_KEYWORDS.has(leaf.type)) branches++;
		}
		return { nesting, branches };
	}

	private packageHeader(node: SyntaxNode): void {
		const names = identifiers(childOfType(node, "qualified_identifier"));
		const last = names.at(-1);
		if (last === undefined) return;
		this.packageName = names.map((item) => nameText(this.text, item)).join(".");
		const descriptors: Descriptor[] = [{ kind: "namespace", name: this.packageName }];
		const range = this.range(node);
		this.declarations.push({
			symbolId: composeSymbolId({ language: LANGUAGE, module: this.module, descriptors }),
			kind: "package",
			languageKind: "package",
			name: this.packageName,
			range,
			selectionRange: this.range(last),
			visibility: "public",
			exported: true,
			metrics: { lines: range.end.line - range.start.line + 1 },
		});
	}

	private importDirective(node: SyntaxNode): void {
		const path = identifiers(childOfType(node, "qualified_identifier"));
		const source = path.at(-1);
		if (source === undefined) return;
		const star = childOfType(node, "*");
		const alias = identifiers(node)[0];
		const segments = path.map((item) => nameText(this.text, item));
		const specifier = `${segments.join(".")}${star === undefined ? "" : ".*"}`;
		const sourceName = nameText(this.text, source);
		const imported: ImportedName[] =
			star === undefined
				? [
						{
							name: sourceName,
							range: this.range(source),
							local: nameText(this.text, alias ?? source),
							localRange: this.range(alias ?? source),
						},
					]
				: [{ name: "*", range: this.range(star) }];
		const info: ImportInfo = {
			specifier,
			imported,
			reExport: false,
			star: star !== undefined,
			...(star === undefined
				? { importedName: sourceName, localName: nameText(this.text, alias ?? source) }
				: {}),
		};
		this.imports.push(info);
		if (star === undefined) this.importNames.set(source, info);
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
		const added = this.add({
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
			owner: true,
			metrics: this.bodyMetrics(body),
		});
		const supertypes = supertypePaths(this.text, node);
		if (supertypes.length > 0) this.supertypes.set(added.symbolId, supertypes);
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
		const added = this.add({
			node,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: "class",
			languageKind: "typealias",
			descriptorKind: "type",
			scope,
			access: this.access(this.modifiers(childOfType(node, "modifiers")), context),
			signature: render(this.text, leadingAnnotationsSkipped(node), this.lines),
			owner: true,
		});
		const equals = node.children.findIndex((child) => child.type === "=");
		this.declaredType(
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
		const added = this.add({
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
			owner: true,
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
			const added = this.add({
				node,
				nameNode,
				name,
				kind: "property",
				languageKind: keyword.type === "var" ? "constructorVar" : "constructorVal",
				descriptorKind: "term",
				scope: scope.classScope,
				access: this.access(this.modifiers(childOfType(node, "modifiers")), "class"),
				signature,
				owner: false,
			});
			if (type !== undefined) this.declaredType(added.symbolId, type);
			else this.inferredType(added.symbolId, this.initializer(node));
			return;
		}
		const added = this.add({
			node,
			nameNode,
			name,
			kind: "variable",
			languageKind: "parameter",
			descriptorKind: "parameter",
			scope,
			access: { visibility: "local", exported: false },
			signature,
			owner: false,
		});
		this.declaredType(added.symbolId, type);
	}

	private initializer(node: SyntaxNode): SyntaxNode | undefined {
		const equals = node.children.findIndex((child) => child.type === "=");
		return equals < 0 ? undefined : node.children.slice(equals + 1).find((child) => child.named);
	}

	private enumEntry(node: SyntaxNode, scope: Scope): Scope {
		const nameNode = identifiers(node)[0];
		if (nameNode === undefined) return scope;
		const name = nameText(this.text, nameNode);
		const added = this.add({
			node,
			nameNode,
			name,
			kind: "constant",
			languageKind: "enumEntry",
			descriptorKind: "term",
			scope,
			access: this.access([], "class"),
			signature: render(this.text, [node], this.lines),
			owner: true,
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
		const added = this.add({
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
			owner: true,
			metrics: {
				parameters: parameters === undefined ? 0 : childrenOfType(parameters, "parameter").length,
				...this.bodyMetrics(childOfType(body ?? node, "block")),
			},
		});
		if (receiver) this.receiverType(added.symbolId, node.children.slice(0, dot));
		if (parameters !== undefined) {
			const after = node.children.slice(node.children.indexOf(parameters) + 1);
			this.declaredType(
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
		const added = this.add({
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
			owner: true,
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
		const added = this.add({
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
			owner: false,
		});
		this.declaredType(
			added.symbolId,
			node.children.find((child) => TYPE_NODES.has(child.type)),
		);
	}

	private typeParameter(node: SyntaxNode, scope: Scope): void {
		const nameNode = identifiers(node)[0];
		if (nameNode === undefined) return;
		this.add({
			node,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: "typeParameter",
			languageKind: "typeParameter",
			descriptorKind: "typeParameter",
			scope,
			access: { visibility: "local", exported: false },
			signature: render(this.text, [node], this.lines),
			owner: false,
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
		const added = this.add({
			node,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: context === "function" ? "variable" : constant ? "constant" : "property",
			...defined({ languageKind: constant ? "constVal" : keyword?.type }),
			descriptorKind: "term",
			scope,
			access: this.access(modifiers, context),
			signature: render(this.text, header, this.lines),
			owner: true,
		});
		const beforeName = node.children.slice(0, node.children.indexOf(variable));
		if (beforeName.some((child) => child.type === ".")) this.receiverType(added.symbolId, beforeName);
		const type = variable.children.find((child) => TYPE_NODES.has(child.type));
		if (type !== undefined) this.declaredType(added.symbolId, type);
		else this.inferredType(added.symbolId, this.initializer(node));
		// A local's initializer binds into its function, as a block does.
		if (context === "function") return scope;
		this.valueHolders.set(added.symbolId, added.declaration);
		return { ...scope, descriptors: added.descriptors, containerId: added.symbolId };
	}

	/** The last type ahead of the name's dot. */
	private receiverType(symbolId: string, before: SyntaxNode[]): void {
		const path = typePath(
			this.text,
			before.findLast((child) => TYPE_NODES.has(child.type)),
		);
		if (path !== undefined) this.receiverTypes.set(symbolId, path);
	}

	private setterParameter(node: SyntaxNode, scope: Scope): void {
		const nameNode = identifiers(node)[0];
		if (nameNode === undefined) return;
		const added = this.add({
			node: nameNode,
			nameNode,
			name: nameText(this.text, nameNode),
			kind: "variable",
			languageKind: "parameter",
			descriptorKind: "parameter",
			scope,
			access: { visibility: "local", exported: false },
			signature: render(this.text, [nameNode], this.lines),
			owner: false,
		});
		this.declaredType(
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
		const added = this.add({
			node: variable,
			nameNode,
			name,
			kind: "variable",
			languageKind,
			descriptorKind,
			scope,
			access: { visibility: "local", exported: false },
			signature: render(this.text, [variable], this.lines),
			owner: false,
		});
		this.declaredType(
			added.symbolId,
			variable.children.find((child) => TYPE_NODES.has(child.type)),
		);
	}

	private catchParameter(node: SyntaxNode, nameNode: SyntaxNode, scope: Scope): void {
		const type = node.children.find((child) => TYPE_NODES.has(child.type));
		const added = this.add({
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
			owner: false,
		});
		this.declaredType(added.symbolId, type);
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
