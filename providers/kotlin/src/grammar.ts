// Kotlin by recursive descent over the specification's syntax grammar.
//
// Nodes use tree-sitter-kotlin 1.1.0's names, fields and leaves, the vocabulary the walkers read.
// `context_parameters` and `when_guard` name syntax that grammar lacks.

import { isTooDeep, NestingGauge, TOO_DEEP, type WorkMeter } from "@nyaa-lexicon/protocol";
import type { Comment, LexProblem, StringPart, Token } from "./lexer.js";
import type { SyntaxNode, SyntaxTree } from "./tree.js";

////////////////////////////////
//  Interfaces & Types

export interface GrammarProblem {
	message: string;
	start: number;
	end: number;
}

export interface GrammarResult {
	tree: SyntaxTree;
	problems: GrammarProblem[];
}

/** Where a statement sits, which decides what may follow a property. */
type Place = "file" | "class" | "local";

////////////////////////////////
//  Constants

const MODIFIER_TYPES: ReadonlyMap<string, string> = new Map([
	["enum", "class_modifier"],
	["sealed", "class_modifier"],
	["annotation", "class_modifier"],
	["data", "class_modifier"],
	["inner", "class_modifier"],
	["value", "class_modifier"],
	["tailrec", "function_modifier"],
	["operator", "function_modifier"],
	["infix", "function_modifier"],
	["inline", "function_modifier"],
	["external", "function_modifier"],
	["suspend", "function_modifier"],
	["const", "property_modifier"],
	["public", "visibility_modifier"],
	["private", "visibility_modifier"],
	["protected", "visibility_modifier"],
	["internal", "visibility_modifier"],
	["abstract", "inheritance_modifier"],
	["final", "inheritance_modifier"],
	["open", "inheritance_modifier"],
	["override", "member_modifier"],
	["lateinit", "member_modifier"],
	["vararg", "parameter_modifier"],
	["noinline", "parameter_modifier"],
	["crossinline", "parameter_modifier"],
	["expect", "platform_modifier"],
	["actual", "platform_modifier"],
]);

const PARAMETER_MODIFIERS: ReadonlySet<string> = new Set(["vararg", "noinline", "crossinline"]);

/** Soft keywords that start a declaration only in a class body. */
const CLASS_MEMBER_WORDS: ReadonlySet<string> = new Set(["constructor", "init", "companion"]);

const USE_SITE_TARGETS: ReadonlySet<string> = new Set([
	"field",
	"property",
	"get",
	"set",
	"receiver",
	"param",
	"setparam",
	"delegate",
	"file",
	"all",
]);

const ASSIGNMENTS: ReadonlySet<string> = new Set(["=", "+=", "-=", "*=", "/=", "%="]);

const EQUALITY: ReadonlySet<string> = new Set(["==", "!=", "===", "!=="]);

const COMPARISON: ReadonlySet<string> = new Set(["<", ">", "<=", ">="]);

const ADDITIVE: ReadonlySet<string> = new Set(["+", "-"]);

const MULTIPLICATIVE: ReadonlySet<string> = new Set(["*", "/", "%"]);

const PREFIX: ReadonlySet<string> = new Set(["++", "--", "+", "-", "!"]);

/** Closers that end a statement list or an argument list during recovery. */
const CLOSERS: ReadonlySet<string> = new Set(["}", ")", "]"]);

////////////////////////////////
//  Functions & Helpers

function leafOf(token: Token, type: string, named: boolean, field: string | null = null): SyntaxNode {
	return { type, named, missing: false, field, start: token.start, end: token.end, parent: null, children: [] };
}

function withField(node: SyntaxNode, field: string): SyntaxNode {
	node.field = field;
	return node;
}

function linkParents(node: SyntaxNode): void {
	const stack = [node];
	while (stack.length > 0) {
		const current = stack.pop() as SyntaxNode;
		for (const child of current.children) {
			child.parent = current;
			stack.push(child);
		}
	}
}

/** First child starting at or after `offset`; children in source order. */
function firstChildFrom(children: readonly SyntaxNode[], offset: number): number {
	let low = 0;
	let high = children.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((children[middle] as SyntaxNode).start < offset) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** The deepest node spanning `leaf`, in source order among its children. */
function insertExtra(root: SyntaxNode, leaf: SyntaxNode): void {
	let parent = root;
	for (;;) {
		// Only the last child starting before the leaf can span it.
		const inner = parent.children[firstChildFrom(parent.children, leaf.start) - 1];
		if (inner === undefined || inner.children.length === 0 || leaf.end >= inner.end) break;
		parent = inner;
	}
	parent.children.splice(firstChildFrom(parent.children, leaf.end), 0, leaf);
}

function leavesIn(root: SyntaxNode): SyntaxNode[] {
	const leaves: SyntaxNode[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop() as SyntaxNode;
		if (current.children.length === 0) leaves.push(current);
		for (let index = current.children.length - 1; index >= 0; index--) {
			stack.push(current.children[index] as SyntaxNode);
		}
	}
	return leaves;
}

////////////////////////////////
//  Classes

class KotlinGrammar {
	private at = 0;
	private readonly problems: GrammarProblem[] = [];

	constructor(
		private readonly text: string,
		private readonly tokens: Token[],
		/** Shared with each template's grammar, so nesting counts across both. */
		private readonly gauge = new NestingGauge(),
		private readonly meter?: WorkMeter,
	) {}

	////////////////////////////////
	//  Tokens

	private peek(ahead = 0): Token {
		return this.tokens[Math.min(this.at + ahead, this.tokens.length - 1)] as Token;
	}

	private get token(): Token {
		return this.peek();
	}

	private get done(): boolean {
		return this.token.kind === "eof";
	}

	/** A keyword, word or punctuation spelled `text`; never a literal. */
	private is(text: string, ahead = 0): boolean {
		const token = this.peek(ahead);
		return (
			token.text === text &&
			(token.kind === "identifier" || token.kind === "keyword" || token.kind === "punct" || token.kind === "jump")
		);
	}

	/** A plain or soft-keyword name. */
	private isName(ahead = 0): boolean {
		return this.peek(ahead).kind === "identifier";
	}

	private newline(ahead = 0): boolean {
		return this.peek(ahead).newlineBefore;
	}

	/** Adjacent to the token before it. */
	private tight(ahead = 0): boolean {
		return !this.peek(ahead).spaceBefore;
	}

	private advance(): Token {
		const token = this.token;
		if (token.kind !== "eof") this.at++;
		return token;
	}

	/** The token as an anonymous leaf spelled as written. */
	private word(field: string | null = null): SyntaxNode {
		const token = this.advance();
		return leafOf(token, token.text, false, field);
	}

	private named(type: string, field: string | null = null): SyntaxNode {
		return leafOf(this.advance(), type, true, field);
	}

	private identifier(field: string | null = null): SyntaxNode {
		return this.named("identifier", field);
	}

	/** Two adjacent tokens read as one leaf. */
	private joined(type: string, field: string | null = null): SyntaxNode {
		const first = this.advance();
		const second = this.advance();
		return {
			type,
			named: false,
			missing: false,
			field,
			start: first.start,
			end: second.end,
			parent: null,
			children: [],
		};
	}

	private node(type: string, children: SyntaxNode[], field: string | null = null): SyntaxNode {
		const first = children[0];
		const last = children.at(-1);
		const start = first?.start ?? this.token.start;
		return { type, named: true, missing: false, field, start, end: last?.end ?? start, parent: null, children };
	}

	/** A zero-width leaf where `type` belongs: after the previous token, or at the first. */
	private missing(type: string): SyntaxNode {
		const at = this.at === 0 ? (this.tokens[0] as Token).start : (this.tokens[this.at - 1] as Token).end;
		this.problem(`expected ${type}`, at, at);
		return { type, named: false, missing: true, field: null, start: at, end: at, parent: null, children: [] };
	}

	/** The token `text` when next, else a missing leaf. */
	private expect(text: string): SyntaxNode {
		return this.is(text) ? this.word() : this.missing(text);
	}

	private problem(message: string, start: number, end: number): void {
		this.problems.push({ message, start, end });
	}

	/** Skips to a statement boundary; the skipped tokens become an ERROR node. */
	private error(stopAtNewline: boolean): SyntaxNode {
		const children: SyntaxNode[] = [];
		const start = this.at;
		let depth = 0;
		while (!this.done) {
			if (this.at > start && depth === 0) {
				if (stopAtNewline && this.newline()) break;
				if (this.is(";")) break;
				if (CLOSERS.has(this.token.text) && this.token.kind === "punct") break;
			}
			if (this.token.kind === "punct" && (this.is("{") || this.is("(") || this.is("["))) depth++;
			if (this.token.kind === "punct" && CLOSERS.has(this.token.text)) depth = Math.max(0, depth - 1);
			children.push(this.token.kind === "identifier" ? this.identifier() : this.word());
			if (this.at === start + 1 && depth === 0 && !stopAtNewline) break;
		}
		const node = this.node("ERROR", children);
		this.problem("unexpected tokens", node.start, node.end);
		return node;
	}

	/** Parses speculatively; rewinds and answers null when `parse` does. */
	private attempt<T>(parse: () => T | null): T | null {
		const at = this.at;
		const problems = this.problems.length;
		const result = parse();
		if (result === null || this.problems.length > problems) {
			this.at = at;
			this.problems.length = problems;
			return null;
		}
		return result;
	}

	////////////////////////////////
	//  File

	sourceFile(comments: readonly Comment[]): GrammarResult {
		const children: SyntaxNode[] = [];
		try {
			while (this.is("@") && this.isName(1) && this.peek(1).text === "file" && this.is(":", 2) && this.tight(2)) {
				children.push(this.fileAnnotation());
			}
			if (this.is("package")) children.push(this.packageHeader());
			while (this.is("import")) children.push(this.importDirective());
			children.push(...this.statements("file", false));
		} catch (error) {
			if (!isTooDeep(error)) throw error;
			this.problem(TOO_DEEP, this.token.start, this.token.end);
		}
		const root = this.node("source_file", children);
		const firstToken =
			(this.tokens[0] as Token).kind === "eof" ? this.text.length : (this.tokens[0] as Token).start;
		root.start = Math.min(firstToken, comments[0]?.start ?? this.text.length);
		if (root.start === this.text.length) root.start = 0;
		root.end = this.text.length;
		for (const comment of comments) {
			const leaf: SyntaxNode = {
				type: comment.type,
				named: true,
				missing: false,
				field: null,
				start: comment.start,
				end: comment.end,
				parent: null,
				children: [],
			};
			insertExtra(root, leaf);
		}
		linkParents(root);
		return { tree: { root, leaves: leavesIn(root) }, problems: this.problems };
	}

	private fileAnnotation(): SyntaxNode {
		const children = [this.word(), this.word(), this.word()];
		if (this.is("[")) {
			children.push(this.word());
			while (!this.done && !this.is("]")) children.push(this.unescapedAnnotation());
			children.push(this.expect("]"));
		} else {
			children.push(this.unescapedAnnotation());
		}
		return this.node("file_annotation", children);
	}

	private packageHeader(): SyntaxNode {
		const children = [this.word(), this.qualifiedIdentifier()];
		if (this.is(";") && !this.newline()) children.push(this.word());
		return this.node("package_header", children);
	}

	private importDirective(): SyntaxNode {
		const children = [this.word(), this.qualifiedIdentifier()];
		if (this.is(".") && this.is("*", 1)) {
			children.push(this.word(), this.word());
		} else if (this.is("as") && !this.newline()) {
			children.push(this.word(), this.isName() ? this.identifier() : this.missing("identifier"));
		}
		if (this.is(";") && !this.newline()) children.push(this.word());
		return this.node("import", children);
	}

	private qualifiedIdentifier(): SyntaxNode {
		const children = [this.isName() ? this.identifier() : this.missing("identifier")];
		while (this.is(".") && this.isName(1) && !this.newline(1)) children.push(this.word(), this.identifier());
		return this.node("qualified_identifier", children);
	}

	////////////////////////////////
	//  Statements

	/** Statements to the end of the file, or to the closing brace when `braced`. */
	private statements(place: Place, braced: boolean): SyntaxNode[] {
		const nodes: SyntaxNode[] = [];
		let guard = -1;
		while (!this.done) {
			if (this.at <= guard) throw new Error("Kotlin statement list failed to advance");
			guard = this.at;
			if (this.is(";")) {
				this.advance();
				continue;
			}
			if (braced && this.is("}")) break;
			if (!braced && CLOSERS.has(this.token.text) && this.token.kind === "punct") {
				nodes.push(this.error(false));
				continue;
			}
			const statement = this.statement(place);
			nodes.push(statement);
			if (!this.done && !this.is(";") && !this.newline() && !(braced && this.is("}"))) {
				nodes.push(this.error(true));
			}
		}
		return nodes;
	}

	private statement(place: Place): SyntaxNode {
		this.gauge.open();
		try {
			const start = this.at;
			const declaration = this.declaration(place);
			if (declaration !== null) return declaration;
			const loop = this.loopStatement();
			if (loop !== null) return loop;
			const expression = this.expressionOrAssignment();
			if (this.at === start) return this.error(true);
			return expression;
		} finally {
			this.gauge.close();
		}
	}

	/** A loop, labeled or not, or null when none starts here. */
	private loopStatement(): SyntaxNode | null {
		if (this.token.kind === "label" && (this.is("for", 1) || this.is("while", 1) || this.is("do", 1))) {
			const label = this.named("label");
			return this.loop(label);
		}
		if (this.is("for") || this.is("while") || this.is("do")) return this.loop(null);
		return null;
	}

	private expressionOrAssignment(): SyntaxNode {
		const left = this.expression();
		if (this.token.kind === "punct" && ASSIGNMENTS.has(this.token.text) && !this.newline()) {
			withField(left, "left");
			const operator = this.word("operator");
			const right = withField(this.expression(), "right");
			return this.node("assignment", [left, operator, right]);
		}
		return left;
	}

	private loop(label: SyntaxNode | null): SyntaxNode {
		const children = label === null ? [] : [label];
		if (this.is("for")) {
			children.push(this.word(), this.expect("("));
			while (this.is("@")) children.push(this.annotation());
			children.push(this.is("(") ? this.multiVariableDeclaration() : this.variableDeclaration());
			children.push(this.expect("in"), this.expression(), this.expect(")"));
			const body = this.controlBody();
			if (body !== null) children.push(body);
			return this.node("for_statement", children);
		}
		if (this.is("while")) {
			children.push(this.word(), this.expect("("), withField(this.expression(), "condition"), this.expect(")"));
			if (this.is(";") && !this.newline()) children.push(this.word());
			else {
				const body = this.controlBody();
				if (body !== null) children.push(body);
			}
			return this.node("while_statement", children);
		}
		children.push(this.word());
		if (!this.is("while")) {
			const body = this.controlBody();
			if (body !== null) children.push(body);
		}
		children.push(
			this.expect("while"),
			this.expect("("),
			withField(this.expression(), "condition"),
			this.expect(")"),
		);
		return this.node("do_while_statement", children);
	}

	/** A branch of `if` or a loop body. A brace opens a lambda only when parameters and an arrow follow. */
	private controlBody(): SyntaxNode | null {
		if (this.done || this.is("}") || this.is(")") || this.is(";") || this.is("else")) return null;
		if (this.is("{")) return this.lambdaAhead() ? this.lambdaLiteral() : this.block();
		return this.statement("local");
	}

	private block(): SyntaxNode {
		const children = [this.expect("{"), ...this.statements("local", true), this.expect("}")];
		return this.node("block", children);
	}

	////////////////////////////////
	//  Declarations

	/** A declaration at the cursor, or null (nothing consumed) when none starts here. */
	private declaration(place: Place): SyntaxNode | null {
		// Outside a class body these are plain names.
		if (place !== "class" && this.isName() && CLASS_MEMBER_WORDS.has(this.token.text)) return null;
		const modifiersEnd = this.modifiersEnd();
		if (modifiersEnd === null) return null;
		const modifiers = modifiersEnd > this.at ? this.modifiers(modifiersEnd) : null;
		const prefix = modifiers === null ? [] : [modifiers];
		const token = this.token;
		switch (token.text) {
			case "class":
				return this.classDeclaration(prefix);
			case "interface":
				return this.classDeclaration(prefix);
			case "fun":
				if (this.is("interface", 1)) return this.classDeclaration(prefix);
				return this.functionDeclaration(prefix);
			case "val":
			case "var":
				return this.propertyDeclaration(prefix, place);
			case "object":
				return this.objectDeclaration(prefix);
			case "typealias":
				return this.typeAlias(prefix);
			case "companion":
				return this.companionObject(prefix);
			case "constructor":
				return this.secondaryConstructor(prefix);
			case "init":
				return this.node("anonymous_initializer", [this.word(), this.block()]);
		}
		// Modifiers read, yet no declaration: the annotations annotate an expression.
		return modifiers === null ? null : this.annotatedExpression(modifiers);
	}

	/**
	 * Where the modifier run at the cursor ends, when a declaration keyword follows it; null when the
	 * cursor starts no declaration. An annotation run before an expression also answers its end.
	 */
	private modifiersEnd(): number | null {
		let ahead = 0;
		let annotated = false;
		for (;;) {
			const token = this.peek(ahead);
			if (token.kind === "punct" && token.text === "@") {
				const end = this.annotationEnd(ahead);
				if (end === null) return null;
				ahead = end;
				annotated = true;
				continue;
			}
			if (token.kind === "identifier" && MODIFIER_TYPES.has(token.text) && this.modifierFollows(ahead + 1)) {
				ahead++;
				continue;
			}
			const context = this.contextEnd(ahead);
			if (context !== null && this.modifierFollows(context)) {
				ahead = context;
				continue;
			}
			break;
		}
		const next = this.peek(ahead);
		const starts = this.startsDeclaration(ahead);
		if (starts) return this.at + ahead;
		if (next.kind === "keyword" && next.text === "interface") return this.at + ahead;
		return annotated ? this.at + ahead : ahead === 0 ? null : null;
	}

	/** A modifier word is one only before another modifier, an annotation or a declaration. */
	private modifierFollows(ahead: number): boolean {
		const next = this.peek(ahead);
		if (
			next.newlineBefore &&
			next.kind !== "keyword" &&
			!(next.kind === "identifier" && MODIFIER_TYPES.has(next.text))
		)
			return this.startsDeclaration(ahead);
		if (next.kind === "punct" && next.text === "@") return true;
		if (next.kind === "identifier" && MODIFIER_TYPES.has(next.text)) return true;
		const context = this.contextEnd(ahead);
		if (context !== null) return this.modifierFollows(context);
		return this.startsDeclaration(ahead);
	}

	/** The token index past `context(...)` starting `ahead` tokens on, or null. */
	private contextEnd(ahead: number): number | null {
		const word = this.peek(ahead);
		const open = this.peek(ahead + 1);
		if (word.kind !== "identifier" || word.text !== "context") return null;
		if (open.kind !== "punct" || open.text !== "(" || open.spaceBefore) return null;
		let depth = 0;
		for (let at = ahead + 1; ; at++) {
			const token = this.peek(at);
			if (token.kind === "eof") return null;
			if (token.kind !== "punct") continue;
			if (token.text === "(") depth++;
			else if (token.text === ")" && --depth === 0) return at + 1;
		}
	}

	private startsDeclaration(ahead: number): boolean {
		const token = this.peek(ahead);
		if (token.kind === "keyword") {
			if (token.text === "fun")
				return (
					!(this.peek(ahead + 1).kind === "punct" && this.peek(ahead + 1).text === "(") &&
					!this.namelessFunction(ahead)
				);
			if (token.text === "object") {
				const next = this.peek(ahead + 1);
				return next.kind === "identifier" && !next.newlineBefore;
			}
			return ["class", "interface", "val", "var", "typealias"].includes(token.text);
		}
		if (token.kind !== "identifier") return false;
		const next = this.peek(ahead + 1);
		switch (token.text) {
			case "companion":
				return next.kind === "keyword" && next.text === "object";
			case "constructor":
				return next.kind === "punct" && next.text === "(";
			case "init":
				return next.kind === "punct" && next.text === "{";
			default:
				return false;
		}
	}

	/** `fun Type.(...)` names no function: an anonymous function with a receiver. */
	private namelessFunction(ahead: number): boolean {
		let depth = 0;
		for (let at = ahead + 1; ; at++) {
			const token = this.peek(at);
			if (token.kind === "punct") {
				if (token.text === "<") depth++;
				else if (token.text === ">") depth--;
				else if (token.text === "(" && depth === 0) return this.is(".", at - 1);
				else if (depth === 0 && token.text !== "." && token.text !== "?") return false;
			} else if (token.kind !== "identifier" && token.kind !== "keyword") {
				return false;
			}
		}
	}

	/** The token index past an annotation starting `ahead` tokens on, or null when malformed. */
	private annotationEnd(ahead: number): number | null {
		let at = ahead + 1;
		if (this.peek(at).kind === "identifier" && USE_SITE_TARGETS.has(this.peek(at).text)) {
			const colon = this.peek(at + 1);
			if (colon.kind === "punct" && colon.text === ":" && !colon.spaceBefore) at += 2;
		}
		if (this.peek(at).kind === "punct" && this.peek(at).text === "[") {
			let depth = 0;
			for (;;) {
				const token = this.peek(at);
				if (token.kind === "eof") return null;
				if (token.kind === "punct" && token.text === "[") depth++;
				if (token.kind === "punct" && token.text === "]") {
					depth--;
					if (depth === 0) return at + 1;
				}
				at++;
			}
		}
		if (this.peek(at).kind !== "identifier") return null;
		at++;
		for (;;) {
			const token = this.peek(at);
			if (token.kind === "punct" && token.text === "." && this.peek(at + 1).kind === "identifier") {
				at += 2;
				continue;
			}
			if (token.kind === "punct" && token.text === "<" && !token.spaceBefore) {
				const end = this.typeArgumentsEnd(at);
				if (end === null) break;
				at = end;
				continue;
			}
			break;
		}
		const open = this.peek(at);
		if (open.kind === "punct" && open.text === "(" && !open.spaceBefore) {
			let depth = 0;
			for (;;) {
				const token = this.peek(at);
				if (token.kind === "eof") return null;
				if (token.kind === "punct" && token.text === "(") depth++;
				if (token.kind === "punct" && token.text === ")") {
					depth--;
					if (depth === 0) return at + 1;
				}
				at++;
			}
		}
		return at;
	}

	/** Past a balanced `<...>` holding only type tokens, or null. */
	private typeArgumentsEnd(ahead: number): number | null {
		let depth = 0;
		let at = ahead;
		for (;;) {
			const token = this.peek(at);
			if (token.kind === "eof") return null;
			if (token.kind === "punct") {
				if (token.text === "<") depth++;
				else if (token.text === ">") {
					depth--;
					if (depth === 0) return at + 1;
				} else if (![",", ".", "?", "*", "(", ")", "->", ":", "&", "@"].includes(token.text)) return null;
			} else if (token.kind === "keyword" && !["in", "out"].includes(token.text)) {
				return null;
			} else if (token.kind !== "identifier" && token.kind !== "keyword") {
				return null;
			}
			at++;
		}
	}

	private modifiers(end: number): SyntaxNode {
		const children: SyntaxNode[] = [];
		while (this.at < end) {
			if (this.is("@")) {
				children.push(this.annotation());
				continue;
			}
			if (this.is("context") && this.is("(", 1)) {
				children.push(this.contextParameters());
				continue;
			}
			const type = MODIFIER_TYPES.get(this.token.text) as string;
			children.push(this.node(type, [this.word()]));
		}
		return this.node("modifiers", children);
	}

	/** `context(name: Type, Type)`: context parameters, or receivers named by type alone. */
	private contextParameters(): SyntaxNode {
		const children = [this.word(), this.word()];
		while (!this.done && !this.is(")")) {
			children.push(this.isName() && this.is(":", 1) ? this.parameter() : this.type());
			if (!this.is(",")) break;
			children.push(this.word());
		}
		children.push(this.expect(")"));
		return this.node("context_parameters", children);
	}

	private annotatedExpression(modifiers: SyntaxNode): SyntaxNode {
		// `@A @B x` nests one annotation per node, the first outermost.
		const annotations = modifiers.children;
		let inner = this.loopStatement() ?? this.expressionOrAssignment();
		for (let index = annotations.length - 1; index >= 0; index--) {
			inner = this.node("annotated_expression", [annotations[index] as SyntaxNode, inner]);
		}
		return inner;
	}

	private annotation(): SyntaxNode {
		const children = [this.word()];
		if (this.isName() && USE_SITE_TARGETS.has(this.token.text) && this.is(":", 1) && this.tight(1)) {
			children.push(this.node("use_site_target", [this.word(), this.word()]));
		}
		if (this.is("[")) {
			children.push(this.word());
			while (!this.done && !this.is("]")) children.push(this.unescapedAnnotation());
			children.push(this.expect("]"));
		} else {
			children.push(this.unescapedAnnotation());
		}
		return this.node("annotation", children);
	}

	/** A type, or a constructor invocation when arguments follow at once. */
	private unescapedAnnotation(): SyntaxNode {
		const type = this.userType(false);
		if (this.is("(") && this.tight()) return this.node("constructor_invocation", [type, this.valueArguments()]);
		return type;
	}

	private classDeclaration(prefix: SyntaxNode[]): SyntaxNode {
		const children = [...prefix];
		if (this.is("fun")) children.push(this.word());
		const isEnum = prefix.some((node) =>
			node.children.some((child) => child.type === "class_modifier" && child.children[0]?.type === "enum"),
		);
		children.push(this.word());
		children.push(this.isName() ? this.identifier("name") : this.missing("identifier"));
		if (this.is("<")) children.push(this.typeParameters());
		if (this.startsPrimaryConstructor()) children.push(this.primaryConstructor());
		// The specification allows line breaks before `:`; no statement starts with one.
		if (this.is(":")) children.push(this.word(), this.delegationSpecifiers());
		if (this.is("where")) children.push(this.typeConstraints());
		if (this.is("{") && !this.newline()) children.push(isEnum ? this.enumClassBody() : this.classBody());
		else if (this.is("{") && this.newline()) children.push(isEnum ? this.enumClassBody() : this.classBody());
		return this.node("class_declaration", children);
	}

	private startsPrimaryConstructor(): boolean {
		if (this.is("(") && !this.newline()) return true;
		const end = this.modifiersEnd();
		if (end === null) return false;
		return (this.is("constructor", end - this.at) && this.is("(", end - this.at + 1)) || this.is("constructor");
	}

	private primaryConstructor(): SyntaxNode {
		const children: SyntaxNode[] = [];
		if (!this.is("(")) {
			const end = this.modifiersEnd() ?? this.at;
			if (end > this.at) children.push(this.modifiers(end));
			children.push(this.expect("constructor"));
		}
		children.push(this.classParameters());
		return this.node("primary_constructor", children);
	}

	private classParameters(): SyntaxNode {
		const children = [this.expect("(")];
		while (!this.done && !this.is(")")) {
			children.push(this.classParameter());
			if (this.is(",")) children.push(this.word());
			else break;
		}
		children.push(this.expect(")"));
		return this.node("class_parameters", children);
	}

	private classParameter(): SyntaxNode {
		const children: SyntaxNode[] = [];
		const end = this.parameterModifiersEnd();
		if (end > this.at) children.push(this.modifiers(end));
		if (this.is("val") || this.is("var")) children.push(this.word());
		children.push(this.isName() ? this.identifier() : this.missing("identifier"));
		children.push(this.expect(":"), this.type());
		if (this.is("=")) children.push(this.word(), this.expression());
		return this.node("class_parameter", children);
	}

	/** Annotations and modifier words before a parameter name. */
	private parameterModifiersEnd(): number {
		let ahead = 0;
		for (;;) {
			const token = this.peek(ahead);
			if (token.kind === "punct" && token.text === "@") {
				const end = this.annotationEnd(ahead);
				if (end === null) break;
				ahead = end;
				continue;
			}
			const next = this.peek(ahead + 1);
			if (
				token.kind === "identifier" &&
				MODIFIER_TYPES.has(token.text) &&
				(next.kind === "identifier" ||
					(next.kind === "keyword" && (next.text === "val" || next.text === "var")) ||
					next.text === "@")
			) {
				ahead++;
				continue;
			}
			break;
		}
		return this.at + ahead;
	}

	private delegationSpecifiers(): SyntaxNode {
		const children = [this.delegationSpecifier()];
		while (this.is(",")) children.push(this.word(), this.delegationSpecifier());
		return this.node("delegation_specifiers", children);
	}

	private delegationSpecifier(): SyntaxNode {
		const children: SyntaxNode[] = [];
		while (this.is("@")) children.push(this.annotation());
		const type = this.type();
		if (this.is("(") && !this.newline()) {
			children.push(this.node("constructor_invocation", [type, this.valueArguments()]));
		} else if (this.is("by")) {
			const by = this.word();
			children.push(this.node("explicit_delegation", [type, by, this.expression({ lambda: false })]));
		} else {
			children.push(type);
		}
		return this.node("delegation_specifier", children);
	}

	private typeConstraints(): SyntaxNode {
		const children = [this.word(), this.typeConstraint()];
		while (this.is(",")) children.push(this.word(), this.typeConstraint());
		return this.node("type_constraints", children);
	}

	private typeConstraint(): SyntaxNode {
		const children: SyntaxNode[] = [];
		while (this.is("@")) children.push(this.annotation());
		children.push(this.isName() ? this.identifier() : this.missing("identifier"), this.expect(":"), this.type());
		return this.node("type_constraint", children);
	}

	private classBody(): SyntaxNode {
		this.gauge.open();
		try {
			const children = [this.expect("{"), ...this.members(), this.expect("}")];
			return this.node("class_body", children);
		} finally {
			this.gauge.close();
		}
	}

	private members(): SyntaxNode[] {
		const nodes: SyntaxNode[] = [];
		let guard = -1;
		while (!this.done && !this.is("}")) {
			if (this.meter !== undefined) this.meter.steps++;
			if (this.at <= guard) throw new Error("Kotlin member list failed to advance");
			guard = this.at;
			if (this.is(";")) {
				this.advance();
				continue;
			}
			const member = this.declaration("class");
			nodes.push(member ?? this.error(true));
		}
		return nodes;
	}

	private enumClassBody(): SyntaxNode {
		const children = [this.expect("{")];
		while (!this.done && !this.is("}") && !this.is(";")) {
			const start = this.at;
			children.push(this.enumEntry());
			if (this.is(",")) children.push(this.word());
			else if (this.at === start) children.push(this.error(true));
			else break;
		}
		if (this.is(";")) {
			children.push(this.word());
			children.push(...this.members());
		}
		children.push(this.expect("}"));
		return this.node("enum_class_body", children);
	}

	private enumEntry(): SyntaxNode {
		const children: SyntaxNode[] = [];
		const end = this.modifiersEnd();
		if (end !== null && end > this.at) children.push(this.modifiers(end));
		else {
			let ahead = 0;
			while (this.peek(ahead).text === "@") {
				const next = this.annotationEnd(ahead);
				if (next === null) break;
				ahead = next;
			}
			if (ahead > 0) children.push(this.modifiers(this.at + ahead));
		}
		children.push(this.isName() ? this.identifier() : this.missing("identifier"));
		if (this.is("(") && !this.newline()) children.push(this.valueArguments());
		if (this.is("{")) children.push(this.classBody());
		return this.node("enum_entry", children);
	}

	private objectDeclaration(prefix: SyntaxNode[]): SyntaxNode {
		const children = [...prefix, this.word()];
		children.push(this.isName() ? this.identifier("name") : this.missing("identifier"));
		if (this.is(":")) children.push(this.word(), this.delegationSpecifiers());
		if (this.is("{")) children.push(this.classBody());
		return this.node("object_declaration", children);
	}

	private companionObject(prefix: SyntaxNode[]): SyntaxNode {
		const children = [...prefix, this.word(), this.word()];
		if (this.isName() && !this.newline()) children.push(this.identifier("name"));
		if (this.is(":")) children.push(this.word(), this.delegationSpecifiers());
		if (this.is("{")) children.push(this.classBody());
		return this.node("companion_object", children);
	}

	private secondaryConstructor(prefix: SyntaxNode[]): SyntaxNode {
		const children = [...prefix, this.word(), this.functionValueParameters()];
		if (this.is(":")) {
			children.push(this.word());
			const target = this.is("this") || this.is("super") ? this.word() : this.missing("this");
			children.push(this.node("constructor_delegation_call", [target, this.valueArguments()]));
		}
		if (this.is("{")) children.push(this.block());
		return this.node("secondary_constructor", children);
	}

	private typeAlias(prefix: SyntaxNode[]): SyntaxNode {
		const children = [...prefix, this.word()];
		children.push(this.isName() ? this.identifier("type") : this.missing("identifier"));
		if (this.is("<")) children.push(this.typeParameters());
		children.push(this.expect("="), this.type());
		return this.node("type_alias", children);
	}

	private functionDeclaration(prefix: SyntaxNode[]): SyntaxNode {
		const children = [...prefix, this.word()];
		if (this.is("<")) children.push(this.typeParameters());
		if (!(this.isName() && this.is("(", 1))) {
			children.push(this.receiverType("("));
			children.push(this.expect("."));
		}
		children.push(this.isName() ? this.identifier("name") : this.missing("identifier"));
		children.push(this.functionValueParameters());
		if (this.is(":")) children.push(this.word(), this.type());
		if (this.is("where")) children.push(this.typeConstraints());
		const body = this.functionBody();
		if (body !== null) children.push(body);
		return this.node("function_declaration", children);
	}

	/** A receiver type ending where `.name` and then `stop` follow. */
	private receiverType(stop: string): SyntaxNode {
		const children: SyntaxNode[] = [];
		if (this.startsTypeModifiers()) children.push(this.typeModifiers());
		let type: SyntaxNode;
		if (this.is("(")) type = this.parenthesizedOrFunctionType([]);
		else if (this.is("dynamic")) type = this.word();
		else type = this.userType(true, stop);
		while (this.is("?") && this.tight()) type = this.node("nullable_type", [type, this.word()]);
		if (children.length > 0) {
			// Modifiers wrap the type they precede.
			type.children.unshift(...children);
			type.start = (children[0] as SyntaxNode).start;
		}
		return type;
	}

	private functionValueParameters(): SyntaxNode {
		const children = [this.expect("(")];
		while (!this.done && !this.is(")")) {
			const end = this.parameterModifiersEnd();
			if (end > this.at) children.push(this.parameterModifiers(end));
			children.push(this.parameter());
			if (this.is("=")) children.push(this.word(), this.expression());
			if (this.is(",")) children.push(this.word());
			else break;
		}
		children.push(this.expect(")"));
		return this.node("function_value_parameters", children);
	}

	private parameterModifiers(end: number): SyntaxNode {
		const children: SyntaxNode[] = [];
		while (this.at < end) {
			if (this.is("@")) children.push(this.annotation());
			else if (PARAMETER_MODIFIERS.has(this.token.text))
				children.push(this.node("parameter_modifier", [this.word()]));
			else children.push(this.node(MODIFIER_TYPES.get(this.token.text) as string, [this.word()]));
		}
		return this.node("parameter_modifiers", children);
	}

	private parameter(): SyntaxNode {
		const children = [
			this.isName() ? this.identifier() : this.missing("identifier"),
			this.expect(":"),
			this.type(),
		];
		return this.node("parameter", children);
	}

	private functionBody(): SyntaxNode | null {
		if (this.is("{")) return this.node("function_body", [this.block()]);
		if (this.is("=")) return this.node("function_body", [this.word(), this.expression()]);
		return null;
	}

	private propertyDeclaration(prefix: SyntaxNode[], place: Place): SyntaxNode {
		const children = [...prefix, this.word()];
		if (this.is("<")) children.push(this.typeParameters());
		if (this.hasReceiver()) {
			children.push(this.receiverType(""));
			children.push(this.expect("."));
		}
		children.push(this.is("(") ? this.multiVariableDeclaration() : this.variableDeclaration());
		if (this.is("where")) children.push(this.typeConstraints());
		if (this.is("=")) children.push(this.word(), this.expression());
		else if (this.is("by")) children.push(this.node("property_delegate", [this.word(), this.expression()]));
		// A `;` here separates statements unless an accessor follows it.
		if (this.is(";") && !this.newline() && place !== "local" && this.accessorAfterSemicolon()) {
			children.push(this.word());
		}
		if (place !== "local") children.push(...this.accessors());
		return this.node("property_declaration", children);
	}

	/** A dot at depth zero before the property name ends. */
	private hasReceiver(): boolean {
		let ahead = 0;
		let depth = 0;
		for (;;) {
			const token = this.peek(ahead);
			if (token.kind === "eof") return false;
			// A line break ends the search at any depth, so an unmatched `<` costs one line.
			if (ahead > 0 && token.newlineBefore) return false;
			if (token.kind === "punct") {
				if (token.text === "<" || token.text === "(") depth++;
				else if (token.text === ">" || token.text === ")") depth--;
				else if (depth === 0 && token.text === ".") return true;
				else if (depth === 0 && [":", "=", ";", "{", "}"].includes(token.text)) return false;
			} else if (depth === 0 && token.kind === "identifier" && token.text === "by" && ahead > 0) {
				return false;
			} else if (token.kind !== "identifier" && token.kind !== "keyword") {
				if (depth === 0) return false;
			}
			ahead++;
		}
	}

	private accessorAfterSemicolon(): boolean {
		const at = this.at;
		this.at++;
		const found = this.accessorModifiersEnd() !== null;
		this.at = at;
		return found;
	}

	private accessors(): SyntaxNode[] {
		const nodes: SyntaxNode[] = [];
		for (let count = 0; count < 2; count++) {
			const end = this.accessorModifiersEnd();
			if (end === null) break;
			const modifiers = end > this.at ? this.modifiers(end) : null;
			const prefix = modifiers === null ? [] : [modifiers];
			nodes.push(this.is("get") ? this.getter(prefix) : this.setter(prefix));
			if (this.is(";") && !this.newline()) this.advance();
		}
		return nodes;
	}

	/** The end of the modifiers before `get` or `set`, or null when no accessor starts here. */
	private accessorModifiersEnd(): number | null {
		let ahead = 0;
		for (;;) {
			const token = this.peek(ahead);
			if (token.kind === "punct" && token.text === "@") {
				const end = this.annotationEnd(ahead);
				if (end === null) return null;
				ahead = end;
				continue;
			}
			if (token.kind === "identifier" && MODIFIER_TYPES.has(token.text)) {
				ahead++;
				continue;
			}
			break;
		}
		const word = this.peek(ahead);
		if (word.kind !== "identifier" || (word.text !== "get" && word.text !== "set")) return null;
		const next = this.peek(ahead + 1);
		const ends =
			next.kind === "eof" ||
			next.newlineBefore ||
			(next.kind === "punct" && [";", "}", "(", "=", "{"].includes(next.text));
		return ends ? this.at + ahead : null;
	}

	private getter(prefix: SyntaxNode[]): SyntaxNode {
		const children = [...prefix, this.word()];
		if (this.is("(") && !this.newline()) {
			children.push(this.word(), this.expect(")"));
			if (this.is(":")) children.push(this.word(), this.type());
			const body = this.functionBody();
			if (body !== null) children.push(body);
		} else if (this.is("=") || (this.is("{") && !this.newline())) {
			const body = this.functionBody();
			if (body !== null) children.push(body);
		}
		return this.node("getter", children);
	}

	private setter(prefix: SyntaxNode[]): SyntaxNode {
		const children = [...prefix, this.word()];
		if (this.is("(") && !this.newline()) {
			children.push(this.word());
			const end = this.parameterModifiersEnd();
			if (end > this.at) children.push(this.parameterModifiers(end));
			children.push(this.isName() ? this.identifier() : this.missing("identifier"));
			if (this.is(":")) children.push(this.word(), this.type());
			if (this.is("=")) children.push(this.word(), this.expression());
			if (this.is(",")) this.advance();
			children.push(this.expect(")"));
			if (this.is(":")) children.push(this.word(), this.type());
			const body = this.functionBody();
			if (body !== null) children.push(body);
		}
		return this.node("setter", children);
	}

	private variableDeclaration(): SyntaxNode {
		const children: SyntaxNode[] = [];
		while (this.is("@")) children.push(this.annotation());
		children.push(this.isName() ? this.identifier() : this.missing("identifier"));
		if (this.is(":")) children.push(this.word(), this.type());
		return this.node("variable_declaration", children);
	}

	private multiVariableDeclaration(): SyntaxNode {
		const children = [this.word()];
		while (!this.done && !this.is(")")) {
			children.push(this.variableDeclaration());
			if (this.is(",")) children.push(this.word());
			else break;
		}
		children.push(this.expect(")"));
		return this.node("multi_variable_declaration", children);
	}

	private typeParameters(): SyntaxNode {
		const children = [this.word(), this.typeParameter()];
		while (this.is(",")) {
			children.push(this.word());
			if (this.is(">")) break;
			children.push(this.typeParameter());
		}
		children.push(this.expect(">"));
		return this.node("type_parameters", children);
	}

	private typeParameter(): SyntaxNode {
		const children: SyntaxNode[] = [];
		const modifiers: SyntaxNode[] = [];
		for (;;) {
			if (this.is("@")) modifiers.push(this.annotation());
			else if (this.is("reified") && this.isName(1)) modifiers.push(this.named("reification_modifier"));
			else if ((this.is("in") || this.is("out")) && this.isName(1)) {
				modifiers.push(this.node("variance_modifier", [this.word()]));
			} else break;
		}
		if (modifiers.length > 0) children.push(this.node("type_parameter_modifiers", modifiers));
		children.push(this.isName() ? this.identifier() : this.missing("identifier"));
		if (this.is(":")) children.push(this.word(), this.type());
		return this.node("type_parameter", children);
	}

	////////////////////////////////
	//  Types

	private startsTypeModifiers(): boolean {
		return this.is("@") || (this.is("suspend") && (this.isName(1) || this.is("(", 1) || this.is("@", 1)));
	}

	private typeModifiers(): SyntaxNode {
		const children: SyntaxNode[] = [];
		while (this.startsTypeModifiers()) children.push(this.is("@") ? this.annotation() : this.word());
		return this.node("type_modifiers", children);
	}

	type(): SyntaxNode {
		this.gauge.open();
		try {
			const modifiers = this.startsTypeModifiers() ? [this.typeModifiers()] : [];
			let type: SyntaxNode;
			if (this.is("(")) type = this.parenthesizedOrFunctionType(modifiers);
			else if (this.is("dynamic")) type = this.withModifiers(modifiers, this.word());
			else {
				const user = this.userType(false);
				if (this.is(".") && this.is("(", 1)) type = this.functionType(modifiers, [user, this.word()]);
				else if (this.is("?") && this.tight() && this.is(".", 1) && this.tight(1) && this.is("(", 2)) {
					const nullable = this.node("nullable_type", [user, this.word()]);
					type = this.functionType(modifiers, [nullable, this.word()]);
				} else type = this.withModifiers(modifiers, user);
			}
			for (;;) {
				if (this.is("?") && this.tight()) {
					type = this.node("nullable_type", [type, this.word()]);
					continue;
				}
				if (this.is("&") && !this.newline()) {
					type = this.node("non_nullable_type", [type, this.word(), this.type()]);
					continue;
				}
				break;
			}
			return type;
		} finally {
			this.gauge.close();
		}
	}

	/** Type modifiers become the first children of the type they precede. */
	private withModifiers(modifiers: SyntaxNode[], type: SyntaxNode): SyntaxNode {
		if (modifiers.length === 0) return type;
		if (type.children.length === 0) return this.node("user_type", [...modifiers, type]);
		type.children.unshift(...modifiers);
		type.start = (modifiers[0] as SyntaxNode).start;
		return type;
	}

	private parenthesizedOrFunctionType(modifiers: SyntaxNode[]): SyntaxNode {
		const parameters = this.attempt(() => {
			const node = this.functionTypeParameters();
			return this.is("->") ? node : null;
		});
		if (parameters !== null) {
			return this.node("function_type", [...modifiers, parameters, this.word(), this.type()]);
		}
		const inner = this.node("parenthesized_type", [this.word(), this.type(), this.expect(")")]);
		if (this.is(".") && this.is("(", 1)) return this.functionType(modifiers, [inner, this.word()]);
		return this.withModifiers(modifiers, inner);
	}

	private functionType(modifiers: SyntaxNode[], receiver: SyntaxNode[]): SyntaxNode {
		const parameters = this.functionTypeParameters();
		return this.node("function_type", [...modifiers, ...receiver, parameters, this.expect("->"), this.type()]);
	}

	private functionTypeParameters(): SyntaxNode {
		const children = [this.word()];
		while (!this.done && !this.is(")")) {
			if (this.isName() && this.is(":", 1)) {
				children.push(this.node("parameter", [this.identifier(), this.word(), this.type()]));
			} else {
				children.push(this.type());
			}
			if (this.is(",")) children.push(this.word());
			else break;
		}
		children.push(this.expect(")"));
		return this.node("function_type_parameters", children);
	}

	/** `A.B<C>.D`; with `receiver`, it stops before `.name` then `stop`. */
	private userType(receiver: boolean, stop = ""): SyntaxNode {
		const children = [this.isName() ? this.identifier() : this.missing("identifier")];
		if (this.typeArgumentsNext()) children.push(this.typeArguments());
		while (this.is(".") && this.isName(1)) {
			if (receiver && (stop === "" ? this.endsPropertyName(2) : this.is(stop, 2))) break;
			children.push(this.word(), this.identifier());
			if (this.typeArgumentsNext()) children.push(this.typeArguments());
		}
		return this.node("user_type", children);
	}

	/** In a type, `<` opens its arguments whatever space precedes it, when a balanced list follows. */
	private typeArgumentsNext(): boolean {
		return this.is("<") && (this.tight() || this.typeArgumentsEnd(0) !== null);
	}

	/** After a candidate property name: the declaration continues past the name. */
	private endsPropertyName(ahead: number): boolean {
		const token = this.peek(ahead);
		return (
			token.kind === "eof" ||
			token.newlineBefore ||
			(token.kind === "punct" && [":", "=", ";", "}", ","].includes(token.text)) ||
			(token.kind === "identifier" && (token.text === "by" || token.text === "get" || token.text === "set"))
		);
	}

	private typeArguments(): SyntaxNode {
		const children = [this.word(), this.typeProjection()];
		while (this.is(",")) {
			children.push(this.word());
			if (this.is(">")) break;
			children.push(this.typeProjection());
		}
		children.push(this.expect(">"));
		return this.node("type_arguments", children);
	}

	private typeProjection(): SyntaxNode {
		if (this.is("*")) return this.node("type_projection", [this.word()]);
		const children: SyntaxNode[] = [];
		while ((this.is("in") || this.is("out")) && !this.is(",", 1) && !this.is(">", 1)) {
			children.push(this.node("variance_modifier", [this.word()]));
		}
		children.push(this.type());
		return this.node("type_projection", children);
	}

	////////////////////////////////
	//  Expressions

	/** With `lambda` false, a trailing lambda is left for the caller: a delegation's class body. */
	expression(options: { lambda: boolean } = { lambda: true }): SyntaxNode {
		const saved = this.allowLambda;
		this.allowLambda = options.lambda;
		this.gauge.open();
		try {
			return this.disjunction();
		} finally {
			this.allowLambda = saved;
			this.gauge.close();
		}
	}

	private allowLambda = true;

	private binary(operand: () => SyntaxNode, operators: ReadonlySet<string>, newlineOk: boolean): SyntaxNode {
		let left = operand();
		while (this.token.kind === "punct" && operators.has(this.token.text) && (newlineOk || !this.newline())) {
			withField(left, "left");
			const operator = this.word("operator");
			left = this.node("binary_expression", [left, operator, withField(operand(), "right")]);
		}
		return left;
	}

	private disjunction(): SyntaxNode {
		return this.binary(() => this.conjunction(), new Set(["||"]), true);
	}

	private conjunction(): SyntaxNode {
		return this.binary(() => this.equality(), new Set(["&&"]), true);
	}

	private equality(): SyntaxNode {
		return this.binary(() => this.comparison(), EQUALITY, false);
	}

	private comparison(): SyntaxNode {
		return this.binary(() => this.namedChecks(), COMPARISON, false);
	}

	private namedChecks(): SyntaxNode {
		let left = this.elvis();
		for (;;) {
			if (this.newline()) break;
			if (this.is("in") || this.is("!in")) {
				withField(left, "left");
				left = this.node("in_expression", [left, this.word(), withField(this.elvis(), "right")]);
				continue;
			}
			if (this.is("is") || this.is("!is")) {
				withField(left, "left");
				left = this.node("is_expression", [left, this.word(), withField(this.type(), "right")]);
				continue;
			}
			break;
		}
		return left;
	}

	private elvis(): SyntaxNode {
		let left = this.infixCall();
		while (this.is("?") && this.is(":", 1) && this.tight(1)) {
			withField(left, "left");
			const operator = this.joined("?:", "operator");
			left = this.node("binary_expression", [left, operator, withField(this.infixCall(), "right")]);
		}
		return left;
	}

	private infixCall(): SyntaxNode {
		let left = this.range();
		// The infix name shares the left operand's line; its right operand may start the next.
		while (this.isName() && !this.newline() && this.startsExpression(1, true)) {
			const name = this.identifier();
			left = this.node("infix_expression", [left, name, this.range()]);
		}
		return left;
	}

	private range(): SyntaxNode {
		let left = this.additive();
		while ((this.is("..") || this.is("..<")) && !this.newline()) {
			left = this.node("range_expression", [left, this.word(), this.additive()]);
		}
		return left;
	}

	private additive(): SyntaxNode {
		return this.binary(() => this.multiplicative(), ADDITIVE, false);
	}

	private multiplicative(): SyntaxNode {
		return this.binary(() => this.asExpression(), MULTIPLICATIVE, false);
	}

	private asExpression(): SyntaxNode {
		let left = this.prefix();
		while (this.is("as") || this.is("as?")) {
			withField(left, "left");
			left = this.node("as_expression", [left, this.word(), withField(this.type(), "right")]);
		}
		return left;
	}

	/** Prefixes wrap right to left, so all are read before the operand they wrap. */
	private prefix(): SyntaxNode {
		const wrappers: Array<(inner: SyntaxNode) => SyntaxNode> = [];
		for (;;) {
			if (this.token.kind === "punct" && PREFIX.has(this.token.text)) {
				const operator = this.word("operator");
				wrappers.push((inner) => this.node("unary_expression", [operator, withField(inner, "argument")]));
				continue;
			}
			if (this.is("@")) {
				const annotation = this.annotation();
				wrappers.push((inner) => this.node("annotated_expression", [annotation, inner]));
				continue;
			}
			if (this.token.kind === "label") {
				const label = this.named("label");
				wrappers.push((inner) => this.node("labeled_expression", [label, inner]));
				if (this.is("{")) break;
				continue;
			}
			break;
		}
		let expression = this.postfix();
		for (let index = wrappers.length - 1; index >= 0; index--)
			expression = (wrappers[index] as (inner: SyntaxNode) => SyntaxNode)(expression);
		return expression;
	}

	private postfix(): SyntaxNode {
		let expression = this.primary();
		for (;;) {
			if ((this.is("++") || this.is("--")) && !this.newline()) {
				withField(expression, "argument");
				expression = this.node("unary_expression", [expression, this.word("operator")]);
				continue;
			}
			if (this.is("!") && this.tight() && this.is("!", 1) && this.tight(1) && !this.newline()) {
				withField(expression, "argument");
				expression = this.node("unary_expression", [expression, this.joined("!!", "operator")]);
				continue;
			}
			if (this.is(".") || (this.is("?") && this.is(".", 1) && this.tight(1))) {
				const operator = this.is(".") ? this.word() : this.joined("?.");
				const name = this.navigationName();
				expression = this.node("navigation_expression", [expression, operator, name]);
				continue;
			}
			if (this.is("?") && this.tight() && this.is("::", 1) && this.typeLike(expression)) {
				const type = this.node("user_type", this.typeSegments(expression));
				expression = this.typeReference(this.node("nullable_type", [type, this.word()]));
				continue;
			}
			if (this.is("::") && !this.newline()) {
				const operator = this.word();
				const name = this.is("class") ? this.named("identifier") : this.navigationName();
				expression = this.node("navigation_expression", [expression, operator, name]);
				continue;
			}
			if (this.is("[") && !this.newline()) {
				const children = [expression, this.word()];
				while (!this.done && !this.is("]")) {
					children.push(this.expression());
					if (this.is(",")) children.push(this.word());
					else break;
				}
				children.push(this.expect("]"));
				expression = this.node("index_expression", children);
				continue;
			}
			const call = this.callSuffix(expression);
			if (call !== null) {
				expression = call;
				continue;
			}
			break;
		}
		return expression;
	}

	private navigationName(): SyntaxNode {
		if (this.isName() || this.token.kind === "keyword") return this.named("identifier");
		if (this.is("("))
			return this.node("parenthesized_expression", [this.word(), this.expression(), this.expect(")")]);
		return this.missing("identifier");
	}

	/** Type arguments, value arguments and a trailing lambda on the same line. */
	private callSuffix(callee: SyntaxNode): SyntaxNode | null {
		let typeArguments: SyntaxNode | null = null;
		if (this.is("<") && this.tight()) {
			typeArguments = this.attempt(() => {
				const node = this.typeArguments();
				const follows =
					(this.is("(") && !this.newline()) ||
					(this.is("{") && !this.newline()) ||
					this.is("::") ||
					this.is(".") ||
					(this.is("?") && (this.is(".", 1) || this.is("::", 1)));
				return follows ? node : null;
			});
			if (typeArguments === null) return null;
		}
		if (typeArguments !== null && this.typeLike(callee) && (this.is("::") || this.is("?"))) {
			// `Type<A>::member` references through a type, never a call.
			const type = this.node("user_type", [...this.typeSegments(callee), typeArguments]);
			if (this.is("::")) return this.typeReference(type);
			if (this.is("::", 1)) return this.typeReference(this.node("nullable_type", [type, this.word()]));
		}
		const children = typeArguments === null ? [callee] : [callee, typeArguments];
		if (this.is("(") && !this.newline()) {
			children.push(this.valueArguments());
			const call = this.node("call_expression", children);
			const lambda = this.trailingLambda();
			return lambda === null ? call : this.node("call_expression", [call, lambda]);
		}
		const lambda = this.trailingLambda();
		if (lambda !== null) return this.node("call_expression", [...children, lambda]);
		if (typeArguments !== null) return this.node("call_expression", children);
		return null;
	}

	/** `type::member` at the `::`. */
	private typeReference(type: SyntaxNode): SyntaxNode {
		const operator = this.word();
		const name = this.is("class") ? this.word() : this.navigationName();
		return this.node("callable_reference", [type, operator, name]);
	}

	/** A name, or a dotted run of names. */
	private typeLike(node: SyntaxNode): boolean {
		if (node.type === "identifier") return true;
		return (
			node.type === "navigation_expression" &&
			node.children[1]?.type === "." &&
			this.typeLike(node.children[0] as SyntaxNode) &&
			node.children[2]?.type === "identifier"
		);
	}

	/** A dotted run of names as user type segments. */
	private typeSegments(node: SyntaxNode): SyntaxNode[] {
		if (node.type === "identifier") return [node];
		return [
			...this.typeSegments(node.children[0] as SyntaxNode),
			node.children[1] as SyntaxNode,
			node.children[2] as SyntaxNode,
		];
	}

	/** The specification lets a trailing lambda start on the next line. */
	private trailingLambda(): SyntaxNode | null {
		if (!this.allowLambda) return null;
		if (this.is("{")) return this.node("annotated_lambda", [this.lambdaLiteral()]);
		if (this.token.kind === "label" && this.is("{", 1)) {
			return this.node("annotated_lambda", [this.named("label"), this.lambdaLiteral()]);
		}
		if (this.is("@")) {
			const lambda = this.attempt(() => {
				const annotations: SyntaxNode[] = [];
				while (this.is("@")) annotations.push(this.annotation());
				if (this.token.kind === "label") annotations.push(this.named("label"));
				return this.is("{") ? [...annotations, this.lambdaLiteral()] : null;
			});
			if (lambda !== null) return this.node("annotated_lambda", lambda);
		}
		return null;
	}

	private valueArguments(): SyntaxNode {
		const children = [this.expect("(")];
		const saved = this.allowLambda;
		this.allowLambda = true;
		while (!this.done && !this.is(")")) {
			const start = this.at;
			children.push(this.valueArgument());
			if (this.is(",")) children.push(this.word());
			else if (this.at === start) children.push(this.error(false));
			else if (!this.is(")")) children.push(this.error(false));
		}
		this.allowLambda = saved;
		children.push(this.expect(")"));
		return this.node("value_arguments", children);
	}

	private valueArgument(): SyntaxNode {
		const children: SyntaxNode[] = [];
		if (this.isName() && this.is("=", 1)) children.push(this.identifier(), this.word());
		if (this.is("*")) children.push(this.node("spread_expression", [this.word(), this.expression()]));
		else children.push(this.expression());
		return this.node("value_argument", children);
	}

	/** Whether an expression can start `ahead` tokens on, for infix calls. */
	private startsExpression(ahead: number, acrossLines = false): boolean {
		const token = this.peek(ahead);
		if (token.newlineBefore && ahead > 0 && !acrossLines) return false;
		switch (token.kind) {
			case "identifier":
			case "number":
			case "float":
			case "char":
			case "string":
			case "label":
			case "jump":
				return true;
			case "keyword":
				return !["as", "as?", "in", "!in", "is", "!is", "else", "catch", "finally"].includes(token.text);
			case "punct":
				return ["(", "{", "[", "!", "-", "+", "++", "--", "::", "@"].includes(token.text);
			default:
				return false;
		}
	}

	private primary(): SyntaxNode {
		const token = this.token;
		switch (token.kind) {
			case "identifier":
				return this.identifier();
			case "number":
				return this.named("number_literal");
			case "float":
				return this.named("float_literal");
			case "char":
				return this.characterLiteral();
			case "string":
				return this.stringLiteral();
			case "jump":
				return this.jump();
			case "label":
				return this.named("label");
			case "keyword":
				return this.keywordExpression();
			case "punct":
				return this.punctExpression();
			default:
				return this.missing("expression");
		}
	}

	private keywordExpression(): SyntaxNode {
		switch (this.token.text) {
			case "true":
			case "false":
			case "null":
				return this.identifier();
			case "break":
				return this.node("break_expression", [this.word()]);
			case "continue":
				return this.node("continue_expression", [this.word()]);
			case "this":
				return this.node("this_expression", [this.word()]);
			case "super": {
				const children = [this.word()];
				if (this.is("<") && this.tight()) children.push(this.word(), this.type(), this.expect(">"));
				if (this.is("@") && this.tight()) children.push(this.word(), this.identifier());
				return this.node("super_expression", children);
			}
			case "if":
				return this.ifExpression();
			case "when":
				return this.whenExpression();
			case "try":
				return this.tryExpression();
			case "return": {
				const children = [this.word()];
				if (this.startsExpression(0) && !this.newline() && !this.is("}")) children.push(this.expression());
				return this.node("return_expression", children);
			}
			case "throw":
				return this.node("throw_expression", [this.word(), this.expression()]);
			case "object":
				return this.objectLiteral();
			case "fun":
				return this.anonymousFunction();
			default:
				return this.error(true);
		}
	}

	private jump(): SyntaxNode {
		const jump = this.token.text;
		if (jump === "break@" || jump === "continue@") {
			const opener = this.word();
			const label = withField(this.isName() ? this.identifier() : this.missing("identifier"), "label");
			return this.node(jump === "break@" ? "break_expression" : "continue_expression", [opener, label]);
		}
		const opener = this.word();
		const name =
			this.isName() || this.token.kind === "keyword" ? this.named("identifier") : this.missing("identifier");
		if (jump === "return@") {
			withField(name, "label");
			const children = [opener, name];
			if (this.startsExpression(0) && !this.newline() && !this.is("}")) children.push(this.expression());
			return this.node("return_expression", children);
		}
		return this.node(jump === "this@" ? "this_expression" : "super_expression", [opener, name]);
	}

	private punctExpression(): SyntaxNode {
		switch (this.token.text) {
			case "(":
				return this.node("parenthesized_expression", [this.word(), this.expression(), this.expect(")")]);
			case "{":
				return this.lambdaLiteral();
			case "[": {
				const children = [this.word()];
				while (!this.done && !this.is("]")) {
					children.push(this.expression());
					if (this.is(",")) children.push(this.word());
					else break;
				}
				children.push(this.expect("]"));
				return this.node("collection_literal", children);
			}
			case "::": {
				const children = [this.word()];
				children.push(
					this.is("class") ? this.word() : this.isName() ? this.identifier() : this.missing("identifier"),
				);
				return this.node("callable_reference", children);
			}
			case "*":
				return this.node("spread_expression", [this.word(), this.expression()]);
			default:
				return this.error(true);
		}
	}

	private ifExpression(): SyntaxNode {
		const children = [this.word(), this.expect("("), withField(this.expression(), "condition"), this.expect(")")];
		const body = this.controlBody();
		if (body !== null) children.push(body);
		const elseAhead = this.is(";") && !this.newline() && this.is("else", 1) ? 1 : 0;
		// `else ->` opens the next when entry.
		if (this.is("else", elseAhead) && !this.is("->", elseAhead + 1)) {
			if (elseAhead === 1) children.push(this.word());
			children.push(this.word());
			const otherwise = this.controlBody();
			if (otherwise !== null) children.push(otherwise);
		} else if (body === null && this.is(";")) {
			children.push(this.word());
		}
		return this.node("if_expression", children);
	}

	private whenExpression(): SyntaxNode {
		const children = [this.word()];
		if (this.is("(")) {
			const subject = [this.word()];
			const declared = this.attempt(() => {
				const nodes: SyntaxNode[] = [];
				while (this.is("@")) nodes.push(this.annotation());
				if (!this.is("val")) return null;
				nodes.push(this.word(), this.variableDeclaration(), this.expect("="));
				return nodes;
			});
			if (declared !== null) subject.push(...declared);
			subject.push(this.expression(), this.expect(")"));
			children.push(this.node("when_subject", subject));
		}
		children.push(this.expect("{"));
		let guard = -1;
		while (!this.done && !this.is("}")) {
			if (this.at <= guard) throw new Error("Kotlin when entries failed to advance");
			guard = this.at;
			if (this.is(";")) {
				this.advance();
				continue;
			}
			children.push(this.whenEntry());
		}
		children.push(this.expect("}"));
		return this.node("when_expression", children);
	}

	private whenEntry(): SyntaxNode {
		const children: SyntaxNode[] = [];
		if (this.is("else")) children.push(this.word());
		else {
			for (;;) {
				children.push(withField(this.whenCondition(), "condition"));
				if (this.is(",")) {
					children.push(this.word());
					if (this.is("->")) break;
					continue;
				}
				break;
			}
		}
		if (this.is("if")) children.push(this.node("when_guard", [this.word(), this.expression()]));
		children.push(this.expect("->"));
		const body = this.is("{") ? this.block() : this.statement("local");
		children.push(body);
		return this.node("when_entry", children);
	}

	private whenCondition(): SyntaxNode {
		if (this.is("in") || this.is("!in")) return this.node("range_test", [this.word(), this.expression()]);
		if (this.is("is") || this.is("!is")) return this.node("type_test", [this.word(), this.type()]);
		return this.expression();
	}

	private tryExpression(): SyntaxNode {
		const children = [this.word(), this.block()];
		while (this.is("catch")) {
			const catchChildren = [this.word(), this.expect("(")];
			while (this.is("@")) catchChildren.push(this.annotation());
			catchChildren.push(
				this.isName() ? this.identifier() : this.missing("identifier"),
				this.expect(":"),
				this.type(),
			);
			if (this.is(",")) this.advance();
			catchChildren.push(this.expect(")"), this.block());
			children.push(this.node("catch_block", catchChildren));
		}
		if (this.is("finally")) children.push(this.node("finally_block", [this.word(), this.block()]));
		return this.node("try_expression", children);
	}

	private objectLiteral(): SyntaxNode {
		const children = [this.word()];
		if (this.is(":")) children.push(this.word(), this.delegationSpecifiers());
		children.push(this.classBody());
		return this.node("object_literal", children);
	}

	private anonymousFunction(): SyntaxNode {
		const children = [this.word()];
		if (!this.is("(")) children.push(this.receiverType("("), this.expect("."));
		children.push(this.functionValueParameters());
		if (this.is(":")) children.push(this.word(), this.type());
		if (this.is("where")) children.push(this.typeConstraints());
		const body = this.functionBody();
		if (body !== null) children.push(body);
		return this.node("anonymous_function", children);
	}

	private lambdaLiteral(): SyntaxNode {
		const children = [this.word()];
		const parameters = this.lambdaParameters();
		if (parameters !== null) children.push(...parameters);
		children.push(...this.statements("local", true), this.expect("}"));
		return this.node("lambda_literal", children);
	}

	/** Whether the brace at the cursor opens a lambda with an arrow. */
	private lambdaAhead(): boolean {
		const at = this.at;
		this.advance();
		const parameters = this.lambdaParameters();
		this.at = at;
		return parameters !== null;
	}

	/** Parameters and their arrow, or null (nothing consumed) when no arrow follows. */
	private lambdaParameters(): SyntaxNode[] | null {
		return this.attempt(() => {
			if (this.is("->")) return [this.word()];
			const list: SyntaxNode[] = [];
			for (;;) {
				list.push(this.is("(") ? this.multiVariableDeclaration() : this.variableDeclaration());
				if (this.is(",")) {
					list.push(this.word());
					if (this.is("->")) break;
					continue;
				}
				break;
			}
			if (!this.is("->")) return null;
			return [this.node("lambda_parameters", list), this.word()];
		});
	}

	////////////////////////////////
	//  Literals

	private characterLiteral(): SyntaxNode {
		const token = this.advance();
		const children = [this.quote(token.start, token.start + 1, "'")];
		for (const part of token.parts ?? []) {
			if (part.kind === "escape") children.push(this.span("escape_sequence", part.start, part.end, true));
		}
		if (token.closer !== "") children.push(this.quote(token.end - 1, token.end, "'"));
		return { ...this.node("character_literal", children), start: token.start, end: token.end };
	}

	private stringLiteral(): SyntaxNode {
		const token = this.advance();
		const opener = token.opener ?? '"';
		const raw = opener.endsWith('"""');
		const children = [this.quote(token.start, token.start + opener.length, raw ? '"""' : '"')];
		for (const part of token.parts ?? []) children.push(this.stringPart(part));
		const closer = token.closer ?? "";
		if (closer !== "") children.push(this.quote(token.end - closer.length, token.end, raw ? '"""' : '"'));
		const node = this.node(raw ? "multiline_string_literal" : "string_literal", children);
		node.start = token.start;
		node.end = token.end;
		return node;
	}

	private stringPart(part: StringPart): SyntaxNode {
		switch (part.kind) {
			case "content":
				return this.span("string_content", part.start, part.end, true);
			case "escape":
				return this.span("escape_sequence", part.start, part.end, true);
			case "name": {
				const dollar = this.span("$", part.start, part.name.start, false);
				const name =
					part.name.text === "this"
						? this.node("this_expression", [leafOf(part.name, "this", false)])
						: leafOf(part.name, "identifier", true);
				return this.node("interpolation", [dollar, name]);
			}
			case "expression": {
				const opener = this.span("${", part.start, part.openEnd, false);
				const inner = new KotlinGrammar(this.text, part.tokens, this.gauge, this.meter);
				const expression = inner.expression();
				if (!inner.done) inner.problem("unexpected tokens", inner.token.start, part.end);
				this.problems.push(...inner.problems);
				const children = [opener, expression];
				if (part.closed) children.push(this.span("}", part.end - 1, part.end, false));
				return this.node("interpolation", children);
			}
		}
	}

	private quote(start: number, end: number, type: string): SyntaxNode {
		return this.span(type, start, end, false);
	}

	private span(type: string, start: number, end: number, named: boolean): SyntaxNode {
		return { type, named, missing: false, field: null, start, end, parent: null, children: [] };
	}
}

////////////////////////////////
//  Functions

export function parseKotlinSyntax(
	text: string,
	tokens: Token[],
	comments: readonly Comment[],
	meter?: WorkMeter,
): GrammarResult {
	return new KotlinGrammar(text, tokens, undefined, meter).sourceFile(comments);
}

export type { LexProblem };
