import {
	COMMENT_TYPES,
	childOfType,
	insertLeaf,
	isProblem,
	leavesOf,
	misreadKeyword,
	nodeAt,
	nodesOf,
	outermostProblems,
	readMask,
	type SyntaxNode,
	type SyntaxTree,
	shift,
} from "./tree.js";

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

export const DECLARATION_WORDS: ReadonlySet<string> = new Set([
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

const INLINE_SPACE = new Set([" ", "\t"]);

const DELEGATING_OWNERS: ReadonlySet<string> = new Set(["class_declaration", "object_declaration", "object_literal"]);

export interface Damage {
	/** Outermost problem nodes. */
	regions: SyntaxNode[];
	/** Problem nodes, any depth. */
	errors: number;
	/** Misread keyword leaves. */
	misread: ReadonlySet<SyntaxNode>;
	/** Characters inside `regions`. */
	characters: number;
}

export type RepairName = "comments" | "respelling" | "isolation" | "annotations" | "delegation";

/** Rewritten spans, original offsets. */
export interface RepairRecord {
	repair: RepairName;
	spans: Array<[number, number]>;
}

/** One reading, its history. */
export interface ParseArtifact {
	/** What offsets count. */
	text: string;
	/** Read in place of `text`; same length. */
	mask: string;
	tree: SyntaxTree;
	damage: Damage;
	record: RepairRecord[];
}

/** Earlier repairs, over mask. */
type Reread = (text: string, mask: string) => ParseArtifact;

interface Repair {
	/** Consumes the input tree. */
	apply(artifact: ParseArtifact, reread: Reread): ParseArtifact;
}

/** Ordered: each reads masks only through the ones before it. */
const REPAIRS: readonly Repair[] = [
	{ apply: commentTrivia },
	{ apply: respelling },
	{ apply: isolation },
	{ apply: delegationBodies },
];

export function damageOf(text: string, root: SyntaxNode, leaves: SyntaxNode[]): Damage {
	const regions = outermostProblems(root);
	let characters = 0;
	for (const node of regions) characters += node.end - node.start;
	return {
		regions,
		errors: nodesOf(root).filter(isProblem).length,
		misread: new Set(leaves.filter((leaf) => misreadKeyword(text, leaf))),
		characters,
	};
}

function undamaged(damage: Damage): boolean {
	return damage.errors === 0 && damage.misread.size === 0;
}

/** Characters first, then problems. */
function lessDamaged(left: Damage, right: Damage): boolean {
	const leftProblems = left.errors + left.misread.size;
	const rightProblems = right.errors + right.misread.size;
	return left.characters < right.characters || (left.characters === right.characters && leftProblems < rightProblems);
}

function artifactOf(text: string, mask: string, tree: SyntaxTree, record: RepairRecord[]): ParseArtifact {
	return { text, mask, tree, damage: damageOf(text, tree.root, tree.leaves), record };
}

/** With `count` repairs applied. */
function run(text: string, mask: string, count: number): ParseArtifact {
	let artifact = artifactOf(text, mask, readMask(text, mask), []);
	for (let index = 0; index < count; index++)
		artifact = (REPAIRS[index] as Repair).apply(artifact, (reread, masked) => run(reread, masked, index));
	return artifact;
}

/** Offsets always count `text`; names, ranges and literals read from it, never from a mask. */
export function parseSource(text: string): ParseArtifact {
	return run(text, text, REPAIRS.length);
}

function recorded(artifact: ParseArtifact, repair: RepairName, spans: Array<[number, number]>): RepairRecord[] {
	return [...artifact.record, { repair, spans }];
}

function blank(part: string): string {
	return part.replace(/[^\n]/gu, " ");
}

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

/**
 * The scanner consumes a block comment opening a line as its semicolon lookahead, so the newline
 * before it ends nothing. Such comments read as a newline and blanks, then return as leaves.
 */
function commentTrivia(artifact: ParseArtifact, reread: Reread): ParseArtifact {
	const blanked: SyntaxNode[] = [];
	let latest = artifact;
	let mask = artifact.mask;
	for (;;) {
		// Blanking may expose more.
		const comments = lineOpeningComments(mask, latest.tree.leaves);
		if (comments.length === 0) break;
		let next = "";
		let from = 0;
		for (const comment of comments) {
			next += `${mask.slice(from, comment.start)}\n${" ".repeat(comment.end - comment.start - 1)}`;
			from = comment.end;
		}
		mask = next + mask.slice(from);
		blanked.push(...comments);
		latest = reread(artifact.text, mask);
	}
	if (blanked.length === 0) return artifact;
	const { root } = latest.tree;
	for (const comment of blanked) insertLeaf(root, comment);
	const spans = blanked.map((comment): [number, number] => [comment.start, comment.end]);
	return artifactOf(
		artifact.text,
		artifact.mask,
		{ root, leaves: leavesOf(root) },
		recorded(artifact, "comments", spans),
	);
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

/** Keyword spellings in name positions, first letter upper-cased, so every offset survives. */
function respelled(text: string, mask: string, tree: SyntaxTree): string {
	const leaves = significant(tree.leaves);
	let out = "";
	let from = 0;
	for (let index = 0; index < leaves.length; index++) {
		const leaf = leaves[index] as SyntaxNode;
		const word = text.slice(leaf.start, leaf.end);
		if (!MODIFIER_WORDS.has(word) && !SOFT_WORDS.has(word)) continue;
		if (mask.charCodeAt(leaf.start) !== text.charCodeAt(leaf.start)) continue;
		const before = leaves[index - 1];
		const after = leaves[index + 1];
		const previous = before === undefined ? "" : text.slice(before.start, before.end);
		const next = after === undefined ? "" : text.slice(after.start, after.end);
		const nextIsName = after?.type === "identifier" && !MODIFIER_WORDS.has(next) && !SOFT_WORDS.has(next);
		if (!namePosition(word, previous, next, nextIsName)) continue;
		out += mask.slice(from, leaf.start) + mask.charAt(leaf.start).toUpperCase();
		from = leaf.start + 1;
	}
	return out + mask.slice(from);
}

/** The grammar misses a nested body's `}` after a member on one line; a newline ahead of it means the same. */
function closersOnTheirOwnLine(mask: string, tree: SyntaxTree): string {
	const problems = outermostProblems(tree.root).filter((node) => node.type === "ERROR");
	if (problems.length === 0) return mask;
	let out = "";
	let from = 0;
	for (const leaf of tree.leaves) {
		if (leaf.type !== "}" || leaf.missing) continue;
		const before = mask.charAt(leaf.start - 1);
		if (before !== " " && before !== "\t") continue;
		if (!problems.some((node) => node.start <= leaf.start && leaf.start < node.end)) continue;
		out += `${mask.slice(from, leaf.start - 1)}\n`;
		from = leaf.start;
	}
	return out + mask.slice(from);
}

/** Multi-dollar literals postdate the grammar; `$$"` reads as a plain literal once its dollars are blank. */
function withoutDollarPrefixes(mask: string): string {
	return mask.replace(/\${2,}(?=")/gu, (run) => " ".repeat(run.length));
}

/** Where equal-length masks differ. */
function changedSpans(before: string, after: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	for (let index = 0; index < before.length; index++) {
		if (before.charCodeAt(index) === after.charCodeAt(index)) continue;
		const last = spans.at(-1);
		if (last !== undefined && last[1] === index) last[1] = index + 1;
		else spans.push([index, index + 1]);
	}
	return spans;
}

/** Error-directed rounds; the least damaged reading wins. */
function respelling(artifact: ParseArtifact, reread: Reread): ParseArtifact {
	const { text } = artifact;
	let latest = artifact;
	let best = artifact;
	for (let round = 0; round < REPAIR_ROUNDS && latest.damage.errors > 0; round++) {
		const mask = closersOnTheirOwnLine(
			withoutDollarPrefixes(respelled(text, latest.mask, latest.tree)),
			latest.tree,
		);
		if (mask === latest.mask) break;
		latest = reread(text, mask);
		if (lessDamaged(latest.damage, best.damage)) best = latest;
	}
	if (best === artifact) return artifact;
	const spans = changedSpans(artifact.mask, best.mask);
	return { ...best, mask: artifact.mask, record: recorded(artifact, "respelling", spans) };
}

/** One statement alone, `blanked` read as blanks; `room` blanked text after it still steers recovery. */
function isolated(
	artifact: ParseArtifact,
	reread: Reread,
	start: number,
	end: number,
	{ blanked, room = ISOLATION_ROOM }: { blanked?: [number, number]; room?: number } = {},
): ParseArtifact {
	const window = (source: string): string => source.slice(start, end) + blank(source.slice(end, end + room));
	let mask = window(artifact.mask);
	if (blanked !== undefined) {
		const [from, to] = [blanked[0] - start, blanked[1] - start];
		mask = mask.slice(0, from) + blank(mask.slice(from, to)) + mask.slice(to);
	}
	const alone = reread(window(artifact.text), mask);
	shift(alone.tree.root, start);
	return artifactOf(artifact.text, artifact.mask, alone.tree, []);
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

/**
 * `@A annotation class B` reads as an expression; read it bare with the annotations handed back.
 * The annotations stay the statement's own until the reading is taken.
 */
function withoutAnnotations(
	artifact: ParseArtifact,
	reread: Reread,
	statement: SyntaxNode,
): { artifact: ParseArtifact; take: () => void } | null {
	const annotations = leadingAnnotations(statement);
	const first = annotations[0];
	const last = annotations.at(-1);
	if (first === undefined || last === undefined) return null;
	const alone = isolated(artifact, reread, last.end, statement.end);
	const declaration = alone.tree.root.children.find((child) => child.named && !COMMENT_TYPES.has(child.type));
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
	modifiers.children.unshift(...annotations);
	modifiers.start = first.start;
	declaration.start = first.start;
	const { root } = alone.tree;
	const holder = modifiers;
	return {
		artifact: artifactOf(artifact.text, artifact.mask, { root, leaves: leavesOf(root) }, []),
		take: () => {
			for (const annotation of annotations) annotation.parent = holder;
		},
	};
}

/** Damaged top-level statements read alone; neighbours can steer an ambiguous reading. */
function isolation(artifact: ParseArtifact, reread: Reread): ParseArtifact {
	const { text, tree } = artifact;
	if (undamaged(artifact.damage)) return artifact;
	const statements = tree.root.children;
	const spans: Array<[number, number]> = [];
	const annotated: Array<[number, number]> = [];
	for (let index = 0; index < statements.length; index++) {
		const statement = statements[index] as SyntaxNode;
		const before = damageOf(text, statement, leavesOf(statement));
		if (undamaged(before)) continue;
		const span: [number, number] = [statement.start, statement.end];
		let alone = isolated(artifact, reread, statement.start, statement.end);
		if (!lessDamaged(alone.damage, before)) {
			const bare = withoutAnnotations(artifact, reread, statement);
			if (bare === null || !lessDamaged(bare.artifact.damage, before)) continue;
			bare.take();
			alone = bare.artifact;
			annotated.push(span);
		} else spans.push(span);
		const replacements = alone.tree.root.children;
		for (const replacement of replacements) replacement.parent = tree.root;
		statements.splice(index, 1, ...replacements);
		index += replacements.length - 1;
	}
	if (spans.length === 0 && annotated.length === 0) return artifact;
	const record = [...artifact.record];
	if (spans.length > 0) record.push({ repair: "isolation", spans });
	if (annotated.length > 0) record.push({ repair: "annotations", spans: annotated });
	return artifactOf(text, artifact.mask, { root: tree.root, leaves: leavesOf(tree.root) }, record);
}

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

/**
 * Kotlin never attaches a trailing lambda to a delegate; each body is its owner reread alone with `by d`
 * blanked. The grammar reads a file of one-line bodies in quadratic time, so never the whole file.
 */
function delegationBodies(artifact: ParseArtifact, reread: Reread): ParseArtifact {
	const { text, tree } = artifact;
	const found = misreadBodies(tree.root).sort((left, right) => left.call.start - right.call.start);
	const spans: Array<[number, number]> = [];
	for (const { owner, call } of found) {
		const lambda = call.children.at(-1) as SyntaxNode;
		const delegation = call.parent;
		const callee = call.children[0];
		const span: [number, number] = [
			delegation?.children.find((child) => child.type === "by")?.start ?? call.start,
			lambda.start,
		];
		// Body ends at its brace.
		const alone = isolated(artifact, reread, owner.start, owner.end, { blanked: span, room: 0 });
		const reading = nodeAt(alone.tree.root, owner.type, owner.start);
		const body = reading === undefined ? undefined : childOfType(reading, "class_body");
		if (body === undefined || delegation === null || callee === undefined) continue;
		spans.push(span);
		delegation.children[delegation.children.indexOf(call)] = callee;
		callee.parent = delegation;
		for (let node: SyntaxNode | null = delegation; node !== null && node !== owner; node = node.parent)
			node.end = Math.max(callee.end, ...node.children.map((child) => child.end));
		body.parent = owner;
		owner.children.push(body);
	}
	if (spans.length === 0) return artifact;
	return artifactOf(
		text,
		artifact.mask,
		{ root: tree.root, leaves: leavesOf(tree.root) },
		recorded(artifact, "delegation", spans),
	);
}
