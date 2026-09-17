import { type Binding, type CommentSpan, defined, type Literal } from "@nyaa-lexicon/protocol";
import { unclosedComment } from "./diagnostics.js";
import type { ScopeEnvironment } from "./environment.js";
import type { Frame, Receiver, ReferenceInfo, ReferenceRole } from "./facts.js";
import { literalShape } from "./literals.js";
import {
	COMMENT_TYPES,
	childOfType,
	type LineTable,
	misreadKeyword,
	nameText,
	type SyntaxNode,
	type SyntaxTree,
} from "./tree.js";

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
	private frame: Frame | undefined;
	/** An unclosed comment's start, which swallows everything after. */
	private readonly unclosed: number;

	constructor(
		private readonly text: string,
		private readonly tree: SyntaxTree,
		private readonly lines: LineTable,
		private readonly environment: ScopeEnvironment,
	) {
		this.unclosed = unclosedComment(text, tree) ?? text.length;
	}

	walk(): UseFacts {
		type Step = { node: SyntaxNode; exit: boolean; outer?: Frame | undefined; owned?: boolean; bound?: boolean };
		const stack: Step[] = [{ node: this.tree.root, exit: false }];
		while (stack.length > 0) {
			const step = stack.pop() as Step;
			if (step.exit) {
				if (step.owned === true) this.owners.pop();
				if (step.bound === true) this.binders.pop();
				this.frame = step.outer;
				continue;
			}
			const { node } = step;
			const owner = this.environment.ownerAt(node);
			const declared = this.environment.declaredAt(node);
			if (owner !== undefined) this.owners.push(owner);
			if (declared !== undefined) this.binders.push(declared.symbolId);
			const enclosing = this.frame;
			this.frame = this.environment.scopeOpenedBy(node) ?? this.frame;
			this.visit(node);
			stack.push({
				node,
				exit: true,
				outer: enclosing,
				owned: owner !== undefined,
				bound: declared !== undefined,
			});
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
			this.add(node, this.environment.declaresType(nameText(this.text, node)) ? "instantiate" : "call", extra);
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
				this.add(
					node,
					this.environment.declaresType(nameText(this.text, node)) ? "instantiate" : "call",
					extra,
				);
				return true;
			}
		}
		return false;
	}

	private identifier(node: SyntaxNode): void {
		const parent = node.parent;
		if (parent === null || this.environment.namesDeclaration(node) || misreadKeyword(this.text, node)) return;
		const importInfo = this.environment.importAt(node);
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

export function walkUses(text: string, tree: SyntaxTree, lines: LineTable, environment: ScopeEnvironment): UseFacts {
	return new UseWalker(text, tree, lines, environment).walk();
}
