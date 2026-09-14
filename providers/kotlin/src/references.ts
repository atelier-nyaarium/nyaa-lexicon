import { type Binding, type CommentSpan, type Declaration, defined, type Literal } from "@nyaa-lexicon/protocol";
import { literalShape, supertypePaths } from "./declarations.js";
import type { Frame, ImportInfo, Receiver, ReferenceInfo, ReferenceRole } from "./facts.js";
import {
	COMMENT_TYPES,
	childOfType,
	type LineTable,
	misreadKeyword,
	nameText,
	type SyntaxNode,
	type SyntaxTree,
	unclosedComment,
} from "./syntax.js";

export interface UseFacts {
	references: ReferenceInfo[];
	literals: Literal[];
	comments: CommentSpan[];
}

const LITERAL_TYPES: ReadonlySet<string> = new Set([
	"string_literal",
	"multiline_string_literal",
	"character_literal",
	"number_literal",
	"float_literal",
]);

const BINDER_PARENTS: ReadonlySet<string> = new Set([
	"catch_block",
	"parameter",
	"class_parameter",
	"variable_declaration",
	"enum_entry",
	"type_parameter",
	"setter",
	"qualified_identifier",
	"import",
	"this_expression",
	"super_expression",
]);

const LABEL_KEYWORDS_RE = /^(?:break|continue|return|this|super)@$/u;

const TYPE_KINDS: ReadonlySet<string> = new Set(["class", "interface", "enum", "package"]);

const PLACEHOLDER: Binding = {
	status: "unbound",
	reason: "NotIndexed",
	detail: "binding is resolved by the provider index",
};

function identifierCharacter(character: string, first: boolean): boolean {
	return character === "_" || /^\p{L}$/u.test(character) || (!first && /^\p{Nd}$/u.test(character));
}

function isHeritage(userType: SyntaxNode): boolean {
	const parent = userType.parent;
	if (parent === null) return false;
	if (parent.type === "delegation_specifier" || parent.type === "explicit_delegation") return true;
	return parent.type === "constructor_invocation" && parent.parent?.type === "delegation_specifier";
}

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

function memberName(node: SyntaxNode): SyntaxNode | undefined {
	if (node.type === "identifier") return node;
	if (node.type === "navigation_expression" || node.type === "user_type") {
		const last = node.children.at(-1);
		return last?.type === "identifier" ? last : undefined;
	}
	return undefined;
}

class UseWalker {
	private readonly references: ReferenceInfo[] = [];
	private readonly literals: Literal[] = [];
	private readonly comments: CommentSpan[] = [];
	private readonly firstReference = new Map<SyntaxNode, number>();
	private readonly owners: string[] = [];
	private readonly binders: string[] = [];
	private readonly byId = new Map<string, Declaration>();
	private frame: Frame | undefined;
	private readonly typeNames: ReadonlySet<string>;
	/** An unclosed comment's start, which swallows everything after. */
	private readonly unclosed: number;

	constructor(
		private readonly text: string,
		private readonly tree: SyntaxTree,
		private readonly lines: LineTable,
		declarations: Declaration[],
		private readonly importNames: Map<SyntaxNode, ImportInfo>,
	) {
		this.unclosed = unclosedComment(text, tree) ?? text.length;
		for (const declaration of declarations) this.byId.set(declaration.symbolId, declaration);
		this.typeNames = new Set(
			declarations
				.filter((declaration) => TYPE_KINDS.has(declaration.kind))
				.map((declaration) => declaration.name),
		);
	}

	walk(): UseFacts {
		const stack: Array<{ node: SyntaxNode; exit: boolean; outer?: Frame | undefined }> = [
			{ node: this.tree.root, exit: false },
		];
		while (stack.length > 0) {
			const { node, exit, outer } = stack.pop() as { node: SyntaxNode; exit: boolean; outer?: Frame };
			if (exit) {
				if (node.owner !== undefined) this.owners.pop();
				if (node.declared !== undefined) this.binders.pop();
				this.frame = outer;
				continue;
			}
			if (node.owner !== undefined) this.owners.push(node.owner);
			if (node.declared !== undefined) this.binders.push(node.declared);
			const enclosing = this.frame;
			this.enterScope(node);
			this.visit(node);
			stack.push({ node, exit: true, outer: enclosing });
			for (let index = node.children.length - 1; index >= 0; index--)
				stack.push({ node: node.children[index] as SyntaxNode, exit: false });
		}
		if (this.unclosed < this.text.length)
			this.comments.push({
				range: this.lines.range(this.unclosed, this.text.length),
				text: this.text.slice(this.unclosed),
			});
		return { references: this.references, literals: this.literals, comments: this.comments };
	}

	/** Declares a local into the enclosing frame, then opens the node's own. */
	private enterScope(node: SyntaxNode): void {
		const declared = node.declared === undefined ? undefined : this.byId.get(node.declared);
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
		if (frame !== undefined) this.frame = frame;
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
			const inner = this.modifierWords(node).includes("inner");
			const nested = classMember(node) && !inner && node.type !== "enum_entry";
			return {
				parent,
				member: classMember(node),
				receiver: { kind: "class", classId: declared.symbolId, label: declared.name, nested },
			};
		}
		const extension =
			declared.languageKind?.split(" ").includes("extensionFunction") || this.extensionProperty(node);
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

	private extensionProperty(node: SyntaxNode): boolean {
		if (node.type !== "property_declaration") return false;
		const variable = childOfType(node, "variable_declaration");
		if (variable === undefined) return false;
		return node.children.slice(0, node.children.indexOf(variable)).some((child) => child.type === ".");
	}

	private modifierWords(node: SyntaxNode): string[] {
		const modifiers = childOfType(node, "modifiers");
		return modifiers === undefined
			? []
			: modifiers.children.map((child) => this.text.slice(child.start, child.end));
	}

	private visit(node: SyntaxNode): void {
		if (COMMENT_TYPES.has(node.type)) {
			if (node.start >= this.unclosed) return;
			const end = this.text.charAt(node.end - 1) === "\r" ? node.end - 1 : node.end;
			this.comments.push({ range: this.lines.range(node.start, end), text: this.text.slice(node.start, end) });
			return;
		}
		if (LITERAL_TYPES.has(node.type) || node.type === "identifier") {
			const shape = literalShape(this.text, node);
			if (shape !== null) {
				if (shape.kind !== "null")
					this.literals.push({
						kind: shape.kind,
						value: shape.value,
						...defined({ number: shape.number }),
						range: this.lines.range(node.start, node.end),
						...defined({ containerId: this.binders.at(-1) }),
					});
				return;
			}
		}
		if (node.type === "identifier" && node.end > node.start) this.identifier(node);
		else if (node.type === "string_content") this.shortTemplate(node);
	}

	/** The grammar leaves `"$name"` as two string contents. */
	private shortTemplate(node: SyntaxNode): void {
		if (node.end - node.start !== 1 || this.text.charAt(node.start) !== "$") return;
		const siblings = node.parent?.children ?? [];
		const next = siblings[siblings.indexOf(node) + 1];
		if (next?.type !== "string_content" || next.start !== node.end) return;
		let end = next.start;
		while (end < next.end && identifierCharacter(this.text.charAt(end), end === next.start)) end++;
		if (end === next.start) return;
		this.add(
			{
				type: "identifier",
				named: true,
				missing: false,
				field: null,
				start: next.start,
				end,
				parent: node.parent,
				children: [],
			},
			"read",
		);
	}

	private add(
		node: SyntaxNode,
		role: ReferenceRole,
		extra: Pick<ReferenceInfo, "importInfo" | "receiver"> = {},
	): void {
		const index = this.references.length;
		const owner = this.owners.at(-1);
		this.references.push({
			reference: {
				name: nameText(this.text, node),
				range: this.lines.range(node.start, node.end),
				role,
				binding: PLACEHOLDER,
				...defined({ fromId: owner }),
			},
			index,
			offset: node.start,
			...defined({ frame: this.frame, importInfo: extra.importInfo, receiver: extra.receiver }),
		});
		if (!this.firstReference.has(node)) this.firstReference.set(node, index);
	}

	private receiverOf(left: SyntaxNode | undefined): Receiver {
		if (left?.type === "this_expression") {
			const label = childOfType(left, "identifier");
			return defined({
				kind: "this" as const,
				label: label === undefined ? undefined : nameText(this.text, label),
			});
		}
		if (left?.type === "super_expression") return { kind: "super" };
		const name = left === undefined ? undefined : memberName(left);
		const index = name === undefined ? undefined : this.firstReference.get(name);
		return index === undefined ? { kind: "expression" } : { kind: "name", index };
	}

	private applied(node: SyntaxNode, target: SyntaxNode, extra: Pick<ReferenceInfo, "receiver">): boolean {
		const parent = target.parent;
		if (parent === null) return false;
		if (parent.type === "call_expression" && parent.children[0] === target) {
			this.add(node, this.typeNames.has(nameText(this.text, node)) ? "instantiate" : "call", extra);
			return true;
		}
		if (parent.type === "assignment" && parent.children[0] === target) {
			const operator = parent.children.find((child) => child.field === "operator");
			if (operator !== undefined && operator.type !== "=") this.add(node, "read", extra);
			this.add(node, "write", extra);
			return true;
		}
		if (parent.type === "unary_expression" && target.field === "argument") {
			const operator = parent.children.find((child) => child.field === "operator");
			if (operator?.type === "++" || operator?.type === "--") {
				this.add(node, "read", extra);
				this.add(node, "write", extra);
				return true;
			}
			// The grammar reads `!f(x)` as `(!f)(x)`.
			const call = parent.parent;
			if (
				operator !== undefined &&
				operator.start < target.start &&
				call?.type === "call_expression" &&
				call.children[0] === parent
			) {
				this.add(node, this.typeNames.has(nameText(this.text, node)) ? "instantiate" : "call", extra);
				return true;
			}
		}
		return false;
	}

	private identifier(node: SyntaxNode): void {
		const parent = node.parent;
		if (parent === null || node.declaresName === true || misreadKeyword(this.text, node)) return;
		const importInfo = this.importNames.get(node);
		if (importInfo !== undefined) {
			this.add(node, "import", { importInfo });
			return;
		}
		if (BINDER_PARENTS.has(parent.type)) return;
		if (node.field === "label") return;
		const name = nameText(this.text, node);
		const siblings = parent.children;
		const position = siblings.indexOf(node);
		switch (parent.type) {
			case "labeled_expression": {
				const label = siblings[0];
				if (label?.type === "label" && LABEL_KEYWORDS_RE.test(this.text.slice(label.start, label.end))) return;
				break;
			}
			case "value_argument":
				if (position === 0 && siblings[1]?.type === "=") return;
				break;
			case "user_type": {
				const previous = siblings.slice(0, position).findLast((child) => child.type === "identifier");
				const receiver = previous === undefined ? undefined : this.receiverOf(previous);
				const last = siblings.findLast((child) => child.type === "identifier") === node;
				this.add(node, last && isHeritage(parent) ? "extends" : "typeUse", defined({ receiver }));
				return;
			}
			case "type_constraint":
				this.add(node, "typeUse");
				return;
			case "navigation_expression": {
				if (position === 0) break;
				const operator = siblings[position - 1];
				if (operator?.type === "::" && name === "class") return;
				const receiver = this.receiverOf(siblings[0]);
				if (!this.applied(node, parent, { receiver })) this.add(node, "read", { receiver });
				return;
			}
			case "callable_reference": {
				if (siblings[position - 1]?.type !== "::" || name === "class") return;
				const left = siblings[0];
				if (left === undefined || left.type === "::") break;
				const typeName = left.type === "user_type" ? memberName(left) : undefined;
				const index = typeName === undefined ? undefined : this.firstReference.get(typeName);
				this.add(node, "read", {
					receiver: index === undefined ? this.receiverOf(left) : { kind: "name", index, callable: true },
				});
				return;
			}
			case "infix_expression":
				if (position === 1) {
					this.add(node, "call", { receiver: this.receiverOf(siblings[0]) });
					return;
				}
				break;
		}
		if (!this.applied(node, node, {})) this.add(node, "read");
	}
}

export function walkUses(
	text: string,
	tree: SyntaxTree,
	lines: LineTable,
	declarations: Declaration[],
	importNames: Map<SyntaxNode, ImportInfo>,
): UseFacts {
	return new UseWalker(text, tree, lines, declarations, importNames).walk();
}
