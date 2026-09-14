import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Diagnostic, Position, Range } from "@nyaa-lexicon/protocol";
import { Language, Parser } from "web-tree-sitter";

/** Beside the bundle when shipped, else the installed package. */
function runtimeWasm(): string {
	const beside = fileURLToPath(new URL("./web-tree-sitter.wasm", import.meta.url));
	if (existsSync(beside)) return beside;
	return createRequire(import.meta.url).resolve("web-tree-sitter/web-tree-sitter.wasm");
}

await Parser.init({ locateFile: () => runtimeWasm() });
const KOTLIN = await Language.load(readFileSync(fileURLToPath(new URL("./tree-sitter-kotlin.wasm", import.meta.url))));
const parser = new Parser();
parser.setLanguage(KOTLIN);

export interface SyntaxNode {
	type: string;
	named: boolean;
	missing: boolean;
	field: string | null;
	start: number;
	end: number;
	parent: SyntaxNode | null;
	children: SyntaxNode[];
	/** Declaration owning the uses inside. */
	owner?: string;
	/** Declaration this node spells. */
	declared?: string;
	/** Identifier naming a declaration. */
	declaresName?: boolean;
}

export interface SyntaxTree {
	root: SyntaxNode;
	/** Leaves in source order, comments included. */
	leaves: SyntaxNode[];
	errors: number;
}

export const COMMENT_TYPES: ReadonlySet<string> = new Set(["line_comment", "block_comment", "shebang"]);

const STRING_TYPES: ReadonlySet<string> = new Set(["string_literal", "multiline_string_literal", "character_literal"]);

const QUOTE_TYPES: ReadonlySet<string> = new Set(['"', '"""', "'"]);

const OPENERS = new Map([
	["(", "("],
	["[", "["],
	["{", "{"],
	["${", "{"],
]);

const CLOSERS = new Map([
	[")", "("],
	["]", "["],
	["}", "{"],
]);

const CLOSING_OF = new Map([...CLOSERS].map(([closer, opener]) => [opener, closer]));

/** Modifiers the grammar reads as keywords at a statement start. */
const MODIFIER_WORDS: ReadonlySet<string> = new Set([
	"abstract",
	"actual",
	"annotation",
	"companion",
	"const",
	"crossinline",
	"data",
	"dynamic",
	"enum",
	"expect",
	"external",
	"final",
	"infix",
	"inline",
	"inner",
	"internal",
	"lateinit",
	"noinline",
	"open",
	"operator",
	"out",
	"override",
	"private",
	"protected",
	"public",
	"reified",
	"sealed",
	"suspend",
	"tailrec",
	"value",
	"vararg",
]);

const SOFT_WORDS: ReadonlySet<string> = new Set([
	"by",
	"catch",
	"constructor",
	"delegate",
	"field",
	"file",
	"finally",
	"get",
	"import",
	"init",
	"param",
	"property",
	"receiver",
	"set",
	"setparam",
	"where",
]);

const DECLARATION_WORDS: ReadonlySet<string> = new Set([
	"class",
	"constructor",
	"fun",
	"interface",
	"object",
	"typealias",
	"val",
	"var",
]);

const NAME_INTRODUCERS: ReadonlySet<string> = new Set([".", "?.", "::", "val", "var", "class", "interface", "object"]);

const MEMBER_ACCESS: ReadonlySet<string> = new Set([".", "?."]);

const TYPE_PRECEDERS: ReadonlySet<string> = new Set([":", "<", ",", "as", "as?", "is", "->", "("]);

const REPAIR_ROUNDS = 8;

const ISOLATION_ROOM = 4096;

const MISREAD_WORDS: ReadonlySet<string> = new Set([
	"class",
	"do",
	"else",
	"for",
	"fun",
	"if",
	"import",
	"interface",
	"object",
	"package",
	"try",
	"typealias",
	"val",
	"var",
	"when",
	"while",
]);

const DECLARATION_NODES: ReadonlySet<string> = new Set([
	"class_declaration",
	"companion_object",
	"function_declaration",
	"object_declaration",
	"property_declaration",
	"secondary_constructor",
	"type_alias",
]);

const HEADER_TYPES: ReadonlyMap<string, string> = new Map([
	["import", "import"],
	["package_header", "package"],
]);

const HEADER_KEYWORDS: ReadonlySet<string> = new Set(["import", "package"]);

/** Hidden tokens such as `;` and `!is` leave gaps; a delimiter never does. */
const DELIMITER_GAP_RE = /[(){}[\]"'`]/u;

const INLINE_SPACE = new Set([" ", "\t"]);

function lineBreakAt(text: string, at: number): boolean {
	return text.charAt(at) === "\n" || text.charAt(at) === "\r";
}

/** Block comments opening a line that code follows on. */
function lineOpeningComments(text: string, leaves: SyntaxNode[]): SyntaxNode[] {
	return leaves.filter((leaf) => {
		if (leaf.type !== "block_comment") return false;
		let before = leaf.start - 1;
		while (before >= 0 && INLINE_SPACE.has(text.charAt(before))) before--;
		let after = leaf.end;
		while (INLINE_SPACE.has(text.charAt(after))) after++;
		return before >= 0 && lineBreakAt(text, before) && after < text.length && !lineBreakAt(text, after);
	});
}

/** A comment leaf back where blanking took it from. */
function graft(root: SyntaxNode, comment: SyntaxNode): void {
	let parent = root;
	for (;;) {
		const inner = parent.children.find((child) => child.start <= comment.start && comment.end <= child.end);
		if (inner === undefined || inner.children.length === 0) break;
		parent = inner;
	}
	const leaf: SyntaxNode = { ...comment, field: null, parent, children: [] };
	const at = parent.children.findIndex((child) => child.start >= comment.end);
	if (at < 0) parent.children.push(leaf);
	else parent.children.splice(at, 0, leaf);
}

/**
 * The scanner consumes a block comment opening a line as its semicolon lookahead, so the newline
 * before it ends nothing. Such comments parse as a newline and blanks, then return as leaves.
 */
function mirror(text: string): SyntaxTree {
	const blanked: SyntaxNode[] = [];
	let parsed = text;
	for (;;) {
		const tree = build(text, parsed);
		// Blanking one can expose the next.
		const comments = lineOpeningComments(parsed, tree.leaves);
		if (comments.length === 0) {
			for (const comment of blanked) graft(tree.root, comment);
			return blanked.length === 0 ? tree : { root: tree.root, leaves: leavesOf(tree.root), errors: tree.errors };
		}
		let next = "";
		let from = 0;
		for (const comment of comments) {
			next += `${parsed.slice(from, comment.start)}\n${" ".repeat(comment.end - comment.start - 1)}`;
			from = comment.end;
		}
		parsed = next + parsed.slice(from);
		blanked.push(...comments);
	}
}

function build(text: string, parsed: string): SyntaxTree {
	// Scanner stalls at EOF after an annotation.
	const tree = parser.parse(parsed.endsWith("\n") ? parsed : `${parsed}\n`);
	if (tree === null) throw new Error("the Kotlin grammar produced no tree");
	const cursor = tree.walk();
	const make = (parent: SyntaxNode | null): SyntaxNode => ({
		type: cursor.nodeType,
		named: cursor.nodeIsNamed,
		missing: cursor.nodeIsMissing,
		field: cursor.currentFieldName,
		start: Math.min(cursor.startIndex, text.length),
		end: Math.min(cursor.endIndex, text.length),
		parent,
		children: [],
	});
	const root = make(null);
	const leaves: SyntaxNode[] = [];
	let errors = 0;
	let current = root;
	const visit = (node: SyntaxNode): void => {
		if (node.type === "ERROR" || node.missing) errors++;
	};
	visit(root);
	for (;;) {
		if (cursor.gotoFirstChild()) {
			const child = make(current);
			current.children.push(child);
			visit(child);
			current = child;
			continue;
		}
		leaves.push(current);
		let advanced = false;
		while (!advanced) {
			if (cursor.gotoNextSibling()) {
				const parent = current.parent as SyntaxNode;
				const sibling = make(parent);
				parent.children.push(sibling);
				visit(sibling);
				current = sibling;
				advanced = true;
			} else if (cursor.gotoParent()) {
				current = current.parent as SyntaxNode;
			} else {
				cursor.delete();
				tree.delete();
				return { root, leaves, errors };
			}
		}
	}
}

function significant(leaves: SyntaxNode[]): SyntaxNode[] {
	return leaves.filter((leaf) => !COMMENT_TYPES.has(leaf.type) && leaf.end > leaf.start);
}

/** Whether a keyword spelling sits where only a name can. */
function namePosition(word: string, previous: string, next: string, nextIsName: boolean): boolean {
	if (SOFT_WORDS.has(word)) return MEMBER_ACCESS.has(previous) || previous === "::" || MEMBER_ACCESS.has(next);
	if (NAME_INTRODUCERS.has(previous)) return true;
	if (word === "dynamic") return !TYPE_PRECEDERS.has(previous);
	if (nextIsName || MODIFIER_WORDS.has(next) || DECLARATION_WORDS.has(next) || next === "@") return false;
	return !(word === "suspend" && (next === "(" || next === "{"));
}

/** Same length, first letter upper-cased, so every offset survives. */
function respell(original: string, current: string, tree: SyntaxTree): string {
	const leaves = significant(tree.leaves);
	const cuts: number[] = [];
	for (let index = 0; index < leaves.length; index++) {
		const leaf = leaves[index] as SyntaxNode;
		const word = original.slice(leaf.start, leaf.end);
		if (!MODIFIER_WORDS.has(word) && !SOFT_WORDS.has(word)) continue;
		if (current.charCodeAt(leaf.start) !== original.charCodeAt(leaf.start)) continue;
		const before = leaves[index - 1];
		const after = leaves[index + 1];
		const previous = before === undefined ? "" : original.slice(before.start, before.end);
		const next = after === undefined ? "" : original.slice(after.start, after.end);
		const nextIsName = after?.type === "identifier" && !MODIFIER_WORDS.has(next) && !SOFT_WORDS.has(next);
		if (namePosition(word, previous, next, nextIsName)) cuts.push(leaf.start);
	}
	let out = "";
	let from = 0;
	for (const cut of cuts) {
		out += current.slice(from, cut) + current.charAt(cut).toUpperCase();
		from = cut + 1;
	}
	return closersOnTheirOwnLine(withoutDollarPrefixes(out + current.slice(from)), tree);
}

/** The grammar misses a nested body's `}` after a member on one line; a newline ahead of it means the same. */
function closersOnTheirOwnLine(text: string, tree: SyntaxTree): string {
	const problems = outermostProblems(tree.root).filter((node) => node.type === "ERROR");
	if (problems.length === 0) return text;
	let out = "";
	let from = 0;
	for (const leaf of tree.leaves) {
		if (leaf.type !== "}" || leaf.missing) continue;
		const before = text.charAt(leaf.start - 1);
		if (before !== " " && before !== "\t") continue;
		if (!problems.some((node) => node.start <= leaf.start && leaf.start < node.end)) continue;
		out += `${text.slice(from, leaf.start - 1)}\n`;
		from = leaf.start;
	}
	return out + text.slice(from);
}

/** Multi-dollar literals postdate the grammar; `$$"` reads as a plain literal once its dollars are blank. */
function withoutDollarPrefixes(text: string): string {
	return text.replace(/\${2,}(?=")/gu, (run) => " ".repeat(run.length));
}

/** A keyword no grammar reading can make a name. */
export function misreadKeyword(text: string, leaf: SyntaxNode): boolean {
	if (leaf.type !== "identifier") return false;
	const word = text.slice(leaf.start, leaf.end);
	if (!MISREAD_WORDS.has(word)) return false;
	const siblings = leaf.parent?.children ?? [];
	return !(word === "class" && siblings[siblings.indexOf(leaf) - 1]?.type === "::");
}

/** Unreadable characters, then problem count; lower is better. */
function damage(text: string, root: SyntaxNode, leaves: SyntaxNode[]): [number, number] {
	let characters = 0;
	let problems = 0;
	for (const node of outermostProblems(root)) characters += node.end - node.start;
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		if (node.type === "ERROR" || node.missing) problems++;
		for (const child of node.children) stack.push(child);
	}
	for (const leaf of leaves) if (misreadKeyword(text, leaf)) problems++;
	return [characters, problems];
}

function lessDamaged(left: [number, number], right: [number, number]): boolean {
	return left[0] < right[0] || (left[0] === right[0] && left[1] < right[1]);
}

function repaired(text: string): SyntaxTree {
	let latest = mirror(text);
	let best = latest;
	let score = damage(text, best.root, best.leaves);
	let current = text;
	for (let round = 0; round < REPAIR_ROUNDS && latest.errors > 0; round++) {
		const respelled = respell(text, current, latest);
		if (respelled === current) break;
		current = respelled;
		latest = mirror(respelled);
		const latestScore = damage(text, latest.root, latest.leaves);
		if (lessDamaged(latestScore, score)) {
			best = latest;
			score = latestScore;
		}
	}
	return best;
}

function leavesOf(node: SyntaxNode): SyntaxNode[] {
	const leaves: SyntaxNode[] = [];
	const stack = [node];
	while (stack.length > 0) {
		const current = stack.pop() as SyntaxNode;
		if (current.children.length === 0) leaves.push(current);
		for (let index = current.children.length - 1; index >= 0; index--)
			stack.push(current.children[index] as SyntaxNode);
	}
	return leaves;
}

function blank(part: string): string {
	return part.replace(/[^\n]/gu, " ");
}

/** One statement alone; blanked text after it still steers recovery. */
function isolated(text: string, start: number, end: number): SyntaxTree {
	const tree = repaired(text.slice(start, end) + blank(text.slice(end, end + ISOLATION_ROOM)));
	const stack = [tree.root];
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		node.start += start;
		node.end += start;
		for (const child of node.children) stack.push(child);
	}
	return tree;
}

/** Annotations ahead of the first token outside any annotation. */
function leadingAnnotations(statement: SyntaxNode): SyntaxNode[] {
	const found: SyntaxNode[] = [];
	const stack = [statement];
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		if (node.type === "annotation") {
			found.push(node);
			continue;
		}
		if (node.children.length === 0 && !COMMENT_TYPES.has(node.type) && node.end > node.start) break;
		for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index] as SyntaxNode);
	}
	return found;
}

/** `@A annotation class B` reads as an expression; parse it bare and hand the annotations back. */
function withoutAnnotations(text: string, statement: SyntaxNode): SyntaxTree | null {
	const annotations = leadingAnnotations(statement);
	const first = annotations[0];
	const last = annotations.at(-1);
	if (first === undefined || last === undefined) return null;
	const alone = isolated(text, last.end, statement.end);
	const declaration = alone.root.children.find((child) => child.named && !COMMENT_TYPES.has(child.type));
	if (declaration === undefined) return null;
	let modifiers = declaration.children.find((child) => child.type === "modifiers");
	if (modifiers === undefined) {
		modifiers = {
			type: "modifiers",
			named: true,
			missing: false,
			field: null,
			start: first.start,
			end: last.end,
			parent: declaration,
			children: [],
		};
		declaration.children.unshift(modifiers);
	}
	for (const annotation of annotations) annotation.parent = modifiers;
	modifiers.children.unshift(...annotations);
	modifiers.start = first.start;
	declaration.start = first.start;
	return { root: alone.root, leaves: leavesOf(alone.root), errors: alone.errors };
}

/**
 * Error-directed: each round respells what the last tree exposed and the least damaged tree wins.
 * A damaged top-level statement is then reparsed alone, since a grammar ambiguity can pull its
 * reading from statements around it.
 */
function readable(text: string): SyntaxTree {
	const tree = repaired(text);
	if (tree.errors === 0 && !tree.leaves.some((leaf) => misreadKeyword(text, leaf))) return tree;
	const statements = tree.root.children;
	let spliced = false;
	for (let index = 0; index < statements.length; index++) {
		const statement = statements[index] as SyntaxNode;
		const before = damage(text, statement, leavesOf(statement));
		if (before[0] === 0 && before[1] === 0) continue;
		let alone: SyntaxTree | null = isolated(text, statement.start, statement.end);
		if (!lessDamaged(damage(text, alone.root, alone.leaves), before)) alone = withoutAnnotations(text, statement);
		if (alone === null || !lessDamaged(damage(text, alone.root, alone.leaves), before)) continue;
		const replacements = alone.root.children;
		for (const replacement of replacements) replacement.parent = tree.root;
		statements.splice(index, 1, ...replacements);
		index += replacements.length - 1;
		spliced = true;
	}
	if (!spliced) return tree;
	return { root: tree.root, leaves: leavesOf(tree.root), errors: damage("", tree.root, [])[1] };
}

const DELEGATING_OWNERS: ReadonlySet<string> = new Set(["class_declaration", "object_declaration", "object_literal"]);

/** `I by d {` whose body the grammar read as a trailing lambda on `d`. */
function misreadBodies(root: SyntaxNode): Array<{ owner: SyntaxNode; call: SyntaxNode }> {
	const found: Array<{ owner: SyntaxNode; call: SyntaxNode }> = [];
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		const call = node.children.at(-1);
		const owner = node.parent?.parent?.parent;
		if (
			node.type === "explicit_delegation" &&
			call?.type === "call_expression" &&
			call.children.at(-1)?.type === "annotated_lambda" &&
			owner !== undefined &&
			owner !== null &&
			DELEGATING_OWNERS.has(owner.type) &&
			childOfType(owner, "class_body") === undefined &&
			node.parent?.parent?.children.at(-1) === node.parent
		) {
			found.push({ owner, call });
			continue;
		}
		for (const child of node.children) stack.push(child);
	}
	return found;
}

function nodeAt(root: SyntaxNode, type: string, start: number): SyntaxNode | undefined {
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		if (node.type === type && node.start === start) return node;
		for (const child of node.children) if (child.start <= start && start < child.end) stack.push(child);
	}
	return undefined;
}

/** Kotlin never attaches a trailing lambda to a delegate; the braces are the body. */
function withDelegationBodies(text: string, tree: SyntaxTree): SyntaxTree {
	const found = misreadBodies(tree.root);
	if (found.length === 0) return tree;
	let blanked = "";
	let from = 0;
	for (const { call } of [...found].sort((left, right) => left.call.start - right.call.start)) {
		const lambda = call.children.at(-1) as SyntaxNode;
		const by = call.parent?.children.find((child) => child.type === "by");
		const start = by?.start ?? call.start;
		blanked += text.slice(from, start) + blank(text.slice(start, lambda.start));
		from = lambda.start;
	}
	const reread = readable(blanked + text.slice(from));
	for (const { owner, call } of found) {
		const body = childOfType(nodeAt(reread.root, owner.type, owner.start) ?? owner, "class_body");
		const delegation = call.parent;
		const callee = call.children[0];
		if (body === undefined || delegation === null || callee === undefined) continue;
		delegation.children[delegation.children.indexOf(call)] = callee;
		callee.parent = delegation;
		for (let node: SyntaxNode | null = delegation; node !== null && node !== owner; node = node.parent)
			node.end = Math.max(callee.end, ...node.children.map((child) => child.end));
		body.parent = owner;
		owner.children.push(body);
	}
	return { root: tree.root, leaves: leavesOf(tree.root), errors: damage("", tree.root, [])[1] };
}

export function parseSource(text: string): SyntaxTree {
	return withDelegationBodies(text, readable(text));
}

export class LineTable {
	private readonly starts: number[] = [0];

	constructor(text: string) {
		for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1))
			this.starts.push(index + 1);
	}

	position(offset: number): Position {
		let low = 0;
		let high = this.starts.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if ((this.starts[middle] as number) <= offset) low = middle;
			else high = middle - 1;
		}
		return { line: low, character: offset - (this.starts[low] as number) };
	}

	range(start: number, end: number): Range {
		return { start: this.position(start), end: this.position(end) };
	}
}

function outermostProblems(root: SyntaxNode): SyntaxNode[] {
	const found: SyntaxNode[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		if (node.type === "ERROR" || node.missing) {
			found.push(node);
			continue;
		}
		for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index] as SyntaxNode);
	}
	return found;
}

/** Text no leaf covers, in source order. */
function gaps(text: string, tree: SyntaxTree): Array<[number, number]> {
	const found: Array<[number, number]> = [];
	let covered = 0;
	for (const leaf of tree.leaves) {
		if (leaf.start > covered) found.push([covered, leaf.start]);
		// A character literal's content is no leaf.
		covered = Math.max(covered, leaf.parent?.type === "character_literal" ? leaf.parent.end : leaf.end);
	}
	if (covered < text.length) found.push([covered, text.length]);
	return found;
}

/** Where an unclosed `/*` starts; it runs to end of file. */
export function unclosedComment(text: string, tree: SyntaxTree): number | undefined {
	let previous: SyntaxNode | undefined;
	let at: number | undefined;
	for (const leaf of tree.leaves) {
		if (COMMENT_TYPES.has(leaf.type)) continue;
		if (leaf.type === "*" && previous?.type === "/" && previous.end === leaf.start) at = previous.start;
		else if (leaf.type === "ERROR" && text.startsWith("/*", leaf.start)) at = leaf.start;
		if (at !== undefined) break;
		previous = leaf;
	}
	for (const [start, end] of gaps(text, tree)) {
		const opens = start + text.slice(start, end).search(/\S/u);
		if (opens >= start && text.startsWith("/*", opens)) return Math.min(opens, at ?? opens);
	}
	return at;
}

/** An `import` or `package` directive holding no name. */
function namesNothing(text: string, leaf: SyntaxNode): boolean {
	const directive = leaf.parent?.parent?.type ?? "";
	if (HEADER_TYPES.has(directive)) return leaf.missing || misreadKeyword(text, leaf);
	return HEADER_KEYWORDS.has(leaf.type) && !HEADER_TYPES.has(leaf.parent?.type ?? "");
}

/** A declaration node, or a declaration keyword past the region's first token. */
function holdsDeclaration(text: string, node: SyntaxNode): boolean {
	const stack = [node];
	let first = true;
	while (stack.length > 0) {
		const current = stack.pop() as SyntaxNode;
		if (DECLARATION_NODES.has(current.type)) return true;
		if (current.children.length === 0 && !COMMENT_TYPES.has(current.type) && current.end > current.start) {
			if (!first && DECLARATION_WORDS.has(text.slice(current.start, current.end))) return true;
			first = false;
		}
		for (let index = current.children.length - 1; index >= 0; index--)
			stack.push(current.children[index] as SyntaxNode);
	}
	return false;
}

/**
 * Refuses what no valid source produces: an unterminated literal or comment, an empty directive, an
 * opener the text never closes, or damage to end of file holding no declaration. Other damage is a
 * grammar gap in valid source and only warns.
 */
export function syntaxDiagnostics(module: string, text: string, tree: SyntaxTree, lines: LineTable): Diagnostic[] {
	const lexical: Array<{ message: string; start: number; end: number }> = [];
	const refuse = (message: string, start: number, end: number): void => {
		lexical.push({ message, start, end });
	};
	const open = new Map<string, SyntaxNode[]>();
	const problems = outermostProblems(tree.root);
	const last = text.trimEnd().length;
	const gapTolerated = problems.some((node) => holdsDeclaration(text, node));
	let unrecovered = !gapTolerated && problems.some((node) => node.end >= last);
	for (const [start, end] of gaps(text, tree)) {
		if (!DELIMITER_GAP_RE.test(text.slice(start, end))) continue;
		refuse("Kotlin text here is not part of any token.", start, end);
		if (end === text.length) unrecovered ||= !gapTolerated;
	}
	for (const leaf of tree.leaves) {
		if (leaf.missing && (CLOSERS.has(leaf.type) || QUOTE_TYPES.has(leaf.type)))
			refuse(`Missing ${leaf.type}.`, leaf.start, leaf.end);
		if (namesNothing(text, leaf)) {
			const header = HEADER_TYPES.get(leaf.parent?.parent?.type ?? "") ?? leaf.type;
			refuse(`The ${header} directive names nothing.`, leaf.start, leaf.end);
			unrecovered = true;
		}
		// Lexing never leaves a quote outside its literal.
		if (QUOTE_TYPES.has(leaf.type) && !leaf.missing && !STRING_TYPES.has(leaf.parent?.type ?? "")) {
			refuse("Literal has no closing quote.", leaf.start, text.length);
			unrecovered = true;
		}
		const opener = OPENERS.get(leaf.type);
		if (opener !== undefined && !leaf.missing) {
			const stack = open.get(opener) ?? [];
			stack.push(leaf);
			open.set(opener, stack);
		}
		const closes = CLOSERS.get(leaf.type);
		if (closes !== undefined && !leaf.missing && open.get(closes)?.pop() === undefined)
			refuse(`Closing ${leaf.type} has no opening delimiter.`, leaf.start, leaf.end);
	}
	const tail = gaps(text, tree).find(([, end]) => end === text.length);
	const skipped = tail === undefined ? "" : text.slice(tail[0]);
	for (const [kind, stack] of open) {
		for (const leaf of stack) refuse(`Opening ${kind} is not closed.`, leaf.start, leaf.end);
		// A grammar gap skips its closers; truncation has none.
		const closer = CLOSING_OF.get(kind) as string;
		if (stack.length > skipped.split(closer).length - 1) unrecovered = true;
	}
	const comment = unclosedComment(text, tree);
	if (comment !== undefined) {
		refuse("Block comment has no closing delimiter.", comment, text.length);
		unrecovered = true;
	}
	const tailProblem = problems.find((node) => node.end >= last);
	if (unrecovered && lexical.length === 0 && tailProblem !== undefined)
		refuse("Kotlin text ends inside an unfinished declaration.", tailProblem.start, tailProblem.end);
	const diagnostics: Diagnostic[] = lexical.map((problem) => ({
		severity: unrecovered ? "error" : "warning",
		message: problem.message,
		range: lines.range(problem.start, problem.end),
		path: module,
	}));
	for (const leaf of tree.leaves)
		if (misreadKeyword(text, leaf))
			diagnostics.push({
				severity: "warning",
				message: `The Kotlin grammar read the keyword ${text.slice(leaf.start, leaf.end)} as a name.`,
				range: lines.range(leaf.start, leaf.end),
				path: module,
			});
	for (const node of problems)
		diagnostics.push({
			severity: "warning",
			message: node.missing
				? `The Kotlin grammar expected ${node.type} here.`
				: "The Kotlin grammar could not read this region; declarations inside may be missing.",
			range: lines.range(node.start, node.end),
			path: module,
		});
	return diagnostics;
}

const TIGHT_BEFORE: ReadonlySet<string> = new Set([
	"(",
	",",
	")",
	"]",
	"}",
	".",
	"?.",
	"::",
	":",
	"?",
	"!",
	"!!",
	";",
	">",
]);

const TIGHT_AFTER: ReadonlySet<string> = new Set(["(", "[", "{", ".", "?.", "::", "@", "<"]);

/** Header text without comments, spaced by token. */
export function render(text: string, nodes: SyntaxNode[], lines: LineTable): string {
	const parts: string[] = [];
	let previous = "";
	let lastLine = -1;
	const stack = [...nodes].reverse();
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		if (COMMENT_TYPES.has(node.type) || node.end === node.start) continue;
		if (node.children.length > 0 && !STRING_TYPES.has(node.type)) {
			for (let index = node.children.length - 1; index >= 0; index--)
				stack.push(node.children[index] as SyntaxNode);
			continue;
		}
		const value = text.slice(node.start, node.end);
		const line = lines.position(node.start).line;
		if (lastLine >= 0 && line > lastLine) {
			parts.push("\n".repeat(line - lastLine));
			previous = "";
		}
		const tightBefore = TIGHT_BEFORE.has(value) || (value === "<" && !["fun", "val", "var"].includes(previous));
		if (parts.length > 0 && previous !== "" && !tightBefore && !TIGHT_AFTER.has(previous)) parts.push(" ");
		parts.push(value);
		previous = value;
		lastLine = lines.position(node.end).line;
	}
	return parts.join("").trim();
}

/** Backticks quote a name; they are not part of it. */
export function nameText(text: string, node: SyntaxNode): string {
	const raw = text.slice(node.start, node.end);
	return raw.length >= 2 && raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
}

export function childOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
	return node.children.find((child) => child.type === type);
}

export function childrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
	return node.children.filter((child) => child.type === type);
}
