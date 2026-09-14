import type { Diagnostic } from "@nyaa-lexicon/protocol";
import { DECLARATION_WORDS, type ParseArtifact } from "./repairs.js";
import { COMMENT_TYPES, type LineTable, STRING_TYPES, type SyntaxNode, type SyntaxTree } from "./tree.js";

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
function namesNothing(artifact: ParseArtifact, leaf: SyntaxNode): boolean {
	const directive = leaf.parent?.parent?.type ?? "";
	if (HEADER_TYPES.has(directive)) return leaf.missing || artifact.damage.misread.has(leaf);
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
export function syntaxDiagnostics(module: string, artifact: ParseArtifact, lines: LineTable): Diagnostic[] {
	const { text, tree } = artifact;
	const lexical: Array<{ message: string; start: number; end: number }> = [];
	const refuse = (message: string, start: number, end: number): void => {
		lexical.push({ message, start, end });
	};
	const open = new Map<string, SyntaxNode[]>();
	const problems = artifact.damage.regions;
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
		if (namesNothing(artifact, leaf)) {
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
		if (artifact.damage.misread.has(leaf))
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
