// The text each occurrence of a renamed Python name becomes, and the occurrences no edit can make
// safe.

import {
	type BlockedSite,
	comparePositions,
	type coordinatesOf,
	planEdits,
	type RenameEditsRequest,
	type RenameEditsResponse,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import type * as A from "../syntax/ast.js";
import { walk } from "../syntax/ast.js";
import { isKeyword, parsePython } from "../syntax/parser.js";
import { isIdentifierCharacter, isIdentifierStart } from "../syntax/tokenizer.js";
import { Analyzer } from "./analyzer.js";
import { isFunction, NodeVisitor, parameters, typeParamExpressions, typeParamsOf } from "./nodes.js";
import { parseTypeComment } from "./references.js";
import { pathKey } from "./scopes.js";
import { Source } from "./source.js";
import type { Range, RawDescriptor } from "./types.js";
import { stringRepr } from "./values.js";

////////////////////////////////
//  Interfaces & Types

type CandidateKind =
	| "declaration"
	| "parameter"
	| "identifier"
	| "attribute"
	| "localImport"
	| "sourceImport"
	| "keyword"
	| "allString"
	| "stringAnnotation"
	| "stringLiteral";

interface Candidate {
	name: string;
	range: Range;
	kind: CandidateKind;
	/** Whether the occurrence binds the name in its scope. */
	binding: boolean;
	scopePath: RawDescriptor[];
	dynamic: boolean;
}

interface EditGroup {
	edit: TextEdit;
	sources: Array<["site" | "owner", number]>;
}

////////////////////////////////
//  Constants

const STRING_KINDS: ReadonlySet<CandidateKind> = new Set(["allString", "stringAnnotation", "stringLiteral"]);

////////////////////////////////
//  Functions & Helpers

/** `str.isidentifier`. */
function isIdentifier(name: string): boolean {
	const characters = [...name];
	return (
		characters.length > 0 &&
		isIdentifierStart(characters[0] as string) &&
		characters.slice(1).every((character) => isIdentifierCharacter(character))
	);
}

function contains(outer: Range, inner: Range): boolean {
	return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
}

function sameRange(left: Range, right: Range): boolean {
	return comparePositions(left.start, right.start) === 0 && comparePositions(left.end, right.end) === 0;
}

function rangeKey(range: Range): string {
	return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function blocked(range: Range, reason: BlockedSite["reason"], detail: string): BlockedSite {
	return { range, reason, detail };
}

/** String constants a literal `__all__` lists. */
function allStrings(tree: A.Module): Set<A.Node> {
	const found = new Set<A.Node>();
	for (const node of walk(tree)) {
		if (node.type !== "Assign" && node.type !== "AugAssign") continue;
		const targets = node.type === "Assign" ? node.targets : [node.target];
		if (!targets.some((target) => target.type === "Name" && target.id === "__all__")) continue;
		const value = node.value;
		if (value.type !== "List" && value.type !== "Tuple" && value.type !== "Set") continue;
		for (const element of value.elts) {
			if (element.type === "Constant" && element.value.kind === "str") found.add(element);
		}
	}
	return found;
}

/** The scopes a read in `scope` looks through, innermost first; a method's class is skipped. */
function outwardScopes(scope: RawDescriptor[]): RawDescriptor[][] {
	const chain: RawDescriptor[][] = [];
	let current = [...scope];
	for (;;) {
		chain.push(current);
		if (current.length === 0) return chain;
		const wasMethod = current.at(-1)?.kind === "method";
		current = current.slice(0, -1);
		if (wasMethod && current.at(-1)?.kind === "type") current = current.slice(0, -1);
	}
}

/** The scope a name read in `scope` binds in; undefined when no scope holds it. */
function resolveScope(analyzer: Analyzer, scope: RawDescriptor[], name: string): RawDescriptor[] | undefined {
	let current = [...scope];
	for (;;) {
		const info = analyzer.scopes.info(current);
		if (info !== undefined) {
			if (info.kind === "function" && info.globals.has(name)) return [];
			if (info.locals.has(name) || info.parameters.has(name) || info.typeParameters.has(name)) return current;
			if (info.nonlocals.has(name)) {
				current = current.slice(0, -1);
				if (current.at(-1)?.kind === "type") current = current.slice(0, -1);
				continue;
			}
		}
		if (current.length === 0) return undefined;
		const wasMethod = current.at(-1)?.kind === "method";
		current = current.slice(0, -1);
		if (wasMethod && current.at(-1)?.kind === "type") current = current.slice(0, -1);
	}
}

function matches(
	candidate: Candidate,
	site: Range,
	coordinates: ReturnType<typeof coordinatesOf>,
	oldName: string,
): boolean {
	if (STRING_KINDS.has(candidate.kind)) {
		if (!contains(candidate.range, site) && !sameRange(candidate.range, site)) return false;
		const text = coordinates.sliceRange(site);
		return text !== undefined && (candidate.name === oldName || text.includes(oldName));
	}
	return candidate.name === oldName && (sameRange(candidate.range, site) || contains(site, candidate.range));
}

/** The edit a site makes, or why it makes none; undefined when it already reads the new name. */
function siteOutcome(
	candidates: Candidate[],
	site: Range,
	coordinates: ReturnType<typeof coordinatesOf>,
	oldName: string,
	newName: string,
): TextEdit | BlockedSite | undefined {
	if (candidates.length === 0) {
		const siteText = coordinates.sliceRange(site);
		if (siteText === undefined) return blocked(site, "ParseError", "the supplied range does not address text");
		if (siteText === newName) return undefined;
		return blocked(site, "NotImplemented", "the supplied range does not match a supported Python rename site");
	}
	if (candidates.length !== 1) {
		return blocked(site, "NotImplemented", "the supplied range matches multiple Python rename sites");
	}
	const candidate = candidates[0] as Candidate;
	if (candidate.kind === "allString" && candidate.name === oldName) {
		return { range: candidate.range, newText: stringRepr(newName) };
	}
	if (STRING_KINDS.has(candidate.kind)) {
		return blocked(site, "StringLiteral", "renaming inside a string could change unrelated text");
	}
	if (candidate.kind === "attribute") {
		return blocked(site, "NotImplemented", "attribute names may be created or read dynamically");
	}
	if (candidate.kind === "keyword") {
		return blocked(site, "NotImplemented", "keyword argument names are not a closed reference set");
	}
	if (candidate.dynamic) return blocked(site, "NotImplemented", "exec or eval can change this scope");
	return { range: candidate.range, newText: newName };
}

/** The innermost call a range encloses or sits in. */
function ownerCall(analyzer: Analyzer, owner: Range): A.Call | undefined {
	let best: { span: [number, number]; call: A.Call } | undefined;
	for (const node of walk(analyzer.tree)) {
		if (node.type !== "Call") continue;
		const range = analyzer.source.rangeOf(node);
		if (!contains(range, owner) && !contains(owner, range)) continue;
		const span: [number, number] = [range.end.line - range.start.line, range.end.character - range.start.character];
		if (best === undefined || span[0] < best.span[0] || (span[0] === best.span[0] && span[1] < best.span[1])) {
			best = { span, call: node };
		}
	}
	return best?.call;
}

////////////////////////////////
//  Classes

/** Every occurrence a rename site may address, with the scope it is written in. */
class RenameVisitor extends NodeVisitor {
	readonly candidates: Candidate[] = [];
	private scopePath: RawDescriptor[] = [];
	private unsupportedDepth = 0;
	private readonly allStrings: Set<A.Node>;
	private readonly annotationRanges: Range[];

	constructor(private readonly analyzer: Analyzer) {
		super();
		this.allStrings = allStrings(analyzer.tree);
		this.annotationRanges = analyzer.typeAnnotations().map((item) => item.annotationRange);
	}

	private get source(): Source {
		return this.analyzer.source;
	}

	private add(name: string, range: Range, kind: CandidateKind, binding = false): void {
		const info = this.analyzer.scopes.info(this.scopePath);
		this.candidates.push({
			name,
			range,
			kind,
			binding,
			scopePath: [...this.scopePath],
			dynamic: this.unsupportedDepth > 0 || info?.dynamic === true,
		});
	}

	/** A parameter's or keyword argument's name. */
	nameRange(node: A.Arg | A.Keyword): Range {
		const name = node.type === "arg" ? node.arg : (node.arg ?? "");
		return this.source.range(node.pos, node.pos + name.length);
	}

	override visit(node: A.Node): void {
		switch (node.type) {
			case "FunctionDef":
			case "AsyncFunctionDef":
				this.visitFunction(node);
				break;
			case "ClassDef":
				this.visitClass(node);
				break;
			case "TypeAlias":
				this.add(node.name.id, this.source.rangeOf(node.name), "declaration", true);
				this.visitTypeParamBounds(node);
				this.inScope(this.analyzer.declarationPath(node, this.scopePath, "type"), node, () =>
					this.visit(node.value),
				);
				break;
			case "arg":
				this.add(node.arg, this.nameRange(node), "parameter", true);
				if (node.annotation !== undefined) this.visit(node.annotation);
				this.visitTypeComment(node.typeComment, node);
				break;
			case "Name":
				this.add(node.id, this.source.rangeOf(node), "identifier", node.ctx !== "Load");
				break;
			case "Attribute":
				this.visit(node.value);
				this.add(node.attr, this.source.range(node.end - node.attr.length, node.end), "attribute");
				break;
			case "Import":
				for (const alias of node.names) {
					const local = alias.asname ?? (alias.name.split(".")[0] as string);
					const start = alias.asname === undefined ? alias.pos : alias.end - alias.asname.length;
					this.add(local, this.source.range(start, start + local.length), "localImport", true);
				}
				break;
			case "ImportFrom":
				this.visitImportFrom(node);
				break;
			case "keyword":
				if (node.arg !== undefined) this.add(node.arg, this.nameRange(node), "keyword");
				this.visit(node.value);
				break;
			case "Lambda":
			case "ListComp":
			case "SetComp":
			case "DictComp":
			case "GeneratorExp":
				this.unsupportedDepth++;
				this.genericVisit(node);
				this.unsupportedDepth--;
				break;
			case "Constant":
				this.visitConstant(node);
				break;
			case "Assign":
			case "For":
			case "AsyncFor":
			case "With":
			case "AsyncWith":
				this.genericVisit(node);
				this.visitTypeComment(node.typeComment, node);
				break;
			default:
				this.genericVisit(node);
		}
	}

	private inScope(path: RawDescriptor[], node: A.Node, body: () => void): void {
		const oldPath = this.scopePath;
		this.scopePath = path;
		for (const parameter of typeParamsOf(node)) {
			this.add(parameter.name, this.source.selectionOf(parameter), "declaration", true);
		}
		body();
		this.scopePath = oldPath;
	}

	private visitTypeParamBounds(node: A.Node): void {
		for (const expression of typeParamExpressions(node)) this.visit(expression);
	}

	private visitFunction(node: A.FunctionDef): void {
		this.add(node.name, this.source.selectionOf(node), "declaration", true);
		for (const decorator of node.decoratorList) this.visit(decorator);
		this.visitTypeParamBounds(node);
		const args = node.args;
		for (const value of [...args.defaults, ...args.kwDefaults]) if (value !== undefined) this.visit(value);
		for (const argument of parameters(args)) {
			if (argument.annotation !== undefined) this.visit(argument.annotation);
			this.visitTypeComment(argument.typeComment, argument);
		}
		if (node.returns !== undefined) this.visit(node.returns);
		this.visitTypeComment(node.typeComment, node);
		this.inScope(this.analyzer.declarationPath(node, this.scopePath, "method"), node, () => {
			for (const argument of parameters(args))
				this.add(argument.arg, this.nameRange(argument), "parameter", true);
			for (const child of node.body) this.visit(child);
		});
	}

	private visitClass(node: A.ClassDef): void {
		this.add(node.name, this.source.selectionOf(node), "declaration", true);
		for (const decorator of node.decoratorList) this.visit(decorator);
		this.visitTypeParamBounds(node);
		for (const base of node.bases) this.visit(base);
		for (const keyword of node.keywords) this.visit(keyword.value);
		this.inScope(this.analyzer.declarationPath(node, this.scopePath, "type"), node, () => {
			for (const child of node.body) this.visit(child);
		});
	}

	/** A type comment's names, where the comment spells them. */
	private visitTypeComment(text: string | undefined, anchor: A.Node): void {
		const expressions = parseTypeComment(text, isFunction(anchor));
		const start = text === undefined ? undefined : this.source.typeCommentStart(anchor, text);
		if (start === undefined) return;
		for (const expression of expressions) {
			for (const node of walk(expression)) {
				if (node.type === "Name")
					this.add(node.id, this.source.range(start + node.pos, start + node.end), "identifier");
				else if (node.type === "Attribute") {
					this.add(
						node.attr,
						this.source.range(start + node.end - node.attr.length, start + node.end),
						"attribute",
					);
				}
			}
		}
	}

	private visitImportFrom(node: A.ImportFrom): void {
		for (const alias of node.names) {
			if (alias.name === "*" || alias.name.includes(".")) continue;
			// A differently named local is its own binding; the source name binds only when unaliased.
			const aliased = alias.asname !== undefined && alias.asname !== alias.name;
			this.add(alias.name, this.source.range(alias.pos, alias.pos + alias.name.length), "sourceImport", !aliased);
			if (aliased) {
				const asname = alias.asname as string;
				this.add(asname, this.source.range(alias.end - asname.length, alias.end), "localImport", true);
			}
		}
	}

	private visitConstant(node: A.Constant): void {
		if (node.value.kind !== "str") return;
		const range = this.source.rangeOf(node);
		let kind: CandidateKind = "stringLiteral";
		if (this.allStrings.has(node)) kind = "allString";
		else if (this.annotationRanges.some((annotation) => contains(annotation, range))) kind = "stringAnnotation";
		this.add(node.value.value, range, kind);
	}
}

////////////////////////////////
//  Main

export function renameEdits(request: RenameEditsRequest): RenameEditsResponse {
	const { module, text, oldName, newName, sites, ownerCalls } = request;
	if (!isIdentifier(oldName) || !isIdentifier(newName)) {
		return { status: "refused", reason: "InvalidName", detail: "Python names must be identifiers" };
	}
	if (isKeyword(newName))
		return { status: "refused", reason: "ReservedWord", detail: `${newName} is a Python keyword` };
	const parsed = parsePython(Source.parsedText(text));
	if (parsed.module === undefined) {
		return {
			status: "refused",
			reason: "ParseError",
			detail: `parse error: ${parsed.error?.message ?? "invalid syntax"}`,
		};
	}
	if (oldName === newName) return { status: "ready", edits: [], blocked: [] };

	const source = new Source(text, parsed.tokens);
	const analyzer = new Analyzer(module, source, parsed.module);
	analyzer.analyze();
	const visitor = new RenameVisitor(analyzer);
	visitor.visit(parsed.module);
	const coordinates = source.coordinates;

	const matched = sites.map((site) => {
		const unique = new Map<string, Candidate>();
		for (const candidate of visitor.candidates) {
			if (matches(candidate, site.range, coordinates, oldName))
				unique.set(`${candidate.kind} ${rangeKey(candidate.range)}`, candidate);
		}
		return { site, candidates: [...unique.values()] };
	});
	const onlyParameter = (candidates: Candidate[]): boolean =>
		candidates.length === 1 && candidates[0]?.kind === "parameter";

	const parameterTarget = ownerCalls !== undefined || matched.some(({ candidates }) => onlyParameter(candidates));
	if (parameterTarget && ownerCalls === undefined) {
		return {
			status: "refused",
			reason: "NotImplemented",
			detail: "parameter renames cannot account for keyword callers outside this request",
		};
	}
	const parameterRanges = new Set(
		matched
			.filter(({ candidates }) => onlyParameter(candidates))
			.map(({ candidates }) => rangeKey((candidates[0] as Candidate).range)),
	);
	let acceptsKeyword = false;
	for (const node of walk(parsed.module)) {
		if (!isFunction(node)) continue;
		for (const argument of [...node.args.args, ...node.args.kwonlyargs]) {
			if (parameterRanges.has(rangeKey(visitor.nameRange(argument)))) acceptsKeyword = true;
		}
	}

	const ownerEdits: Array<{ site: Range; edit: TextEdit }> = [];
	const ownerBlocked: BlockedSite[] = [];
	if (parameterTarget) {
		const seen = new Set<string>();
		for (const owner of ownerCalls ?? []) {
			if (seen.has(rangeKey(owner))) continue;
			seen.add(rangeKey(owner));
			const call = ownerCall(analyzer, owner);
			if (call === undefined) {
				ownerBlocked.push(blocked(owner, "NotImplemented", "the supplied owner range does not enclose a call"));
				continue;
			}
			if (acceptsKeyword && call.keywords.some((keyword) => keyword.arg === undefined)) {
				ownerBlocked.push(blocked(owner, "NotImplemented", "the call forwards keyword names through **kwargs"));
				continue;
			}
			for (const keyword of call.keywords) {
				if (keyword.arg === oldName)
					ownerEdits.push({ site: owner, edit: { range: visitor.nameRange(keyword), newText: newName } });
			}
		}
	}

	const targetScopes = new Map<string, RawDescriptor[]>();
	const renamed = new Set<Candidate>();
	for (const { candidates } of matched) {
		if (candidates.length !== 1) continue;
		const candidate = candidates[0] as Candidate;
		const scope = candidate.binding ? candidate.scopePath : resolveScope(analyzer, candidate.scopePath, oldName);
		if (scope === undefined) continue;
		targetScopes.set(pathKey(scope), scope);
		renamed.add(candidate);
		// A scope between the site and its target that binds the new name would capture the site.
		const nearer = resolveScope(analyzer, candidate.scopePath, newName);
		if (nearer !== undefined && nearer.length > scope.length) {
			return { status: "refused", reason: "Collision", detail: `${newName} binds nearer to a renamed site` };
		}
	}
	for (const scope of targetScopes.values()) {
		const info = analyzer.scopes.info(scope);
		if (
			info !== undefined &&
			(info.locals.has(newName) || info.parameters.has(newName) || info.typeParameters.has(newName))
		) {
			return { status: "refused", reason: "Collision", detail: `${newName} already binds in the target scope` };
		}
	}
	// A read of the new name that the target scope would newly bind is captured.
	for (const candidate of visitor.candidates) {
		if (candidate.name !== newName || renamed.has(candidate)) continue;
		if (candidate.kind !== "identifier" && candidate.kind !== "declaration" && candidate.kind !== "parameter")
			continue;
		const current = resolveScope(analyzer, candidate.scopePath, newName);
		const chain = outwardScopes(candidate.scopePath);
		for (const scope of targetScopes.values()) {
			const key = pathKey(scope);
			if (!chain.some((outer) => pathKey(outer) === key)) continue;
			if (current === undefined || current.length < scope.length) {
				return {
					status: "refused",
					reason: "Collision",
					detail: `${newName} would capture an existing reference`,
				};
			}
		}
	}

	const groups = new Map<string, EditGroup>();
	const blockedBySite = new Map<number, BlockedSite>();
	const group = (edit: TextEdit, source: ["site" | "owner", number]): void => {
		const key = `${rangeKey(edit.range)} ${edit.newText}`;
		const found = groups.get(key) ?? { edit, sources: [] };
		found.sources.push(source);
		groups.set(key, found);
	};
	for (const [index, { site, candidates }] of matched.entries()) {
		const outcome = siteOutcome(candidates, site.range, coordinates, oldName, newName);
		if (outcome === undefined) continue;
		if ("newText" in outcome) group(outcome, ["site", index]);
		else blockedBySite.set(index, outcome);
	}
	for (const [index, { edit }] of ownerEdits.entries()) group(edit, ["owner", index]);

	const sourcesOf = new Map([...groups.values()].map((item) => [item.edit, item.sources]));
	const plan = planEdits(coordinates, [...sourcesOf.keys()]);
	const refused = [
		...plan.conflicts.map(({ edit, conflict }) => ({
			edit,
			detail: conflict === "unaddressable" ? "an edit does not address text" : "the requested edits overlap",
		})),
		...plan.joined.map(({ edit }) => ({ edit, detail: "two rename insertions share one point" })),
	];
	for (const { edit, detail } of refused) {
		for (const [kind, sourceIndex] of sourcesOf.get(edit) ?? []) {
			if (kind === "site") {
				const site = (matched[sourceIndex] as (typeof matched)[number]).site.range;
				blockedBySite.set(sourceIndex, blocked(site, "NotImplemented", detail));
			} else {
				const owner = (ownerEdits[sourceIndex] as (typeof ownerEdits)[number]).site;
				ownerBlocked.push(blocked(owner, "NotImplemented", detail));
			}
		}
	}
	const joinedEdits = new Set(plan.joined.map(({ edit }) => edit));
	const edits = plan.edits.filter((edit) => !joinedEdits.has(edit));
	const siteBlocked = [...blockedBySite.keys()]
		.sort((a, b) => a - b)
		.map((index) => blockedBySite.get(index) as BlockedSite);
	return { status: "ready", edits, blocked: [...siteBlocked, ...ownerBlocked] };
}
